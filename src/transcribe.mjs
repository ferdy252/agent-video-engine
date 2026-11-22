import {mkdir, mkdtemp, readFile, writeFile, stat, rm, rename} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {resolve, join} from 'node:path';
import {homedir} from 'node:os';
import {run, fileFingerprint} from './media.mjs';

// A long single-word interval can include a pause or a retake. Preserve the
// evidence for review instead of guessing a shorter duration.
export function uncertainWordTiming(word) {
  return word.start === word.end || (!/\s/u.test(word.text.trim()) && word.end - word.start > 3);
}

function timingValue(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) return Number(value);
  return NaN;
}

function spokenOffsets(item, text, segmentStart, segmentEnd) {
  const visible = item.tokens.filter(token => typeof token?.text === 'string' && !/^\[_[^\]]+\]$/u.test(token.text));
  if (visible.map(token => token.text).join('').trim() !== text) return null;
  const spoken = visible.filter(token => /[^\p{P}\s]/u.test(token.text));
  if (!spoken.length) return null;
  let firstStart, previousEnd = segmentStart;
  for (const token of spoken) {
    const from = timingValue(token.offsets?.from), to = timingValue(token.offsets?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < previousEnd || to <= from || to > segmentEnd) return null;
    firstStart ??= from;
    previousEnd = to;
  }
  return {from: firstStart, to: previousEnd};
}

export function normalizeTranscript(document, assetId, {duration, tolerance = 0.15} = {}) {
  const input = Array.isArray(document) ? document : document.words || document.transcription;
  if (!Array.isArray(input)) throw new Error('Expected timestamped words, source-timed transcript, or whisper.cpp JSON');
  const words = [];
  const flagged = new Set(document.timingReviewWordIds ?? []);
  const timingReviewWordIds = [];
  for (const item of input) {
    const text = String(item.text ?? item.word ?? '').trim();
    if (!text || /^\[(BLANK_AUDIO|SILENCE)\]$/.test(text)) continue;
    const hasOffsets = item.offsets != null;
    const from = timingValue(hasOffsets ? item.offsets.from : item.start);
    const to = timingValue(hasOffsets ? item.offsets.to : item.end);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) {
      throw new Error('Invalid word timing. Native timings must be finite, ordered and nonnegative.');
    }
    const hasTokens = hasOffsets && Array.isArray(item.tokens);
    const measured = hasTokens ? spokenOffsets(item, text, from, to) : null;
    const unit = hasOffsets ? 1000 : 1;
    let start = (measured?.from ?? from) / unit;
    let end = (measured?.to ?? to) / unit;
    if (words.length && start < words.at(-1).start) throw new Error('Invalid word timing. Words must be in source order.');
    const id = String(item.id ?? `w${words.length}`);
    if (duration !== undefined && end > duration) {
      if (end > duration + tolerance) throw new Error('Transcript extends beyond source media; inspect raw-whisper.json');
      // Native decoder timestamps can run a few milliseconds past the last
      // sample. Keep raw-whisper.json and constrain the edit to real media.
      start = Math.min(start, duration); end = duration; flagged.add(id);
    }
    if (flagged.has(id) || (hasTokens && !measured) || uncertainWordTiming({text, start, end})) timingReviewWordIds.push(id);
    words.push({id, text, start, end,
      ...(Number.isFinite(item.confidence) ? {confidence: item.confidence} : {})});
  }
  return {assetId, language: document.language || 'en', words, ...(timingReviewWordIds.length ? {timingReviewWordIds} : {})};
}

export async function transcribeAsset(projectDir, asset, {modelPath, language = 'en', signal, onProgress = () => {}} = {}) {
  if (!asset.hasAudio && asset.type !== 'audio') throw new Error('Asset has no audio to transcribe');
  const model = resolve(modelPath || process.env.VIDEO_ENGINE_MODEL || join(homedir(), '.cache/whisper.cpp/ggml-small.en.bin'));
  const modelInfo = await stat(model); // A missing model is an actionable error, never a download.
  const key = createHash('sha256').update(JSON.stringify([await fileFingerprint(asset.path), model, modelInfo.size, modelInfo.mtimeMs, language, 1])).digest('hex');
  const dir = join(resolve(projectDir), '.engine/transcripts', key);
  const transcriptPath = join(dir, 'transcript-v3.json');
  try { const cached = JSON.parse(await readFile(transcriptPath, 'utf8')); return {transcript: {...cached, assetId: asset.id}, transcriptPath, cached: true}; }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  await mkdir(dir, {recursive: true});
  const rawPath = join(dir, 'raw-whisper.json');
  let work;
  let native;
  // Older normalized caches cannot distinguish missing timing from a real zero.
  // A completed cache establishes that the decoder finished writing raw evidence.
  for (const previous of ['transcript-v2.json', 'transcript.json']) {
    try {
      if (Array.isArray(JSON.parse(await readFile(join(dir, previous), 'utf8'))?.words)) {
        native = JSON.parse(await readFile(rawPath, 'utf8'));
        break;
      }
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  }
  const cached = Boolean(native);
  try {
    if (!native) {
      work = await mkdtemp(join(dir, '.decode-'));
      const wav = join(work, 'audio.wav');
      onProgress(0.05, 'Extracting audio locally');
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-i', asset.path, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], {signal});
      onProgress(0.2, 'Transcribing with cached local whisper.cpp model');
      const result = await run('whisper-cli', ['--model', model, '--file', wav, '--language', language, '--max-len', '1', '--split-on-word', '--output-json-full', '--output-file', join(work, 'raw-whisper'), '--no-prints'], {signal});
      const raw = join(work, 'raw-whisper.json');
      native = JSON.parse(await readFile(raw, 'utf8'));
      await writeFile(join(work, 'transcription.log'), result.stderr + result.stdout);
      await rename(join(work, 'transcription.log'), join(dir, 'transcription.log'));
      await rename(raw, rawPath);
    }
    const transcript = normalizeTranscript(native, asset.id, {duration: asset.duration});
    transcript.language = language;
    const temporary = `${transcriptPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(transcript, null, 2) + '\n');
      await rename(temporary, transcriptPath);
    } finally { await rm(temporary, {force: true}); }
    onProgress(0.95, 'Transcript ready');
    return {transcript, transcriptPath, cached};
  } finally { if (work) await rm(work, {recursive: true, force: true}); }
}
