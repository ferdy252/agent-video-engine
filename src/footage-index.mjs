import {createHash, randomUUID} from 'node:crypto';
import {access, link, lstat, mkdir, readFile, realpath, rename, rm, stat, unlink, writeFile} from 'node:fs/promises';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileFingerprint, run} from './media.mjs';
import {analyzeTakes} from './take-index.mjs';

const schemaVersion = 1;
const algorithmVersion = 1;
const cellWidth = 320, imageHeight = 180, labelHeight = 24, gap = 4;
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, code = 'INVALID_MEDIA_INDEX') => {throw Object.assign(new Error(message), {code});};
const checkAbort = (signal) => {if (signal?.aborted) throw Object.assign(new Error('Source indexing cancelled'), {name: 'AbortError', code: 'CANCELLED'});};
const progress = (onProgress, value, stage) => {onProgress?.(value, stage);};
const transcriptFor = (project, assetId) => project.transcripts.find((entry) => entry.assetId === assetId) ?? null;
const transcriptHash = (transcript) => hash(transcript ? {language: transcript.language ?? null, words: transcript.words} : null);
const countsFor = (index) => ({thumbnails: index.frames.length, contactSheets: index.contactSheets.length,
  attempts: index.attempts.length, retakeGroups: index.groups.length});
const visualOnly = (index) => index.assetType === 'video' && index.transcriptStatus !== 'available';
const indexMode = (index) => index.assetType === 'video'
  ? (visualOnly(index) ? 'visual_only' : 'text_and_visual')
  : (index.transcriptStatus === 'available' ? 'text_only' : 'metadata_only');

function optionsFor({intervalSeconds = 15, maxThumbnails = 120}) {
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 120) fail('intervalSeconds must be from 1 to 120.');
  if (!Number.isInteger(maxThumbnails) || maxThumbnails < 6 || maxThumbnails > 240) fail('maxThumbnails must be an integer from 6 to 240.');
  return {intervalSeconds, maxThumbnails};
}

function indexDirectory(projectDir, indexId) {
  if (typeof indexId !== 'string' || !/^[a-f0-9]{64}$/.test(indexId)) fail('Supply the exact 64-character indexId returned by media_index.', 'INVALID_MEDIA_INDEX_ID');
  return join(resolve(projectDir), '.engine/indexes', indexId);
}

async function assetState(project, assetId, {stale = false} = {}) {
  const asset = project.assets.find((entry) => entry.id === assetId);
  if (!asset) fail('The indexed asset is not present in this project.', stale ? 'STALE_MEDIA_INDEX' : 'ASSET_NOT_FOUND');
  if (!['video', 'audio'].includes(asset.type)) fail('Source indexing supports video and audio recordings, not still images.', 'UNSUPPORTED_INDEX_ASSET');
  if (!Number.isFinite(asset.duration) || asset.duration <= 0) fail('Source duration must be positive.');
  let fingerprint;
  try {fingerprint = await fileFingerprint(asset.path);} catch (error) {
    if (stale) fail('The indexed source is unavailable or changed. Import it again and rebuild its index.', 'STALE_MEDIA_INDEX');
    throw error;
  }
  if (asset.fingerprint && asset.fingerprint !== fingerprint) {
    fail('Source changed since import. Import the original again before indexing.', stale ? 'STALE_MEDIA_INDEX' : 'SOURCE_CHANGED');
  }
  const transcript = transcriptFor(project, assetId);
  return {asset, fingerprint, transcript, transcriptFingerprint: transcriptHash(transcript)};
}

function expectedId(project, assetId, sourceFingerprint, transcriptFingerprint, options) {
  return hash({algorithmVersion, projectId: project.id, assetId, sourceFingerprint, transcriptFingerprint, options});
}

