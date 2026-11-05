import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir, open, link, rm} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {compileTimeline} from './timeline.mjs';
import {validateProject} from './project.mjs';
import {renderProject} from './render.mjs';
import {toolEnv} from './media.mjs';
import {resolveAudioSettings, resolveClipAudio, volumeAt} from './audio-settings.mjs';
import {colorTransform} from './color-settings.mjs';

const invalid = (message) => { throw Object.assign(new Error(message), {code: 'INVALID_REVIEW_REQUEST'}); };
const abortError = () => Object.assign(new Error('Cut review cancelled'), {name: 'AbortError', code: 'CANCELLED'});
const checkAbort = (signal) => {if (signal?.aborted) throw abortError();};
const db = (rms) => 20 * Math.log10(Math.max(rms, 1e-12));

function wordBoundary(project, clip, sourceTime, side) {
  const words = project.transcripts.find((entry) => entry.assetId === clip.assetId)?.words;
  const intervals = words?.filter((word) => word.end > word.start) ?? [];
  const pointCount = (words?.length ?? 0) - intervals.length;
  const status = !words ? 'unassessed_no_transcript' : !words.length ? 'unassessed_empty_transcript'
    : !intervals.length ? 'unassessed_point_timestamps' : pointCount ? 'partial_point_timestamps' : 'assessed_source_word_intervals';
  const evidence = intervals.filter((word) => sourceTime > word.start + 0.015 && sourceTime < word.end - 0.015)
    .map((word) => ({side, assetId: clip.assetId, clipId: clip.id, wordId: word.id, text: word.text,
      wordStart: word.start, wordEnd: word.end, boundarySourceTime: sourceTime}));
  return {status, toleranceSeconds: 0.015, intervalCount: intervals.length, pointCount, evidence};
}

/** Locate actual discontinuities on the compiled master frame clock. */
export function analyzeCutBoundaries(project) {
  if (project.custom && project.custom.mode !== 'layer') throw Object.assign(new Error('This standalone composition may use independent cuts. Adapt its motion to custom.mode="layer" to keep the engine in control of the main timeline.'), {code: 'UNSUPPORTED_CUSTOM_REVIEW'});
  const timeline = compileTimeline(project);
  const audio = resolveAudioSettings(project.audio);
  const cuts = [];
  for (let index = 1; index < timeline.clips.length; index++) {
    const left = timeline.clips[index - 1], right = timeline.clips[index];
    if (left.type === 'gap' || right.type === 'gap') continue;
    const leftAudio = resolveClipAudio(left.audio), rightAudio = resolveClipAudio(right.audio);
    const contiguous = !right.transition && left.assetId === right.assetId && Math.abs(left.sourceEnd - right.sourceStart) < 1e-7 &&
      left.playbackRate === right.playbackRate && left.volume === right.volume && left.fit === right.fit &&
      leftAudio.gainDb === rightAudio.gainDb && (!audio.enabled || leftAudio.leveling === rightAudio.leveling) &&
      JSON.stringify(colorTransform(left.color)) === JSON.stringify(colorTransform(right.color)) &&
      JSON.stringify(leftAudio) === JSON.stringify(rightAudio) &&
      JSON.stringify([left.crop, left.focus, left.motion]) === JSON.stringify([right.crop, right.focus, right.motion]) &&
      JSON.stringify(left.position ?? null) === JSON.stringify(right.position ?? null);
    if (contiguous) continue;
    const leftWords = wordBoundary(project, {...left, assetId: left.audioAssetId}, left.audio?.sourceEnd ?? left.sourceEnd, 'left');
    const rightWords = wordBoundary(project, {...right, assetId: right.audioAssetId}, right.audio?.sourceStart ?? right.sourceStart, 'right');
    const evidence = [...leftWords.evidence, ...rightWords.evidence];
    const outputFrame = right.from + Math.floor((right.transitionFrames ?? 0) / 2);
    cuts.push({id: `cut-${cuts.length + 1}`, index: cuts.length, outputFrame, outputTime: outputFrame / timeline.fps,
      ...(right.transition ? {transition: {...right.transition, startFrame: right.from, endFrame: right.from + right.transitionFrames},
        assessmentNote: 'This join overlaps. Audio measurements include both clips during the transition.'} : {}),
      left: {clipId: left.id, assetId: left.assetId, sourceTime: left.sourceEnd},
      right: {clipId: right.id, assetId: right.assetId, sourceTime: right.sourceStart},
      wordTiming: {left: leftWords, right: rightWords},
      flags: evidence.length ? [{code: 'CUT_INSIDE_WORD', severity: 'warning',
        message: 'A retained source boundary falls inside a measured transcript word. Review the source delivery and join.', evidence}] : [],
      audio: null, preview: null});
  }
  return {fps: timeline.fps, totalCuts: cuts.length, cuts};
}

