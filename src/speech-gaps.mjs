import {run} from './media.mjs';
import {compileTimeline} from './timeline.mjs';

const round = value => Math.round(value * 1000) / 1000;
const union = intervals => {
  const result = [];
  for (const span of intervals.filter(x => x.end > x.start).sort((a, b) => a.start - b.start)) {
    const last = result.at(-1);
    if (last && span.start <= last.end + 1e-7) last.end = Math.max(last.end, span.end);
    else result.push({...span});
  }
  return result;
};
function subtract(regions, covered) {
  const result = [];
  const merged = union(covered);
  for (const region of union(regions)) {
    let cursor = region.start;
    for (const span of merged) {
      if (span.end <= cursor) continue;
      if (span.start >= region.end) break;
      if (span.start > cursor) result.push({start: cursor, end: Math.min(span.start, region.end)});
      cursor = Math.max(cursor, span.end);
    }
    if (cursor < region.end) result.push({start: cursor, end: region.end});
  }
  return result;
}

/** Source word intervals are evidence independent of music in the encoded mix. */
export function transcriptSpeechCoverage(project, timeline, {start = 0, duration}) {
  const known = [], unknown = [], words = [];
  const assets = new Map(project.assets.map(asset => [asset.id, asset]));
  const transcripts = new Map(project.transcripts.map(entry => [entry.assetId, entry.words]));
  const tracks = [...timeline.clips.filter(clip => clip.type !== 'gap').map(clip => ({
    assetId: clip.audioAssetId, from: clip.audioFrom / timeline.fps,
    duration: clip.audioDurationInFrames / timeline.fps, source: clip.audioSourceFrame / timeline.fps,
    rate: clip.playbackRate ?? 1, volume: clip.volume ?? 1, audio: clip.audio, defaultRole: 'voice',
  })), ...timeline.overlays.filter(overlay => ['audio', 'video'].includes(overlay.type)).map(overlay => ({
    assetId: overlay.assetId, from: overlay.from / timeline.fps, duration: overlay.durationInFrames / timeline.fps,
    source: Math.round((overlay.sourceStart ?? 0) * timeline.fps) / timeline.fps,
    rate: 1, volume: overlay.volume ?? 1, audio: overlay.audio, defaultRole: 'effects',
  }))];
  let voiceTrackCount = 0, unassessedTrackCount = 0;
  for (const track of tracks) {
    const asset = assets.get(track.assetId), audio = track.audio ?? {};
    if (!asset || asset.type === 'image' || asset.hasAudio === false || audio.muted || track.volume === 0 ||
      (audio.role ?? track.defaultRole) !== 'voice') continue;
    const region = {start: Math.max(0, track.from - start), end: Math.min(duration, track.from + track.duration - start)};
    if (region.end <= region.start) continue;
    voiceTrackCount++;
    const sourceWords = transcripts.get(track.assetId);
    // Point timestamps do not establish speech duration or silence around a word.
    if (!sourceWords?.length || sourceWords.some(word => word.end <= word.start)) {
      unknown.push(region); unassessedTrackCount++; continue;
    }
    known.push(region);
    for (const word of sourceWords) {
      const from = track.from + (word.start - track.source) / track.rate - start;
      const to = track.from + (word.end - track.source) / track.rate - start;
      const span = {start: Math.max(region.start, from), end: Math.min(region.end, to)};
      if (span.end > span.start) words.push(span);
    }
  }
  const assessed = subtract(known, unknown);
  return {voiceTrackCount, unassessedTrackCount,
    assessedSeconds: round(assessed.reduce((sum, x) => sum + x.end - x.start, 0)),
    words: union(words), gaps: subtract(assessed, words)};
}

