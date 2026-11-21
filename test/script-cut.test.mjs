import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {callTool} from '../src/api.mjs';
import {createProject} from '../src/project.mjs';

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'engine-script-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const projectDir = join(directory, 'project');
  function transcript(assetId, passages) {
    const words = passages.flatMap(([start, text]) => text.split(' ').map((text, n) =>
      ({id: assetId + '-' + start + '-' + n, text, start: start + n * .3, end: start + n * .3 + .25})));
    return {assetId, words, language: 'en'};
  }
  const a = transcript('a', [[.1, "Here's the"], [1, "Here's the trick."], [3, "Here's the trick."],
    [5, "Don't open settings."], [7, 'Open settings. Tap Back Tap.'], [10, 'Maybe later.']]);
  a.timingReviewWordIds = [a.words.find(word => word.start === 1.3).id, a.words.at(-1).id];
  const b = transcript('b', [[.2, "Here's the trick."], [2, 'Goodbye now.']]);
  for (const id of ['a', 'b']) await writeFile(join(directory, id + '.mov'), 'source fixture');
  await createProject(projectDir, {assets: ['a','b'].map(id => ({id, path: join(directory, id + '.mov'),
    duration: 14, type: 'video', hasAudio: true})), transcripts: [a,b]});
  return {projectDir, expectedRevision: 0};
}

test('one continuous recording stages complete lines, keeps ordinary joins and swaps a repeated take', async t => {
  const base = await setup(t), assetIds = ['a'];
  const lines = [{text: 'Here is the trick.'}, {text: 'Open settings.'}, {text: 'Tap Back Tap.'}];
  const first = await callTool('script_cut_draft', {...base, assetIds, lines});
  assert.equal(first.status, 'complete');
  assert.equal(first.lines[0].totalTakes, 2);
  assert.equal(first.lines[0].selected.take, 2, 'prefer the complete passage over a phrase following the false start');
  assert.equal(first.lines[1].selected.take, 2, 'avoid cutting a negative qualification');
  assert.equal(first.lines[1].selected.clipId, first.lines[2].selected.clipId);
  const initial = await callTool('draft_inspect', {projectDir: base.projectDir, draftId: first.draftId, includeTimeline: true});
  assert.equal(first.preview.toFrame, initial.timeline.durationInFrames - 1);
  assert.deepEqual(initial.timeline.clips.map(c => c.assetId), ['a', 'a']);
  const revised = await callTool('script_cut_draft', {...base, assetIds, lines: [{...lines[0], take: 1}, ...lines.slice(1)]});
  assert.ok(revised.lines[0].selected.sourceEnd < first.lines[0].selected.sourceStart);
  assert.equal(revised.lines[0].selected.interiorTimingNeedsReview, true);
  assert.equal(JSON.parse(await readFile(join(base.projectDir, 'project.json'))).revision, 0);
  await callTool('draft_apply', {...base, draftId: revised.draftId});
  await assert.rejects(callTool('script_cut_draft', {...base, assetIds, lines}), {code: 'REVISION_CONFLICT'});
});

test('several files assemble in script order and report missing or uncertain speech explicitly', async t => {
  const base = await setup(t), assetIds = ['a','b'];
  const lines = [{text:'Goodbye now'}, {text:'Here is the trick', take:3}, {text:'Missing wording'}, {text:'Maybe later'}];
  const draft = await callTool('script_cut_draft', {...base, assetIds, lines});
  assert.equal(draft.status, 'partial');
  assert.equal(draft.matchedLines, 2);
  assert.deepEqual(draft.lines.map(line => line.status), ['matched','matched','no_clear_match','needs_review']);
  assert.deepEqual(draft.lines.slice(0,2).map(line => line.selected.assetId), ['b','b']);
  const both = await callTool('script_cut_draft', {...base, assetIds, lines:[{text:'Goodbye now'}, {text:'Open settings'}]});
  assert.deepEqual(both.lines.map(line => line.selected.assetId), ['b','a']);
  const absent = await callTool('script_cut_draft', {...base, assetIds, lines:[lines[2], lines[3]]});
  assert.equal(absent.draftId, null);
  const repeated = await callTool('script_cut_draft', {...base, assetIds, lines:[{text:'Here is the trick'}, {text:'Here is the trick',take:1}]});
  assert.deepEqual(repeated.lines.map(line => line.selected.take), [2,1]);
  await assert.rejects(callTool('script_cut_draft', {...base, assetIds, lines:[{text:'Open settings',take:1}]}), {code:'INVALID_SCRIPT_CUT'});
});
