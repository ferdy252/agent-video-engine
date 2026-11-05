import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fileFingerprint} from '../src/media.mjs';
import {applyOperations, createProject, listRevisions, loadProject, readProjectRevision, restoreRevision} from '../src/project.mjs';
import {createProjectBundle, openProjectBundle, relinkMedia} from '../src/portability.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'engine-portability-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  const sources = join(root, 'originals');
  const projectDir = join(root, 'edit');
  await mkdir(sources);
  const assets = [];
  for (const id of ['one', 'two']) {
    const path = join(sources, `${id}.mp4`);
    await writeFile(path, `synthetic source bytes ${id}`);
    assets.push({id, path, type: 'video', duration: 4, fingerprint: await fileFingerprint(path), hasAudio: true});
  }
  const project = await createProject(projectDir, {
    name: 'Synthetic portable project', assets,
    transcripts: [{assetId: 'one', language: 'en', words: [{id: 'word-1', start: 0.5, end: 1, text: 'Hello'}]}],
    clips: [{id: 'clip', assetId: 'one', sourceStart: 0.25, sourceEnd: 3.5, playbackRate: 1.25, color: {saturation: 0.5}}],
  });
  return {root, sources, projectDir, project};
}

test('relink requires the same source bytes and commits all moved assets together', async (t) => {
  const {root, sources, projectDir, project} = await fixture(t);
  const moved = join(root, 'moved');
  const manifest = join(projectDir, 'project.json');
  const originalManifest = await readFile(manifest);
  await rename(sources, moved);
  await assert.rejects(loadProject(projectDir), {code: 'ASSET_NOT_FOUND'});
  assert.deepEqual(await loadProject(projectDir, {allowMissingAssets: true}), project);
  const replacements = project.assets.map(({id}) => ({assetId: id, path: join(moved, `${id}.mp4`)}));
  await assert.rejects(relinkMedia(projectDir, {expectedRevision: 0, replacements: [replacements[0],
    {...replacements[1], path: replacements[0].path}]}), {code: 'RELINK_FINGERPRINT_MISMATCH'});
  assert.deepEqual(await readFile(manifest), originalManifest);
  await assert.rejects(relinkMedia(projectDir, {expectedRevision: 1, replacements}), {code: 'REVISION_CONFLICT'});
  await assert.rejects(relinkMedia(projectDir, {expectedRevision: 0, replacements: replacements.slice(0, 1)}),
    {code: 'ASSET_NOT_FOUND'});
  assert.deepEqual(await readFile(manifest), originalManifest);
  const result = await relinkMedia(projectDir, {expectedRevision: 0, replacements});
  assert.equal(result.revision, 1);
  assert.deepEqual(result.relinked.map(({assetId, path}) => ({assetId, path})), replacements);
  const repaired = await loadProject(projectDir);
  assert.deepEqual(repaired, {...project, revision: 1, updatedAt: repaired.updatedAt,
    assets: project.assets.map((asset, index) => ({...asset, path: replacements[index].path}))});
  assert.deepEqual(await readProjectRevision(projectDir, 0), {...project, assets: repaired.assets});
  await mkdir(sources);
  await writeFile(project.assets[0].path, 'different bytes at an old path');
  await writeFile(project.assets[1].path, await readFile(repaired.assets[1].path));
  assert.deepEqual((await readProjectRevision(projectDir, 0)).assets, [repaired.assets[0], project.assets[1]]);
  const restored = await restoreRevision(projectDir, {expectedRevision: 1, revision: 0});
  assert.equal(restored.revision, 2);
  assert.deepEqual(restored.assets, [repaired.assets[0], project.assets[1]]);
});