/** Decode ALL encoded audio. This flags possible gaps, not semantic speech recognition. */
export async function scanSpeechGaps(filePath, {project, timeline = compileTimeline(project),
  duration, hasAudio = true, startSeconds = 0, minGapSeconds = .8, noiseDb = -40, signal} = {}) {
  if (!Number.isFinite(minGapSeconds) || minGapSeconds < .2 || minGapSeconds > 30) throw new Error('minGapSeconds must be between .2 and 30');
  if (!Number.isFinite(noiseDb) || noiseDb < -80 || noiseDb > -15) throw new Error('noiseDb must be between -80 and -15');
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Speech scan needs the encoded duration');
  signal?.throwIfAborted();
  const standalone = project.custom && project.custom.mode !== 'layer';
  const coverage = standalone ? {voiceTrackCount: 0, unassessedTrackCount: 0, assessedSeconds: 0, words: [], gaps: []}
    : transcriptSpeechCoverage(project, timeline, {start: startSeconds, duration});
  const findings = [];
  let totalFindings = 0;
  const add = (code, start, end) => {
    start = Math.max(0, start); end = Math.min(duration, end);
    if (end - start < minGapSeconds - .005) return;
    totalFindings++;
    // Keep long exports bounded but never stop decoding or counting findings.
    if (findings.length < 1000) findings.push({code, startSeconds: round(start), endSeconds: round(end),
      durationSeconds: round(end - start), timelineStartSeconds: round(start + startSeconds),
      timelineEndSeconds: round(end + startSeconds),
      reviewStartSeconds: round(Math.max(0, start - .5)), reviewEndSeconds: round(Math.min(duration, end + .5))});
  };
  let pending = '', quietStart = null, decodedEnd = 0;
  const line = text => {
    const begin = text.match(/silence_start:\s*(-?[\d.e+]+)/);
    if (begin) quietStart = Number(begin[1]);
    const end = text.match(/silence_end:\s*(-?[\d.e+]+)/);
    if (end && quietStart !== null) {add('QUIET_AUDIO_GAP', quietStart, Number(end[1])); quietStart = null;}
  };
  if (hasAudio) {
    const {stdout} = await run('ffmpeg', ['-hide_banner', '-nostats', '-loglevel', 'info', '-xerror', '-i', filePath,
      '-map', '0:a:0', '-vn', '-af', `silencedetect=noise=${noiseDb}dB:d=${minGapSeconds}`,
      '-progress', 'pipe:1', '-f', 'null', '-'], {signal, maxOutput: 16000,
      onData: (chunk, stream) => {
        if (stream !== 'stderr') return;
        pending += chunk;
        const lines = pending.split(/\r?\n/); pending = lines.pop();
        for (const item of lines) line(item);
      }});
    line(pending);
    for (const match of stdout.matchAll(/out_time_us=(\d+)/g)) decodedEnd = Math.max(decodedEnd, Number(match[1]) / 1e6);
    if (!stdout.includes('progress=end') || decodedEnd <= 0) throw new Error('The full-export audio scan did not complete');
    if (quietStart !== null) add('QUIET_AUDIO_GAP', quietStart, Math.min(duration, decodedEnd));
    if (duration - decodedEnd >= minGapSeconds) add('AUDIO_ENDS_EARLY', decodedEnd, duration);
  } else add('MISSING_AUDIO', 0, duration);
  for (const gap of coverage.gaps) add('TRANSCRIPT_SPEECH_GAP', gap.start, gap.end);
  findings.sort((a, b) => a.startSeconds - b.startSeconds || a.code.localeCompare(b.code));
  signal?.throwIfAborted();
  return {version: 1, status: hasAudio ? 'completed' : 'missing_audio', scope: 'entire_encoded_file',
    method: 'decoded_audio_silence_and_source_word_intervals', durationSeconds: duration,
    decodedAudioSeconds: round(decodedEnd), minGapSeconds, noiseDb,
    transcriptCoverage: {voiceTrackCount: coverage.voiceTrackCount, unassessedTrackCount: coverage.unassessedTrackCount,
      assessedSeconds: coverage.assessedSeconds, customAudioUnassessed: Boolean(project.custom)},
    totalFindings, findings, truncated: totalFindings > findings.length,
    limitations: ['Quiet audio and gaps in source word timings are review cues, not proof of an editing error. Pauses can be intentional.',
      'Music, effects or noise can mask missing speech in the mixed track. Transcript evidence helps only where measured source word intervals are available.',
      'This does not transcribe the finished file or prove that expected speech is audible. Custom audio and inaccurate transcripts need direct listening.',
      'Review the flagged ranges in the actual encoded file before sharing. Fix unwanted gaps and export again; do not automatically cut every pause.']};
}
