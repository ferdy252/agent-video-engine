import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm, access, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {run, fileFingerprint} from '../src/media.mjs';
import {importCutScript} from '../src/import-legacy.mjs';
import {compileTimeline, loadProject} from '../src/project.mjs';

async function fixture(t, patch = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-video-cutscript-import-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const media = path.join(directory, 'original.wav');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi', '-i',
    'sine=frequency=440:sample_rate=16000:duration=4', '-c:a', 'pcm_s16le', media]);
  const sourceProject = path.join(directory, 'Edit.aive');
  const document = {version: 1, videoPath: './original.wav', language: 'en',
    words: [{word: 'Hello', start: 0.5, end: 0.8, confidence: 0.9},
      {word: 'world', start: 2.5, end: 2.9, confidence: 0.8}],
    segments: [], deletedRanges: [], createdAt: '2026-11-04T12:00:00.000Z', modifiedAt: '2026-11-04T12:00:00.000Z', ...patch};
  await writeFile(sourceProject, `${JSON.stringify(document, null, 2)}\n`);
  return {directory, media, sourceProject, projectDir: path.join(directory, 'new-project')};
}

test('CutScript import preserves source-linked cuts, transcript and untouched originals', async (t) => {
  const {media, sourceProject, projectDir} = await fixture(t, {deletedRanges: [
    {id: 'one', start: 1, end: 2, wordIndices: []},
    {id: 'overlap', start: 1.5, end: 2.25, wordIndices: []},
    {id: 'outside', start: -5, end: 0.2, wordIndices: []},
    {id: 'tail', start: 3.8, end: 9, wordIndices: []},
  ]});
  const fingerprint = await fileFingerprint(media);
  const originalProject = await readFile(sourceProject, 'utf8');
  const imported = await importCutScript(projectDir, {path: sourceProject, name: 'Migrated edit', settings: {fps: 20}});
  assert.equal(imported.name, 'Migrated edit');
  assert.equal(imported.revision, 0);
  assert.equal(imported.assets[0].path, await realpath(media));
  assert.equal(imported.assets[0].fingerprint, fingerprint);
  assert.deepEqual(imported.clips.map((clip) => [clip.sourceStart, clip.sourceEnd]), [[0.2, 1], [2.25, 3.8]]);
  assert.deepEqual(imported.transcripts[0].words.map((word) => [word.id, word.text, word.start, word.end]),
    [['w0', 'Hello', 0.5, 0.8], ['w1', 'world', 2.5, 2.9]]);
  const compiled = compileTimeline(imported);
  assert.equal(compiled.durationInFrames, 47);
  assert.equal(compiled.captions.find((word) => word.text === 'world').start, 1.05);
  assert.equal(await readFile(sourceProject, 'utf8'), originalProject);
  assert.equal(await fileFingerprint(media), fingerprint);
  assert.deepEqual(await loadProject(projectDir), imported);
});

test('no-cut import retains source lead-in, gaps and trailing silence rather than only transcript words', async (t) => {
  const {sourceProject, projectDir} = await fixture(t);
  const imported = await importCutScript(projectDir, {path: sourceProject});
  assert.equal(imported.name, 'Edit');
  assert.deepEqual(imported.clips.map((clip) => [clip.sourceStart, clip.sourceEnd]), [[0, 4]]);
  assert.equal(compileTimeline(imported).durationInFrames, 120);
});

test('an all-deleted CutScript project imports an empty edit without changing its transcript', async (t) => {
  const {sourceProject, projectDir} = await fixture(t, {deletedRanges: [{start: 0, end: 4, wordIndices: [0, 1]}]});
  const imported = await importCutScript(projectDir, {path: sourceProject});
  assert.deepEqual(imported.clips, []);
  assert.equal(imported.transcripts[0].words.length, 2);
  assert.deepEqual(compileTimeline(imported).captions, []);
});

test('import refuses existing destinations and invalid legacy timings without partial projects', async (t) => {
  const {sourceProject, projectDir} = await fixture(t);
  await importCutScript(projectDir, {path: sourceProject});
  const before = await readFile(path.join(projectDir, 'project.json'), 'utf8');
  await assert.rejects(importCutScript(projectDir, {path: sourceProject}), {code: 'PROJECT_EXISTS'});
  assert.equal(await readFile(path.join(projectDir, 'project.json'), 'utf8'), before);
  const invalidDir = `${projectDir}-invalid`;
  await writeFile(sourceProject, JSON.stringify({version: 1, videoPath: './original.wav', words: [], deletedRanges: [{start: '1', end: 2}]}));
  await assert.rejects(importCutScript(invalidDir, {path: sourceProject}), {code: 'INVALID_LEGACY_PROJECT'});
  await assert.rejects(access(path.join(invalidDir, 'project.json')), {code: 'ENOENT'});
  await assert.rejects(importCutScript(invalidDir, {path: './something.json'}), {code: 'INVALID_LEGACY_PROJECT'});
});
