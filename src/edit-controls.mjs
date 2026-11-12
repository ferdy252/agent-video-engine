// Shared by validation, timeline compilation and the browser renderer.
const fail = message => {throw Object.assign(new Error(message), {code: 'VALIDATION_ERROR'});};
const object = (v, name) => {if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`${name} must be an object.`);};
const finite = (v, name, min = -Infinity, max = Infinity) => {
  if (!Number.isFinite(v) || v < min || v > max) fail(`${name} must be between ${min} and ${max}.`);
};
export const MOTION_LIMITS = {x: [-100000, 100000], y: [-100000, 100000], scale: [.01, 100], rotation: [-36000, 36000], opacity: [0, 1]};
export function validateMotion(motion) {
  object(motion, 'motion');
  for (const [key, points] of Object.entries(motion)) {
    if (!Object.hasOwn(MOTION_LIMITS, key)) fail(`Unknown motion control ${key}.`);
    if (!Array.isArray(points) || !points.length || points.length > 1000) fail('Motion needs 1 to 1000 keyframes per control.');
    let previous = -1;
    for (const point of points) {
      object(point, 'keyframe');
      finite(point.time, 'keyframe.time', 0);
      if (point.time <= previous) fail('Keyframe times must strictly increase.');
      previous = point.time;
      finite(point.value, `keyframe.${key}`, ...MOTION_LIMITS[key]);
      if (point.easing !== undefined && !['linear', 'easeInOut', 'hold'].includes(point.easing)) fail('Unknown keyframe easing.');
      if (Object.keys(point).some(key => !['time', 'value', 'easing'].includes(key))) fail('Unknown keyframe field.');
    }
  }
}
export function validateVisual(item) {
  if (item.motion !== undefined) validateMotion(item.motion);
  if (item.motionTimeOffset !== undefined) finite(item.motionTimeOffset, 'motionTimeOffset');
  if (item.focus !== undefined) {
    object(item.focus, 'focus');
    finite(item.focus.x, 'focus.x', 0, 1); finite(item.focus.y, 'focus.y', 0, 1);
  }
  if (item.crop !== undefined) {
    object(item.crop, 'crop');
    for (const [key, value] of Object.entries(item.crop)) {
      if (!['left', 'top', 'right', 'bottom'].includes(key)) fail('Unknown crop edge.');
      finite(value, `crop.${key}`, 0, .99);
    }
    if ((item.crop.left ?? 0) + (item.crop.right ?? 0) >= 1 || (item.crop.top ?? 0) + (item.crop.bottom ?? 0) >= 1) fail('Crop must leave a visible picture.');
  }
}
export function valueAt(points, seconds, fallback = 0) {
  if (!points?.length) return fallback;
  if (seconds <= points[0].time) return points[0].value;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (seconds > b.time) continue;
    if (seconds === b.time) return b.value;
    let t = (seconds - a.time) / (b.time - a.time);
    if (a.easing === 'hold') t = 0;
    if (a.easing === 'easeInOut') t = t * t * (3 - 2 * t);
    return a.value + (b.value - a.value) * t;
  }
  return points.at(-1).value;
}
export function motionStyle(motion = {}, frame, fps, offset = 0) {
  const t = frame / fps + offset;
  return {transform: `translate(${valueAt(motion.x, t)}px, ${valueAt(motion.y, t)}px) scale(${valueAt(motion.scale, t, 1)}) rotate(${valueAt(motion.rotation, t)}deg)`,
    opacity: valueAt(motion.opacity, t, 1)};
}
export function clipSeconds(clip) {
  return clip.type === 'gap' ? clip.duration : (clip.sourceEnd - clip.sourceStart) / (clip.playbackRate ?? 1);
}
export function validateSequence(clips, fps) {
  let elapsed = 0;
  const compiled = [];
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i], previous = clips[i - 1], next = clips[i + 1];
    const duration = clipSeconds(clip);
    if (clip.type === 'gap') {
      finite(duration, 'gap.duration', 1 / fps);
      if (clip.transition) fail('A gap cannot have a transition.');
    }
    if (clip.transition) {
      object(clip.transition, 'transition');
      if (!['crossfade', 'dip', 'wipe'].includes(clip.transition.type)) fail('Unknown transition type.');
      finite(clip.transition.duration, 'transition.duration', 1 / fps, 30);
      if (!previous || previous.type === 'gap') fail('A transition needs an adjacent preceding media clip.');
      if (Math.round(clip.transition.duration * fps) < 2) fail('Transitions need at least two frames.');
    }
    const overlap = (clip.transition?.duration ?? 0) + (next?.transition?.duration ?? 0);
    if (overlap > duration + 1e-7) fail(`Transitions exceed the duration of clip ${clip.id}.`);
    const previousEnd = Math.round(elapsed * fps);
    elapsed -= clip.transition?.duration ?? 0;
    const from = Math.round(elapsed * fps);
    elapsed += duration;
    const end = Math.round(elapsed * fps), frames = end - from, transitionFrames = clip.transition ? previousEnd - from : 0;
    if (!Number.isSafeInteger(end) || end > 2147483647) fail('Timeline exceeds the supported frame count.');
    if (clip.transition && transitionFrames < 2) fail('A transition must overlap at least two actual output frames.');
    if (compiled.length && compiled.at(-1).transitionFrames + transitionFrames > compiled.at(-1).frames) fail('Rounded transitions overlap beyond the preceding clip.');
    if (transitionFrames > frames) fail('Transition exceeds the incoming output frames.');
    compiled.push({frames, transitionFrames});
  }
}
export function transitionStyle(clip, frame) {
  const incoming = clip.transitionFrames ?? 0, outgoing = clip.outgoingTransitionFrames ?? 0;
  let opacity = 1;
  let clipPath;
  if (incoming > 0 && frame < incoming) {
    const t = frame / (incoming - 1);
    if (clip.transition.type === 'crossfade') opacity *= t;
    if (clip.transition.type === 'dip') opacity *= Math.max(0, 2 * t - 1);
    if (clip.transition.type === 'wipe') clipPath = `inset(0 ${(1 - t) * 100}% 0 0)`;
  }
  if (outgoing > 0 && clip.outgoingTransitionType === 'dip' && frame >= clip.durationInFrames - outgoing) {
    const t = (frame - clip.durationInFrames + outgoing) / (outgoing - 1);
    opacity *= Math.max(0, 1 - 2 * t);
  }
  return {opacity, clipPath};
}
export function validateCaptionCues(cues) {
  if (cues === undefined || cues === null) return;
  if (!Array.isArray(cues) || cues.length > 100000) fail('Caption cues must be an array of at most 100000 entries.');
  const ids = new Set(); let previousEnd = 0;
  for (const cue of cues) {
    object(cue, 'caption cue');
    if (typeof cue.id !== 'string' || !cue.id.trim() || ids.has(cue.id)) fail('Caption cues need unique nonempty IDs.');
    ids.add(cue.id);
    if (typeof cue.text !== 'string' || !cue.text.trim()) fail('Caption text must be nonempty.');
    finite(cue.start, 'caption.start', previousEnd); finite(cue.end, 'caption.end', cue.start + Number.EPSILON);
    previousEnd = cue.end;
  }
}
export function captionCues(words, style, fps) {
  if (style.cues != null) return style.cues.map(cue => ({...cue, startFrame: Math.round(cue.start * fps), endFrame: Math.max(Math.round(cue.start * fps) + 1, Math.round(cue.end * fps))}));
  const pages = [];
  for (const word of words.slice().sort((a, b) => a.startFrame - b.startFrame)) {
    const page = pages.at(-1), previous = page?.at(-1);
    if (!page || word.pageBreakBefore || page.length >= style.wordsPerPage || previous.clipId !== word.clipId || word.startFrame - previous.endFrame > fps * .4) pages.push([word]);
    else page.push(word);
  }
  return pages.map((page, i) => {
    const startFrame = page[0].startFrame, endFrame = Math.min(page.at(-1).endFrame, pages[i + 1]?.[0].startFrame ?? Infinity);
    return {id: `caption-${page[0].clipId}-${page[0].id}`, text: page.map((w, i) => `${i ? w.lineBreakBefore ? '\n' : ' ' : ''}${w.text}`).join(''), start: startFrame / fps, end: endFrame / fps, startFrame, endFrame, words: page};
  }).filter(cue => cue.endFrame > cue.startFrame);
}
export const GRAPHIC_PRESETS = Object.freeze({
  title: {left: '8%', top: '35%', width: '84%', height: '25%', fontSize: 80, fontWeight: 800, textAlign: 'center', backgroundColor: 'rgba(0,0,0,.65)', padding: 24, borderRadius: 20, fadeInFrames: 6, fadeOutFrames: 6},
  lower_third: {left: '6%', top: '74%', width: '70%', height: '14%', fontSize: 48, fontWeight: 700, textAlign: 'left', backgroundColor: 'rgba(0,0,0,.8)', padding: 24, borderRadius: 12, fadeInFrames: 6, fadeOutFrames: 6},
  callout: {left: '10%', top: '12%', width: '80%', height: '14%', fontSize: 56, fontWeight: 700, color: '#171717', backgroundColor: '#ffde59', padding: 20, borderRadius: 16, fadeInFrames: 4, fadeOutFrames: 4},
});
