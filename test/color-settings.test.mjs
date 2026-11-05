import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProject, loadProject, applyOperations, restoreRevision, listRevisions} from '../src/project.mjs';
import {compileTimeline} from '../src/timeline.mjs';
import {analyzeCutBoundaries} from '../src/cut-review.mjs';
import {callTool} from '../src/api.mjs';
import {
  DEFAULT_COLOR_SETTINGS, COLOR_LIMITS, validateColorSettings, resolveColorSettings,
  isColorCorrectionActive, colorTransform, applyColorPatch,
} from '../src/color-settings.mjs';

test('partial settings accept only finite supported fields and inclusive bounds', () => {
  assert.equal(validateColorSettings({}), true);
  assert.equal(validateColorSettings({brightness: 0, contrast: 3, saturation: 0, temperature: -1, tint: 1, enabled: false}), true);
  for (const value of [null, [], new Date(), 'warm', 1, undefined,
    {brightness: NaN}, {contrast: Infinity}, {saturation: -0.1}, {brightness: 3.01},
    {temperature: 1.01}, {tint: -1.01}, {enabled: 1}, {brightness: null}, {enabled: undefined},
    {exposure: 1}, JSON.parse('{"__proto__": {"brightness": 2}}')]) {
    assert.throws(() => validateColorSettings(value), {code: 'VALIDATION_ERROR'});
  }
  const symbolic = {[Symbol('unknown')]: 1};
  assert.throws(() => validateColorSettings(symbolic), {code: 'VALIDATION_ERROR'});
  assert.deepEqual(COLOR_LIMITS.brightness, [0, 3]);
  assert.ok(Object.isFrozen(DEFAULT_COLOR_SETTINGS));
});

test('defaults, asset corrections and clip overrides resolve without source mutation', () => {
  const asset = Object.freeze({brightness: 1.2, saturation: 0.9, temperature: 0.3});
  const clip = Object.freeze({saturation: 1.1, contrast: 1.05});
  const resolved = resolveColorSettings(undefined, asset, clip);
  assert.deepEqual(resolved, {enabled: true, brightness: 1.2, contrast: 1.05, saturation: 1.1, temperature: 0.3, tint: 0});
  resolved.brightness = 2;
  assert.equal(asset.brightness, 1.2);
  assert.equal(DEFAULT_COLOR_SETTINGS.brightness, 1);
  assert.throws(() => resolveColorSettings(asset, null), {code: 'VALIDATION_ERROR'});
});

test('neutral or disabled settings bypass correction while disabled values remain stored', () => {
  assert.equal(isColorCorrectionActive(), false);
  assert.equal(isColorCorrectionActive({brightness: 1, temperature: 0}), false);
  assert.deepEqual(colorTransform(), {filter: '', rgbGains: [1, 1, 1]});
  const stored = {enabled: false, brightness: 1.8, contrast: 0.5, temperature: 0.8, tint: -0.5};
  assert.equal(isColorCorrectionActive(stored), false);
  assert.deepEqual(colorTransform(stored), {filter: '', rgbGains: [1, 1, 1]});
  assert.equal(stored.brightness, 1.8);
  assert.equal(resolveColorSettings(stored).temperature, 0.8);
  assert.equal(isColorCorrectionActive(resolveColorSettings(stored, {enabled: true})), true);
});

test('nonneutral CSS controls retain order and white balance produces relative RGB gains', () => {
  const transform = colorTransform({brightness: 1.2, contrast: 0.8, saturation: 1.4, temperature: 0.5, tint: -0.2});
  assert.equal(transform.filter, 'brightness(1.2) contrast(0.8) saturate(1.4)');
  const expected = [1.08, 1.03, 0.88];
  transform.rgbGains.forEach((gain, index) => assert.ok(Math.abs(gain - expected[index]) < 1e-12));
  assert.equal(colorTransform({temperature: -0.5}).filter, '');
  assert.equal(isColorCorrectionActive({temperature: -0.5}), true);
  assert.equal(colorTransform({saturation: 0}).filter, 'saturate(0)');
});

