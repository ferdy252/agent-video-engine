import test from 'node:test';
import assert from 'node:assert/strict';
import {access, mkdtemp, readFile, writeFile, rm, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProject} from '../src/project.mjs';
import {analyzeCutBoundaries, analyzeAudioSamples, reviewCuts} from '../src/cut-review.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-video-cut-review-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const media = join(directory, 'source.mp4');
  await writeFile(media, 'synthetic timing-only source');
  const projectDir = join(directory, 'project');
  const project = await createProject(projectDir, {settings: {fps: 20, width: 160, height: 90},
    assets: [{id: 'a', path: media, type: 'video', duration: 4, hasAudio: false}],
    transcripts: [{assetId: 'a', language: 'en', words: [
      {id: 'w1', text: 'outgoing', start: 0.4, end: 0.8},
      {id: 'w2', text: 'incoming', start: 1.1, end: 1.5}]}],
    clips: [{id: 'left', assetId: 'a', sourceStart: 0, sourceEnd: 0.6},
      {id: 'right', assetId: 'a', sourceStart: 1.3, sourceEnd: 2.3}], ...options});
  return {directory, projectDir, project, media};
}

test('source word checks use source seconds and compiled output join frames', async (t) => {
  const {project} = await fixture(t, {clips: [
    {id: 'left', assetId: 'a', sourceStart: 0, sourceEnd: 0.6, playbackRate: 2},
    {id: 'right', assetId: 'a', sourceStart: 1.3, sourceEnd: 2.3}]});
  const report = analyzeCutBoundaries(project);
  assert.equal(report.totalCuts, 1);
  assert.equal(report.cuts[0].outputFrame, 6);
  assert.equal(report.cuts[0].outputTime, 0.3);
  assert.equal(report.cuts[0].flags[0].code, 'CUT_INSIDE_WORD');
  assert.deepEqual(report.cuts[0].flags[0].evidence.map((word) => [word.side, word.wordId]), [['left', 'w1'], ['right', 'w2']]);
});

test('a source-contiguous split is skipped but rate or volume changes remain reviewable', async (t) => {
  const {project} = await fixture(t, {clips: [
    {id: 'one', assetId: 'a', sourceStart: 0, sourceEnd: 1},
    {id: 'two', assetId: 'a', sourceStart: 1, sourceEnd: 2},
    {id: 'three', assetId: 'a', sourceStart: 2, sourceEnd: 3, volume: 0.5},
    {id: 'four', assetId: 'a', sourceStart: 3, sourceEnd: 4, playbackRate: 2, volume: 0.5}]});
  const report = analyzeCutBoundaries(project);
  assert.equal(report.totalCuts, 2);
  assert.deepEqual(report.cuts.map((cut) => cut.outputFrame), [40, 60]);
});

test('missing and point-only word timing is explicitly unassessed', async (t) => {
  const {project} = await fixture(t, {transcripts: []});
  assert.equal(analyzeCutBoundaries(project).cuts[0].wordTiming.left.status, 'unassessed_no_transcript');
  project.transcripts = [{assetId: 'a', language: 'en', words: [{id: 'point', text: 'point', start: 0.6, end: 0.6}]}];
  const cut = analyzeCutBoundaries(project).cuts[0];
  assert.equal(cut.wordTiming.right.status, 'unassessed_point_timestamps');
  assert.deepEqual(cut.flags, []);
});

test('audio level flags measure loudness only when both sides are above the silence floor', () => {
  const samples = new Float32Array(16000);
  samples.fill(0.02, 0, 8000);
  samples.fill(0.2, 8000);
  const report = analyzeAudioSamples(samples, {sampleRate: 16000, cutSample: 8000});
  assert.ok(Math.abs(report.levelJumpDb - 20) < 0.01);
  assert.deepEqual(report.flags.map((flag) => flag.code), ['AUDIO_LEVEL_JUMP']);
  samples.fill(0, 0, 8000);
  assert.ok(!analyzeAudioSamples(samples, {sampleRate: 16000, cutSample: 8000}).flags.some((flag) => flag.code === 'AUDIO_LEVEL_JUMP'));
});

test('quiet gaps are contiguous around the join and preview-edge truncation is a lower bound', () => {
  const samples = new Float32Array(16000).fill(0.1);
  samples.fill(0, 4000, 12000);
  const report = analyzeAudioSamples(samples, {sampleRate: 16000, cutSample: 8000});
  assert.equal(report.silence.durationSeconds, 0.5);
  assert.equal(report.silence.isLowerBound, false);
  assert.ok(report.flags.some((flag) => flag.code === 'LONG_SILENCE_NEAR_JOIN'));
  samples.fill(0);
  const truncated = analyzeAudioSamples(samples, {sampleRate: 16000, cutSample: 8000});
  assert.equal(truncated.silence.isLowerBound, true);
  assert.equal(truncated.silence.truncatedAtPreviewStart, true);
  assert.equal(truncated.silence.truncatedAtPreviewEnd, true);
});

