import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProject, prepareOperations, applyOperations, loadProject} from '../src/project.mjs';
import {compileTimeline} from '../src/timeline.mjs';
import {callTool} from '../src/api.mjs';
import {exportSubtitles} from '../src/delivery.mjs';

const override = (wordIds, rest) => ({assetId: 'voice', wordIds, ...rest});
const set = overrides => ({type: 'set_caption_overrides', overrides});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'engine-captions-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = join(root, 'source.mp4'); await writeFile(source, 'immutable original');
  const dir = join(root, 'project');
  const project = await createProject(dir, {name: 'Linked captions', settings: {width: 320, height: 180, fps: 10},
    assets: [{id: 'voice', type: 'video', path: source, duration: 5, hasAudio: true}],
    clips: [{id: 'take', assetId: 'voice', sourceStart: 0, sourceEnd: 4}],
    captions: {wordsPerPage: 8},
    transcripts: [{assetId: 'voice', language: 'en', words: [
      {id: 'a', text: 'Try', start: 1, end: 1.3}, {id: 'b', text: 'Chat', start: 1.4, end: 1.6},
      {id: 'c', text: 'GBT', start: 1.7, end: 2}, {id: 'd', text: 'today', start: 2.1, end: 2.6},
      {id: 'e', text: 'please', start: 2.7, end: 3},
    ]}]});
  return {root, source, dir, project};
}

test('corrections and line/page breaks preserve raw words, anchors, sound and highlight intervals', async t => {
  const {project} = await fixture(t);
  const edited = prepareOperations(project, [set([
    override(['b', 'c'], {text: 'ChatGPT'}), override(['d'], {lineBreakBefore: true}), override(['e'], {pageBreakBefore: true}),
  ]), {type: 'upsert_overlay', overlay: {id: 'anchor', type: 'text', text: 'Graphic', start: 0, end: .2, anchor: {assetId: 'voice', wordId: 'c'}}}]);
  const timeline = compileTimeline(edited);
  assert.deepEqual(timeline.captionCues.map(c => c.text), ['Try ChatGPT\ntoday', 'please']);
  const corrected = timeline.captionCues[0].words[1];
  assert.deepEqual([corrected.text, corrected.startFrame, corrected.endFrame], ['ChatGPT', 14, 20]);
  assert.deepEqual(corrected.sourceWordIds, ['b', 'c']);
  assert.equal(timeline.overlays[0].from, 17);
  assert.equal(timeline.captions[2].text, 'GBT');
  assert.deepEqual(edited.transcripts, project.transcripts);
  assert.deepEqual(edited.clips, project.clips);
  assert.deepEqual(edited.audio, project.audio);
  assert.equal(timeline.captionOverrideReview.totalFindings, 0);
});

test('source corrections follow trims, speed, repeats, rearrangement and replacement audio timing', async t => {
  const {project} = await fixture(t);
  const edited = prepareOperations(project, [set([override(['d'], {text: 'TODAY'})]),
    {type: 'set_clips', clips: [
      {id: 'fast', assetId: 'voice', sourceStart: 1, sourceEnd: 4, playbackRate: 2},
      {id: 'again', assetId: 'voice', sourceStart: 2, sourceEnd: 3},
    ]}, {type: 'reorder_clips', clipIds: ['again', 'fast']}]);
  const timeline = compileTimeline(edited);
  const instances = timeline.captionCues.flatMap(c => c.words).filter(w => w.text === 'TODAY');
  assert.deepEqual(instances.map(w => [w.clipId, w.startFrame, w.endFrame]), [['again', 1, 6], ['fast', 16, 18]]);
  const shifted = prepareOperations(project, [set([override(['d'], {text: 'TODAY'})]),
    {type: 'set_clip_audio', clipId: 'take', patch: {sourceStart: 2, sourceEnd: 3, offset: .5}}]);
  assert.equal(compileTimeline(shifted).captionCues[0].words[0].startFrame, 6);
  const split = prepareOperations(edited, [{type: 'split_clip', clipId: 'fast', sourceTime: 2, newClipId: 'tail'}]);
  assert.equal(compileTimeline(split).captionCues.flatMap(c => c.words).filter(w => w.text === 'TODAY').length, 2);
});

