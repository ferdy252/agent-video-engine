import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProject, prepareOperations} from '../src/project.mjs';
import {renderProject} from '../src/render.mjs';
import {probeAsset, run, toolEnv} from '../src/media.mjs';
const exec = promisify(execFile);
const real = {skip: process.env.AGENT_VIDEO_RENDER_SMOKE !== '1', timeout: 180000};
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'engine-controls-render-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const red = join(dir, 'red.mp4'), blue = join(dir, 'blue.mp4');
  for (const [file, color, frequency] of [[red, 'red', 440], [blue, 'blue', 880]]) {
    await run('ffmpeg', ['-v', 'error', '-n', '-f', 'lavfi', '-i', `color=c=${color}:s=160x90:r=10:d=3`,
      '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=3`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
  }
  const project = await createProject(join(dir, 'project'), {name: 'Controls rendering', settings: {width: 160, height: 90, fps: 10},
    assets: [await probeAsset(red, 'red'), await probeAsset(blue, 'blue')], captions: {enabled: false},
    clips: [{id: 'red', assetId: 'red', sourceStart: 0, sourceEnd: 2}, {id: 'blue', assetId: 'blue', sourceStart: 0, sourceEnd: 2}]});
  return {dir, project, red, blue};
}
async function pixels(file, frame) {
  const {stdout} = await exec('ffmpeg', ['-v', 'error', '-i', file, ...(frame === undefined ? [] : ['-vf', `select=eq(n\\,${frame})`]),
    '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], {encoding: 'buffer', env: toolEnv});
  return stdout;
}
const pixel = (data, x, y) => [...data.subarray((y * 160 + x) * 3, (y * 160 + x) * 3 + 3)];
async function audio(file) {
  const {stdout} = await exec('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], {encoding: 'buffer', env: toolEnv});
  return new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength));
}
function tone(samples, frequency, from, duration = .1) {
  let real = 0, imaginary = 0, count = 0;
  for (let i = Math.round(from * 48000); i < Math.min(samples.length, Math.round((from + duration) * 48000)); i++) {
    real += samples[i] * Math.cos(2 * Math.PI * frequency * i / 48000);
    imaginary += samples[i] * Math.sin(2 * Math.PI * frequency * i / 48000); count++;
  }
  return Math.hypot(real, imaginary) / Math.max(1, count) * 2;
}
test('encoded crossfade, dip and wipe use actual overlapping pictures and crossfade both source sounds', real, async t => {
  const {dir, project, red} = await fixture(t), original = await readFile(red);
  const mixed = prepareOperations(project, [{type: 'set_transition', clipId: 'blue', transition: {type: 'crossfade', duration: 1}}]);
  const output = join(dir, 'crossfade.mp4');
  const rendered = await renderProject(mixed, {outputPath: output});
  assert.equal(rendered.durationInFrames, 30);
  const mid = pixel(await pixels(output, 15), 80, 45);
  assert.ok(mid[0] > 60 && mid[2] > 90 && mid[1] < 10, `crossfade mixes colors ${mid}`);
  const samples = await audio(output);
  const redAlone = tone(samples, 440, .4), blueAlone = tone(samples, 880, 2.4);
  const redMid = tone(samples, 440, 1.5), blueMid = tone(samples, 880, 1.5);
  assert.ok(redMid > redAlone * .2 && redMid < redAlone * .8);
  assert.ok(blueMid > blueAlone * .2 && blueMid < blueAlone * .8);
  for (const type of ['dip', 'wipe']) {
    const edit = prepareOperations(project, [{type: 'set_transition', clipId: 'blue', transition: {type, duration: 1}}]);
    const still = join(dir, `${type}.png`);
    await renderProject(edit, {kind: 'still', frame: 14, outputPath: still});
    const data = await pixels(still);
    if (type === 'dip') assert.ok(Math.max(...pixel(data, 80, 45)) < 40, 'dip approaches black in the overlap midpoint');
    else {
      assert.ok(pixel(data, 20, 45)[2] > 220, 'wipe reveals incoming blue at the left');
      assert.ok(pixel(data, 140, 45)[0] > 220, 'wipe retains outgoing red on the right');
    }
  }
  assert.deepEqual(await readFile(red), original);
});
test('rendered keyframes, crop, edited captions and graphic styles follow saved controls', real, async t => {
  const {dir, project} = await fixture(t);
  const pattern = join(dir, 'pattern.png');
  await run('ffmpeg', ['-v', 'error', '-n', '-f', 'lavfi', '-i', 'color=c=red:s=160x90,drawbox=x=80:y=0:w=80:h=90:color=blue:t=fill', '-frames:v', '1', pattern]);
  const animated = {...project, assets: [...project.assets, await probeAsset(pattern, 'pattern')], clips: [{...project.clips[0], assetId: 'pattern',
    position: {x: 0, y: 0, width: 40, height: 40}, crop: {left: .5}, motion: {x: [{time: 0, value: 0}, {time: 1, value: 80}]}}]};
  const first = join(dir, 'first.png'), second = join(dir, 'second.png');
  await renderProject(animated, {kind: 'still', frame: 0, outputPath: first});
  await renderProject(animated, {kind: 'still', frame: 10, outputPath: second});
  assert.ok(pixel(await pixels(first), 20, 20)[2] > 220, 'crop reveals right half of source');
  const moved = await pixels(second);
  assert.ok(Math.max(...pixel(moved, 20, 20)) < 3, 'motion vacates initial position');
  assert.ok(pixel(moved, 100, 20)[2] > 220, 'motion reaches saved keyframe');
  const zoomed = {...animated, clips: [{...animated.clips[0], position: {x: 60, y: 25, width: 40, height: 40},
    motion: {scale: [{time: 0, value: .5}, {time: 1, value: 2}], opacity: [{time: 0, value: 1}, {time: 1, value: .5}]}}]};
  const zoomFirst = join(dir, 'zoom-first.png'), zoomLast = join(dir, 'zoom-last.png');
  await renderProject(zoomed, {kind: 'still', frame: 0, outputPath: zoomFirst});
  await renderProject(zoomed, {kind: 'still', frame: 10, outputPath: zoomLast});
  assert.ok(Math.max(...pixel(await pixels(zoomFirst), 50, 45)) < 3, 'initial small scale excludes the sample');
  const zoomPixel = pixel(await pixels(zoomLast), 50, 45);
  assert.ok(zoomPixel[2] > 110 && zoomPixel[2] < 140, `zoom expands the picture with half opacity ${zoomPixel}`);
  const captioned = prepareOperations(animated, [
    {type: 'set_captions', patch: {enabled: true, fontSize: 14, bottom: 0, color: '#00ff00'}},
    {type: 'set_caption_cues', cues: [{id: 'cue', start: 0, end: 1, text: 'NEW\nLINE'}]},
    {type: 'upsert_overlay', overlay: {id: 'title', type: 'text', text: 'TITLE', preset: 'callout', start: 0, end: 1,
      style: {left: 110, top: 0, width: 50, height: 20, fontSize: 8, padding: 0, fadeInFrames: 0, fadeOutFrames: 0}}},
  ]);
  const still = join(dir, 'captions.png'); await renderProject(captioned, {kind: 'still', frame: 5, outputPath: still});
  const data = await pixels(still);
  const greenRows = new Set();
  for (let y = 45; y < 90; y++) for (let x = 0; x < 160; x++) {const p = pixel(data, x, y); if (p[1] > 100 && p[0] < 20 && p[2] < 20) greenRows.add(y);}
  assert.ok(greenRows.size >= 12, 'both caption lines are rendered in edited color');
  const title = pixel(data, 132, 4); assert.ok(title[0] > 220 && title[1] > 170 && title[2] < 130, 'callout preset rendered');
});
test('rendered sound can lead and outlast picture while volume envelopes and fades remain adjustable', real, async t => {
  const {dir, project} = await fixture(t);
  const edited = prepareOperations(project, [{type: 'set_clips', clips: [
    {id: 'gap', type: 'gap', duration: 1},
    {id: 'blue', assetId: 'blue', sourceStart: 1, sourceEnd: 2, audio: {sourceStart: 0, sourceEnd: 2.5, offset: -.5,
      fadeIn: .2, fadeOut: .2, envelope: [{time: 0, value: 1}, {time: .8, value: 1}, {time: 1, value: .25}, {time: 2.5, value: .25}]}},
  ]}]);
  const output = join(dir, 'split-sound.mp4');
  const result = await renderProject(edited, {outputPath: output});
  assert.equal(result.durationInFrames, 30, 'audio tail extends complete timeline');
  const samples = await audio(output);
  assert.ok(tone(samples, 880, .8) > .05, 'J sound starts before the picture');
  assert.ok(tone(samples, 880, 2.3) > .01, 'L sound continues after the picture');
  assert.ok(tone(samples, 880, .8) > tone(samples, 880, 2.3) * 3, 'saved envelope lowers the later section');
  assert.ok(tone(samples, 880, .5, .05) < tone(samples, 880, .8) * .3, 'fade removes abrupt leading sound');
  for (const frame of [8, 23]) assert.ok(Math.max(...pixel(await pixels(output, frame), 80, 45)) < 3, 'gap/tail has background picture');
  assert.ok(!(await readdir(dir)).some(file => file.startsWith('.agent-video-render-')));
});
