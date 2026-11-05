import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, realpath, rename, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileFingerprint, run, toolEnv} from '../src/media.mjs';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');

async function pixel(file) {
  const {stdout} = await exec('ffmpeg', ['-v', 'error', '-i', file,
    '-vf', 'crop=2:2:80:44', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
  {encoding: 'buffer', env: toolEnv});
  return [...stdout.subarray(0, 3)];
}

test('real MCP stages, reviews, delivers and transfers one complete source-linked edit',
  {skip: process.env.AGENT_VIDEO_INTEGRATION !== '1', timeout: 180000}, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-editor-workflow-'));
    const projectDir = join(directory, 'project');
    const manifest = join(projectDir, 'project.json');
    const source = join(directory, 'Original picture.mp4');
    const sound = join(directory, 'Original sound.wav');
    const client = new Client({name: 'editor-workflow-check', version: '1.0.0'});
    const transport = new StdioClientTransport({command: process.execPath,
      args: [join(root, 'src/server.mjs')], env: {...toolEnv, VIDEO_ENGINE_RUNTIME: join(directory, 'runtime')}, stderr: 'pipe'});
    const call = async (name, args = {}) => {
      const response = await client.callTool({name, arguments: args});
      const value = JSON.parse(response.content.find((entry) => entry.type === 'text').text);
      if (response.isError) throw Object.assign(new Error(`${name}: ${value.message}`), {code: value.code});
      return value;
    };
    const completed = async (name, args = {}) => {
      const started = await call(name, {projectDir, ...args});
      const jobProjectDir = started.projectDir ?? projectDir;
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        const job = await call('job_get', {projectDir: jobProjectDir, jobId: started.id, includePreview: false});
        if (job.status === 'completed') return job.result;
        if (!['queued', 'running'].includes(job.status)) throw Object.assign(
          new Error(`${name}: ${job.error?.message ?? job.status}`), {code: job.error?.code});
        await delay(100);
      }
      throw new Error(`${name} job ${started.id} timed out`);
    };
    try {
      await run('ffmpeg', ['-v', 'error', '-n', '-f', 'lavfi', '-i', 'color=red:s=160x90:r=10:d=2',
        '-f', 'lavfi', '-i', 'color=blue:s=160x90:r=10:d=2',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
        '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[picture]', '-map', '[picture]', '-map', '2:a',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
      await run('ffmpeg', ['-v', 'error', '-n', '-f', 'lavfi', '-i',
        'sine=frequency=880:sample_rate=48000:duration=4', '-c:a', 'pcm_s16le', sound]);
      const sourceHash = await fileFingerprint(source), soundHash = await fileFingerprint(sound);
      await client.connect(transport);
      const presets = await call('graphic_presets');
      assert.ok(presets.lower_third && presets.title && presets.callout);
      await call('project_create', {projectDir, name: 'One complete edit', width: 160, height: 90, fps: 10});
      const picture = (await call('media_add', {projectDir, expectedRevision: 0, path: source, addToTimeline: true})).asset;
      const audio = (await call('media_add', {projectDir, expectedRevision: 1, path: sound})).asset;
      const base = await readFile(manifest, 'utf8');
      const draft = await call('draft_stage', {projectDir, expectedRevision: 2, name: 'Reviewed cut', operations: [
        {type: 'set_clips', clips: [
          {id: 'left', assetId: picture.id, sourceStart: 0, sourceEnd: 1.2},
          {id: 'right', assetId: picture.id, sourceStart: 2, sourceEnd: 3.2},
          {id: 'tail', assetId: picture.id, sourceStart: 3.2, sourceEnd: 3.8},
        ]},
        {type: 'set_transition', clipId: 'right', transition: {type: 'crossfade', duration: .4}},
        {type: 'insert_gap', index: 2, duration: .4},
        {type: 'set_clip_visual', clipId: 'tail', patch: {crop: {left: .1}, focus: {x: .8, y: .5},
          motion: {scale: [{time: 0, value: 1}, {time: .5, value: 1.1, easing: 'easeInOut'}]}}},
        {type: 'set_clip_audio', clipId: 'tail', patch: {assetId: audio.id, sourceStart: 0, sourceEnd: .9,
          offset: -.3, role: 'voice', fadeIn: .1, fadeOut: .1, envelope: [{time: 0, value: 1}, {time: .8, value: .6}]}},
        {type: 'set_audio', patch: {enabled: true, strength: 0, musicGainDb: -8,
          ducking: {enabled: true, amountDb: 6, thresholdDb: -35}, denoise: {enabled: true, amount: .25}}},
        {type: 'upsert_overlay', overlay: {id: 'music', type: 'audio', assetId: audio.id, start: 0, end: 1.6,
          audio: {role: 'music', fadeOut: .2}}},
        {type: 'upsert_overlay', overlay: {id: 'credit', type: 'text', preset: 'lower_third', text: 'First pass',
          start: .2, end: 1.2, style: {fontSize: 8, padding: 2}}},
        {type: 'set_caption_cues', cues: [{id: 'cue', start: .3, end: 1.4, text: 'An edited\ncaption'}]},
        {type: 'set_captions', patch: {fontSize: 8, bottom: 3}},
      ]});
      assert.equal(draft.diff.before.durationInFrames, 40);
      assert.equal(draft.diff.after.durationInFrames, 30);
      const staged = await call('draft_inspect', {projectDir, draftId: draft.id, includeTimeline: true});
      const stagedGap = staged.timeline.clips.find((clip) => clip.type === 'gap');
      assert.ok(stagedGap.id);
      assert.deepEqual(staged.timeline.clips.map(({from, durationInFrames}) => [from, durationInFrames]),
        [[0, 12], [8, 12], [20, 4], [24, 6]]);
      const stagedTail = staged.timeline.clips.at(-1);
      assert.equal(stagedTail.audioFrom, 21);
      assert.equal(stagedTail.audioDurationInFrames, 9);
      assert.equal(stagedTail.audioAssetId, audio.id);
      assert.equal(stagedTail.focus.x, .8);
      assert.equal(stagedTail.motion.scale[1].value, 1.1);
      assert.equal(staged.timeline.overlays.find((overlay) => overlay.id === 'credit').preset, 'lower_third');
      assert.equal(staged.timeline.captionCues[0].text, 'An edited\ncaption');

      const preview = await completed('preview_render', {expectedRevision: 2, draftId: draft.id,
        kind: 'still', frame: 22, preset: 'vertical', scale: .1});
      assert.deepEqual([preview.width, preview.height], [108, 192]);
      assert.deepEqual(await pixel(preview.outputPath), [0, 0, 0], 'The draft renders the inserted gap');
      assert.equal(await readFile(manifest, 'utf8'), base, 'Staging and previewing leave the saved edit untouched');

      const applied = await call('draft_apply', {projectDir, draftId: draft.id, expectedRevision: 2});
      assert.equal(applied.revision, 3);
      const current = await call('project_inspect', {projectDir, includeTimeline: true});
      assert.equal(current.timeline.clips.find((clip) => clip.type === 'gap').id, stagedGap.id,
        'Applying preserves the exact reviewed snapshot, including generated IDs');
      assert.deepEqual(current.timeline, staged.timeline);
      await assert.rejects(call('draft_apply', {projectDir, draftId: draft.id, expectedRevision: 3}), {code: 'REVISION_CONFLICT'});
      const changes = await call('revision_compare', {projectDir, fromRevision: 2, toRevision: 3});
      assert.equal(changes.before.durationInFrames, 40);
      assert.equal(changes.after.durationInFrames, 30);
      const historical = await completed('preview_render', {expectedRevision: 3, revision: 2, kind: 'still', frame: 22, scale: 1});
      assert.ok((await pixel(historical.outputPath))[2] > 200, 'Historical preview renders the earlier uncut source');

      const saved = await readFile(manifest, 'utf8');
      const movie = await completed('export_render', {expectedRevision: 3, preset: 'vertical', outputPath: join(directory, 'vertical.mp4')});
      assert.deepEqual([movie.width, movie.height, movie.fps, movie.durationInFrames], [1080, 1920, 10, 30]);
      assert.equal(movie.verification.audio, true);
      assert.equal(movie.audio.peakSafety.passed, true);
      assert.equal(movie.audio.mix.denoise.enabled, true);
      assert.equal(movie.audio.mix.ducking.target, 'music');
      assert.ok(movie.audio.encoded.truePeakDb <= movie.audio.settings.truePeakDb);
      const movieHash = await fileFingerprint(movie.outputPath);
      const srt = await completed('export_subtitles', {expectedRevision: 3, format: 'srt', outputPath: 'delivery/captions.srt'});
      assert.equal(await readFile(srt.outputPath, 'utf8'), '1\n00:00:00,300 --> 00:00:01,400\nAn edited\ncaption\n');
      const interchange = await completed('export_timeline', {expectedRevision: 3, outputPath: 'delivery/edit.otio'});
      const editable = JSON.parse(await readFile(interchange.outputPath, 'utf8'));
      assert.equal(interchange.durationInFrames, movie.durationInFrames);
      assert.ok(editable.tracks.children[0].children.some((item) => item.OTIO_SCHEMA === 'Transition.1'));
      assert.ok(editable.tracks.children.filter((track) => track.kind === 'Audio').some((track) => track.children.some((item) =>
        item.metadata.agent_video_engine?.clipId === 'tail' && item.metadata.agent_video_engine.fromFrame === 21)));
      await assert.rejects(completed('export_subtitles', {expectedRevision: 3, format: 'srt', outputPath: srt.outputPath}), {code: 'OUTPUT_EXISTS'});

      const bundleDir = join(directory, 'bundle');
      const bundle = await completed('project_bundle', {expectedRevision: 3, bundleDir});
      assert.equal(bundle.assetCount, 2);
      const reopenedDir = join(directory, 'reopened');
      const opened = await completed('project_open_bundle', {projectDir: reopenedDir, bundleDir});
      assert.equal(await realpath(opened.projectDir), await realpath(reopenedDir));
      const reopened = await call('project_inspect', {projectDir: opened.projectDir, includeTimeline: true});
      assert.equal(reopened.durationInFrames, 30);
      assert.equal(reopened.timeline.clips.find((clip) => clip.type === 'gap').id, stagedGap.id);
      assert.equal(await fileFingerprint(reopened.assets.find((asset) => asset.id === picture.id).path), sourceHash);
      assert.equal(await readFile(manifest, 'utf8'), saved, 'Delivery and packaging preserve the accepted revision');

      const moved = join(directory, 'Moved original.mp4');
      await rename(source, moved);
      await assert.rejects(call('media_relink', {projectDir, expectedRevision: 3,
        replacements: [{assetId: picture.id, path: sound}]}), {code: 'RELINK_FINGERPRINT_MISMATCH'});
      assert.equal(await readFile(manifest, 'utf8'), saved);
      const relinked = await call('media_relink', {projectDir, expectedRevision: 3,
        replacements: [{assetId: picture.id, path: moved}]});
      assert.equal(relinked.revision, 4);
      assert.equal(relinked.relinked[0].path, await realpath(moved));
      assert.equal((await call('project_validate', {projectDir})).durationInFrames, 30);
      assert.equal(await fileFingerprint(moved), sourceHash);
      assert.equal(await fileFingerprint(sound), soundHash);
      assert.equal(await fileFingerprint(movie.outputPath), movieHash);
    } finally {
      await client.close().catch(() => {});
      await rm(directory, {recursive: true, force: true});
    }
  });
