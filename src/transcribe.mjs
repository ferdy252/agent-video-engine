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

function spokenOffsets(item, text) {
  const visible = item.tokens.filter(token => typeof token?.text === 'string' && !/^\[_[^\]]+\]$/u.test(token.text));
  if (visible.map(token => token.text).join('').trim() !== text) return null;
  const spoken = visible.filter(token => /[^\p{P}\s]/u.test(token.text));
  if (!spoken.length) return null;
  let previousEnd = item.offsets.from;
  for (const token of spoken) {
    const {from, to} = token.offsets ?? {};
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < previousEnd || to <= from || to > item.offsets.to) return null;
    previousEnd = to;
  }
  return {from: spoken[0].offsets.from, to: previousEnd};
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
    const hasTokens = item.offsets && Array.isArray(item.tokens);
    const measured = hasTokens ? spokenOffsets(item, text) : null;
    const offsets = measured ?? item.offsets;
    let start = offsets ? Number(offsets.from) / 1000 : Number(item.start);
    let end = offsets ? Number(offsets.to) / 1000 : Number(item.end);
    if (![start, end].every(Number.isFinite) || start < 0 || end < start || (words.length && start < words.at(-1).start)) {
      throw new Error('Invalid word timing. Native timings must be finite, ordered and nonnegative.');
    }
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
  const model = resolve(modelPath || process.env.VIDEO_ENGINE_MODEL || join(homedir(), '.cache/whisper.cpp/ggml-medium.en.bin'));
  const modelInfo = await stat(model); // A missing model is an actionable error, never a download.
  const key = createHash('sha256').update(JSON.stringify([await fileFingerprint(asset.path), model, modelInfo.size, modelInfo.mtimeMs, language, 1])).digest('hex');
  const dir = join(resolve(projectDir), '.engine/transcripts', key);
  const transcriptPath = join(dir, 'transcript-v2.json');
  try { const cached = JSON.parse(await readFile(transcriptPath, 'utf8')); return {transcript: {...cached, assetId: asset.id}, transcriptPath, cached: true}; }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  await mkdir(dir, {recursive: true});
  const rawPath = join(dir, 'raw-whisper.json');
  let work;
  let native;
  try {
    // A completed v1 cache establishes that the decoder finished writing raw evidence.
    if (Array.isArray(JSON.parse(await readFile(join(dir, 'transcript.json'), 'utf8')).words)) {
      native = JSON.parse(await readFile(rawPath, 'utf8'));
    }
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
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
