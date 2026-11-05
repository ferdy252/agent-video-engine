import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileFingerprint, run, toolEnv} from '../src/media.mjs';

const exec = promisify(execFile);
const engine = resolve(import.meta.dirname, '..');

test('real MCP relinks an original and renders a moved portable custom project', {
  skip: process.env.AGENT_VIDEO_INTEGRATION !== '1', timeout: 120000,
}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'engine-portability-mcp-')));
  const originals = join(root, 'originals');
  const projectDir = join(root, 'project');
  const publicDir = join(originals, 'public');
  const source = join(originals, 'source.mp4');
  const entryPoint = join(originals, 'layer.tsx');
  const bundleDir = join(root, 'bundle');
  const destination = join(root, 'new-project');
  const runtime = join(root, 'runtime');
  let blocker;
  const client = new Client({name: 'portability-check', version: '1.0.0'});
  const transport = new StdioClientTransport({command: process.execPath,
    args: [join(engine, 'src/server.mjs')], env: {...toolEnv, VIDEO_ENGINE_RUNTIME: runtime}, stderr: 'pipe'});
  const call = async (name, args) => {
    const response = await client.callTool({name, arguments: args});
    const result = JSON.parse(response.content.find((item) => item.type === 'text').text);
    if (response.isError) throw Object.assign(new Error(result.message), {code: result.code});
    return result;
  };
  const wait = async (dir, id, status = 'completed') => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const job = await call('job_get', {projectDir: dir, jobId: id, includePreview: false});
      if (!['queued', 'running'].includes(job.status)) {
        assert.equal(job.status, status, JSON.stringify(job.error));
        return job.result;
      }
      await delay(100);
    }
    throw new Error(`Job ${id} timed out`);
  };
  try {
    await mkdir(publicDir, {recursive: true});
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', source]);
    const originalFingerprint = await fileFingerprint(source);
    await writeFile(join(publicDir, 'marker.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="20"><rect width="24" height="20" fill="#00ff00"/></svg>');
    const fixtureBytes = Buffer.alloc(3 * 1024 * 1024, 0x42);
    await writeFile(join(publicDir, 'synthetic-data.bin'), fixtureBytes);
    await writeFile(join(originals, 'palette.ts'), "export const color = '#ff0000';");
    await writeFile(join(originals, 'layer.css'), '.portable-marker { position: absolute; width: 24px; height: 20px; left: 4px; top: 4px; }');
    await writeFile(entryPoint, `import {Img, staticFile} from 'remotion';
import {color} from './palette';
import './layer.css';
export default function Layer() {
  return <>
    <div className="portable-marker" style={{backgroundColor: color}}/>
    <Img src={staticFile('marker.svg')} style={{position:'absolute', top:4, left:36, width:24, height:20}}/>
  </>;
}`);
    await client.connect(transport);
    await call('project_create', {projectDir, name: 'Synthetic portable layer', width: 160, height: 90, fps: 10});
    const added = await call('media_add', {projectDir, expectedRevision: 0, path: source, addToTimeline: true});
    const movedSource = join(originals, 'relocated.mp4');
    await rename(source, movedSource);
    assert.equal((await call('project_inspect', {projectDir})).revision, 1);
    assert.equal((await call('media_relink', {projectDir, expectedRevision: 1,
      replacements: [{assetId: added.asset.id, path: movedSource}]})).revision, 2);
    await call('edit_apply', {projectDir, expectedRevision: 2, operations: [
      {type: 'set_custom', custom: {mode: 'layer', entryPoint, publicDir}},
    ]});
    const manifest = join(projectDir, 'project.json');
    const saved = await readFile(manifest);
    const exportJob = await call('project_bundle', {projectDir, expectedRevision: 3, bundleDir});
    const bundled = await wait(projectDir, exportJob.id);
    assert.equal(bundled.revision, 3);
    assert.equal(bundled.customBundled, true);
    assert.deepEqual(await readFile(manifest), saved);
    assert.equal(await fileFingerprint(movedSource), originalFingerprint);
    const movedBundle = join(root, 'transferred');
    await rename(bundleDir, movedBundle);
    await rm(originals, {recursive: true});
    const port = 49152 + createHash('sha256').update(runtime).digest().readUInt16BE(0) % 10000;
    blocker = createServer((socket) => socket.destroy());
    await new Promise((ready, reject) => {blocker.once('error', reject); blocker.listen(port, '127.0.0.1', ready);});
    const pending = await call('project_open_bundle', {projectDir: destination, bundleDir: movedBundle});
    assert.equal(pending.destinationProjectDir, destination);
    assert.notEqual(pending.projectDir, destination);
    assert.equal(pending.status, 'queued');
    await call('job_cancel', {projectDir: pending.projectDir, jobId: pending.id});
    assert.equal(await wait(pending.projectDir, pending.id, 'cancelled'), undefined);
    await assert.rejects(access(destination), {code: 'ENOENT'});
    await new Promise((done) => blocker.close(done));
    blocker = null;
    const restarted = await call('job_retry', {projectDir: pending.projectDir, jobId: pending.id});
    assert.notEqual(restarted.id, pending.id);
    const opened = await wait(restarted.projectDir, restarted.id);
    assert.equal(opened.revision, 3);
    assert.equal(opened.projectDir, destination);
    const restored = await call('project_inspect', {projectDir: destination});
    assert.equal(restored.assets[0].id, added.asset.id);
    assert.equal(await fileFingerprint(restored.assets[0].path), originalFingerprint);
    assert.equal(restored.custom.mode, 'layer');
    assert.deepEqual(await readFile(join(restored.custom.publicDir, 'synthetic-data.bin')), fixtureBytes);
    const preview = await call('preview_render', {projectDir: destination, expectedRevision: 3, kind: 'still', frame: 3, scale: 1});
    const {outputPath} = await wait(destination, preview.id);
    const {stdout} = await exec('ffmpeg', ['-v', 'error', '-i', outputPath, '-vf', 'format=rgb24',
      '-frames:v', '1', '-f', 'rawvideo', '-'], {encoding: 'buffer', env: toolEnv});
    assert.equal(stdout.length, 160 * 90 * 3);
    const pixel = (x, y) => [...stdout.subarray((y * 160 + x) * 3, (y * 160 + x) * 3 + 3)];
    assert.deepEqual(pixel(12, 12), [255, 0, 0], 'The local TS helper and CSS appear in the reopened render');
    assert.deepEqual(pixel(44, 12), [0, 255, 0], 'The declared public SVG appears in the reopened render');
    assert.ok(pixel(100, 50)[2] > 230, 'The copied source video appears in the reopened render');
  } finally {
    if (blocker) await new Promise((done) => blocker.close(done));
    await client.close().catch(() => {});
    await rm(root, {recursive: true, force: true});
  }
});
