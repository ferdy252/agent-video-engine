import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applyOperations, createProject, listRevisions, loadProject} from '../src/project.mjs';
import {applyDraft, compareProjectSnapshots, deleteDraft, getDraft, inspectDraft, listDrafts, stageDraft} from '../src/drafts.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'engine-draft-edit-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const source = join(directory, 'source.mp4');
  await writeFile(source, 'synthetic manifest-only source');
  const projectDir = join(directory, 'project');
  const project = await createProject(projectDir, {
    name: 'Synthetic edit',
    settings: {fps: 20},
    assets: [{id: 'camera', path: source, type: 'video', duration: 8}],
    clips: [
      {id: 'first', assetId: 'camera', sourceStart: 0, sourceEnd: 4},
      {id: 'second', assetId: 'camera', sourceStart: 4, sourceEnd: 8},
    ],
  });
  return {projectDir, project, source, manifest: join(projectDir, 'project.json')};
}

test('stage and inspect validated edits against a frozen base without writing a revision', async (t) => {
  const {projectDir, project, manifest} = await fixture(t);
  const before = await readFile(manifest, 'utf8');
  const staged = await stageDraft(projectDir, {expectedRevision: 0, name: 'Shorter opening', operations: [
    {type: 'trim_clip', clipId: 'first', sourceStart: 0, sourceEnd: 3},
    {type: 'set_captions', patch: {enabled: false}},
    {type: 'upsert_overlay', overlay: {id: 'title', type: 'text', text: 'Example title', start: 0, end: 1}},
  ]});
  assert.equal(staged.baseRevision, 0);
  assert.equal(staged.operationCount, 3);
  assert.deepEqual(staged.diff.changedSections, ['clips', 'overlays', 'captions']);
  assert.equal(staged.diff.before.durationSeconds, 8);
  assert.equal(staged.diff.after.durationSeconds, 7);
  assert.equal(staged.diff.durationChangeSeconds, -1);
  assert.deepEqual(staged.diff.clips.changed[0].fields, ['sourceEnd']);
  assert.equal(staged.diff.clips.changed[0].before.sourceEnd, 4);
  assert.equal(staged.diff.clips.changed[0].after.sourceEnd, 3);
  const saved = await getDraft(projectDir, staged.id);
  assert.deepEqual(saved.base, project);
  assert.equal(saved.snapshot.revision, 0);
  assert.equal(saved.snapshot.clips[0].sourceEnd, 3);
  const inspected = await inspectDraft(projectDir, staged.id, {includeTimeline: true});
  assert.equal(inspected.canApply, true);
  assert.equal(inspected.timeline.durationInFrames, 140);
  assert.equal((await listDrafts(projectDir))[0].name, 'Shorter opening');
  assert.equal(await readFile(manifest, 'utf8'), before);
  assert.deepEqual((await listRevisions(projectDir)).map(({revision}) => revision), [0]);
});

test('apply commits the exact staged clip IDs once and preserves the source and base history', async (t) => {
  const {projectDir, source} = await fixture(t);
  const staged = await stageDraft(projectDir, {expectedRevision: 0, operations: [
    {type: 'split_clip', clipId: 'first', sourceTime: 2},
  ]});
  const {snapshot} = await getDraft(projectDir, staged.id);
  assert.notEqual(snapshot.clips[1].id, 'first');
  const applied = await applyDraft(projectDir, {draftId: staged.id, expectedRevision: 0});
  assert.equal(applied.revision, 1);
  assert.deepEqual({...applied, revision: snapshot.revision, updatedAt: snapshot.updatedAt}, snapshot);
  assert.deepEqual(await loadProject(projectDir), applied);
  assert.deepEqual((await listRevisions(projectDir)).map(({revision}) => revision), [0, 1]);
  assert.equal(await readFile(source, 'utf8'), 'synthetic manifest-only source');
  assert.equal((await inspectDraft(projectDir, staged.id)).stale, true);
  await assert.rejects(applyDraft(projectDir, {draftId: staged.id, expectedRevision: 0}), {code: 'REVISION_CONFLICT'});
});

