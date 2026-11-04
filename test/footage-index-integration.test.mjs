import test from 'node:test';
import assert from 'node:assert/strict';
import {access, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileFingerprint, run, toolEnv} from '../src/media.mjs';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');

function transcriptFixture() {
  const passages = [
    'Save your work before you save time.',
    'Save your work before you save time.',
    'Save your work before you save time.',
    'Change the setting before sharing screenshots.',
    'Change the setting before sharing screenshots.',
    'Change the setting before sharing screenshots.',
    'The battery lasts several hours on a charge.',
  ];
  const starts = [0.1, 1.8, 3.5, 5.2, 6.9, 8.6, 10.3];
  const wordGroups = passages.map((passage, attempt) => passage.split(' ').map((text, word) => ({
    id: `passage-${attempt + 1}-word-${word + 1}`,
    text,
    start: Number((starts[attempt] + word * 0.07).toFixed(3)),
    end: Number((starts[attempt] + word * 0.07 + 0.05).toFixed(3)),
  })));
  return {document: {language: 'en', words: wordGroups.flat()}, wordGroups};
}

test('real MCP maps repeated takes in one continuous source, searches alternatives and keeps indexes private and current', {
  skip: process.env.AGENT_VIDEO_INTEGRATION !== '1', timeout: 180000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-footage-index-'));
  const projectDir = join(directory, 'project');
  const visualProjectDir = join(directory, 'visual-only-project');
  const runtime = join(directory, 'runtime');
  const source = join(directory, 'continuous-source.mp4');
  const transcriptPath = join(directory, 'source-words.json');
  const manifest = join(projectDir, 'project.json');
  const client = new Client({name: 'footage-index-check', version: '1.0.0'});
  const transport = new StdioClientTransport({command: process.execPath, args: [join(root, 'src/server.mjs')],
    env: {...toolEnv, VIDEO_ENGINE_RUNTIME: runtime}, stderr: 'pipe'});
  let blocker;
  const response = (name, args) => client.callTool({name, arguments: args});
  const parse = (result) => {
    const value = JSON.parse(result.content.find((item) => item.type === 'text').text);
    if (result.isError) throw Object.assign(new Error(value.message), {code: value.code});
    return value;
  };
  const call = async (name, args) => parse(await response(name, args));
  const wait = async (started, target = projectDir) => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const job = await call('job_get', {projectDir: target, jobId: started.id, includePreview: false});
      assert.ok(Number.isFinite(job.progress), 'Index jobs report finite progress');
      if (!['running', 'queued'].includes(job.status)) return job;
      await delay(100);
    }
    throw new Error(`Footage index job ${started.id} timed out`);
  };
  const complete = async (args) => {
    const job = await wait(await call('media_index', args), args.projectDir);
    assert.equal(job.status, 'completed', JSON.stringify(job.error));
    return job.result;
  };
  const framePixels = async (file, time) => {
    const {stdout} = await exec('ffmpeg', ['-v', 'error', ...(time === undefined ? [] : ['-ss', String(time)]),
      '-i', file, '-vf', 'scale=32:18,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'],
    {encoding: 'buffer', env: toolEnv});
    assert.equal(stdout.length, 32 * 18 * 3);
    return stdout;
  };
  const fixture = transcriptFixture();
  try {
    // One continuously changing test pattern, without scene cuts. Take grouping
    // must come from the supplied source transcript, not visual scene changes.
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n',
      '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=20:duration=12',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
    const sourceHash = await fileFingerprint(source);
    await writeFile(transcriptPath, JSON.stringify(fixture.document));
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of ['media_index', 'media_index_get', 'media_search']) assert.ok(names.includes(name));
    await call('project_create', {projectDir, name: 'Continuous recording', width: 160, height: 90, fps: 20});
    const {asset: {id: assetId}} = await call('media_add', {projectDir, expectedRevision: 0, path: source, addToTimeline: true});
    await call('transcript_import', {projectDir, expectedRevision: 1, assetId, path: transcriptPath});
    const beforeIndex = await readFile(manifest, 'utf8');
    const options = {projectDir, expectedRevision: 2, assetId, intervalSeconds: 1, maxThumbnails: 24};
    const indexed = await complete(options);
    assert.equal(indexed.assetId, assetId);
    assert.equal(indexed.cached, false);
    assert.equal(indexed.counts.attempts, 7);
    assert.equal(indexed.counts.retakeGroups, 2);
    assert.ok(indexed.counts.thumbnails > 12 && indexed.counts.thumbnails <= 24);
    assert.equal(indexed.counts.contactSheets, 2);
    assert.ok(indexed.indexPath.startsWith(join(projectDir, '.engine', 'indexes') + sep));
    assert.equal(await readFile(manifest, 'utf8'), beforeIndex, 'Indexing leaves the master revision and edit unchanged');
    assert.equal(await fileFingerprint(source), sourceHash);

    const readResponse = await response('media_index_get', {projectDir, indexId: indexed.indexId, limit: 20, sheetPage: 0});
    const map = parse(readResponse);
    assert.equal(map.status, 'current');
    assert.equal(map.totalAttempts, 7);
    assert.equal(map.attempts.length, 7);
    assert.equal(map.groups.length, 2);
    assert.deepEqual(map.groups.map((group) => group.attemptIds.length).sort(), [3, 3]);
    const allWordIds = new Set(fixture.document.words.map((word) => word.id));
    for (const attempt of map.attempts) {
      assert.ok(attempt.wordIds.length > 0);
      assert.ok(attempt.wordIds.every((id) => allWordIds.has(id)), 'Source word IDs survive indexing');
      assert.equal(attempt.sourcePreview.assetId, assetId);
      assert.ok(attempt.sourcePreview.sourceStart <= attempt.start);
      assert.ok(attempt.sourcePreview.sourceEnd >= attempt.end, 'Short source attempts retain preview context on both sides');
      assert.ok(attempt.start >= 0 && attempt.end > attempt.start && attempt.end <= 12);
    }
    const unrelated = map.attempts.find((attempt) => attempt.text.toLowerCase().includes('battery'));
    assert.ok(unrelated);
    assert.deepEqual(unrelated.groupIds, [], 'An unrelated later section is not labeled an alternative take');
    assert.ok(map.groups.every((group) => !group.attemptIds.includes(unrelated.id)));
    assert.ok(map.limitations.some((text) => /possible|heuristic|best|quality|semantic/i.test(text)), 'The map explains that grouping is evidence, not a best-take decision');
    assert.equal(map.contactSheet.page, 0);
    assert.equal(map.contactSheet.frameIds.length, map.frames.length);
    assert.ok(map.frames.length > 0 && map.frames.length <= 12);
    for (const frame of map.frames) {
      const cell = map.contactSheet.cells.find((item) => item.frameId === frame.id);
      assert.ok(cell, 'Every displayed sample has an identified contact-sheet cell');
      assert.equal(cell.sourceTime, frame.sourceTime);
      assert.equal(frame.time, frame.sourceTime);
      assert.ok(frame.sourceTime >= 0 && frame.sourceTime < 12);
      assert.ok(frame.label.includes(frame.id), 'Visible labels map back to stable frame IDs');
    }
    const jpeg = readResponse.content.find((item) => item.type === 'image');
    assert.ok(jpeg, 'The MCP client receives the selected contact sheet inline');
    assert.equal(jpeg.mimeType, 'image/jpeg');
    assert.equal(Buffer.from(jpeg.data, 'base64').subarray(0, 3).toString('hex'), 'ffd8ff');
    const secondSheet = await call('media_index_get', {projectDir, indexId: indexed.indexId, limit: 2, offset: 2, sheetPage: 1, includePreview: false});
    assert.equal(secondSheet.attempts.length, 2);
    assert.equal(secondSheet.offset, 2);
    assert.equal(secondSheet.nextOffset, 4);
    assert.equal(secondSheet.contactSheet.page, 1);
    assert.ok(secondSheet.frames.length > 0 && secondSheet.frames.length <= 12);
    assert.ok(!secondSheet.frames.some((frame) => map.contactSheet.frameIds.includes(frame.id)), 'Contact sheet pages identify distinct source samples');

    const found = await call('media_search', {projectDir, indexId: indexed.indexId, query: 'save time', limit: 20});
    assert.equal(found.totalMatches, 3);
    for (const match of found.matches) {
      assert.ok(match.text.toLowerCase().includes('save time'));
      assert.ok(match.wordIds.every((id) => allWordIds.has(id)));
      const hitAttempt = map.attempts.find((attempt) => attempt.id === match.attemptId);
      const sourceWords = fixture.document.words.filter((word) => hitAttempt.wordIds.includes(word.id));
      assert.equal(match.start, sourceWords[5].start, 'Search locates the full phrase, not the earlier standalone word Save');
      assert.equal(match.end, sourceWords[6].end);
      assert.deepEqual(match.wordIds, sourceWords.slice(5, 7).map((word) => word.id), 'Edit-ready search IDs cover only the matched phrase');
      assert.equal(match.text, 'save time.');
      assert.ok(match.contextText.startsWith('Save your work'), 'Surrounding speech is explicitly separate from edit-ready IDs');
      assert.equal(match.alternatives.length, 2);
      for (const alternative of match.alternatives) {
        const original = map.attempts.find((attempt) => attempt.id === (alternative.id ?? alternative.attemptId));
        assert.ok(original && original.id !== match.attemptId);
        assert.deepEqual(alternative.wordIds, original.wordIds, 'Alternative takes retain the exact original word IDs');
      }
    }
    const unrelatedSearch = await call('media_search', {projectDir, indexId: indexed.indexId, query: 'battery lasts'});
    assert.equal(unrelatedSearch.totalMatches, 1);
    assert.deepEqual(unrelatedSearch.matches[0].alternatives, []);

    // Source preview requests returned by search must seek the original source,
    // even after an independent saved edit is later changed.
    const match = found.matches[2];
    const previewJob = await wait(await call('source_preview', {projectDir, expectedRevision: 2,
      ...match.sourcePreview, kind: 'still', scale: 1}));
    assert.equal(previewJob.status, 'completed', JSON.stringify(previewJob.error));
    const expected = await framePixels(source, match.sourcePreview.sourceStart);
    const actual = await framePixels(previewJob.result.outputPath);
    const meanDifference = actual.reduce((sum, value, index) => sum + Math.abs(value - expected[index]), 0) / actual.length;
    assert.ok(meanDifference < 12, `Search preview must resolve to its source timestamp (mean pixel difference ${meanDifference})`);

    await call('edit_apply', {projectDir, expectedRevision: 2, operations: [{type: 'set_captions', patch: {enabled: false}}]});
    const afterTimelineEdit = await readFile(manifest, 'utf8');
    const cached = await complete({...options, expectedRevision: 3});
    assert.equal(cached.cached, true);
    assert.equal(cached.indexId, indexed.indexId, 'A timeline-only edit reuses the source/transcript index');
    assert.equal(await readFile(manifest, 'utf8'), afterTimelineEdit);
    assert.equal((await call('media_index_get', {projectDir, indexId: indexed.indexId, includePreview: false})).currentRevision, 3);

    const revisedWords = structuredClone(fixture.document);
    revisedWords.words[0].text = 'This';
    await writeFile(transcriptPath, JSON.stringify(revisedWords));
    await call('transcript_import', {projectDir, expectedRevision: 3, assetId, path: transcriptPath});
    await assert.rejects(call('media_index_get', {projectDir, indexId: indexed.indexId}), {code: 'STALE_MEDIA_INDEX'});
    await assert.rejects(call('media_search', {projectDir, indexId: indexed.indexId, query: 'save time'}), {code: 'STALE_MEDIA_INDEX'});
    const revised = await complete({...options, expectedRevision: 4});
    assert.equal(revised.cached, false);
    assert.notEqual(revised.indexId, indexed.indexId, 'Changed source transcript produces a new index');
    assert.equal((await call('media_index_get', {projectDir, indexId: revised.indexId, includePreview: false})).status, 'current');

    const indexRoot = join(projectDir, '.engine', 'indexes');
    const beforeCancel = (await readdir(indexRoot)).sort();
    const port = 49152 + createHash('sha256').update(runtime).digest().readUInt16BE(0) % 10000;
    blocker = createServer((socket) => socket.destroy());
    await new Promise((ready, reject) => {blocker.once('error', reject); blocker.listen(port, '127.0.0.1', ready);});
    const queued = await call('media_index', {...options, expectedRevision: 4, intervalSeconds: 2, maxThumbnails: 12});
    await delay(300);
    await call('job_cancel', {projectDir, jobId: queued.id});
    const cancelled = await wait(queued);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.result, undefined);
    assert.deepEqual((await readdir(indexRoot)).sort(), beforeCancel, 'A cancelled queued index creates no partial cache');
    await new Promise((done) => blocker.close(done));
    blocker = null;

    await call('project_create', {projectDir: visualProjectDir, name: 'Visual source map', width: 160, height: 90, fps: 20});
    const visualAsset = await call('media_add', {projectDir: visualProjectDir, expectedRevision: 0, path: source});
    const visual = await complete({projectDir: visualProjectDir, expectedRevision: 1, assetId: visualAsset.asset.id, intervalSeconds: 2, maxThumbnails: 6});
    assert.equal(visual.counts.attempts, 0);
    assert.equal(visual.counts.retakeGroups, 0);
    const visualMap = await call('media_index_get', {projectDir: visualProjectDir, indexId: visual.indexId});
    assert.equal(visualMap.transcriptStatus, 'missing');
    assert.equal(visualMap.visualOnly, true);
    assert.ok(visualMap.frames.length > 0);
    assert.equal((await call('media_search', {projectDir: visualProjectDir, indexId: visual.indexId, query: 'save time'})).totalMatches, 0);
    await assert.rejects(access(join(visualProjectDir, '.engine', 'transcripts')), {code: 'ENOENT'});
    assert.equal(await fileFingerprint(source), sourceHash, 'Indexing, searching and previews preserve the source recording');
  } finally {
    if (blocker) await new Promise((done) => blocker.close(done));
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await rm(directory, {recursive: true, force: true});
  }
});