async function safeDerivedPath(directory, file) {
  if (typeof file !== 'string' || !file) fail('Cached derived-media path is missing.', 'MEDIA_INDEX_INCOMPLETE');
  const absolute = resolve(directory, file);
  const within = (candidate, base) => {const suffix = relative(base, candidate); return suffix && !suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix);};
  if (!within(absolute, resolve(directory))) fail('Cached media path escapes its index directory. Rebuild this index.', 'MEDIA_INDEX_INCOMPLETE');
  let canonical, base;
  try {canonical = await realpath(absolute); base = await realpath(directory);} catch {
    fail('Cached thumbnail or contact sheet is missing. Rebuild this index.', 'MEDIA_INDEX_INCOMPLETE');
  }
  const info = await stat(canonical);
  if (!within(canonical, base) || !info.isFile() || !info.size) {
    fail('Cached media points outside its index directory. Rebuild this index.', 'MEDIA_INDEX_INCOMPLETE');
  }
  return canonical;
}

function validateRecord(index, project, indexId) {
  if (!index || index.schemaVersion !== schemaVersion || index.algorithmVersion !== algorithmVersion ||
    index.indexId !== indexId || index.projectId !== project.id || !['video', 'audio'].includes(index.assetType) ||
    !['frames', 'contactSheets', 'attempts', 'groups', 'sourceWords'].every((field) => Array.isArray(index[field]))) {
    fail('The saved source index is incomplete or belongs to another project. Rebuild it.', 'MEDIA_INDEX_INCOMPLETE');
  }
  optionsFor(index.options ?? {});
  if (index.frames.length > index.options.maxThumbnails || index.frames.some((frame) =>
    !/^frame-\d{4}$/.test(frame.id) || frame.path !== `${frame.id}.jpg` || !Number.isFinite(frame.time) || frame.time < 0 || frame.time > index.duration) ||
    index.contactSheets.some((sheet, page) => sheet.page !== page || sheet.path !== `sheet-${String(page + 1).padStart(4, '0')}.jpg` ||
      !Array.isArray(sheet.frameIds) || sheet.frameIds.length > 12)) fail('Cached image metadata is invalid. Rebuild the index.', 'MEDIA_INDEX_INCOMPLETE');
  if (expectedId(project, index.assetId, index.sourceFingerprint, index.transcriptFingerprint, index.options) !== indexId) {
    fail('The saved source index does not match its cache identity. Rebuild it.', 'MEDIA_INDEX_INCOMPLETE');
  }
}

async function loadRecord(project, {projectDir, indexId}, state) {
  const directory = indexDirectory(projectDir, indexId);
  let index;
  try {
    if ((await lstat(directory)).isSymbolicLink()) fail('The source index directory cannot be a symbolic link.', 'MEDIA_INDEX_INCOMPLETE');
    if ((await lstat(join(directory, 'index.json'))).isSymbolicLink()) fail('The source index document cannot be a symbolic link.', 'MEDIA_INDEX_INCOMPLETE');
    index = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'MEDIA_INDEX_INCOMPLETE') throw error;
    fail('The saved source index is missing or incomplete. Run media_index to rebuild it.', 'MEDIA_INDEX_INCOMPLETE');
  }
  validateRecord(index, project, indexId);
  const current = state ?? await assetState(project, index.assetId, {stale: true});
  if (index.assetId !== current.asset.id || index.sourceFingerprint !== current.fingerprint ||
    index.transcriptFingerprint !== current.transcriptFingerprint || index.duration !== current.asset.duration || index.assetType !== current.asset.type) {
    fail('Source media or its transcript changed. Run media_index again before reading this map.', 'STALE_MEDIA_INDEX');
  }
  // Validate all image references even when the caller requests only text. A
  // manipulated cache must never become a file-reading shortcut for the host.
  for (const entry of [...index.frames, ...index.contactSheets]) await safeDerivedPath(directory, entry.path);
  return {index, directory, state: current};
}

function timestamp(time) {
  const millis = Math.round(time * 1000);
  const hours = Math.floor(millis / 3600000);
  const minutes = Math.floor(millis / 60000) % 60;
  const seconds = (millis % 60000) / 1000;
  return `${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m ${seconds.toFixed(3).padStart(6, '0')}s`;
}

function chooseEvenly(values, count) {
  if (values.length <= count) return values;
  if (count === 1) return [values[0]];
  return Array.from({length: count}, (_, index) => values[Math.round(index * (values.length - 1) / (count - 1))]);
}

