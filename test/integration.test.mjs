import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, mkdir, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {run, fileFingerprint, toolEnv} from '../src/media.mjs';
import {normalizeTranscript} from '../src/transcribe.mjs';
import {getJob, jobDir, saveJob} from '../src/jobs.mjs';
import {bundle} from '../src/bundle.mjs';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');

test('custom projects pinned to another Remotion version require an explicit migration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'engine-version-'));
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({dependencies: {remotion: '4.0.538'}}));
    await assert.rejects(bundle({entryPoint: join(dir, 'entry.ts'), outDir: join(dir, 'out')}), /Migrate explicitly/);
  } finally {await rm(dir, {recursive: true, force: true});}
});

test('native point-timed words survive normalization and fingerprints use file content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'engine-content-'));
  try {
    const a = join(dir, 'a'), b = join(dir, 'b');
    await writeFile(a, 'same-size-A'); await writeFile(b, 'same-size-B');
    assert.notEqual(await fileFingerprint(a), await fileFingerprint(b));
    const result = normalizeTranscript({transcription: [{text: 'hello', offsets: {from: 100, to: 100}}]}, 'camera');
    assert.deepEqual(result.words, [{id: 'w0', text: 'hello', start: 0.1, end: 0.1}]);
    assert.deepEqual(result.timingReviewWordIds, ['w0']);
    const rounded = normalizeTranscript([{text: 'last', start: 0.8, end: 1.02}], 'camera', {duration: 1});
    assert.equal(rounded.words[0].end, 1);
    assert.deepEqual(rounded.timingReviewWordIds, ['w0']);
    assert.throws(() => normalizeTranscript([{text: 'bad', start: 0.8, end: 1.3}], 'camera', {duration: 1}), /beyond/);
    assert.throws(() => normalizeTranscript([{text: 'bad', start: 2, end: 1}], 'camera'), /timing/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('durable job reads preserve completed results and detect a stopped worker', async () => {
  const project = await mkdtemp(join(tmpdir(), 'engine-jobs-'));
  const id = '12345678-1234-1234-1234-123456789abc', dir = jobDir(project, id);
  try {
    await mkdir(dir, {recursive: true});
    await writeFile(join(dir, 'pid'), '99999999');
    await saveJob(dir, {id, status: 'completed', result: {outputPath: '/example/video.mp4'}});
    assert.equal((await getJob(project, id)).result.outputPath, '/example/video.mp4');
    await saveJob(dir, {id, status: 'running', createdAt: new Date().toISOString()});
    assert.equal((await getJob(project, id)).status, 'interrupted');
  } finally { await rm(project, {recursive: true, force: true}); }
});

test('real MCP: import, source preview, edit, caption, export, undo and queue cancellation', {
  skip: process.env.AGENT_VIDEO_INTEGRATION !== '1', timeout: 120000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'engine-mcp-'));
  const projectDir = join(dir, 'project'), runtime = join(dir, 'runtime'), source = join(dir, 'original.mp4');
  const client = new Client({name: 'engine-check', version: '1.0.0'});
  const transport = new StdioClientTransport({command: process.execPath, args: [join(root, 'src/server.mjs')],
    env: {...toolEnv, VIDEO_ENGINE_RUNTIME: runtime}, stderr: 'pipe'});
  let blocker;
  const call = async (name, args) => {
    const response = await client.callTool({name, arguments: args});
    if (response.isError) throw new Error(response.content[0].text);
    return JSON.parse(response.content[0].text);
  };
  const waitJob = async job => {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const current = await call('job_get', {projectDir, jobId: job.id, includePreview: false});
      assert.ok(Number.isFinite(current.progress), 'finite progress');
      if (!['running', 'queued'].includes(current.status)) return current;
      await delay(100);
    }
    throw new Error('Job timed out');
  };
  const pixel = async path => {
    const {stdout} = await exec('ffmpeg', ['-v', 'error', '-i', path, '-vf', 'crop=2:2:2:2', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {encoding: 'buffer', env: toolEnv});
    return [...stdout.subarray(0, 3)];
  };
  try {
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=160x90:r=20:d=1', '-f', 'lavfi', '-i', 'color=blue:s=160x90:r=20:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
    const originalHash = await fileFingerprint(source);
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'source_preview'));
    const created = await call('project_create', {projectDir, name: 'Synthetic integration', width: 160, height: 90, fps: 20});
    assert.equal(created.revision, 0);
    const added = await call('media_add', {projectDir, expectedRevision: 0, path: source, addToTimeline: true});
    const assetId = added.asset.id;
    const transcriptPath = join(dir, 'words.json');
    await writeFile(transcriptPath, JSON.stringify({words: [{id: 'red', word: 'Red', start: 0.1, end: 0.6}, {id: 'blue', word: 'Blue', start: 1.1, end: 1.6}], language: 'en'}));
    await call('transcript_import', {projectDir, expectedRevision: 1, assetId, path: transcriptPath});
    await call('edit_apply', {projectDir, expectedRevision: 2, operations: [
      {type: 'delete_source_range', assetId, start: 0, end: 1},
      {type: 'set_captions', patch: {fontSize: 12, bottom: 2, wordsPerPage: 2}},
      {type: 'upsert_overlay', overlay: {id: 'title', type: 'text', text: 'Engine', start: 0, end: 0.3,
        anchor: {assetId, wordId: 'blue'}, style: {fontSize: 10, top: 20, height: 20}}},
    ]});
    const inspected = await call('project_inspect', {projectDir, includeTimeline: true});
    assert.equal(inspected.timeline.durationInFrames, 20);
    assert.equal(inspected.timeline.captions[0].text, 'Blue');
    assert.equal(inspected.timeline.captions[0].startFrame, 2);
    assert.equal(inspected.timeline.overlays[0].from, 2);
    const originalPreview = await waitJob(await call('source_preview', {projectDir, expectedRevision: 3, assetId, kind: 'still', sourceStart: 0, sourceEnd: 0.8, scale: 1}));
    assert.equal(originalPreview.status, 'completed', JSON.stringify(originalPreview.error));
    const red = await pixel(originalPreview.result.outputPath);
    assert.ok(red[0] > 200 && red[2] < 40, `source preview is original red frame: ${red}`);
    const editedPreview = await waitJob(await call('preview_render', {projectDir, expectedRevision: 3, kind: 'still', frame: 4, scale: 1}));
    assert.equal(editedPreview.status, 'completed', JSON.stringify(editedPreview.error));
    const blue = await pixel(editedPreview.result.outputPath);
    assert.ok(blue[2] > 200 && blue[0] < 40, `edited preview is kept blue frame: ${blue}`);
    const exported = await waitJob(await call('export_render', {projectDir, expectedRevision: 3}));
    assert.equal(exported.status, 'completed', JSON.stringify(exported.error));
    assert.equal(exported.result.verification.frames, 20);
    assert.equal(exported.result.verification.audio, true);
    assert.equal(exported.result.quality.purpose, 'final');
    assert.equal(exported.result.quality.status, 'needs_review', 'A small final must carry a delivery warning');
    const checkedFinal = await call('export_verify', {outputPath: exported.result.outputPath});
    assert.equal(checkedFinal.verification.verifiedFinal, false);
    assert.equal(checkedFinal.status, 'needs_review');
    assert.equal(await fileFingerprint(source), originalHash);
    const restored = await call('revision_restore', {projectDir, expectedRevision: 3, revision: 2});
    assert.equal(restored.revision, 4);
    assert.equal((await call('project_inspect', {projectDir})).durationInFrames, 40);
    const port = 49152 + createHash('sha256').update(runtime).digest().readUInt16BE(0) % 10000;
    blocker = createServer(socket => socket.destroy());
    await new Promise((ready, reject) => {blocker.once('error', reject); blocker.listen(port, '127.0.0.1', ready);});
    const queued = await call('preview_render', {projectDir, expectedRevision: 4, kind: 'still', scale: 1});
    await delay(300);
    await call('job_cancel', {projectDir, jobId: queued.id});
    const cancelled = await waitJob(queued);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.result, undefined);
  } finally {
    if (blocker) await new Promise(done => blocker.close(done));
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await rm(dir, {recursive: true, force: true});
  }
});
