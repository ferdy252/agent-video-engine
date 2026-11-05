import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {createProject} from '../src/project.mjs';
import {renderProject} from '../src/render.mjs';
import {fileFingerprint, probeAsset, run, toolEnv} from '../src/media.mjs';

const exec = promisify(execFile);
const sampleRate = 48000;
const real = {skip: process.env.AGENT_VIDEO_RENDER_SMOKE !== '1', timeout: 150000};

async function writeSignal(file, expression) {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi', '-i',
    `aevalsrc=${expression}|${expression}:s=${sampleRate}:d=4`, '-c:a', 'pcm_f32le', file]);
}

async function samples(file, filter) {
  const {stdout} = await exec('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0',
    ...(filter ? ['-af', filter] : []), '-ar', String(sampleRate), '-ac', '2', '-f', 'f32le', '-'],
  {encoding: 'buffer', env: toolEnv, maxBuffer: 8 * 1024 * 1024});
  const result = new Float32Array(Math.floor(stdout.length / 8));
  for (let index = 0; index < result.length; index++) result[index] = stdout.readFloatLE(index * 8);
  return result;
}

function toneMagnitude(signal, frequency, start, end) {
  const first = Math.round(start * sampleRate), last = Math.round(end * sampleRate);
  assert.ok(last <= signal.length, 'The decoded audio covers the requested measurement window');
  let realPart = 0, imaginaryPart = 0;
  for (let index = first; index < last; index++) {
    const phase = 2 * Math.PI * frequency * index / sampleRate;
    realPart += signal[index] * Math.cos(phase);
    imaginaryPart += signal[index] * Math.sin(phase);
  }
  return 2 * Math.hypot(realPart, imaginaryPart) / (last - first);
}

function rms(signal, start, end) {
  const values = signal.subarray(Math.round(start * sampleRate), Math.round(end * sampleRate));
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
}

