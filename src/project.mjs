import {randomUUID} from 'node:crypto';
import {statSync} from 'node:fs';
import {mkdir, open, readFile, rename, unlink, readdir} from 'node:fs/promises';
import path from 'node:path';
import {resolveAudioSettings, resolveClipAudio, validateAudioSettings, validateClipAudio} from './audio-settings.mjs';

export {compileTimeline, retimeWords} from './timeline.mjs';

const PROJECT_FILE = 'project.json';
const DEFAULT_CAPTIONS = {enabled: true, fontSize: 64, color: '#ffffff', highlightColor: '#ffde59', bottom: 140, wordsPerPage: 4};
const DEFAULT_SETTINGS = {width: 1080, height: 1920, fps: 30, background: '#000000'};
const clone = (value) => structuredClone(value);

function fail(message, code = 'VALIDATION_ERROR') {
  throw Object.assign(new Error(message), {code});
}
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object.`);
}
function string(value, name) {
  if (typeof value !== 'string' || !value.trim()) fail(`${name} must be a non-empty string.`);
}
function number(value, name, {min = -Infinity, max = Infinity, integer = false} = {}) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    fail(`${name} must be ${integer ? 'an integer' : 'a finite number'} between ${min} and ${max}.`);
  }
}
function array(value, name) {
  if (!Array.isArray(value)) fail(`${name} must be an array.`);
}
function uniqueIds(items, name) {
  const ids = new Set();
  for (const item of items) {
    object(item, name);
    string(item.id, `${name}.id`);
    if (ids.has(item.id)) fail(`Duplicate ${name} id: ${item.id}.`);
    ids.add(item.id);
  }
}
function existingFile(filePath, name) {
  string(filePath, name);
  if (!path.isAbsolute(filePath)) fail(`${name} must be an absolute local path.`);
  try {
    if (!statSync(filePath).isFile()) fail(`${name} must identify a regular file.`);
  } catch (error) {
    if (error.code === 'VALIDATION_ERROR') throw error;
    fail(`${name} is not an accessible file: ${filePath}.`, 'ASSET_NOT_FOUND');
  }
}
function jsonData(value, name) {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') return number(value, name);
  if (typeof value !== 'object') fail(`${name} must contain JSON values only.`);
  for (const [key, child] of Object.entries(value)) jsonData(child, `${name}.${key}`);
}
function sourceBounds(asset, start, end, name, {allowPoint = false} = {}) {
  number(start, `${name}.sourceStart`, {min: 0});
  number(end, `${name}.sourceEnd`, {min: 0});
  if (end < start || (!allowPoint && end === start)) fail(`${name} must have sourceEnd ${allowPoint ? 'at least equal to' : 'greater than'} sourceStart.`);
  if (asset.type !== 'image' && end > asset.duration + 1e-7) fail(`${name} exceeds source duration.`);
}

/** Validate both the manifest and referenced local files. No original is ever written. */
export function validateProject(project) {
  object(project, 'project');
  if (project.schemaVersion !== 1) fail('Unsupported project schemaVersion.');
  string(project.id, 'project.id');
  string(project.name, 'project.name');
  number(project.revision, 'project.revision', {min: 0, integer: true});
  for (const key of ['createdAt', 'updatedAt']) {
    string(project[key], key);
    if (!Number.isFinite(Date.parse(project[key]))) fail(`${key} must be an ISO timestamp.`);
  }
  object(project.settings, 'settings');
  number(project.settings.width, 'settings.width', {min: 2, max: 16384, integer: true});
  number(project.settings.height, 'settings.height', {min: 2, max: 16384, integer: true});
  number(project.settings.fps, 'settings.fps', {min: 1, max: 120, integer: true});
  string(project.settings.background, 'settings.background');
  if (project.audio !== undefined) validateAudioSettings(project.audio);
  for (const key of ['assets', 'transcripts', 'clips', 'overlays']) array(project[key], key);
  uniqueIds(project.assets, 'asset');
  uniqueIds(project.clips, 'clip');
  uniqueIds(project.overlays, 'overlay');
  const assets = new Map();
  for (const asset of project.assets) {
    if (!['video', 'audio', 'image'].includes(asset.type)) fail(`Invalid asset type: ${asset.type}.`);
    existingFile(asset.path, `asset ${asset.id}.path`);
    number(asset.duration, `asset ${asset.id}.duration`, {min: 0});
    if (asset.type !== 'image' && asset.duration <= 0) fail(`Asset ${asset.id} must have positive duration.`);
    for (const key of ['width', 'height']) if (asset[key] !== undefined) number(asset[key], `asset.${key}`, {min: 1, integer: true});
    if (asset.fps !== undefined) number(asset.fps, 'asset.fps', {min: Number.EPSILON});
    if (asset.hasAudio !== undefined && typeof asset.hasAudio !== 'boolean') fail('asset.hasAudio must be boolean.');
    assets.set(asset.id, asset);
  }
  const transcriptAssets = new Set();
  for (const transcript of project.transcripts) {
    object(transcript, 'transcript');
    const asset = assets.get(transcript.assetId);
    if (!asset) fail(`Transcript references unknown asset: ${transcript.assetId}.`);
    if (transcriptAssets.has(transcript.assetId)) fail(`Duplicate transcript for asset: ${transcript.assetId}.`);
    transcriptAssets.add(transcript.assetId);
    string(transcript.language, 'transcript.language');
    array(transcript.words, 'transcript.words');
    uniqueIds(transcript.words, 'word');
    let previous = -Infinity;
    for (const word of transcript.words) {
      string(word.text, 'word.text');
      sourceBounds(asset, word.start, word.end, `word ${word.id}`, {allowPoint: true});
      if (word.start < previous) fail('Transcript words must be ordered by source start.');
      previous = word.start;
      if (word.confidence !== undefined) number(word.confidence, 'word.confidence', {min: 0, max: 1});
    }
  }
  for (const clip of project.clips) {
    const asset = assets.get(clip.assetId);
    if (!asset) fail(`Clip references unknown asset: ${clip.assetId}.`);
    sourceBounds(asset, clip.sourceStart, clip.sourceEnd, `clip ${clip.id}`);
    number(clip.playbackRate, 'clip.playbackRate', {min: 0.01, max: 16});
    number(clip.volume, 'clip.volume', {min: 0, max: 8});
    if (clip.audio !== undefined) validateClipAudio(clip.audio);
    if (!['cover', 'contain'].includes(clip.fit)) fail('clip.fit must be cover or contain.');
    if (clip.position !== undefined) {
      object(clip.position, 'clip.position');
      for (const key of ['x', 'y']) number(clip.position[key], `clip.position.${key}`);
      for (const key of ['width', 'height']) number(clip.position[key], `clip.position.${key}`, {min: Number.EPSILON});
    }
  }
  for (const overlay of project.overlays) {
    if (!['text', 'image', 'video', 'audio'].includes(overlay.type)) fail('Invalid overlay type.');
    number(overlay.start, 'overlay.start', {min: 0});
    number(overlay.end, 'overlay.end', {min: 0});
    if (overlay.end <= overlay.start) fail('overlay.end must be greater than start.');
    if (overlay.anchor !== undefined) {
      object(overlay.anchor, 'overlay.anchor');
      string(overlay.anchor.assetId, 'overlay.anchor.assetId');
      string(overlay.anchor.wordId, 'overlay.anchor.wordId');
      if (!assets.has(overlay.anchor.assetId)) fail(`Overlay anchor references unknown asset: ${overlay.anchor.assetId}.`);
      const transcript = project.transcripts.find((entry) => entry.assetId === overlay.anchor.assetId);
      if (!transcript?.words.some((word) => word.id === overlay.anchor.wordId)) fail(`Overlay anchor references unknown source word: ${overlay.anchor.wordId}.`);
      if (overlay.anchor.offset !== undefined) number(overlay.anchor.offset, 'overlay.anchor.offset');
      // Keep a clip-specific anchor when that clip is removed, so restoring the
      // edit restores the attachment. Compilation suppresses absent occurrences.
      if (overlay.anchor.clipId !== undefined) {
        string(overlay.anchor.clipId, 'overlay.anchor.clipId');
        const anchoredClip = project.clips.find((entry) => entry.id === overlay.anchor.clipId);
        if (anchoredClip && anchoredClip.assetId !== overlay.anchor.assetId) fail('Overlay anchor clip must use the anchored source asset.');
      }
    }
    if (overlay.type === 'text') string(overlay.text, 'overlay.text');
    else {
      const asset = assets.get(overlay.assetId);
      if (!asset) fail(`Overlay references unknown asset: ${overlay.assetId}.`);
      if (asset.type !== overlay.type) fail('Overlay type must match its asset type.');
      const sourceStart = overlay.sourceStart ?? 0;
      sourceBounds(asset, sourceStart, sourceStart + overlay.end - overlay.start, `overlay ${overlay.id}`);
    }
    if (overlay.volume !== undefined) number(overlay.volume, 'overlay.volume', {min: 0, max: 8});
    if (overlay.style !== undefined) {
      object(overlay.style, 'overlay.style');
      jsonData(overlay.style, 'overlay.style');
    }
  }
  object(project.captions, 'captions');
  if (typeof project.captions.enabled !== 'boolean') fail('captions.enabled must be boolean.');
  number(project.captions.fontSize, 'captions.fontSize', {min: 1, max: 1000});
  number(project.captions.bottom, 'captions.bottom', {min: 0});
  number(project.captions.wordsPerPage, 'captions.wordsPerPage', {min: 1, max: 50, integer: true});
  for (const key of ['color', 'highlightColor']) string(project.captions[key], `captions.${key}`);
  if (project.custom !== undefined && project.custom !== null) {
    object(project.custom, 'custom');
    existingFile(project.custom.entryPoint, 'custom.entryPoint');
    const mode = project.custom.mode ?? 'composition';
    if (!['composition', 'layer'].includes(mode)) fail('custom.mode must be composition or layer.');
    if (mode === 'layer') {
      if (project.custom.compositionId !== undefined) fail('Layer mode uses the engine composition and cannot specify compositionId.');
      if (project.custom.exportName !== undefined) string(project.custom.exportName, 'custom.exportName');
    } else {
      string(project.custom.compositionId, 'custom.compositionId');
      if (project.custom.exportName !== undefined) fail('custom.exportName is supported only in layer mode.');
    }
    if (project.custom.publicDir !== undefined) {
      string(project.custom.publicDir, 'custom.publicDir');
      if (!path.isAbsolute(project.custom.publicDir)) fail('custom.publicDir must be an absolute local directory.');
      try { if (!statSync(project.custom.publicDir).isDirectory()) fail('custom.publicDir must identify a directory.'); }
      catch (error) { if (error.code === 'VALIDATION_ERROR') throw error; fail('custom.publicDir is not an accessible directory.'); }
    }
    if (project.custom.props !== undefined) {
      object(project.custom.props, 'custom.props');
      jsonData(project.custom.props, 'custom.props');
    }
  }
  jsonData(project, 'project');
  return true;
}

function projectPath(projectDir) { return path.join(path.resolve(projectDir), PROJECT_FILE); }
function revisionPath(projectDir, revision) { return path.join(path.resolve(projectDir), '.history', `revision-${String(revision).padStart(8, '0')}.json`); }
async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') fail(`File does not exist: ${file}`, 'PROJECT_NOT_FOUND');
    if (error instanceof SyntaxError) fail(`Invalid JSON: ${file}`, 'INVALID_PROJECT');
    throw error;
  }
}
async function atomicWrite(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}
async function withLock(projectDir, action) {
  const directory = path.resolve(projectDir);
  await mkdir(directory, {recursive: true});
  const file = path.join(directory, '.project.lock');
  const token = randomUUID();
  let handle;
  for (let attempt = 0; attempt < 3 && !handle; attempt++) {
    try { handle = await open(file, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try { previous = await readFile(file, 'utf8'); }
      catch (readError) { if (readError.code === 'ENOENT') continue; throw readError; }
      let owner;
      try { owner = JSON.parse(previous); } catch { fail('Another process is acquiring the project lock.', 'PROJECT_LOCKED'); }
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) fail('Project lock has no valid process owner.', 'PROJECT_LOCKED');
      let dead = false;
      try { process.kill(owner.pid, 0); } catch (killError) { dead = killError.code === 'ESRCH'; }
      if (!dead) fail(`Project is locked by process ${owner.pid}.`, 'PROJECT_LOCKED');
      // Only reap the same dead owner's lock; never unlink a replacement lock.
      if (await readFile(file, 'utf8').catch(() => null) === previous) await unlink(file).catch((unlinkError) => { if (unlinkError.code !== 'ENOENT') throw unlinkError; });
    }
  }
  if (!handle) fail('Could not acquire project lock.', 'PROJECT_LOCKED');
  try {
    await handle.writeFile(JSON.stringify({pid: process.pid, token, createdAt: new Date().toISOString()}));
    await handle.sync();
    return await action();
  } finally {
    await handle.close();
    const owner = await readJson(file).catch(() => null);
    if (owner?.token === token) await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}
async function persist(projectDir, project) {
  await mkdir(path.join(path.resolve(projectDir), '.history'), {recursive: true});
  await atomicWrite(revisionPath(projectDir, project.revision), project);
  await atomicWrite(projectPath(projectDir), project);
  return project;
}

export async function createProject(projectDir, options = {}) {
  return withLock(projectDir, async () => {
    try { await readFile(projectPath(projectDir)); fail('Project already exists.', 'PROJECT_EXISTS'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const now = new Date().toISOString();
    const project = {
      schemaVersion: 1, id: options.id ?? randomUUID(), name: options.name ?? path.basename(path.resolve(projectDir)),
      revision: 0, createdAt: now, updatedAt: now,
      settings: {...DEFAULT_SETTINGS, ...options.settings},
      assets: clone(options.assets ?? []), transcripts: clone(options.transcripts ?? []),
      clips: normalizeClips(clone(options.clips ?? [])), overlays: clone(options.overlays ?? []),
      captions: {...DEFAULT_CAPTIONS, ...options.captions},
      audio: resolveAudioSettings(options.audio),
      ...(options.custom != null ? {custom: clone(options.custom)} : {}),
    };
    validateProject(project);
    return persist(projectDir, project);
  });
}
export async function loadProject(projectDir) {
  const project = await readJson(projectPath(projectDir));
  validateProject(project);
  return project;
}
function normalizeClips(clips) {
  array(clips, 'clips');
  return clips.map((clip) => ({playbackRate: 1, volume: 1, fit: 'cover', ...clip}));
}
function findClip(project, id) {
  const index = project.clips.findIndex((clip) => clip.id === id);
  if (index < 0) fail(`Unknown clip: ${id}.`, 'CLIP_NOT_FOUND');
  return index;
}
function cutSource(project, assetId, start, end) {
  const asset = project.assets.find((entry) => entry.id === assetId);
  if (!asset) fail(`Unknown asset: ${assetId}.`, 'ASSET_NOT_FOUND');
  sourceBounds(asset, start, end, 'delete range');
  project.clips = project.clips.flatMap((clip) => {
    if (clip.assetId !== assetId || end <= clip.sourceStart || start >= clip.sourceEnd) return [clip];
    const retained = [];
    if (start > clip.sourceStart) retained.push({...clip, sourceEnd: start});
    if (end < clip.sourceEnd) retained.push({...clip, id: retained.length ? `${clip.id}-${randomUUID()}` : clip.id, sourceStart: end});
    return retained;
  });
}
function applyOperation(project, operation) {
  object(operation, 'operation');
  const type = operation.type ?? operation.op;
  switch (type) {
    case 'add_asset': project.assets.push(clone(operation.asset)); break;
    case 'set_transcript': {
      const transcript = clone(operation.transcript);
      object(transcript, 'transcript');
      project.transcripts = project.transcripts.filter((entry) => entry.assetId !== transcript.assetId);
      project.transcripts.push(transcript);
      break;
    }
    case 'set_clips': project.clips = normalizeClips(clone(operation.clips)); break;
    case 'split_clip': {
      const index = findClip(project, operation.clipId);
      const clip = project.clips[index];
      number(operation.sourceTime, 'sourceTime');
      if (operation.sourceTime <= clip.sourceStart || operation.sourceTime >= clip.sourceEnd) fail('Split must be inside the clip.');
      project.clips.splice(index, 1, {...clip, sourceEnd: operation.sourceTime},
        {...clip, id: operation.newClipId ?? `${clip.id}-${randomUUID()}`, sourceStart: operation.sourceTime});
      break;
    }
    case 'remove_clip': project.clips.splice(findClip(project, operation.clipId), 1); break;
    case 'trim_clip': {
      const clip = project.clips[findClip(project, operation.clipId)];
      clip.sourceStart = operation.sourceStart;
      clip.sourceEnd = operation.sourceEnd;
      break;
    }
    case 'reorder_clips': {
      array(operation.clipIds, 'clipIds');
      if (operation.clipIds.length !== project.clips.length || new Set(operation.clipIds).size !== project.clips.length) fail('clipIds must contain every clip exactly once.');
      const byId = new Map(project.clips.map((clip) => [clip.id, clip]));
      if (operation.clipIds.some((id) => !byId.has(id))) fail('clipIds contains an unknown clip.');
      project.clips = operation.clipIds.map((id) => byId.get(id));
      break;
    }
    case 'delete_source_range': cutSource(project, operation.assetId, operation.start, operation.end); break;
    case 'delete_words': {
      array(operation.wordIds, 'wordIds');
      const transcript = project.transcripts.find((entry) => entry.assetId === operation.assetId);
      if (!transcript) fail(`No transcript for asset: ${operation.assetId}.`, 'TRANSCRIPT_NOT_FOUND');
      const byId = new Map(transcript.words.map((word) => [word.id, word]));
      for (const id of new Set(operation.wordIds)) {
        const word = byId.get(id);
        if (!word) fail(`Unknown word: ${id}.`, 'WORD_NOT_FOUND');
        if (word.start === word.end) fail(`Word ${id} has a point timestamp and no measured speech interval. Inspect the source audio and set a verified source range before deleting it.`, 'WORD_TIMING_UNCERTAIN');
        cutSource(project, operation.assetId, word.start, word.end);
      }
      break;
    }
    case 'upsert_overlay': {
      const overlay = clone(operation.overlay);
      object(overlay, 'overlay');
      const index = project.overlays.findIndex((entry) => entry.id === overlay.id);
      if (index < 0) project.overlays.push(overlay); else project.overlays[index] = overlay;
      break;
    }
    case 'remove_overlay': {
      const index = project.overlays.findIndex((overlay) => overlay.id === operation.overlayId);
      if (index < 0) fail(`Unknown overlay: ${operation.overlayId}.`, 'OVERLAY_NOT_FOUND');
      project.overlays.splice(index, 1);
      break;
    }
    case 'set_captions': object(operation.patch, 'patch'); project.captions = {...project.captions, ...clone(operation.patch)}; break;
    case 'set_settings': object(operation.patch, 'patch'); project.settings = {...project.settings, ...clone(operation.patch)}; break;
    case 'set_audio': {
      validateAudioSettings(operation.patch);
      project.audio = {...resolveAudioSettings(project.audio), ...clone(operation.patch)};
      break;
    }
    case 'set_clip_audio': {
      validateClipAudio(operation.patch);
      const clip = project.clips[findClip(project, operation.clipId)];
      clip.audio = {...resolveClipAudio(clip.audio), ...clone(operation.patch)};
      break;
    }
    case 'set_custom': if (operation.custom === null) delete project.custom; else project.custom = clone(operation.custom); break;
    default: fail(`Unknown edit operation: ${type}.`, 'UNKNOWN_OPERATION');
  }
}
function checkRevision(project, expectedRevision) {
  number(expectedRevision, 'expectedRevision', {min: 0, integer: true});
  if (project.revision !== expectedRevision) fail(`Expected revision ${expectedRevision}, current revision is ${project.revision}. Reload before editing.`, 'REVISION_CONFLICT');
}
export async function applyOperations(projectDir, {expectedRevision, operations}) {
  array(operations, 'operations');
  if (!operations.length) fail('At least one operation is required.');
  return withLock(projectDir, async () => {
    const project = await loadProject(projectDir);
    checkRevision(project, expectedRevision);
    for (const operation of operations) applyOperation(project, operation);
    project.revision++;
    project.updatedAt = new Date().toISOString();
    validateProject(project);
    return persist(projectDir, project);
  });
}
export async function restoreRevision(projectDir, {expectedRevision, revision}) {
  number(revision, 'revision', {min: 0, integer: true});
  return withLock(projectDir, async () => {
    const current = await loadProject(projectDir);
    checkRevision(current, expectedRevision);
    if (revision > current.revision) fail('Cannot restore a future revision.', 'REVISION_NOT_FOUND');
    let project;
    try { project = await readJson(revisionPath(projectDir, revision)); }
    catch (error) { if (error.code === 'PROJECT_NOT_FOUND') fail(`Revision ${revision} does not exist.`, 'REVISION_NOT_FOUND'); throw error; }
    if (project.id !== current.id || project.revision !== revision) fail('Revision belongs to a different project.', 'INVALID_PROJECT');
    project.revision = current.revision + 1;
    project.updatedAt = new Date().toISOString();
    validateProject(project);
    return persist(projectDir, project);
  });
}
export async function listRevisions(projectDir) {
  const project = await loadProject(projectDir);
  const files = await readdir(path.join(path.resolve(projectDir), '.history'));
  const result = [];
  for (const file of files.filter((name) => /^revision-\d+\.json$/.test(name)).sort()) {
    const snapshot = await readJson(path.join(path.resolve(projectDir), '.history', file));
    if (snapshot.id === project.id && snapshot.revision <= project.revision) {
      result.push({revision: snapshot.revision, name: snapshot.name, createdAt: snapshot.createdAt, updatedAt: snapshot.updatedAt});
    }
  }
  return result.sort((a, b) => a.revision - b.revision);
}
