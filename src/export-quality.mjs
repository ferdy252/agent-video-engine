import {readFile, stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {fileFingerprint, run} from './media.mjs';
import {compileTimeline} from './timeline.mjs';
import {inspectFraming} from './framing-quality.mjs';
import {scanSpeechGaps} from './speech-gaps.mjs';

const positiveInteger = z.number().int().positive().safe();
const nonnegativeInteger = z.number().int().nonnegative().safe();
const positiveNumber = z.number().finite().positive();
const dimensionsSchema = z.object({width: positiveInteger, height: positiveInteger}).strict();
const compositionSchema = dimensionsSchema.extend({fps: positiveNumber, durationInFrames: positiveInteger});
const targetSchema = dimensionsSchema.extend({fps: positiveNumber, minShortSide: positiveInteger.min(2).max(8192)});
const renderSchema = z.object({
  kind: z.enum(['video', 'preview', 'still']),
  sourcePreview: z.boolean(),
  composition: compositionSchema,
  dimensions: dimensionsSchema,
  frameRange: z.tuple([nonnegativeInteger, nonnegativeInteger]).nullable(),
  scale: positiveNumber.max(2),
}).strict();
const measuredSchema = dimensionsSchema.extend({
  fps: positiveNumber.nullable(),
  durationSeconds: positiveNumber.nullable(),
  frames: positiveInteger.nullable(),
  videoCodec: z.string().min(1),
  audioCodec: z.string().min(1).nullable(),
  pixelFormat: z.string().min(1).nullable(),
  bitrateBps: positiveInteger.nullable(),
  videoBitrateBps: positiveInteger.nullable(),
  container: z.string().min(1),
  majorBrand: z.string().min(1).nullable(),
});
const sourceResolutionSchema = z.object({
  scope: z.literal('engine_timeline_references'),
  visualAssetCount: nonnegativeInteger,
  unknownDimensionsCount: nonnegativeInteger,
  sizes: z.array(dimensionsSchema.extend({count: positiveInteger})),
}).strict();
const legacyReportSchema = z.object({
  schemaVersion: z.literal(1),
  purpose: z.enum(['final', 'preview', 'source_preview', 'still']),
  status: z.enum(['passed', 'needs_review', 'not_final']),
  revision: nonnegativeInteger,
  fingerprint: z.object({sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: positiveInteger}).strict(),
  target: targetSchema,
  render: renderSchema,
  measured: measuredSchema,
  encoding: z.object({requested: z.object({
    codec: z.literal('h264'),
    audioCodec: z.literal('aac'),
    container: z.literal('mp4'),
    pixelFormat: z.literal('yuv420p'),
    rateControl: z.literal('crf'),
    crf: z.union([z.literal(18), z.literal(25)]),
  }).strict().nullable()}).strict(),
  sourceResolution: sourceResolutionSchema,
  warnings: z.array(z.object({code: z.string(), message: z.string()}).strict()),
  limitations: z.array(z.string()),
}).strict();

const findingRange = {startSeconds: z.number().nonnegative(), endSeconds: z.number().nonnegative()};
const framingSchema = z.object({
  version: z.literal(1), scope: z.literal('engine_raster_geometry'), revision: nonnegativeInteger,
  threshold: z.number().min(1).max(10), assessedCount: nonnegativeInteger, unassessedCount: nonnegativeInteger,
  totalFindings: nonnegativeInteger, offset: nonnegativeInteger, truncated: z.boolean(),
  findings: z.array(z.object({code: z.enum(['EXCESSIVE_UPSCALE', 'FRAMING_UNASSESSED', 'CUSTOM_FRAMING_UNASSESSED']),
    kind: z.enum(['clip', 'overlay', 'custom']), message: z.string(), itemId: z.string().optional(), assetId: z.string().optional(),
    startFrame: nonnegativeInteger.optional(), endFrame: nonnegativeInteger.optional(),
    startSeconds: z.number().nonnegative().optional(), endSeconds: z.number().nonnegative().optional(),
    nativeWidth: positiveNumber.optional(), nativeHeight: positiveNumber.optional(),
    boxWidth: positiveNumber.optional(), boxHeight: positiveNumber.optional(), fit: z.enum(['cover', 'contain']).optional(),
    crop: z.record(z.number()).optional(), maxUpscale: positiveNumber.optional(), motionScale: positiveNumber.optional(),
    worstFrame: nonnegativeInteger.optional(), worstSeconds: z.number().nonnegative().optional(),
    sourceSeconds: z.number().nonnegative().nullable().optional(),
    preview: z.object({kind: z.literal('still'), frame: nonnegativeInteger, scale: z.literal(1)}).strict().optional(),
    suggestions: z.array(z.string()).optional(),
  }).strict()), limitations: z.array(z.string()),
}).strict();
const speechSchema = z.object({
  version: z.literal(1), status: z.enum(['completed', 'missing_audio']), scope: z.literal('entire_encoded_file'),
  method: z.literal('decoded_audio_silence_and_source_word_intervals'), durationSeconds: positiveNumber,
  decodedAudioSeconds: z.number().nonnegative(), minGapSeconds: z.number().min(.2).max(30), noiseDb: z.number().min(-80).max(-15),
  transcriptCoverage: z.object({voiceTrackCount: nonnegativeInteger, unassessedTrackCount: nonnegativeInteger,
    assessedSeconds: z.number().nonnegative(), customAudioUnassessed: z.boolean()}).strict(),
  totalFindings: nonnegativeInteger, truncated: z.boolean(),
  findings: z.array(z.object({code: z.enum(['QUIET_AUDIO_GAP', 'AUDIO_ENDS_EARLY', 'MISSING_AUDIO', 'TRANSCRIPT_SPEECH_GAP']),
    ...findingRange, durationSeconds: positiveNumber, timelineStartSeconds: z.number().nonnegative(), timelineEndSeconds: z.number().nonnegative(),
    reviewStartSeconds: z.number().nonnegative(), reviewEndSeconds: z.number().nonnegative()}).strict()),
  limitations: z.array(z.string()),
}).strict();
const reportSchema = z.union([legacyReportSchema, legacyReportSchema.extend({schemaVersion: z.literal(2),
  checks: z.object({framing: framingSchema, speechGaps: speechSchema.nullable(),
    captionOverrides: z.object({active: z.boolean(), totalFindings: nonnegativeInteger, truncated: z.boolean(),
      findings: z.array(z.object({code: z.literal('CAPTION_GROUP_INTERRUPTED'), clipId: z.string(), assetId: z.string(),
        wordIds: z.array(z.string()), frame: nonnegativeInteger, message: z.string()}).strict())}).strict().optional(),
  }).strict()})]);

const limitations = [
  'These checks verify technical export properties. Watch the video at delivery size to judge visual quality.',
  'Visual softness, detail lost to cropping or upscaling, and quality after platform transcoding require visual review.',
  'Source dimensions summarize engine timeline references. Shot visibility, framing and custom-layer media can differ.',
  'The encoder settings are requested values. Bitrate is measured for context and does not determine pass or fail.',
];
const currentLimitations = [limitations[0],
  'Framing checks estimate enlargement for supported engine media. Focus, custom visuals and platform transcoding need direct review.',
  'Speech-gap checks scan the full encoded audio and use source word intervals where available. Music can mask speech gaps.',
  limitations[3]];

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function positiveCount(value) {
  const number = positive(value);
  return Number.isSafeInteger(number) ? number : null;
}

function frameRate(value) {
  const [numerator, denominator = 1] = String(value).split('/').map(Number);
  return positive(numerator / denominator);
}

async function inspectMedia(filePath, signal) {
  signal?.throwIfAborted();
  const original = await stat(filePath);
  if (!original.isFile() || !original.size) throw new Error('Export quality requires a nonempty media file.');
  const {stdout} = await run('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,r_frame_rate,duration,nb_frames,bit_rate:format=format_name,duration,bit_rate:format_tags=major_brand',
    '-of', 'json', filePath], {signal});
  const {streams = [], format = {}} = JSON.parse(stdout);
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  if (!video?.width || !video.height || !video.codec_name || !format.format_name) {
    throw new Error('Could not read the export video dimensions and codec.');
  }
  // Image demuxers may report an assumed rate for a standalone still.
  const still = format.format_name === 'image2' || format.format_name.endsWith('_pipe');
  const measured = measuredSchema.parse({
    width: video.width,
    height: video.height,
    fps: still ? null : frameRate(video.avg_frame_rate) ?? frameRate(video.r_frame_rate),
    durationSeconds: still ? null : positive(video.duration) ?? positive(format.duration),
    frames: still ? 1 : positiveCount(video.nb_frames),
    videoCodec: video.codec_name,
    audioCodec: audio?.codec_name ?? null,
    pixelFormat: video.pix_fmt ?? null,
    bitrateBps: positiveCount(format.bit_rate),
    videoBitrateBps: positiveCount(video.bit_rate),
    container: format.format_name,
    majorBrand: format.tags?.major_brand || null,
  });
  const fingerprint = {sha256: (await fileFingerprint(filePath)).slice('sha256:'.length), bytes: original.size};
  signal?.throwIfAborted();
  const current = await stat(filePath);
  if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some((key) => original[key] !== current[key])) {
    throw Object.assign(new Error('The export changed while its quality was checked.'), {code: 'EXPORT_CHANGED'});
  }
  return {fingerprint, measured};
}

