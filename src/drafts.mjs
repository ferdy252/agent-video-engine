import {randomUUID} from 'node:crypto';
import {link, mkdir, open, readdir, readFile, unlink} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {commitProjectSnapshot, loadProject, prepareOperations} from './project.mjs';
import {compileTimeline} from './timeline.mjs';

const draftIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fail(message, code = 'VALIDATION_ERROR') {
  throw Object.assign(new Error(message), {code});
}

function draftDirectory(projectDir) {
  return join(resolve(projectDir), '.engine', 'drafts');
}

function draftPath(projectDir, draftId) {
  if (typeof draftId !== 'string' || !draftIdPattern.test(draftId)) {
    fail('Invalid draft ID. Use an ID returned by draft_stage or draft_list.', 'INVALID_DRAFT_ID');
  }
  return join(draftDirectory(projectDir), `${draftId}.json`);
}

function checkExpectedRevision(expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    fail('expectedRevision must be a nonnegative integer.');
  }
}

function fieldsChanged(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => !isDeepStrictEqual(before[key], after[key]));
}

function compareItems(before, after, identify, summarize = (item) => item) {
  const earlier = new Map(before.map((item) => [identify(item), item]));
  const later = new Map(after.map((item) => [identify(item), item]));
  const added = after.filter((item) => !earlier.has(identify(item))).map(summarize);
  const removed = before.filter((item) => !later.has(identify(item))).map(summarize);
  const changed = [];
  for (const [id, current] of later) {
    const previous = earlier.get(id);
    if (previous && !isDeepStrictEqual(previous, current)) {
      changed.push({id, fields: fieldsChanged(previous, current), before: summarize(previous), after: summarize(current)});
    }
  }
  const beforeOrder = [...earlier.keys()].filter((id) => later.has(id));
  const afterOrder = [...later.keys()].filter((id) => earlier.has(id));
  const orderChanged = !isDeepStrictEqual(beforeOrder, afterOrder);
  return {added, removed, changed, orderChanged, ...(orderChanged ? {beforeOrder, afterOrder} : {})};
}

function timelineSummary(project) {
  const timeline = compileTimeline(project);
  return {
    revision: project.revision,
    width: timeline.width,
    height: timeline.height,
    fps: timeline.fps,
    durationInFrames: timeline.durationInFrames,
    durationSeconds: timeline.durationInFrames / timeline.fps,
    clipCount: project.clips.length,
    overlayCount: project.overlays.length,
  };
}

/** Compare saved or staged manifests, excluding revision metadata from the change list. */
export function compareProjectSnapshots(before, after) {
  if (before.id !== after.id) fail('Compare two snapshots from the same project.');
  const id = (item) => item.id;
  const transcriptSummary = ({assetId, language, words}) => ({assetId, language, wordCount: words.length});
  const collections = {
    clips: compareItems(before.clips, after.clips, id),
    overlays: compareItems(before.overlays, after.overlays, id),
    assets: compareItems(before.assets, after.assets, id),
    transcripts: compareItems(before.transcripts, after.transcripts, (item) => item.assetId, transcriptSummary),
  };
  const settings = {};
  for (const key of ['name', 'settings', 'captions', 'audio', 'custom']) {
    if (!isDeepStrictEqual(before[key], after[key])) settings[key] = {before: before[key] ?? null, after: after[key] ?? null};
  }
  const beforeTimeline = timelineSummary(before);
  const afterTimeline = timelineSummary(after);
  const changedCollections = Object.entries(collections).filter(([, collection]) =>
    collection.added.length || collection.removed.length || collection.changed.length || collection.orderChanged);
  return {
    before: beforeTimeline,
    after: afterTimeline,
    timingScope: 'engine_timeline',
    durationChangeSeconds: afterTimeline.durationSeconds - beforeTimeline.durationSeconds,
    changedSections: [...changedCollections.map(([key]) => key), ...Object.keys(settings)],
    ...collections,
    settings,
  };
}

function summarizeDraft(draft) {
  const {id, name, projectId, baseRevision, createdAt, operations} = draft;
  return {id, name, projectId, baseRevision, createdAt, operationCount: operations.length};
}

function summarizeAgainst(draft, current) {
  const canApply = draft.projectId === current.id && draft.baseRevision === current.revision;
  return {...summarizeDraft(draft), currentRevision: current.revision, canApply, stale: !canApply};
}

