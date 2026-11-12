import {link, lstat, mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {basename, dirname, extname, isAbsolute, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assertAssets} from './media.mjs';
import {MOTION_LIMITS} from './edit-controls.mjs';
import {validateProject} from './project.mjs';
import {compileTimeline} from './timeline.mjs';

export const DELIVERY_PRESETS = Object.freeze({
  vertical: Object.freeze({width: 1080, height: 1920}),
  horizontal: Object.freeze({width: 1920, height: 1080}),
  square: Object.freeze({width: 1080, height: 1080}),
});

function fail(message, code = 'INVALID_DELIVERY_REQUEST') {
  throw Object.assign(new Error(message), {code});
}

function checkAbort(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Delivery cancelled'), {name: 'AbortError', code: 'CANCELLED'});
}

function deliverySnapshot(project) {
  const snapshot = structuredClone(project);
  validateProject(snapshot);
  if (snapshot.custom && snapshot.custom.mode !== 'layer') {
    fail('Delivery needs the engine output clock. Adapt the standalone composition to custom.mode:"layer" first.',
      'UNSUPPORTED_CUSTOM_DELIVERY');
  }
  return snapshot;
}

function scaled(value, factor) {
  return Math.max(-Number.MAX_VALUE, Math.min(Number.MAX_VALUE, value * factor));
}

function scaleMotion(motion, x, y) {
  if (!motion) return;
  for (const [axis, factor] of [['x', x], ['y', y]]) {
    const [minimum, maximum] = MOTION_LIMITS[axis];
    for (const point of motion[axis] ?? []) {
      point.value = Math.max(minimum, Math.min(maximum, scaled(point.value, factor)));
    }
  }
}

/** Derive a render-only framing variant from the saved project. */
export function applyDeliveryPreset(project, {preset, fit = 'contain'} = {}) {
  if (!Object.hasOwn(DELIVERY_PRESETS, preset)) fail('preset must be vertical, horizontal or square.');
  if (fit !== 'contain' && fit !== 'cover') fail('fit must be contain or cover.');
  const snapshot = deliverySnapshot(project);
  const {width, height} = DELIVERY_PRESETS[preset];
  const x = width / snapshot.settings.width;
  const y = height / snapshot.settings.height;
  const uniform = Math.min(x, y);
  const assets = new Map(snapshot.assets.map((asset) => [asset.id, asset]));
  snapshot.settings = {...snapshot.settings, width, height};
  for (const clip of snapshot.clips) {
    if (clip.type === 'gap' || assets.get(clip.assetId)?.type === 'audio') continue;
    clip.fit = fit;
    scaleMotion(clip.motion, x, y);
    if (clip.position) {
      clip.position = {x: scaled(clip.position.x, x), y: scaled(clip.position.y, y),
        width: Math.max(Number.EPSILON, scaled(clip.position.width, x)),
        height: Math.max(Number.EPSILON, scaled(clip.position.height, y))};
    }
  }
  const styleFactors = {left: x, right: x, width: x, top: y, bottom: y, height: y,
    fontSize: uniform, padding: uniform, letterSpacing: uniform, borderRadius: uniform};
  for (const overlay of snapshot.overlays) {
    if (overlay.type === 'audio') continue;
    scaleMotion(overlay.motion, x, y);
    if (!overlay.style) continue;
    for (const [key, factor] of Object.entries(styleFactors)) {
      if (typeof overlay.style[key] === 'number') overlay.style[key] = scaled(overlay.style[key], factor);
    }
  }
  snapshot.captions.fontSize = Math.max(1, Math.min(1000, scaled(snapshot.captions.fontSize, uniform)));
  snapshot.captions.bottom = scaled(snapshot.captions.bottom, y);
  return snapshot;
}

async function publishFile(outputPath, extension, data, {signal, verify} = {}) {
  checkAbort(signal);
  if (typeof outputPath !== 'string' || !isAbsolute(outputPath) || extname(outputPath).toLowerCase() !== extension) {
    fail(`outputPath must be an absolute local path ending in ${extension}.`);
  }
  await mkdir(dirname(outputPath), {recursive: true});
  const parent = await realpath(dirname(outputPath));
  const output = join(parent, basename(outputPath));
  try {await lstat(output); fail('Output already exists. Choose a new versioned outputPath.', 'OUTPUT_EXISTS');}
  catch (error) {if (error.code !== 'ENOENT') throw error;}
  const work = await mkdtemp(join(parent, '.agent-video-delivery-'));
  try {
    const partial = join(work, `delivery${extension}`);
    await writeFile(partial, data, {flag: 'wx', mode: 0o600, signal});
    await verify?.();
    checkAbort(signal);
    try {await link(partial, output);}
    catch (error) {
      if (error.code === 'EEXIST') fail('Output already exists. Choose a new versioned outputPath.', 'OUTPUT_EXISTS');
      throw error;
    }
    return output;
  } finally {
    await rm(work, {recursive: true, force: true});
  }
}

function subtitleTime(frame, fps, separator) {
  const milliseconds = Math.round(frame * 1000 / fps);
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor(milliseconds / 60000) % 60;
  const seconds = Math.floor(milliseconds / 1000) % 60;
  const clock = [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
  return `${clock}${separator}${String(milliseconds % 1000).padStart(3, '0')}`;
}

function subtitleText(value, format) {
  const text = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
  if (format === 'srt') return text;
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Write plain sidecar cues on the same edited frame clock as rendered captions. */
export async function exportSubtitles(project, {outputPath, format, signal} = {}) {
  checkAbort(signal);
  if (format !== 'srt' && format !== 'vtt') fail('Subtitle format must be srt or vtt.');
  const snapshot = deliverySnapshot(project);
  const timeline = compileTimeline(snapshot);
  const separator = format === 'srt' ? ',' : '.';
  const cues = (timeline.captionCues ?? []).flatMap((cue) => {
    const from = Math.max(0, cue.startFrame);
    const to = Math.min(timeline.durationInFrames, cue.endFrame);
    const text = subtitleText(cue.text, format);
    if (!text || to <= from) return [];
    const start = subtitleTime(from, timeline.fps, separator);
    const end = subtitleTime(to, timeline.fps, separator);
    return [`${start} --> ${end}\n${text}`];
  });
  const body = cues.map((cue, index) => `${index + 1}\n${cue}\n`).join('\n');
  const data = format === 'vtt' ? `WEBVTT\n\n${body}` : body;
  const output = await publishFile(outputPath, `.${format}`, data, {signal});
  return {kind: 'subtitles', format, revision: snapshot.revision, outputPath: output,
    cueCount: cues.length, fps: timeline.fps, durationInFrames: timeline.durationInFrames,
    ...(timeline.captionOverrideReview ? {captionOverrideReview: timeline.captionOverrideReview} : {}),
    limitations: ['Subtitle sidecars carry cue text and timing. Caption typography, placement and per-word highlighting stay in the rendered video.']};
}

const namespace = 'agent_video_engine';
const time = (value, rate) => ({OTIO_SCHEMA: 'RationalTime.1', rate, value});
const range = (start, duration, fps) => ({OTIO_SCHEMA: 'TimeRange.1',
  start_time: time(start, fps), duration: time(duration, fps)});
const metadata = (values) => ({[namespace]: values});
const item = (schema, name, sourceRange = null, values = {}, enabled = true) => ({
  OTIO_SCHEMA: schema, metadata: values, name, source_range: sourceRange,
  effects: [], markers: [], enabled, color: null,
});
const gap = (frames, fps, id) => item('Gap.1', id ?? 'Gap', range(0, frames, fps), id ? metadata({clipId: id}) : {});
const track = (name, kind, children) => ({...item('Track.1', name), kind, children});

function mediaClip(asset, segment, fps, usedAssets) {
  usedAssets.add(asset.id);
  const name = basename(asset.path);
  const {sourceFrame, duration, rate, kind, ...details} = segment;
  const sourceFps = asset.fps ?? fps;
  const sourceStart = asset.type === 'image' ? 0 : sourceFrame / fps;
  const reference = {
    OTIO_SCHEMA: 'ExternalReference.1', metadata: metadata({assetId: asset.id, type: asset.type}),
    name, target_url: pathToFileURL(asset.path).href, available_image_bounds: null,
    available_range: asset.type === 'image' ? null : range(0, asset.duration * sourceFps, sourceFps),
  };
  const clip = item('Clip.2', name, {OTIO_SCHEMA: 'TimeRange.1',
    start_time: time(sourceStart * sourceFps, sourceFps), duration: time(duration, fps)},
  metadata({...details, assetId: asset.id, playbackRate: rate}), kind !== 'Audio' || details.volume !== 0);
  if (rate !== 1 && asset.type !== 'image') clip.effects.push({OTIO_SCHEMA: 'LinearTimeWarp.1', metadata: {},
    name: 'Playback rate', effect_name: 'LinearTimeWarp', enabled: true, time_scalar: rate});
  return {...clip, media_references: {DEFAULT_MEDIA: reference}, active_media_reference_key: 'DEFAULT_MEDIA'};
}

function transition(left, right, fps) {
  const overlap = left.from + left.durationInFrames - right.from;
  if (overlap <= 0) return null;
  const before = Math.floor(overlap / 2);
  const after = overlap - before;
  const type = right.transition?.type ?? 'crossfade';
  return {before, after, cut: right.from + before, node: {
    OTIO_SCHEMA: 'Transition.1', metadata: metadata({type, fromFrame: right.from, durationInFrames: overlap}),
    name: type, in_offset: time(before, fps), out_offset: time(after, fps),
    transition_type: type === 'crossfade' ? 'SMPTE_Dissolve' : 'Custom_Transition',
  }};
}

function mainVideoTrack(timeline, assets, usedAssets) {
  const {clips, fps, durationInFrames} = timeline;
  const joins = clips.map((clip, index) => index ? transition(clips[index - 1], clip, fps) : null);
  const children = [];
  let cursor = 0;
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index], asset = assets.get(clip.assetId);
    const incoming = joins[index], outgoing = joins[index + 1];
    const start = incoming?.cut ?? clip.from;
    const end = outgoing?.cut ?? clip.from + clip.durationInFrames;
    if (start > cursor) children.push(gap(start - cursor, fps));
    if (incoming) children.push(incoming.node);
    const duration = end - start;
    const rate = clip.playbackRate ?? 1;
    if (!asset || asset.type === 'audio') children.push(gap(duration, fps, clip.id));
    else children.push(mediaClip(asset, {kind: 'Video', duration, rate, clipId: clip.id,
      sourceFrame: clip.sourceFrame + (start - clip.from) * rate, fromFrame: start,
      sourceStart: clip.sourceStart, sourceEnd: clip.sourceEnd, fit: clip.fit,
      position: clip.position, color: clip.color}, fps, usedAssets));
    cursor = end;
  }
  if (cursor < durationInFrames) children.push(gap(durationInFrames - cursor, fps));
  return {track: track('Main picture', 'Video', children),
    transitionCount: joins.filter(Boolean).length};
}

function placedTrack(segments, name, kind, fps, usedAssets) {
  const children = [];
  let cursor = 0;
  for (const {asset, from, ...segment} of segments) {
    if (from > cursor) children.push(gap(from - cursor, fps));
    children.push(mediaClip(asset, {...segment, kind, fromFrame: from}, fps, usedAssets));
    cursor = from + segment.duration;
  }
  return track(name, kind, children);
}

function audioLanes(segments, fps, usedAssets) {
  const lanes = [];
  const sorted = segments.sort((left, right) => left.from - right.from);
  for (const segment of sorted) {
    let lane = lanes.find((entry) => entry.end <= segment.from);
    if (!lane) {lane = {end: 0, segments: []}; lanes.push(lane);}
    lane.segments.push(segment);
    lane.end = segment.from + segment.duration;
  }
  return lanes.map(({segments: entries}, index) => placedTrack(entries, `Sound ${index + 1}`, 'Audio', fps, usedAssets));
}

function carriesAudio(asset) {
  return asset?.type === 'audio' || (asset?.type === 'video' && asset.hasAudio !== false);
}

function collectAudio(timeline, assets) {
  return timeline.clips.flatMap((clip) => {
    const asset = assets.get(clip.audioAssetId ?? clip.assetId);
    if (!carriesAudio(asset)) return [];
    const rawFrom = clip.audioFrom ?? clip.from;
    const from = Math.max(0, rawFrom);
    const end = Math.min(timeline.durationInFrames, rawFrom + (clip.audioDurationInFrames ?? clip.durationInFrames));
    if (end <= from) return [];
    const rate = clip.playbackRate ?? 1;
    return [{asset, from, duration: end - from, rate, clipId: clip.id, volume: clip.audio?.muted ? 0 : clip.volume,
      sourceFrame: (clip.audioSourceFrame ?? clip.sourceFrame) + (from - rawFrom) * rate, audio: clip.audio}];
  });
}

/** Write an editable OTIO document with real media references and tracks. */
export async function exportTimeline(project, {outputPath, format = 'otio', signal} = {}) {
  checkAbort(signal);
  if (format !== 'otio') fail('Timeline format must be otio.');
  const snapshot = deliverySnapshot(project);
  const timeline = compileTimeline(snapshot);
  const {fps, width, height, durationInFrames} = timeline;
  const assets = new Map(timeline.assets.map((asset) => [asset.id, asset]));
  const usedAssets = new Set();
  const main = mainVideoTrack(timeline, assets, usedAssets);
  const overlays = [];
  const audio = collectAudio(timeline, assets);
  for (const overlay of timeline.overlays) {
    const asset = assets.get(overlay.assetId);
    if (!asset) continue;
    const segment = {asset, from: overlay.from, duration: overlay.durationInFrames, rate: 1,
      sourceFrame: Math.round((overlay.sourceStart ?? 0) * fps), overlayId: overlay.id,
      volume: overlay.audio?.muted ? 0 : (overlay.volume ?? 1), audio: overlay.audio,
      style: overlay.style, anchor: overlay.anchor, color: overlay.color};
    if (asset.type !== 'audio') overlays.push(placedTrack([segment], `Overlay ${overlay.id}`, 'Video', fps, usedAssets));
    if (carriesAudio(asset)) audio.push(segment);
  }
  const tracks = [main.track, ...overlays, ...audioLanes(audio, fps, usedAssets)];
  if (!usedAssets.size) fail('Add an editable media clip or overlay before exporting a timeline.', 'NO_EDITABLE_MEDIA');
  const limitations = [
    'This editable timeline references original files by local URL. Keep them available or relink the media in the receiving editor.',
    'Receiving editors differ in their handling of retimes, crossfades, custom transitions, still images and media timecode.',
    'Dip and wipe transfer their timing and type as custom transitions. Receiving editors may substitute a cut.',
    'Engine layout, color, keyframes, caption styling, text graphics, audio fades/finishing and custom motion are not rendered into this interchange. Use subtitle sidecars and the MP4 for those results.',
    'Separate audio tracks carry source audio and J/L timing. Legacy videos with unknown audio metadata retain an audio track, matching the engine renderer. Importers may leave that track empty for picture-only files.',
    'Importers vary in how they restore linked clip selections and engine mix settings.',
  ];
  const document = {OTIO_SCHEMA: 'Timeline.1', name: snapshot.name,
    global_start_time: time(0, fps), metadata: metadata({projectId: snapshot.id, revision: snapshot.revision,
      width, height, fps, durationInFrames, limitations}),
    tracks: {...item('Stack.1', 'tracks'), children: tracks}};
  const referenced = timeline.assets.filter((asset) => usedAssets.has(asset.id));
  const output = await publishFile(outputPath, '.otio', `${JSON.stringify(document, null, 2)}\n`, {signal,
    verify: () => assertAssets({assets: referenced})});
  return {kind: 'timeline', format, revision: snapshot.revision, outputPath: output,
    width, height, fps, durationInFrames, assetCount: referenced.length, trackCount: tracks.length,
    transitionCount: main.transitionCount, limitations};
}
