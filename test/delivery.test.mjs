import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {applyDeliveryPreset, exportSubtitles, exportTimeline} from '../src/delivery.mjs';
import {fileFingerprint} from '../src/media.mjs';
import {createProject} from '../src/project.mjs';
import {compileTimeline} from '../src/timeline.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-video-delivery-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const assets = await Promise.all([
    {id: 'main', file: 'Take A & #1.mp4', type: 'video', duration: 12, fps: 24},
    {id: 'insert', file: 'Insert.mp4', type: 'video', duration: 12, fps: 24, hasAudio: false},
    {id: 'voice', file: 'Voice.wav', type: 'audio', duration: 8},
  ].map(async ({file, ...asset}) => {
    const path = join(directory, file);
    await writeFile(path, `fixture ${asset.id}`);
    return {...asset, path, fingerprint: await fileFingerprint(path)};
  }));
  const projectDir = join(directory, 'project');
  const project = await createProject(projectDir, {name: 'Delivery fixture', assets,
    settings: {fps: 24, width: 1920, height: 1080},
    clips: [
      {id: 'first', assetId: 'main', sourceStart: .5, sourceEnd: 2.5,
        position: {x: 192, y: 108, width: 960, height: 540}, motionTimeOffset: .25,
        motion: {x: [{time: 0, value: 192, easing: 'easeInOut'}], y: [{time: .5, value: 108}], scale: [{time: 0, value: 1.1}]}},
      {id: 'pause', type: 'gap', duration: .5},
      {id: 'fast', assetId: 'main', sourceStart: 3, sourceEnd: 5, playbackRate: 2,
        audio: {assetId: 'voice', sourceStart: .5, sourceEnd: 1.5, offset: -.25}},
      {id: 'last', assetId: 'insert', sourceStart: 1, sourceEnd: 2,
        transition: {type: 'crossfade', duration: .25}},
    ],
    overlays: [
      {id: 'music', type: 'audio', assetId: 'voice', start: .25, end: 1.25},
      {id: 'title', type: 'text', text: 'Title', start: 0, end: 1,
        style: {left: 192, top: 108, width: '80%', height: 54, fontSize: 64}, motion: {x: [{time: 0, value: 192}]}},
    ],
    captions: {fontSize: 64, bottom: 108, cues: [
      {id: 'first-cue', start: 1 / 24, end: 13 / 24, text: 'First\nline & <tag>'},
      {id: 'second-cue', start: 14 / 24, end: 24 / 24, text: 'Second'},
    ]},
    transcripts: [{assetId: 'main', language: 'en', words: [
      {id: 'removed', text: 'Discarded', start: .1, end: .3},
      {id: 'word-1', text: 'Keep', start: .6, end: .8},
      {id: 'word-2', text: 'this', start: .9, end: 1.1},
    ]}],
  });
  return {directory, project, projectDir, assets};
}

test('delivery presets map canvas geometry while preserving the complete edit clock', async (t) => {
  const {project, projectDir} = await fixture(t);
  const original = await readFile(join(projectDir, 'project.json'));
  const baseline = compileTimeline(project);
  const vertical = applyDeliveryPreset(project, {preset: 'vertical'});
  const compiled = compileTimeline(vertical);
  assert.deepEqual([vertical.settings.width, vertical.settings.height, compiled.fps], [1080, 1920, 24]);
  assert.equal(compiled.durationInFrames, baseline.durationInFrames);
  assert.deepEqual(compiled.clips.map(({from, durationInFrames, sourceFrame}) => [from, durationInFrames, sourceFrame]),
    baseline.clips.map(({from, durationInFrames, sourceFrame}) => [from, durationInFrames, sourceFrame]));
  assert.deepEqual(compiled.captionCues, baseline.captionCues);
  assert.equal(vertical.clips[0].fit, 'contain');
  assert.deepEqual(vertical.clips[0].position, {x: 108, y: 192, width: 540, height: 960});
  assert.deepEqual(vertical.clips[0].motion, {x: [{time: 0, value: 108, easing: 'easeInOut'}],
    y: [{time: .5, value: 192}], scale: [{time: 0, value: 1.1}]});
  assert.equal(vertical.clips[0].motionTimeOffset, .25);
  assert.deepEqual(vertical.overlays[1].style, {left: 108, top: 192, width: '80%', height: 96, fontSize: 36});
  assert.deepEqual(vertical.overlays[1].motion, {x: [{time: 0, value: 108}]});
  assert.equal(vertical.captions.bottom, 192);
  assert.equal(vertical.revision, project.revision);
  const square = applyDeliveryPreset(project, {preset: 'square', fit: 'cover'});
  assert.deepEqual([square.settings.width, square.settings.height, square.clips[0].fit], [1080, 1080, 'cover']);
  const horizontal = applyDeliveryPreset(project, {preset: 'horizontal'});
  assert.deepEqual([horizontal.settings.width, horizontal.settings.height], [1920, 1080]);
  assert.deepEqual(await readFile(join(projectDir, 'project.json')), original);
  assert.equal(project.clips[0].fit, 'cover');
});

