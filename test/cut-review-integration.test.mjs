import test from 'node:test';
import assert from 'node:assert/strict';
import {access, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, relative, resolve, sep} from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {run, toolEnv} from '../src/media.mjs';

const root = resolve(import.meta.dirname, '..');
const exec = promisify(execFile);
const digest = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');

test('real MCP cut review checks source joins, audio, bounded previews and immutable project state', {
  skip: process.env.AGENT_VIDEO_INTEGRATION !== '1', timeout: 120000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-cut-review-'));
  const projectDir = join(directory, 'project');
  const runtime = join(directory, 'runtime');
  const source = join(directory, 'original.mp4');
  const client = new Client({name: 'cut-review-check', version: '1.0.0'});
  const transport = new StdioClientTransport({command: process.execPath,
    args: [join(root, 'src/server.mjs')], env: {...toolEnv, VIDEO_ENGINE_RUNTIME: runtime}, stderr: 'pipe'});
  let blocker;
  const call = async (name, args) => {
    const response = await client.callTool({name, arguments: args});
    const result = JSON.parse(response.content[0].text);
    if (response.isError) throw Object.assign(new Error(result.message ?? response.content[0].text), {code: result.code});
    return result;
  };
  const waitJob = async (started) => {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const job = await call('job_get', {projectDir, jobId: started.id, includePreview: false});
      assert.ok(Number.isFinite(job.progress), 'Job progress is numeric');
      if (!['queued', 'running'].includes(job.status)) return job;
      await delay(100);
    }
    throw new Error(`Cut-review job ${started.id} timed out`);
  };
  const completed = async (request) => {
    const job = await waitJob(await call('review_cuts', {projectDir, ...request}));
    assert.equal(job.status, 'completed', JSON.stringify(job.error));
    assert.equal(job.type, 'review_cuts');
    return job.result;
  };
  const pixel = async (path, time) => {
    const {stdout} = await exec('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', path,
      '-vf', 'crop=2:2:2:2', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
    {encoding: 'buffer', env: toolEnv});
    return [...stdout.subarray(0, 3)];
  };
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n',
      '-f', 'lavfi', '-i', 'color=red:s=160x90:r=20:d=1',
      '-f', 'lavfi', '-i', 'color=blue:s=160x90:r=20:d=1',
      '-f', 'lavfi', '-i', 'aevalsrc=if(lt(t\\,0.8)\\,0.02*sin(2*PI*440*t)\\,0.5*sin(2*PI*440*t)):s=48000:d=2',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
    const originalHash = await digest(source);
    await client.connect(transport);
    const reviewTool = (await client.listTools()).tools.find((tool) => tool.name === 'review_cuts');
    assert.ok(reviewTool, 'The MCP client can discover cut review');
    assert.ok(reviewTool.inputSchema.required.includes('expectedRevision'));
    await call('project_create', {projectDir, name: 'Synthetic cut review', width: 160, height: 90, fps: 20});
    const added = await call('media_add', {projectDir, expectedRevision: 0, path: source, addToTimeline: true});
    const assetId = added.asset.id;
    const transcriptPath = join(directory, 'words.json');
    await writeFile(transcriptPath, JSON.stringify({language: 'en', words: [
      {id: 'first', text: 'Before', start: 0.15, end: 0.35},
      {id: 'crossing-left', text: 'Clipped', start: 0.45, end: 0.75},
      {id: 'crossing-right', text: 'Boundary', start: 0.95, end: 1.2},
      {id: 'last', text: 'After', start: 1.25, end: 1.5},
    ]}));
    await call('transcript_import', {projectDir, expectedRevision: 1, assetId, path: transcriptPath});
    await call('edit_apply', {projectDir, expectedRevision: 2, operations: [
      {type: 'set_clips', clips: [
        {id: 'left-take', assetId, sourceStart: 0.1, sourceEnd: 0.6},
        {id: 'right-take', assetId, sourceStart: 1, sourceEnd: 1.6},
      ]},
      {type: 'set_captions', patch: {fontSize: 8, bottom: 1}},
    ]});
    const manifestPath = join(projectDir, 'project.json');
    const manifestBefore = await readFile(manifestPath, 'utf8');
    await assert.rejects(call('review_cuts', {projectDir, expectedRevision: 2}), {code: 'STALE_REVISION'});
    assert.equal((await call('job_list', {projectDir})).length, 0, 'Stale requests do not queue work');

    const report = await completed({expectedRevision: 3, contextSeconds: 1, renderPreviews: true});
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.revision, 3);
    assert.equal(report.fps, 20);
    assert.equal(report.totalCuts, 1);
    assert.equal(report.reviewedCuts, 1);
    assert.equal(report.hasMore, false);
    assert.equal(report.cuts.length, 1);
    const cut = report.cuts[0];
    assert.equal(cut.outputFrame, 10);
    assert.equal(cut.outputTime, 0.5);
    assert.equal(cut.left.clipId, 'left-take');
    assert.equal(cut.left.assetId, assetId);
    assert.equal(cut.left.sourceTime, 0.6);
    assert.equal(cut.right.clipId, 'right-take');
    assert.equal(cut.right.assetId, assetId);
    assert.equal(cut.right.sourceTime, 1);
    const wordFlag = cut.flags.find((flag) => flag.code === 'CUT_INSIDE_WORD');
    assert.ok(wordFlag, 'Transcript source boundaries expose the deliberately clipped word');
    assert.match(JSON.stringify(wordFlag.evidence), /crossing-left/);
    assert.ok(cut.flags.some((flag) => flag.code === 'AUDIO_LEVEL_JUMP'));
    assert.equal(cut.audio.status, 'analyzed');
    assert.ok(cut.audio.levelJumpDb > 20, `Synthetic low/high join should be detected: ${cut.audio.levelJumpDb}`);
    assert.equal(cut.preview.fromFrame, 0);
    assert.equal(cut.preview.toFrame, 21);
    assert.equal(cut.preview.cutFrameInPreview, 10);
    assert.equal(cut.preview.cutTimeInPreview, 0.5);
    assert.deepEqual(cut.preview.frameRange, [0, 21]);
    const beforeJoin = await pixel(cut.preview.outputPath, 0.25);
    const afterJoin = await pixel(cut.preview.outputPath, 0.7);
    assert.ok(beforeJoin[0] > 200 && beforeJoin[2] < 40, `Preview starts with retained red take: ${beforeJoin}`);
    assert.ok(afterJoin[2] > 200 && afterJoin[0] < 40, `Preview crosses to retained blue take: ${afterJoin}`);
    await access(report.reportPath);
    const persisted = JSON.parse(await readFile(report.reportPath, 'utf8'));
    assert.equal(persisted.revision, report.revision);
    assert.deepEqual(persisted.cuts.map((entry) => entry.id), report.cuts.map((entry) => entry.id));
    assert.ok(relative(projectDir, report.reportPath).startsWith(`.engine${sep}`), 'Review artifacts stay under local project state');
    const ignore = await readFile(join(root, '.gitignore'), 'utf8');
    assert.match(ignore, /^\.engine\/?\s*$/m, 'Generated review state is excluded from the public repository');
    assert.equal(await readFile(manifestPath, 'utf8'), manifestBefore, 'Review does not write project state or revisions');
    assert.equal(await digest(source), originalHash, 'Review never changes original media');

    const port = 49152 + createHash('sha256').update(runtime).digest().readUInt16BE(0) % 10000;
    blocker = createServer((socket) => socket.destroy());
    await new Promise((ready, reject) => {blocker.once('error', reject); blocker.listen(port, '127.0.0.1', ready);});
    const queued = await call('review_cuts', {projectDir, expectedRevision: 3, renderPreviews: true});
    await delay(300);
    await call('job_cancel', {projectDir, jobId: queued.id});
    const cancelled = await waitJob(queued);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.result, undefined);
    await new Promise((done) => blocker.close(done));
    blocker = undefined;

    const customEntry = join(directory, 'custom.tsx');
    await writeFile(customEntry, '// Not executed: unsupported review must reject before queuing.\n');
    await call('edit_apply', {projectDir, expectedRevision: 3, operations: [
      {type: 'set_custom', custom: {entryPoint: customEntry, compositionId: 'Custom'}},
    ]});
    const jobsBeforeRejection = (await call('job_list', {projectDir})).length;
    await assert.rejects(call('review_cuts', {projectDir, expectedRevision: 4}), {code: 'UNSUPPORTED_CUSTOM_REVIEW'});
    assert.equal((await call('job_list', {projectDir})).length, jobsBeforeRejection,
      'Unsupported custom compositions are rejected before queuing');
    await call('edit_apply', {projectDir, expectedRevision: 4, operations: [
      {type: 'set_custom', custom: null},
      {type: 'set_clips', clips: [{id: 'continuous', assetId, sourceStart: 0.1, sourceEnd: 1.6}]},
    ]});
    const noCutManifest = await readFile(manifestPath, 'utf8');
    const noCuts = await completed({expectedRevision: 5, renderPreviews: false});
    assert.equal(noCuts.totalCuts, 0);
    assert.equal(noCuts.reviewedCuts, 0);
    assert.deepEqual(noCuts.cuts, []);
    assert.equal(noCuts.hasMore, false);
    assert.equal(await readFile(manifestPath, 'utf8'), noCutManifest);
    assert.equal(await digest(source), originalHash);
  } finally {
    if (blocker) await new Promise((done) => blocker.close(done));
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await rm(directory, {recursive: true, force: true});
  }
});
