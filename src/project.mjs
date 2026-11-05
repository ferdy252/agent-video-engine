import {randomUUID} from 'node:crypto';
import {statSync} from 'node:fs';
import {mkdir, open, readFile, rename, unlink, readdir} from 'node:fs/promises';
import path from 'node:path';
import {resolveAudioSettings, resolveClipAudio, validateAudioSettings, validateClipAudio, mergeAudioSettings} from './audio-settings.mjs';
import {applyColorPatch, validateColorSettings} from './color-settings.mjs';
import {fileFingerprint} from './media.mjs';
import {validateVisual, validateSequence, validateCaptionCues, GRAPHIC_PRESETS} from './edit-controls.mjs';

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
export function validateProject(project, {allowMissingAssets = false} = {}) {
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
    if (allowMissingAssets) {
      string(asset.path, `asset ${asset.id}.path`);
      if (!path.isAbsolute(asset.path)) fail('Asset paths must be absolute.');
    } else existingFile(asset.path, `asset ${asset.id}.path`);
    number(asset.duration, `asset ${asset.id}.duration`, {min: 0});
    if (asset.type !== 'image' && asset.duration <= 0) fail(`Asset ${asset.id} must have positive duration.`);
    for (const key of ['width', 'height']) if (asset[key] !== undefined) number(asset[key], `asset.${key}`, {min: 1, integer: true});
    if (asset.fps !== undefined) number(asset.fps, 'asset.fps', {min: Number.EPSILON});
    if (asset.hasAudio !== undefined && typeof asset.hasAudio !== 'boolean') fail('asset.hasAudio must be boolean.');
    if (asset.color !== undefined) {
      if (asset.type === 'audio') fail('Color controls require an image or video asset.');
      validateColorSettings(asset.color);
    }
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
    if (clip.type === 'gap') {
      number(clip.duration, 'gap.duration', {min: 1 / project.settings.fps});
      if (Object.keys(clip).some(key => !['id', 'type', 'duration'].includes(key))) fail('Gaps support only id, type and duration.');
      continue;
    }
    if (clip.type !== undefined && clip.type !== 'media') fail('Unknown clip type.');
    const asset = assets.get(clip.assetId);
    if (!asset) fail(`Clip references unknown asset: ${clip.assetId}.`);
    sourceBounds(asset, clip.sourceStart, clip.sourceEnd, `clip ${clip.id}`);
    number(clip.playbackRate, 'clip.playbackRate', {min: 0.01, max: 16});
    number(clip.volume, 'clip.volume', {min: 0, max: 8});
    if (clip.audio !== undefined) validateClipAudio(clip.audio);
    const sound = clip.audio ?? {}, audioAsset = assets.get(sound.assetId ?? clip.assetId);
    if (!audioAsset) fail('Clip audio references an unknown asset.');
    if (sound.assetId !== undefined && audioAsset.type === 'image') fail('Clip audio needs a video or audio asset.');
    if ((sound.sourceStart === undefined) !== (sound.sourceEnd === undefined)) fail('Set both audio source bounds together.');
    if (sound.assetId !== undefined || sound.sourceStart !== undefined) sourceBounds(audioAsset, sound.sourceStart ?? clip.sourceStart, sound.sourceEnd ?? clip.sourceEnd, `clip ${clip.id} audio`);
    if (sound.assetId !== undefined && audioAsset.hasAudio === false) fail('Replacement audio asset has no audio stream.');
    validateVisual(clip);
    if (clip.color !== undefined) {
      if (asset.type === 'audio') fail('Color controls require an image or video clip.');
      validateColorSettings(clip.color);
    }
    if (!['cover', 'contain'].includes(clip.fit)) fail('clip.fit must be cover or contain.');
    if (clip.position !== undefined) {
      object(clip.position, 'clip.position');
      for (const key of ['x', 'y']) number(clip.position[key], `clip.position.${key}`);
      for (const key of ['width', 'height']) number(clip.position[key], `clip.position.${key}`, {min: Number.EPSILON});
    }
  }
  validateSequence(project.clips, project.settings.fps);
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
        if (anchoredClip && (anchoredClip.audio?.assetId ?? anchoredClip.assetId) !== overlay.anchor.assetId) fail('Overlay anchor clip must use the anchored spoken source asset.');
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
    if (overlay.audio !== undefined) {
      validateClipAudio(overlay.audio);
      if (['assetId', 'sourceStart', 'sourceEnd', 'offset'].some(key => overlay.audio[key] !== undefined)) fail('Overlay audio uses the overlay assetId, sourceStart and output start/end.');
    }
    validateVisual(overlay);
    if (overlay.preset !== undefined && (overlay.type !== 'text' || !Object.hasOwn(GRAPHIC_PRESETS, overlay.preset))) fail('Choose a known text graphic preset.');
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
  validateCaptionCues(project.captions.cues);
  let previousCaptionEnd = 0;
  for (const cue of project.captions.cues ?? []) {
    const start = Math.round(cue.start * project.settings.fps), end = Math.round(cue.end * project.settings.fps);
    if (start < previousCaptionEnd || end <= start) fail('Caption cues must occupy separate output frames and last at least one frame.');
    previousCaptionEnd = end;
  }
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
export async function createProjectFromSnapshot(projectDir, snapshot) {
  return withLock(projectDir, async () => {
    try { await readFile(projectPath(projectDir)); fail('Project already exists.', 'PROJECT_EXISTS'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const project = clone(snapshot);
    validateProject(project);
    return persist(projectDir, project);
  });
}
export async function loadProject(projectDir, options) {
  const project = await readJson(projectPath(projectDir));
  validateProject(project, options);
  return project;
}
export async function mutateProject(projectDir, {expectedRevision, allowMissingAssets = false}, update) {
  return withLock(projectDir, async () => {
    const project = await loadProject(projectDir, {allowMissingAssets});
    checkRevision(project, expectedRevision);
    await update(project);
    project.revision++;
    project.updatedAt = new Date().toISOString();
    validateProject(project);
    return persist(projectDir, project);
  });
}
function normalizeClips(clips) {
  array(clips, 'clips');
  return clips.map((clip) => clip.type === 'gap' ? clip : ({playbackRate: 1, volume: 1, fit: 'cover', ...clip}));
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
    if (start > clip.sourceStart) retained.push(sliceClip(clip, clip.sourceStart, start));
    if (end < clip.sourceEnd) retained.push({...sliceClip(clip, end, clip.sourceEnd), id: retained.length ? `${clip.id}-${randomUUID()}` : clip.id});
    return retained;
  });
}
function sliceClip(clip, start, end) {
  if (clip.type === 'gap') fail('Use set_gap to change a gap.');
  const result = clone(clip), rate = clip.playbackRate ?? 1;
  const offset = (start - clip.sourceStart) / rate, duration = (end - start) / rate;
  result.sourceStart = start; result.sourceEnd = end;
  if (offset !== 0) delete result.transition;
  if (clip.motion) result.motionTimeOffset = (clip.motionTimeOffset ?? 0) + offset;
  if (clip.audio) {
    const original = clip.audio, audio = result.audio;
    const sourceStart = original.sourceStart ?? clip.sourceStart;
    const sourceEnd = original.sourceEnd ?? clip.sourceEnd;
    const audioFrom = original.offset ?? 0;
    const audioDuration = (sourceEnd - sourceStart) / rate;
    const audioEnd = audioFrom + audioDuration;
    const retainedFrom = start === clip.sourceStart ? audioFrom : Math.max(audioFrom, offset);
    const retainedEnd = end === clip.sourceEnd ? audioEnd : Math.min(audioEnd, offset + duration);
    if (retainedEnd <= retainedFrom) audio.muted = true;
    else {
      if (original.sourceStart !== undefined || original.offset) {
        audio.sourceStart = sourceStart + (retainedFrom - audioFrom) * rate;
        audio.sourceEnd = audio.sourceStart + (retainedEnd - retainedFrom) * rate;
        audio.offset = retainedFrom - offset;
      }
      if (original.fadeIn || original.fadeOut || original.envelope?.length || original.curveDuration) {
        audio.curveOffset = (original.curveOffset ?? 0) + retainedFrom - audioFrom;
        audio.curveDuration = original.curveDuration ?? audioDuration;
      }
    }
  }
  return result;
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
    case 'insert_clip': {
      number(operation.index, 'index', {min: 0, max: project.clips.length, integer: true});
      project.clips.splice(operation.index, 0, normalizeClips([clone(operation.clip)])[0]);
      break;
    }
    case 'replace_clip': project.clips.splice(findClip(project, operation.clipId), 1, normalizeClips([clone(operation.clip)])[0]); break;
    case 'insert_gap': {
      number(operation.index, 'index', {min: 0, max: project.clips.length, integer: true});
      project.clips.splice(operation.index, 0, {id: operation.id ?? randomUUID(), type: 'gap', duration: operation.duration});
      break;
    }
    case 'set_gap': {
      const clip = project.clips[findClip(project, operation.clipId)];
      if (clip.type !== 'gap') fail('set_gap needs a gap clip.');
      clip.duration = operation.duration; break;
    }
    case 'set_transition': {
      const clip = project.clips[findClip(project, operation.clipId)];
      if (operation.transition === null) delete clip.transition;
      else clip.transition = clone(operation.transition);
      break;
    }
    case 'set_clip_visual': {
      const clip = project.clips[findClip(project, operation.clipId)];
      if (clip.type === 'gap') fail('A gap has no visual controls.');
      object(operation.patch, 'patch');
      for (const [key, value] of Object.entries(operation.patch)) {
        if (!['fit', 'position', 'crop', 'focus', 'motion'].includes(key)) fail(`Unknown visual control ${key}.`);
        if (value === null) {if (key === 'fit') clip.fit = 'cover'; else delete clip[key];}
        else clip[key] = clone(value);
        if (key === 'motion') delete clip.motionTimeOffset;
      }
      break;
    }
    case 'split_clip': {
      const index = findClip(project, operation.clipId);
      const clip = project.clips[index];
      number(operation.sourceTime, 'sourceTime');
      if (operation.sourceTime <= clip.sourceStart || operation.sourceTime >= clip.sourceEnd) fail('Split must be inside the clip.');
      project.clips.splice(index, 1, sliceClip(clip, clip.sourceStart, operation.sourceTime),
        {...sliceClip(clip, operation.sourceTime, clip.sourceEnd), id: operation.newClipId ?? `${clip.id}-${randomUUID()}`});
      break;
    }
    case 'remove_clip': project.clips.splice(findClip(project, operation.clipId), 1); break;
    case 'trim_clip': {
      const index = findClip(project, operation.clipId);
      project.clips[index] = sliceClip(project.clips[index], operation.sourceStart, operation.sourceEnd);
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
    case 'set_caption_cues': project.captions.cues = clone(operation.cues); break;
    case 'set_settings': object(operation.patch, 'patch'); project.settings = {...project.settings, ...clone(operation.patch)}; break;
    case 'set_audio': {
      validateAudioSettings(operation.patch);
      project.audio = mergeAudioSettings(project.audio, clone(operation.patch));
      break;
    }
    case 'set_clip_audio': {
      const clip = project.clips[findClip(project, operation.clipId)];
      if (clip.type === 'gap') fail('A gap has no source audio.');
      if (operation.patch === null) {delete clip.audio; break;}
      validateClipAudio(operation.patch);
      clip.audio = {...resolveClipAudio(clip.audio), ...clone(operation.patch)};
      if (['fadeIn', 'fadeOut', 'envelope', 'assetId', 'sourceStart', 'sourceEnd', 'offset'].some(key => Object.hasOwn(operation.patch, key))) {
        if (!Object.hasOwn(operation.patch, 'curveOffset')) delete clip.audio.curveOffset;
        if (!Object.hasOwn(operation.patch, 'curveDuration')) delete clip.audio.curveDuration;
      }
      break;
    }
    case 'set_asset_color': {
      const asset = project.assets.find((entry) => entry.id === operation.assetId);
      if (!asset) fail(`Unknown asset: ${operation.assetId}.`, 'ASSET_NOT_FOUND');
      if (asset.type === 'audio') fail('Color controls require an image or video asset.');
      const color = applyColorPatch(asset.color, operation.patch);
      if (color === undefined) delete asset.color;
      else asset.color = color;
      break;
    }
    case 'set_clip_color': {
      const clip = project.clips[findClip(project, operation.clipId)];
      if (clip.type === 'gap') fail('A gap has no source color.');
      const asset = project.assets.find((entry) => entry.id === clip.assetId);
      if (asset.type === 'audio') fail('Color controls require an image or video clip.');
      const color = applyColorPatch(clip.color, operation.patch);
      if (color === undefined) delete clip.color;
      else clip.color = color;
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
  return withLock(projectDir, async () => {
    const current = await loadProject(projectDir);
    checkRevision(current, expectedRevision);
    const project = prepareOperations(current, operations);
    project.revision++;
    project.updatedAt = new Date().toISOString();
    validateProject(project);
    return persist(projectDir, project);
  });
}
/** Build the exact proposed state without writing or assigning a new revision. */
export function prepareOperations(current, operations) {
  array(operations, 'operations');
  if (!operations.length || operations.length > 1000) fail('Supply 1 to 1000 operations.');
  const project = clone(current);
  for (const operation of operations) applyOperation(project, operation);
  validateProject(project);
  return project;
}
/** Commit a validated draft verbatim so generated IDs match its preview. */
export async function commitProjectSnapshot(projectDir, {expectedRevision, snapshot}) {
  return withLock(projectDir, async () => {
    const current = await loadProject(projectDir);
    checkRevision(current, expectedRevision);
    const project = clone(snapshot);
    if (project.id !== current.id || project.revision !== current.revision || project.createdAt !== current.createdAt) {
      fail('Snapshot belongs to a different project or base revision.', 'REVISION_CONFLICT');
    }
    project.revision++;
    project.updatedAt = new Date().toISOString();
    validateProject(project);
    return persist(projectDir, project);
  });
}
async function rebindRelinkedAssets(snapshot, current) {
  const currentAssets = new Map(current.assets.map((asset) => [asset.id, asset]));
  for (const asset of snapshot.assets) {
    const replacement = currentAssets.get(asset.id);
    if (!replacement || replacement.path === asset.path || !asset.fingerprint || replacement.fingerprint !== asset.fingerprint) continue;
    if (await fileFingerprint(asset.path).catch(() => null) === asset.fingerprint) continue;
    if (await fileFingerprint(replacement.path) !== asset.fingerprint) {
      fail(`Neither saved path has the original bytes for asset ${asset.id}.`, 'SOURCE_CHANGED');
    }
    asset.path = replacement.path;
  }
  return snapshot;
}

export async function readProjectRevision(projectDir, revision) {
  number(revision, 'revision', {min: 0, integer: true});
  const current = await loadProject(projectDir);
  const snapshot = await readJson(revisionPath(projectDir, revision));
  if (snapshot.id !== current.id || snapshot.revision !== revision || revision > current.revision) fail('Invalid revision.', 'REVISION_NOT_FOUND');
  return rebindRelinkedAssets(snapshot, current);
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
    await rebindRelinkedAssets(project, current);
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