function purposeFor({kind, sourcePreview}) {
  if (sourcePreview) return 'source_preview';
  return kind === 'video' ? 'final' : kind;
}

function encodingFor(kind) {
  return {requested: kind === 'still' ? null :
    {codec: 'h264', audioCodec: 'aac', container: 'mp4', pixelFormat: 'yuv420p',
      rateControl: 'crf', crf: kind === 'preview' ? 25 : 18}};
}

function validFrameRange({kind, frameRange, composition}) {
  if (kind === 'still') return frameRange === null;
  return frameRange !== null && frameRange[0] <= frameRange[1] && frameRange[1] < composition.durationInFrames;
}

function sameDimensions(left, right) {
  return left.width === right.width && left.height === right.height;
}

function technicalWarnings({purpose, target, render, measured, encoding}) {
  const warnings = [];
  const add = (code, message) => warnings.push({code, message});
  if (!sameDimensions(measured, render.dimensions)) {
    add('OUTPUT_DIMENSIONS_MISMATCH', 'The encoded dimensions differ from the requested render dimensions.');
  }
  if (render.kind !== 'still') {
    const frames = render.frameRange[1] - render.frameRange[0] + 1;
    if (measured.fps === null || Math.abs(measured.fps - render.composition.fps) > 1e-6) {
      add('OUTPUT_FPS_MISMATCH', 'The encoded frame rate differs from the composition frame rate.');
    }
    if (measured.frames !== frames || measured.durationSeconds === null ||
      Math.abs(measured.durationSeconds - frames / render.composition.fps) > 1 / render.composition.fps + 1e-6) {
      add('OUTPUT_TIMING_MISMATCH', 'The encoded frame count or duration differs from the selected range.');
    }
    if (measured.videoCodec !== encoding.requested.codec) {
      add('OUTPUT_CODEC_MISMATCH', 'The encoded video codec differs from the requested codec.');
    }
    if (measured.audioCodec !== encoding.requested.audioCodec) {
      add('OUTPUT_AUDIO_CODEC_MISMATCH', 'The encoded file needs an AAC audio track.');
    }
    // FFprobe groups related containers under the same format name.
    const otherBrand = /^(qt$|3g|mjp|mj2|m4a$)/i.test(measured.majorBrand?.trim() ?? '');
    if (!measured.container.split(',').includes(encoding.requested.container) || otherBrand) {
      add('OUTPUT_CONTAINER_MISMATCH', 'The encoded file is not an MP4 container.');
    }
    if (measured.pixelFormat !== encoding.requested.pixelFormat) {
      add('OUTPUT_PIXEL_FORMAT_MISMATCH', 'The encoded pixel format differs from the requested format.');
    }
  }
  if (purpose === 'final') {
    if (Math.min(measured.width, measured.height) < target.minShortSide) {
      add('FINAL_RESOLUTION_BELOW_MINIMUM', 'The short side is below the requested minimum resolution.');
    }
    if (!sameDimensions(render.composition, target) || !sameDimensions(measured, target)) {
      add('TARGET_DIMENSIONS_MISMATCH', 'The composition or encoded dimensions differ from the project target.');
    }
    if (Math.abs(render.composition.fps - target.fps) > 1e-6) {
      add('TARGET_FPS_MISMATCH', 'The composition frame rate differs from the project target.');
    }
    if (render.scale !== 1) add('SCALED_FINAL', 'The final render used a scale other than one.');
    if (render.frameRange[0] !== 0 || render.frameRange[1] !== render.composition.durationInFrames - 1) {
      add('PARTIAL_FINAL', 'The final render covers only part of the composition.');
    }
  }
  return warnings;
}