/** Bounded whole-recording samples, reserving room for source attempt starts. */
function sampleFrames(asset, attempts, options, visualDuration = asset.duration) {
  const tail = Math.max(0, visualDuration - 1 / (asset.fps || 30));
  const starts = [...new Set(attempts.map((attempt) => Math.min(tail, Math.max(0, attempt.start))))].sort((a, b) => a - b);
  const reserved = Math.min(starts.length, Math.floor(options.maxThumbnails * .4));
  const regularCount = Math.min(Math.ceil(tail / options.intervalSeconds) + 1, options.maxThumbnails - reserved);
  const times = Array.from({length: Math.max(1, regularCount)}, (_, index) => {
    const desired = Math.ceil(tail / options.intervalSeconds) + 1;
    return regularCount < desired ? tail * index / Math.max(1, regularCount - 1) : Math.min(tail, index * options.intervalSeconds);
  });
  const byTime = new Map(times.map((time) => [Math.round(time * 1000), {time, kind: 'regular_sample', attemptIds: []}]));
  const remaining = starts.filter((time) => !byTime.has(Math.round(time * 1000)));
  const selected = chooseEvenly(remaining, Math.max(0, options.maxThumbnails - byTime.size));
  for (const time of selected) byTime.set(Math.round(time * 1000), {time, kind: 'attempt_start', attemptIds: []});
  for (const attempt of attempts) {
    const key = Math.round(Math.min(tail, Math.max(0, attempt.start)) * 1000);
    if (byTime.has(key)) byTime.get(key).attemptIds.push(attempt.id);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time).map((sample, index) => {
    const id = `frame-${String(index + 1).padStart(4, '0')}`;
    return {...sample, time: Math.round(sample.time * 1000) / 1000,
      sourceTime: Math.round(sample.time * 1000) / 1000, id, label: `${id} ${timestamp(sample.time)}`,
      path: `${id}.jpg`};
  });
}

async function videoDuration(asset, signal) {
  const {stdout} = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=duration,start_time:format=start_time', '-of', 'json', asset.path], {signal});
  const probe = JSON.parse(stdout), stream = probe.streams?.[0];
  const length = Number(stream?.duration);
  const origin = Number(stream?.start_time ?? 0) - Number(probe.format?.start_time ?? 0);
  return Number.isFinite(length) && length > 0 ? Math.min(asset.duration, length + Math.max(0, origin)) : asset.duration;
}

async function commitIndex(project, projectDir, indexId, temporary, directory, state, signal) {
  const lockPath = join(resolve(projectDir), '.engine/indexes', `.commit-${indexId}.lock`);
  const token = randomUUID();
  const ownerPath = join(temporary, 'commit-owner.json');
  await writeFile(ownerPath, JSON.stringify({pid: process.pid, token}), {flag: 'wx'});
  let acquired = false;
  for (let attempt = 0; !acquired && attempt < 200; attempt++) {
    checkAbort(signal);
    // Publish an already complete owner document atomically. A crash between
    // creating and writing a lock must not leave an unrecoverable empty lock.
    try {await link(ownerPath, lockPath); acquired = true;}
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const raw = await readFile(lockPath, 'utf8').catch(() => null);
      let owner; try {owner = JSON.parse(raw);} catch {}
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        let dead = false;
        try {process.kill(owner.pid, 0);} catch (error) {dead = error.code === 'ESRCH';}
        if (dead && await readFile(lockPath, 'utf8').catch(() => null) === raw) await unlink(lockPath).catch(() => {});
      } else {
        const info = await stat(lockPath).catch(() => null);
        if (info && Date.now() - info.mtimeMs > 1000 && await readFile(lockPath, 'utf8').catch(() => null) === raw) await unlink(lockPath).catch(() => {});
      }
      await delay(50, undefined, {signal});
    }
  }
  if (!acquired) fail('Another process is committing this source index. Retry shortly.', 'MEDIA_INDEX_BUSY');
  let displaced;
  try {
    await unlink(ownerPath);
    try {const winner = (await loadRecord(project, {projectDir, indexId}, state)).index; checkAbort(signal); return {cached: true, index: winner};}
    catch (error) {if (!['MEDIA_INDEX_INCOMPLETE', 'STALE_MEDIA_INDEX'].includes(error.code)) throw error;}
    checkAbort(signal);
    try {await lstat(directory); displaced = `${temporary}-invalid`; await rename(directory, displaced);}
    catch (error) {if (error.code !== 'ENOENT') throw error;}
    try {await rename(temporary, directory);}
    catch (error) {if (displaced) {await rename(displaced, directory); displaced = undefined;} throw error;}
    return {cached: false};
  } finally {
    if (displaced) await rm(displaced, {recursive: true, force: true});
    const owner = await readFile(lockPath, 'utf8').catch(() => null);
    try {if (JSON.parse(owner)?.token === token) await unlink(lockPath);} catch {}
  }
}