test('a moved bundle restores current editable state without original paths or unrelated runtime files', async (t) => {
  const {root, sources, projectDir} = await fixture(t);
  const project = await applyOperations(projectDir, {expectedRevision: 0, operations: [
    {type: 'set_audio', patch: {enabled: true, targetLufs: -18}},
    {type: 'set_asset_color', assetId: 'two', patch: {brightness: 0.75}},
  ]});
  const bundleDir = join(root, 'bundle');
  const destination = join(root, 'new-edit');
  await mkdir(join(projectDir, '.engine'));
  await writeFile(join(projectDir, '.engine', 'cache.txt'), 'cache');
  const bundled = await createProjectBundle(project, {bundleDir});
  assert.equal(bundled.scope, 'current_revision');
  assert.equal(bundled.revision, 1);
  assert.equal(bundled.fileCount, 2);
  assert.equal(await readFile(join(bundleDir, '.gitignore'), 'utf8'), '*\n');
  assert.deepEqual(await loadProject(projectDir), project);
  const descriptor = await readFile(bundled.manifestPath, 'utf8');
  assert.ok(!descriptor.includes(root));
  await assert.rejects(createProjectBundle(project, {bundleDir}), {code: 'OUTPUT_EXISTS'});
  const movedBundle = join(root, 'transferred');
  await rename(bundleDir, movedBundle);
  await rm(sources, {recursive: true});
  const opened = await openProjectBundle(movedBundle, {projectDir: destination});
  assert.equal(opened.projectDir, destination);
  assert.equal(await readFile(join(destination, '.gitignore'), 'utf8'), '*\n');
  const restored = await loadProject(destination);
  assert.deepEqual(restored, {...project, assets: project.assets.map((asset, index) => ({
    ...asset, path: join(destination, 'bundle-files', 'media', `00000${index + 1}.mp4`),
  }))});
  assert.deepEqual(await Promise.all(restored.assets.map((asset) => fileFingerprint(asset.path))),
    project.assets.map((asset) => asset.fingerprint));
  assert.deepEqual((await listRevisions(destination)).map((item) => item.revision), [1]);
  await assert.rejects(access(join(destination, '.engine', 'cache.txt')), {code: 'ENOENT'});
  await assert.rejects(openProjectBundle(movedBundle, {projectDir: destination}), {code: 'OUTPUT_EXISTS'});
  await applyOperations(destination, {expectedRevision: 1, operations: [
    {type: 'set_clip_color', clipId: 'clip', patch: null},
  ]});
  const reverted = await restoreRevision(destination, {expectedRevision: 2, revision: 1});
  assert.deepEqual(reverted.clips, restored.clips);
});

test('bundle export publishes only after copying and leaves any raced destination intact', async (t) => {
  const {root, project} = await fixture(t);
  const bundleDir = join(root, 'bundle');
  const controller = new AbortController();
  let visibleWhileCopying;
  await assert.rejects(createProjectBundle(project, {bundleDir, signal: controller.signal, onProgress: () => {
    visibleWhileCopying = existsSync(bundleDir);
    controller.abort();
  }}), {name: 'AbortError'});
  assert.equal(visibleWhileCopying, false);
  await assert.rejects(access(bundleDir), {code: 'ENOENT'});
  assert.equal((await readdir(root)).some((name) => name.startsWith('.engine-bundle-')), false);

  const marker = join(bundleDir, 'external-file.txt');
  let claimed = false;
  await assert.rejects(createProjectBundle(project, {bundleDir, onProgress: () => {
    if (claimed) return;
    mkdirSync(bundleDir);
    writeFileSync(marker, 'keep existing files');
    claimed = true;
  }}), {code: 'OUTPUT_EXISTS'});
  assert.equal(await readFile(marker, 'utf8'), 'keep existing files');
  await assert.rejects(access(join(bundleDir, 'bundle.json')), {code: 'ENOENT'});
  assert.equal((await readdir(root)).some((name) => name.startsWith('.engine-bundle-')), false);
});