function statusFor(purpose, warnings) {
  if (purpose !== 'final') return 'not_final';
  return warnings.length ? 'needs_review' : 'passed';
}

function reviewWarnings(report) {
  const warnings = technicalWarnings(report);
  if (report.schemaVersion !== 2) return warnings;
  const {framing, speechGaps} = report.checks;
  if (framing.totalFindings) warnings.push({code: 'FRAMING_REVIEW_REQUIRED', message: `${framing.totalFindings} framing finding(s). Inspect the indicated shots at delivery size.`});
  if (speechGaps?.totalFindings) warnings.push({code: 'SPEECH_GAPS_REVIEW_REQUIRED', message: `${speechGaps.totalFindings} possible speech/audio gap(s). Listen to the flagged ranges in the encoded file before sharing.`});
  if (report.purpose === 'final' && !speechGaps) warnings.push({code: 'SPEECH_SCAN_MISSING', message: 'The full-export speech-gap scan is missing.'});
  if (framing.truncated || speechGaps?.truncated) warnings.push({code: 'REVIEW_FINDINGS_TRUNCATED', message: 'The entire export was checked, but the returned findings are capped. Additional review is required.'});
  if (report.checks.captionOverrides?.totalFindings) warnings.push({code: 'CAPTION_OVERRIDES_REVIEW_REQUIRED', message: 'Cuts interrupted a corrected caption phrase. Inspect captionOverrideReview and the displayed retained words.'});
  return warnings;
}

