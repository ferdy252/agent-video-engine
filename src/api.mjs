import {z} from 'zod';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createProject, loadProject, applyOperations, restoreRevision, listRevisions, validateProject} from './project.mjs';
import {compileTimeline} from './timeline.mjs';
import {probeAsset, doctor, assertAssets} from './media.mjs';
import {normalizeTranscript} from './transcribe.mjs';
import {startJob, getJob, cancelJob, retryJob, listJobs} from './jobs.mjs';
import {importLegacyProject} from './import-legacy.mjs';

const projectDir = z.string().min(1).describe('Absolute path of the local video project directory');
const expectedRevision = z.number().int().nonnegative().describe('Revision returned by project_inspect. Prevents overwriting newer edits.');
const ro = {readOnlyHint: true, destructiveHint: false, openWorldHint: false};
const edit = {readOnlyHint: false, destructiveHint: false, openWorldHint: false};
const clipSchema = z.object({id: z.string(), assetId: z.string(), sourceStart: z.number().nonnegative(), sourceEnd: z.number().positive(),
  playbackRate: z.number().min(0.01).max(16).optional(), volume: z.number().min(0).max(8).optional(), fit: z.enum(['cover', 'contain']).optional(),
  position: z.object({x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive()}).optional()}).strict();
const captionPatch = z.object({enabled: z.boolean().optional(), fontSize: z.number().positive().optional(), color: z.string().optional(),
  highlightColor: z.string().optional(), bottom: z.number().nonnegative().optional(), wordsPerPage: z.number().int().min(1).max(50).optional()}).strict();
const overlaySchema = z.object({id: z.string(), type: z.enum(['text', 'image', 'video', 'audio']), text: z.string().optional(),
  assetId: z.string().optional(), start: z.number().nonnegative(), end: z.number().positive(), sourceStart: z.number().nonnegative().optional(),
  volume: z.number().min(0).max(8).optional(), style: z.record(z.unknown()).optional(),
  anchor: z.object({assetId: z.string(), wordId: z.string(), offset: z.number().optional(), clipId: z.string().optional()}).strict().optional()}).strict();
