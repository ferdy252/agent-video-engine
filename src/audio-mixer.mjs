import {link, mkdtemp, rm} from 'node:fs/promises';
import {dirname, isAbsolute, join} from 'node:path';
import {resolveAudioSettings} from './audio-settings.mjs';
import {run} from './media.mjs';

const sampleRate = 48000;
const format = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS';
// The 48 kHz FFT denoiser delays its signal by 25 ms. Keep the voice bus
// aligned with picture and the other buses by trimming that look-ahead.
const denoiseLatencySamples = 1200;
const duckingBlockSamples = 1024;
const amplitude = (db) => 10 ** (db / 20);
const activeDenoise = (settings) => settings.denoise.enabled && settings.denoise.amount > 0;
const activeDucking = (settings) => settings.ducking.enabled && settings.ducking.amountDb > 0;

export function needsStemMix(settings) {
  const resolved = resolveAudioSettings(settings);
  return activeDenoise(resolved) || activeDucking(resolved) || resolved.effectsGainDb !== 0;
}

function roleFormat(gainDb) {
  return gainDb === 0 ? format : `${format},volume=${gainDb}dB`;
}

function reportProgress(observer, progress, stage) {
  try {observer?.({progress, stage});} catch {}
}

async function stemSamples(file, signal) {
  const {stdout} = await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=duration_ts,time_base', '-of', 'json', file], {signal});
  const stream = JSON.parse(stdout).streams?.[0];
  const [numerator, denominator] = (stream?.time_base ?? '').split('/').map(Number);
  const samples = Math.round(Number(stream?.duration_ts) * numerator / denominator * sampleRate);
  if (!Number.isSafeInteger(samples) || samples <= 0) {
    throw Object.assign(new Error('The audio stem needs a measurable sample length.'), {code: 'INVALID_AUDIO_STEM'});
  }
  return samples;
}

async function renderFloatAudio(inputs, filters, output, signal) {
  signal?.throwIfAborted();
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-filter_complex_threads', '1',
    ...inputs.flatMap((file) => ['-i', file]), '-filter_complex', filters.join(';'), '-map', '[output]',
    '-ar', String(sampleRate), '-ac', '2', '-c:a', 'pcm_f32le', '-f', 'wav', output], {signal});
}

async function duckMusic(music, voice, voiceFilter, settings, output, signal) {
  const musicSamples = await stemSamples(music, signal);
  const {amountDb, thresholdDb, attack, release} = settings.ducking;
  const wet = 1 - amplitude(-amountDb);
  const compressor = `sidechaincompress=threshold=${amplitude(thresholdDb)}:ratio=20:attack=${attack * 1000}` +
    `:release=${release * 1000}:knee=1:link=maximum:detection=rms:mix=${wet}`;

  // The compressor can stop at either input's EOF. Give its control stream a
  // full extra block and match frame sizes, including a partial music tail.
  const musicFilter = `${roleFormat(settings.musicGainDb)},asetnsamples=n=${duckingBlockSamples}:p=0`;
  const controlFilter = `${voiceFilter},apad=whole_len=${musicSamples + duckingBlockSamples}` +
    `,asetnsamples=n=${duckingBlockSamples}:p=1`;
  await renderFloatAudio([music, voice], [
    `[0:a:0]${musicFilter}[music]`,
    `[1:a:0]${controlFilter}[control]`,
    `[music][control]${compressor}[output]`,
  ], output, signal);
  const outputSamples = await stemSamples(output, signal);
  if (outputSamples !== musicSamples) {
    throw Object.assign(new Error(`The music stem expected ${musicSamples} samples after ducking and received ${outputSamples}.`),
      {code: 'AUDIO_DUCKING_LENGTH_MISMATCH'});
  }
  return outputSamples;
}

/** Mix full-length role stems, preserving floating-point headroom for the master. */
export async function mixAudioStems({voice, music, effects}, outputWav, suppliedSettings, {signal, onProgress} = {}) {
  signal?.throwIfAborted();
  for (const path of [voice, music, effects, outputWav]) {
    if (typeof path !== 'string' || !isAbsolute(path)) {
      throw Object.assign(new Error('Audio stems and output require absolute local paths.'), {code: 'VALIDATION_ERROR'});
    }
  }
  const settings = resolveAudioSettings(suppliedSettings);
  const denoise = activeDenoise(settings);
  const ducking = activeDucking(settings);
  const noiseReductionDb = denoise ? Math.max(0.01, settings.denoise.amount * 24) : 0;
  let voiceFilter = roleFormat(settings.voiceGainDb);
  if (denoise) {
    const samples = await stemSamples(voice, signal);
    voiceFilter += `,apad=pad_len=${denoiseLatencySamples * 2},afftdn=nr=${noiseReductionDb}:nf=-45:tn=1:gs=5` +
      `,atrim=start_sample=${denoiseLatencySamples}:end_sample=${denoiseLatencySamples + samples},asetpts=PTS-STARTPTS`;
  }
  const scratch = await mkdtemp(join(dirname(outputWav), '.audio-mix-'));
  const temporary = join(scratch, 'master.wav');
  let processedMusicSamples = 0;
  try {
    reportProgress(onProgress, 0, 'Mixing voice, music and effects');
    let voiceInput = voice;
    if (denoise && ducking) {
      voiceInput = join(scratch, 'voice-clean.wav');
      await renderFloatAudio([voice], [`[0:a:0]${voiceFilter}[output]`], voiceInput, signal);
      voiceFilter = format;
    }
    let musicInput = music;
    let musicFilter = roleFormat(settings.musicGainDb);
    if (ducking) {
      // Finish and check ducking before summing. Otherwise amix can mask an
      // early music EOF by continuing to output the other two stems.
      musicInput = join(scratch, 'music-ducked.wav');
      processedMusicSamples = await duckMusic(music, voiceInput, voiceFilter, settings, musicInput, signal);
      musicFilter = format;
    }
    await renderFloatAudio([voiceInput, musicInput, effects], [
      `[0:a:0]${voiceFilter}[voice]`,
      `[1:a:0]${musicFilter}[music]`,
      `[2:a:0]${roleFormat(settings.effectsGainDb)}[effects]`,
      '[voice][music][effects]amix=inputs=3:duration=longest:dropout_transition=0:normalize=0[output]',
    ], temporary, signal);
    signal?.throwIfAborted();
    await link(temporary, outputWav);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw Object.assign(new Error('Audio output already exists. Choose a new output path.'), {code: 'OUTPUT_EXISTS'});
    }
    throw error;
  } finally {
    await rm(scratch, {recursive: true, force: true});
  }
  reportProgress(onProgress, 1, 'Complete audio mix ready');
  return {
    outputPath: outputWav,
    sampleRate,
    channels: 2,
    codec: 'pcm_f32le',
    roleGainsDb: {voice: settings.voiceGainDb, music: settings.musicGainDb, effects: settings.effectsGainDb},
    denoise: {enabled: denoise, role: 'voice', amount: settings.denoise.amount, noiseReductionDb,
      latencyCompensationSamples: denoise ? denoiseLatencySamples : 0},
    ducking: {enabled: ducking, sidechain: 'voice', target: 'music',
      maximumReductionDb: ducking ? settings.ducking.amountDb : 0,
      processedMusicSamples,
      thresholdDb: settings.ducking.thresholdDb, attack: settings.ducking.attack, release: settings.ducking.release},
  };
}
