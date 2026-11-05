import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mergeAudioSettings, resolveAudioSettings, validateClipAudio, volumeAt} from '../src/audio-settings.mjs';
import {mixAudioStems, needsStemMix} from '../src/audio-mixer.mjs';

const rate = 48000;
const real = {skip: process.env.AGENT_VIDEO_RENDER_SMOKE !== '1', timeout: 30000};

async function writeSignal(file, duration, signal, channels = 2) {
  const frames = Math.round(duration * rate);
  const frameBytes = channels * 4;
  const size = frames * frameBytes;
  const wav = Buffer.alloc(44 + size);
  wav.write('RIFF');
  wav.writeUInt32LE(size + 36, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(3, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * frameBytes, 28);
  wav.writeUInt16LE(frameBytes, 32);
  wav.writeUInt16LE(32, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(size, 40);
  for (let index = 0; index < frames; index++) {
    const sample = signal(index / rate);
    for (let channel = 0; channel < channels; channel++) {
      wav.writeFloatLE(sample, 44 + index * frameBytes + channel * 4);
    }
  }
  await writeFile(file, wav);
}

async function readSignal(file) {
  const wav = await readFile(file);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  for (let offset = 12; offset + 8 <= wav.length;) {
    const tag = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (tag === 'data') {
      const result = new Float32Array(size / 8);
      for (let index = 0; index < result.length; index++) result[index] = wav.readFloatLE(offset + 8 + index * 8);
      return result;
    }
    offset += 8 + size + size % 2;
  }
  throw new Error('Expected a stereo floating-point WAV data chunk.');
}

async function fixture(t, {voice, music, effects, duration = 4, durations = {}, channels = {}}) {
  const directory = await mkdtemp(join(tmpdir(), 'engine-audio-mixer-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const stems = Object.fromEntries(['voice', 'music', 'effects'].map((role) => [role, join(directory, `${role}.wav`)]));
  const signals = {voice, music, effects};
  await Promise.all(Object.entries(stems).map(([role, file]) =>
    writeSignal(file, durations[role] ?? duration, signals[role], channels[role])));
  return {directory, stems, duration};
}

const tone = (frequency, time) => Math.sin(2 * Math.PI * frequency * time);
function toneAmplitude(samples, frequency, start, end) {
  const first = Math.round(start * rate), last = Math.round(end * rate);
  let sine = 0, cosine = 0;
  for (let index = first; index < last; index++) {
    const phase = 2 * Math.PI * frequency * index / rate;
    sine += samples[index] * Math.sin(phase);
    cosine += samples[index] * Math.cos(phase);
  }
  return 2 * Math.hypot(sine, cosine) / (last - first);
}
function rms(samples, start, end) {
  const part = samples.subarray(Math.round(start * rate), Math.round(end * rate));
  return Math.sqrt(part.reduce((sum, sample) => sum + sample * sample, 0) / part.length);
}

test('effect patches preserve independent settings and validate finite bounded controls', () => {
  const initial = resolveAudioSettings({ducking: {enabled: true, release: 0.6}});
  const adjusted = mergeAudioSettings(initial, {ducking: {amountDb: 12}, denoise: {enabled: true}});
  assert.equal(adjusted.enabled, false);
  assert.deepEqual(adjusted.ducking, {...initial.ducking, amountDb: 12});
  assert.equal(initial.ducking.amountDb, 10);
  assert.equal(needsStemMix(adjusted), true);
  assert.equal(needsStemMix({effectsGainDb: -4}), true);
  assert.equal(needsStemMix({ducking: {enabled: true, amountDb: 0}, denoise: {enabled: true, amount: 0}}), false);
  for (const settings of [{musicGainDb: 30}, {ducking: {attack: 0}}, {ducking: {thresholdDb: -75}},
    {denoise: {amount: NaN}}, {denoise: {mode: 'automatic'}}]) {
    assert.throws(() => resolveAudioSettings(settings), {code: 'VALIDATION_ERROR'});
  }
});

test('linear volume points, fades and mute use sequence-relative time', () => {
  const audio = {assetId: 'alternate', sourceStart: 1, sourceEnd: 2, offset: -0.2, role: 'music',
    fadeIn: 0.5, fadeOut: 0.5, envelope: [{time: 0, value: 0.5}, {time: 1, value: 1.5}]};
  assert.equal(validateClipAudio(audio), true);
  assert.equal(volumeAt(audio, 0, 2, 2), 0);
  assert.equal(volumeAt(audio, 0.25, 2, 2), 0.75);
  assert.equal(volumeAt(audio, 0.75, 2, 2), 2.5);
  assert.equal(volumeAt(audio, 1.75, 2, 2), 1.5);
  assert.equal(volumeAt(audio, 2, 2, 2), 0);
  assert.equal(volumeAt({...audio, muted: true}, 1, 2, 2), 0);
  assert.equal(volumeAt({...audio, curveOffset: -0.2}, 0.1, 2, 2), 0);
  const sliced = {...audio, curveOffset: 0.6, curveDuration: 2};
  assert.equal(volumeAt(sliced, 0.2, 1, 2), volumeAt(audio, 0.8, 2, 2));
  assert.equal(volumeAt(sliced, 0.9, 1, 2), volumeAt(audio, 1.5, 2, 2));
  for (const invalid of [{role: 'background'}, {fadeOut: -1}, {sourceStart: 2, sourceEnd: 1},
    {curveDuration: 0}, {curveOffset: Infinity}, {envelope: [{time: 0, value: 1}, {time: 0, value: 0}]}, {envelope: [{time: 1, value: 9}]}]) {
    assert.throws(() => validateClipAudio(invalid), {code: 'VALIDATION_ERROR'});
  }
});

test('a rendered voice signal lowers only music, then releases it at the saved mix clock', real, async (t) => {
  const {directory, stems, duration} = await fixture(t, {
    voice: (time) => time >= 1 && time < 3 ? 0.25 * tone(220, time) : 0,
    music: (time) => 0.08 * tone(660, time), effects: (time) => 0.03 * tone(990, time),
  });
  const original = await readFile(stems.voice);
  const output = join(directory, 'ducked.wav');
  const report = await mixAudioStems(stems, output, {ducking: {enabled: true, amountDb: 10, thresholdDb: -32,
    attack: 0.04, release: 0.2}});
  assert.equal(report.ducking.sidechain, 'voice');
  assert.equal(report.ducking.maximumReductionDb, 10);
  assert.equal(report.ducking.processedMusicSamples, duration * rate);
  assert.equal(report.codec, 'pcm_f32le');
  const samples = await readSignal(output);
  assert.equal(samples.length, duration * rate);
  const baseline = toneAmplitude(samples, 660, 0.3, 0.6);
  const ducked = toneAmplitude(samples, 660, 1.5, 1.8);
  const recovered = toneAmplitude(samples, 660, 3.6, 3.9);
  assert.ok(Math.abs(baseline - 0.08) < 0.001, `Music before voice = ${baseline}`);
  assert.ok(ducked / baseline < 0.55 && ducked / baseline >= 10 ** (-10 / 20) - 0.02, `Ducked music ratio = ${ducked / baseline}`);
  assert.ok(Math.abs(recovered - baseline) < 0.002, `Music after release = ${recovered}`);
  assert.ok(Math.abs(toneAmplitude(samples, 990, 1.5, 1.8) - 0.03) < 0.001);
  assert.ok(Math.abs(toneAmplitude(samples, 220, 1.5, 1.8) - 0.25) < 0.001);
  assert.deepEqual(await readFile(stems.voice), original);
  await assert.rejects(mixAudioStems(stems, output, {}), {code: 'OUTPUT_EXISTS'});
});

test('ducking retains every music tail across 16 stem lengths and mono/stereo buffer layouts', real, async (t) => {
  const sampleOffsets = [0, 1, 37, 511, 1023, 1024, 2047, 3577];
  for (let batch = 0; batch < 4; batch++) {
    await Promise.all(Array.from({length: 4}, async (_, offset) => {
      const index = batch * 4 + offset;
      const musicSamples = 3 * rate + sampleOffsets[index % sampleOffsets.length];
      const voiceSamples = index % 2 === 0 ? musicSamples : 2 * rate + 113 + index;
      const effectsSamples = musicSamples + (index % 3 === 0 ? 211 : -251);
      const musicDuration = musicSamples / rate;
      const {directory, stems} = await fixture(t, {
        voice: (time) => time >= 0.75 && time < 1.85 ? 0.25 * tone(220, time) : 0,
        music: (time) => 0.08 * tone(660, time), effects: (time) => 0.03 * tone(990, time),
        durations: {voice: voiceSamples / rate, music: musicDuration, effects: effectsSamples / rate},
        channels: {voice: index % 4 < 2 ? 1 : 2, music: index % 4 % 2 + 1, effects: index % 3 === 0 ? 1 : 2},
      });
      const output = join(directory, 'mix.wav');
      const report = await mixAudioStems(stems, output, {
        ducking: {enabled: true, amountDb: 10, thresholdDb: -32, attack: 0.04, release: 0.2},
        denoise: {enabled: index % 3 === 0, amount: 0.35},
      });
      const samples = await readSignal(output);
      assert.equal(report.ducking.processedMusicSamples, musicSamples, `Case ${index} retains all music samples`);
      assert.equal(samples.length, Math.max(voiceSamples, musicSamples, effectsSamples), `Case ${index} retains the full mix clock`);
      const baseline = toneAmplitude(samples, 660, 0.2, 0.3);
      const active = toneAmplitude(samples, 660, 1.3, 1.4);
      const tail = toneAmplitude(samples, 660, musicDuration - 0.1, musicDuration);
      assert.ok(active < baseline * 0.6, `Case ${index} ducks the music during voice`);
      assert.ok(Math.abs(tail - baseline) < 0.002, `Case ${index} music tail = ${tail}, baseline = ${baseline}`);
    }));
  }
});

test('voice denoise reduces a synthetic noise floor while preserving the full clock and effects bus', real, async (t) => {
  let seed = 42;
  const {directory, stems, duration} = await fixture(t, {
    voice: (time) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const noise = (seed / 2 ** 32 - 0.5) * 0.004;
      return noise + (time >= 1 && time < 3 ? 0.18 * tone(220, time) : 0);
    },
    music: () => 0, effects: (time) => time >= 1 && time < 3 ? 0.04 * tone(990, time) : 0,
  });
  const output = join(directory, 'denoised.wav');
  const report = await mixAudioStems(stems, output, {denoise: {enabled: true, amount: 0.75}});
  assert.equal(report.denoise.role, 'voice');
  assert.equal(report.denoise.noiseReductionDb, 18);
  const cleaned = await readSignal(output), original = await readSignal(stems.voice);
  assert.equal(cleaned.length, duration * rate);
  const onset = (samples) => samples.findIndex((sample) => Math.abs(sample) > 0.1);
  assert.ok(Math.abs(onset(cleaned) - onset(original)) < 0.004 * rate, 'Denoise stays aligned with the source onset');
  assert.ok(rms(cleaned, 0.4, 0.8) < rms(original, 0.4, 0.8) * 0.65, 'Measured quiet voice noise falls after FFT filtering');
  assert.ok(toneAmplitude(cleaned, 220, 1.5, 1.8) > 0.15, 'Strong voice signal survives the denoise pass');
  assert.ok(Math.abs(toneAmplitude(cleaned, 990, 1.5, 1.8) - 0.04) < 0.001, 'Effects bypass voice denoise');
});