test('cuts through grouped corrections display retained source words and flag the affected occurrences', async t => {
  const {project} = await fixture(t);
  const merged = prepareOperations(project, [set([override(['b', 'c'], {text: 'ChatGPT'})])]);
  const partial = prepareOperations(merged, [{type: 'trim_clip', clipId: 'take', sourceStart: 1.7, sourceEnd: 4}]);
  const timeline = compileTimeline(partial);
  assert.ok(!timeline.captionCues.some(c => c.text.includes('ChatGPT')));
  assert.ok(timeline.captionCues.some(c => c.text.includes('GBT')));
  assert.equal(timeline.captionOverrideReview.findings[0].code, 'CAPTION_GROUP_INTERRUPTED');
  const removed = prepareOperations(merged, [{type: 'trim_clip', clipId: 'take', sourceStart: 2.1, sourceEnd: 4}]);
  assert.equal(compileTimeline(removed).captionOverrideReview.totalFindings, 0);
  const split = prepareOperations(merged, [{type: 'split_clip', clipId: 'take', sourceTime: 1.65, newClipId: 'tail'}]);
  assert.equal(compileTimeline(split).captionOverrideReview.totalFindings, 2);
  const clippedWord = prepareOperations(merged, [{type: 'trim_clip', clipId: 'take', sourceStart: 1.5, sourceEnd: 4}]);
  assert.equal(compileTimeline(clippedWord).captionOverrideReview.totalFindings, 1);
  assert.ok(!compileTimeline(clippedWord).captionCues.some(c => c.text.includes('ChatGPT')));
});

test('invalid or stale corrections reject atomically and clearing permits transcript replacement', async t => {
  const {dir, source, project} = await fixture(t);
  for (const overrides of [[override(['missing'], {text: 'No'})], [override(['b', 'd'], {text: 'No'})],
    [override(['b'], {text: 'One'}), override(['b'], {text: 'Two'})], [override(['b'], {text: 'Line\nbreak'})],
    [override(['b'], {})], [override(['b', 'c'], {lineBreakBefore: true})]]) {
    await assert.rejects(applyOperations(dir, {expectedRevision: 0, operations: [set(overrides)]}), {code: 'VALIDATION_ERROR'});
    assert.deepEqual(await loadProject(dir), project);
  }
  const corrected = await applyOperations(dir, {expectedRevision: 0, operations: [set([override(['d'], {text: 'TODAY'})])]});
  const transcript = structuredClone(project.transcripts[0]); transcript.words[3].text = 'tomorrow';
  await assert.rejects(applyOperations(dir, {expectedRevision: 1, operations: [{type: 'set_transcript', transcript}]}), {code: 'CAPTION_OVERRIDE_STALE'});
  assert.deepEqual(await loadProject(dir), corrected);
  const reset = await applyOperations(dir, {expectedRevision: 1, operations: [set([]), {type: 'set_transcript', transcript}]});
  assert.ok(compileTimeline(reset).captionCues.some(c => c.text.includes('tomorrow')));
  assert.equal(await readFile(source, 'utf8'), 'immutable original');
});

test('MCP draft, apply, subtitle delivery and undo preserve correction timing and existing cue modes', async t => {
  const {dir: projectDir, root, project} = await fixture(t);
  const draft = await callTool('draft_stage', {projectDir, expectedRevision: 0, operations: [set([
    override(['b', 'c'], {text: 'ChatGPT'}), override(['d'], {lineBreakBefore: true}),
  ])]});
  assert.deepEqual(await loadProject(projectDir), project);
  const preview = await callTool('draft_inspect', {projectDir, draftId: draft.id, includeTimeline: true});
  assert.ok(preview.timeline.captionCues[0].words);
  await callTool('draft_apply', {projectDir, draftId: draft.id, expectedRevision: 0});
  await callTool('edit_apply', {projectDir, expectedRevision: 1, operations: [{type: 'trim_clip', clipId: 'take', sourceStart: 1, sourceEnd: 4}]});
  const saved = await loadProject(projectDir);
  for (const format of ['srt', 'vtt']) {
    const output = join(root, `captions.${format}`);
    await exportSubtitles(saved, {format, outputPath: output});
    assert.ok((await readFile(output, 'utf8')).includes('Try ChatGPT\ntoday please'));
    assert.ok((await readFile(output, 'utf8')).includes(format === 'srt' ? '00:00:00,000 --> 00:00:02,000' : '00:00:00.000 --> 00:00:02.000'));
  }
  const fixed = prepareOperations(saved, [{type: 'set_caption_cues', cues: [{id: 'manual', text: 'Fixed', start: .2, end: 1}]}]);
  assert.equal(compileTimeline(fixed).captionCues[0].text, 'Fixed');
  assert.equal(compileTimeline(fixed).captionOverrideReview.active, false);
  const resumed = prepareOperations(fixed, [{type: 'set_caption_cues', cues: null}]);
  assert.ok(compileTimeline(resumed).captionCues[0].text.includes('ChatGPT'));
  await callTool('revision_restore', {projectDir, expectedRevision: 2, revision: 0});
  assert.equal((await loadProject(projectDir)).captions.wordOverrides, undefined);
});
