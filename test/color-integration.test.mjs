import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileFingerprint, run, toolEnv} from '../src/media.mjs';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const width = 160;
const height = 90;

async function pixels(file, frame) {
  const filter = frame === undefined ? 'format=rgb24' : `select=eq(n\\,${frame}),format=rgb24`;
  const {stdout} = await exec('ffmpeg', ['-v', 'error', '-i', file, '-vf', filter,
    '-frames:v', '1', '-f', 'rawvideo', '-'], {encoding: 'buffer', env: toolEnv});
  assert.equal(stdout.length, width * height * 3);
  return stdout;
}

function pixel(image, x, y) {
  const offset = (y * width + x) * 3;
  return [...image.subarray(offset, offset + 3)];
}

function closePixel(actual, expected, tolerance = 3, message = 'Pixel matches the requested appearance') {
  assert.ok(actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance),
    `${message}. Actual ${actual}, expected ${expected}`);
}

test('real MCP applies inherited source color, preserves graphics and compares one exact edit frame', {
  skip: process.env.AGENT_VIDEO_INTEGRATION !== '1', timeout: 180000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-color-controls-'));
  const projectDir = join(directory, 'project');
  const source = join(directory, 'gray-source-with-color-patch.mp4');
  const transcriptPath = join(directory, 'words.json');
  const manifest = join(projectDir, 'project.json');
  const client = new Client({name: 'color-controls-check', version: '1.0.0'});
  const transport = new StdioClientTransport({command: process.execPath,
    args: [join(root, 'src/server.mjs')], env: {...toolEnv, VIDEO_ENGINE_RUNTIME: join(directory, 'runtime')}, stderr: 'pipe'});
  const request = (name, args) => client.callTool({name, arguments: args});
  const parse = (response) => {
    const value = JSON.parse(response.content.find((item) => item.type === 'text').text);
    if (response.isError) throw Object.assign(new Error(value.message), {code: value.code});
    return value;
  };
  const call = async (name, args) => parse(await request(name, args));
  const wait = async (started) => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const job = await call('job_get', {projectDir, jobId: started.id, includePreview: false});
      assert.ok(Number.isFinite(job.progress));
      if (!['running', 'queued'].includes(job.status)) return job;
      await delay(100);
    }
    throw new Error(`Color job ${started.id} timed out`);
  };
  const complete = async (name, args) => {
    const before = await readFile(manifest, 'utf8');
    const started = await call(name, {projectDir, ...args});
    const job = await wait(started);
    assert.equal(job.status, 'completed', JSON.stringify(job.error));
    assert.equal(await readFile(manifest, 'utf8'), before, 'Rendering a color preview preserves the saved edit');
    return {started, result: job.result};
  };
  const still = async (expectedRevision, frame = 5) => {
    const {result} = await complete('preview_render', {expectedRevision, kind: 'still', frame, scale: 1});
    return pixels(result.outputPath);
  };
  const edit = (expectedRevision, operations) => call('edit_apply', {projectDir, expectedRevision, operations});
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi',
      '-i', 'color=c=0x404040:s=160x90:r=10:d=4',
      '-vf', 'drawbox=x=0:y=24:w=32:h=24:color=0xc04020:t=fill',
      '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', '-an', source]);
    const sourceHash = await fileFingerprint(source);
    const raw = await pixels(source, 15);
    const rawGray = pixel(raw, 80, 35);
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'color_preview'));
    await call('project_create', {projectDir, name: 'Synthetic source color', width, height, fps: 10});
    const added = await call('media_add', {projectDir, expectedRevision: 0, path: source});
    const assetId = added.asset.id;
    await writeFile(transcriptPath, JSON.stringify({language: 'en', words: [
      {id: 'caption-word', text: 'HI', start: 0.05, end: 2.95},
    ]}));
    await call('transcript_import', {projectDir, expectedRevision: 1, assetId, path: transcriptPath});
    await edit(2, [
      {type: 'set_clips', clips: [
        {id: 'first', assetId, sourceStart: 0, sourceEnd: 1},
        {id: 'middle', assetId, sourceStart: 1, sourceEnd: 2},
        {id: 'last', assetId, sourceStart: 2, sourceEnd: 3},
      ]},
      {type: 'set_captions', patch: {fontSize: 14, bottom: 2, wordsPerPage: 1}},
      {type: 'upsert_overlay', overlay: {id: 'graphic', type: 'text', text: 'X', start: 0, end: 3,
        style: {left: 4, top: 4, width: 24, height: 16, color: '#00ff00', backgroundColor: '#00ff00', fontSize: 1}}},
      {type: 'upsert_overlay', overlay: {id: 'timing-marker', type: 'text', text: 'X', start: 1, end: 2,
        style: {left: 40, top: 4, width: 24, height: 16, color: '#ff00ff', backgroundColor: '#ff00ff', fontSize: 1}}},
      {type: 'upsert_overlay', overlay: {id: 'same-source-overlay', type: 'video', assetId, sourceStart: 0,
        start: 0, end: 3, volume: 0, style: {left: 112, top: 4, width: 32, height: 18}}},
      {type: 'set_asset_color', assetId, patch: {brightness: 0.5}},
      {type: 'set_clip_color', clipId: 'middle', patch: {brightness: 1.5}},
      {type: 'set_clip_color', clipId: 'last', patch: {enabled: false}},
    ]);
    const savedColorEdit = JSON.parse(await readFile(manifest, 'utf8'));
    const pair = await complete('color_preview', {expectedRevision: 3, frame: 15, scale: 1});
    assert.equal(pair.result.kind, 'color_comparison');
    assert.equal(pair.result.revision, 3);
    assert.equal(pair.result.frame, 15);
    for (const result of [pair.result.before, pair.result.after]) {
      assert.equal(result.frame, 15);
      assert.equal(result.revision, 3);
      assert.equal(result.width, width);
      assert.equal(result.height, height);
      assert.ok(result.outputPath.includes(`${sep}.engine${sep}color-previews${sep}${pair.started.id}${sep}`));
    }
    const images = await request('job_get', {projectDir, jobId: pair.started.id, includePreview: true});
    const inline = images.content.filter((item) => item.type === 'image');
    assert.equal(inline.length, 2);
    for (const image of inline) {
      assert.equal(image.mimeType, 'image/png');
      assert.equal(Buffer.from(image.data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    }
    assert.deepEqual(inline.map((image) => image.data), [
      (await readFile(pair.result.before.outputPath)).toString('base64'),
      (await readFile(pair.result.after.outputPath)).toString('base64'),
    ], 'MCP images preserve the documented Before then After order');
    const before = await pixels(pair.result.before.outputPath);
    const after = await pixels(pair.result.after.outputPath);
    closePixel(pixel(before, 80, 35), rawGray, 3, 'Before bypasses both asset and clip controls');
    closePixel(pixel(after, 80, 35), rawGray.map((value) => Math.round(value * 1.5)), 4,
      'The middle clip overrides the asset multiplier');
    closePixel(pixel(before, 50, 10), [255, 0, 255]);
    closePixel(pixel(after, 50, 10), [255, 0, 255], 3, 'Both comparison images render the requested timed marker');
    closePixel(pixel(before, 12, 10), [0, 255, 0]);
    closePixel(pixel(after, 12, 10), [0, 255, 0], 3, 'Ordinary graphics retain their own color');
    let captionPixels = 0;
    for (let y = 60; y < 88; y++) for (let x = 50; x < 110; x++) {
      const color = pixel(before, x, y);
      if (color[0] === 255 && color[1] === 222 && color[2] === 89) {
        closePixel(pixel(after, x, y), color, 1, 'Caption text retains its intended color');
        captionPixels++;
      }
    }
    assert.ok(captionPixels > 3, 'The comparison actually includes visible caption pixels');

    const first = await still(3, 5);
    closePixel(pixel(first, 80, 35), rawGray.map((value) => Math.round(value * 0.5)), 4,
      'The first retained use inherits source color');
    const last = await still(3, 25);
    closePixel(pixel(last, 80, 35), rawGray, 3, 'A disabled clip bypasses inherited source correction');
    closePixel(pixel(last, 128, 12), rawGray.map((value) => Math.round(value * 0.5)), 4,
      'The same source in a media overlay still inherits its asset correction');
    const originalPreview = await complete('source_preview', {expectedRevision: 3, assetId,
      sourceStart: 1.5, sourceEnd: 2, kind: 'still', scale: 1});
    closePixel(pixel(await pixels(originalPreview.result.outputPath), 80, 35), rawGray, 3,
      'Source previews show original source color');
    const exported = await complete('export_render', {expectedRevision: 3});
    closePixel(pixel(await pixels(exported.result.outputPath, 15), 80, 35), pixel(after, 80, 35), 7,
      'The final encoded video uses the same correction as the saved preview');

    await edit(3, [{type: 'set_clip_color', clipId: 'middle', patch: {brightness: null}}]);
    const inherited = await still(4, 15);
    closePixel(pixel(inherited, 80, 35), pixel(first, 80, 35), 3, 'Clearing one override exposes the current source setting');
    const inheritedProject = await call('project_inspect', {projectDir});
    assert.ok(!Object.hasOwn(inheritedProject.clips[1].color ?? {}, 'brightness'));
    await edit(4, [{type: 'set_clip_color', clipId: 'last', patch: null}]);
    closePixel(pixel(await still(5, 25), 80, 35), pixel(first, 80, 35), 3,
      'Resetting the complete clip override restores inheritance');
    await edit(5, [{type: 'set_asset_color', assetId, patch: null}]);
    closePixel(pixel(await still(6), 80, 35), rawGray, 3, 'Resetting source controls restores neutral footage');

    await edit(6, [{type: 'set_asset_color', assetId, patch: {temperature: 0.8}}]);
    const warm = pixel(await still(7), 80, 35);
    assert.ok(warm[0] > warm[2] + 5, `A warmer setting shifts neutral source pixels toward red (${warm})`);
    await edit(7, [{type: 'set_asset_color', assetId, patch: {temperature: 0, tint: 0.8}}]);
    const magenta = pixel(await still(8), 80, 35);
    assert.ok(magenta[0] > magenta[1] + 4 && magenta[2] > magenta[1] + 4,
      `Positive tint shifts neutral source pixels toward magenta (${magenta})`);
    await edit(8, [{type: 'set_asset_color', assetId, patch: {tint: 0, saturation: 0}}]);
    const desaturated = pixel(await still(9), 16, 36);
    assert.ok(Math.max(...desaturated) - Math.min(...desaturated) <= 3,
      `Zero saturation desaturates an actual colored source patch (${desaturated})`);

    const restored = await call('revision_restore', {projectDir, expectedRevision: 9, revision: 3});
    assert.equal(restored.revision, 10);
    assert.deepEqual(restored.assets, savedColorEdit.assets);
    assert.deepEqual(restored.clips, savedColorEdit.clips);
    closePixel(pixel(await still(10, 15), 80, 35), pixel(after, 80, 35), 3,
      'Undo restores the saved source and clip appearance');

    const standaloneEntry = join(directory, 'standalone.tsx');
    await writeFile(standaloneEntry, `import React from 'react';
import {AbsoluteFill, Composition, registerRoot} from 'remotion';
const Picture = () => <AbsoluteFill style={{backgroundColor:'#804080'}}/>;
registerRoot(() => <Composition id="Standalone" component={Picture} width={160} height={90} fps={10} durationInFrames={10}/>);
`);
    await edit(10, [{type: 'set_custom', custom: {mode: 'composition', entryPoint: standaloneEntry, compositionId: 'Standalone'}}]);
    const rejected = await wait(await call('export_render', {projectDir, expectedRevision: 11}));
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.error.code, 'UNSUPPORTED_CUSTOM_COLOR');
    await edit(11, [
      {type: 'set_asset_color', assetId, patch: null},
      {type: 'set_clip_color', clipId: 'middle', patch: null},
      {type: 'set_clip_color', clipId: 'last', patch: null},
    ]);
    const neutralStandalone = await complete('export_render', {expectedRevision: 12});
    assert.equal(neutralStandalone.result.compositionId, 'Standalone');
    await edit(12, [
      {type: 'set_clips', clips: []},
      ...['graphic', 'timing-marker', 'same-source-overlay'].map((overlayId) => ({type: 'remove_overlay', overlayId})),
      {type: 'set_asset_color', assetId, patch: {brightness: 0.7}},
    ]);
    const assetOnlyRejected = await wait(await call('preview_render', {projectDir, expectedRevision: 13,
      kind: 'still', frame: 0, scale: 1}));
    assert.equal(assetOnlyRejected.status, 'failed');
    assert.equal(assetOnlyRejected.error.code, 'UNSUPPORTED_CUSTOM_COLOR',
      'Standalone code may use assets directly even when the engine timeline has no clips');
    await edit(13, [{type: 'set_asset_color', assetId, patch: {enabled: false}}]);
    const disabledStandalone = await complete('preview_render', {expectedRevision: 14, kind: 'still', frame: 0, scale: 1});
    assert.equal(disabledStandalone.result.compositionId, 'Standalone', 'A saved disabled grade preserves standalone compatibility');
    assert.equal(await fileFingerprint(source), sourceHash, 'Color edits preserve original source bytes');
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await rm(directory, {recursive: true, force: true});
  }
});