function summarizeSourceResolution(project) {
  const used = new Set([...project.clips, ...project.overlays].map((item) => item.assetId));
  const visual = project.assets.filter((asset) => used.has(asset.id) && ['video', 'image'].includes(asset.type));
  const resolutions = new Map();
  let unknownDimensionsCount = 0;
  for (const asset of visual) {
    const size = dimensionsSchema.safeParse({width: asset.width, height: asset.height});
    if (!size.success) {
      unknownDimensionsCount++;
      continue;
    }
    const key = `${size.data.width}x${size.data.height}`;
    const existing = resolutions.get(key);
    if (existing) existing.count++;
    else resolutions.set(key, {...size.data, count: 1});
  }
  const sizes = [...resolutions.values()].sort((a, b) => a.width - b.width || a.height - b.height);
  return {scope: 'engine_timeline_references', visualAssetCount: visual.length, unknownDimensionsCount, sizes};
}

/** Measure the staged output before it is published and paired with its sidecar. */
export async function buildExportQuality({filePath, project, kind, sourcePreview = false, composition,
  dimensions, frameRange, scale, minShortSide = 1080, maxUpscale = 1.25,
  speechGapMinSeconds = .8, speechGapNoiseDb = -40, signal, onProgress}) {
  const {width, height, fps} = project.settings;
  const target = targetSchema.parse({width, height, fps, minShortSide});
  const render = renderSchema.parse({
    kind,
    sourcePreview,
    composition: {width: composition.width, height: composition.height, fps: composition.fps, durationInFrames: composition.durationInFrames},
    dimensions,
    frameRange: frameRange ?? null,
    scale,
  });
  if (!validFrameRange(render)) throw new Error('Invalid export quality frame range.');
  const actual = await inspectMedia(resolve(filePath), signal);
  const timeline = compileTimeline(project);
  onProgress?.({stage: 'framing_quality', progress: 0});
  const framing = await inspectFraming(project, {timeline, scale, frameRange: frameRange ?? [0, timeline.durationInFrames - 1], maxUpscale, signal});
  if (kind === 'video' && !sourcePreview) onProgress?.({stage: 'speech_gap_scan', progress: 0});
  const speechGaps = kind === 'video' && !sourcePreview ? await scanSpeechGaps(resolve(filePath), {project, timeline,
    duration: actual.measured.durationSeconds, hasAudio: actual.measured.audioCodec !== null,
    startSeconds: (frameRange?.[0] ?? 0) / composition.fps, minGapSeconds: speechGapMinSeconds, noiseDb: speechGapNoiseDb, signal}) : null;
  // Guard the entire scan, not just the metadata read, against file replacement.
  if ((await fileFingerprint(filePath)).slice('sha256:'.length) !== actual.fingerprint.sha256) {
    throw Object.assign(new Error('The export changed during its full-file checks.'), {code: 'EXPORT_CHANGED'});
  }
  const report = {schemaVersion: 2, purpose: purposeFor(render), revision: nonnegativeInteger.parse(project.revision),
    ...actual, target, render, encoding: encodingFor(kind), sourceResolution: summarizeSourceResolution(project)};
  report.checks = {framing, speechGaps, ...(timeline.captionOverrideReview ? {captionOverrides: timeline.captionOverrideReview} : {})};
  const warnings = reviewWarnings(report);
  signal?.throwIfAborted();
  return reportSchema.parse({...report, status: statusFor(report.purpose, warnings), warnings, limitations: [...currentLimitations]});
}

