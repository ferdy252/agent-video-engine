import test from 'node:test';
import assert from 'node:assert/strict';
import {access, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileFingerprint, run, toolEnv} from '../src/media.mjs';

const root = resolve(import.meta.dirname, '..');
const exec = promisify(execFile);
const amplitudeDb = (rms) => 20 * Math.log10(Math.max(rms, 1e-12));

async function rms(file, start, duration) {
  const {stdout} = await exec('ffmpeg', ['-v', 'error', '-i', file,
    '-ss', String(start), '-t', String(duration), '-map', '0:a:0', '-vn',
    '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'],
  {encoding: 'buffer', env: toolEnv, maxBuffer: 4 * 1024 * 1024});
  assert.ok(stdout.length >= 4, 'The encoded export contains measurable audio samples');
  let squares = 0;
  for (let offset = 0; offset + 4 <= stdout.length; offset += 4) {
    const sample = stdout.readFloatLE(offset);
    assert.ok(Number.isFinite(sample));
    squares += sample * sample;
  }
  return Math.sqrt(squares / Math.floor(stdout.length / 4));
}

async function encodedLoudness(file) {
  const {stderr} = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file,
    '-map', '0:a:0', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']);
  const matches = [...stderr.matchAll(/\{[^{}]*"input_i"[^{}]*\}/gs)];
  assert.ok(matches.length, 'Measure the actual encoded AAC rather than a pre-encode estimate');
  const measured = JSON.parse(matches.at(-1)[0]);
  return {integratedLufs: Number(measured.input_i), truePeakDb: Number(measured.input_tp)};
}

