import {z} from 'zod';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, join, isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createProject, loadProject, applyOperations, restoreRevision, listRevisions, validateProject, readProjectRevision} from './project.mjs';
import {stageDraft, inspectDraft, listDrafts, applyDraft, deleteDraft, compareProjectSnapshots} from './drafts.mjs';
import {GRAPHIC_PRESETS, MOTION_LIMITS} from './edit-controls.mjs';
import {compileTimeline} from './timeline.mjs';
import {probeAsset, doctor, assertAssets} from './media.mjs';
import {normalizeTranscript} from './transcribe.mjs';
import {startJob, startBundleOpen, getJob, cancelJob, retryJob, listJobs} from './jobs.mjs';
import {importLegacyProject} from './import-legacy.mjs';
import {AUDIO_LIMITS, resolveAudioSettings} from './audio-settings.mjs';
import {COLOR_LIMITS} from './color-settings.mjs';
import {verifyExportQuality} from './export-quality.mjs';

const projectDir = z.string().min(1).describe('Absolute path of the local video project directory');
const expectedRevision = z.number().int().nonnegative().describe('Revision returned by project_inspect. Prevents overwriting newer edits.');
const ro = {readOnlyHint: true, destructiveHint: false, openWorldHint: false};
const edit = {readOnlyHint: false, destructiveHint: false, openWorldHint: false};
const audioNumber = (key) => z.number().min(AUDIO_LIMITS[key][0]).max(AUDIO_LIMITS[key][1]).optional();
const audioPatch = z.object({
  enabled: z.boolean().optional().describe('Enable automatic main-track leveling and complete-mix loudness finishing. Off by default.'),
  targetLufs: audioNumber('targetLufs'), truePeakDb: audioNumber('truePeakDb'),
  strength: audioNumber('strength').describe('Automatic take-level matching strength, from 0 to 1. Constant gains preserve delivery within a source span.'),
  maxGainDb: audioNumber('maxGainDb'),
  voiceGainDb: audioNumber('voiceGainDb').describe('Main-track voice balance relative to music and effects. For overall loudness, change outputGainDb.'),
  outputGainDb: audioNumber('outputGainDb').describe('Overall adjustment after automatic target gain. Negative values make the result quieter; peak protection still applies.'),
  musicGainDb: z.number().min(-24).max(24).optional(), effectsGainDb: z.number().min(-24).max(24).optional(),
  ducking: z.object({enabled: z.boolean().optional(), amountDb: z.number().min(0).max(24).optional(), attack: z.number().min(.005).max(2).optional(), release: z.number().min(.01).max(5).optional(), thresholdDb: z.number().min(-60).max(0).optional()}).strict().optional(),
  denoise: z.object({enabled: z.boolean().optional(), amount: z.number().min(0).max(1).optional()}).strict().optional(),
}).strict();
const clipAudioPatch = z.object({leveling: z.boolean().optional(), gainDb: z.number().min(-24).max(24).optional(),
  assetId: z.string().optional(), sourceStart: z.number().nonnegative().optional(), sourceEnd: z.number().positive().optional(), offset: z.number().optional(),
  muted: z.boolean().optional(), role: z.enum(['voice', 'music', 'effects']).optional(),
  fadeIn: z.number().min(0).max(3600).optional(), fadeOut: z.number().min(0).max(3600).optional(),
  curveOffset: z.number().optional(), curveDuration: z.number().positive().optional(),
  envelope: z.array(z.object({time: z.number().nonnegative(), value: z.number().min(0).max(8)}).strict()).max(128).optional(),
}).strict();
const motionSchema = z.object(Object.fromEntries(Object.entries(MOTION_LIMITS).map(([key, [min, max]]) => [key,
  z.array(z.object({time: z.number().nonnegative(), value: z.number().min(min).max(max), easing: z.enum(['linear', 'easeInOut', 'hold']).optional()}).strict()).min(1).max(1000).optional()]))).strict();