function sampleStats(samples, from, to, channels) {
  const sums = Array(channels).fill(0);
  let peak = 0;
  for (let frame = from; frame < to; frame++) for (let channel = 0; channel < channels; channel++) {
    const sample = samples[frame * channels + channel];
    if (!Number.isFinite(sample)) invalid('Audio samples must be finite.');
    sums[channel] += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  const frames = to - from;
  const channelRms = sums.map((sum) => Math.sqrt(sum / Math.max(1, frames)));
  const rms = Math.sqrt(sums.reduce((a, b) => a + b, 0) / Math.max(1, frames * channels));
  return {rms, peak, dbfs: db(rms), channelRms, frames};
}

/** Audio is interleaved; cutSample is a sample-frame index, never a byte offset. */
export function analyzeAudioSamples(samples, {sampleRate, cutSample, channels = 1, windowMs = 150,
  silenceThresholdDb = -45, longSilenceSeconds = 0.4, levelJumpDb = 12} = {}) {
  if (!(samples instanceof Float32Array)) invalid('Audio samples must be a Float32Array.');
  if (!Number.isInteger(channels) || channels < 1 || channels > 8 || samples.length % channels) invalid('Invalid interleaved audio channel count.');
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isInteger(cutSample) || cutSample <= 0 || cutSample >= samples.length / channels) invalid('Audio cutSample must lie inside the decoded preview.');
  for (const [key, value] of Object.entries({windowMs, silenceThresholdDb, longSilenceSeconds, levelJumpDb})) {
    if (!Number.isFinite(value)) invalid(`${key} must be finite.`);
  }
  if (windowMs <= 0 || longSilenceSeconds <= 0 || levelJumpDb <= 0) invalid('Audio analysis windows and thresholds must be positive.');
  const totalFrames = samples.length / channels;
  const windowFrames = Math.max(1, Math.round(sampleRate * windowMs / 1000));
  const left = sampleStats(samples, Math.max(0, cutSample - windowFrames), cutSample, channels);
  const right = sampleStats(samples, cutSample, Math.min(totalFrames, cutSample + windowFrames), channels);
  const flags = [];
  const change = right.dbfs - left.dbfs;
  if (left.dbfs > silenceThresholdDb && right.dbfs > silenceThresholdDb && Math.abs(change) >= levelJumpDb) {
    flags.push({code: 'AUDIO_LEVEL_JUMP', severity: 'warning', message: 'The mixed audio level changes sharply across the join. Review the signal-level change and listen to the join.',
      evidence: {leftDbfs: left.dbfs, rightDbfs: right.dbfs, differenceDb: Math.abs(change), thresholdDb: levelJumpDb, windowMs}});
  }
  const binFrames = Math.max(1, Math.round(sampleRate * 0.01));
  const quiet = (from, to) => sampleStats(samples, from, to, channels).channelRms.every((rms) => db(rms) <= silenceThresholdDb);
  let start = cutSample, end = cutSample;
  while (start > 0) {
    const previous = Math.max(0, start - binFrames);
    if (!quiet(previous, start)) break;
    start = previous;
  }
  while (end < totalFrames) {
    const next = Math.min(totalFrames, end + binFrames);
    if (!quiet(end, next)) break;
    end = next;
  }
  const silence = {durationSeconds: (end - start) / sampleRate, startSample: start, endSample: end,
    thresholdDb: silenceThresholdDb, binMs: binFrames / sampleRate * 1000,
    truncatedAtPreviewStart: start === 0, truncatedAtPreviewEnd: end === totalFrames,
    isLowerBound: start === 0 || end === totalFrames};
  if (silence.durationSeconds >= longSilenceSeconds) flags.push({code: 'LONG_SILENCE_NEAR_JOIN', severity: 'info',
    message: `The mixed track contains a quiet gap around the join${silence.isLowerBound ? ' that reaches the preview edge' : ''}. Review whether the pause is intentional.`,
    evidence: {...silence, thresholdSeconds: longSilenceSeconds}});
  return {status: 'analyzed', sampleRate, channels, windowMs, evidenceScope: 'mixed_master',
    windowTruncated: {left: left.frames < windowFrames, right: right.frames < windowFrames},
    left, right, levelJumpDb: Math.abs(change), levelChangeDb: change, silence, flags};
}