async function supportsLabels(signal) {
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=320x204:d=0.1',
      '-vf', "drawtext=text='frame-0001 00h 00m 00.000s':fontcolor=white:fontsize=15:x=6:y=3",
      '-frames:v', '1', '-f', 'null', '-'], {signal});
    return true;
  } catch (error) {checkAbort(signal); return false;}
}

async function browserSheet(project, directory, frames, sheet, signal) {
  const {renderProject} = await import('./render.mjs');
  const assets = frames.map((frame) => ({id: frame.id, type: 'image', path: join(directory, frame.path), duration: 0,
    width: cellWidth, height: imageHeight, hasAudio: false}));
  const overlays = sheet.cells.flatMap((cell) => [
    {id: `picture-${cell.frameId}`, type: 'image', assetId: cell.frameId, start: 0, end: 1,
      style: {left: cell.x, top: cell.y + labelHeight, width: cellWidth, height: imageHeight, objectFit: 'contain'}},
    {id: `label-${cell.frameId}`, type: 'text', text: cell.label, start: 0, end: 1,
      style: {left: cell.x, top: cell.y, width: cellWidth, height: labelHeight, fontSize: 15, color: '#ffffff'}},
  ]);
  const snapshot = {...project, assets, transcripts: [], clips: [], overlays, custom: null,
    settings: {width: sheet.width, height: sheet.height, fps: 1, background: '#000000'},
    captions: {...project.captions, enabled: false}};
  await renderProject(snapshot, {kind: 'still', frame: 0, outputPath: join(directory, sheet.path), signal});
}

function makeSheet(frames, page) {
  const columns = Math.min(4, frames.length), rows = Math.ceil(frames.length / columns);
  return {page, path: `sheet-${String(page + 1).padStart(4, '0')}.jpg`, frameIds: frames.map((frame) => frame.id),
    columns, rows, width: columns * (cellWidth + gap) + gap, height: rows * (imageHeight + labelHeight + gap) + gap,
    cells: frames.map((frame, index) => ({frameId: frame.id, time: frame.time, sourceTime: frame.time,
      label: frame.label, row: Math.floor(index / columns), column: index % columns,
      x: gap + index % columns * (cellWidth + gap), y: gap + Math.floor(index / columns) * (imageHeight + labelHeight + gap),
      width: cellWidth, height: imageHeight + labelHeight}))};
}

function summary(index, directory, cached) {
  return {indexId: index.indexId, assetId: index.assetId, sourceFingerprint: index.sourceFingerprint,
    transcriptFingerprint: index.transcriptFingerprint, indexPath: join(directory, 'index.json'), cached,
    counts: countsFor(index), transcriptStatus: index.transcriptStatus, assetType: index.assetType,
    visualOnly: visualOnly(index), indexMode: indexMode(index), limitations: index.limitations};
}

