import {compileTimeline} from './timeline.mjs';
import {valueAt} from './edit-controls.mjs';
import {run, videoGeometry} from './media.mjs';

/** Read actual raster geometry, including old imports that lack rotation/SAR. */
export async function inspectFraming(project, options = {}) {
  const timeline = options.timeline ?? compileTimeline(project);
  const used = new Set([...timeline.clips, ...timeline.overlays].map(item => item.assetId));
  const assets = [];
  for (const asset of timeline.assets) {
    if (!used.has(asset.id) || !['video', 'image'].includes(asset.type)) {assets.push(asset); continue;}
    options.signal?.throwIfAborted();
    const {stdout} = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', asset.path], {signal: options.signal});
    const stream = JSON.parse(stdout).streams?.[0];
    assets.push({...asset, ...(stream ? videoGeometry(stream) : {width: null, height: null})});
  }
  return analyzeFraming(project, {...options, timeline: {...timeline, assets}});
}

const rounded = value => Math.round(value * 1000) / 1000;
const pixels = (value, dimension) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+(\.\d+)?(px|%)$/.test(value)) {
    return parseFloat(value) * (value.endsWith('%') ? dimension / 100 : 1);
  }
  return null;
};

// All supported easings are monotone between keyframes. Include both sides of
// each boundary so holds, trim offsets and subframe keyframes match rendering.
function candidateFrames(item, first, last, fps) {
  const frames = new Set([first, last]);
  for (const points of Object.values(item.motion ?? {})) for (const point of points) {
    const frame = (point.time - (item.motionTimeOffset ?? 0)) * fps;
    for (const near of [Math.floor(frame) - 1, Math.floor(frame), Math.ceil(frame), Math.ceil(frame) + 1]) {
      if (near >= first && near <= last) frames.add(near);
    }
  }
  return [...frames].sort((a, b) => a - b);
}

/** Estimate raster enlargement using the same element boxes and fit as Clip/Overlay. */
export function analyzeFraming(project, {timeline = compileTimeline(project), scale = 1,
  frameRange = [0, timeline.durationInFrames - 1], maxUpscale = 1.25, offset = 0, limit = 100} = {}) {
  if (!Number.isFinite(maxUpscale) || maxUpscale < 1 || maxUpscale > 10) throw new Error('maxUpscale must be between 1 and 10');
  const assets = new Map(timeline.assets.map(asset => [asset.id, asset]));
  const findings = [];
  let assessedCount = 0, unassessedCount = 0;
  const standalone = project.custom && project.custom.mode !== 'layer';
  if (project.custom) {
    unassessedCount++;
    findings.push({code: 'CUSTOM_FRAMING_UNASSESSED', kind: 'custom',
      message: 'Custom code can place media independently. Review its framing directly.'});
  }
  if (!standalone) for (const [kind, items] of [['clip', timeline.clips], ['overlay', timeline.overlays]]) {
    for (const item of items) {
      const asset = assets.get(item.assetId);
      if (!asset || !['video', 'image'].includes(asset.type)) continue;
      const first = Math.max(0, frameRange[0] - item.from);
      const last = Math.min(item.durationInFrames - 1, frameRange[1] - item.from);
      if (last < first) continue;
      const startFrame = item.from + first, endFrame = item.from + last + 1;
      const context = {kind, itemId: item.id, assetId: asset.id, startFrame, endFrame,
        startSeconds: rounded(startFrame / timeline.fps), endSeconds: rounded(endFrame / timeline.fps)};
      const style = item.style ?? {};
      if (kind === 'overlay' && style.opacity === 0) continue;
      const box = kind === 'clip' ? {width: item.position?.width ?? timeline.width, height: item.position?.height ?? timeline.height}
        : {width: pixels(style.width ?? '100%', timeline.width), height: pixels(style.height ?? '100%', timeline.height)};
      const fit = kind === 'clip' ? item.fit ?? 'contain' : style.objectFit ?? 'contain';
      const unsupported = !box.width || !box.height || !asset.width || !asset.height ||
        !['cover', 'contain'].includes(fit) || (kind === 'overlay' &&
          (style.transform || style.padding || style.border || (typeof style.opacity === 'string')));
      if (unsupported) {
        unassessedCount++;
        findings.push({...context, code: 'FRAMING_UNASSESSED', message: 'Source dimensions or CSS layout cannot be measured by this check. Review at delivery size.'});
        continue;
      }
      const crop = item.crop ?? {};
      const widthFraction = 1 - (crop.left ?? 0) - (crop.right ?? 0);
      const heightFraction = 1 - (crop.top ?? 0) - (crop.bottom ?? 0);
      const rotation = Math.abs(asset.rotation ?? 0) % 180;
      if (rotation !== 0 && rotation !== 90) {
        unassessedCount++;
        findings.push({...context, code: 'FRAMING_UNASSESSED', message: 'Non-right-angle source rotation requires direct framing review.'});
        continue;
      }
      const sar = asset.sampleAspectRatio ?? 1;
      const nativeWidth = rotation === 90 ? asset.height : asset.width;
      const nativeHeight = rotation === 90 ? asset.width : asset.height;
      const displayWidth = rotation === 90 ? asset.height : asset.width * sar;
      const displayHeight = rotation === 90 ? asset.width * sar : asset.height;
      const fitScale = (fit === 'cover' ? Math.max : Math.min)(
        box.width / widthFraction / displayWidth, box.height / heightFraction / displayHeight);
      let worst = null;
      for (const frame of candidateFrames(item, first, last, timeline.fps)) {
        const time = frame / timeline.fps + (item.motionTimeOffset ?? 0);
        if (valueAt(item.motion?.opacity, time, 1) <= 0) continue;
        const zoom = valueAt(item.motion?.scale, time, 1);
        const enlargement = fitScale * zoom * scale * Math.max(sar, 1);
        if (!worst || enlargement > worst.upscale) worst = {upscale: enlargement, zoom, frame: item.from + frame};
      }
      if (!worst) continue;
      assessedCount++;
      if (worst.upscale <= maxUpscale + 1e-9) continue;
      findings.push({...context, code: 'EXCESSIVE_UPSCALE',
        message: 'This shot enlarges source pixels beyond the selected limit. Check sharpness before delivery.',
        nativeWidth, nativeHeight, boxWidth: rounded(box.width), boxHeight: rounded(box.height), fit,
        crop: {...crop}, maxUpscale: rounded(worst.upscale), motionScale: rounded(worst.zoom),
        worstFrame: worst.frame, worstSeconds: rounded(worst.frame / timeline.fps),
        sourceSeconds: asset.type === 'image' ? null : rounded((kind === 'clip' ? item.sourceFrame / timeline.fps : item.sourceStart ?? 0) +
          (worst.frame - item.from) / timeline.fps * (kind === 'clip' ? item.playbackRate ?? 1 : 1)),
        preview: {kind: 'still', frame: worst.frame, scale: 1},
        suggestions: ['Reduce the zoom or crop.', 'Use contain or a smaller picture area.', 'Use a higher-resolution source.']});
    }
  }
  return {version: 1, scope: 'engine_raster_geometry', revision: project.revision, threshold: maxUpscale,
    assessedCount, unassessedCount, totalFindings: findings.length, offset,
    findings: findings.slice(offset, offset + limit), truncated: offset + limit < findings.length,
    limitations: ['This measures pixel enlargement, not focus, compression damage or perceived sharpness.',
      'Visibility behind other layers and off-screen placement are not inferred. Findings can be intentionally hidden.',
      'Custom media and unsupported CSS require direct review. Source rotation and pixel aspect use imported metadata.']};
}