function audibleNear(timeline, cut, side) {
  const assets = new Map(timeline.assets.map((asset) => [asset.id, asset]));
  const hasAudio = (assetId) => {const asset = assets.get(assetId); return asset?.type === 'audio' || asset?.hasAudio === true;};
  const frame = cut.outputFrame + (side === 'left' ? -0.25 : 0.25);
  if (timeline.clips.some(clip => clip.type !== 'gap' && hasAudio(clip.audioAssetId) && clip.audioFrom <= frame &&
    clip.audioFrom + clip.audioDurationInFrames > frame && volumeAt(clip.audio, (frame - clip.audioFrom) / timeline.fps,
      clip.audioDurationInFrames / timeline.fps, clip.volume ?? 1) > 0)) return true;
  return timeline.overlays.some((overlay) => ['audio', 'video'].includes(overlay.type) && (overlay.volume ?? 1) > 0 &&
    overlay.from <= frame && overlay.from + overlay.durationInFrames > frame && hasAudio(overlay.assetId) &&
    volumeAt(overlay.audio, (frame - overlay.from) / timeline.fps, overlay.durationInFrames / timeline.fps, overlay.volume ?? 1) > 0);
}

async function decodeAudio(file, {signal, sampleRate = 16000, channels = 2} = {}) {
  checkAbort(signal);
  const bytes = await new Promise((resolveDecode, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:a:0',
      '-vn', '-ac', String(channels), '-ar', String(sampleRate), '-f', 'f32le', '-'], {env: toolEnv, stdio: ['ignore', 'pipe', 'pipe']});
    const chunks = [];
    let length = 0, stderr = '', killTimer, failure;
    const abort = () => {child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 2000); killTimer.unref();};
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    child.stdout.on('data', (chunk) => {
      length += chunk.length;
      if (length > 2 * 1024 * 1024) {failure = Object.assign(new Error('Bounded cut preview produced too much decoded audio.'), {code: 'AUDIO_LIMIT_EXCEEDED'}); abort();}
      else chunks.push(chunk);
    });
    child.stderr.on('data', (data) => {stderr = (stderr + data).slice(-4000);});
    child.once('error', (error) => {failure = error;});
    child.once('close', (code) => {
      signal?.removeEventListener('abort', abort);
      clearTimeout(killTimer);
      if (signal?.aborted) return reject(abortError());
      if (failure) return reject(failure);
      if (code !== 0) return reject(Object.assign(new Error(`Cannot decode cut preview audio: ${stderr}`), {code: 'AUDIO_DECODE_FAILED'}));
      resolveDecode(Buffer.concat(chunks));
    });
  });
  const samples = new Float32Array(Math.floor(bytes.length / 4));
  for (let index = 0; index < samples.length; index++) samples[index] = bytes.readFloatLE(index * 4);
  return {samples, sampleRate, channels};
}

