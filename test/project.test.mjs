import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createProject, loadProject, applyOperations, restoreRevision, listRevisions, compileTimeline, retimeWords} from '../src/project.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-video-core-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const media = path.join(directory, 'source.mp4');
  await writeFile(media, 'source bytes remain untouched');
  const projectDir = path.join(directory, 'project');
  const project = await createProject(projectDir, {
    assets: [{id: 'a', path: media, type: 'video', duration: 10000, fps: 30000 / 1001, hasAudio: true}],
    clips: [{id: 'c', assetId: 'a', sourceStart: 0, sourceEnd: 10}],
    transcripts: [{assetId: 'a', language: 'en', words: [
      {id: 'w1', text: 'Hello', start: 1, end: 2},
      {id: 'w2', text: 'um', start: 3, end: 4},
      {id: 'w3', text: 'world', start: 6, end: 7},
    ]}], ...options,
  });
  return {projectDir, project, media};
}

test('word deletion removes only explicit word time and retimes captions after cuts', async (t) => {
  const {projectDir, media} = await fixture(t);
  const edited = await applyOperations(projectDir, {expectedRevision: 0, operations: [
    {type: 'delete_words', assetId: 'a', wordIds: ['w2']},
  ]});
  assert.deepEqual(edited.clips.map((clip) => [clip.sourceStart, clip.sourceEnd]), [[0, 3], [4, 10]]);
  const timeline = compileTimeline(edited);
  assert.equal(timeline.durationInFrames, 270);
  assert.deepEqual(timeline.captions.map((word) => [word.id, word.start, word.end]), [['w1', 1, 2], ['w3', 5, 6]]);
  assert.deepEqual(retimeWords(edited), timeline.captions);
  assert.equal(await readFile(media, 'utf8'), 'source bytes remain untouched');
});

test('cumulative frame rounding avoids drift across many fractional-source-FPS cuts', async (t) => {
  const clips = Array.from({length: 1000}, (_, index) => ({id: `c${index}`, assetId: 'a', sourceStart: index * 2, sourceEnd: index * 2 + 1.013}));
  const {project} = await fixture(t, {clips});
  const timeline = compileTimeline(project);
  assert.equal(timeline.durationInFrames, Math.round(1000 * 1.013 * 30));
  assert.equal(timeline.clips.reduce((sum, clip) => sum + clip.durationInFrames, 0), timeline.durationInFrames);
  for (let index = 1; index < timeline.clips.length; index++) {
    assert.equal(timeline.clips[index].from, timeline.clips[index - 1].from + timeline.clips[index - 1].durationInFrames);
  }
  assert.equal(timeline.clips[1].sourceFrame, 60);
  assert.equal(timeline.clips[1].sourceFps, 30000 / 1001);
});

test('invalid operation batches and stale revisions leave the entire project unchanged', async (t) => {
  const {projectDir} = await fixture(t);
  const before = await readFile(path.join(projectDir, 'project.json'), 'utf8');
  await assert.rejects(applyOperations(projectDir, {expectedRevision: 0, operations: [
    {type: 'trim_clip', clipId: 'c', sourceStart: 1, sourceEnd: 5},
    {type: 'set_captions', patch: {fontSize: NaN}},
  ]}), {code: 'VALIDATION_ERROR'});
  assert.equal(await readFile(path.join(projectDir, 'project.json'), 'utf8'), before);
  await applyOperations(projectDir, {expectedRevision: 0, operations: [{type: 'trim_clip', clipId: 'c', sourceStart: 1, sourceEnd: 5}]});
  await assert.rejects(applyOperations(projectDir, {expectedRevision: 0, operations: [{type: 'remove_clip', clipId: 'c'}]}), {code: 'REVISION_CONFLICT'});
  assert.equal((await loadProject(projectDir)).revision, 1);
  assert.equal((await listRevisions(projectDir)).length, 2);
});

