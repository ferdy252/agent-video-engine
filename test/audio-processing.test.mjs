import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {analyzeAudio, finishAudioMaster, prepareVoiceGains} from '../src/audio-processing.mjs';
import {compileTimeline} from '../src/timeline.mjs';
import {fileFingerprint} from '../src/media.mjs';

const real = {skip: process.env.AGENT_VIDEO_RENDER_SMOKE !== '1', timeout: 120000};
async function fixture(t, {duration = 8, amplitude = (time) => time < 3 ? .04 : time < 4 ? 0 : .16} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'engine-audio-check-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const source = join(directory, 'source.wav'), sampleRate = 48000, count = Math.round(duration * sampleRate);
  const dataSize = count * 2 * 4, wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF'); wav.writeUInt32LE(dataSize + 36, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(3, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 8, 28); wav.writeUInt16LE(8, 32); wav.writeUInt16LE(32, 34);
  wav.write('data', 36); wav.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < count; index++) {
    const time = index / sampleRate, sample = amplitude(time) * Math.sin(2 * Math.PI * 440 * time);
    wav.writeFloatLE(sample, 44 + index * 8); wav.writeFloatLE(sample, 48 + index * 8);
  }
  await writeFile(source, wav);
  const project = {settings: {fps: 30, width: 160, height: 90},
    audio: {enabled: true, maxGainDb: 24},
    assets: [{id: 'voice', path: source, type: 'audio', duration, hasAudio: true}], transcripts: [], overlays: [], captions: {},
    clips: [{id: 'quiet', assetId: 'voice', sourceStart: 0, sourceEnd: 3, playbackRate: 1, volume: 1},
      {id: 'loud', assetId: 'voice', sourceStart: 4, sourceEnd: 7, playbackRate: 1, volume: 1}]};
  return {directory, source, project};
}

test('manual clip adjustments stay effective while disabled global controls are bypassed', async () => {
  const project = {audio: {enabled: false, voiceGainDb: -3}, assets: [{id: 'voice', type: 'audio'}]};
  const timeline = {fps: 30, clips: [{id: 'clip', assetId: 'voice', volume: .5, audio: {gainDb: -6},
    from: 0, durationInFrames: 30}], overlays: [{id: 'music', volume: .2}]};
  const original = structuredClone(timeline);
  const {timeline: prepared, report} = await prepareVoiceGains(project, timeline);
  assert.deepEqual(timeline, original);
  assert.deepEqual(prepared.overlays, original.overlays);
  assert.ok(Math.abs(prepared.clips[0].volume - .5 * 10 ** (-6 / 20)) < 1e-8);
  assert.equal(report.clips[0].automaticGainDb, 0);
  assert.equal(report.clips[0].manualGainDb, -6);
});

test('real source measurements balance separate takes while nearby edit fragments share a gain', real, async (t) => {
  const {project, source} = await fixture(t), before = await fileFingerprint(source);
  const {timeline, report} = await prepareVoiceGains(project, compileTimeline(project));
  assert.equal(report.groups.length, 2);
  assert.ok(report.groups.every((group) => group.analysis.status === 'measured'));
  assert.ok(report.clips[0].automaticGainDb > report.clips[1].automaticGainDb + 10);
  const inferred = report.clips.map((clip) => clip.measuredLufs + clip.automaticGainDb);
  assert.ok(Math.abs(inferred[0] - inferred[1]) < .2);
  assert.ok(timeline.clips[0].volume > timeline.clips[1].volume * 3);
  const fragmented = structuredClone(project);
  fragmented.clips = [
    {...project.clips[0], id: 'part-one', sourceEnd: .3},
    {...project.clips[0], id: 'part-two', sourceStart: .5, sourceEnd: 1},
    {...project.clips[0], id: 'part-three', sourceStart: 1.1}, project.clips[1],
  ];
  const fragments = await prepareVoiceGains(fragmented, compileTimeline(fragmented));
  assert.equal(fragments.report.groups.length, 2);
  assert.equal(new Set(fragments.report.clips.slice(0, 3).map((clip) => clip.automaticGainDb)).size, 1);
  const capped = await prepareVoiceGains({...project, audio: {enabled: true}}, compileTimeline(project));
  assert.ok(capped.report.clips.every((clip) => Math.abs(clip.automaticGainDb) <= 9));
  assert.equal(await fileFingerprint(source), before);
});

test('automatic analysis does not cancel clip gain, volume, strength or opt-out controls', real, async (t) => {
  const {project} = await fixture(t);
  const baseline = await prepareVoiceGains(project, compileTimeline(project));
  const adjusted = structuredClone(project);
  adjusted.clips[0].audio = {gainDb: -6}; adjusted.clips[0].volume = .5;
  adjusted.clips[1].audio = {leveling: false, gainDb: 3};
  const result = await prepareVoiceGains(adjusted, compileTimeline(adjusted));
  assert.equal(result.report.clips[0].automaticGainDb, baseline.report.clips[0].automaticGainDb);
  assert.ok(Math.abs(result.timeline.clips[0].volume / baseline.timeline.clips[0].volume - .5 * 10 ** (-6 / 20)) < 1e-8);
  assert.equal(result.report.clips[1].automaticGainDb, 0);
  assert.equal(result.report.clips[1].status, 'opted_out');
  const half = await prepareVoiceGains({...project, audio: {enabled: true, maxGainDb: 24, strength: .5}}, compileTimeline(project));
  assert.ok(Math.abs(half.report.clips[0].automaticGainDb - baseline.report.clips[0].automaticGainDb / 2) < 1e-8);
});

