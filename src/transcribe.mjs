import {mkdir, readFile, writeFile, stat, rm, rename} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {resolve, join} from 'node:path';
import {homedir} from 'node:os';
import {run, fileFingerprint} from './media.mjs';

export function normalizeTranscript(document, assetId, {duration, tolerance = 0.15} = {}) {
  const input = Array.isArray(document) ? document : document.words || document.transcription;
  if (!Array.isArray(input)) throw new Error('Expected timestamped words, CutScript transcript, or whisper.cpp JSON');
  const words = [];
  const timingReviewWordIds = [];
  for (const item of input) {
    const text = String(item.text ?? item.word ?? '').trim();
    if (!text || /^\[(BLANK_AUDIO|SILENCE)\]$/.test(text)) continue;
    let start = item.offsets ? Number(item.offsets.from) / 1000 : Number(item.start);
    let end = item.offsets ? Number(item.offsets.to) / 1000 : Number(item.end);
    if (![start, end].every(Number.isFinite) || start < 0 || end < start || (words.length && start < words.at(-1).start)) {
      throw new Error('Invalid word timing. Native timings must be finite, ordered and nonnegative.');
    }
    const id = String(item.id ?? `w${words.length}`);
    if (duration !== undefined && end > duration) {
      if (end > duration + tolerance) throw new Error('Transcript extends beyond source media; inspect raw-whisper.json');
      // Native decoder timestamps can run a few milliseconds past the last
      // sample. Keep raw-whisper.json and constrain the edit to real media.
      start = Math.min(start, duration); end = duration; timingReviewWordIds.push(id);
    }
    if (start === end && !timingReviewWordIds.includes(id)) timingReviewWordIds.push(id);
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
  const transcriptPath = join(dir, 'transcript.json');
  try { const cached = JSON.parse(await readFile(transcriptPath, 'utf8')); return {transcript: {...cached, assetId: asset.id}, transcriptPath, cached: true}; }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  await mkdir(dir, {recursive: true});
  const wav = join(dir, 'audio.wav');
  onProgress(0.05, 'Extracting audio locally');
  await rm(wav, {force: true});
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-i', asset.path, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], {signal});
  try {
    onProgress(0.2, 'Transcribing with cached local whisper.cpp model');
    const result = await run('whisper-cli', ['--model', model, '--file', wav, '--language', language, '--max-len', '1', '--split-on-word', '--output-json-full', '--output-file', join(dir, 'raw-whisper'), '--no-prints'], {signal});
    await writeFile(join(dir, 'transcription.log'), result.stderr + result.stdout);
    const native = JSON.parse(await readFile(join(dir, 'raw-whisper.json'), 'utf8'));
    const transcript = normalizeTranscript(native, asset.id, {duration: asset.duration});
    transcript.language = language;
    if (transcript.words.some(word => word.end > asset.duration + 0.15)) throw new Error('Transcript extends beyond source media; inspect raw-whisper.json');
    const temporary = `${transcriptPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(transcript, null, 2) + '\n');
      await rename(temporary, transcriptPath);
    } finally { await rm(temporary, {force: true}); }
    onProgress(0.95, 'Transcript ready');
    return {transcript, transcriptPath, cached: false};
  } finally { await rm(wav, {force: true}); }
}