/** Index originals only. This never edits a manifest, chooses a take or transcribes. */
export async function buildMediaIndex(project, {projectDir, assetId, intervalSeconds = 15, maxThumbnails = 120, signal, onProgress} = {}) {
  checkAbort(signal);
  const options = optionsFor({intervalSeconds, maxThumbnails});
  const state = await assetState(project, assetId);
  const {asset, fingerprint, transcript, transcriptFingerprint} = state;
  checkAbort(signal);
  const indexId = expectedId(project, assetId, fingerprint, transcriptFingerprint, options);
  const directory = indexDirectory(projectDir, indexId);
  try {
    const loaded = await loadRecord(project, {projectDir, indexId}, state);
    checkAbort(signal);
    progress(onProgress, 1, 'Using cached source map');
    checkAbort(signal);
    return summary(loaded.index, directory, true);
  } catch (error) {
    if (!['MEDIA_INDEX_INCOMPLETE', 'STALE_MEDIA_INDEX'].includes(error.code)) throw error;
  }
  const parent = join(resolve(projectDir), '.engine/indexes');
  await mkdir(parent, {recursive: true});
  const temporary = join(parent, `.building-${indexId}-${randomUUID()}`);
  await mkdir(temporary);
  let committed = false;
  try {
    progress(onProgress, .05, 'Grouping source transcript attempts');
    const takes = analyzeTakes(transcript, {duration: asset.duration});
    const visualDuration = asset.type === 'video' ? await videoDuration(asset, signal) : null;
    const samples = asset.type === 'video' ? sampleFrames(asset, takes.attempts, options, visualDuration) : [];
    const frames = [], unavailableSamples = [];
    const labelled = samples.length ? await supportsLabels(signal) : false;
    for (let index = 0; index < samples.length; index++) {
      checkAbort(signal);
      const id = `frame-${String(frames.length + 1).padStart(4, '0')}`;
      const frame = {...samples[index], id, path: `${id}.jpg`, label: `${id} ${timestamp(samples[index].time)}`};
      const filter = `scale=${cellWidth}:${imageHeight}:force_original_aspect_ratio=decrease,pad=${cellWidth}:${imageHeight}:(ow-iw)/2:(oh-ih)/2:black` +
        (labelled ? `,pad=${cellWidth}:${imageHeight + labelHeight}:0:${labelHeight}:black,drawtext=text='${frame.label}':fontcolor=white:fontsize=15:x=6:y=3` : '');
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-ss', String(frame.time), '-i', asset.path,
        '-map', '0:v:0', '-frames:v', '1', '-vf', filter, '-q:v', '3', join(temporary, frame.path)], {signal});
      try {await access(join(temporary, frame.path)); frames.push(frame);}
      catch {unavailableSamples.push(frame.time);}
      progress(onProgress, .1 + .55 * (index + 1) / samples.length, `Sampling original frame ${index + 1}/${samples.length}`);
    }
    const contactSheets = [];
    for (let offset = 0; offset < frames.length; offset += 12) {
      checkAbort(signal);
      const pageFrames = frames.slice(offset, offset + 12), sheet = makeSheet(pageFrames, contactSheets.length);
      if (labelled) {
        await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-framerate', '1', '-start_number', String(offset + 1),
          '-i', join(temporary, 'frame-%04d.jpg'), '-frames:v', '1', '-vf',
          `tile=${sheet.columns}x${sheet.rows}:nb_frames=${pageFrames.length}:padding=${gap}:margin=${gap}:color=black`,
          '-q:v', '3', join(temporary, sheet.path)], {signal});
      } else await browserSheet(project, temporary, pageFrames, sheet, signal);
      contactSheets.push(sheet);
      progress(onProgress, .65 + .25 * Math.min(1, (offset + 12) / frames.length), `Labelling contact sheet ${sheet.page + 1}`);
    }
    checkAbort(signal);
    if (await fileFingerprint(asset.path) !== fingerprint) fail('Source changed while indexing. Reimport it before retrying.', 'SOURCE_CHANGED');
    const limitations = [
      'Thumbnails are regular samples and possible attempt starts, not semantic scene or action detection.',
      'Repeated passages are possible retakes, not a best-take choice. Inspect original delivery before editing.',
      ...(takes.limitations ?? []),
      ...(asset.type === 'audio' ? ['This audio recording has no visual thumbnails or contact sheets.'] : []),
      ...(takes.status !== 'available' ? [asset.type === 'video'
        ? 'No usable transcript is available. No transcription was requested; this video map contains sampled visuals only.'
        : 'No usable transcript is available. No transcription was requested; this audio map contains recording metadata only.'] : []),
      ...(visualDuration !== null && visualDuration < asset.duration - .05 ? ['Video ends before the full recording. Visual samples stop at the video stream end; transcript source times retain the full recording duration.'] : []),
      ...(unavailableSamples.length ? [`No video frame was available at ${unavailableSamples.length} requested sample times. Those samples were omitted, not relabelled as other times.`] : []),
      ...(!labelled && frames.length ? ['Contact-sheet labels were rendered with the installed local browser because FFmpeg drawtext was unavailable.'] : []),
    ];
    const index = {schemaVersion, algorithmVersion, indexId, projectId: project.id, assetId, assetType: asset.type, duration: asset.duration,
      sourceFingerprint: fingerprint, transcriptFingerprint, options, createdAt: new Date().toISOString(),
      frames, contactSheets, visualDuration, unavailableSamples, attempts: takes.attempts, groups: takes.groups, transcriptStatus: takes.status,
      sourceWords: transcript?.words ?? [], limitations};
    await writeFile(join(temporary, 'index.json'), JSON.stringify(index, null, 2) + '\n', {flag: 'wx'});
    checkAbort(signal);
    const commit = await commitIndex(project, projectDir, indexId, temporary, directory, state, signal);
    if (commit.cached) return summary(commit.index, directory, true);
    committed = true;
    progress(onProgress, 1, 'Source map ready');
    return summary(index, directory, false);
  } finally {if (!committed) await rm(temporary, {recursive: true, force: true});}
}

