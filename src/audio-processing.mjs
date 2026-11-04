import {run} from './media.mjs';
import {open, rm} from 'node:fs/promises';
import {resolveAudioSettings, resolveClipAudio} from './audio-settings.mjs';

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const decibels = (value) => 10 ** (value / 20);
const checkAbort = (signal) => signal?.throwIfAborted();
const progress = (observer, value, stage) => {try {observer?.({progress: value, stage});} catch {}};
const headroomDb = .5;
const minimumDuration = .4;
const quietFloorDb = -65;

async function probeAudio(file, signal) {
  const {stdout} = await run('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type,duration:format=duration', '-of', 'json', file], {signal});
  const info = JSON.parse(stdout), stream = info.streams?.find((entry) => entry.codec_type === 'audio');
  return {hasAudio: Boolean(stream), duration: finite(stream?.duration ?? info.format?.duration) ?? 0};
}

function tempoFilters(rate) {
  const result = [];
  while (rate < .5) {result.push('atempo=0.5'); rate /= .5;}
  while (rate > 2) {result.push('atempo=2'); rate /= 2;}
  if (Math.abs(rate - 1) > 1e-8) result.push(`atempo=${rate}`);
  return result;
}

async function measure(file, {signal, duration, input = [], prefix = []}) {
  checkAbort(signal);
  const {stderr} = await run('ffmpeg', ['-hide_banner', '-loglevel', 'info', ...input, '-i', file,
    '-map', '0:a:0', '-vn', '-af', [...prefix, 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json'].join(','),
    '-f', 'null', '-'], {signal});
  const document = stderr.match(/\{\s*"input_i"[\s\S]*?\}/g)?.at(-1);
  if (!document) throw Object.assign(new Error('The local audio processor did not return loudness measurements.'), {code: 'AUDIO_MEASUREMENT_FAILED'});
  const raw = JSON.parse(document), integratedLufs = finite(raw.input_i), truePeakDb = finite(raw.input_tp);
  const silent = truePeakDb === null || truePeakDb <= quietFloorDb;
  const insufficient = duration < minimumDuration || integratedLufs === null;
  return {status: silent ? 'silent' : insufficient ? 'insufficient_duration' : 'measured',
    duration, hasAudio: true, integratedLufs, truePeakDb, loudnessRange: finite(raw.input_lra), silent};
}

/** Measure the actual file without changing it. Nonfinite silence values stay JSON-safe. */
export async function analyzeAudio(file, {signal} = {}) {
  checkAbort(signal);
  const info = await probeAudio(file, signal);
  if (!info.hasAudio) return {status: 'missing_audio', duration: info.duration, hasAudio: false,
    integratedLufs: null, truePeakDb: null, loudnessRange: null, silent: false};
  return measure(file, {...info, signal});
}

/** Main clips are assumed voice. Near-contiguous fragments share a constant gain. */
export async function prepareVoiceGains(project, timeline, {signal, onProgress} = {}) {
  checkAbort(signal);
  const settings = resolveAudioSettings(project.audio), assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const result = structuredClone(timeline), groups = [], membership = new Map(), metadata = new Map();
  const candidates = result.clips.filter((clip) => {
    const asset = assets.get(clip.assetId), audio = resolveClipAudio(clip.audio);
    return settings.enabled && settings.strength > 0 && audio.leveling && (clip.volume ?? 1) > 0 &&
      asset && asset.type !== 'image' && asset.hasAudio !== false;
  }).map((clip) => ({clip, rate: clip.playbackRate ?? 1,
    start: Number.isFinite(clip.sourceFrame) ? clip.sourceFrame / timeline.fps : clip.sourceStart,
    end: (Number.isFinite(clip.sourceFrame) ? clip.sourceFrame / timeline.fps : clip.sourceStart) +
      clip.durationInFrames / timeline.fps * (clip.playbackRate ?? 1)}))
    .sort((a, b) => a.clip.assetId.localeCompare(b.clip.assetId) || a.rate - b.rate || a.start - b.start);
  for (const candidate of candidates) {
    let group = groups.at(-1);
    if (!group || group.assetId !== candidate.clip.assetId || group.playbackRate !== candidate.rate || candidate.start > group.sourceEnd + .5) {
      group = {id: `voice-span-${groups.length + 1}`, assetId: candidate.clip.assetId,
        sourceStart: candidate.start, sourceEnd: candidate.end, playbackRate: candidate.rate, clips: []};
      groups.push(group);
    } else group.sourceEnd = Math.max(group.sourceEnd, candidate.end);
    group.clips.push(candidate.clip.id); membership.set(candidate.clip.id, group);
  }
  for (let index = 0; index < groups.length; index++) {
    checkAbort(signal);
    const group = groups[index], asset = assets.get(group.assetId);
    let info = metadata.get(group.assetId);
    if (!info) {info = await probeAudio(asset.path, signal); metadata.set(group.assetId, info);}
    const sourceDuration = Math.max(0, Math.min(group.sourceEnd, asset.duration) - group.sourceStart);
    const duration = sourceDuration / group.playbackRate;
    group.analysis = !info.hasAudio ? {status: 'missing_audio', hasAudio: false, duration,
      integratedLufs: null, truePeakDb: null, loudnessRange: null, silent: false}
      : sourceDuration < minimumDuration || duration < minimumDuration
        ? {status: 'insufficient_duration', hasAudio: true, duration, sourceDuration,
          integratedLufs: null, truePeakDb: null, loudnessRange: null, silent: false,
          measurementSkipped: 'The available source or played span is too short for a stable loudness measurement.'}
        : await measure(asset.path, {signal, duration,
        input: ['-ss', String(group.sourceStart), '-t', String(sourceDuration)],
        prefix: [...tempoFilters(group.playbackRate), 'aformat=channel_layouts=stereo']});
    group.automaticGainDb = group.analysis.status === 'measured'
      ? clamp(settings.targetLufs - group.analysis.integratedLufs, -settings.maxGainDb, settings.maxGainDb) * settings.strength : 0;
    progress(onProgress, (index + 1) / Math.max(1, groups.length), `Measuring voice span ${index + 1}/${groups.length}`);
  }
  const clips = result.clips.map((clip) => {
    const audio = resolveClipAudio(clip.audio), asset = assets.get(clip.assetId), group = membership.get(clip.id);
    const automaticGainDb = group?.automaticGainDb ?? 0;
    const manualGainDb = audio.gainDb + (settings.enabled ? settings.voiceGainDb : 0);
    const effectiveVolume = (clip.volume ?? 1) * decibels(automaticGainDb + manualGainDb);
    clip.volume = effectiveVolume;
    return {clipId: clip.id, groupId: group?.id ?? null,
      status: group?.analysis.status ?? (asset?.hasAudio === false || asset?.type === 'image' ? 'missing_audio'
        : (clip.volume === 0 ? 'muted' : !audio.leveling ? 'opted_out' : 'disabled')),
      measuredLufs: group?.analysis.integratedLufs ?? null, automaticGainDb, manualGainDb, effectiveVolume};
  });
  checkAbort(signal);
  return {timeline: result, report: {enabled: settings.enabled, settings, scope: 'main_timeline_clips',
    counts: {clips: clips.length, groups: groups.length}, clips: clips.slice(0, 100), clipsTruncated: clips.length > 100,
    groups: groups.slice(0, 100).map((group) => ({...group, clips: group.clips.slice(0, 50),
      clipCount: group.clips.length, clipsTruncated: group.clips.length > 50})), groupsTruncated: groups.length > 100,
    limitations: ['Main-timeline clips are assumed to contain voice. This is level measurement, not speech detection.',
      'Nearby fragments share a constant gain to preserve emphasis. Short, silent or unmeasurable spans receive no automatic gain.',
      'Source gaps of at most half a second may be included when measuring fragments of the same recording.',
      'Music and effects in overlays do not receive automatic voice gain. Existing clip volume and manual adjustments are applied after measurement.']}};
}

/** Finish the complete project mix with constant gain, preserving its dynamics. */
export async function finishAudioMaster(inputWav, outputWav, suppliedSettings, {signal, onProgress} = {}) {
  const settings = resolveAudioSettings(suppliedSettings);
  checkAbort(signal);
  progress(onProgress, 0, 'Measuring complete audio master');
  const before = await analyzeAudio(inputWav, {signal});
  if (!before.hasAudio) throw Object.assign(new Error('The rendered master has no audio stream.'), {code: 'AUDIO_STREAM_MISSING'});
  const canNormalize = settings.enabled && before.status === 'measured';
  const automaticGainDb = canNormalize ? Math.min(settings.maxGainDb, settings.targetLufs - before.integratedLufs) : 0;
  const requestedGainDb = automaticGainDb + (settings.enabled ? settings.outputGainDb : 0);
  const ceiling = settings.truePeakDb - headroomDb;
  const peakGainDb = settings.enabled && before.truePeakDb !== null ? ceiling - before.truePeakDb : Infinity;
  const appliedGainDb = Math.min(requestedGainDb, peakGainDb);
  checkAbort(signal);
  progress(onProgress, .5, 'Applying complete-master audio gain');
  let owned = false, after;
  try {
    const handle = await open(outputWav, 'wx', 0o600); owned = true; await handle.close();
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputWav, '-map', '0:a:0', '-vn',
      '-af', `volume=${appliedGainDb}dB`, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le', '-f', 'wav', outputWav], {signal});
    after = await analyzeAudio(outputWav, {signal});
    checkAbort(signal);
  } catch (error) {
    if (owned) await rm(outputWav, {force: true});
    if (error.code === 'EEXIST') throw Object.assign(new Error('Audio output already exists. Choose a new output path.'), {code: 'OUTPUT_EXISTS'});
    throw error;
  }
  checkAbort(signal);
  const targetReached = canNormalize && after.integratedLufs !== null
    ? Math.abs(after.integratedLufs - (settings.targetLufs + settings.outputGainDb)) <= .5 : null;
  const peakLimited = appliedGainDb < requestedGainDb - .001;
  progress(onProgress, 1, 'Complete audio master ready');
  return {enabled: settings.enabled, before, after, automaticGainDb, requestedGainDb, appliedGainDb,
    peakLimited, targetReached, headroomDb: settings.enabled ? headroomDb : 0,
    status: !settings.enabled ? 'disabled' : before.status !== 'measured' ? before.status : peakLimited ? 'peak_limited' : 'finished',
    limitations: ['Finishing uses one constant gain for the complete mix. It does not compress emphasis, remove noise or repair distorted source audio.',
      'Loudness targets can be unreachable because of peak protection or the maximum automatic boost.',
      'Overall outputGainDb is applied after calculating the loudness adjustment. Peak protection can limit a requested increase.',
      'The encoded output must be measured again because lossy audio encoding can change peaks.']};
}
