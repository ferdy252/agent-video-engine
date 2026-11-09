import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildExportQuality, verifyExportQuality} from '../src/export-quality.mjs';
import {fileFingerprint, run} from '../src/media.mjs';

const settings = {width: 160, height: 90, fps: 10};
const composition = {...settings, durationInFrames: 4};
const dimensions = {width: settings.width, height: settings.height};
const project = {
  revision: 3, settings,
  assets: [
    {id: 'main', type: 'video', path: '/private/source/original.mp4', width: 3840, height: 2160},
    {id: 'image', type: 'image', path: '/private/source/graphic.png'},
    {id: 'unused', type: 'video', path: '/private/source/other.mp4', width: 320, height: 180},
  ],
  clips: [{assetId: 'main'}, {assetId: 'main'}],
  overlays: [{assetId: 'image'}],
};

async function fixture(t, {size = '160x90', codec = 'libx264', pixelFormat = 'yuv420p',
  audioCodec = 'aac', extension = 'mp4', still = false} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-video-export-quality-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const filePath = join(directory, still ? 'example.png' : `example.${extension}`);
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=blue:s=${size}:r=10:d=0.4`,
    ...(still ? ['-frames:v', '1', '-c:v', 'png', '-update', '1'] :
      [...(audioCodec ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-c:a', audioCodec, '-shortest'] : ['-an']),
        '-c:v', codec, '-pix_fmt', pixelFormat, '-metadata', 'title=quality-byte-marker-a']),
    filePath]);
  return filePath;
}

function build(filePath, options = {}) {
  return buildExportQuality({filePath, project, kind: 'video', composition, dimensions,
    frameRange: [0, 3], scale: 1, ...options});
}

function save(filePath, report) {
  return writeFile(`${filePath}.quality.json`, JSON.stringify(report));
}

const warningCodes = (report) => report.warnings.map(({code}) => code);

test('a low-resolution final needs review unless its requested minimum allows it', async (t) => {
  const filePath = await fixture(t);
  const standard = await build(filePath);
  assert.equal(standard.purpose, 'final');
  assert.equal(standard.status, 'needs_review');
  assert.deepEqual(warningCodes(standard), ['FINAL_RESOLUTION_BELOW_MINIMUM']);
  assert.deepEqual(standard.target, {...settings, minShortSide: 1080});
  assert.deepEqual(standard.encoding.requested, {codec: 'h264', audioCodec: 'aac', container: 'mp4',
    pixelFormat: 'yuv420p', rateControl: 'crf', crf: 18});
  assert.deepEqual([standard.measured.width, standard.measured.height, standard.measured.fps,
    standard.measured.frames, standard.measured.durationSeconds], [160, 90, 10, 4, 0.4]);
  assert.equal(standard.fingerprint.sha256, (await fileFingerprint(filePath)).slice('sha256:'.length));
  assert.deepEqual(standard.sourceResolution, {scope: 'engine_timeline_references', visualAssetCount: 2,
    unknownDimensionsCount: 1, sizes: [{width: 3840, height: 2160, count: 1}]});
  assert.ok(!JSON.stringify(standard).includes('/private/source'));
  await save(filePath, standard);
  const verifiedLow = await verifyExportQuality(filePath);
  assert.equal(verifiedLow.status, 'needs_review');
  assert.equal(verifiedLow.verification.report, 'matched');
  assert.equal(verifiedLow.verification.verifiedFinal, false);

  const explicitlySmall = await build(filePath, {minShortSide: 90});
  assert.equal(explicitlySmall.status, 'passed');
  assert.ok(explicitlySmall.measured.videoBitrateBps < 100000, 'This low-bitrate fixture passes the explicit size target');
  assert.deepEqual(explicitlySmall.warnings, []);
  await save(filePath, explicitlySmall);
  const verified = await verifyExportQuality(filePath);
  assert.deepEqual(verified.verification, {report: 'matched', fingerprintMatches: true, metadataMatches: true, verifiedFinal: true});
});

test('matching previews and stills remain non-final, including source previews', async (t) => {
  const filePath = await fixture(t);
  for (const [purpose, sourcePreview] of [['preview', false], ['source_preview', true]]) {
    const report = await build(filePath, {kind: 'preview', sourcePreview, minShortSide: 90});
    assert.equal(report.purpose, purpose);
    assert.equal(report.encoding.requested.crf, 25);
    await save(filePath, report);
    const verified = await verifyExportQuality(filePath);
    assert.equal(verified.status, 'not_final');
    assert.equal(verified.verification.report, 'matched');
    assert.equal(verified.verification.verifiedFinal, false);
  }
  const image = await fixture(t, {still: true});
  const still = await build(image, {kind: 'still', frameRange: undefined});
  assert.equal(still.purpose, 'still');
  assert.equal(still.encoding.requested, null);
  assert.equal(still.measured.fps, null);
  await save(image, still);
  assert.equal((await verifyExportQuality(image)).status, 'not_final');
});

test('verification refuses absent, malformed or inconsistent reports and independent file and metadata changes', async (t) => {
  const filePath = await fixture(t);
  const report = await build(filePath, {minShortSide: 90});
  const missing = await verifyExportQuality(filePath);
  assert.equal(missing.status, 'needs_review');
  assert.equal(missing.verification.report, 'missing');
  assert.deepEqual(warningCodes(missing), ['QUALITY_REPORT_MISSING']);
  await writeFile(`${filePath}.quality.json`, '{broken');
  for (const malformed of [null, {purpose: 'final', status: 'passed'}, {...report, status: 'not_final'},
    {...report, purpose: 'preview'}, {...report, render: {...report.render, frameRange: [3, 1]}}]) {
    if (malformed !== null) await save(filePath, malformed);
    const rejected = await verifyExportQuality(filePath);
    assert.equal(rejected.status, 'needs_review');
    assert.equal(rejected.verification.report, 'malformed');
    assert.equal(rejected.verification.verifiedFinal, false);
  }

  await save(filePath, {...report, measured: {...report.measured, bitrateBps: report.measured.bitrateBps + 1}});
  const metadata = await verifyExportQuality(filePath);
  assert.equal(metadata.verification.fingerprintMatches, true);
  assert.equal(metadata.verification.metadataMatches, false);
  assert.deepEqual(warningCodes(metadata), ['EXPORT_METADATA_MISMATCH']);
  await save(filePath, report);

  const bytes = await readFile(filePath);
  const marker = Buffer.from('quality-byte-marker-a');
  const offset = bytes.indexOf(marker);
  assert.ok(offset >= 0);
  bytes[offset + marker.length - 1] = 'b'.charCodeAt(0);
  await writeFile(filePath, bytes);
  const changed = await verifyExportQuality(filePath);
  assert.equal(changed.status, 'needs_review');
  assert.deepEqual(changed.verification, {report: 'mismatch', fingerprintMatches: false, metadataMatches: true, verifiedFinal: false});
  assert.deepEqual(warningCodes(changed), ['EXPORT_FINGERPRINT_MISMATCH']);
});

test('wrong output format or dimensions and scaled or partial final settings require review', async (t) => {
  const wrongCodec = await fixture(t, {size: '128x72', codec: 'mpeg4'});
  const incompatible = await build(wrongCodec, {minShortSide: 72});
  assert.equal(incompatible.status, 'needs_review');
  assert.ok(warningCodes(incompatible).includes('OUTPUT_CODEC_MISMATCH'));
  assert.ok(warningCodes(incompatible).includes('OUTPUT_DIMENSIONS_MISMATCH'));
  const wrongPixels = await fixture(t, {pixelFormat: 'yuv444p'});
  const color = await build(wrongPixels, {minShortSide: 90});
  assert.equal(color.measured.pixelFormat, 'yuv444p');
  assert.deepEqual(warningCodes(color), ['OUTPUT_PIXEL_FORMAT_MISMATCH']);
  for (const audioCodec of [null, 'alac']) {
    const wrongAudio = await fixture(t, {audioCodec});
    const audio = await build(wrongAudio, {minShortSide: 90});
    assert.equal(audio.measured.audioCodec, audioCodec);
    assert.deepEqual(warningCodes(audio), ['OUTPUT_AUDIO_CODEC_MISMATCH']);
  }
  const quickTime = await build(await fixture(t, {extension: 'mov'}), {minShortSide: 90});
  assert.equal(quickTime.measured.majorBrand.trim(), 'qt');
  assert.deepEqual(warningCodes(quickTime), ['OUTPUT_CONTAINER_MISMATCH']);
  const normal = await fixture(t);
  const altered = await build(normal, {minShortSide: 90, scale: .5,
    project: {...project, settings: {...settings, fps: 24}},
    composition: {width: 320, height: 180, fps: 10, durationInFrames: 8}});
  assert.deepEqual(warningCodes(altered), ['TARGET_DIMENSIONS_MISMATCH', 'TARGET_FPS_MISMATCH', 'SCALED_FINAL', 'PARTIAL_FINAL']);
});