test('rendered stems duck music from voice, preserve custom effects and share the master with previews', real, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-mixer-render-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const definitions = [
    ['voice', 'if(between(t\\,1\\,3)\\,0.25*sin(2*PI*220*t)\\,0)+0.003*(2*random(5)-1)'],
    ['music', '0.08*sin(2*PI*660*t)'],
    ['effect', '0.03*sin(2*PI*990*t)'],
    ['custom-effect', '0.05*sin(2*PI*1110*t)'],
  ];
  const assets = await Promise.all(definitions.map(async ([id, expression]) => {
    const file = join(directory, `${id}.wav`);
    await writeSignal(file, expression);
    return probeAsset(file, id);
  }));
  const layer = join(directory, 'custom-audio.tsx');
  await writeFile(layer, `import React from 'react';
import {Audio} from 'remotion';
export default function SoundLayer({timeline}) {
  const source = timeline.assets.find(asset => asset.id === 'custom-effect');
  return <Audio src={source.src} volume={0.8}/>;
}
`);
  const project = await createProject(join(directory, 'project'), {
    name: 'Synthetic audio mix', settings: {width: 160, height: 90, fps: 20}, assets,
    clips: [{id: 'voice-clip', assetId: 'voice', sourceStart: 0, sourceEnd: 4}],
    overlays: [
      {id: 'music-track', type: 'audio', assetId: 'music', start: 0, end: 4,
        audio: {role: 'music', fadeIn: 0.5, fadeOut: 0.15, envelope: [{time: 0, value: 0.5}, {time: 0.75, value: 1}]}},
      {id: 'sound-effect', type: 'audio', assetId: 'effect', start: 0, end: 4},
    ],
    audio: {voiceGainDb: -3, musicGainDb: -6, effectsGainDb: -6},
    custom: {mode: 'layer', entryPoint: layer},
  });
  const reference = await renderProject(project, {outputPath: join(directory, 'reference.mp4')});
  assert.equal(reference.audio.scope, 'full_timeline_mix');
  assert.equal(reference.audio.enabled, false);
  assert.equal(reference.audio.mix.ducking.enabled, false);
  assert.equal(reference.audio.mix.denoise.enabled, false);
  const original = await samples(reference.outputPath);
  const originalMusic = toneMagnitude(original, 660, 1.5, 1.8);
  const originalCustom = toneMagnitude(original, 1110, 1.5, 1.8);
  assert.ok(Math.abs(originalMusic - 0.08 * 10 ** (-6 / 20)) < 0.004, `Rendered music fader = ${originalMusic}`);
  assert.ok(Math.abs(originalCustom - 0.05 * 0.8 * 10 ** (-6 / 20)) < 0.003, `Custom effects fader = ${originalCustom}`);
  assert.ok(toneMagnitude(original, 660, 0.1, 0.3) < originalMusic * 0.45, 'The rendered fade and ramp attenuate the music opening');

  const processed = structuredClone(project);
  processed.audio.ducking = {enabled: true, amountDb: 10, attack: 0.04, release: 0.2, thresholdDb: -32};
  processed.audio.denoise = {enabled: true, amount: 0.75};
  const mixed = await renderProject(processed, {outputPath: join(directory, 'processed.mp4')});
  const signal = await samples(mixed.outputPath);
  assert.equal(mixed.durationInFrames, 80);
  assert.equal(mixed.audio.mix.denoise.enabled, true);
  assert.equal(mixed.audio.mix.ducking.enabled, true);
  assert.equal(Object.hasOwn(mixed.audio.mix, 'outputPath'), false);
  const duckedMusic = toneMagnitude(signal, 660, 1.5, 1.8);
  assert.ok(duckedMusic < originalMusic * 0.6 && duckedMusic > originalMusic * 0.28, `Rendered duck ratio = ${duckedMusic / originalMusic}`);
  assert.ok(Math.abs(toneMagnitude(signal, 660, 3.5, 3.8) - originalMusic) < 0.004, 'Music returns after voice releases');
  for (const frequency of [220, 990, 1110]) {
    const before = toneMagnitude(original, frequency, 1.5, 1.8);
    const after = toneMagnitude(signal, frequency, 1.5, 1.8);
    assert.ok(Math.abs(before - after) < 0.006, `Voice or effects tone ${frequency} remains at its own level`);
  }
  // Reject the four low-frequency test tones strongly enough to isolate the
  // broadband voice noise in the encoded result.
  const highBand = 'highpass=f=4000,highpass=f=4000,highpass=f=4000,lowpass=f=12000';
  const [beforeNoise, afterNoise] = await Promise.all([samples(reference.outputPath, highBand), samples(mixed.outputPath, highBand)]);
  const beforeFloor = rms(beforeNoise, 3.55, 3.8), afterFloor = rms(afterNoise, 3.55, 3.8);
  assert.ok(afterFloor < beforeFloor * 0.8, `Encoded voice-bus noise falls from ${beforeFloor} to ${afterFloor}`);

  const preview = await renderProject(processed, {kind: 'preview', fromFrame: 24, toFrame: 55,
    outputPath: join(directory, 'preview.mp4')});
  assert.deepEqual(preview.frameRange, [24, 55]);
  const previewSignal = await samples(preview.outputPath);
  for (const frequency of [220, 660, 990, 1110]) {
    const part = toneMagnitude(previewSignal, frequency, 0.3, 0.6);
    const master = toneMagnitude(signal, frequency, 1.5, 1.8);
    assert.ok(Math.abs(part - master) < 0.004, `Preview matches the full-master segment for ${frequency} Hz`);
  }

  const finished = await renderProject({...processed, audio: {...processed.audio, enabled: true, strength: 0, targetLufs: -20}},
    {outputPath: join(directory, 'finished.mp4')});
  assert.equal(finished.audio.scope, 'full_timeline_master');
  assert.equal(finished.audio.mix.ducking.enabled, true);
  assert.equal(finished.audio.peakSafety.passed, true);
  assert.ok(Number.isFinite(finished.audio.encoded.integratedLufs));
  for (const asset of assets) assert.equal(await fileFingerprint(asset.path), asset.fingerprint);
});
