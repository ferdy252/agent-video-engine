import {z} from 'zod';
import {MOTION_LIMITS} from './edit-controls.mjs';

export const anchorSchema = z.object({
  assetId: z.string().min(1), wordId: z.string().min(1), clipId: z.string().min(1).optional(), offset: z.number().finite().optional(),
}).strict();
const fraction = z.number().finite().min(0).max(1);
const wordChannels = [...Object.keys(MOTION_LIMITS), 'fill'];
const color = z.string().regex(/^#(?:[\da-f]{3}|[\da-f]{6})$/i);
const channels = Object.fromEntries(Object.entries(MOTION_LIMITS).map(([key, [min, max]]) =>
  [key, z.number().min(min).max(max).optional()]));
export const wordActionsSchema = z.object({
  steps: z.array(z.object({anchor: anchorSchema, ...channels, fill: fraction.optional(), color: color.optional(),
    easing: z.enum(['linear', 'easeInOut', 'hold']).optional()}).strict().refine(step =>
    Object.keys(step).some(key => key !== 'anchor' && key !== 'easing'), 'Each word needs a visual change.')).min(1).max(128),
  holdSeconds: z.number().finite().min(0).max(60).optional(),
}).strict();
export const boundsSchema = z.object({x: fraction, y: fraction, width: fraction.positive(), height: fraction.positive()}).strict()
  .refine(b => b.x + b.width <= 1.000001 && b.y + b.height <= 1.000001, 'Bounds must fit inside the displayed source.');
export const screenFocusSchema = z.object({
  target: z.object({assetId: z.string().min(1), sourceTime: z.number().finite().nonnegative(), bounds: boundsSchema}).strict(),
  zoom: z.number().min(1).max(8).optional(), color: color.optional(),
  rampSeconds: z.number().positive().max(10).optional(),
}).strict();

export function overlayAnchors(overlay) {
  return [...(overlay.anchor !== undefined ? [overlay.anchor] : []), ...(overlay.wordActions?.steps ?? []).map(step => step.anchor)];
}

export function anchorSeconds(words, anchor) {
  const word = words.find(w => w.assetId === anchor.assetId && w.id === anchor.wordId &&
    (anchor.clipId === undefined || w.clipId === anchor.clipId));
  return word ? Math.max(0, word.start + (anchor.offset ?? 0)) : null;
}

// Compile on the same frame clock as captions, even when captions are hidden.
export function compileWordActions(overlay, words, fps) {
  const frames = overlay.wordActions.steps.map(step => {
    const seconds = anchorSeconds(words, step.anchor);
    return seconds === null ? null : Math.round(seconds * fps);
  });
  const missing = frames.findIndex(frame => frame === null);
  const reversed = frames.findIndex((frame, i) => i > 0 && frame <= frames[i - 1]);
  const issue = missing >= 0 ? missing : reversed;
  if (issue >= 0) return {issue: {overlayId: overlay.id, step: issue, anchor: overlay.wordActions.steps[issue].anchor,
    reason: missing >= 0 ? 'word_removed' : 'words_out_of_order_or_same_frame'}};
  const from = frames[0], motion = {...overlay.motion}, fill = [], colors = [];
  const tracks = {fill};
  for (const [i, step] of overlay.wordActions.steps.entries()) {
    const time = (frames[i] - from) / fps;
    if (step.color) colors.push({frame: frames[i] - from, value: step.color});
    for (const key of wordChannels) {
      if (step[key] === undefined) continue;
      const track = tracks[key] ??= [];
      if (!track.length && time > 0) track.push({time: 0, value: ['opacity','scale'].includes(key) ? 1 : 0, easing: 'hold'});
      track.push({time, value: step[key], easing: step.easing ?? 'linear'});
      if (key !== 'fill') motion[key] = track;
    }
  }
  const durationInFrames = frames.at(-1) - from + Math.max(1, Math.ceil((overlay.wordActions.holdSeconds ?? .8) * fps));
  return {compiled: {...overlay, from, start: from / fps, end: (from + durationInFrames) / fps, durationInFrames,
    motion, actionFrames: frames, fill, colors}};
}