const cropSchema = z.object({left: z.number().min(0).max(.99).optional(), right: z.number().min(0).max(.99).optional(), top: z.number().min(0).max(.99).optional(), bottom: z.number().min(0).max(.99).optional()}).strict();
const focusSchema = z.object({x: z.number().min(0).max(1), y: z.number().min(0).max(1)}).strict();
const positionSchema = z.object({x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive()}).strict();
const transitionSchema = z.object({type: z.enum(['crossfade', 'dip', 'wipe']), duration: z.number().positive().max(30)}).strict();
const colorNumber = (key) => z.number().min(COLOR_LIMITS[key][0]).max(COLOR_LIMITS[key][1]);
const colorFields = {enabled: z.boolean(), brightness: colorNumber('brightness'), contrast: colorNumber('contrast'),
  saturation: colorNumber('saturation'), temperature: colorNumber('temperature'), tint: colorNumber('tint')};
const colorSettings = z.object(Object.fromEntries(Object.entries(colorFields).map(([key, schema]) => [key, schema.optional()]))).strict();
const colorPatch = z.object(Object.fromEntries(Object.entries(colorFields).map(([key, schema]) => [key, schema.nullable().optional()]))).strict().nullable();
const mediaClipSchema = z.object({id: z.string(), type: z.literal('media').optional(), assetId: z.string(), sourceStart: z.number().nonnegative(), sourceEnd: z.number().positive(),
  playbackRate: z.number().min(0.01).max(16).optional(), volume: z.number().min(0).max(8).optional(), fit: z.enum(['cover', 'contain']).optional(),
  audio: clipAudioPatch.optional(),
  color: colorSettings.optional(),
  position: positionSchema.optional(), crop: cropSchema.optional(), focus: focusSchema.optional(), motion: motionSchema.optional(), motionTimeOffset: z.number().optional(), transition: transitionSchema.optional()}).strict();
const clipSchema = z.union([mediaClipSchema, z.object({id: z.string(), type: z.literal('gap'), duration: z.number().positive()}).strict()]);
const cueSchema = z.object({id: z.string(), text: z.string().min(1), start: z.number().nonnegative(), end: z.number().positive()}).strict();
const captionPatch = z.object({enabled: z.boolean().optional(), fontSize: z.number().positive().optional(), color: z.string().optional(),
  highlightColor: z.string().optional(), bottom: z.number().nonnegative().optional(), wordsPerPage: z.number().int().min(1).max(50).optional(), cues: z.array(cueSchema).max(100000).nullable().optional()}).strict();
const overlaySchema = z.object({id: z.string(), type: z.enum(['text', 'image', 'video', 'audio']), text: z.string().optional(),
  assetId: z.string().optional(), start: z.number().nonnegative(), end: z.number().positive(), sourceStart: z.number().nonnegative().optional(),
  volume: z.number().min(0).max(8).optional(), style: z.record(z.unknown()).optional(),
  audio: clipAudioPatch.optional(), motion: motionSchema.optional(), crop: cropSchema.optional(), focus: focusSchema.optional(), preset: z.enum(['title', 'lower_third', 'callout']).optional(),
  anchor: z.object({assetId: z.string(), wordId: z.string(), offset: z.number().optional(), clipId: z.string().optional()}).strict().optional()}).strict();
