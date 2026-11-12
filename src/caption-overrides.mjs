// Display-only edits. Original transcript words remain the source of cuts,
// anchors and speech evidence. No browser or speech-model dependency is needed.
const fail = (message, code = 'VALIDATION_ERROR') => {throw Object.assign(new Error(message), {code});};
const key = (assetId, wordId) => JSON.stringify([assetId, wordId]);
const evidence = word => ({id: word.id, text: word.text, start: word.start, end: word.end});

function check(overrides, transcripts, stored) {
  if (!Array.isArray(overrides) || overrides.length > 1000) fail('Caption overrides must be an array of at most 1000 entries.');
  const sources = new Map(transcripts.map(entry => [entry.assetId, entry.words]));
  const used = new Set();
  return overrides.map(override => {
    if (!override || typeof override !== 'object' || Array.isArray(override)) fail('Invalid caption override.');
    const allowed = ['assetId', 'wordIds', 'text', 'lineBreakBefore', 'pageBreakBefore', ...(stored ? ['sourceWords'] : [])];
    if (Object.keys(override).some(field => !allowed.includes(field))) fail('Unknown caption override field.');
    if (!Array.isArray(override.wordIds) || !override.wordIds.length || override.wordIds.length > 50 ||
      override.wordIds.some(id => typeof id !== 'string' || !id.trim())) fail('Caption overrides need 1 to 50 source word IDs.');
    if (override.text !== undefined && (typeof override.text !== 'string' || !override.text.trim() || override.text.length > 500 || /[\r\n]/.test(override.text))) {
      fail('Caption replacement text must be a nonempty single line, at most 500 characters. Use lineBreakBefore for a line break.');
    }
    for (const field of ['lineBreakBefore', 'pageBreakBefore']) {
      if (override[field] !== undefined && typeof override[field] !== 'boolean') fail(`${field} must be boolean.`);
    }
    if (override.text === undefined && !override.lineBreakBefore && !override.pageBreakBefore) fail('A caption override needs replacement text or a break.');
    if (override.wordIds.length > 1 && override.text === undefined) fail('Grouped word overrides need replacement text.');
    const words = sources.get(override.assetId);
    if (!words) fail('Caption override needs an existing source transcript.');
    const start = words.findIndex(word => word.id === override.wordIds[0]);
    const selected = words.slice(start, start + override.wordIds.length);
    if (start < 0 || selected.length !== override.wordIds.length || selected.some((word, i) => word.id !== override.wordIds[i])) {
      fail('Caption override word IDs must be consecutive and in source order.');
    }
    for (const id of override.wordIds) {
      const idKey = key(override.assetId, id);
      if (used.has(idKey)) fail('Caption overrides cannot overlap the same source word.');
      used.add(idKey);
    }
    const sourceWords = selected.map(evidence);
    if (stored && (!Array.isArray(override.sourceWords) || override.sourceWords.length !== sourceWords.length ||
      sourceWords.some((word, i) => !override.sourceWords[i] || Object.keys(word).some(field => override.sourceWords[i][field] !== word[field])))) {
      fail('The source transcript changed under a caption correction. Clear affected overrides before replacing the transcript, then reapply them using the new source words.', 'CAPTION_OVERRIDE_STALE');
    }
    return {...override, ...(override.text !== undefined ? {text: override.text.trim()} : {}), sourceWords};
  });
}

export const prepareCaptionOverrides = (overrides, transcripts) => check(overrides, transcripts, false);
export function validateCaptionOverrides(overrides, transcripts) {
  if (overrides === undefined) return;
  check(overrides, transcripts, true);
}

/** Resolve each retained occurrence independently. Never invent a missing word. */
export function applyCaptionOverrides(words, style, clips = []) {
  const overrides = style.wordOverrides ?? [];
  const active = style.cues == null && overrides.length > 0;
  const review = {active, totalFindings: 0, findings: [], truncated: false};
  if (!active) return {words, review};
  const byWord = new Map(overrides.flatMap(override => override.wordIds.map(id => [key(override.assetId, id), override])));
  const byClip = new Map(clips.map(clip => [clip.id, clip]));
  const ordered = words.slice().sort((a, b) => a.startFrame - b.startFrame);
  const display = [], reported = new Set();
  for (let i = 0; i < ordered.length; i++) {
    const word = ordered[i], override = byWord.get(key(word.assetId, word.id));
    if (!override) {display.push(word); continue;}
    const count = override.wordIds.length, group = ordered.slice(i, i + count);
    const clip = byClip.get(word.clipId);
    const complete = group.length === count && group.every((part, j) => part.assetId === override.assetId &&
      part.clipId === word.clipId && part.id === override.wordIds[j] && (count === 1 || (clip &&
        part.sourceStart >= clip.audioSourceStartSeconds - 1e-7 && part.sourceEnd <= clip.audioSourceEndSeconds + 1e-7)));
    if (!complete) {
      display.push(word);
      const findingKey = JSON.stringify([word.clipId, override.assetId, override.wordIds]);
      if (!reported.has(findingKey)) {
        reported.add(findingKey); review.totalFindings++;
        if (review.findings.length < 100) review.findings.push({code: 'CAPTION_GROUP_INTERRUPTED',
          clipId: word.clipId, assetId: word.assetId, wordIds: override.wordIds,
          frame: word.startFrame, message: 'A cut or overlapping speech interrupted this corrected phrase. Original retained words are displayed; review the correction.'});
      }
      continue;
    }
    display.push({...word, text: override.text ?? word.text, end: Math.max(...group.map(part => part.end)),
      endFrame: Math.max(...group.map(part => part.endFrame)), sourceEnd: Math.max(...group.map(part => part.sourceEnd)),
      sourceWordIds: [...override.wordIds], lineBreakBefore: override.lineBreakBefore ?? false,
      pageBreakBefore: override.pageBreakBefore ?? false});
    i += count - 1;
  }
  review.truncated = review.totalFindings > review.findings.length;
  return {words: display, review};
}