test('real MCP finishes quiet/loud takes consistently, preserves manual controls and verifies encoded audio', {
  skip: process.env.AGENT_VIDEO_INTEGRATION !== '1', timeout: 240000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-audio-finish-'));
  const projectDir = join(directory, 'project');
  const silentProjectDir = join(directory, 'no-audio-project');
  const runtime = join(directory, 'runtime');
  const source = join(directory, 'quiet-and-loud-source.mp4');
  const noAudioSource = join(directory, 'picture-only-source.mp4');
  const manifest = join(projectDir, 'project.json');
  const client = new Client({name: 'audio-finish-check', version: '1.0.0'});
  const transport = new StdioClientTransport({command: process.execPath,
    args: [join(root, 'src/server.mjs')], env: {...toolEnv, VIDEO_ENGINE_RUNTIME: runtime}, stderr: 'pipe'});
  let blocker;
  const call = async (name, args) => {
    const response = await client.callTool({name, arguments: args});
    const value = JSON.parse(response.content.find((item) => item.type === 'text').text);
    if (response.isError) throw Object.assign(new Error(value.message), {code: value.code});
    return value;
  };
  const wait = async (started, target = projectDir) => {
    const deadline = Date.now() + 75000;
    while (Date.now() < deadline) {
      const job = await call('job_get', {projectDir: target, jobId: started.id, includePreview: false});
      assert.ok(Number.isFinite(job.progress), 'Audio finishing jobs retain finite progress');
      if (!['running', 'queued'].includes(job.status)) return job;
      await delay(100);
    }
    throw new Error(`Audio finishing job ${started.id} timed out`);
  };
  const render = async (expectedRevision, extras = {}, target = projectDir) => {
    const before = await readFile(join(target, 'project.json'), 'utf8');
    const job = await wait(await call('export_render', {projectDir: target, expectedRevision, ...extras}), target);
    assert.equal(job.status, 'completed', JSON.stringify(job.error));
    assert.equal(await readFile(join(target, 'project.json'), 'utf8'), before, 'Finishing does not rewrite the edit or its revision');
    return job.result;
  };
  const levels = async (file) => ({quiet: amplitudeDb(await rms(file, 0.5, 2)), loud: amplitudeDb(await rms(file, 3.5, 2))});
  try {
    // Source takes have the same waveform at different levels and a genuine
    // one-second source gap, so take-wide analysis must not merge them.
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n',
      '-f', 'lavfi', '-i', 'color=navy:s=160x90:r=10:d=8',
      '-f', 'lavfi', '-i', "aevalsrc=exprs='if(lt(t,3),0.08*sin(2*PI*440*t),if(between(t,4,7),0.25*sin(2*PI*440*t),0))':sample_rate=48000:duration=8",
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', source]);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi',
      '-i', 'color=teal:s=160x90:r=10:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', noAudioSource]);
    const sourceHash = await fileFingerprint(source);
    const noAudioHash = await fileFingerprint(noAudioSource);
    await client.connect(transport);
    const created = await call('project_create', {projectDir, name: 'Synthetic audio finishing', width: 160, height: 90, fps: 10});
    assert.equal(created.audio.enabled, false, 'Finishing is opt-in');
    const added = await call('media_add', {projectDir, expectedRevision: 0, path: source});
    const assetId = added.asset.id;
    await call('edit_apply', {projectDir, expectedRevision: 1, operations: [
      {type: 'set_clips', clips: [
        {id: 'quiet-take', assetId, sourceStart: 0, sourceEnd: 3},
        {id: 'loud-take', assetId, sourceStart: 4, sourceEnd: 7},
      ]},
      {type: 'set_captions', patch: {enabled: false}},
    ]});
    const originalEdit = await readFile(manifest, 'utf8');
    const baseline = await render(2);
    const baselineLevels = await levels(baseline.outputPath);
    const baselineGap = baselineLevels.loud - baselineLevels.quiet;
    assert.ok(baselineGap > 9, `The source fixture contains a real level difference (${baselineGap} dB)`);

    await call('edit_apply', {projectDir, expectedRevision: 2, operations: [
      {type: 'set_audio', patch: {enabled: true, targetLufs: -16, truePeakDb: -1.5, strength: 1,
        maxGainDb: 9, voiceGainDb: 0, outputGainDb: 0}},
    ]});
    const finished = await render(3);
    assert.equal(finished.audio.enabled, true);
    assert.equal(finished.audio.scope, 'full_timeline_master');
    assert.equal(finished.audio.encodedScope, 'requested_frame_range');
    assert.equal(finished.audio.peakSafety.passed, true);
    const finishedLevels = await levels(finished.outputPath);
    const finishedGap = Math.abs(finishedLevels.loud - finishedLevels.quiet);
    assert.ok(finishedGap < 3 && finishedGap < baselineGap - 6,
      `Finishing meaningfully levels retained takes (${baselineGap} dB before, ${finishedGap} dB after)`);
    const measured = await encodedLoudness(finished.outputPath);
    assert.ok(Number.isFinite(measured.integratedLufs));
    assert.ok(measured.truePeakDb <= -1.4, `Encoded true peak respects the -1.5 dB ceiling (${measured.truePeakDb})`);
    assert.ok(Math.abs(finished.audio.encoded.truePeakDb - measured.truePeakDb) <= 0.11,
      'The report measures the same encoded output returned to the user');

    const sourcePreview = await wait(await call('source_preview', {projectDir, expectedRevision: 3,
      assetId, sourceStart: 0, sourceEnd: 3, kind: 'preview', scale: 1}));
    assert.equal(sourcePreview.status, 'completed', JSON.stringify(sourcePreview.error));
    assert.equal(sourcePreview.result.audio.enabled, false);
    assert.ok(Math.abs(amplitudeDb(await rms(sourcePreview.result.outputPath, 0.5, 2)) - baselineLevels.quiet) < 0.4,
      'Source previews preserve original voice levels even when the saved edit enables finishing');

    const previewJob = await wait(await call('preview_render', {projectDir, expectedRevision: 3,
      kind: 'preview', fromFrame: 10, toFrame: 29, scale: 1}));
    assert.equal(previewJob.status, 'completed', JSON.stringify(previewJob.error));
    const fullQuietLevel = amplitudeDb(await rms(finished.outputPath, 1.3, 1.2));
    const previewQuietLevel = amplitudeDb(await rms(previewJob.result.outputPath, 0.3, 1.2));
    assert.ok(Math.abs(fullQuietLevel - previewQuietLevel) < 0.35,
      `A range preview uses the same full-project finish as the final export (${fullQuietLevel} vs ${previewQuietLevel} dB)`);

    await call('edit_apply', {projectDir, expectedRevision: 3, operations: [
      {type: 'set_audio', patch: {outputGainDb: -6}},
    ]});
    const quieter = await render(4);
    const quieterLevels = await levels(quieter.outputPath);
    for (const take of ['quiet', 'loud']) assert.ok(Math.abs(quieterLevels[take] - finishedLevels[take] + 6) < 0.4,
      `The manual master output control lowers the ${take} take by six dB`);

    await call('edit_apply', {projectDir, expectedRevision: 4, operations: [
      {type: 'set_audio', patch: {outputGainDb: 12}},
    ]});
    const boosted = await render(5);
    const boostedMeasurement = await encodedLoudness(boosted.outputPath);
    assert.ok(boostedMeasurement.truePeakDb <= -1.4,
      `The final AAC ceiling still holds with a strong manual output boost (${boostedMeasurement.truePeakDb})`);

    await call('edit_apply', {projectDir, expectedRevision: 5, operations: [
      {type: 'set_audio', patch: {enabled: false}},
      {type: 'set_clip_audio', clipId: 'quiet-take', patch: {leveling: false, gainDb: 6}},
    ]});
    const manual = await render(6);
    const manualLevels = await levels(manual.outputPath);
    assert.ok(Math.abs(manualLevels.quiet - baselineLevels.quiet - 6) < 0.4, 'Manual clip gain works with automatic finishing off');
    assert.ok(Math.abs(manualLevels.loud - baselineLevels.loud) < 0.4, 'Turning finishing off bypasses the global output gain');
    const inspected = await call('project_inspect', {projectDir});
    assert.equal(inspected.audio.enabled, false);
    assert.equal(inspected.clips[0].audio.gainDb, 6);
    assert.equal(inspected.clips[0].audio.leveling, false);

    const restored = await call('revision_restore', {projectDir, expectedRevision: 6, revision: 2});
    assert.equal(restored.revision, 7);
    assert.deepEqual(restored.clips, JSON.parse(originalEdit).clips, 'Undo restores the original per-clip controls');
    assert.equal(restored.audio.enabled, false);
    const restoredOutput = await render(7);
    const restoredLevels = await levels(restoredOutput.outputPath);
    for (const take of ['quiet', 'loud']) assert.ok(Math.abs(restoredLevels[take] - baselineLevels[take]) < 0.4,
      `Restoring the original revision restores the ${take} sound level`);

    await call('edit_apply', {projectDir, expectedRevision: 7, operations: [
      {type: 'set_clips', clips: [{id: 'silence', assetId, sourceStart: 3.2, sourceEnd: 3.8}]},
      {type: 'set_audio', patch: {enabled: true, outputGainDb: 0}},
    ]});
    const silent = await render(8);
    assert.ok(await rms(silent.outputPath, 0.1, 0.3) < 0.0001, 'Silent source spans are not amplified into noise');
    assert.equal(silent.audio.encoded.silent, true);

    await call('project_create', {projectDir: silentProjectDir, name: 'Picture without sound', width: 160, height: 90, fps: 10,
      audio: {enabled: true}});
    await call('media_add', {projectDir: silentProjectDir, expectedRevision: 0, path: noAudioSource, addToTimeline: true});
    const noAudio = await render(1, {}, silentProjectDir);
    assert.ok(await rms(noAudio.outputPath, 0.1, 0.7) < 0.0001, 'Missing source audio remains silent and renders successfully');
    assert.equal(noAudio.audio.voice.clips[0].status, 'missing_audio');
    assert.equal(noAudio.audio.encoded.silent, true);

    const beforeCancel = await readFile(manifest, 'utf8');
    const port = 49152 + createHash('sha256').update(runtime).digest().readUInt16BE(0) % 10000;
    blocker = createServer((socket) => socket.destroy());
    await new Promise((ready, reject) => {blocker.once('error', reject); blocker.listen(port, '127.0.0.1', ready);});
    const queued = await call('export_render', {projectDir, expectedRevision: 8});
    await delay(300);
    await call('job_cancel', {projectDir, jobId: queued.id});
    const cancelled = await wait(queued);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.result, undefined);
    await assert.rejects(access(cancelled.request.outputPath), {code: 'ENOENT'});
    assert.equal(await readFile(manifest, 'utf8'), beforeCancel);
    assert.equal(await fileFingerprint(source), sourceHash);
    assert.equal(await fileFingerprint(noAudioSource), noAudioHash);
  } finally {
    if (blocker) await new Promise((done) => blocker.close(done));
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await rm(directory, {recursive: true, force: true});
  }
});