async function saveReport(report, directory, signal) {
  const temporary = join(directory, `.cut-review-${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    await file.sync();
    await file.close();
    file = null;
    checkAbort(signal);
    await link(temporary, report.reportPath);
  } finally {
    await file?.close();
    await rm(temporary, {force: true});
  }
}

/** Review a frozen manifest without changing its edit, media or revision history. */
export async function reviewCuts(project, {projectDir, outputDir, contextSeconds = 1, limit = 20, offset = 0,
  renderPreviews = true, signal, onProgress = () => {}} = {}) {
  checkAbort(signal);
  if (!Number.isFinite(contextSeconds) || contextSeconds < 0.25 || contextSeconds > 3) invalid('contextSeconds must be between 0.25 and 3.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) invalid('limit must be an integer between 1 and 50.');
  if (!Number.isInteger(offset) || offset < 0) invalid('offset must be a nonnegative integer.');
  if (typeof renderPreviews !== 'boolean') invalid('renderPreviews must be boolean.');
  if (!outputDir && !projectDir) invalid('projectDir or outputDir is required for the review report.');
  const snapshot = structuredClone(project);
  validateProject(snapshot);
  const boundaries = analyzeCutBoundaries(snapshot);
  const timeline = compileTimeline(snapshot);
  const directory = resolve(outputDir ?? join(projectDir, '.engine', 'reviews', randomUUID()));
  await mkdir(dirname(directory), {recursive: true});
  try { await mkdir(directory); }
  catch (error) {
    if (error.code === 'EEXIST') throw Object.assign(new Error('Review output directory already exists. Choose a new, job-specific directory.'), {code: 'REVIEW_OUTPUT_EXISTS'});
    throw error;
  }
  let succeeded = false;
  try {
    const cuts = boundaries.cuts.slice(offset, offset + limit);
    for (let index = 0; index < cuts.length; index++) {
      checkAbort(signal);
      const cut = cuts[index];
      onProgress({stage: 'review_cuts', progress: index / cuts.length, cutIndex: cut.index, message: `Reviewing cut ${cut.index + 1} of ${boundaries.totalCuts}`});
      if (!renderPreviews) {
        cut.audio = {status: 'skipped', reason: 'renderPreviews is false; only transcript-boundary timing was checked.', evidenceScope: 'none'};
        continue;
      }
      const contextFrames = Math.max(1, Math.round(contextSeconds * timeline.fps));
      const fromFrame = Math.max(0, cut.outputFrame - contextFrames);
      const toFrame = Math.min(timeline.durationInFrames - 1, cut.outputFrame + contextFrames - 1);
      const outputPath = join(directory, `cut-${cut.index + 1}-${randomUUID().slice(0, 8)}.mp4`);
      const preview = await renderProject(snapshot, {kind: 'preview', fromFrame, toFrame, outputPath, scale: 0.5, signal,
        onProgress: (update) => {
          const fraction = update.stage === 'bundle' ? (update.progress ?? 0) * 0.1
            : update.stage === 'render' ? 0.1 + (update.progress ?? 0) * 0.65 : update.stage === 'verify' ? 0.8 : 0.9;
          onProgress({stage: 'review_cuts', progress: (index + fraction) / cuts.length, cutIndex: cut.index, renderStage: update.stage});
        }});
      const previewStart = preview.frameRange[0];
      cut.preview = {...preview, fromFrame: previewStart, toFrame: preview.frameRange[1],
        cutFrameInPreview: cut.outputFrame - previewStart, cutTimeInPreview: (cut.outputFrame - previewStart) / timeline.fps};
      const expectedAudio = {left: audibleNear(timeline, cut, 'left'), right: audibleNear(timeline, cut, 'right')};
      const knownAudioOnBothSides = expectedAudio.left && expectedAudio.right;
      const customLayer = snapshot.custom?.mode === 'layer';
      if (!knownAudioOnBothSides && !customLayer) {
        cut.audio = {status: 'not_analyzable', evidenceScope: 'mixed_master', expectedAudio,
          reason: 'Audio is not present or is intentionally muted at one or both sides of this join. Silence and level-change flags were not inferred.'};
        continue;
      }
      const decoded = await decodeAudio(preview.outputPath, {signal});
      const cutSample = Math.round(cut.preview.cutTimeInPreview * decoded.sampleRate);
      if (cutSample <= 0 || cutSample >= decoded.samples.length / decoded.channels) {
        cut.audio = {status: 'not_analyzable', evidenceScope: 'mixed_master', reason: 'Decoded preview does not contain audio on both sides of the join.'};
        continue;
      }
      cut.audio = {...analyzeAudioSamples(decoded.samples, {...decoded, cutSample}), expectedAudio};
      if (customLayer) {
        cut.audio.customLayerAudio = 'unknown';
        if (!knownAudioOnBothSides) {
          cut.audio.silenceAssessment = 'unassessed_custom_layer_audio_expectation';
          cut.audio.flags = cut.audio.flags.filter((flag) => flag.code !== 'LONG_SILENCE_NEAR_JOIN');
          cut.audio.silenceAssessmentNote = 'The custom layer may supply audio. Measured level changes are available, but silence is not classified without known audio on both sides in the engine timeline.';
        }
      }
      const nearbyCuts = boundaries.cuts.filter((other) => other.id !== cut.id && Math.abs(other.outputTime - cut.outputTime) < 0.15)
        .map((other) => ({id: other.id, outputTime: other.outputTime}));
      if (nearbyCuts.length) cut.audio.isolationNote = 'Other joins fall inside the audio measurement window; level changes cannot be attributed to this join alone.';
      cut.audio.nearbyCuts = nearbyCuts;
      cut.flags.push(...cut.audio.flags);
    }
    checkAbort(signal);
    const byCode = {};
    for (const cut of cuts) for (const flag of cut.flags) byCode[flag.code] = (byCode[flag.code] ?? 0) + 1;
    const report = {schemaVersion: 1, revision: snapshot.revision, fps: timeline.fps, totalCuts: boundaries.totalCuts,
      reviewScope: 'engine_main_timeline', customMode: snapshot.custom?.mode ?? (snapshot.custom ? 'composition' : null),
    offset, limit, reviewedCuts: cuts.length, hasMore: offset + cuts.length < boundaries.totalCuts,
    nextOffset: offset + cuts.length < boundaries.totalCuts ? offset + cuts.length : null, cuts,
      reportPath: join(directory, `cut-review-${randomUUID()}.json`),
      summary: {totalCuts: boundaries.totalCuts, reviewedCuts: cuts.length, flaggedCuts: cuts.filter((cut) => cut.flags.length).length,
        flagCount: cuts.reduce((sum, cut) => sum + cut.flags.length, 0), byCode,
        previewsRendered: cuts.filter((cut) => cut.preview).length, audioAnalyzed: cuts.filter((cut) => cut.audio?.status === 'analyzed').length},
      limitations: ['Transcript timing may be missing or inaccurate. Boundary checks do not establish whether a spoken word sounds clipped.',
      'Audio measurements describe the mixed master, so music or effects can mask speech. Level changes are not proof of clicks.',
        'Quiet-gap thresholds and short windows are review aids. They do not establish natural speech flow or final mix quality.',
        ...(snapshot.custom?.mode === 'layer' ? ['Main-clip joins use the engine timeline. Independent cuts inside custom layers are not discovered, and custom visuals may cover the main video.'] : []),
        ...(!renderPreviews ? ['Moving previews and mixed-audio measurements were skipped.'] : [])]};
    await saveReport(report, directory, signal);
    onProgress({stage: 'review_cuts', progress: 1, message: 'Cut review report saved'});
    succeeded = true;
    return report;
  } finally {
    // The directory was exclusively created by this call. Never remove or
    // reuse an existing directory, and retain no partial review after failure.
    if (!succeeded) await rm(directory, {recursive: true, force: true});
  }
}
