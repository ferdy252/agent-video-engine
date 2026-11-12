import React, {createContext, useContext, useId} from 'react';
import {colorTransform} from './color-settings.mjs';
import {motionStyle, transitionStyle, GRAPHIC_PRESETS} from './edit-controls.mjs';
import {volumeAt} from './audio-settings.mjs';
import {
  AbsoluteFill, Audio, Composition, Img, OffthreadVideo, Sequence,
  useCurrentFrame,
} from 'remotion';

type Asset = {id: string; src: string; type: string; hasAudio?: boolean};
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

function Clip({clip, timeline}: {clip: any; timeline: Timeline}) {
  const frame = useCurrentFrame();
  const asset = getAsset(timeline, clip.assetId);
  const color = useMediaColor(clip.color);
  const moving = motionStyle(clip.motion, frame, timeline.fps, clip.motionTimeOffset), transition = transitionStyle(clip, frame);
  const crop = clip.crop ?? {}, w = 1 - (crop.left ?? 0) - (crop.right ?? 0), h = 1 - (crop.top ?? 0) - (crop.bottom ?? 0);
  const style: React.CSSProperties = {position: 'absolute', left: `${-(crop.left ?? 0) / w * 100}%`, top: `${-(crop.top ?? 0) / h * 100}%`,
    width: `${100 / w}%`, height: `${100 / h}%`, objectFit: clip.fit ?? 'contain',
    objectPosition: `${(clip.focus?.x ?? .5) * 100}% ${(clip.focus?.y ?? .5) * 100}%`, filter: color.filter};
  if (asset.type === 'audio') return null;
  return <div style={{position: 'absolute', inset: 0, overflow: 'hidden',
    ...(clip.position ? {left: clip.position.x, top: clip.position.y, width: clip.position.width, height: clip.position.height, right: 'auto', bottom: 'auto'} : {}),
    ...moving, ...transition, opacity: moving.opacity * transition.opacity}}>
    <MediaColorDefinition color={color}/>
    {asset.type === 'image' ? <Img src={asset.src} style={style}/> : <OffthreadVideo src={asset.src} trimBefore={clip.sourceFrame}
      playbackRate={clip.playbackRate ?? 1} muted style={style}/>}
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

function Overlay({overlay, timeline}: {overlay: any; timeline: Timeline}) {
  const frame = useCurrentFrame();
  const color = useMediaColor(overlay.color);
  const baseStyle = {...(GRAPHIC_PRESETS as any)[overlay.preset], ...overlay.style};
  const style = overlayStyle(baseStyle, frame, overlay.durationInFrames);
  const moving = motionStyle(overlay.motion, frame, timeline.fps);
  Object.assign(style, {transform: [style.transform, moving.transform].filter(Boolean).join(' '), opacity: Number(style.opacity ?? 1) * moving.opacity});
  if (overlay.type === 'text') return <div style={{display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'white', fontSize: 56, fontFamily: 'Arial, sans-serif', whiteSpace: 'pre-wrap', ...style}}>{overlay.text}</div>;
  const asset = getAsset(timeline, overlay.assetId);
  const trimBefore = Math.round((overlay.sourceStart ?? 0) * timeline.fps);
  const audio = overlay.audio ?? {}, role = audio.role ?? 'effects';
  const hasSound = !audio.muted && asset.type !== 'image' && asset.hasAudio !== false && (!timeline.audioRenderRole || timeline.audioRenderRole === role);
  const sound = hasSound ? <Audio src={asset.src} trimBefore={trimBefore}
    volume={f => volumeAt(audio, f / timeline.fps, overlay.durationInFrames / timeline.fps, overlay.volume ?? 1)}/> : null;
  if (overlay.type === 'audio') return sound;
  const crop = overlay.crop ?? {}, w = 1 - (crop.left ?? 0) - (crop.right ?? 0), h = 1 - (crop.top ?? 0) - (crop.bottom ?? 0);
  const pictureStyle: React.CSSProperties = {position: 'absolute', left: `${-(crop.left ?? 0) / w * 100}%`, top: `${-(crop.top ?? 0) / h * 100}%`,
    width: `${100 / w}%`, height: `${100 / h}%`, objectFit: baseStyle.objectFit ?? 'contain',
    objectPosition: baseStyle.objectPosition ?? `${(overlay.focus?.x ?? .5) * 100}% ${(overlay.focus?.y ?? .5) * 100}%`, filter: color.filter};
  return <><div style={{...style, overflow: 'hidden'}}><MediaColorDefinition color={color}/>
    {overlay.type === 'image' ? <Img src={asset.src} style={pictureStyle}/> : <OffthreadVideo src={asset.src} trimBefore={trimBefore} muted style={pictureStyle}/>}
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

export function TimelineComposition({timeline, customLayerProps}: EngineProps) {
  const CustomLayer = useContext(CustomLayerContext);
  return <AbsoluteFill style={{backgroundColor: timeline.settings?.background ?? '#000000'}}>
    <AbsoluteFill style={{zIndex: 0, isolation: 'isolate'}}>
      {timeline.clips.filter(clip => clip.type !== 'gap').map((clip) => <Sequence key={clip.id} from={clip.from} durationInFrames={clip.durationInFrames}>
        <Clip clip={clip} timeline={timeline}/>
      </Sequence>)}
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

export function EngineRoot() {
  return <Composition id="AgentVideo" component={TimelineComposition} width={1080} height={1920}
    fps={30} durationInFrames={1} defaultProps={{timeline: empty, customLayerProps: {}}}
    calculateMetadata={({props}) => ({fps: props.timeline.fps, width: props.timeline.width,
      height: props.timeline.height, durationInFrames: props.timeline.durationInFrames})}/>;
}

// Called exactly once by the generated bundle entry, before React renders.
// Components stay stable across frames; no component is created during render.
export function createEngineRoot(CustomLayer: React.ComponentType<any>) {
  return function EngineRootWithLayer() {
    return <CustomLayerContext.Provider value={CustomLayer}><EngineRoot/></CustomLayerContext.Provider>;
  };
}
