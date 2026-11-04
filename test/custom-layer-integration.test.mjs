import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {run, toolEnv} from '../src/media.mjs';

const root = resolve(import.meta.dirname, '..');
const exec = promisify(execFile);
const digest = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

test('custom layers retain the engine story and clock through editing, cut review and final export', {
  skip: process.env.AGENT_VIDEO_INTEGRATION !== '1', timeout: 180000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-custom-layer-'));
  const projectDir = join(directory, 'project');
  const source = join(directory, 'source.mp4');
  const layer = join(directory, 'word-layer.tsx');
  const manifest = join(projectDir, 'project.json');
  const client = new Client({name: 'custom-layer-check', version: '1.0.0'});
  const transport = new StdioClientTransport({command: process.execPath,
    args: [join(root, 'src/server.mjs')], env: {...toolEnv, VIDEO_ENGINE_RUNTIME: join(directory, 'runtime')}, stderr: 'pipe'});
  const call = async (name, args) => {
    const response = await client.callTool({name, arguments: args});
    const value = JSON.parse(response.content[0].text);
    if (response.isError) throw Object.assign(new Error(value.message ?? response.content[0].text), {code: value.code});
    return value;
  };
  const wait = async (started) => {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const job = await call('job_get', {projectDir, jobId: started.id});
      if (!['queued', 'running'].includes(job.status)) return job;
      await delay(100);
    }
    throw new Error(`Custom-layer job ${started.id} timed out`);
  };
  const complete = async (name, args) => {
    const job = await wait(await call(name, {projectDir, ...args}));
    assert.equal(job.status, 'completed', JSON.stringify(job.error));
    return job.result;
  };
  const pixel = async (file, frame, x, y) => {
    const {stdout} = await exec('ffmpeg', ['-v', 'error', '-i', file, '-vf',
      `select=eq(n\\,${frame}),crop=2:2:${x}:${y}`, '-frames:v', '1',
      '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], {encoding: 'buffer', env: toolEnv});
    assert.ok(stdout.length >= 3, `Frame ${frame} must exist`);
    return [...stdout.subarray(0, 3)];
  };
  const isRed = (rgb) => rgb[0] > 190 && rgb[1] < 50 && rgb[2] < 50;
  const isBlue = (rgb) => rgb[2] > 190 && rgb[0] < 50 && rgb[1] < 50;
  const isGreen = (rgb) => rgb[1] > 180 && rgb[0] < 60 && rgb[2] < 60;
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n',
      '-f', 'lavfi', '-i', 'color=red:s=160x90:r=20:d=1',
      '-f', 'lavfi', '-i', 'color=blue:s=160x90:r=20:d=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
    await writeFile(layer, `import React from 'react';
import {Audio, useCurrentFrame, useVideoConfig} from 'remotion';
export default function WordLayer({timeline, markerColor, customAudio}) {
  const frame = useCurrentFrame();
  const config = useVideoConfig();
  const word = timeline.captions.find(item => item.id === 'blue-word');
  const cue = timeline.overlays.find(item => item.id === 'word-cue');
  if (!word || !cue || cue.from !== word.startFrame) throw new Error('Source-linked word and overlay are missing or out of sync');
  if (config.fps !== timeline.fps || config.durationInFrames !== timeline.durationInFrames) throw new Error('Layer escaped the engine clock');
  const active = frame >= cue.from && frame < cue.from + cue.durationInFrames;
  return <>{customAudio ? <Audio src={timeline.assets[0].src} volume={0.1}/> : null}
    {active ? <div style={{position:'absolute',left:4,top:4,width:20,height:20,backgroundColor:markerColor}}/> : null}</>;
}
`);
    const sourceHash = await digest(source);
    await client.connect(transport);
    await call('project_create', {projectDir, name: 'Synthetic custom layer', width: 160, height: 90, fps: 20});
    const added = await call('media_add', {projectDir, expectedRevision: 0, path: source, addToTimeline: true});
    const assetId = added.asset.id;
    const words = join(directory, 'words.json');
    await writeFile(words, JSON.stringify({language: 'en', words: [
      {id: 'red-word', text: 'Before', start: 0.4, end: 0.8},
      {id: 'blue-word', text: 'After', start: 1.2, end: 1.4},
    ]}));
    await call('transcript_import', {projectDir, expectedRevision: 1, assetId, path: words});
    await call('edit_apply', {projectDir, expectedRevision: 2, operations: [
      {type: 'set_clips', clips: [
        {id: 'red-take', assetId, sourceStart: 0, sourceEnd: 0.6},
        {id: 'blue-take', assetId, sourceStart: 1, sourceEnd: 1.6},
      ]},
      {type: 'set_captions', patch: {enabled: false}},
      {type: 'upsert_overlay', overlay: {id: 'word-cue', type: 'text', text: 'Cue', start: 0, end: 0.2,
        anchor: {assetId, wordId: 'blue-word'}, style: {opacity: 0}}},
      {type: 'set_custom', custom: {mode: 'layer', entryPoint: layer, props: {markerColor: '#00ff00'}}},
    ]});
    const first = await complete('preview_render', {expectedRevision: 3, kind: 'preview', fromFrame: 0, toFrame: 23, scale: 1});
    assert.equal(first.customMode, 'layer');
    assert.equal(first.compositionId, 'AgentVideo');
    assert.equal(first.fps, 20);
    assert.equal(first.durationInFrames, 24);
    assert.ok(isRed(await pixel(first.outputPath, 5, 100, 40)), 'Layer preserves the retained red base take');
    assert.ok(isBlue(await pixel(first.outputPath, 17, 100, 40)), 'Layer preserves the source cut into blue');
    assert.ok(isBlue(await pixel(first.outputPath, 13, 10, 10)), 'Word cue has not started at frame 13');
    assert.ok(isGreen(await pixel(first.outputPath, 17, 10, 10)), 'Custom layer receives props and the source-linked cue');
    const beforeReview = await readFile(manifest, 'utf8');
    const review = await complete('review_cuts', {expectedRevision: 3, renderPreviews: true, contextSeconds: 1});
    assert.equal(review.reviewScope, 'engine_main_timeline');
    assert.equal(review.customMode, 'layer');
    assert.equal(review.revision, 3);
    assert.equal(review.totalCuts, 1);
    assert.equal(review.cuts[0].outputFrame, 12);
    assert.equal(review.cuts[0].outputTime, 0.6);
    assert.deepEqual(review.cuts[0].preview.frameRange, [0, 23]);
    assert.ok(isGreen(await pixel(review.cuts[0].preview.outputPath, 17, 5, 5)), 'Cut review includes the rendered custom layer');
    assert.equal(await readFile(manifest, 'utf8'), beforeReview);
    assert.equal(await digest(source), sourceHash);

    await call('edit_apply', {projectDir, expectedRevision: 3, operations: [
      {type: 'delete_source_range', assetId, start: 0, end: 0.2},
    ]});
    const inspected = await call('project_inspect', {projectDir, includeTimeline: true});
    assert.equal(inspected.revision, 4);
    assert.equal(inspected.timeline.durationInFrames, 20);
    assert.equal(inspected.timeline.overlays[0].from, 12);
    const second = await complete('preview_render', {expectedRevision: 4, kind: 'preview', fromFrame: 0, toFrame: 19, scale: 1});
    assert.ok(isGreen(await pixel(second.outputPath, 13, 10, 10)), 'Cue follows its source word four frames earlier after the cut');
    assert.ok(isBlue(await pixel(second.outputPath, 17, 10, 10)), 'Cue also ends earlier, without stale hardcoded timing');
    const revisedManifest = await readFile(manifest, 'utf8');
    const secondReview = await complete('review_cuts', {expectedRevision: 4, renderPreviews: true, contextSeconds: 1});
    assert.equal(secondReview.revision, 4);
    assert.equal(secondReview.cuts[0].outputFrame, 8);
    assert.equal(secondReview.cuts[0].outputTime, 0.4);
    assert.equal(secondReview.cuts[0].preview.cutFrameInPreview, 8);
    assert.equal(await readFile(manifest, 'utf8'), revisedManifest);
    assert.equal(await digest(source), sourceHash);
    const exported = await complete('export_render', {expectedRevision: 4});
    assert.equal(exported.customMode, 'layer');
    assert.equal(exported.compositionId, 'AgentVideo');
    assert.equal(exported.fps, 20);
    assert.equal(exported.durationInFrames, 20);
    const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', exported.outputPath])).stdout);
    const video = probe.streams.find((stream) => stream.codec_type === 'video');
    assert.equal(video.avg_frame_rate, '20/1');
    assert.equal(video.nb_frames, '20');
    assert.ok(Math.abs(Number(video.duration ?? probe.format.duration) - 1) < 0.051);
    assert.ok(probe.streams.some((stream) => stream.codec_type === 'audio'));

    await call('edit_apply', {projectDir, expectedRevision: 4, operations: [
      {type: 'set_clips', clips: inspected.clips.map((clip) => ({...clip, volume: 0}))},
      {type: 'set_custom', custom: {mode: 'layer', entryPoint: layer, props: {markerColor: '#00ff00', customAudio: true}}},
    ]});
    const silentBaseManifest = await readFile(manifest, 'utf8');
    const customAudioReview = await complete('review_cuts', {expectedRevision: 5, renderPreviews: true, contextSeconds: 0.5});
    const audio = customAudioReview.cuts[0].audio;
    assert.equal(audio.status, 'analyzed');
    assert.equal(audio.evidenceScope, 'mixed_master');
    assert.equal(audio.silenceAssessment, 'unassessed_custom_layer_audio_expectation');
    assert.ok(audio.left.rms > 0.001 && audio.right.rms > 0.001, 'Review measures actual layer audio even when the engine base is muted');
    assert.ok(!customAudioReview.cuts[0].flags.some((flag) => flag.code === 'LONG_SILENCE_NEAR_JOIN'));
    assert.equal(await readFile(manifest, 'utf8'), silentBaseManifest);
    assert.equal(await digest(source), sourceHash);

    for (const custom of [
      {mode: 'invalid', entryPoint: layer},
      {mode: 'composition', entryPoint: layer},
      {mode: 'layer', entryPoint: layer, compositionId: 'ForbiddenStandaloneRoot'},
    ]) {
      await assert.rejects(call('edit_apply', {projectDir, expectedRevision: 5, operations: [{type: 'set_custom', custom}]}));
      assert.equal(await readFile(manifest, 'utf8'), silentBaseManifest, 'Invalid custom modes never change the project');
    }
    const invalidLayer = join(directory, 'invalid-root-layer.tsx');
    await writeFile(invalidLayer, `import React from 'react';
import {registerRoot} from 'remotion';
registerRoot(() => null);
export default function InvalidLayer() {return null;}
`);
    await call('edit_apply', {projectDir, expectedRevision: 5, operations: [
      {type: 'set_custom', custom: {mode: 'layer', entryPoint: invalidLayer}},
    ]});
    const invalidRender = await wait(await call('preview_render', {projectDir, expectedRevision: 6, kind: 'still', frame: 0}));
    assert.equal(invalidRender.status, 'failed');
    assert.match(invalidRender.error.message, /registerRoot|layer|root/i);
    const independent = join(directory, 'independent.tsx');
    await writeFile(independent, '// Review must reject this independent root before executing its code.\n');
    await call('edit_apply', {projectDir, expectedRevision: 6, operations: [
      {type: 'set_custom', custom: {entryPoint: independent, compositionId: 'IndependentRoot'}},
    ]});
    const jobsBefore = (await call('job_list', {projectDir})).length;
    await assert.rejects(call('review_cuts', {projectDir, expectedRevision: 7}), {code: 'UNSUPPORTED_CUSTOM_REVIEW'});
    assert.equal((await call('job_list', {projectDir})).length, jobsBefore);
    assert.equal(await digest(source), sourceHash);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await rm(directory, {recursive: true, force: true});
  }
});
