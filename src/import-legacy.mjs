import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {createProject} from './project.mjs';
import {probeAsset} from './media.mjs';
import {normalizeTranscript} from './transcribe.mjs';

function invalid(message) {
  throw Object.assign(new Error(message), {code: 'INVALID_LEGACY_PROJECT'});
}

/** Keep source material outside explicit deletion ranges. */
function keptRanges(duration, deletedRanges) {
  if (!Array.isArray(deletedRanges)) invalid('Legacy deletedRanges must be an array.');
  const cuts = deletedRanges.map((range) => {
    if (!range || typeof range !== 'object' || !Number.isFinite(range.start) || !Number.isFinite(range.end)) {
      invalid('Each legacy deletion must contain finite source start and end times.');
    }
    return {start: Math.max(0, range.start), end: Math.min(duration, range.end)};
  }).filter((range) => range.end > range.start).sort((a, b) => a.start - b.start);
  const kept = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.start > cursor) kept.push({start: cursor, end: cut.start});
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < duration) kept.push({start: cursor, end: duration});
  return kept;
}

/** Import a local .aive without changing the source project or source media. */
export async function importLegacyProject(projectDir, {path: importPath, name, settings} = {}) {
  if (typeof importPath !== 'string' || !importPath.trim()) invalid('Supply the local path to a legacy .aive project.');
  const file = path.resolve(importPath);
  if (path.extname(file).toLowerCase() !== '.aive') invalid('Legacy project import accepts .aive projects only.');
  if (!(await stat(file)).isFile()) invalid('The legacy project must be a regular local file.');
  let document;
  try { document = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) invalid('The legacy project contains invalid JSON.');
    throw error;
  }
  if (!document || typeof document !== 'object' || Array.isArray(document) || document.version !== 1) {
    invalid('Only version-1 legacy .aive projects are supported.');
  }
  if (typeof document.videoPath !== 'string' || !document.videoPath.trim()) invalid('Legacy project is missing its source videoPath.');
  if (!Array.isArray(document.words)) invalid('Legacy project is missing its timestamped words array.');
  const source = path.resolve(path.dirname(file), document.videoPath);
  const asset = await probeAsset(source, 'legacy-source');
  if (asset.type === 'image' || !(asset.duration > 0)) invalid('Legacy source must be a timed video or audio file.');
  const transcript = normalizeTranscript(document, asset.id);
  const ranges = keptRanges(asset.duration, document.deletedRanges);
  return createProject(projectDir, {
    name: name ?? path.basename(file, path.extname(file)),
    settings,
    assets: [asset],
    transcripts: [transcript],
    clips: ranges.map((range, index) => ({id: `legacy-clip-${index}`, assetId: asset.id,
      sourceStart: range.start, sourceEnd: range.end})),
  });
}