function pagination(offset, limit) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    fail('Use a nonnegative integer offset and a limit from 1 to 50.');
  }
}

function previewHint(index, start, end) {
  const sourceStart = Math.max(0, Math.min(index.duration - .001, start - .25));
  const sourceEnd = Math.min(index.duration, Math.max(sourceStart + .25, end + .25), sourceStart + 8);
  return {assetId: index.assetId, sourceStart, sourceEnd};
}

function groupIdsFor(index, attemptId) {return index.groups.filter((group) => group.attemptIds.includes(attemptId)).map((group) => group.id).slice(0, 8);}
function attemptSummary(index, attempt) {
  return {id: attempt.id, start: attempt.start, end: attempt.end, text: attempt.text.slice(0, 1000),
    wordIds: attempt.wordIds.slice(0, 80), wordCount: attempt.wordIds.length,
    wordIdsTruncated: attempt.wordIds.length > 80, textTruncated: attempt.text.length > 1000,
    reason: attempt.reason, boundaryEvidence: attempt.boundaryEvidence,
    groupIds: groupIdsFor(index, attempt.id), sourcePreview: previewHint(index, attempt.start, attempt.end)};
}

/** Return one bounded attempt page and, independently, one labelled image page. */
export async function readMediaIndex(project, {projectDir, indexId, offset = 0, limit = 20, sheetPage = 0} = {}) {
  pagination(offset, limit);
  if (!Number.isInteger(sheetPage) || sheetPage < 0) fail('sheetPage must be a nonnegative integer.');
  const {index, directory} = await loadRecord(project, {projectDir, indexId});
  const attempts = index.attempts.slice(offset, offset + limit).map((attempt) => attemptSummary(index, attempt));
  const ids = new Set(attempts.map((attempt) => attempt.id));
  const groups = index.groups.filter((group) => group.attemptIds.some((id) => ids.has(id))).slice(0, 50)
    .map((group) => ({...group, sharedText: String(group.sharedText ?? '').slice(0, 500),
      attemptIds: group.attemptIds.slice(0, 50), totalAttempts: group.attemptIds.length,
      attemptsTruncated: group.attemptIds.length > 50,
      evidence: {...group.evidence, comparisons: group.evidence?.comparisons?.slice(0, 10),
        comparisonCount: group.evidence?.comparisons?.length ?? 0,
        comparisonsTruncated: (group.evidence?.comparisons?.length ?? 0) > 10}}));
  const selected = index.contactSheets[sheetPage];
  const contactSheet = selected ? {...selected, path: await safeDerivedPath(directory, selected.path)} : null;
  const frameIds = new Set(selected?.frameIds ?? []);
  const frames = [];
  for (const frame of index.frames.filter((frame) => frameIds.has(frame.id))) frames.push({...frame,
    attemptIds: frame.attemptIds.slice(0, 80), attemptCount: frame.attemptIds.length,
    path: await safeDerivedPath(directory, frame.path)});
  const hasMore = offset + attempts.length < index.attempts.length;
  return {indexId, assetId: index.assetId, sourceFingerprint: index.sourceFingerprint, transcriptFingerprint: index.transcriptFingerprint,
    currentRevision: project.revision, status: 'current', duration: index.duration, options: index.options,
    transcriptStatus: index.transcriptStatus, assetType: index.assetType, visualOnly: visualOnly(index), indexMode: indexMode(index),
    counts: countsFor(index), offset, limit, totalAttempts: index.attempts.length, hasMore,
    nextOffset: hasMore ? offset + attempts.length : null, attempts, groups, frames, contactSheet,
    sheetCount: index.contactSheets.length, sheetPage, limitations: index.limitations};
}