test('restore creates a new revision and preserves previous edit history', async (t) => {
  const {projectDir} = await fixture(t);
  await applyOperations(projectDir, {expectedRevision: 0, operations: [{type: 'remove_clip', clipId: 'c'}]});
  const restored = await restoreRevision(projectDir, {expectedRevision: 1, revision: 0});
  assert.equal(restored.revision, 2);
  assert.equal(restored.clips[0].id, 'c');
  assert.deepEqual((await listRevisions(projectDir)).map((entry) => entry.revision), [0, 1, 2]);
});

test('parallel writes cannot silently overwrite each other', async (t) => {
  const {projectDir} = await fixture(t);
  const requests = await Promise.allSettled([1, 2].map((start) => applyOperations(projectDir, {expectedRevision: 0,
    operations: [{type: 'trim_clip', clipId: 'c', sourceStart: start, sourceEnd: 5}]})));
  assert.equal(requests.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = requests.find((result) => result.status === 'rejected');
  assert.ok(['PROJECT_LOCKED', 'REVISION_CONFLICT'].includes(rejected.reason.code));
  assert.equal((await loadProject(projectDir)).revision, 1);
});

test('a crashed process lock is recovered and source bounds are checked before saving', async (t) => {
  const {projectDir} = await fixture(t);
  await writeFile(path.join(projectDir, '.project.lock'), JSON.stringify({pid: 2147483647, token: 'dead-owner'}));
  await applyOperations(projectDir, {expectedRevision: 0, operations: [
    {type: 'trim_clip', clipId: 'c', sourceStart: 1, sourceEnd: 5},
  ]});
  await assert.rejects(applyOperations(projectDir, {expectedRevision: 1, operations: [
    {type: 'trim_clip', clipId: 'c', sourceStart: 1, sourceEnd: 10001},
  ]}), {code: 'VALIDATION_ERROR'});
  const project = await loadProject(projectDir);
  assert.equal(project.revision, 1);
  assert.equal(project.clips[0].sourceEnd, 5);
});

test('split, reorder and overlays use the common output frame clock', async (t) => {
  const {projectDir} = await fixture(t);
  const edited = await applyOperations(projectDir, {expectedRevision: 0, operations: [
    {type: 'split_clip', clipId: 'c', sourceTime: 5, newClipId: 'c2'},
    {type: 'reorder_clips', clipIds: ['c2', 'c']},
    {type: 'upsert_overlay', overlay: {id: 'title', type: 'text', text: 'A title', start: 0.1, end: 2.1}},
  ]});
  const timeline = compileTimeline(edited);
  assert.equal(timeline.clips[0].sourceStart, 5);
  assert.equal(timeline.clips[1].from, 150);
  assert.equal(timeline.overlays[0].from, 3);
  assert.equal(timeline.overlays[0].durationInFrames, 60);
  assert.equal(timeline.captions.find((word) => word.id === 'w3').start, 1);
});

test('point-timed transcript words survive as one-frame captions without inferred speech cuts', async (t) => {
  const {projectDir} = await fixture(t, {
    clips: [{id: 'first', assetId: 'a', sourceStart: 1, sourceEnd: 3},
      {id: 'last', assetId: 'a', sourceStart: 5, sourceEnd: 7}],
    transcripts: [{assetId: 'a', language: 'en', words: [
      {id: 'at-start', text: 'A', start: 1, end: 1},
      {id: 'at-end', text: 'omitted', start: 3, end: 3},
      {id: 'removed', text: 'omitted', start: 4, end: 4},
      {id: 'in-last', text: 'B', start: 6, end: 6},
      {id: 'outside', text: 'omitted', start: 7, end: 7},
    ]}],
  });
  const project = await loadProject(projectDir);
  const words = retimeWords(project);
  assert.deepEqual(words.map((word) => [word.id, word.startFrame, word.endFrame]),
    [['at-start', 0, 1], ['in-last', 90, 91]]);
  await assert.rejects(applyOperations(projectDir, {expectedRevision: 0, operations: [
    {type: 'delete_words', assetId: 'a', wordIds: ['in-last']},
  ]}), {code: 'WORD_TIMING_UNCERTAIN'});
  assert.equal((await loadProject(projectDir)).revision, 0);
});

test('overlays extend the master duration and support motion-only projects', async (t) => {
  const {projectDir} = await fixture(t);
  const withOutro = await applyOperations(projectDir, {expectedRevision: 0, operations: [
    {type: 'upsert_overlay', overlay: {id: 'outro', type: 'text', text: 'Thanks', start: 9, end: 12}},
  ]});
  assert.equal(compileTimeline(withOutro).durationInFrames, 360);
  const motionOnly = await applyOperations(projectDir, {expectedRevision: 1, operations: [
    {type: 'set_clips', clips: []},
  ]});
  const timeline = compileTimeline(motionOnly);
  assert.equal(timeline.durationInFrames, 360);
  assert.deepEqual(timeline.clips, []);
  assert.deepEqual(timeline.captions, []);
  assert.equal(timeline.overlays[0].durationInFrames, 90);
});

test('word-anchored overlays follow cuts and disappear when their source speech is removed', async (t) => {
  const {projectDir} = await fixture(t);
  const attached = await applyOperations(projectDir, {expectedRevision: 0, operations: [
    {type: 'upsert_overlay', overlay: {id: 'graphic', type: 'text', text: 'World', start: 6, end: 8,
      anchor: {assetId: 'a', wordId: 'w3', offset: 0.25}}},
  ]});
  assert.equal(compileTimeline(attached).overlays[0].start, 6.25);
  const cut = await applyOperations(projectDir, {expectedRevision: 1, operations: [
    {type: 'delete_source_range', assetId: 'a', start: 0, end: 3},
  ]});
  const graphic = compileTimeline(cut).overlays[0];
  assert.equal(graphic.start, 3.25);
  assert.equal(graphic.end, 5.25);
  assert.equal(cut.overlays[0].start, 6);
  assert.equal(cut.overlays[0].end, 8);
  const removed = await applyOperations(projectDir, {expectedRevision: 2, operations: [
    {type: 'delete_words', assetId: 'a', wordIds: ['w3']},
  ]});
  assert.deepEqual(compileTimeline(removed).overlays, []);
  assert.equal(removed.overlays.length, 1);
});

test('reused words have deterministic first-occurrence anchors and optional clip-specific attachments', async (t) => {
  const {projectDir} = await fixture(t, {clips: [
    {id: 'first', assetId: 'a', sourceStart: 5, sourceEnd: 8},
    {id: 'second', assetId: 'a', sourceStart: 5, sourceEnd: 8},
  ]});
  const attached = await applyOperations(projectDir, {expectedRevision: 0, operations: [
    {type: 'upsert_overlay', overlay: {id: 'first-caption', type: 'text', text: 'First', start: 0, end: 1,
      anchor: {assetId: 'a', wordId: 'w3'}}},
    {type: 'upsert_overlay', overlay: {id: 'second-caption', type: 'text', text: 'Second', start: 0, end: 1,
      anchor: {assetId: 'a', wordId: 'w3', clipId: 'second'}}},
    {type: 'upsert_overlay', overlay: {id: 'before', type: 'text', text: 'Before', start: 0, end: 1,
      anchor: {assetId: 'a', wordId: 'w3', offset: -2}}},
  ]});
  assert.deepEqual(compileTimeline(attached).overlays.map((overlay) => [overlay.id, overlay.start, overlay.end]),
    [['first-caption', 1, 2], ['second-caption', 4, 5], ['before', 0, 1]]);
  const removed = await applyOperations(projectDir, {expectedRevision: 1, operations: [
    {type: 'remove_clip', clipId: 'second'},
  ]});
  assert.deepEqual(compileTimeline(removed).overlays.map((overlay) => overlay.id), ['first-caption', 'before']);
});

test('invalid overlay word anchors reject the batch without creating a revision', async (t) => {
  const {projectDir} = await fixture(t);
  await assert.rejects(applyOperations(projectDir, {expectedRevision: 0, operations: [
    {type: 'upsert_overlay', overlay: {id: 'bad', type: 'text', text: 'Missing', start: 0, end: 1,
      anchor: {assetId: 'a', wordId: 'missing'}}},
  ]}), {code: 'VALIDATION_ERROR'});
  assert.equal((await loadProject(projectDir)).revision, 0);
});
