import React, {createContext, useContext, useId} from 'react';
import {TransitionSeries, linearTiming} from '@remotion/transitions';
import {slide} from '@remotion/transitions/slide';
import {colorTransform} from './color-settings.mjs';
import {hasSourceCrop, motionStyle, transitionStyle, GRAPHIC_PRESETS, valueAt, screenFocusRamp, screenFocusAmount, SCREEN_LABEL_PADDING} from './edit-controls.mjs';
import {volumeAt} from './audio-settings.mjs';
import {
  AbsoluteFill, Audio, Composition, Img, OffthreadVideo, Sequence,
  useCurrentFrame,
} from 'remotion';

type Asset = {id: string; src: string; type: string; hasAudio?: boolean; cropDisplaySize?: {width: number; height: number} | null};
type Framing = {crop?: {left?: number; right?: number; top?: number; bottom?: number}; focus?: {x: number; y: number}};
type Timeline = {
  fps: number; width: number; height: number; durationInFrames: number;
  assets: Asset[]; clips: any[]; overlays: any[]; captions: any[];
  settings?: Record<string, any>; captionsStyle?: Record<string, any>;
  captionCues?: any[]; audioRenderRole?: string;
};
export type EngineProps = {timeline: Timeline; customLayerProps?: Record<string, unknown>};
const CustomLayerContext = createContext<React.ComponentType<any> | null>(null);

const mediaStyle = {width: '100%', height: '100%'} as const;
const getAsset = (timeline: Timeline, id: string): Asset => {
  const asset = timeline.assets.find((item) => item.id === id);
  if (!asset?.src) throw new Error(`No registered media URL for asset ${id}`);
  return asset;
};

// Data-driven styles intentionally cover basic layout. More involved motion is
// available through a project's explicitly registered custom composition.
const styleKeys = [
  'left', 'right', 'top', 'bottom', 'width', 'height', 'opacity', 'transform',
  'transformOrigin', 'borderRadius', 'border', 'boxShadow', 'backgroundColor',
  'padding', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
  'color', 'textAlign', 'textShadow', 'objectFit', 'objectPosition', 'zIndex',
] as const;

function overlayStyle(style: Record<string, any> = {}, frame: number, duration: number): React.CSSProperties {
  const result: Record<string, any> = {position: 'absolute', inset: 0, width: '100%', height: '100%'};
  for (const key of styleKeys) if (style[key] !== undefined) result[key] = style[key];
  // Explicit dimensions/position should not stretch to the opposite edge.
  if (style.width !== undefined) { result.right = style.right ?? 'auto'; }
  if (style.height !== undefined) { result.bottom = style.bottom ?? 'auto'; }
  if (style.right !== undefined && style.left === undefined) result.left = 'auto';
  if (style.bottom !== undefined && style.top === undefined) result.top = 'auto';
  let opacity = Number.isFinite(style.opacity) ? style.opacity : 1;
  if (style.fadeInFrames > 0) opacity *= Math.min(1, frame / style.fadeInFrames);
  if (style.fadeOutFrames > 0) opacity *= Math.min(1, Math.max(0, (duration - 1 - frame) / style.fadeOutFrames));
  result.opacity = opacity;
  return result;
}

