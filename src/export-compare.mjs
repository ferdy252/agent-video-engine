import {realpath} from 'node:fs/promises';
import {fileFingerprint, run} from './media.mjs';
import {decodedBlocks, pictureFrames} from './encoded-review.mjs';

async function probe(path, signal) {
  const {stdout} = await run('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type,width,height,avg_frame_rate,r_frame_rate,start_time,duration,nb_frames,sample_rate,channels', '-of', 'json', path], {signal});
  const streams = JSON.parse(stdout).streams;
  const video = streams.find(s => s.codec_type === 'video');
  if (!video) throw new Error('An export comparison requires two encoded video files.');
  const rate = value => {const [n, d] = value.split('/').map(Number); return n / d;};
  const fps = rate(video.avg_frame_rate), nominalFps = rate(video.r_frame_rate), frames = Number(video.nb_frames);
  if (!(fps > 0 && Number.isFinite(fps)) || !Number.isFinite(nominalFps) || Math.abs(fps - nominalFps) > 1e-6 ||
      !Number.isSafeInteger(frames) || frames <= 0) throw new Error('Comparison requires constant-frame-rate exports with a known frame count.');
  const audio = streams.find(s => s.codec_type === 'audio');
  if (audio && (!(Number(audio.sample_rate) > 0) || !Number.isFinite(Number(audio.duration)) ||
      !Number.isInteger(audio.channels) || audio.channels < 1)) throw new Error('Audio timing or channel metadata is unavailable.');
  return {width: video.width, height: video.height, fps, frames, videoStart: Number(video.start_time ?? 0),
    audio: audio ? {channels: audio.channels, rate: Number(audio.sample_rate), start: Number(audio.start_time ?? 0),
      duration: Number(audio.duration)} : null};
}

function allowedIntervals(changes, track, rate) {
  const intervals = changes.filter(c => c.track === track || c.track === 'both')
    .map(c => [Math.ceil(c.startSeconds * rate - 1e-7), Math.ceil(c.endSeconds * rate - 1e-7)])
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of intervals) {
    if (merged.length && start <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(end, merged.at(-1)[1]);
    else merged.push([start, end]);
  }
  return merged;
}

function differences(rate) {
  const result = {comparedUnits: 0, totalRanges: 0, ranges: [], truncated: false};
  let last;
  return {result, record(start, end, changed) {
    result.comparedUnits += end - start;
    if (!changed) return;
    if (last?.end === start) {
      last.end = end;
      last.range.endSeconds = end / rate;
      return;
    }
    const range = {startSeconds: start / rate, endSeconds: end / rate};
    last = {end, range};
    result.totalRanges++;
    if (result.ranges.length < 100) result.ranges.push(range);
    else result.truncated = true;
  }};
}

async function* pairs(a, b) {
  try {
    while (true) {
      const [x, y] = await Promise.all([a.next(), b.next()]);
      if (x.done !== y.done || x.value?.length !== y.value?.length) throw new Error('Decoded lengths differ. The exports do not share one clock.');
      if (x.done) return;
      yield [x.value, y.value];
    }
  } finally {
    await Promise.allSettled([a.return(), b.return()]);
  }
}

// A small changed region (for example a caption) can disappear in a whole-frame average.
function changedPicture(a, b) {
  const tiles = new Uint32Array(6 * 7);
  let sum = 0;
  for (let y = 0, i = 0; y < 192; y++) {
    for (let x = 0; x < 108; x++, i += 3) {
      const delta = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      sum += delta;
      tiles[(y >> 5) * 7 + (x >> 4)] += delta;
    }
  }
  if (sum > 3 * a.length) return true;
  return tiles.some((v, i) => v > 12 * 3 * 32 * Math.min(16, 108 - (i % 7) * 16));
}

async function comparePicture(a, b, clock, changes, signal) {
  const finding = differences(clock.fps), allowed = allowedIntervals(changes, 'picture', clock.fps);
  let frame = 0, i = 0;
  for await (const [x, y] of pairs(pictureFrames(a, signal), pictureFrames(b, signal))) {
    while (i < allowed.length && frame >= allowed[i][1]) i++;
    if (i === allowed.length || frame < allowed[i][0]) finding.record(frame, frame + 1, changedPicture(x, y));
    frame++;
  }
  if (frame !== clock.frames) throw new Error('Incomplete picture comparison.');
  return finding.result;
}

function audioBlocks(path, audio, signal) {
  return decodedBlocks(['-i', path, '-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le', '-f', 's16le'],
    Math.max(1, Math.round(audio.rate * .02)) * audio.channels * 2, {signal, allowPartial: true});
}

function changedSound(a, b, start, end, channels) {
  const stride = channels * 2;
  const count = (end - start) / stride;
  for (let channel = 0; channel < channels; channel++) {
    let energy = 0, residual = 0;
    for (let j = start + channel * 2; j < end; j += stride) {
      const x = a.readInt16LE(j), y = b.readInt16LE(j);
      energy += Math.max(x * x, y * y);
      residual += (x - y) ** 2;
    }
    // The AAC tolerance is per channel so a loud left track cannot mask a change on the right.
    if (residual > Math.max(count * (32768 * .0025) ** 2, energy * .05 ** 2)) return true;
  }
  return false;
}

