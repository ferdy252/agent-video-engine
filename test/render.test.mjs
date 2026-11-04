import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createProject} from '../src/project.mjs';
import {renderProject, startAssetServer} from '../src/render.mjs';

const exec = promisify(execFile);
async function scratch(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-video-render-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}

test('media server exposes only registered assets and serves seek ranges', async (t) => {
  const directory = await scratch(t);
  const file = path.join(directory, 'private clip.mp4');
  await writeFile(file, '0123456789');
  const server = await startAssetServer([{id: 'clip/one', path: file, type: 'video'}]);
  t.after(() => server.close());
  const url = server.assets[0].src;
  assert.equal(server.assets[0].path, undefined);
  const range = await fetch(url, {headers: {Range: 'bytes=2-5'}});
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await range.text(), '2345');
  const suffix = await fetch(url, {headers: {Range: 'bytes=-3'}});
  assert.equal(await suffix.text(), '789');
  const head = await fetch(url, {method: 'HEAD'});
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');
  assert.equal((await fetch(url, {headers: {Range: 'bytes=20-30'}})).status, 416);
  assert.equal((await fetch(new URL('/etc/passwd', url))).status, 404);
  assert.equal((await fetch(`${url}/../other.mp4`)).status, 404);
  assert.equal((await fetch(url, {method: 'POST', body: 'upload'})).status, 405);
  assert.equal(await readFile(file, 'utf8'), '0123456789');
});