const tokens = (text) => String(text).normalize('NFKC').replace(/[\u2018\u2019]/g, "'").toLocaleLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

/** Lexical spoken-text search, never visual/semantic search or take ranking. */
export async function searchMediaIndex(project, {projectDir, indexId, query, offset = 0, limit = 20} = {}) {
  pagination(offset, limit);
  const queryTokens = tokens(query);
  if (!queryTokens.length || queryTokens.length > 40) fail('Supply a spoken-text query with 1 to 40 words.');
  const {index} = await loadRecord(project, {projectDir, indexId});
  const wordMap = new Map(index.sourceWords.map((word) => [word.id, word]));
  const matching = [];
  for (const attempt of index.attempts) {
    const source = attempt.wordIds.map((id) => wordMap.get(id)).filter(Boolean);
    const normalized = source.flatMap((word, wordIndex) => tokens(word.text).map((token) => ({token, wordIndex})));
    for (let index = 0; index <= normalized.length - queryTokens.length; index++) {
      if (queryTokens.every((token, offset) => normalized[index + offset].token === token)) {
        matching.push({attempt, source, first: normalized[index].wordIndex, last: normalized[index + queryTokens.length - 1].wordIndex});
      }
    }
  }
  const matches = matching.slice(offset, offset + limit).map(({attempt, source, first, last}) => {
    const words = source.slice(first, last + 1);
    const contextWords = source.slice(Math.max(0, first - 8), last + 9);
    const groupIds = groupIdsFor(index, attempt.id);
    const alternatives = index.attempts.filter((other) => other.id !== attempt.id && index.groups.some((group) =>
      groupIds.includes(group.id) && group.attemptIds.includes(other.id))).slice(0, 5).map((other) => ({attemptId: other.id,
      id: other.id, start: other.start, end: other.end, text: other.text.slice(0, 250),
      wordIds: other.wordIds.slice(0, 80), wordCount: other.wordIds.length, wordIdsTruncated: other.wordIds.length > 80,
      groupIds: groupIdsFor(index, other.id),
      sourcePreview: previewHint(index, other.start, other.end)}));
    const start = source[first]?.start ?? attempt.start;
    const end = source[last]?.end ?? attempt.end;
    return {attemptId: attempt.id, start, end, text: words.map((word) => word.text).join(' ').slice(0, 1500),
      wordIds: words.map((word) => word.id).slice(0, 80), contextText: contextWords.map((word) => word.text).join(' ').slice(0, 1500),
      groupIds, alternatives,
      sourcePreview: previewHint(index, start, end)};
  });
  const hasMore = offset + matches.length < matching.length;
  return {indexId, assetId: index.assetId, currentRevision: project.revision, query, offset, limit,
    totalMatches: matching.length, hasMore, nextOffset: hasMore ? offset + matches.length : null,
    transcriptStatus: index.transcriptStatus, assetType: index.assetType, visualOnly: visualOnly(index), indexMode: indexMode(index), matches,
    limitations: [...index.limitations, 'Search matches normalized spoken words. It does not identify objects, visuals, actions or the best delivery.']};
}