const customSchema = z.union([
  z.object({mode: z.literal('layer'), entryPoint: z.string(), exportName: z.string().optional(), publicDir: z.string().optional(),
    props: z.record(z.unknown()).optional()}).strict(),
  z.object({mode: z.literal('composition').optional(), entryPoint: z.string(), compositionId: z.string(), publicDir: z.string().optional(),
    props: z.record(z.unknown()).optional()}).strict(),
]);
const operationSchema = z.discriminatedUnion('type', [
  z.object({type: z.literal('set_clips'), clips: z.array(clipSchema)}).strict(),
  z.object({type: z.literal('split_clip'), clipId: z.string(), sourceTime: z.number().nonnegative(), newClipId: z.string().optional()}).strict(),
  z.object({type: z.literal('remove_clip'), clipId: z.string()}).strict(),
  z.object({type: z.literal('trim_clip'), clipId: z.string(), sourceStart: z.number().nonnegative(), sourceEnd: z.number().positive()}).strict(),
  z.object({type: z.literal('reorder_clips'), clipIds: z.array(z.string())}).strict(),
  z.object({type: z.literal('delete_source_range'), assetId: z.string(), start: z.number().nonnegative(), end: z.number().positive()}).strict(),
  z.object({type: z.literal('delete_words'), assetId: z.string(), wordIds: z.array(z.string()).min(1)}).strict(),
  z.object({type: z.literal('upsert_overlay'), overlay: overlaySchema}).strict(),
  z.object({type: z.literal('remove_overlay'), overlayId: z.string()}).strict(),
  z.object({type: z.literal('set_captions'), patch: captionPatch}).strict(),
  z.object({type: z.literal('set_settings'), patch: z.object({width: z.number().int().min(2).max(16384).optional(), height: z.number().int().min(2).max(16384).optional(),
    fps: z.number().int().min(1).max(120).optional(), background: z.string().optional()}).strict()}).strict(),
  z.object({type: z.literal('set_custom'), custom: customSchema.nullable()}).strict(),
]);
async function inspect({projectDir: dir, includeTimeline = false}) {
  const project = await loadProject(dir);
  const timeline = compileTimeline(project);
  return {...project, transcripts: project.transcripts.map(({words, ...rest}) => ({...rest, wordCount: words.length})),
    durationInFrames: timeline.durationInFrames, duration: timeline.durationInFrames / timeline.fps,
    ...(includeTimeline ? {timeline} : {})};
}
async function renderJob(args, sourcePreview = false) {
  const project = await loadProject(args.projectDir);
  if (project.revision !== args.expectedRevision) throw Object.assign(new Error('Project revision changed'), {code: 'STALE_REVISION'});
  await assertAssets(project);
  const kind = args.kind || 'video';
  const outputPath = args.outputPath ? resolve(args.projectDir, args.outputPath) : join(resolve(args.projectDir), 'exports',
    `r${project.revision}-${sourcePreview ? 'source' : kind}-${Date.now()}-${randomUUID().slice(0, 8)}.${kind === 'still' ? 'png' : 'mp4'}`);
  return startJob(args.projectDir, {...args, outputPath, type: 'render', ...(sourcePreview ? {sourcePreview: true} : {})});
}
export const toolDefinitions = [
  {name: 'engine_status', description: 'Check local video engine dependencies and cached transcription model. No uploads or downloads.', schema: {}, annotations: ro, run: doctor},
  {name: 'project_import_legacy', description: 'Import an existing local legacy .aive project into a new headless project, preserving its source transcript and explicit cuts. Does not change the source project or footage.',
    schema: {projectDir, path: z.string().min(1), name: z.string().optional()}, annotations: edit,
    run: ({projectDir: dir, ...options}) => importLegacyProject(dir, options)},
  {name: 'project_create', description: 'Create a new local headless video project. Existing directories and media are preserved.',
    schema: {projectDir, name: z.string().min(1), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), fps: z.number().int().min(1).max(120).optional()}, annotations: edit,
    run: ({projectDir: dir, name, ...settings}) => createProject(dir, {name, settings})},
  {name: 'project_inspect', description: 'Read project state and revision. Include the compiled timeline to inspect edited timing and retimed captions.',
    schema: {projectDir, includeTimeline: z.boolean().optional()}, annotations: ro, run: inspect},
  {name: 'project_validate', description: 'Validate timeline and confirm originals still match imported fingerprints. Does not judge creative quality.',
    schema: {projectDir}, annotations: ro, run: async ({projectDir: dir}) => {const project = await loadProject(dir); validateProject(project); await assertAssets(project); const timeline = compileTimeline(project); return {valid: true, revision: project.revision, durationInFrames: timeline.durationInFrames, assetCount: project.assets.length};}},
  {name: 'media_add', description: 'Probe and reference a local original image, video or audio file without copying it. Optionally append video/audio to the main timeline.',
    schema: {projectDir, expectedRevision, path: z.string().min(1), addToTimeline: z.boolean().optional()}, annotations: edit,
    run: async ({projectDir: dir, expectedRevision: revision, path, addToTimeline = false}) => {
      const project = await loadProject(dir), asset = await probeAsset(path);
      const operations = [{type: 'add_asset', asset}];
      if (addToTimeline) {
        if (asset.type === 'image') throw new Error('Add an image with an explicit clip duration through edit_apply');
        operations.push({type: 'set_clips', clips: [...project.clips, {id: randomUUID(), assetId: asset.id, sourceStart: 0,
          sourceEnd: asset.duration, playbackRate: 1, volume: 1, fit: 'contain'}]});
      }
      const updated = await applyOperations(dir, {expectedRevision: revision, operations});
      return {asset, revision: updated.revision};
    }},
  {name: 'media_index', description: 'Map one original recording, including multiple attempts recorded in the same file. Creates timestamped thumbnails/contact sheets for video, links existing source transcript words, and groups repeated passages as POSSIBLE retakes. Never chooses the best take, splits the source, changes the edit or deletes footage. Returns a durable job ID; read job_get for the index ID. Does not transcribe automatically: use transcribe or transcript_import first for spoken take grouping. Missing transcripts allow video picture maps without spoken grouping. Reuses a cached map when source, transcript and options match.',
    schema: {projectDir, expectedRevision, assetId: z.string(), intervalSeconds: z.number().min(1).max(120).default(15),
      maxThumbnails: z.number().int().min(6).max(240).default(120)}, annotations: edit,
    run: async args => {
      const project = await loadProject(args.projectDir);
      if (project.revision !== args.expectedRevision) throw Object.assign(new Error('Project revision changed. Inspect it before indexing.'), {code: 'STALE_REVISION'});
      const asset = project.assets.find(item => item.id === args.assetId);
      if (!asset) throw Object.assign(new Error('Unknown source asset.'), {code: 'ASSET_NOT_FOUND'});
      if (!['video', 'audio'].includes(asset.type)) throw Object.assign(new Error('Index a video or audio recording. Still images do not contain takes.'), {code: 'UNSUPPORTED_INDEX_ASSET'});
      return startJob(args.projectDir, {...args, type: 'media_index'});
    }},
  {name: 'media_index_get', description: 'Read a saved original-recording map in bounded pages. Returns possible attempts, retake groups, source timestamps and preview hints; optionally returns one timestamped contact sheet as an image. Use the indexId returned by media_index. Normal timeline edits can reuse the map; changed source media or transcript requires reindexing. A possible retake is a repeated phrase, not a quality verdict.',
    schema: {projectDir, indexId: z.string(), offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(50).default(20), sheetPage: z.number().int().nonnegative().default(0),
      includePreview: z.boolean().default(true)}, annotations: ro,
    run: async args => {const project = await loadProject(args.projectDir); const {readMediaIndex} = await import('./footage-index.mjs'); return readMediaIndex(project, args);}},
  {name: 'media_search', description: 'Search words spoken in an indexed source recording and find source-time ranges plus possible alternative attempts. This is lexical transcript search, not semantic image search or automatic best-take selection. Use returned preview hints with source_preview to compare actual delivery before editing.',
    schema: {projectDir, indexId: z.string(), query: z.string().trim().min(1), offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(50).default(20)}, annotations: ro,
    run: async args => {const project = await loadProject(args.projectDir); const {searchMediaIndex} = await import('./footage-index.mjs'); return searchMediaIndex(project, args);}},
  {name: 'edit_apply', description: 'Apply an atomic batch of source-linked edits. Operations: set_clips, split_clip, remove_clip, trim_clip, reorder_clips, delete_source_range, delete_words, upsert_overlay, remove_overlay, set_captions, set_settings, set_custom. Invalid batches make no change. Originals are never changed.',
    schema: {projectDir, expectedRevision, operations: z.array(operationSchema).min(1).max(1000)}, annotations: edit,
    run: async ({projectDir: dir, ...request}) => {const project = await applyOperations(dir, request); return {revision: project.revision, clips: project.clips, durationInFrames: compileTimeline(project).durationInFrames};}},
  {name: 'revision_list', description: 'List saved edit revisions.', schema: {projectDir}, annotations: ro, run: ({projectDir: dir}) => listRevisions(dir)},
  {name: 'revision_restore', description: 'Restore a saved revision as a new revision. Keeps history and original footage.',
    schema: {projectDir, expectedRevision, revision: z.number().int().nonnegative()}, annotations: edit,
    run: ({projectDir: dir, ...request}) => restoreRevision(dir, request)},
  {name: 'transcript_import', description: 'Import source-timed transcript words from local JSON, including a word array or native speech-recognition output. Reuses existing transcripts without retranscription.',
    schema: {projectDir, expectedRevision, assetId: z.string(), path: z.string().min(1)}, annotations: edit,
    run: async ({projectDir: dir, expectedRevision: revision, assetId, path}) => {
      const transcript = normalizeTranscript(JSON.parse(await readFile(resolve(path), 'utf8')), assetId);
      const project = await applyOperations(dir, {expectedRevision: revision, operations: [{type: 'set_transcript', transcript}]});
      return {revision: project.revision, wordCount: transcript.words.length};
    }},
  {name: 'transcript_search', description: 'Read or search source transcript words with stable word IDs and source times. Use empty query for paginated reading; review footage before judging retakes.',
    schema: {projectDir, assetId: z.string(), query: z.string().optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(300).optional()}, annotations: ro,
    run: async ({projectDir: dir, assetId, query = '', offset = 0, limit = 100}) => {
      const project = await loadProject(dir), transcript = project.transcripts.find(item => item.assetId === assetId);
      if (!transcript) throw new Error('No transcript for this asset');
      const q = query.toLocaleLowerCase(), words = transcript.words;
      const phraseLength = Math.max(1, q.split(/\s+/).length);
      const hits = q ? words.flatMap((word, index) => words.slice(index, index + phraseLength).map(item => item.text).join(' ').toLocaleLowerCase().includes(q)
        ? [{...word, context: words.slice(Math.max(0, index - 4), index + phraseLength + 4)}] : []) : words;
      return {revision: project.revision, assetId, language: transcript.language, total: hits.length, offset, words: hits.slice(offset, offset + limit)};
    }},
  {name: 'transcribe', description: 'Start cached, local word transcription with whisper.cpp. Returns a durable job ID. Never uploads footage or downloads models. Applies results only if the project revision is unchanged.',
    schema: {projectDir, expectedRevision, assetId: z.string(), modelPath: z.string().optional(), language: z.string().default('en')}, annotations: edit,
    run: args => startJob(args.projectDir, {...args, type: 'transcribe'})},
  {name: 'preview_render', description: 'Render a still frame or short moving preview of the current edit. Returns a durable job ID. Use job_get to inspect the resulting image or video path.',
    schema: {projectDir, expectedRevision, kind: z.enum(['still', 'preview']).default('still'), frame: z.number().int().nonnegative().optional(), fromFrame: z.number().int().nonnegative().optional(), toFrame: z.number().int().nonnegative().optional(), scale: z.number().min(0.1).max(1).default(0.5)}, annotations: edit,
    run: args => renderJob(args)},
  {name: 'source_preview', description: 'Inspect an original source asset before making editorial decisions. Renders a still or short source clip without changing the saved edit.',
    schema: {projectDir, expectedRevision, assetId: z.string(), kind: z.enum(['still', 'preview']).default('still'), sourceStart: z.number().nonnegative().default(0), sourceEnd: z.number().positive().optional(), scale: z.number().min(0.1).max(1).default(0.5)}, annotations: edit,
    run: args => renderJob(args, true)},
  {name: 'export_render', description: 'Render one final MP4 from the saved project, including captions, overlays and audio. Always creates a new output and preserves originals and accepted exports.',
    schema: {projectDir, expectedRevision, outputPath: z.string().optional(), concurrency: z.number().int().min(1).max(8).optional()}, annotations: edit,
    run: args => renderJob({...args, kind: 'video', scale: 1})},
  {name: 'review_cuts', description: 'Review source-linked timeline joins without changing the edit. Supports the built-in timeline and custom layer mode, where the engine owns timing and main clips. Flags transcript words cut at a boundary, measured audio level jumps and long silence near a join. Creates short mixed-master preview clips and a local report. Returns a durable job ID; read job_get for results. Measurements are review cues, not a verdict on naturalness. Use offset/limit to review long edits in batches. Independent standalone compositions require adaptation to layer mode.',
    schema: {projectDir, expectedRevision, contextSeconds: z.number().min(0.25).max(3).default(1),
      offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20),
      renderPreviews: z.boolean().default(true).describe('When false, perform transcript timing review only; audio is explicitly skipped.')}, annotations: edit,
    run: async args => {
      const project = await loadProject(args.projectDir);
      if (project.revision !== args.expectedRevision) throw Object.assign(new Error('Project revision changed. Inspect it before reviewing.'), {code: 'STALE_REVISION'});
      if (project.custom && project.custom.mode !== 'layer') throw Object.assign(new Error('This standalone composition owns its timing. Adapt its motion component to custom.mode="layer" so the engine renders the shared main timeline, or review its output directly.'), {code: 'UNSUPPORTED_CUSTOM_REVIEW'});
      return startJob(args.projectDir, {...args, type: 'review_cuts'});
    }},
  {name: 'job_list', description: 'List saved local render, transcription, cut-review and recording-index jobs.', schema: {projectDir}, annotations: ro, run: ({projectDir: dir}) => listJobs(dir)},
  {name: 'job_get', description: 'Read job progress, result paths or actionable errors. Completed still previews can be returned as images.',
    schema: {projectDir, jobId: z.string(), includePreview: z.boolean().optional()}, annotations: ro, run: ({projectDir: dir, jobId}) => getJob(dir, jobId)},
  {name: 'job_cancel', description: 'Request cancellation of a queued or running job and its underlying renderer/transcriber.', schema: {projectDir, jobId: z.string()}, annotations: edit, run: ({projectDir: dir, jobId}) => cancelJob(dir, jobId)},
  {name: 'job_retry', description: 'Restart a failed or interrupted job only if its original project revision is still current.', schema: {projectDir, jobId: z.string()}, annotations: edit, run: ({projectDir: dir, jobId}) => retryJob(dir, jobId)},
];

export async function callTool(name, args = {}) {
  const definition = toolDefinitions.find(tool => tool.name === name);
  if (!definition) throw new Error(`Unknown tool: ${name}`);
  return definition.run(z.object(definition.schema).strict().parse(args));
}
