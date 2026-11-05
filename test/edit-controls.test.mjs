import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProject, applyOperations, prepareOperations, loadProject} from '../src/project.mjs';
import {compileTimeline} from '../src/timeline.mjs';
import {valueAt} from '../src/edit-controls.mjs';
import {volumeAt} from '../src/audio-settings.mjs';
import {analyzeCutBoundaries} from '../src/cut-review.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'engine-edit-controls-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = join(root, 'source.mp4'); await writeFile(source, 'immutable source');
  const dir = join(root, 'project');
  const project = await createProject(dir, {name: 'Editing controls', settings: {fps: 30, width: 160, height: 90},
    assets: [{id: 'a', type: 'video', path: source, duration: 20, hasAudio: true}],
    clips: [{id: 'one', assetId: 'a', sourceStart: 1, sourceEnd: 5}],
    transcripts: [{assetId: 'a', language: 'en', words: [{id: 'w', text: 'Original', start: 2, end: 3}]}], ...options});
  return {root, dir, source, project};
}
test('insert, replace and explicit gaps compile on the same clock and batch failures are atomic', async t => {
  const {dir, source} = await fixture(t);
  const project = await applyOperations(dir, {expectedRevision: 0, operations: [
    {type: 'insert_gap', index: 0, id: 'space', duration: .5},
    {type: 'insert_clip', index: 2, clip: {id: 'two', assetId: 'a', sourceStart: 5, sourceEnd: 7}},
    {type: 'replace_clip', clipId: 'one', clip: {id: 'replacement', assetId: 'a', sourceStart: 2, sourceEnd: 3}},
    {type: 'set_gap', clipId: 'space', duration: 1},
  ]});
  const timeline = compileTimeline(project);
  assert.deepEqual(timeline.clips.map(c => [c.id, c.from, c.durationInFrames]), [['space', 0, 30], ['replacement', 30, 30], ['two', 60, 60]]);
  assert.equal(timeline.durationInFrames, 120);
  assert.equal(timeline.captions[0].startFrame, 30);
  assert.equal(analyzeCutBoundaries(project).totalCuts, 1);
  await assert.rejects(applyOperations(dir, {expectedRevision: 1, operations: [
    {type: 'remove_clip', clipId: 'two'}, {type: 'insert_clip', index: 50, clip: project.clips[1]},
  ]}), {code: 'VALIDATION_ERROR'});
  assert.deepEqual(await loadProject(dir), project);
  assert.equal(await readFile(source, 'utf8'), 'immutable source');
});
test('transitions overlap real source ranges and reject triple overlaps, gaps and subframe joins', async t => {
  const {project} = await fixture(t);
  const clips = Array.from({length: 3}, (_, i) => ({id: `c${i}`, assetId: 'a', sourceStart: i * 4, sourceEnd: i * 4 + 4}));
  const edited = prepareOperations(project, [{type: 'set_clips', clips},
    {type: 'set_transition', clipId: 'c1', transition: {type: 'crossfade', duration: .5}},
    {type: 'set_transition', clipId: 'c2', transition: {type: 'wipe', duration: 1}}]);
  const timeline = compileTimeline(edited);
  assert.deepEqual(timeline.clips.map(c => [c.from, c.durationInFrames, c.transitionFrames]), [[0, 120, 0], [105, 120, 15], [195, 120, 30]]);
  assert.equal(timeline.durationInFrames, 315);
  assert.equal(timeline.clips[0].outgoingTransitionFrames, 15);
  const report = analyzeCutBoundaries(edited);
  assert.equal(report.cuts[0].outputFrame, 112);
  assert.equal(report.cuts[0].transition.endFrame, 120);
  for (const operations of [
    [{type: 'set_transition', clipId: 'c0', transition: {type: 'dip', duration: .5}}],
    [{type: 'set_transition', clipId: 'c2', transition: {type: 'dip', duration: 3.8}}],
    [{type: 'set_transition', clipId: 'c1', transition: {type: 'dip', duration: .01}}],
    [{type: 'insert_gap', index: 1, duration: .5}],
  ]) assert.throws(() => prepareOperations(edited, operations), {code: 'VALIDATION_ERROR'});
});
test('independent audio trim retains J and L timing and linked audio shares cumulative frame boundaries', async t => {
  const {project} = await fixture(t);
  const edited = prepareOperations(project, [{type: 'set_clips', clips: [
    {id: 'head', assetId: 'a', sourceStart: 0, sourceEnd: 2},
    {id: 'jl', assetId: 'a', sourceStart: 5, sourceEnd: 7, audio: {sourceStart: 4, sourceEnd: 8, offset: -.5}},
  ]}]);
  const timeline = compileTimeline(edited), c = timeline.clips[1];
  assert.deepEqual([c.from, c.audioFrom, c.audioSourceFrame, c.audioDurationInFrames], [60, 45, 120, 120]);
  assert.equal(timeline.durationInFrames, 165);
  const split = prepareOperations(edited, [{type: 'split_clip', clipId: 'jl', sourceTime: 6, newClipId: 'tail'}]);
  const sounds = compileTimeline(split).clips.slice(1);
  assert.equal(sounds[0].audioFrom, 45);
  assert.equal(sounds[0].audioFrom + sounds[0].audioDurationInFrames, sounds[1].audioFrom);
  assert.equal(sounds[1].audioFrom + sounds[1].audioDurationInFrames, 165);
  const clips = Array.from({length: 100}, (_, i) => ({id: `c${i}`, assetId: 'a', sourceStart: .1, sourceEnd: 1.113}));
  for (const c of compileTimeline(prepareOperations(project, [{type: 'set_clips', clips}])).clips) {
    assert.equal(c.audioFrom, c.from); assert.equal(c.audioDurationInFrames, c.durationInFrames);
  }
  const reset = prepareOperations(edited, [{type: 'set_clip_audio', clipId: 'jl', patch: null}]);
  assert.equal(compileTimeline(reset).durationInFrames, 120);
});
test('keyframes keep their trajectory when split or trimmed, and crop/focus validate before saving', async t => {
  const {project} = await fixture(t);
  const animated = prepareOperations(project, [{type: 'set_clip_visual', clipId: 'one', patch: {
    crop: {left: .25}, focus: {x: .75, y: .5}, motion: {x: [{time: 0, value: 0}, {time: 4, value: 100}]},
  }}]);
  const split = prepareOperations(animated, [{type: 'split_clip', clipId: 'one', sourceTime: 3, newClipId: 'tail'}]);
  assert.equal(valueAt(split.clips[0].motion.x, 2), 50);
  assert.equal(valueAt(split.clips[1].motion.x, split.clips[1].motionTimeOffset), 50);
  assert.equal(valueAt(split.clips[1].motion.x, 1 + split.clips[1].motionTimeOffset), 75);
  const trimmed = prepareOperations(animated, [{type: 'trim_clip', clipId: 'one', sourceStart: 2, sourceEnd: 4}]);
  assert.equal(valueAt(trimmed.clips[0].motion.x, trimmed.clips[0].motionTimeOffset), 25);
  assert.throws(() => prepareOperations(animated, [{type: 'set_clip_visual', clipId: 'one', patch: {crop: {left: .6, right: .4}}}]), {code: 'VALIDATION_ERROR'});
  assert.throws(() => prepareOperations(animated, [{type: 'set_clip_visual', clipId: 'one', patch: {motion: {x: [{time: 1, value: 1}, {time: 0, value: 2}]}}}]), {code: 'VALIDATION_ERROR'});
});
test('editable caption cues preserve source words and anchors, line breaks and reset to automatic pages', async t => {
  const {project} = await fixture(t);
  const edited = prepareOperations(project, [
    {type: 'set_caption_cues', cues: [{id: 'manual', start: .2, end: 1.2, text: 'Corrected\ncaption'}]},
    {type: 'upsert_overlay', overlay: {id: 'title', type: 'text', preset: 'callout', text: 'Here', start: 0, end: 1, anchor: {assetId: 'a', wordId: 'w'}}},
  ]);
  const timeline = compileTimeline(edited);
  assert.equal(timeline.captionCues[0].text, 'Corrected\ncaption');
  assert.deepEqual([timeline.captionCues[0].startFrame, timeline.captionCues[0].endFrame], [6, 36]);
  assert.equal(timeline.captions[0].text, 'Original');
  assert.equal(timeline.overlays[0].from, 30);
  assert.deepEqual(edited.transcripts, project.transcripts);
  const reset = prepareOperations(edited, [{type: 'set_caption_cues', cues: null}]);
  assert.equal(compileTimeline(reset).captionCues[0].text, 'Original');
  assert.throws(() => prepareOperations(edited, [{type: 'set_caption_cues', cues: [{id: 'x', start: 1, end: 0, text: 'bad'}]}]), {code: 'VALIDATION_ERROR'});
});
test('rounded overlaps, alternate audio bounds and frame-colliding captions reject unreachable saved states', async t => {
  const {project} = await fixture(t, {settings: {fps: 10, width: 160, height: 90}});
  assert.throws(() => prepareOperations(project, [{type: 'set_clips', clips: [
    {id: 'one', assetId: 'a', sourceStart: 0, sourceEnd: 1.04},
    {id: 'two', assetId: 'a', sourceStart: 2, sourceEnd: 3, transition: {type: 'crossfade', duration: .15}},
  ]}]), /actual output frames/);
  assert.throws(() => prepareOperations({...project, assets: [...project.assets, {...project.assets[0], id: 'short', duration: .5}]},
    [{type: 'set_clip_audio', clipId: 'one', patch: {assetId: 'short'}}]), /source duration/);
  assert.throws(() => prepareOperations(project, [{type: 'set_caption_cues', cues: [
    {id: 'a', start: 0, end: .01, text: 'One'}, {id: 'b', start: .01, end: .02, text: 'Two'},
  ]}]), /output frames/);
});
test('split retains nonlinear easing and audio gain curves, and spoken captions follow independent audio', async t => {
  const {project} = await fixture(t);
  const animated = prepareOperations(project, [{type: 'set_clip_visual', clipId: 'one', patch: {motion: {x: [{time: 0, value: 0, easing: 'easeInOut'}, {time: 4, value: 100}]}}},
    {type: 'set_clip_audio', clipId: 'one', patch: {fadeIn: 1, fadeOut: 1, envelope: [{time: 0, value: 1}, {time: 4, value: .2}]}}]);
  const split = prepareOperations(animated, [{type: 'split_clip', clipId: 'one', sourceTime: 2, newClipId: 'tail'}]);
  const tail = split.clips[1];
  for (const time of [.1, .7, 1.8, 2.9]) {
    assert.equal(valueAt(tail.motion.x, time + tail.motionTimeOffset), valueAt(animated.clips[0].motion.x, time + 1));
    assert.equal(volumeAt(tail.audio, time, 3), volumeAt(animated.clips[0].audio, time + 1, 4));
  }
  const refaded = prepareOperations(split, [{type: 'set_clip_audio', clipId: 'tail', patch: {fadeIn: .5}}]);
  assert.equal(volumeAt(refaded.clips[1].audio, 0, 3), 0, 'a newly requested fade starts at the new clip boundary');
  assert.equal(refaded.clips[1].audio.curveOffset, undefined);
  const detached = prepareOperations(project, [{type: 'set_clip_audio', clipId: 'one', patch: {sourceStart: 2, sourceEnd: 4, offset: .5}}]);
  const word = compileTimeline(detached).captions[0];
  assert.deepEqual([word.startFrame, word.endFrame], [15, 45], 'caption follows spoken audio rather than picture source trim');
  const alternate = {...project, assets: [...project.assets, {...project.assets[0], id: 'narration'}],
    transcripts: [...project.transcripts, {...project.transcripts[0], assetId: 'narration'}]};
  const anchored = prepareOperations(alternate, [{type: 'set_clip_audio', clipId: 'one', patch: {assetId: 'narration'}},
    {type: 'upsert_overlay', overlay: {id: 'spoken', type: 'text', text: 'Cue', start: 0, end: 1,
      anchor: {assetId: 'narration', wordId: 'w', clipId: 'one'}}}]);
  assert.equal(compileTimeline(anchored).overlays[0].from, 30);
});