test('drafts cannot replace newer work even if the caller supplies the new revision', async (t) => {
  const {projectDir, manifest} = await fixture(t);
  const staged = await stageDraft(projectDir, {expectedRevision: 0, operations: [
    {type: 'remove_clip', clipId: 'first'},
  ]});
  await applyOperations(projectDir, {expectedRevision: 0, operations: [
    {type: 'set_settings', patch: {background: '#ffffff'}},
  ]});
  const current = await readFile(manifest, 'utf8');
  const inspected = await inspectDraft(projectDir, staged.id);
  assert.equal(inspected.currentRevision, 1);
  assert.equal(inspected.canApply, false);
  assert.equal(inspected.diff.clips.removed[0].id, 'first');
  for (const expectedRevision of [0, 1]) {
    await assert.rejects(applyDraft(projectDir, {draftId: staged.id, expectedRevision}), {code: 'REVISION_CONFLICT'});
  }
  assert.equal(await readFile(manifest, 'utf8'), current);
});

test('invalid batches and stale staging leave no draft record or partial project changes', async (t) => {
  const {projectDir, manifest} = await fixture(t);
  const before = await readFile(manifest, 'utf8');
  await assert.rejects(stageDraft(projectDir, {expectedRevision: 0, operations: [
    {type: 'remove_clip', clipId: 'first'},
    {type: 'trim_clip', clipId: 'second', sourceStart: 4, sourceEnd: 20},
  ]}), {code: 'VALIDATION_ERROR'});
  await assert.rejects(stageDraft(projectDir, {expectedRevision: 5, operations: [
    {type: 'remove_clip', clipId: 'first'},
  ]}), {code: 'REVISION_CONFLICT'});
  assert.deepEqual(await listDrafts(projectDir), []);
  assert.equal(await readFile(manifest, 'utf8'), before);
  assert.equal((await listRevisions(projectDir)).length, 1);
});

test('two drafts from the same revision can be compared and only one wins concurrent application', async (t) => {
  const {projectDir} = await fixture(t);
  const first = await stageDraft(projectDir, {expectedRevision: 0, operations: [
    {type: 'reorder_clips', clipIds: ['second', 'first']},
  ]});
  const second = await stageDraft(projectDir, {expectedRevision: 0, operations: [
    {type: 'trim_clip', clipId: 'first', sourceStart: 0, sourceEnd: 2},
  ]});
  const before = await getDraft(projectDir, first.id);
  const after = await getDraft(projectDir, second.id);
  const comparison = compareProjectSnapshots(before.snapshot, after.snapshot);
  assert.equal(comparison.clips.orderChanged, true);
  assert.deepEqual(comparison.clips.beforeOrder, ['second', 'first']);
  assert.deepEqual(comparison.clips.afterOrder, ['first', 'second']);
  assert.equal(comparison.durationChangeSeconds, -2);
  const outcomes = await Promise.allSettled([first, second].map(({id}) => applyDraft(projectDir, {draftId: id, expectedRevision: 0})));
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  const failure = outcomes.find((outcome) => outcome.status === 'rejected');
  assert.ok(['PROJECT_LOCKED', 'REVISION_CONFLICT'].includes(failure.reason.code));
  assert.equal((await loadProject(projectDir)).revision, 1);
  assert.equal((await listRevisions(projectDir)).length, 2);
});

test('explicit draft deletion is scoped to its UUID and leaves other drafts and the saved edit intact', async (t) => {
  const {projectDir, manifest} = await fixture(t);
  const operations = [{type: 'remove_clip', clipId: 'first'}];
  const first = await stageDraft(projectDir, {expectedRevision: 0, operations});
  const second = await stageDraft(projectDir, {expectedRevision: 0, operations});
  const before = await readFile(manifest, 'utf8');
  await assert.rejects(deleteDraft(projectDir, '../../project'), {code: 'INVALID_DRAFT_ID'});
  assert.deepEqual(await deleteDraft(projectDir, first.id), {id: first.id, deleted: true});
  await assert.rejects(getDraft(projectDir, first.id), {code: 'DRAFT_NOT_FOUND'});
  await assert.rejects(applyDraft(projectDir, {draftId: first.id, expectedRevision: 0}), {code: 'DRAFT_NOT_FOUND'});
  assert.deepEqual((await listDrafts(projectDir)).map(({id}) => id), [second.id]);
  assert.equal(await readFile(manifest, 'utf8'), before);
});