test('silence and short spans remain JSON-safe and receive no automatic boost', real, async (t) => {
  const {directory, project, source} = await fixture(t, {duration: 2, amplitude: () => 0});
  project.clips = [{...project.clips[0], sourceEnd: 2}];
  const result = await prepareVoiceGains(project, compileTimeline(project));
  assert.equal(result.report.clips[0].automaticGainDb, 0);
  assert.equal(result.report.groups[0].analysis.silent, true);
  assert.equal(result.report.groups[0].analysis.integratedLufs, null);
  const completed = await finishAudioMaster(source, join(directory, 'silent-master.wav'), project.audio);
  assert.equal(completed.appliedGainDb, 0);
  assert.equal(completed.after.silent, true);
  assert.doesNotMatch(JSON.stringify(completed), /NaN|Infinity/);
  const short = await fixture(t, {duration: .2, amplitude: () => .1});
  const analysis = await analyzeAudio(short.source);
  assert.equal(analysis.status, 'insufficient_duration');
  short.project.clips = [{...short.project.clips[0], sourceEnd: .2}];
  assert.equal((await prepareVoiceGains(short.project, compileTimeline(short.project))).report.clips[0].automaticGainDb, 0);
});

test('complete-master finishing preserves dynamics, caps peaks and honors output gain without overwriting', real, async (t) => {
  const {directory, source, project} = await fixture(t, {duration: 4, amplitude: (time) => time < 2 ? .1 : .2});
  const before = await readFile(source), first = join(directory, 'finished.wav'), quieter = join(directory, 'quieter.wav');
  const settings = {...project.audio, targetLufs: -20, truePeakDb: -1.5};
  const finish = await finishAudioMaster(source, first, settings);
  const second = await finishAudioMaster(source, quieter, {...settings, outputGainDb: -6});
  assert.ok(Math.abs(finish.after.integratedLufs - -20) <= .5);
  assert.ok(Math.abs(second.after.integratedLufs - finish.after.integratedLufs + 6) <= .2);
  assert.ok(finish.after.truePeakDb <= -1.5);
  assert.ok(Math.abs(finish.after.loudnessRange - finish.before.loudnessRange) <= .2);
  assert.deepEqual(await readFile(source), before);
  await assert.rejects(finishAudioMaster(source, first, settings), {code: 'OUTPUT_EXISTS'});
  const high = await fixture(t, {duration: 2, amplitude: (time) => time < .01 ? 2 : .02});
  const limited = await finishAudioMaster(high.source, join(high.directory, 'peak-limited.wav'),
    {enabled: true, targetLufs: -16, truePeakDb: -2, maxGainDb: 24});
  assert.equal(limited.peakLimited, true);
  assert.equal(limited.targetReached, false);
  assert.ok(limited.after.truePeakDb <= -2.4);
});

test('rounded source starts at EOF and tiny slowed spans skip measurement without failing the render plan', real, async (t) => {
  const {project, source} = await fixture(t, {duration: 2, amplitude: () => .1});
  const fingerprint = await fileFingerprint(source);
  project.clips = [{...project.clips[0], sourceStart: 1.99, sourceEnd: 2, playbackRate: .01}];
  const atEnd = compileTimeline(project);
  assert.equal(atEnd.clips[0].sourceFrame / atEnd.fps, 2);
  const result = await prepareVoiceGains(project, atEnd);
  assert.equal(result.report.groups[0].analysis.status, 'insufficient_duration');
  assert.equal(result.report.groups[0].analysis.sourceDuration, 0);
  assert.equal(result.report.clips[0].automaticGainDb, 0);
  assert.equal(result.timeline.clips[0].volume, 1);
  project.clips = [{...project.clips[0], sourceStart: 1.9, sourceEnd: 1.91}];
  const slowed = await prepareVoiceGains(project, compileTimeline(project));
  assert.ok(slowed.report.groups[0].analysis.duration > .4);
  assert.ok(slowed.report.groups[0].analysis.sourceDuration < .4);
  assert.equal(slowed.report.groups[0].analysis.status, 'insufficient_duration');
  assert.equal(slowed.report.clips[0].automaticGainDb, 0);
  assert.equal(await fileFingerprint(source), fingerprint);
});

test('audio processing accepts cancellation before touching any source', async () => {
  const signal = AbortSignal.abort();
  await assert.rejects(analyzeAudio('/unopened/source.wav', {signal}), {name: 'AbortError'});
  await assert.rejects(prepareVoiceGains({audio: {}}, {clips: []}, {signal}), {name: 'AbortError'});
  await assert.rejects(finishAudioMaster('/unopened/source.wav', '/unused/output.wav', {}, {signal}), {name: 'AbortError'});
});
