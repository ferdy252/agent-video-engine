import React, {createContext, useContext, useId, useMemo} from 'react';
import {colorTransform} from './color-settings.mjs';
import {
  AbsoluteFill, Audio, Composition, Img, OffthreadVideo, Sequence,
  useCurrentFrame,
} from 'remotion';

type Asset = {id: string; src: string; type: string; hasAudio?: boolean};
type Timeline = {
  fps: number; width: number; height: number; durationInFrames: number;
  assets: Asset[]; clips: any[]; overlays: any[]; captions: any[];
  settings?: Record<string, any>; captionsStyle?: Record<string, any>;
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
  const asset = getAsset(timeline, clip.assetId);
  const color = useMediaColor(clip.color);
  const volume = clip.volume ?? 1;
  const style: React.CSSProperties = {...mediaStyle, objectFit: clip.fit ?? 'contain',
    ...(clip.position ? {position: 'absolute', left: clip.position.x, top: clip.position.y,
      width: clip.position.width, height: clip.position.height} : {}), filter: color.filter};
  if (asset.type === 'image') return <><MediaColorDefinition color={color}/><Img src={asset.src} style={style}/></>;
  if (asset.type === 'audio') return <Audio src={asset.src} trimBefore={clip.sourceFrame}
    playbackRate={clip.playbackRate ?? 1} volume={volume}/>;
  return <><MediaColorDefinition color={color}/><OffthreadVideo src={asset.src} trimBefore={clip.sourceFrame}
    playbackRate={clip.playbackRate ?? 1} volume={volume}
    muted={volume === 0 || asset.hasAudio === false}
    style={style}/></>;
}

function Overlay({overlay, timeline}: {overlay: any; timeline: Timeline}) {
  const frame = useCurrentFrame();
  const color = useMediaColor(overlay.color);
  const style = overlayStyle(overlay.style, frame, overlay.durationInFrames);
  if (overlay.type === 'text') return <div style={{display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'white', fontSize: 56, fontFamily: 'Arial, sans-serif', whiteSpace: 'pre-wrap', ...style}}>{overlay.text}</div>;
  const asset = getAsset(timeline, overlay.assetId);
  const trimBefore = Math.round((overlay.sourceStart ?? 0) * timeline.fps);
  if (overlay.type === 'audio') return <Audio src={asset.src} trimBefore={trimBefore} volume={overlay.volume ?? 1}/>;
  const mediaStyle = {objectFit: 'contain' as const, ...style, filter: color.filter};
  if (overlay.type === 'image') return <><MediaColorDefinition color={color}/><Img src={asset.src} style={mediaStyle}/></>;
  return <><MediaColorDefinition color={color}/><OffthreadVideo src={asset.src} trimBefore={trimBefore} volume={overlay.volume ?? 1}
    muted={overlay.volume === 0 || asset.hasAudio === false} style={mediaStyle}/></>;
}

function CaptionPages({timeline}: {timeline: Timeline}) {
  const frame = useCurrentFrame();
  const style = timeline.captionsStyle ?? {};
  const pageSize = Math.min(50, Math.max(1, Math.floor(style.wordsPerPage ?? 5)));
  const pages = useMemo(() => {
    const words = timeline.captions.filter((word) => word.endFrame > word.startFrame)
      .slice().sort((a, b) => a.startFrame - b.startFrame);
    const result: any[][] = [];
    for (const word of words) {
      const page = result[result.length - 1];
      const previous = page?.[page.length - 1];
      if (!page || page.length >= pageSize || previous.clipId !== word.clipId ||
        word.startFrame - previous.endFrame > timeline.fps * .4) result.push([word]);
      else page.push(word);
    }
    return result;
  }, [timeline.captions, timeline.fps, pageSize]);
  if (style.enabled === false) return null;
  const pageIndex = pages.findIndex((page, index) => frame >= page[0].startFrame &&
    frame < Math.min(page[page.length - 1].endFrame, pages[index + 1]?.[0].startFrame ?? Infinity));
  if (pageIndex < 0) return null;
  const page = pages[pageIndex];
  let active = -1;
  page.forEach((word, index) => {if (word.startFrame <= frame) active = index;});
  return <div style={{position: 'absolute', left: '5%', width: '90%', bottom: style.bottom ?? 100,
    display: 'flex', justifyContent: 'center', zIndex: 1000, fontFamily: 'Arial, sans-serif'}}>
    <div style={{display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '0 .22em',
      padding: '.18em .35em', borderRadius: 12, backgroundColor: 'rgba(0,0,0,.78)',
      fontSize: style.fontSize ?? 56, lineHeight: 1.2, fontWeight: 700, textAlign: 'center'}}>
      {page.map((word, index) => <span key={`${word.id}-${word.startFrame}-${index}`}
        style={{color: index === active ? style.highlightColor ?? '#ffd860' : style.color ?? '#ffffff'}}>{word.text}</span>)}
    </div>
  </div>;
}

export function TimelineComposition({timeline, customLayerProps}: EngineProps) {
  const CustomLayer = useContext(CustomLayerContext);
  return <AbsoluteFill style={{backgroundColor: timeline.settings?.background ?? '#000000'}}>
    <AbsoluteFill style={{zIndex: 0, isolation: 'isolate'}}>
      {timeline.clips.map((clip) => <Sequence key={clip.id} from={clip.from} durationInFrames={clip.durationInFrames}>
        <Clip clip={clip} timeline={timeline}/>
      </Sequence>)}
      {timeline.overlays.map((overlay) => <Sequence key={overlay.id} from={overlay.from}
        durationInFrames={overlay.durationInFrames} layout={overlay.type === 'audio' ? 'none' : 'absolute-fill'}>
        <Overlay overlay={overlay} timeline={timeline}/>
      </Sequence>)}
    </AbsoluteFill>
    {CustomLayer ? <AbsoluteFill style={{zIndex: 1, isolation: 'isolate'}}>
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