test('render rejects relative outputs and cancellation before work starts', async () => {
  await assert.rejects(renderProject({}, {outputPath: 'relative.mp4'}), /absolute/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(renderProject({}, {outputPath: '/tmp/not-rendered.mp4', signal: controller.signal}), {name: 'AbortError'});
});

test('custom public media serves registered symlinks without copying or exposing siblings', async (t) => {
  const directory = await scratch(t);
  const publicDir = path.join(directory, 'public');
  await mkdir(publicDir);
  const original = path.join(directory, 'outside-original.txt');
  await writeFile(original, 'registered linked media');
  await symlink(original, path.join(publicDir, 'linked.txt'));
  await writeFile(path.join(publicDir, '.private'), 'hidden');
  await symlink(publicDir, path.join(publicDir, 'cycle'));
  const server = await startAssetServer([], {publicDir});
  t.after(() => server.close());
  assert.deepEqual(server.staticFiles.map((file) => file.name), ['linked.txt']);
  assert.equal(await (await fetch(`${server.staticBase}/linked.txt`)).text(), 'registered linked media');
  assert.equal((await fetch(`${server.staticBase}/outside-original.txt`)).status, 404);
  assert.equal((await fetch(`${server.staticBase}/.private`)).status, 404);
  assert.ok(server.sourcePaths.includes(await realpath(original)));
  assert.equal(server.staticFiles[0].path, undefined);
});

test('existing outputs and original source assets cannot be replaced', async (t) => {
  const directory = await scratch(t);
  const source = path.join(directory, 'source.mp4');
  const existing = path.join(directory, 'accepted.mp4');
  await writeFile(source, 'original');
  await writeFile(existing, 'accepted');
  const project = await createProject(path.join(directory, 'project'), {name: 'guards',
    assets: [{id: 'a', path: source, type: 'video', duration: 1, fps: 30}],
    clips: [{id: 'c', assetId: 'a', sourceStart: 0, sourceEnd: 1}]});
  await assert.rejects(renderProject(project, {outputPath: source}), /source asset/);
  await assert.rejects(renderProject(project, {outputPath: existing}), /already exists/);
  assert.equal(await readFile(source, 'utf8'), 'original');
  assert.equal(await readFile(existing, 'utf8'), 'accepted');
  assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.agent-video-render-')));
});

test('headless synthetic smoke renders source trim, caption, overlay and audio',
  {skip: process.env.AGENT_VIDEO_RENDER_SMOKE !== '1', timeout: 120000}, async (t) => {
    const directory = await scratch(t);
    const source = path.join(directory, 'red-then-blue.mp4');
    await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n',
      '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=20:d=1',
      '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=20:d=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
    const project = await createProject(path.join(directory, 'project'), {name: 'smoke',
      settings: {width: 160, height: 90, fps: 20},
      captions: {fontSize: 10, bottom: 2},
      assets: [{id: 'a', path: source, type: 'video', duration: 2, fps: 20, hasAudio: true}],
      clips: [{id: 'c', assetId: 'a', sourceStart: 1, sourceEnd: 2}],
      overlays: [{id: 'label', type: 'text', text: 'TEST', start: 0, end: 1,
        style: {left: 2, top: 2, width: 40, height: 12, fontSize: 10}}],
      transcripts: [{assetId: 'a', language: 'en', words: [{id: 'word', text: 'Blue', start: 1.1, end: 1.8}]}]});
    const still = await renderProject(project, {kind: 'still', frame: 5, outputPath: path.join(directory, 'still.png')});
    assert.equal(still.width, 160);
    const pixel = await exec('ffmpeg', ['-v', 'error', '-i', still.outputPath,
      '-vf', 'crop=1:1:80:20,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], {encoding: 'buffer'});
    assert.ok(pixel.stdout[2] > 200 && pixel.stdout[0] < 40, 'Source trim must start in blue second, not red first second');
    const video = await renderProject(project, {kind: 'preview', scale: 1, fromFrame: 0, toFrame: 9,
      outputPath: path.join(directory, 'preview.mp4')});
    assert.equal(video.durationInFrames, 10);
    const {stdout} = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video.outputPath]);
    const probe = JSON.parse(stdout);
    const picture = probe.streams.find((stream) => stream.codec_type === 'video');
    assert.equal(picture.nb_frames, '10');
    assert.equal(picture.width, 160);
    assert.equal(picture.height, 90);
    assert.ok(probe.streams.some((stream) => stream.codec_type === 'audio'));
    assert.ok(Math.abs(Number(probe.format.duration) - .5) < .05);
    await exec('ffmpeg', ['-v', 'error', '-i', video.outputPath, '-f', 'null', '-']);
    assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.agent-video-render-')));
  });

test('custom Remotion motion renders headlessly and in-flight cancellation leaves no export',
  {skip: process.env.AGENT_VIDEO_RENDER_SMOKE !== '1', timeout: 120000}, async (t) => {
    const directory = await scratch(t);
    const entryPoint = path.join(directory, 'custom.tsx');
    const publicDir = path.join(directory, 'public');
    await mkdir(path.join(publicDir, 'nested'), {recursive: true});
    const artwork = path.join(directory, 'original.svg');
    await writeFile(artwork, '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#ff00ff"/></svg>');
    await symlink(artwork, path.join(publicDir, 'nested/linked.svg'));
    await writeFile(entryPoint, `import React from 'react';
import {registerRoot, Composition, AbsoluteFill, Img, staticFile, useCurrentFrame} from 'remotion';
const Motion = ({color, timeline}) => {
  const frame = useCurrentFrame();
  if (!timeline.assets || timeline.settings.width !== 160) throw new Error('Timeline input missing');
  return <AbsoluteFill style={{backgroundColor:color}}><Img src={staticFile('nested/linked.svg')}/><div style={{transform:'translateX('+frame+'px)'}}>Motion</div></AbsoluteFill>;
};
registerRoot(() => <Composition id="CustomMotion" component={Motion} width={160} height={90}
  fps={20} durationInFrames={200} defaultProps={{color:'#ff00ff',timeline:{assets:[],settings:{width:160}}}}/>);
`);
    const project = await createProject(path.join(directory, 'project'), {name: 'custom smoke',
      settings: {width: 160, height: 90, fps: 20},
      custom: {entryPoint, compositionId: 'CustomMotion', publicDir, props: {color: '#ff00ff'}}});
    const still = await renderProject(project, {kind: 'still', frame: 8, outputPath: path.join(directory, 'custom.png')});
    assert.equal(still.compositionId, 'CustomMotion');
    assert.equal(still.verification.probe, 'passed');
    const pixel = await exec('ffmpeg', ['-v', 'error', '-i', still.outputPath,
      '-vf', 'crop=1:1:80:60,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], {encoding: 'buffer'});
    assert.ok(pixel.stdout[0] > 230 && pixel.stdout[1] < 20 && pixel.stdout[2] > 230);
    const controller = new AbortController();
    await assert.rejects(renderProject(project, {kind: 'video', signal: controller.signal,
      outputPath: path.join(directory, 'cancelled.mp4'),
      onProgress: (update) => {if (update.stage === 'render' && update.renderedFrames >= 1) controller.abort();}}),
    {name: 'AbortError'});
    const files = await readdir(directory);
    assert.ok(!files.includes('cancelled.mp4'));
    assert.ok(!files.some((name) => name.startsWith('.agent-video-render-')));
  });
