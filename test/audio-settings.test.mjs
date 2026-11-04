import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProject, loadProject, applyOperations, restoreRevision, compileTimeline} from '../src/project.mjs';
import {resolveAudioSettings, resolveClipAudio} from '../src/audio-settings.mjs';
import {callTool} from '../src/api.mjs';
import {analyzeCutBoundaries} from '../src/cut-review.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'engine-audio-controls-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const source = join(directory, 'original.wav');
  await writeFile(source, 'Original fixture is never processed by settings tests.');
  const projectDir = join(directory, 'project');
  await createProject(projectDir, {assets: [{id: 'voice', type: 'audio', path: source, duration: 12, hasAudio: true}],
    clips: [{id: 'take', assetId: 'voice', sourceStart: 0, sourceEnd: 10}]});
  return {projectDir, source, manifest: join(projectDir, 'project.json')};
}

test('audio finishing is opt-in and older manifests load without a silent migration', async (t) => {
  const {projectDir, manifest} = await fixture(t);
  assert.equal((await loadProject(projectDir)).audio.enabled, false);
  const older = JSON.parse(await readFile(manifest, 'utf8'));
  delete older.audio;
  await writeFile(manifest, JSON.stringify(older));
  const before = await readFile(manifest, 'utf8');
  const loaded = await loadProject(projectDir);
  assert.equal(loaded.audio, undefined);
  assert.equal(compileTimeline(loaded).audio.enabled, false);
  assert.equal((await callTool('project_inspect', {projectDir})).audio.enabled, false);
  assert.equal(await readFile(manifest, 'utf8'), before);
});

test('saved automatic and manual audio controls survive cuts and undo without touching originals', async (t) => {
  const {projectDir, source} = await fixture(t);
  const original = await readFile(source, 'utf8');
  const edited = await callTool('edit_apply', {projectDir, expectedRevision: 0, operations: [
    {type: 'set_audio', patch: {enabled: true, strength: .6, outputGainDb: -3}},
    {type: 'set_clip_audio', clipId: 'take', patch: {leveling: false, gainDb: -4}},
    {type: 'split_clip', clipId: 'take', sourceTime: 4, newClipId: 'second'},
  ]});
  assert.equal(edited.revision, 1);
  const saved = await loadProject(projectDir);
  assert.equal(saved.audio.enabled, true);
  assert.equal(saved.audio.strength, .6);
  assert.equal(saved.audio.outputGainDb, -3);
  assert.ok(saved.clips.every((clip) => clip.audio.gainDb === -4 && clip.audio.leveling === false));
  assert.equal(analyzeCutBoundaries(saved).totalCuts, 0, 'Equal audio settings preserve a contiguous split');
  const changedTake = structuredClone(saved);
  changedTake.clips[1].audio.gainDb = -8;
  assert.equal(analyzeCutBoundaries(changedTake).totalCuts, 1, 'Manual gain differences must remain reviewable');
  changedTake.clips[1].audio.gainDb = -4;
  changedTake.clips[1].audio.leveling = true;
  assert.equal(analyzeCutBoundaries(changedTake).totalCuts, 1, 'A different automatic-leveling scope must remain reviewable');
  await applyOperations(projectDir, {expectedRevision: 1, operations: [{type: 'set_audio', patch: {enabled: false}}]});
  assert.equal((await loadProject(projectDir)).clips[0].audio.gainDb, -4);
  const restored = await restoreRevision(projectDir, {expectedRevision: 2, revision: 0});
  assert.equal(restored.audio.enabled, false);
  assert.deepEqual(resolveClipAudio(restored.clips[0].audio), {leveling: true, gainDb: 0});
  assert.equal(await readFile(source, 'utf8'), original);
});

test('invalid or stale audio changes leave the complete saved revision unchanged', async (t) => {
  const {projectDir, manifest} = await fixture(t);
  const before = await readFile(manifest, 'utf8');
  for (const operation of [
    {type: 'set_audio', patch: {enabled: true, strength: 2}},
    {type: 'set_audio', patch: {targetLufs: NaN}},
    {type: 'set_audio', patch: {constructor: 1}},
    {type: 'set_clip_audio', clipId: 'take', patch: {gainDb: 25}},
    {type: 'set_clip_audio', clipId: 'missing', patch: {gainDb: -2}},
  ]) {
    await assert.rejects(applyOperations(projectDir, {expectedRevision: 0, operations: [
      {type: 'trim_clip', clipId: 'take', sourceStart: 1, sourceEnd: 9}, operation,
    ]}));
    assert.equal(await readFile(manifest, 'utf8'), before);
  }
  await callTool('edit_apply', {projectDir, expectedRevision: 0, operations: [{type: 'set_audio', patch: {enabled: true}}]});
  const current = await readFile(manifest, 'utf8');
  await assert.rejects(callTool('edit_apply', {projectDir, expectedRevision: 0,
    operations: [{type: 'set_audio', patch: {enabled: false}}]}), {code: 'REVISION_CONFLICT'});
  await assert.rejects(callTool('edit_apply', {projectDir, expectedRevision: 1,
    operations: [{type: 'set_clip_audio', clipId: 'take', patch: {unknownSetting: true}}]}));
  assert.equal(await readFile(manifest, 'utf8'), current);
  assert.equal(resolveAudioSettings().enabled, false);
});