function useMediaColor(settings: any) {
  const id = `source-color-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const {filter, rgbGains} = colorTransform(settings);
  const hasRgb = rgbGains.some((gain: number) => gain !== 1);
  return {id, rgbGains, hasRgb,
    filter: [hasRgb ? `url("#${id}")` : '', filter].filter(Boolean).join(' ') || undefined};
}

function MediaColorDefinition({color}: {color: ReturnType<typeof useMediaColor>}) {
  if (!color.hasRgb) return null;
  return <svg width={0} height={0} aria-hidden="true" focusable="false"
    style={{position: 'absolute', pointerEvents: 'none'}}>
    <defs><filter id={color.id} colorInterpolationFilters="sRGB">
      <feComponentTransfer>
        <feFuncR type="linear" slope={color.rgbGains[0]}/>
        <feFuncG type="linear" slope={color.rgbGains[1]}/>
        <feFuncB type="linear" slope={color.rgbGains[2]}/>
      </feComponentTransfer>
    </filter></defs>
  </svg>;
}

// The browser resolves position keywords, edge offsets, CSS variables and calc()
// into two axes. Their percentages refer to the space left after fitting,
// which may be negative when a cover crop is larger than its viewport.
function placeCroppedOverlay(element: HTMLDivElement, width: string, height: string) {
  const position = element.computedStyleMap().get('object-position') as CSSPositionValue;
  const axis = (value: CSSNumericValue, freeSpace: string) => value.toString().replace(
    /(-?(?:\d*\.)?\d+(?:e[+-]?\d+)?)%/gi,
    (_, percent) => `calc(${Number(percent) / 100} * (${freeSpace}))`,
  );
  element.style.left = axis(position.x, `100cqw - ${width}`);
  element.style.top = axis(position.y, `100cqh - ${height}`);
}

function SourcePicture({asset, framing, fit, objectPosition, filter, trimBefore, playbackRate = 1}: {
  asset: Asset; framing: Framing; fit: React.CSSProperties['objectFit']; filter?: string;
  trimBefore: number; playbackRate?: number; objectPosition?: React.CSSProperties['objectPosition'];
}) {
  const image = (style: React.CSSProperties) => asset.type === 'image'
    ? <Img src={asset.src} crossOrigin="anonymous" style={style}/>
    : <OffthreadVideo src={asset.src} trimBefore={trimBefore} playbackRate={playbackRate} muted style={style}/>;
  const x = (framing.focus?.x ?? .5) * 100, y = (framing.focus?.y ?? .5) * 100;
  if (!hasSourceCrop(framing)) {
    return image({position: 'absolute', inset: 0, ...mediaStyle, objectFit: fit, objectPosition: objectPosition ?? `${x}% ${y}%`, filter});
  }
  const {left = 0, right = 0, top = 0, bottom = 0} = framing.crop!;
  const w = 1 - left - right, h = 1 - top - bottom;
  const size = asset.cropDisplaySize!;
  const cropWidth = size.width * w, cropHeight = size.height * h, aspect = cropWidth / cropHeight;
  // Fit the retained source rectangle in the actual layout box. Clipping only
  // the outer box lets discarded pixels show in the unused space under contain.
  const heightLimitedWidth = `${100 * aspect}cqh`;
  let width = '100cqw', height = 'auto';
  switch (fit) {
    case 'cover': width = `max(100cqw, ${heightLimitedWidth})`; break;
    case 'contain': width = `min(100cqw, ${heightLimitedWidth})`; break;
    case 'scale-down': width = `min(${cropWidth}px, 100cqw, ${heightLimitedWidth})`; break;
    case 'none': width = `${cropWidth}px`; break;
    default: height = '100cqh';
  }
  return <div style={{position: 'absolute', inset: 0, containerType: 'size', overflow: 'hidden'}}>
    <div ref={objectPosition == null ? undefined : element => {
      if (element) placeCroppedOverlay(element, width, height === 'auto' ? `calc(${width} / ${aspect})` : height);
    }} style={{position: 'absolute', width, height, aspectRatio: aspect, overflow: 'hidden',
      ...(objectPosition == null ? {left: `${x}%`, top: `${y}%`, transform: `translate(-${x}%, -${y}%)`} : {objectPosition})}}>
      {image({position: 'absolute', left: `${-100 * left / w}%`, top: `${-100 * top / h}%`,
        width: `${100 / w}%`, height: `${100 / h}%`, objectFit: 'fill', objectPosition: 'center', filter})}
    </div>
  </div>;
}

function Clip({clip, timeline}: {clip: any; timeline: Timeline}) {
  const frame = useCurrentFrame();
  const asset = getAsset(timeline, clip.assetId);
  const color = useMediaColor(clip.color);
  const moving = motionStyle(clip.motion, frame, timeline.fps, clip.motionTimeOffset), transition = transitionStyle(clip, frame);
  if (asset.type === 'audio') return null;
  return <div style={{position: 'absolute', inset: 0, overflow: 'hidden',
    ...(clip.position ? {left: clip.position.x, top: clip.position.y, width: clip.position.width, height: clip.position.height, right: 'auto', bottom: 'auto'} : {}),
    ...moving, ...transition, opacity: moving.opacity * transition.opacity}}>
    <MediaColorDefinition color={color}/>
    <SourcePicture asset={asset} framing={clip} fit={clip.fit ?? 'contain'} filter={color.filter}
      trimBefore={clip.sourceFrame} playbackRate={clip.playbackRate}/>
  </div>;
}

function ClipSound({clip, timeline}: {clip: any; timeline: Timeline}) {
  const asset = getAsset(timeline, clip.audioAssetId ?? clip.assetId);
  const audio = clip.audio ?? {}, role = audio.role ?? 'voice';
  if (audio.muted || asset.type === 'image' || asset.hasAudio === false || (timeline.audioRenderRole && timeline.audioRenderRole !== role)) return null;
  // Remotion supplies callback frames relative to the played Audio element.
  const gain = (frame: number) => {
    const time = frame / timeline.fps;
    let volume = volumeAt({...audio, curveOffset: (audio.curveOffset ?? 0) + (clip.audioTrimmedSeconds ?? 0),
      curveDuration: audio.curveDuration ?? clip.audioOriginalDurationSeconds}, time, clip.audioDurationInFrames / timeline.fps, clip.volume ?? 1);
    if (clip.audioFollowsPicture) {
      if (clip.transitionFrames) volume *= Math.min(1, Math.max(0, frame / (clip.transitionFrames - 1)));
      if (clip.outgoingTransitionFrames) volume *= Math.min(1, Math.max(0, (clip.durationInFrames - 1 - frame) / (clip.outgoingTransitionFrames - 1)));
    }
    return volume;
  };
  return <Audio src={asset.src} trimBefore={clip.audioSourceFrame ?? clip.sourceFrame}
    playbackRate={clip.playbackRate ?? 1} volume={gain}/>;
}

// The footage and its underline share the same fitted source rectangle. Its
// coordinates stay aligned through letterboxing, cover crops and camera motion.
function FocusedScreen({asset, overlay, fit, filter, frame, fps, trimBefore}: any) {
  const {target, zoom = 2, color = '#ffce42'} = overlay.screenFocus;
  const {x, y, width, height} = target.bounds;
  const ramp = screenFocusRamp(overlay.screenFocus, overlay.durationInFrames, fps);
  const t = screenFocusAmount(frame, ramp, overlay.durationInFrames);
  const aspect = asset.cropDisplaySize.width / asset.cropDisplaySize.height;
  const fitted = fit === 'cover' ? 'max' : 'min';
  const baseWidth = `${fitted}(100cqw, ${aspect * 100}cqh)`;
  const peakWidth = `min(calc(${zoom} * ${baseWidth}), ${100 / (width * SCREEN_LABEL_PADDING)}cqw, ${100 * aspect / (height * SCREEN_LABEL_PADDING)}cqh)`;
  const w = `calc(${1 - t} * ${baseWidth} + ${t} * ${peakWidth})`;
  const h = `calc(${w} / ${aspect})`;
  // Clamp the pan to available space so edge labels never expose extra black.
  const place = (viewport: string, size: string, center: number) => {
    const free = `calc(${viewport} - ${size})`;
    const desired = `calc(.5 * ${free} + ${(.5 - center) * t} * ${size})`;
    return `clamp(min(0px, ${free}), ${desired}, max(0px, ${free}))`;
  };
  const thickness = Math.min(height * .16, .012);
  return <div style={{position:'absolute', inset:0, overflow:'hidden', containerType:'size'}}>
    <div style={{position:'absolute', width:w, height:h, left:place('100cqw', w, x + width / 2), top:place('100cqh', h, y + height / 2)}}>
      <OffthreadVideo src={asset.src} trimBefore={trimBefore} muted style={{...mediaStyle, objectFit:'fill', filter}}/>
      <div style={{position:'absolute', left:`${x * 100}%`, top:`${Math.min(1 - thickness, y + height) * 100}%`,
        width:`${width * 100}%`, height:`${thickness * 100}%`, minHeight:1, backgroundColor:color, opacity:t}}/>
    </div>
  </div>;
}

function Overlay({overlay, timeline}: {overlay: any; timeline: Timeline}) {
  const frame = useCurrentFrame();
  const color = useMediaColor(overlay.color);
  const baseStyle = {...(GRAPHIC_PRESETS as any)[overlay.preset], ...overlay.style};
  const style = overlayStyle(baseStyle, frame, overlay.durationInFrames);
  const moving = motionStyle(overlay.motion, frame, timeline.fps);
  Object.assign(style, {transform: [style.transform, moving.transform].filter(Boolean).join(' '), opacity: Number(style.opacity ?? 1) * moving.opacity});
  const fill = valueAt(overlay.fill, frame / timeline.fps, 0);
  const tint = overlay.colors?.findLast((point: {frame: number}) => point.frame <= frame)?.value;
  if (overlay.preset === 'meter') {
    const track = style.backgroundColor;
    return <div style={{...style, backgroundColor:'transparent', display:'flex', flexDirection:'column', justifyContent:'center'}}>
      <div style={{color:'white', fontFamily:'Arial, sans-serif'}}>{overlay.text}</div>
      <div style={{position:'relative', backgroundColor:track, height:'32%', overflow:'hidden', borderRadius:999}}>
        <div style={{height:'100%', width:`${fill * 100}%`, backgroundColor:tint ?? style.color}}/>
      </div>
    </div>;
  }
  if (overlay.fill?.length) style.clipPath = `inset(0 ${(1 - fill) * 100}% 0 0)`;
  if (tint) style.color = tint;
  if (overlay.type === 'text') return <div style={{display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'white', fontSize: 56, fontFamily: 'Arial, sans-serif', whiteSpace: 'pre-wrap', ...style}}>{overlay.text}</div>;
  const asset = getAsset(timeline, overlay.assetId);
  const trimBefore = Math.round((overlay.sourceStart ?? 0) * timeline.fps);
  const audio = overlay.audio ?? {}, role = audio.role ?? 'effects';
  const hasSound = !audio.muted && asset.type !== 'image' && asset.hasAudio !== false && (!timeline.audioRenderRole || timeline.audioRenderRole === role);
  const sound = hasSound ? <Audio src={asset.src} trimBefore={trimBefore}
    volume={f => volumeAt(audio, f / timeline.fps, overlay.durationInFrames / timeline.fps, overlay.volume ?? 1)}/> : null;
  if (overlay.type === 'audio') return sound;
  return <><div style={{...style, overflow: 'hidden'}}><MediaColorDefinition color={color}/>
    {overlay.screenFocus ? <FocusedScreen asset={asset} overlay={overlay} fit={baseStyle.objectFit ?? 'contain'} frame={frame}
      fps={timeline.fps} trimBefore={trimBefore} filter={color.filter}/> :
      <SourcePicture asset={asset} framing={overlay} fit={baseStyle.objectFit ?? 'contain'} objectPosition={baseStyle.objectPosition}
        filter={color.filter} trimBefore={trimBefore}/>}
  </div>{sound}</>;
}

function CaptionPages({timeline}: {timeline: Timeline}) {
  const frame = useCurrentFrame();
  const style = timeline.captionsStyle ?? {};
  if (timeline.captionCues) {
    if (style.enabled === false) return null;
    const cue = timeline.captionCues.find(c => frame >= c.startFrame && frame < c.endFrame);
    if (!cue) return null;
    const active = cue.words?.findLastIndex((word: any) => word.startFrame <= frame);
    return <div style={{position: 'absolute', left: '5%', width: '90%', bottom: style.bottom ?? 100, display: 'flex', justifyContent: 'center', zIndex: 1000, fontFamily: 'Arial, sans-serif'}}>
      <div style={{padding: '.18em .35em', borderRadius: 12, backgroundColor: 'rgba(0,0,0,.78)', fontSize: style.fontSize ?? 56, lineHeight: 1.2,
        fontWeight: 700, textAlign: 'center', whiteSpace: 'pre-wrap', color: style.color ?? '#ffffff'}}>
        {cue.words ? cue.words.map((word: any, i: number) => <React.Fragment key={`${word.id}-${i}`}>
          {i ? word.lineBreakBefore ? '\n' : ' ' : ''}<span style={{color: i === active ? style.highlightColor ?? '#ffd860' : style.color ?? '#ffffff'}}>{word.text}</span>
        </React.Fragment>) : cue.text}
      </div>
    </div>;
  }
  return null;
}

const slideFromRight = slide({direction: 'from-right'});

function ClipPictures({timeline}: {timeline: Timeline}) {
  // Only neighboring clips joined by slides need a shared TransitionSeries.
  // Retain the compiled absolute start and the local source clock for every run.
  const runs: Timeline['clips'][] = [];
  for (const clip of timeline.clips) {
    if (clip.type === 'gap') continue;
    if (clip.transition?.type === 'slide') runs[runs.length - 1].push(clip);
    else runs.push([clip]);
  }
  return runs.map(run => {
    const first = run[0], last = run[run.length - 1];
    const end = last.from + last.durationInFrames;
    return <Sequence key={first.id} from={first.from} durationInFrames={end - first.from}>
      {run.length === 1 ? <Clip clip={first} timeline={timeline}/> :
        <TransitionSeries>{run.flatMap((clip, i) => {
          const picture = <TransitionSeries.Sequence key={`clip-${clip.id}`} durationInFrames={clip.durationInFrames}>
            <Clip clip={clip} timeline={timeline}/>
          </TransitionSeries.Sequence>;
          if (!i) return [picture];
          return [<TransitionSeries.Transition key={`slide-${clip.id}`} presentation={slideFromRight}
            timing={linearTiming({durationInFrames: clip.transitionFrames})}
            motionBlur={clip.transition.motionBlur ? {} : undefined}/>, picture];
        })}</TransitionSeries>}
    </Sequence>;
  });
}

export function TimelineComposition({timeline, customLayerProps}: EngineProps) {
  const CustomLayer = useContext(CustomLayerContext);
  return <AbsoluteFill style={{backgroundColor: timeline.settings?.background ?? '#000000'}}>
    <AbsoluteFill style={{zIndex: 0, isolation: 'isolate'}}>
      <ClipPictures timeline={timeline}/>
      {timeline.clips.filter(clip => clip.type !== 'gap' && clip.audioDurationInFrames > 0).map(clip => <Sequence key={`audio-${clip.id}`}
        from={clip.audioFrom} durationInFrames={clip.audioDurationInFrames} layout="none">
        <ClipSound clip={clip} timeline={timeline}/>
      </Sequence>)}
      {timeline.overlays.map((overlay) => <Sequence key={overlay.id} from={overlay.from}
        durationInFrames={overlay.durationInFrames} layout={overlay.type === 'audio' ? 'none' : 'absolute-fill'}>
        <Overlay overlay={overlay} timeline={timeline}/>
      </Sequence>)}
    </AbsoluteFill>
    {CustomLayer && (!timeline.audioRenderRole || timeline.audioRenderRole === 'effects') ? <AbsoluteFill style={{zIndex: 1, isolation: 'isolate'}}>
      <CustomLayer {...customLayerProps} timeline={timeline}/>
    </AbsoluteFill> : null}
    <AbsoluteFill style={{zIndex: 2, isolation: 'isolate'}}><CaptionPages timeline={timeline}/></AbsoluteFill>
  </AbsoluteFill>;
}

const empty: Timeline = {fps: 30, width: 1080, height: 1920, durationInFrames: 1,
  assets: [], clips: [], overlays: [], captions: []};

// Some registered images, including SVGs, have dimensions only the browser can read.
async function engineMetadata({props}: {props: EngineProps}) {
  const {timeline} = props;
  const metadata = {fps: timeline.fps, width: timeline.width, height: timeline.height, durationInFrames: timeline.durationInFrames};
  if (!timeline.assets.some(asset => asset.cropDisplaySize === null)) return metadata;
  const assets = await Promise.all(timeline.assets.map(async asset => {
    if (asset.cropDisplaySize !== null) return asset;
    const image = new Image();
    image.src = asset.src;
    await image.decode();
    return {...asset, cropDisplaySize: {width: image.naturalWidth, height: image.naturalHeight}};
  }));
  return {...metadata, props: {...props, timeline: {...timeline, assets}}};
}

export function EngineRoot() {
  return <Composition id="AgentVideo" component={TimelineComposition} width={1080} height={1920}
    fps={30} durationInFrames={1} defaultProps={{timeline: empty, customLayerProps: {}}}
    calculateMetadata={engineMetadata}/>;
}

// Called exactly once by the generated bundle entry, before React renders.
// Components stay stable across frames; no component is created during render.
export function createEngineRoot(CustomLayer: React.ComponentType<any>) {
  return function EngineRootWithLayer() {
    return <CustomLayerContext.Provider value={CustomLayer}><EngineRoot/></CustomLayerContext.Provider>;
  };
}