test('field reset exposes inheritance and whole reset removes only local settings', () => {
  const asset = {brightness: 1.3, temperature: 0.4};
  const clip = Object.freeze({brightness: 1.1, contrast: 1.2, temperature: -0.2});
  const reset = applyColorPatch(clip, {brightness: null, temperature: null});
  assert.deepEqual(reset, {contrast: 1.2});
  assert.deepEqual(resolveColorSettings(asset, reset), {...DEFAULT_COLOR_SETTINGS, brightness: 1.3, temperature: 0.4, contrast: 1.2});
  assert.equal(applyColorPatch(clip, null), undefined);
  assert.equal(applyColorPatch({brightness: 2}, {brightness: null}), undefined);
  assert.equal(applyColorPatch(undefined, {}), undefined);
  assert.deepEqual(clip, {brightness: 1.1, contrast: 1.2, temperature: -0.2});
});

test('invalid patches never mutate a partially patched current object', () => {
  const current = {brightness: 1.1, tint: 0.2};
  for (const patch of [{brightness: 1.5, tint: 4}, {enabled: null, unknown: null}, undefined, [], {brightness: undefined}]) {
    assert.throws(() => applyColorPatch(current, patch), {code: 'VALIDATION_ERROR'});
    assert.deepEqual(current, {brightness: 1.1, tint: 0.2});
  }
  assert.deepEqual(applyColorPatch(current, {enabled: false}), {brightness: 1.1, tint: 0.2, enabled: false});
});

async function projectFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-video-color-settings-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const source = join(directory, 'source.mp4');
  const image = join(directory, 'image.png');
  const audio = join(directory, 'audio.wav');
  await Promise.all([writeFile(source, 'synthetic source bytes'), writeFile(image, 'synthetic image bytes'), writeFile(audio, 'synthetic audio bytes')]);
  const projectDir = join(directory, 'project');
  const project = await createProject(projectDir, {assets: [
    {id: 'video', path: source, type: 'video', duration: 4, fps: 30, hasAudio: true},
    {id: 'image', path: image, type: 'image', duration: 0},
    {id: 'audio', path: audio, type: 'audio', duration: 4, hasAudio: true},
  ], clips: [{id: 'main', assetId: 'video', sourceStart: 0, sourceEnd: 4}],
  overlays: [{id: 'picture', type: 'image', assetId: 'image', start: 0, end: 1}]});
  return {project, projectDir, source};
}

test('older projects remain neutral and asset colors inherit into clips and overlays without source edits', async (t) => {
  const {project, projectDir, source} = await projectFixture(t);
  assert.ok(project.assets.every((asset) => asset.color === undefined));
  assert.equal(project.clips[0].color, undefined);
  assert.deepEqual(compileTimeline(await loadProject(projectDir)).clips[0].color, DEFAULT_COLOR_SETTINGS);
  const updated = await applyOperations(projectDir, {expectedRevision: 0, operations: [
    {type: 'set_asset_color', assetId: 'video', patch: {brightness: 1.3, temperature: 0.4}},
    {type: 'set_asset_color', assetId: 'image', patch: {saturation: 0}},
    {type: 'set_clip_color', clipId: 'main', patch: {contrast: 1.2, brightness: 0.8}},
  ]});
  assert.equal(updated.revision, 1);
  const timeline = compileTimeline(updated);
  assert.deepEqual(timeline.clips[0].color, {...DEFAULT_COLOR_SETTINGS, brightness: 0.8, contrast: 1.2, temperature: 0.4});
  assert.equal(timeline.overlays[0].color.saturation, 0);
  assert.equal(updated.assets[0].path, source);
  assert.equal(await readFile(source, 'utf8'), 'synthetic source bytes');
});

