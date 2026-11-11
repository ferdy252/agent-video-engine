import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanSpeechGaps, transcriptSpeechCoverage} from '../src/speech-gaps.mjs';
import {buildExportQuality, verifyExportQuality} from '../src/export-quality.mjs';
import {compileTimeline} from '../src/timeline.mjs';
import {fileFingerprint, run} from '../src/media.mjs';
import {renderProject} from '../src/render.mjs';
import {createProject, applyOperations} from '../src/project.mjs';
import {probeAsset} from '../src/media.mjs';

const makeProject = (path, extra = {}) => ({revision: 2, settings: {width: 160, height: 90, fps: 10},
  assets: [{id: 'camera', path, type: 'video', width: 160, height: 90, duration: 10, hasAudio: true}],
  clips: [{id: 'continuous-take', assetId: 'camera', sourceStart: 0, sourceEnd: 10}],
  overlays: [], transcripts: [], captions: {enabled: false}, ...extra});

async function fixture(t, expression, {stereo = false} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'engine-speech-scan-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const path = join(directory, 'export.mp4');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=160x90:r=10:d=10',
    '-f', 'lavfi', '-i', `aevalsrc=${expression}:s=16000:d=10${stereo ? ':c=stereo' : ''}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path]);
  return path;
}

test('full-file scan finds leading, internal and trailing gaps far from joins', async t => {
  const path = await fixture(t, '.3*sin(2*PI*440*t)*between(t,1,4)+.3*sin(2*PI*440*t)*between(t,7,9)'.replaceAll(',', '\\,'));
  const fingerprint = await fileFingerprint(path), project = makeProject(path);
  const result = await scanSpeechGaps(path, {project, duration: 10});
  assert.equal(result.status, 'completed');
  assert.equal(result.scope, 'entire_encoded_file');
  assert.ok(result.decodedAudioSeconds >= 9.99);
  const gaps = result.findings.filter(x => x.code === 'QUIET_AUDIO_GAP');
  assert.equal(gaps.length, 3);
  for (const [i, [start, end]] of [[0, 1], [4, 7], [9, 10]].entries()) {
    assert.ok(Math.abs(gaps[i].startSeconds - start) < .08);
    assert.ok(Math.abs(gaps[i].endSeconds - end) < .08);
  }
  assert.equal(await fileFingerprint(path), fingerprint);
  const report = await buildExportQuality({filePath: path, project, kind: 'video', composition: {...project.settings, durationInFrames: 100},
    dimensions: {width: 160, height: 90}, frameRange: [0, 99], scale: 1, minShortSide: 90});
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.status, 'needs_review');
  assert.ok(report.warnings.some(warning => warning.code === 'SPEECH_GAPS_REVIEW_REQUIRED'));
  await writeFile(`${path}.quality.json`, JSON.stringify(report));
  const verified = await verifyExportQuality(path);
  assert.equal(verified.verification.fingerprintMatches, true);
  assert.equal(verified.verification.verifiedFinal, false);
  assert.deepEqual(verified.checks.speechGaps.findings, report.checks.speechGaps.findings);
});

test('measured word intervals expose possible speech gaps even under continuous music', async t => {
  const path = await fixture(t, '.3*sin(2*PI*440*t)');
  const project = makeProject(path, {transcripts: [{assetId: 'camera', words: [
    {id: 'one', text: 'one', start: 0, end: 3}, {id: 'two', text: 'two', start: 6, end: 10},
  ]}]});
  const result = await scanSpeechGaps(path, {project, duration: 10});
  assert.deepEqual(result.findings.map(x => [x.code, x.startSeconds, x.endSeconds]), [['TRANSCRIPT_SPEECH_GAP', 3, 6]]);
  assert.equal(result.transcriptCoverage.assessedSeconds, 10);
  assert.equal((await scanSpeechGaps(path, {project, duration: 10, minGapSeconds: 4})).totalFindings, 0);
});

test('stereo audio is not downmixed into false silence and cancellation does not publish a report', async t => {
  const path = await fixture(t, '.3*sin(2*PI*440*t)|-.3*sin(2*PI*440*t)', {stereo: true});
  const project = makeProject(path);
  const result = await scanSpeechGaps(path, {project, duration: 10});
  assert.equal(result.totalFindings, 0);
  assert.equal(result.transcriptCoverage.unassessedTrackCount, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(scanSpeechGaps(path, {project, duration: 10, signal: controller.signal}), {name: 'AbortError'});
});

test('speech coverage follows replacement audio, retiming, offsets and voice overlays', () => {
  const project = makeProject('/unused', {assets: [
    {id: 'camera', type: 'video', hasAudio: false, width: 160, height: 90},
    {id: 'voice', type: 'audio', hasAudio: true},
  ], clips: [{id: 'picture', assetId: 'camera', sourceStart: 0, sourceEnd: 10, playbackRate: 2,
    audio: {assetId: 'voice', sourceStart: 10, sourceEnd: 20, offset: 1}}],
  transcripts: [{assetId: 'voice', words: [{id: 'a', start: 10, end: 12}, {id: 'b', start: 16, end: 20}]}]});
  let coverage = transcriptSpeechCoverage(project, compileTimeline(project), {start: 0, duration: 6});
  assert.deepEqual(coverage.gaps, [{start: 2, end: 4}]);
  project.overlays = [{id: 'extra-voice', assetId: 'voice', type: 'audio', start: 2, end: 4, sourceStart: 10, audio: {role: 'voice'}}];
  coverage = transcriptSpeechCoverage(project, compileTimeline(project), {start: 0, duration: 6});
  assert.deepEqual(coverage.gaps, []);
  // Point timestamps cannot be treated as measured speech duration.
  project.transcripts[0].words[0].end = 10;
  coverage = transcriptSpeechCoverage(project, compileTimeline(project), {start: 0, duration: 6});
  assert.deepEqual(coverage.gaps, []);
  assert.equal(coverage.unassessedTrackCount, 2);
});

test('actual final rendering automatically flags enlargement and a mid-take gap without separate tool calls', {
  skip: process.env.AGENT_VIDEO_RENDER_SMOKE !== '1', timeout: 90000,
}, async t => {
  const source = await fixture(t, '.3*sin(2*PI*440*t)*(lt(t,3)+gt(t,6))'.replaceAll(',', '\\,'));
  const projectDir = join(source, '..', 'project'), outputPath = join(source, '..', 'final.mp4');
  const created = await createProject(projectDir, {name: 'Automatic checks', settings: {width: 320, height: 180, fps: 10}});
  const asset = await probeAsset(source);
  const project = await applyOperations(projectDir, {expectedRevision: created.revision, operations: [
    {type: 'add_asset', asset}, {type: 'set_clips', clips: [{id: 'continuous', assetId: asset.id, sourceStart: 0, sourceEnd: 10}]},
  ]});
  const hash = await fileFingerprint(source);
  const result = await renderProject(project, {kind: 'video', outputPath, minShortSide: 180});
  assert.equal(result.quality.status, 'needs_review');
  assert.ok(result.quality.checks.framing.findings.some(x => x.maxUpscale === 2));
  assert.ok(result.quality.checks.speechGaps.findings.some(x => x.startSeconds > 2.9 && x.endSeconds < 6.1));
  assert.equal(result.quality.checks.speechGaps.scope, 'entire_encoded_file');
  assert.equal((await verifyExportQuality(outputPath)).verification.verifiedFinal, false);
  assert.equal(await fileFingerprint(source), hash);
});