test('stereo energy does not cancel anti-phase channels into manufactured silence', () => {
  const samples = new Float32Array(32000);
  for (let index = 0; index < 16000; index++) {samples[index * 2] = 0.1; samples[index * 2 + 1] = -0.1;}
  const report = analyzeAudioSamples(samples, {sampleRate: 16000, channels: 2, cutSample: 8000});
  assert.ok(report.left.rms > 0.09);
  assert.equal(report.silence.durationSeconds, 0);
  assert.deepEqual(report.flags, []);
});

test('audio windows that exceed available preview context are explicitly marked', () => {
  const samples = new Float32Array(16000).fill(0.1);
  const report = analyzeAudioSamples(samples, {sampleRate: 16000, cutSample: 400});
  assert.deepEqual(report.windowTruncated, {left: true, right: false});
});

test('timing-only review saves a bounded report without mutating source or project', async (t) => {
  const {project, projectDir, media, directory} = await fixture(t);
  const before = await readFile(join(projectDir, 'project.json'), 'utf8');
  const report = await reviewCuts(project, {projectDir, outputDir: join(directory, 'review'), limit: 1, renderPreviews: false});
  assert.equal(report.revision, 0);
  assert.equal(report.reviewedCuts, 1);
  assert.equal(report.cuts[0].audio.status, 'skipped');
  assert.equal(report.cuts[0].preview, null);
  assert.deepEqual(JSON.parse(await readFile(report.reportPath, 'utf8')), report);
  assert.equal(await readFile(join(projectDir, 'project.json'), 'utf8'), before);
  assert.equal(await readFile(media, 'utf8'), 'synthetic timing-only source');
});

test('zero cuts save a successful empty report, paging remains bounded and custom timing is rejected', async (t) => {
  const {project, projectDir} = await fixture(t, {clips: []});
  const report = await reviewCuts(project, {projectDir, renderPreviews: false});
  assert.equal(report.totalCuts, 0);
  assert.equal(report.reviewedCuts, 0);
  assert.equal(report.hasMore, false);
  await assert.rejects(reviewCuts(project, {projectDir, limit: 51}), {code: 'INVALID_REVIEW_REQUEST'});
  assert.throws(() => analyzeCutBoundaries({...project, custom: {}}), {code: 'UNSUPPORTED_CUSTOM_REVIEW'});
  const controller = new AbortController(); controller.abort();
  await assert.rejects(reviewCuts(project, {projectDir, signal: controller.signal}), {name: 'AbortError'});
});

test('review owns an exclusive output directory and removes only its own failed review', async (t) => {
  const {project, projectDir, directory} = await fixture(t);
  const existing = join(directory, 'existing');
  await mkdir(existing);
  await writeFile(join(existing, 'keep.txt'), 'keep existing artifacts');
  await assert.rejects(reviewCuts(project, {projectDir, outputDir: existing, renderPreviews: false}), {code: 'REVIEW_OUTPUT_EXISTS'});
  assert.equal(await readFile(join(existing, 'keep.txt'), 'utf8'), 'keep existing artifacts');
  const failed = join(directory, 'failed-review');
  await assert.rejects(reviewCuts(project, {projectDir, outputDir: failed, renderPreviews: false,
    onProgress: () => {throw new Error('synthetic observer failure');}}), /synthetic observer failure/);
  await assert.rejects(access(failed), {code: 'ENOENT'});
  const cancelled = join(directory, 'cancelled-review');
  const controller = new AbortController();
  await assert.rejects(reviewCuts(project, {projectDir, outputDir: cancelled, signal: controller.signal,
    onProgress: () => controller.abort()}), {name: 'AbortError'});
  await assert.rejects(access(cancelled), {code: 'ENOENT'});
});

test('review pagination only checks the requested discontinuities', async (t) => {
  const {project, projectDir} = await fixture(t, {clips: [
    {id: 'a0', assetId: 'a', sourceStart: 0, sourceEnd: 0.3},
    {id: 'a1', assetId: 'a', sourceStart: 1, sourceEnd: 1.3},
    {id: 'a2', assetId: 'a', sourceStart: 2, sourceEnd: 2.3},
    {id: 'a3', assetId: 'a', sourceStart: 3, sourceEnd: 3.3}]});
  const report = await reviewCuts(project, {projectDir, offset: 1, limit: 1, renderPreviews: false});
  assert.equal(report.totalCuts, 3);
  assert.equal(report.reviewedCuts, 1);
  assert.equal(report.cuts[0].index, 1);
  assert.equal(report.hasMore, true);
  assert.equal(report.nextOffset, 2);
});
