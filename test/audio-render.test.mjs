import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {createProject} from '../src/project.mjs';
import {probeAsset, run} from '../src/media.mjs';
import {renderProject} from '../src/render.mjs';

const exec = promisify(execFile);

async function crest(file) {
  const {stdout} = await exec('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', file,
    '-t', '1', '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'],
  {encoding: 'buffer', maxBuffer: 1024 * 1024});
  let peak = 0, squares = 0;
  for (let offset = 0; offset < stdout.length; offset += 4) {
    const value = stdout.readFloatLE(offset);
    peak = Math.max(peak, Math.abs(value));
    squares += value * value;
  }
  return peak / Math.sqrt(squares / (stdout.length / 4));
}

test('float master preserves boosted peaks and custom-layer audio before common finishing',
  {skip: process.env.AGENT_VIDEO_RENDER_SMOKE !== '1', timeout: 120000}, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-audio-render-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const source = join(directory, 'source.wav');
    await run('ffmpeg', ['-v', 'error', '-n', '-f', 'lavfi', '-i',
      'sine=frequency=440:sample_rate=48000:duration=3', '-af', 'volume=4', '-c:a', 'pcm_f32le', source]);
    const original = await readFile(source);
    const layerSource = join(directory, 'layer-tone.wav');
    await writeFile(layerSource, original);
    const layer = join(directory, 'layer.tsx');
    await writeFile(layer, `import React from 'react';
import {Audio} from 'remotion';
export default function ToneLayer({timeline}) {
  return <Audio src={timeline.assets.find(asset => asset.id === 'layer-tone').src} volume={3}/>;
}
`);
    const projectDir = join(directory, 'project');
    const project = await createProject(projectDir, {name: 'Float audio regression',
      assets: [await probeAsset(source, 'voice'), await probeAsset(layerSource, 'layer-tone')],
      clips: [{id: 'boosted', assetId: 'voice', sourceStart: 0, sourceEnd: 3, audio: {gainDb: 24}}],
      settings: {fps: 10, width: 160, height: 90},
      audio: {enabled: true, strength: 0}, custom: {mode: 'layer', entryPoint: layer}});
    const manifest = await readFile(join(projectDir, 'project.json'));
    const result = await renderProject(project, {outputPath: join(directory, 'finished.mp4')});
    assert.equal(result.audio.master.before.status, 'measured');
    // The main mono voice alone peaks near +14.97 dB after stereo conversion.
    // The same tone in the layer adds another ~1.5 dB to the real full mix.
    assert.ok(result.audio.master.before.truePeakDb > 16,
      `raw master must preserve over-range peaks and include the layer mix: ${result.audio.master.before.truePeakDb}`);
    assert.ok(result.audio.encoded.truePeakDb <= project.audio.truePeakDb);
    assert.equal(result.audio.peakSafety.gainScope, 'full_timeline_master');
    assert.equal(result.audio.peakSafety.rangeVerified, true);
    assert.equal(result.verification.frames, 30);
    assert.ok(Math.abs(await crest(source) - await crest(result.outputPath)) < .06,
      'constant-gain finishing preserves waveform crest instead of flattening peaks');
    const {stdout} = await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=sample_rate,codec_name', '-of', 'json', result.outputPath]);
    assert.equal(JSON.parse(stdout).streams[0].sample_rate, '48000');
    assert.equal(JSON.parse(stdout).streams[0].codec_name, 'aac');

    const controller = new AbortController();
    await assert.rejects(renderProject(project, {outputPath: join(directory, 'cancelled.mp4'),
      signal: controller.signal, onProgress: (update) => {
        if (update.stage === 'audio_master' && update.renderedFrames >= 1) controller.abort();
      }}), {name: 'AbortError'});
    const files = await readdir(directory);
    assert.ok(!files.includes('cancelled.mp4'));
    assert.ok(!files.some((name) => name.startsWith('.agent-video-render-')));
    assert.deepEqual(await readFile(source), original);
    assert.deepEqual(await readFile(join(projectDir, 'project.json')), manifest);
  });