test('opening a bundle refuses changed bytes and escaping files and cleans an aborted copy', async (t) => {
  const {root, project} = await fixture(t);
  const bundleDir = join(root, 'bundle');
  const destination = join(root, 'new-edit');
  const bundled = await createProjectBundle(project, {bundleDir});
  const source = join(bundleDir, 'media', '000002.mp4');
  const bytes = await readFile(source);
  await writeFile(source, 'wrong bytes');
  await assert.rejects(openProjectBundle(bundleDir, {projectDir: destination}), {code: 'SOURCE_CHANGED'});
  await assert.rejects(access(destination), {code: 'ENOENT'});
  await rm(source);
  await symlink(project.assets[1].path, source);
  await assert.rejects(openProjectBundle(bundleDir, {projectDir: destination}), {code: 'INVALID_PROJECT_BUNDLE'});
  await rm(source);
  await writeFile(source, bytes);
  const controller = new AbortController();
  await assert.rejects(openProjectBundle(bundleDir, {projectDir: destination, signal: controller.signal,
    onProgress: () => controller.abort()}), {name: 'AbortError'});
  await assert.rejects(access(destination), {code: 'ENOENT'});
  assert.equal((await readdir(root)).some((name) => name.startsWith('.engine-import-')), false);
  const descriptor = JSON.parse(await readFile(bundled.manifestPath, 'utf8'));
  descriptor.files[1].path = 'media/../../originals/two.mp4';
  await writeFile(bundled.manifestPath, JSON.stringify(descriptor));
  await assert.rejects(openProjectBundle(bundleDir, {projectDir: destination}), {code: 'INVALID_PROJECT_BUNDLE'});
  assert.deepEqual(await readFile(project.assets[1].path), bytes);
});

test('custom bundle includes local modules and declared public assets and rebases known property paths', async (t) => {
  const {root, projectDir, project} = await fixture(t);
  const customDir = join(root, 'motion');
  const publicDir = join(customDir, 'public');
  const entryPoint = join(customDir, 'layer.tsx');
  const originalSvg = join(publicDir, 'nested', 'sample.svg');
  await mkdir(join(publicDir, 'nested'), {recursive: true});
  await writeFile(originalSvg, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(customDir, 'palette.ts'), "export const color = '#ff0000';");
  await writeFile(join(customDir, 'layer.css'), '.fixture-layer { opacity: 0.9; }');
  await writeFile(entryPoint, `import {Img, staticFile} from 'remotion';
import {color} from './palette';
import './layer.css';
export default () => <div className="fixture-layer" style={{color}}><Img src={staticFile('nested/sample.svg')}/></div>;`);
  const external = join(root, 'not-included.png');
  const edited = await applyOperations(projectDir, {expectedRevision: 0, operations: [
    {type: 'set_custom', custom: {mode: 'layer', entryPoint, publicDir, props: {
      media: [project.assets[0].path, pathToFileURL(originalSvg).href], directory: publicDir, external,
    }}},
  ]});
  const bundleDir = join(root, 'bundle');
  const created = await createProjectBundle(edited, {bundleDir});
  assert.equal(created.customBundled, true);
  assert.deepEqual(created.requiredImports, ['react/jsx-runtime', 'remotion']);
  assert.deepEqual(created.unresolvedCustomPropPaths, [['external']]);
  assert.match(await readFile(join(bundleDir, 'custom', 'entry.mjs'), 'utf8'), /#ff0000/);
  assert.match(await readFile(join(bundleDir, 'custom', 'entry.css'), 'utf8'), /\.fixture-layer/);
  const svgBytes = await readFile(originalSvg);
  await rm(customDir, {recursive: true});
  const destination = join(root, 'new-edit');
  await openProjectBundle(bundleDir, {projectDir: destination});
  const restored = await loadProject(destination);
  assert.equal(restored.custom.entryPoint, join(destination, 'bundle-files', 'custom', 'entry.mjs'));
  assert.equal(restored.custom.mode, 'layer');
  assert.deepEqual(restored.custom.props, {
    media: [restored.assets[0].path, pathToFileURL(join(restored.custom.publicDir, 'nested', 'sample.svg')).href],
    directory: restored.custom.publicDir, external,
  });
  assert.deepEqual(await readFile(join(restored.custom.publicDir, 'nested', 'sample.svg')), svgBytes);
});
