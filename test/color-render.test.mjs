import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {createProject} from '../src/project.mjs';
import {probeAsset, run} from '../src/media.mjs';
import {renderProject} from '../src/render.mjs';
import {renderColorComparison} from '../src/color-preview.mjs';

const exec = promisify(execFile);
async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-color-render-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}
async function pixels(file) {
  const {stdout} = await exec('ffmpeg', ['-v', 'error', '-i', file,
    '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], {encoding: 'buffer'});
  return stdout;
}
const pixel = (data, x, y, width = 160) => [...data.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];
function countColor(data, color) {
  let count = 0;
  for (let index = 0; index < data.length; index += 3) {
    if (color.every((channel, offset) => data[index + offset] === channel)) count++;
  }
  return count;
}

test('color comparisons preserve existing output directories and reject unsupported compositions', async (t) => {
  const directory = await scratch(t);
  const project = await createProject(join(directory, 'project'), {name: 'Color guards'});
  await assert.rejects(renderColorComparison(project, {outputDir: 'relative'}), /absolute/);
  await assert.rejects(renderColorComparison(project, {outputDir: join(directory, 'invalid'), frame: -.5}), /frame/);
  const existing = join(directory, 'accepted');
  await mkdir(existing);
  await writeFile(join(existing, 'keep.txt'), 'preserve');
  await assert.rejects(renderColorComparison(project, {outputDir: existing}), {code: 'OUTPUT_EXISTS'});
  assert.equal(await readFile(join(existing, 'keep.txt'), 'utf8'), 'preserve');
  await writeFile(join(directory, 'custom.tsx'), 'export {};');
  await assert.rejects(renderColorComparison({...project, custom: {entryPoint: join(directory, 'custom.tsx'),
    compositionId: 'Custom'}}, {outputDir: join(directory, 'standalone')}), {code: 'UNSUPPORTED_CUSTOM_COLOR'});
  assert.ok(!(await readdir(directory)).includes('standalone'));
});

test('source-only color filters render identical-frame comparisons without tinting graphics or captions',
  {skip: process.env.AGENT_VIDEO_RENDER_SMOKE !== '1', timeout: 120000}, async (t) => {
    const directory = await scratch(t);
    const source = join(directory, 'recording.mp4'), photograph = join(directory, 'photo.png');
    await run('ffmpeg', ['-v', 'error', '-n', '-f', 'lavfi', '-i',
      'color=c=0x808080:s=160x60:r=10:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
    await run('ffmpeg', ['-v', 'error', '-n', '-f', 'lavfi', '-i',
      'color=c=0x808080:s=40x30', '-frames:v', '1', photograph]);
    const original = await readFile(source), originalPhoto = await readFile(photograph);
    const layer = join(directory, 'layer.tsx');
    await writeFile(layer, `import React from 'react';
export default function Graphic() {
  return <div style={{position:'absolute',right:0,top:0,width:20,height:10,backgroundColor:'#ff00ff'}}/>;
}
`);
    const projectDir = join(directory, 'project');
    const project = await createProject(projectDir, {name: 'Source color regression',
      settings: {fps: 10, width: 160, height: 90, background: '#102030'},
      assets: [{...await probeAsset(source, 'recording'), color: {temperature: .8, tint: .6}},
        {...await probeAsset(photograph, 'photo'), color: {brightness: .5}}],
      clips: [{id: 'clip', assetId: 'recording', sourceStart: 0, sourceEnd: 2, fit: 'contain'}],
      captions: {fontSize: 12, bottom: 3, wordsPerPage: 1, highlightColor: '#ffd860'},
      transcripts: [{assetId: 'recording', language: 'en', words: [{id: 'word', text: 'COLOR', start: 0, end: 2}]}],
      overlays: [{id: 'graphic', type: 'text', text: 'X', start: 0, end: 2,
        style: {left: 0, top: 0, width: 20, height: 10, color: '#00ffff', backgroundColor: '#00ffff'}},
      {id: 'photo', type: 'image', assetId: 'photo', start: 0, end: 2,
        style: {left: 120, top: 30, width: 40, height: 30}}],
      custom: {mode: 'layer', entryPoint: layer}});
    const manifest = await readFile(join(projectDir, 'project.json'));
    const comparison = await renderColorComparison(project, {outputDir: join(directory, 'comparison'), frame: 5, scale: 1});
    assert.equal(comparison.kind, 'color_comparison');
    assert.equal(comparison.before.frame, 5);
    assert.equal(comparison.after.frame, 5);
    assert.equal(comparison.before.width, comparison.after.width);
    const before = await pixels(comparison.before.outputPath), after = await pixels(comparison.after.outputPath);
    const neutral = pixel(before, 70, 30), corrected = pixel(after, 70, 30);
    assert.ok(Math.max(...neutral) - Math.min(...neutral) <= 2, 'uncorrected source stays gray');
    assert.ok(corrected[0] > corrected[2] + 20, 'positive temperature warms source pixels');
    assert.ok(corrected[0] > corrected[1] + 20, 'positive tint moves gray toward magenta');
    assert.ok(pixel(after, 140, 45)[0] < pixel(before, 140, 45)[0] - 40,
      'source-level brightness applies to image overlays');
    for (const [x, y] of [[5, 5], [150, 5], [80, 5]]) assert.deepEqual(pixel(after, x, y), pixel(before, x, y),
      'ordinary graphics, custom graphics and the background remain unchanged');
    const captionColor = [255, 216, 96];
    assert.ok(countColor(before, captionColor) > 5, 'caption fixture contains solid highlight pixels');
    assert.equal(countColor(after, captionColor), countColor(before, captionColor), 'caption colors are not corrected');

    const disabled = {...project, clips: project.clips.map((clip) => ({...clip, color: {enabled: false}}))};
    const disabledRender = await renderProject(disabled, {kind: 'still', frame: 5, outputPath: join(directory, 'disabled.png')});
    assert.deepEqual(pixel(await pixels(disabledRender.outputPath), 70, 30), neutral,
      'a disabled clip bypasses inherited source correction');
    const imageProject = {...project, custom: null, overlays: [], transcripts: [],
      clips: [{...project.clips[0], id: 'image-main', assetId: 'photo'}]};
    const imageRender = await renderProject(imageProject, {kind: 'still', frame: 5, outputPath: join(directory, 'image.png')});
    assert.ok(pixel(await pixels(imageRender.outputPath), 70, 30)[0] < 90, 'main image clips use the same source correction');

    const controller = new AbortController();
    await assert.rejects(renderColorComparison(project, {outputDir: join(directory, 'cancelled'), frame: 5, scale: 1,
      signal: controller.signal, onProgress: (update) => {
        if (update.stage === 'color_after' && update.renderStage === 'bundle') controller.abort();
      }}), {name: 'AbortError'});
    const files = await readdir(directory);
    assert.ok(!files.includes('cancelled'), 'cancellation removes both files in the owned comparison directory');
    assert.ok(!files.some((name) => name.startsWith('.agent-video-render-')));
    assert.deepEqual(await readFile(source), original);
    assert.deepEqual(await readFile(photograph), originalPhoto);
    assert.deepEqual(await readFile(join(projectDir, 'project.json')), manifest);

    const legacyPhoto = join(directory, 'legacy-photo.png');
    await writeFile(legacyPhoto, originalPhoto);
    const legacy = {...imageProject, assets: [{...project.assets[1], path: legacyPhoto, fingerprint: undefined}]};
    const changed = join(directory, 'changed-source');
    await assert.rejects(renderColorComparison(legacy, {outputDir: changed, frame: 5, scale: 1,
      onProgress: (update) => {
        if (update.stage === 'color_before' && update.renderStage === 'complete') {
          writeFileSync(legacyPhoto, Buffer.concat([originalPhoto, Buffer.from('replacement')]));
        }
      }}), {code: 'SOURCE_CHANGED'});
    assert.ok(!(await readdir(directory)).includes('changed-source'), 'A source replacement invalidates the entire comparison');
  });
