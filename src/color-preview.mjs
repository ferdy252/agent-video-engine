import {mkdir, realpath, rm} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join} from 'node:path';
import {renderProject} from './render.mjs';
import {validateProject} from './project.mjs';
import {fileFingerprint} from './media.mjs';

const invalid = (message, code = 'INVALID_COLOR_PREVIEW') => Object.assign(new Error(message), {code});
const checkAbort = (signal) => {
  if (signal?.aborted) throw Object.assign(new Error('Color comparison cancelled'), {name: 'AbortError', code: 'CANCELLED'});
};
const report = (observer, update) => {try {observer?.(update)?.catch?.(() => {});} catch {}};

/** Compare one frozen output frame, changing only engine source correction. */
export async function renderColorComparison(project, {outputDir, frame = 0, scale = .5, signal, onProgress} = {}) {
  checkAbort(signal);
  if (typeof outputDir !== 'string' || !isAbsolute(outputDir)) throw invalid('outputDir must be an absolute new directory.');
  if (!Number.isInteger(frame) || frame < 0) throw invalid('frame must be a nonnegative integer.');
  if (!Number.isFinite(scale) || scale <= 0 || scale > 2) throw invalid('scale must be greater than zero and at most 2.');
  const after = structuredClone(project);
  validateProject(after);
  if (after.custom && after.custom.mode !== 'layer') throw invalid(
    'Color comparison needs the engine source timeline. Use custom.mode:"layer" for motion above its corrected footage.',
    'UNSUPPORTED_CUSTOM_COLOR');
  // Older manifests may have no saved fingerprint. Pin their media for both
  // images so a replacement between renders cannot look like a correction.
  for (const asset of after.assets) {
    checkAbort(signal);
    if (!asset.fingerprint) asset.fingerprint = await fileFingerprint(asset.path);
  }
  const before = structuredClone(after);
  for (const asset of before.assets) delete asset.color;
  for (const clip of before.clips) delete clip.color;
  for (const overlay of before.overlays) delete overlay.color;
  await mkdir(dirname(outputDir), {recursive: true});
  const directory = join(await realpath(dirname(outputDir)), basename(outputDir));
  let owned = false;
  try {
    checkAbort(signal);
    try {await mkdir(directory); owned = true;}
    catch (error) {
      if (error.code === 'EEXIST') throw invalid('Color comparison output directory already exists. Choose a new outputDir.', 'OUTPUT_EXISTS');
      throw error;
    }
    const render = (snapshot, name, phase) => renderProject(snapshot, {kind: 'still', frame, scale, signal,
      outputPath: join(directory, `${name}.png`), onProgress: (update) => report(onProgress,
        {...update, renderStage: update.stage, stage: `color_${name}`, comparison: name,
          ...(Number.isFinite(update.progress) ? {progress: phase + Math.max(0, Math.min(1, update.progress)) / 2} : {})})});
    const beforeResult = await render(before, 'before', 0);
    checkAbort(signal);
    const afterResult = await render(after, 'after', .5);
    checkAbort(signal);
    report(onProgress, {stage: 'complete', progress: 1});
    return {kind: 'color_comparison', revision: after.revision, frame,
      before: beforeResult, after: afterResult};
  } catch (error) {
    if (owned) await rm(directory, {recursive: true, force: true});
    if (signal?.aborted) checkAbort(signal);
    throw error;
  }
}
