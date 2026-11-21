import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {run} from '../src/media.mjs';
import {frameContext, scanFrameGlitches} from '../src/encoded-review.mjs';
import {compareExports} from '../src/export-compare.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'encoded-review-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return async (name, {picture = 'null', audio = '0', size = '160x90'} = {}) => {
    const path = join(dir, name + '.mp4');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s='+size+':r=10:d=1',
      '-f', 'lavfi', '-i', 'aevalsrc='+audio+':s=48000:d=1', '-vf', picture, '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', path]);
    return path;
  };
}
const flash = "drawbox=color=white:t=fill:enable='eq(n,4)'";

test('an isolated encoded frame has a three-frame review strip; a held change is not isolated', async t => {
  const create = await fixture(t);
  const path = await create('flash', {picture: flash});
  const scan = await scanFrameGlitches(path, {fps: 10, expectedFrames: 10});
  assert.deepEqual(scan.findings, [{frame: 4, seconds: .4}]);
  assert.equal(scan.decodedFrames, 10);
  const context = await frameContext(path, 4);
  assert.deepEqual(context.frames, [3, 4, 5]);
  assert.equal(Buffer.from(context.imageBase64, 'base64').readUInt16BE(), 0xffd8);
  await assert.rejects(frameContext(path, 10), /neighbors/);
  const hold = await create('hold', {picture: "drawbox=color=white:t=fill:enable='gte(n,4)'"});
  assert.equal((await scanFrameGlitches(hold, {fps: 10})).totalFindings, 0);
  await assert.rejects(scanFrameGlitches(path, {fps: 10, expectedFrames: 11}), /frame count/);
});

test('two real exports isolate unexpected picture and sound outside per-track time ranges', async t => {
  const create = await fixture(t);
  const baselinePath = await create('before');
  const candidatePath = await create('after', {picture: flash, audio: '0.3*sin(2*PI*400*t)*between(t\\,0.6\\,0.8)'});
  const compare = expectedChanges => compareExports({baselinePath, candidatePath, expectedChanges});
  const both = await compare([]);
  assert.equal(both.status, 'needs_review');
  assert.deepEqual(both.picture.ranges, [{startSeconds: .4, endSeconds: .5}]);
  assert.ok(both.audio.ranges.some(r => r.startSeconds <= .62 && r.endSeconds >= .78));
  const pic = {track:'picture', startSeconds:.4, endSeconds:.5};
  const sound = {track:'audio', startSeconds:.55, endSeconds:.85};
  assert.equal((await compare([pic])).picture.totalRanges, 0);
  assert.equal((await compare([sound])).picture.totalRanges, 1);
  assert.equal((await compare([pic,sound])).status, 'no_unexpected_changes');
  assert.equal((await compare([{track:'both',startSeconds:0,endSeconds:1}])).status, 'nothing_to_compare');
  await assert.rejects(compare([{track:'both',startSeconds:.5,endSeconds:1.5}]), /within the baseline/);
  const differentSize = await create('square', {size:'120x120'});
  assert.equal((await compareExports({baselinePath,candidatePath:differentSize})).status, 'incompatible');
});

test('MP4 tail rounding compares every decoded audio sample and keeps larger shortfalls invalid', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'compare-audio-tail-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const picture = join(dir, 'picture.mp4');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=64x64:r=10:d=0.5',
    '-c:v', 'libx264', picture]);
  async function exportWithTail(name, frequency, extraSamples) {
    const audio = join(dir, name + '.aac'), file = join(dir, name + '.mp4');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=sample_rate=48000:frequency=' + frequency,
      '-frames:a', '6', '-c:a', 'aac', '-f', 'adts', audio]);
    const packets = await run('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'a:0',
      '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', audio]);
    const count = Number(packets.stdout.trim());
    // MP4 can assign a longer presentation duration to the final AAC packet
    // while its decoded sample count stays fixed.
    const muxed = join(dir, name + '-original.mp4');
    await run('ffmpeg', ['-v', 'error', '-i', picture, '-i', audio, '-map', '0:v', '-map', '1:a',
      '-c', 'copy', '-movie_timescale', '48000', muxed]);
    await run('ffmpeg', ['-v', 'error', '-i', muxed, '-c', 'copy', '-bsf:a', `setts=duration=if(eq(N\\,${count - 1})\\,DURATION+${extraSamples}\\,DURATION)`,
      '-movie_timescale', '48000', file]);
    return {file, samples: count * 1024};
  }
  const {file: baselinePath, samples} = await exportWithTail('baseline', 440, 16);
  const same = await compareExports({baselinePath, candidatePath: baselinePath});
  assert.equal(same.status, 'no_unexpected_changes');
  assert.equal(same.audio.comparedUnits, samples);
  assert.equal(same.audio.containerTailRoundingSamples, 16);
  const {file: candidatePath} = await exportWithTail('different-sound', 880, 16);
  const changed = await compareExports({baselinePath, candidatePath});
  assert.equal(changed.status, 'needs_review');
  assert.ok(changed.audio.totalRanges > 0);
  const {file: short} = await exportWithTail('incomplete', 440, 2048);
  await assert.rejects(compareExports({baselinePath: short, candidatePath: short}), /Incomplete audio comparison/);
});
