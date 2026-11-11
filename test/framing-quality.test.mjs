import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {analyzeFraming} from '../src/framing-quality.mjs';
import {callTool} from '../src/api.mjs';
import {run} from '../src/media.mjs';

const project = (clip = {}, extra = {}) => ({revision: 0, settings: {width: 1080, height: 1920, fps: 30},
  assets: [{id: 'camera', type: 'video', width: 1280, height: 720, duration: 10, hasAudio: true}],
  clips: [{id: 'take', assetId: 'camera', sourceStart: 1, sourceEnd: 5, ...clip}],
  overlays: [], transcripts: [], captions: {enabled: false}, ...extra});

test('cover crop finds hidden source enlargement while contain preserves pixel density', () => {
  const cover = analyzeFraming(project({fit: 'cover'}));
  assert.equal(cover.totalFindings, 1);
  assert.equal(cover.findings[0].maxUpscale, 2.667);
  assert.equal(cover.findings[0].sourceSeconds, 1);
  assert.equal(cover.findings[0].worstFrame, 0);
  assert.equal(analyzeFraming(project({fit: 'contain'})).totalFindings, 0);
  assert.equal(analyzeFraming(project({fit: 'cover', position: {x: 0, y: 0, width: 480, height: 270}})).totalFindings, 0);
});

test('animated enlargement uses actual frames, hold boundaries and trim offsets', () => {
  const motion = {scale: [{time: 0, value: 1, easing: 'hold'}, {time: 1, value: 4}, {time: 2, value: 1}]};
  const report = analyzeFraming(project({motion}));
  assert.equal(report.findings[0].worstFrame, 30);
  assert.equal(report.findings[0].maxUpscale, 3.375);
  assert.equal(report.findings[0].sourceSeconds, 2);
  const trimmed = analyzeFraming(project({motion, motionTimeOffset: 1, sourceStart: 2}));
  assert.equal(trimmed.findings[0].worstFrame, 0);
  assert.equal(trimmed.findings[0].sourceSeconds, 2);
  assert.equal(analyzeFraming(project({motion}), {frameRange: [60, 90]}).totalFindings, 0);
  const future = {scale: [{time: 0, value: 1, easing: 'hold'}, {time: 20, value: 100}]};
  assert.equal(analyzeFraming(project({motion: future})).totalFindings, 0);
  const fading = {scale: [{time: 0, value: 10}, {time: 1, value: 1}], opacity: [{time: 0, value: 0}, {time: 1, value: 1}]};
  assert.equal(analyzeFraming(project({motion: fading})).findings[0].worstFrame, 1);
});

test('explicit crops, overlays, source rotation and non-square pixels are accounted for', () => {
  const cropped = analyzeFraming(project({crop: {left: .4, right: .4}}));
  assert.equal(cropped.findings[0].maxUpscale, 2.667); // contain on expanded element, matching renderer
  const p = project({}, {overlays: [{id: 'pic', assetId: 'camera', type: 'video', start: 1, end: 2,
    style: {width: '100%', height: '100%', objectFit: 'cover'}}]});
  assert.equal(analyzeFraming(p).findings[0].itemId, 'pic');
  p.overlays[0].style.transform = 'scale(2)';
  assert.equal(analyzeFraming(p).findings[0].code, 'FRAMING_UNASSESSED');
  const rotated = project({fit: 'cover'}, {assets: [{id: 'camera', type: 'video', width: 1920, height: 1080, rotation: 90}]});
  assert.equal(analyzeFraming(rotated).totalFindings, 0);
  const sar = project({fit: 'contain'}, {settings: {width: 1920, height: 1080, fps: 30},
    assets: [{id: 'camera', type: 'video', width: 960, height: 1080, sampleAspectRatio: 2}]});
  assert.equal(analyzeFraming(sar).findings[0].maxUpscale, 2);
});

test('custom code and unknown layout are unassessed, and pagination retains total findings', () => {
  const p = project({fit: 'cover'}, {custom: {mode: 'layer'}});
  const report = analyzeFraming(p, {limit: 1});
  assert.equal(report.unassessedCount, 1);
  assert.equal(report.totalFindings, 2);
  assert.equal(report.truncated, true);
  assert.equal(analyzeFraming(p, {offset: 1}).findings[0].code, 'EXCESSIVE_UPSCALE');
  p.custom.mode = 'composition';
  assert.equal(analyzeFraming(p).assessedCount, 0);
});

test('MCP preflight inspects a draft and preset without saving or touching originals', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-framing-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const source = join(directory, 'source.mp4'), projectDir = join(directory, 'project');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=160x90:r=10:d=1', '-c:v', 'libx264', source]);
  await callTool('project_create', {projectDir, name: 'Framing', width: 160, height: 90, fps: 10});
  const added = await callTool('media_add', {projectDir, expectedRevision: 0, path: source, addToTimeline: true});
  const saved = await callTool('project_inspect', {projectDir});
  const draft = await callTool('draft_stage', {projectDir, expectedRevision: 1, operations: [
    {type: 'set_clip_visual', clipId: saved.clips[0].id, patch: {motion: {scale: [{time: 0, value: 2}]}}},
  ]});
  const sourceBytes = await readFile(source);
  assert.equal((await callTool('quality_preflight', {projectDir, expectedRevision: 1})).totalFindings, 0);
  const result = await callTool('quality_preflight', {projectDir, expectedRevision: 1, draftId: draft.id});
  assert.equal(result.findings[0].maxUpscale, 2);
  assert.equal(result.findings[0].assetId, added.asset.id);
  assert.ok((await callTool('quality_preflight', {projectDir, expectedRevision: 1, preset: 'vertical', fit: 'cover'})).totalFindings > 0);
  assert.deepEqual(await callTool('project_inspect', {projectDir}), saved);
  assert.deepEqual(await readFile(source), sourceBytes);
  await assert.rejects(callTool('quality_preflight', {projectDir, expectedRevision: 0}), {code: 'STALE_REVISION'});
});
