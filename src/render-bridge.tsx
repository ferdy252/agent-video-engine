// Headless bridge for Remotion 4.0.534, adapted from the upstream Studio
// renderEntry runtime. It contains no editor, player controls or Studio loader.
// See THIRD_PARTY_REMOTION_NOTICE.md for origin and retained license terms.
import React, {useContext, useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {continueRender, delayRender, getInputProps, Internals, useDelayRender} from 'remotion';
import {NoReactInternals} from 'remotion/no-react';

const browser = window as any;
Internals.CSSUtils.injectCSS(Internals.CSSUtils.makeDefaultPreviewCSS(null, '#000000'));
let root: ReturnType<typeof createRoot> | undefined;

function Canvas({mode}: {mode: any}) {
  const {compositions, currentCompositionMetadata, canvasContent} = useContext(Internals.CompositionManager);
  const {setCanvasContent} = useContext(Internals.CompositionSetters);
  const container = useRef<HTMLDivElement>(null);
  const {delayRender: delay, continueRender: resume} = useDelayRender();
  const [handle] = useState(() => delay(`Waiting for composition ${mode.compositionName}`));
  useEffect(() => () => resume(handle), [handle, resume]);
  useEffect(() => {
    if (!compositions.length) return;
    if (!compositions.some((composition) => composition.id === mode.compositionName)) {
      throw new Error(`Unknown composition ${mode.compositionName}. Available: ${compositions.map((composition) => composition.id).join(', ')}`);
    }
    setCanvasContent({type: 'composition', compositionId: mode.compositionName});
  }, [compositions, mode.compositionName, setCanvasContent]);
  useEffect(() => {
    if (!canvasContent || !container.current) return;
    const element = container.current;
    const portal = Internals.portalNode();
    element.appendChild(portal);
    resume(handle);
    return () => {if (portal.parentNode === element) element.removeChild(portal);};
  }, [canvasContent, handle, resume]);
  if (!currentCompositionMetadata) return null;
  return <div id="remotion-canvas" ref={container} style={{display: 'flex', backgroundColor: 'transparent',
    width: currentCompositionMetadata.width, height: currentCompositionMetadata.height}}/>;
}

function mount(Root: React.ComponentType, mode: any) {
  if (!['evaluation', 'composition'].includes(mode.type)) throw new Error('This bundle supports headless rendering only');
  const rendering = mode.type === 'composition';
  const metadata = rendering ? {
    props: NoReactInternals.deserializeJSONWithSpecialTypes(mode.serializedResolvedPropsWithSchema),
    durationInFrames: mode.compositionDurationInFrames, fps: mode.compositionFps,
    width: mode.compositionWidth, height: mode.compositionHeight,
    defaultCodec: mode.compositionDefaultCodec, defaultOutName: mode.compositionDefaultOutName,
    defaultVideoImageFormat: mode.compositionDefaultVideoImageFormat, defaultPixelFormat: mode.compositionDefaultPixelFormat,
    defaultProResProfile: mode.compositionDefaultProResProfile, defaultSampleRate: mode.compositionDefaultSampleRate,
  } : null;
  root ??= createRoot(document.getElementById('video-container')!);
  root.render(<Internals.CompositionManagerProvider initialCanvasContent={null}
    onlyRenderComposition={rendering ? mode.compositionName : null} currentCompositionMetadata={metadata}
    initialCompositions={[]}>
    <Internals.RemotionRootContexts frameState={null} audioEnabled={browser.remotion_audioEnabled}
      videoEnabled={browser.remotion_videoEnabled} logLevel={browser.remotion_logLevel ?? 'error'}
      numberOfAudioTags={0} audioLatencyHint={browser.remotion_audioLatencyHint ?? 'playback'}
      previewSampleRate={browser.remotion_sampleRate ?? 48000} _experimentalKeepAudioContextAlive={false}>
      <Internals.RenderAssetManagerProvider collectAssets={null}>
        <Root/>{rendering ? <Canvas mode={mode}/> : null}
      </Internals.RenderAssetManagerProvider>
    </Internals.RemotionRootContexts>
  </Internals.CompositionManagerProvider>);
}

function compositions() {
  if (!Internals.getRoot()) throw new Error('The entry point did not call registerRoot()');
  if (!Internals.compositionsRef.current) throw new Error('Composition manager has not mounted');
  return Internals.compositionsRef.current.getCompositions();
}

async function calculate(id: string) {
  const composition = compositions().find((item) => item.id === id);
  if (!composition) throw new Error(`Unknown composition ${id}`);
  const handle = delayRender(`Calculating metadata for ${id}`);
  try {
    const result = await Internals.resolveVideoConfig({
      calculateMetadata: composition.calculateMetadata,
      compositionDurationInFrames: composition.durationInFrames ?? null,
      compositionFps: composition.fps ?? null, compositionWidth: composition.width ?? null,
      compositionHeight: composition.height ?? null, compositionId: composition.id,
      inputProps: {...composition.defaultProps ?? {}, ...getInputProps() ?? {}},
      defaultProps: composition.defaultProps ?? {}, signal: new AbortController().signal,
    });
    const {props, defaultProps, ...metadata} = result;
    const serialize = (data: unknown) => NoReactInternals.serializeJSONWithSpecialTypes({data,
      indent: undefined, staticBase: null}).serializedString;
    return {...metadata, serializedResolvedPropsWithCustomSchema: serialize(props),
      serializedDefaultPropsWithCustomSchema: serialize(defaultProps)};
  } finally {continueRender(handle);}
}

const loading = delayRender('Loading headless Remotion composition', {
  timeoutInMilliseconds: browser.remotion_puppeteerTimeout ?? 10000,
});
Internals.waitForRoot(() => continueRender(loading));
browser.getStaticCompositions = () => Promise.all(compositions().map((composition) => calculate(composition.id)));
browser.remotion_getCompositionNames = () => compositions().map((composition) => composition.id);
browser.remotion_calculateComposition = calculate;
browser.remotion_setBundleMode = (mode: any) => {
  const handle = delayRender('Mounting headless Remotion composition');
  Internals.waitForRoot((Root) => {
    mount(Root, mode);
    requestAnimationFrame(() => continueRender(handle));
  });
};