test('clip color overrides survive splitting, reset to inheritance and restore with revisions', async (t) => {
  const {projectDir, source} = await projectFixture(t);
  await applyOperations(projectDir, {expectedRevision: 0, operations: [
    {type: 'set_asset_color', assetId: 'video', patch: {brightness: 1.3}},
    {type: 'set_clip_color', clipId: 'main', patch: {brightness: 0.8, temperature: -0.2}},
    {type: 'split_clip', clipId: 'main', sourceTime: 2, newClipId: 'second'},
  ]});
  let project = await loadProject(projectDir);
  assert.deepEqual(project.clips.map((clip) => clip.color), [
    {brightness: 0.8, temperature: -0.2}, {brightness: 0.8, temperature: -0.2}]);
  project = await applyOperations(projectDir, {expectedRevision: 1, operations: [
    {type: 'set_clip_color', clipId: 'second', patch: {brightness: null, temperature: null}},
  ]});
  assert.equal(project.clips[1].color, undefined);
  assert.equal(project.clips[0].color.brightness, 0.8);
  assert.equal(compileTimeline(project).clips[1].color.brightness, 1.3);
  project = await restoreRevision(projectDir, {expectedRevision: 2, revision: 1});
  assert.equal(project.revision, 3);
  assert.equal(project.clips[1].color.brightness, 0.8);
  project = await applyOperations(projectDir, {expectedRevision: 3, operations: [
    {type: 'set_asset_color', assetId: 'video', patch: null},
    {type: 'set_clip_color', clipId: 'main', patch: null},
    {type: 'set_clip_color', clipId: 'second', patch: null},
  ]});
  assert.equal(project.assets[0].color, undefined);
  assert.deepEqual(compileTimeline(project).clips[0].color, DEFAULT_COLOR_SETTINGS);
  assert.deepEqual((await listRevisions(projectDir)).map((entry) => entry.revision), [0, 1, 2, 3, 4]);
  assert.equal(await readFile(source, 'utf8'), 'synthetic source bytes');
});

test('invalid color batches, audio grades and stale revisions cannot persist partial edits', async (t) => {
  const {projectDir} = await projectFixture(t);
  const file = join(projectDir, 'project.json');
  const before = await readFile(file, 'utf8');
  await assert.rejects(applyOperations(projectDir, {expectedRevision: 0, operations: [
    {type: 'set_asset_color', assetId: 'video', patch: {brightness: 1.2}},
    {type: 'set_clip_color', clipId: 'main', patch: {temperature: 2}},
  ]}), {code: 'VALIDATION_ERROR'});
  await assert.rejects(applyOperations(projectDir, {expectedRevision: 0, operations: [
    {type: 'set_asset_color', assetId: 'audio', patch: {brightness: 1.2}},
  ]}), {code: 'VALIDATION_ERROR'});
  await assert.rejects(applyOperations(projectDir, {expectedRevision: 0, operations: [
    {type: 'set_clips', clips: [{id: 'voice', assetId: 'audio', sourceStart: 0, sourceEnd: 1}]},
    {type: 'set_clip_color', clipId: 'voice', patch: {saturation: 0}},
  ]}), {code: 'VALIDATION_ERROR'});
  await assert.rejects(callTool('edit_apply', {projectDir, expectedRevision: 0, operations: [
    {type: 'set_asset_color', assetId: 'video', patch: {exposure: 2}},
  ]}));
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal((await listRevisions(projectDir)).length, 1);
  await callTool('edit_apply', {projectDir, expectedRevision: 0, operations: [
    {type: 'set_asset_color', assetId: 'video', patch: {brightness: 1.2}},
  ]});
  await assert.rejects(applyOperations(projectDir, {expectedRevision: 0, operations: [
    {type: 'set_clip_color', clipId: 'main', patch: {brightness: 0.8}},
  ]}), {code: 'REVISION_CONFLICT'});
});

test('cut review includes a contiguous split only when its actual visible color transform changes', async (t) => {
  const {projectDir} = await projectFixture(t);
  let project = await applyOperations(projectDir, {expectedRevision: 0, operations: [
    {type: 'split_clip', clipId: 'main', sourceTime: 2, newClipId: 'second'},
  ]});
  assert.equal(analyzeCutBoundaries(project).totalCuts, 0);
  project = await applyOperations(projectDir, {expectedRevision: 1, operations: [
    {type: 'set_clip_color', clipId: 'second', patch: {brightness: 1.3}},
  ]});
  assert.equal(analyzeCutBoundaries(project).totalCuts, 1);
  project = await applyOperations(projectDir, {expectedRevision: 2, operations: [
    {type: 'set_clip_color', clipId: 'main', patch: {enabled: false, temperature: -0.4}},
    {type: 'set_clip_color', clipId: 'second', patch: {enabled: false, brightness: 1.3}},
  ]});
  assert.equal(analyzeCutBoundaries(project).totalCuts, 0);
});