test('subtitle delivery uses edited caption pages and preserves multiline custom cues in both formats', async (t) => {
  const {directory, project} = await fixture(t);
  const [srt, vtt] = await Promise.all([
    exportSubtitles(project, {format: 'srt', outputPath: join(directory, 'captions.srt')}),
    exportSubtitles(project, {format: 'vtt', outputPath: join(directory, 'captions.vtt')}),
  ]);
  assert.equal(srt.cueCount, 2);
  assert.equal(vtt.cueCount, 2);
  assert.equal(await readFile(srt.outputPath, 'utf8'),
    '1\n00:00:00,042 --> 00:00:00,542\nFirst\nline & <tag>\n\n2\n00:00:00,583 --> 00:00:01,000\nSecond\n');
  assert.equal(await readFile(vtt.outputPath, 'utf8'),
    'WEBVTT\n\n1\n00:00:00.042 --> 00:00:00.542\nFirst\nline &amp; &lt;tag&gt;\n\n2\n00:00:00.583 --> 00:00:01.000\nSecond\n');
  const auto = structuredClone(project);
  delete auto.captions.cues;
  const automatic = await exportSubtitles(auto, {format: 'srt', outputPath: join(directory, 'automatic.srt')});
  assert.equal(automatic.cueCount, 1);
  assert.equal(await readFile(automatic.outputPath, 'utf8'), '1\n00:00:00,083 --> 00:00:00,583\nKeep this\n');
});

test('OTIO preserves editable media ranges, gaps, transition handles and legacy split audio placement', async (t) => {
  const {directory, project, projectDir, assets} = await fixture(t);
  const manifest = await readFile(join(projectDir, 'project.json'));
  const snapshot = {...project, overlays: [...project.overlays,
    {id: 'legacy-overlay', type: 'video', assetId: 'main', start: 3.5, end: 4}]};
  const result = await exportTimeline(snapshot, {outputPath: join(directory, 'edit.otio')});
  const otio = JSON.parse(await readFile(result.outputPath, 'utf8'));
  assert.equal(otio.OTIO_SCHEMA, 'Timeline.1');
  assert.equal(otio.tracks.OTIO_SCHEMA, 'Stack.1');
  assert.equal(result.durationInFrames, 102);
  assert.equal(result.transitionCount, 1);
  assert.equal(result.assetCount, 3);
  const [picture, overlay, audio, music] = otio.tracks.children;
  assert.deepEqual([picture.kind, overlay.kind, audio.kind, music.kind], ['Video', 'Video', 'Audio', 'Audio']);
  const [first, gap, fast, dissolve, last] = picture.children;
  assert.equal(first.media_references.DEFAULT_MEDIA.target_url, pathToFileURL(assets[0].path).href);
  assert.equal(first.source_range.start_time.value, 12);
  assert.equal(first.source_range.duration.value, 48);
  assert.equal(gap.OTIO_SCHEMA, 'Gap.1');
  assert.equal(gap.source_range.duration.value, 12);
  assert.equal(fast.effects[0].OTIO_SCHEMA, 'LinearTimeWarp.1');
  assert.equal(fast.effects[0].time_scalar, 2);
  assert.equal(dissolve.OTIO_SCHEMA, 'Transition.1');
  assert.equal(dissolve.transition_type, 'SMPTE_Dissolve');
  assert.deepEqual([dissolve.in_offset.value, dissolve.out_offset.value], [3, 3]);
  assert.deepEqual([fast.source_range.duration.value, last.source_range.duration.value], [21, 21]);
  assert.equal(last.source_range.start_time.value, 27);
  const [firstAudio, gapBeforeVoice, voice] = audio.children;
  assert.equal(firstAudio.metadata.agent_video_engine.clipId, 'first');
  assert.equal(gapBeforeVoice.source_range.duration.value, 6);
  assert.equal(voice.metadata.agent_video_engine.fromFrame, 54);
  assert.equal(voice.source_range.start_time.value, 12);
  assert.equal(voice.source_range.duration.value, 12);
  assert.equal(voice.media_references.DEFAULT_MEDIA.target_url, pathToFileURL(assets[2].path).href);
  assert.equal(audio.children.at(-1).metadata.agent_video_engine.overlayId, 'legacy-overlay');
  assert.equal(audio.children.at(-1).media_references.DEFAULT_MEDIA.target_url, pathToFileURL(assets[0].path).href);
  assert.equal(music.children[0].source_range.duration.value, 6);
  assert.equal(music.children[1].metadata.agent_video_engine.overlayId, 'music');
  assert.deepEqual(await readFile(join(projectDir, 'project.json')), manifest);
  assert.equal(await readFile(assets[0].path, 'utf8'), 'fixture main');
});

test('delivery output is published once and failed verification leaves no partial file', async (t) => {
  const {directory, project, assets} = await fixture(t);
  const outputPath = join(directory, 'captions.srt');
  const attempts = await Promise.allSettled(Array.from({length: 2}, () => exportSubtitles(project, {format: 'srt', outputPath})));
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.find((result) => result.status === 'rejected').reason.code, 'OUTPUT_EXISTS');
  assert.match(await readFile(outputPath, 'utf8'), /00:00:00,042 --> 00:00:00,542/);
  await assert.rejects(exportTimeline(project, {outputPath: assets[0].path}), /\.otio/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(exportTimeline(project, {outputPath: join(directory, 'cancelled.otio'), signal: controller.signal}),
    {name: 'AbortError'});
  await writeFile(assets[0].path, 'changed source');
  await assert.rejects(exportTimeline(project, {outputPath: join(directory, 'stale.otio')}), {code: 'SOURCE_CHANGED'});
  const entries = await readdir(directory);
  assert.ok(!entries.includes('stale.otio') && !entries.includes('cancelled.otio'));
  assert.ok(!entries.some((name) => name.startsWith('.agent-video-delivery-')));
});
