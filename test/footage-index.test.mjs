import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {createProject} from '../src/project.mjs';
import {fileFingerprint, probeAsset, run} from '../src/media.mjs';
import {buildMediaIndex, readMediaIndex, searchMediaIndex} from '../src/footage-index.mjs';

async function fixture(t, {transcript = true} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'source-index-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const source = join(directory, 'original.wav');
  // Valid two-second silent PCM fixture, generated without external models.
  const sampleRate = 8000, dataBytes = sampleRate * 2 * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF'); wav.writeUInt32LE(36 + dataBytes, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(dataBytes, 40);
  await writeFile(source, wav);
  const words = ['Save', 'your', 'work', 'before', 'you', 'save', 'time.'].map((text, index) =>
    ({id: `w${index}`, text, start: .1 + index * .12, end: .18 + index * .12}));
  const projectDir = join(directory, 'project');
  const project = await createProject(projectDir, {name: 'Source text map', assets: [{id: 'recording', path: source,
    type: 'audio', duration: 2, hasAudio: true, fingerprint: await fileFingerprint(source)}],
    transcripts: transcript ? [{assetId: 'recording', language: 'en', words}] : []});
  return {directory, source, projectDir, project, words};
}

test('audio-only index stays source-linked and exact phrase search uses the later matching words', async (t) => {
  const {projectDir, project, words, source} = await fixture(t);
  const before = await readFile(join(projectDir, 'project.json'), 'utf8');
  const fingerprint = await fileFingerprint(source);
  const built = await buildMediaIndex(project, {projectDir, assetId: 'recording'});
  assert.equal(built.cached, false);
  assert.equal(built.counts.thumbnails, 0);
  assert.equal(built.counts.contactSheets, 0);
  const page = await readMediaIndex({...project, revision: 9}, {projectDir, indexId: built.indexId});
  assert.equal(page.currentRevision, 9);
  assert.equal(page.contactSheet, null);
  assert.equal(page.attempts[0].wordIds.length, words.length);
  assert.ok(page.limitations.some((message) => /audio recording/i.test(message)));
  const found = await searchMediaIndex(project, {projectDir, indexId: built.indexId, query: 'save time'});
  assert.equal(found.totalMatches, 1);
  assert.equal(found.matches[0].start, words[5].start);
  assert.equal(found.matches[0].end, words[6].end);
  assert.deepEqual(found.matches[0].wordIds, ['w5', 'w6']);
  assert.equal(found.matches[0].text, 'save time.');
  assert.match(found.matches[0].contextText, /^Save your work/);
  assert.ok(found.matches[0].sourcePreview.sourceStart < words[5].start);
  assert.ok(found.matches[0].sourcePreview.sourceEnd > words[6].end);
  assert.equal((await searchMediaIndex(project, {projectDir, indexId: built.indexId, query: 'ave'})).totalMatches, 0);
  assert.equal((await buildMediaIndex({...project, revision: 9}, {projectDir, assetId: 'recording'})).cached, true);
  assert.equal(await readFile(join(projectDir, 'project.json'), 'utf8'), before);
  assert.equal(await fileFingerprint(source), fingerprint);
});

test('cache is independent of timeline edits and invalidated by transcript, options or original changes', async (t) => {
  const {projectDir, project, source} = await fixture(t);
  const built = await buildMediaIndex(project, {projectDir, assetId: 'recording'});
  const edited = {...project, revision: 10, clips: [{id: 'kept', assetId: 'recording', sourceStart: .4,
    sourceEnd: 1, playbackRate: 1, volume: 1, fit: 'contain'}]};
  const cached = await buildMediaIndex(edited, {projectDir, assetId: 'recording'});
  assert.equal(cached.indexId, built.indexId);
  assert.equal(cached.cached, true);
  const changed = structuredClone(project);
  changed.transcripts[0].words[5].text = 'keep';
  await assert.rejects(readMediaIndex(changed, {projectDir, indexId: built.indexId}), {code: 'STALE_MEDIA_INDEX'});
  const fresh = await buildMediaIndex(changed, {projectDir, assetId: 'recording'});
  assert.notEqual(fresh.indexId, built.indexId);
  const changedOptions = await buildMediaIndex(project, {projectDir, assetId: 'recording', intervalSeconds: 2, maxThumbnails: 6});
  assert.notEqual(changedOptions.indexId, built.indexId);
  const bytes = await readFile(source); bytes[bytes.length - 1] = 1; await writeFile(source, bytes);
  await assert.rejects(readMediaIndex(project, {projectDir, indexId: built.indexId}), {code: 'STALE_MEDIA_INDEX'});
  await assert.rejects(buildMediaIndex(project, {projectDir, assetId: 'recording'}), {code: 'SOURCE_CHANGED'});
});

