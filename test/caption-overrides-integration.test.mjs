import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {run, fileFingerprint, toolEnv} from '../src/media.mjs';
const exec = promisify(execFile);

test('real MCP renders corrected timed words and line breaks, exports matching subtitles and preserves source previews', {
  skip: process.env.AGENT_VIDEO_INTEGRATION !== '1', timeout: 120000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-caption-mcp-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const projectDir = join(directory, 'project'), source = join(directory, 'original.mp4');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=320x180:r=10:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source]);
  const originalHash = await fileFingerprint(source);
  const client = new Client({name: 'caption-test', version: '1'});
  const transport = new StdioClientTransport({command: process.execPath, args: [resolve('src/server.mjs')],
    env: {...toolEnv, VIDEO_ENGINE_RUNTIME: join(directory, 'runtime')}, stderr: 'pipe'});
  const call = async (name, args) => {
    const response = await client.callTool({name, arguments: args});
    if (response.isError) throw new Error(response.content[0].text);
    return JSON.parse(response.content[0].text);
  };
  const complete = async (name, args) => {
    const job = await call(name, {projectDir, ...args});
    for (let i = 0; i < 700; i++) {
      const current = await call('job_get', {projectDir, jobId: job.id, includePreview: false});
      if (current.status === 'completed') return current.result;
      if (!['running', 'queued'].includes(current.status)) throw new Error(JSON.stringify(current.error));
      await delay(100);
    }
    throw new Error('Caption integration job timed out');
  };
  try {
    await client.connect(transport);
    await call('project_create', {projectDir, name: 'Caption integration', width: 320, height: 180, fps: 10});
    const added = await call('media_add', {projectDir, expectedRevision: 0, path: source, addToTimeline: true});
    const assetId = added.asset.id, wordsPath = join(directory, 'words.json');
    await writeFile(wordsPath, JSON.stringify({words: [
      {id: 'a', text: 'Try', start: 1, end: 1.3}, {id: 'b', text: 'Chat', start: 1.4, end: 1.6},
      {id: 'c', text: 'GBT', start: 1.7, end: 2}, {id: 'd', text: 'today', start: 2.1, end: 2.6},
    ]}));
    await call('transcript_import', {projectDir, expectedRevision: 1, assetId, path: wordsPath});
    const before = await call('project_inspect', {projectDir, includeTimeline: true});
    await call('edit_apply', {projectDir, expectedRevision: 2, operations: [
      {type: 'set_caption_overrides', overrides: [{assetId, wordIds: ['b', 'c'], text: 'ChatGPT'}, {assetId, wordIds: ['d'], lineBreakBefore: true}]},
      {type: 'trim_clip', clipId: before.clips[0].id, sourceStart: 1, sourceEnd: 4},
      {type: 'set_captions', patch: {fontSize: 22, bottom: 20, color: '#ffffff', highlightColor: '#ff0000', wordsPerPage: 8}},
    ]});
    const movie = await complete('export_render', {expectedRevision: 3, minShortSide: 180});
    assert.equal(movie.quality.checks.captionOverrides.totalFindings, 0);
    const centers = [];
    for (const frame of [1, 5, 12]) {
      const {stdout: data} = await exec('ffmpeg', ['-v', 'error', '-i', movie.outputPath, '-vf', `select=eq(n\\,${frame})`,
        '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], {encoding: 'buffer', env: toolEnv});
      let count = 0, x = 0, y = 0;
      for (let i = 0; i < data.length; i += 3) if (data[i] > 160 && data[i + 1] < 90 && data[i + 2] < 90) {
        count++; x += (i / 3) % 320; y += Math.floor(i / 3 / 320);
      }
      assert.ok(count > 30, 'Active-word highlighting is actually rendered');
      centers.push([x / count, y / count]);
    }
    assert.ok(centers[1][0] > centers[0][0] + 30, 'Highlight moves from Try to the corrected ChatGPT');
    assert.ok(centers[2][1] > centers[1][1] + 15, 'The corrected line break renders today on the next row');
    const subtitles = await complete('export_subtitles', {expectedRevision: 3, format: 'srt', outputPath: 'captions.srt'});
    assert.ok((await readFile(subtitles.outputPath, 'utf8')).includes('Try ChatGPT\ntoday'));
    const preview = await complete('source_preview', {expectedRevision: 3, assetId, kind: 'still', sourceStart: 0, scale: 1});
    assert.equal(preview.kind, 'still');
    assert.equal(await fileFingerprint(source), originalHash);
    const final = await call('project_inspect', {projectDir, includeTimeline: true});
    assert.equal(final.timeline.captions[2].text, 'GBT');
    assert.equal(final.revision, 3);
  } finally {await client.close();}
});