const customSchema = z.union([
  z.object({mode: z.literal('layer'), entryPoint: z.string(), exportName: z.string().optional(), publicDir: z.string().optional(),
    props: z.record(z.unknown()).optional()}).strict(),
  z.object({mode: z.literal('composition').optional(), entryPoint: z.string(), compositionId: z.string(), publicDir: z.string().optional(),
    props: z.record(z.unknown()).optional()}).strict(),
]);
const operationSchema = z.discriminatedUnion('type', [
  z.object({type: z.literal('set_clips'), clips: z.array(clipSchema)}).strict(),
  z.object({type: z.literal('insert_clip'), index: z.number().int().nonnegative(), clip: clipSchema}).strict(),
  z.object({type: z.literal('replace_clip'), clipId: z.string(), clip: clipSchema}).strict(),
  z.object({type: z.literal('insert_gap'), index: z.number().int().nonnegative(), id: z.string().optional(), duration: z.number().positive()}).strict(),
  z.object({type: z.literal('set_gap'), clipId: z.string(), duration: z.number().positive()}).strict(),
  z.object({type: z.literal('set_transition'), clipId: z.string(), transition: transitionSchema.nullable()}).strict(),
  z.object({type: z.literal('set_clip_visual'), clipId: z.string(), patch: z.object({fit: z.enum(['cover', 'contain']).nullable().optional(), position: positionSchema.nullable().optional(), crop: cropSchema.nullable().optional(), focus: focusSchema.nullable().optional(), motion: motionSchema.nullable().optional()}).strict()}).strict(),
  z.object({type: z.literal('set_caption_cues'), cues: z.array(cueSchema).max(100000).nullable()}).strict(),
  z.object({type: z.literal('split_clip'), clipId: z.string(), sourceTime: z.number().nonnegative(), newClipId: z.string().optional()}).strict(),
  z.object({type: z.literal('remove_clip'), clipId: z.string()}).strict(),
  z.object({type: z.literal('trim_clip'), clipId: z.string(), sourceStart: z.number().nonnegative(), sourceEnd: z.number().positive()}).strict(),
  z.object({type: z.literal('reorder_clips'), clipIds: z.array(z.string())}).strict(),
  z.object({type: z.literal('delete_source_range'), assetId: z.string(), start: z.number().nonnegative(), end: z.number().positive()}).strict(),
  z.object({type: z.literal('delete_words'), assetId: z.string(), wordIds: z.array(z.string()).min(1)}).strict(),
  z.object({type: z.literal('upsert_overlay'), overlay: overlaySchema}).strict(),
  z.object({type: z.literal('remove_overlay'), overlayId: z.string()}).strict(),
  z.object({type: z.literal('set_captions'), patch: captionPatch}).strict(),
  z.object({type: z.literal('set_audio'), patch: audioPatch}).strict(),
  z.object({type: z.literal('set_clip_audio'), clipId: z.string(), patch: clipAudioPatch.nullable()}).strict(),
  z.object({type: z.literal('set_asset_color'), assetId: z.string(), patch: colorPatch}).strict(),
  z.object({type: z.literal('set_clip_color'), clipId: z.string(), patch: colorPatch}).strict(),
  z.object({type: z.literal('set_settings'), patch: z.object({width: z.number().int().min(2).max(16384).optional(), height: z.number().int().min(2).max(16384).optional(),
    fps: z.number().int().min(1).max(120).optional(), background: z.string().optional()}).strict()}).strict(),
  z.object({type: z.literal('set_custom'), custom: customSchema.nullable()}).strict(),
]);
async function inspect({projectDir: dir, includeTimeline = false}) {
  const project = await loadProject(dir, {allowMissingAssets: true});
  const timeline = compileTimeline(project);
  return {...project, audio: resolveAudioSettings(project.audio), transcripts: project.transcripts.map(({words, ...rest}) => ({...rest, wordCount: words.length})),
    durationInFrames: timeline.durationInFrames, duration: timeline.durationInFrames / timeline.fps,
    ...(includeTimeline ? {timeline} : {})};
}
async function renderJob(args, sourcePreview = false) {
  if (args.fit !== undefined && args.preset === undefined) throw new Error('Choose a delivery preset when specifying its fit.');
  const project = await loadProject(args.projectDir);
  if (project.revision !== args.expectedRevision) throw Object.assign(new Error('Project revision changed'), {code: 'STALE_REVISION'});
  await assertAssets(project);
  const kind = args.kind || 'video';
  const outputPath = args.outputPath ? resolve(args.projectDir, args.outputPath) : join(resolve(args.projectDir), 'exports',
    `r${project.revision}-${sourcePreview ? 'source-preview' : kind === 'video' ? 'final' : kind}-${Date.now()}-${randomUUID().slice(0, 8)}.${kind === 'still' ? 'png' : 'mp4'}`);
  return startJob(args.projectDir, {...args, outputPath, type: 'render', ...(sourcePreview ? {sourcePreview: true} : {})});
}
export const toolDefinitions = [
  {name: 'graphic_presets', description: 'List reusable title, lower-third and callout styles. Add a text overlay with preset and override its style or motion as needed.', schema: {}, annotations: ro, run: () => GRAPHIC_PRESETS},
  {name: 'draft_stage', description: 'Prepare a validated edit without changing the saved project. Render it using preview_render with draftId, then apply the exact reviewed state with draft_apply.',
    schema: {projectDir, expectedRevision, name: z.string().optional(), operations: z.array(operationSchema).min(1).max(1000)}, annotations: edit,
    run: ({projectDir: dir, ...request}) => stageDraft(dir, request)},
  {name: 'draft_inspect', description: 'Inspect proposed changes and whether the base revision is still current. Optional compiled timeline includes draft timing and captions.',
    schema: {projectDir, draftId: z.string(), includeTimeline: z.boolean().optional()}, annotations: ro,
    run: ({projectDir: dir, draftId, ...options}) => inspectDraft(dir, draftId, options)},
  {name: 'draft_list', description: 'List saved edit proposals and mark ones whose base revision changed.', schema: {projectDir}, annotations: ro, run: ({projectDir: dir}) => listDrafts(dir)},
  {name: 'draft_apply', description: 'Commit the exact staged edit as one new revision. Refuses stale drafts so it cannot overwrite newer work.',
    schema: {projectDir, draftId: z.string(), expectedRevision}, annotations: edit, run: ({projectDir: dir, ...request}) => applyDraft(dir, request)},
  {name: 'draft_delete', description: 'Delete one saved proposal. The current edit, revision history and original media remain intact.',
    schema: {projectDir, draftId: z.string()}, annotations: edit, run: ({projectDir: dir, draftId}) => deleteDraft(dir, draftId)},
  {name: 'revision_compare', description: 'Compare two saved revisions, including changes to cuts, graphics, captions, settings and output duration. preview_render can render either revision.',
    schema: {projectDir, fromRevision: z.number().int().nonnegative(), toRevision: z.number().int().nonnegative()}, annotations: ro,
    run: async ({projectDir: dir, fromRevision, toRevision}) => compareProjectSnapshots(await readProjectRevision(dir, fromRevision), await readProjectRevision(dir, toRevision))},
  {name: 'media_relink', description: 'Relink moved source files by exact saved fingerprint. Supply all missing assets in one atomic batch. Never accepts different source bytes as the same original.',
    schema: {projectDir, expectedRevision, replacements: z.array(z.object({assetId: z.string(), path: z.string()}).strict()).min(1)}, annotations: edit,
    run: async ({projectDir: dir, ...request}) => (await import('./portability.mjs')).relinkMedia(dir, request)},
  {name: 'project_bundle', description: 'Package the current editable project and registered media in a new local directory for another machine. Does not include revision history, caches or exports. Returns a job.',
    schema: {projectDir, expectedRevision, bundleDir: z.string()}, annotations: edit,
    run: args => startJob(args.projectDir, {...args, bundleDir: resolve(args.bundleDir), type: 'project_bundle'})},
  {name: 'project_open_bundle', description: 'Queue verification and opening of a portable bundle as a new local editable project with copied media. Existing destination directories are refused. Poll job_get using the returned projectDir and id. destinationProjectDir identifies the new editable project after completion.',
    schema: {projectDir, bundleDir: z.string()}, annotations: edit,
    run: args => startBundleOpen(args)},
  {name: 'export_subtitles', description: 'Export edited caption wording, line breaks and timeline timing as SRT or WebVTT. Works when burned-in captions are disabled. Creates a new file.',
    schema: {projectDir, expectedRevision, outputPath: z.string(), format: z.enum(['srt', 'vtt'])}, annotations: edit,
    run: args => startJob(args.projectDir, {...args, outputPath: resolve(args.projectDir, args.outputPath), type: 'export_subtitles'})},
  {name: 'export_timeline', description: 'Export a source-linked OpenTimelineIO timeline for compatible editors. Includes editable cuts, gaps, overlaps and audio timing. Read returned fidelity limitations for effects and graphics.',
    schema: {projectDir, expectedRevision, outputPath: z.string(), format: z.literal('otio').default('otio')}, annotations: edit,
    run: args => startJob(args.projectDir, {...args, outputPath: resolve(args.projectDir, args.outputPath), type: 'export_timeline'})},
  {name: 'engine_status', description: 'Check local video engine dependencies and cached transcription model. No uploads or downloads.', schema: {}, annotations: ro, run: doctor},
  {name: 'project_import_legacy', description: 'Import an existing local legacy .aive project into a new headless project, preserving its source transcript and explicit cuts. Does not change the source project or footage.',
    schema: {projectDir, path: z.string().min(1), name: z.string().optional()}, annotations: edit,
    run: ({projectDir: dir, ...options}) => importLegacyProject(dir, options)},
  {name: 'project_create', description: 'Create a new local headless video project. Existing directories and media are preserved.',
    schema: {projectDir, name: z.string().min(1), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), fps: z.number().int().min(1).max(120).optional(), audio: audioPatch.optional()}, annotations: edit,
    run: ({projectDir: dir, name, audio, ...settings}) => createProject(dir, {name, settings, audio})},
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
  {name: 'edit_apply', description: 'Apply a complete validated batch as one revision. Timeline controls: set_clips, insert_clip, replace_clip, insert_gap, set_gap, split_clip, remove_clip, trim_clip, reorder_clips, delete_source_range, delete_words. Set an incoming crossfade/dip/wipe with set_transition (overlaps existing retained ranges and shortens output). set_clip_visual controls crop, focus, fit, position and timed motion keyframes. set_clip_audio controls independent source bounds/offset, gain, role, fades and volume envelope; patch:null restores linked sound. set_audio controls voice/music/effects gains, optional music ducking, voice noise reduction and automatic loudness. upsert_overlay adds media or reusable title/lower_third/callout text. set_caption_cues edits wording, line breaks and fixed output timing; cues:null returns to source-timed captions. Also supports remove_overlay, set_captions, set_settings, set_custom, set_asset_color and set_clip_color. Use draft_stage for a proposal preview. Invalid or stale batches leave the project unchanged. Originals are preserved.',
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
  {name: 'preview_render', description: 'Render a still frame or short moving preview of the current edit. Enabled audio finishing uses the full project mix so short previews retain the same settings and master level as the final export. Returns a durable job ID. Use job_get for the result, audio measurements and any peak-limited target warnings.',
    schema: {projectDir, expectedRevision, draftId: z.string().optional(), revision: z.number().int().nonnegative().optional(), preset: z.enum(['vertical', 'horizontal', 'square']).optional(), fit: z.enum(['contain', 'cover']).optional(), kind: z.enum(['still', 'preview']).default('still'), frame: z.number().int().nonnegative().optional(), fromFrame: z.number().int().nonnegative().optional(), toFrame: z.number().int().nonnegative().optional(), scale: z.number().min(0.1).max(1).default(0.5)}, annotations: edit,
    run: args => renderJob(args)},
  {name: 'color_preview', description: 'Compare saved color corrections at one identical output frame. Returns a durable job ID; read job_get for labeled before and after PNG images. Uses the same saved edit, captions, graphics, frame and scale for both images. The before image bypasses engine color controls. Requires the engine timeline or a custom layer. Creates derived previews without changing the saved edit.',
    schema: {projectDir, expectedRevision, frame: z.number().int().nonnegative().default(0),
      scale: z.number().min(.1).max(1).default(.5)}, annotations: edit,
    run: args => startJob(args.projectDir, {...args, type: 'color_preview'})},
  {name: 'source_preview', description: 'Inspect an original source asset before making editorial decisions. Renders a still or short source clip without changing the saved edit. Bypasses saved color controls, audio finishing and manual edit gains so it represents the original recording.',
    schema: {projectDir, expectedRevision, assetId: z.string(), kind: z.enum(['still', 'preview']).default('still'), sourceStart: z.number().nonnegative().default(0), sourceEnd: z.number().positive().optional(), scale: z.number().min(0.1).max(1).default(0.5)}, annotations: edit,
    run: args => renderJob(args, true)},
  {name: 'export_render', description: 'Render one final MP4 with captions, overlays and the complete mix. Returns a job; inspect its quality report and warnings before delivery. Writes an adjacent .quality.json report with the exact file fingerprint, intended and measured settings. Finals use H.264 CRF 18; default minimum short side is 1080 pixels. A smaller intentional delivery can set minShortSide explicitly. Warnings do not silently resize the edit or establish visual approval. Creates new files and preserves originals.',
    schema: {projectDir, expectedRevision, outputPath: z.string().optional(), preset: z.enum(['vertical', 'horizontal', 'square']).optional(), fit: z.enum(['contain', 'cover']).optional(), concurrency: z.number().int().min(1).max(8).optional(), minShortSide: z.number().int().min(2).max(8192).default(1080).describe('Minimum final short edge in pixels. Lower only for an intentional smaller delivery; does not resize the video.')}, annotations: edit,
    run: args => renderJob({...args, kind: 'video', scale: 1})},
  {name: 'export_verify', description: 'Read-only check of the exact local video before delivery or upload. Recompute its fingerprint and encoded metadata against the adjacent .quality.json report. Preview files, missing or inconsistent reports and quality warnings cannot pass as a verified final. A technical pass does not establish visual sharpness or platform playback quality. Copy the report beside the video when moving it.',
    schema: {outputPath: z.string().min(1).refine(isAbsolute, 'outputPath must be absolute')}, annotations: ro,
    run: args => verifyExportQuality(args.outputPath)},
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
  {name: 'job_list', description: 'List saved local render, transcription, color-comparison, cut-review and recording-index jobs.', schema: {projectDir}, annotations: ro, run: ({projectDir: dir}) => listJobs(dir)},
  {name: 'job_get', description: 'Read job progress, result paths or actionable errors. Completed stills and color comparisons can be returned as images.',
    schema: {projectDir, jobId: z.string(), includePreview: z.boolean().optional()}, annotations: ro, run: ({projectDir: dir, jobId}) => getJob(dir, jobId)},
  {name: 'job_cancel', description: 'Request cancellation of a queued or running job and its underlying renderer/transcriber.', schema: {projectDir, jobId: z.string()}, annotations: edit, run: ({projectDir: dir, jobId}) => cancelJob(dir, jobId)},
  {name: 'job_retry', description: 'Restart a failed or interrupted job only if its original project revision is still current.', schema: {projectDir, jobId: z.string()}, annotations: edit, run: ({projectDir: dir, jobId}) => retryJob(dir, jobId)},
];

export async function callTool(name, args = {}) {
  const definition = toolDefinitions.find(tool => tool.name === name);
  if (!definition) throw new Error(`Unknown tool: ${name}`);
  return definition.run(z.object(definition.schema).strict().parse(args));
}
