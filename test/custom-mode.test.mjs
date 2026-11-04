import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {applyOperations, createProject, validateProject} from '../src/project.mjs';
import {analyzeCutBoundaries} from '../src/cut-review.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'engine-custom-mode-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const entryPoint = join(directory, 'motion.tsx');
  await writeFile(entryPoint, 'export default function Motion() { return null; }\n');
  const publicDir = join(directory, 'public');
  await mkdir(publicDir);
  const projectDir = join(directory, 'project');
  const project = await createProject(projectDir, {name: 'Shared timeline validation'});
  return {project, projectDir, entryPoint, publicDir};
}

test('custom layers use the engine composition and remain eligible for timeline review', async t => {
  const {projectDir, entryPoint, publicDir} = await fixture(t);
  const project = await applyOperations(projectDir, {expectedRevision: 0, operations: [{type: 'set_custom',
    custom: {mode: 'layer', entryPoint, exportName: 'default', publicDir, props: {color: 'green'}}}]});
  assert.equal(project.revision, 1);
  assert.equal(project.custom.compositionId, undefined);
  assert.equal(validateProject(project), true);
  assert.equal(analyzeCutBoundaries(project).totalCuts, 0);
});

test('invalid custom modes, conflicting clocks and inaccessible public directories do not change the saved edit', async t => {
  const {projectDir, entryPoint, publicDir} = await fixture(t);
  const before = await readFile(join(projectDir, 'project.json'), 'utf8');
  const invalidCustom = [
    {mode: 'unknown', entryPoint, compositionId: 'Root'},
    {mode: 'composition', entryPoint},
    {entryPoint},
    {mode: 'layer', entryPoint, compositionId: 'IndependentRoot'},
    {mode: 'layer', entryPoint, exportName: ''},
    {mode: 'composition', entryPoint, compositionId: 'Root', exportName: 'Motion'},
    {mode: 'layer', entryPoint, publicDir: 'relative/public'},
    {mode: 'layer', entryPoint, publicDir: entryPoint},
    {mode: 'layer', entryPoint, publicDir: join(publicDir, 'missing')},
  ];
  for (const custom of invalidCustom) {
    await assert.rejects(applyOperations(projectDir, {expectedRevision: 0,
      operations: [{type: 'set_custom', custom}]}), {code: 'VALIDATION_ERROR'});
    assert.equal(await readFile(join(projectDir, 'project.json'), 'utf8'), before);
  }
});

test('legacy independent compositions preserve their mode and are never treated as engine-timed layers', async t => {
  const {projectDir, entryPoint} = await fixture(t);
  const project = await applyOperations(projectDir, {expectedRevision: 0,
    operations: [{type: 'set_custom', custom: {entryPoint, compositionId: 'LegacyRoot'}}]});
  assert.equal(project.custom.mode, undefined);
  assert.equal(validateProject(project), true);
  assert.throws(() => analyzeCutBoundaries(project), {code: 'UNSUPPORTED_CUSTOM_REVIEW'});
});