// MP4 can round the presentation duration of its last packet beyond the
// samples it actually contains. Only accept a short tail explained by that
// frame on each file, after both decoders completed and their lengths matched.
async function confirmsRoundedTail(path, audio, decodedSamples, declaredSamples, signal) {
  const seek = Math.max(0, audio.start + audio.duration - 1);
  const {stdout} = await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-read_intervals', `${seek}%`,
    '-show_frames', '-show_entries', 'frame=pts_time,duration_time,pkt_duration_time,nb_samples',
    '-of', 'compact=p=0:nk=0', path], {signal, maxOutput: 4096});
  const line = stdout.trim().split('\n').findLast(row => row.startsWith('pts_time='));
  if (!line) return false;
  const frame = Object.fromEntries(line.split('|').map(field => field.split('=')));
  const start = Math.round((Number(frame.pts_time) - audio.start) * audio.rate);
  const duration = Math.round(Number(frame.duration_time ?? frame.pkt_duration_time) * audio.rate);
  return start + Number(frame.nb_samples) === decodedSamples && start + duration === declaredSamples;
}

async function compareAudio(a, b, audio, changes, videoStart, signal) {
  const offset = audio.start - videoStart;
  const allowed = allowedIntervals(changes.map(c => ({...c, startSeconds: c.startSeconds - offset, endSeconds: c.endSeconds - offset})), 'audio', audio.rate);
  const finding = differences(audio.rate), stride = audio.channels * 2;
  const samples = Math.round(audio.duration * audio.rate);
  let pos = 0, i = 0;
  for await (const [x, y] of pairs(audioBlocks(a, audio, signal), audioBlocks(b, audio, signal))) {
    if (x.length % stride) throw new Error('Incomplete decoded audio sample.');
    const start = pos, end = Math.min(samples, start + x.length / stride);
    while (pos < end) {
      while (i < allowed.length && allowed[i][1] <= pos) i++;
      const interval = allowed[i], excluded = interval && interval[0] <= pos;
      const next = Math.min(end, interval ? interval[excluded ? 1 : 0] : end);
      if (!excluded) finding.record(pos, next, changedSound(x, y, (pos - start) * stride, (next - start) * stride, audio.channels));
      pos = next;
    }
  }
  if (pos !== samples) {
    const missing = samples - pos;
    if (!pos || missing >= audio.rate / 1000) throw new Error('Incomplete audio comparison.');
    const tails = await Promise.all([a, b].map(path => confirmsRoundedTail(path, audio, pos, samples, signal)));
    if (!tails.every(Boolean)) throw new Error('Incomplete audio comparison.');
    finding.result.containerTailRoundingSamples = missing;
  }
  for (const r of finding.result.ranges) {r.startSeconds += offset; r.endSeconds += offset;}
  return finding.result;
}

export async function compareExports({baselinePath, candidatePath, expectedChanges = [], signal, onProgress}) {
  const paths = await Promise.all([baselinePath, candidatePath].map(p => realpath(p)));
  const fingerprints = await Promise.all(paths.map(fileFingerprint));
  const [a, b] = await Promise.all(paths.map(p => probe(p, signal)));
  const reasons = [];
  if (a.width !== b.width || a.height !== b.height) reasons.push('Picture dimensions differ.');
  if (a.frames !== b.frames || Math.abs(a.fps - b.fps) > 1e-6 || a.videoStart !== b.videoStart) reasons.push('Picture clocks differ.');
  if (JSON.stringify(a.audio) !== JSON.stringify(b.audio)) reasons.push('Audio layout, start or duration differs.');
  const duration = a.frames / a.fps;
  if (expectedChanges.some(c => !['picture','audio','both'].includes(c.track) || !Number.isFinite(c.startSeconds) ||
      !Number.isFinite(c.endSeconds) || c.startSeconds < 0 || c.endSeconds <= c.startSeconds || c.endSeconds > duration + 1e-6)) {
    throw new Error('Expected changes must be positive time ranges within the baseline export.');
  }
  const result = {kind: 'export_comparison', baseline: {path: paths[0], fingerprint: fingerprints[0], ...a},
    candidate: {path: paths[1], fingerprint: fingerprints[1], ...b}, expectedChanges, reasons};
  if (reasons.length) result.status = 'incompatible';
  else {
    onProgress?.(.05, 'Comparing encoded picture');
    result.picture = await comparePicture(...paths, a, expectedChanges, signal);
    onProgress?.(.65, 'Comparing encoded sound');
    result.audio = a.audio ? await compareAudio(...paths, a.audio, expectedChanges, a.videoStart, signal) : null;
    if (result.picture.totalRanges || result.audio?.totalRanges) result.status = 'needs_review';
    else result.status = result.picture.comparedUnits || result.audio?.comparedUnits ? 'no_unexpected_changes' : 'nothing_to_compare';
  }
  signal?.throwIfAborted();
  const after = await Promise.all(paths.map(fileFingerprint));
  if (after.some((hash, i) => hash !== fingerprints[i])) throw new Error('An export changed during comparison.');
  return result;
}