function consistentReport(report) {
  const {render, purpose, encoding, sourceResolution} = report;
  if (!validFrameRange(render) || purposeFor(render) !== purpose ||
    !isDeepStrictEqual(encoding, encodingFor(render.kind))) return false;
  if (sourceResolution.visualAssetCount !== sourceResolution.unknownDimensionsCount +
    sourceResolution.sizes.reduce((total, size) => total + size.count, 0)) return false;
  if (report.schemaVersion === 2) {
    const {framing, speechGaps} = report.checks;
    const captions = report.checks.captionOverrides;
    if (captions && (captions.totalFindings < captions.findings.length ||
      captions.truncated !== (captions.totalFindings > captions.findings.length) ||
      (!captions.active && captions.totalFindings))) return false;
    if (framing.revision !== report.revision || framing.offset !== 0 ||
      framing.totalFindings < framing.findings.length || framing.truncated !== (framing.totalFindings > framing.findings.length)) return false;
    if (speechGaps && (speechGaps.totalFindings < speechGaps.findings.length ||
      speechGaps.truncated !== (speechGaps.totalFindings > speechGaps.findings.length) ||
      speechGaps.durationSeconds !== report.measured.durationSeconds ||
      speechGaps.findings.some(x => x.endSeconds <= x.startSeconds || x.endSeconds > speechGaps.durationSeconds + .001))) return false;
  }
  const warnings = reviewWarnings(report);
  return report.status === statusFor(purpose, warnings) && isDeepStrictEqual(report.warnings, warnings) &&
    isDeepStrictEqual(report.limitations, report.schemaVersion === 2 ? currentLimitations : limitations);
}

async function readQualityReport(sidecar, signal) {
  let raw;
  try {
    const info = await stat(sidecar);
    if (!info.isFile() || info.size > 4 * 1024 * 1024) return {state: 'malformed'};
    raw = await readFile(sidecar, {encoding: 'utf8', signal});
  }
  catch (error) {
    if (error.code === 'ENOENT') return {state: 'missing'};
    throw error;
  }
  let parsed;
  try {parsed = reportSchema.safeParse(JSON.parse(raw));}
  catch (error) {
    if (error instanceof SyntaxError) return {state: 'malformed'};
    throw error;
  }
  if (!parsed.success || !consistentReport(parsed.data)) return {state: 'malformed'};
  return {state: 'present', saved: parsed.data};
}

/** Verify the exact file and regenerate the technical status from measured evidence. */
export async function verifyExportQuality(filePath, {signal} = {}) {
  const absolute = resolve(filePath);
  const {state, saved} = await readQualityReport(`${absolute}.quality.json`, signal);
  const actual = await inspectMedia(absolute, signal);
  if (!saved) {
    const warning = state === 'missing' ? {code: 'QUALITY_REPORT_MISSING', message: 'This file has no saved export quality report.'}
      : {code: 'QUALITY_REPORT_MALFORMED', message: 'The saved export quality report is invalid or internally inconsistent.'};
    return {schemaVersion: 1, purpose: null, status: 'needs_review', revision: null, ...actual,
      warnings: [warning], limitations: [...limitations],
      verification: {report: state, fingerprintMatches: null, metadataMatches: null, verifiedFinal: false}};
  }
  const fingerprintMatches = isDeepStrictEqual(saved.fingerprint, actual.fingerprint);
  const metadataMatches = isDeepStrictEqual(saved.measured, actual.measured);
  const matched = fingerprintMatches && metadataMatches;
  const report = {...saved, ...actual};
  const warnings = reviewWarnings(report);
  if (saved.schemaVersion === 1) warnings.push({code: 'EXPORT_REVIEW_CHECKS_MISSING', message: 'This older export report predates framing and full-file speech-gap checks. Export again to run them.'});
  if (!fingerprintMatches) warnings.push({code: 'EXPORT_FINGERPRINT_MISMATCH', message: 'The file bytes differ from the saved export.'});
  if (!metadataMatches) warnings.push({code: 'EXPORT_METADATA_MISMATCH', message: 'The measured media metadata differs from the saved report.'});
  const status = statusFor(report.purpose, warnings);
  return {...report, status, warnings, verification: {report: matched ? 'matched' : 'mismatch',
    fingerprintMatches, metadataMatches, verifiedFinal: matched && status === 'passed'}};
}