async function saveDraft(projectDir, draft) {
  const directory = draftDirectory(projectDir);
  await mkdir(directory, {recursive: true});
  const file = draftPath(projectDir, draft.id);
  const temporary = join(directory, `.${draft.id}.tmp`);
  let handle;
  let created = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    created = true;
    await handle.writeFile(`${JSON.stringify(draft, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, file);
  } finally {
    await handle?.close().catch(() => {});
    if (created) await unlink(temporary).catch((error) => {if (error.code !== 'ENOENT') throw error;});
  }
}

/** Save a validated proposal and its original base in local draft storage. */
export async function stageDraft(projectDir, {expectedRevision, operations, name = 'Draft edit'} = {}) {
  checkExpectedRevision(expectedRevision);
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) {
    fail('Draft name must contain 1 to 120 characters.');
  }
  if (!Array.isArray(operations) || !operations.length || operations.length > 1000) {
    fail('Drafts require a batch of 1 to 1000 edit operations.');
  }
  const batch = structuredClone(operations);
  const base = await loadProject(projectDir);
  if (base.revision !== expectedRevision) {
    fail(`Expected revision ${expectedRevision}, current revision is ${base.revision}. Reload before staging a draft.`, 'REVISION_CONFLICT');
  }
  const snapshot = prepareOperations(base, batch);
  const draft = {schemaVersion: 1, id: randomUUID(), name: name.trim(), projectId: base.id,
    baseRevision: base.revision, createdAt: new Date().toISOString(), operations: batch, base, snapshot};
  const diff = compareProjectSnapshots(base, snapshot);
  await saveDraft(projectDir, draft);
  return {...summarizeDraft(draft), diff};
}

/** Load both frozen manifests for a renderer or an explicit draft comparison. */
export async function getDraft(projectDir, draftId) {
  const file = draftPath(projectDir, draftId);
  let draft;
  try {draft = JSON.parse(await readFile(file, 'utf8'));}
  catch (error) {
    if (error.code === 'ENOENT') fail(`Draft ${draftId} does not exist.`, 'DRAFT_NOT_FOUND');
    if (error instanceof SyntaxError) fail(`Draft ${draftId} is not valid JSON.`, 'INVALID_DRAFT');
    throw error;
  }
  if (!draft || draft.schemaVersion !== 1 || draft.id !== draftId || typeof draft.projectId !== 'string' ||
    typeof draft.name !== 'string' || typeof draft.createdAt !== 'string' || !Number.isFinite(Date.parse(draft.createdAt)) ||
    !Number.isSafeInteger(draft.baseRevision) || draft.baseRevision < 0 || !Array.isArray(draft.operations) ||
    draft.base?.id !== draft.projectId || draft.snapshot?.id !== draft.projectId ||
    draft.base.schemaVersion !== 1 || draft.snapshot.schemaVersion !== 1 ||
    draft.base.revision !== draft.baseRevision || draft.snapshot.revision !== draft.baseRevision) {
    fail(`Draft ${draftId} has an invalid saved snapshot.`, 'INVALID_DRAFT');
  }
  return draft;
}

export async function inspectDraft(projectDir, draftId, {includeTimeline = false} = {}) {
  const [draft, current] = await Promise.all([getDraft(projectDir, draftId), loadProject(projectDir)]);
  return {...summarizeAgainst(draft, current), diff: compareProjectSnapshots(draft.base, draft.snapshot),
    ...(includeTimeline ? {timeline: compileTimeline(draft.snapshot)} : {})};
}

export async function listDrafts(projectDir) {
  const current = await loadProject(projectDir);
  let files;
  try {files = await readdir(draftDirectory(projectDir), {withFileTypes: true});}
  catch (error) {if (error.code === 'ENOENT') return []; throw error;}
  const drafts = [];
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.json')) continue;
    const id = file.name.slice(0, -5);
    if (!draftIdPattern.test(id)) continue;
    try {drafts.push(summarizeAgainst(await getDraft(projectDir, id), current));}
    catch (error) {if (error.code !== 'DRAFT_NOT_FOUND') throw error;}
  }
  return drafts.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

/** Save exactly the staged snapshot using the ordinary project revision lock. */
export async function applyDraft(projectDir, {draftId, expectedRevision} = {}) {
  checkExpectedRevision(expectedRevision);
  const draft = await getDraft(projectDir, draftId);
  if (draft.baseRevision !== expectedRevision) {
    fail(`Draft ${draftId} is based on revision ${draft.baseRevision}. Stage a new draft from the current revision.`, 'REVISION_CONFLICT');
  }
  return commitProjectSnapshot(projectDir, {expectedRevision, snapshot: draft.snapshot});
}

export async function deleteDraft(projectDir, draftId) {
  const file = draftPath(projectDir, draftId);
  try {await unlink(file);}
  catch (error) {if (error.code === 'ENOENT') fail(`Draft ${draftId} does not exist.`, 'DRAFT_NOT_FOUND'); throw error;}
  return {id: draftId, deleted: true};
}