test('concurrent builders converge on one completed cache and a dead or malformed commit lock is recoverable', async (t) => {
  const {projectDir, project} = await fixture(t);
  const results = await Promise.all([buildMediaIndex(project, {projectDir, assetId: 'recording'}),
    buildMediaIndex(project, {projectDir, assetId: 'recording'})]);
  assert.equal(results[0].indexId, results[1].indexId);
  assert.equal(results.filter((result) => !result.cached).length, 1);
  const parent = dirname(results[0].indexPath), indexId = results[0].indexId;
  const cacheRoot = dirname(parent);
  assert.ok(!(await readdir(cacheRoot)).some((file) => file.startsWith('.')));
  await writeFile(join(parent, 'index.json'), 'broken');
  const lock = join(cacheRoot, `.commit-${indexId}.lock`);
  await writeFile(lock, JSON.stringify({pid: 99999999, token: 'dead'}));
  assert.equal((await buildMediaIndex(project, {projectDir, assetId: 'recording'})).cached, false);
  await writeFile(join(parent, 'index.json'), 'broken');
  await writeFile(lock, '');
  const old = new Date(Date.now() - 5000); await utimes(lock, old, old);
  assert.equal((await buildMediaIndex(project, {projectDir, assetId: 'recording'})).cached, false);
});

test('index reads reject traversal and cancellation removes incomplete derived output', async (t) => {
  const {projectDir, project} = await fixture(t, {transcript: false});
  await assert.rejects(readMediaIndex(project, {projectDir, indexId: '../outside'}), {code: 'INVALID_MEDIA_INDEX_ID'});
  const controller = new AbortController();
  await assert.rejects(buildMediaIndex(project, {projectDir, assetId: 'recording', signal: controller.signal,
    onProgress: () => controller.abort()}), {name: 'AbortError'});
  assert.deepEqual(await readdir(join(projectDir, '.engine/indexes')), []);
  const built = await buildMediaIndex(project, {projectDir, assetId: 'recording'});
  const page = await readMediaIndex(project, {projectDir, indexId: built.indexId});
  assert.equal(page.transcriptStatus, 'missing');
  assert.equal(page.visualOnly, false);
  assert.equal(page.indexMode, 'metadata_only');
  assert.deepEqual(page.attempts, []);
});

test('portrait video maps stop at the video stream end, label source times and reject escaped cached media',
  {skip: process.env.AGENT_VIDEO_RENDER_SMOKE !== '1', timeout: 120000}, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'source-index-video-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const source = join(directory, 'portrait-with-audio-tail.mp4');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi', '-i', 'color=cyan:s=90x160:r=20:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
    const asset = await probeAsset(source, 'recording');
    assert.ok(asset.duration > 2.4);
    const projectDir = join(directory, 'project');
    const project = await createProject(projectDir, {name: 'Visual-only portrait', assets: [asset]});
    const before = await readFile(join(projectDir, 'project.json'), 'utf8');
    const built = await buildMediaIndex(project, {projectDir, assetId: asset.id, intervalSeconds: 1, maxThumbnails: 6});
    const page = await readMediaIndex(project, {projectDir, indexId: built.indexId});
    assert.equal(page.visualOnly, true);
    assert.ok(page.frames.every((frame) => frame.time < 2));
    assert.ok(page.frames[page.frames.length - 1].time > 1.8);
    assert.ok(page.contactSheet.cells.every((cell) => cell.label.includes(cell.frameId) && /\d{2}h \d{2}m \d{2}\.\d{3}s/.test(cell.label)));
    const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', page.contactSheet.path])).stdout);
    assert.equal(probe.streams[0].width, page.contactSheet.width);
    assert.equal(probe.streams[0].height, page.contactSheet.height);
    assert.equal(await readFile(join(projectDir, 'project.json'), 'utf8'), before);
    assert.equal(await fileFingerprint(source), asset.fingerprint);
    const stored = JSON.parse(await readFile(built.indexPath, 'utf8'));
    stored.contactSheets[0].path = '../outside.jpg';
    await writeFile(built.indexPath, JSON.stringify(stored));
    await assert.rejects(readMediaIndex(project, {projectDir, indexId: built.indexId}), {code: 'MEDIA_INDEX_INCOMPLETE'});
    assert.equal((await buildMediaIndex(project, {projectDir, assetId: asset.id, intervalSeconds: 1, maxThumbnails: 6})).cached, false);
    const valid = await readMediaIndex(project, {projectDir, indexId: built.indexId});
    const outside = join(directory, 'outside.jpg'); await writeFile(outside, 'not a registered image');
    await rm(valid.contactSheet.path); await symlink(outside, valid.contactSheet.path);
    await assert.rejects(readMediaIndex(project, {projectDir, indexId: built.indexId}), {code: 'MEDIA_INDEX_INCOMPLETE'});
  });
