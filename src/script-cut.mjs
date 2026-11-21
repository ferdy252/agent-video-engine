import {randomUUID} from 'node:crypto';
import {stageDraft} from './drafts.mjs';
import {loadProject} from './project.mjs';
import {normalizeSpokenWords, sentenceEnd} from './take-index.mjs';
import {uncertainWordTiming} from './transcribe.mjs';

function fail(message, code = 'INVALID_SCRIPT_CUT') {
  throw Object.assign(new Error(message), {code});
}

function recording(project, assetId) {
  const asset = project.assets.find(item => item.id === assetId);
  if (!asset || !['video', 'audio'].includes(asset.type)) fail('Select registered video or audio recordings.');
  const transcript = project.transcripts.find(item => item.assetId === assetId);
  if (!transcript?.words.length) fail('Transcribe or import timed words for recording ' + assetId + ' first.', 'TRANSCRIPT_REQUIRED');
  const {words} = transcript;
  const tokens = [], starts = new Map();
  words.forEach((word, wordIndex) => {
    const normalized = normalizeSpokenWords(word.text);
    if (!normalized.length) return;
    const positions = starts.get(normalized[0]) ?? [];
    positions.push(tokens.length);
    starts.set(normalized[0], positions);
    for (const text of normalized) tokens.push({text, wordIndex});
  });
  return {asset, words, tokens, starts, flagged: new Set(transcript.timingReviewWordIds)};
}

// Only whole timestamped entries can supply a cut. A transcript entry may
// contain a phrase, or expand into several normalized tokens ("here's").
function* findTakes(sources, phrase, fps) {
  for (const {asset, words, flagged, starts, tokens} of sources) {
    for (const start of starts.get(phrase[0]) ?? []) {
      if (!phrase.every((text, n) => text === tokens[start + n]?.text)) continue;
      const end = start + phrase.length - 1;
      const first = tokens[start].wordIndex, last = tokens[end].wordIndex;
      const firstWord = words[first], lastWord = words[last], before = words[first - 1], after = words[last + 1];
      const passage = words.slice(first, last + 1);
      // Short handles use only the available space between measured words.
      const leftLimit = before ? (before.end + firstWord.start) / 2 : 0;
      const rightLimit = after ? (lastWord.end + after.start) / 2 : asset.duration;
      const sourceStart = Math.max(0, firstWord.start - .1, Math.min(firstWord.start, leftLimit));
      const sourceEnd = Math.min(asset.duration, lastWord.end + .12, Math.max(lastWord.end, rightLimit));
      const partialEntry = tokens[end + 1]?.wordIndex === last;
      const needsTimingReview = word => flagged.has(word.id) || uncertainWordTiming(word);
      const uncertain = partialEntry || needsTimingReview(firstWord) || needsTimingReview(lastWord) ||
        passage.some((word, i) => i > 0 && (word.start < passage[i - 1].start || word.end < passage[i - 1].end)) ||
        before?.end > firstWord.start || after?.start < lastWord.end || sourceEnd - sourceStart < 1 / fps;
      const pause = passage.some((word, i) => i && word.start - passage[i - 1].end > 1.2);
      const previousTokens = before ? normalizeSpokenWords(before.text) : [];
      const negated = before && firstWord.start - before.end < .5 && !sentenceEnd(before.text) &&
        (['not', 'never', 'no', 'avoid', 'without'].includes(previousTokens.at(-1)) || previousTokens.at(-1)?.endsWith("n't"));
      const startsPassage = !before || sentenceEnd(before.text) || firstWord.start - before.end >= .5;
      const endsPassage = !after || sentenceEnd(lastWord.text) || after.start - lastWord.end >= .5;
      yield {assetId: asset.id, first, last, sourceStart, sourceEnd,
        firstWordId: firstWord.id, lastWordId: lastWord.id, wholePassage: startsPassage && endsPassage,
        ...(passage.slice(1, -1).some(needsTimingReview) ? {interiorTimingNeedsReview: true} : {}),
        reviewReason: uncertain ? 'uncertain_word_boundary' : pause ? 'long_pause_inside_line' : negated ? 'check_preceding_qualifier' : null};
    }
  }
}

export async function stageScriptCut({projectDir, expectedRevision, assetIds, lines}) {
  const project = await loadProject(projectDir);
  if (project.revision !== expectedRevision) fail('The project changed. Inspect the current revision first.', 'REVISION_CONFLICT');
  if (new Set(assetIds).size !== assetIds.length) fail('List each recording once.');
  if (project.custom && project.custom.mode !== 'layer') fail('A script cut needs an engine-controlled timeline.');
  const sources = assetIds.map(id => recording(project, id));
  const used = [], results = Array(lines.length);
  // Reserve explicitly requested takes first so a default cannot consume one.
  const order = lines.map((line, i) => i).sort((a, b) => Number(!!lines[b].take) - Number(!!lines[a].take));
  for (const i of order) {
    const {text, take} = lines[i], phrase = normalizeSpokenWords(text);
    if (!phrase.length) fail('Each script line must contain spoken words.');
    let totalTakes = 0, selected = null;
    const alternatives = [];
    for (const candidate of findTakes(sources, phrase, project.settings.fps)) {
      totalTakes++;
      const {first, last, ...range} = candidate;
      const evidence = {take: totalTakes, ...range};
      if (alternatives.length < 8 || take === totalTakes) alternatives.push(evidence);
      if (candidate.reviewReason || (take && take !== totalTakes)) continue;
      if (selected && (selected.wholePassage || !candidate.wholePassage)) continue;
      if (used.some(other => other.assetId === candidate.assetId &&
        other.sourceStart < candidate.sourceEnd && candidate.sourceStart < other.sourceEnd)) continue;
      selected = {...candidate, take: totalTakes};
    }
    if (take && !selected) {
      const candidate = alternatives.find(option => option.take === take);
      const reason = !candidate ? 'no such occurrence' : candidate.reviewReason ?? 'overlaps another selected line';
      fail('Line ' + (i + 1) + ', take ' + take + ': ' + reason + '. Inspect the candidate source or choose another take.');
    }
    if (selected) used.push(selected);
    const status = selected ? 'matched' : totalTakes ? 'needs_review' : 'no_clear_match';
    results[i] = {line: i + 1, text, status, totalTakes, alternatives, selected};
  }

  const clips = [];
  let previous = null;
  for (const line of results) {
    const selection = line.selected;
    if (!selection) {previous = null; continue;}
    const {assetId, first, last, sourceStart, sourceEnd, ...info} = selection;
    // Adjacent lines from a continuous delivery share one clip, retaining its pause.
    const continuous = previous?.assetId === assetId && previous.last + 1 === first &&
      sourceStart - previous.sourceEnd <= 1.2;
    if (continuous) clips.at(-1).sourceEnd = sourceEnd;
    else clips.push({id: randomUUID(), assetId, sourceStart, sourceEnd, fit: 'contain'});
    line.selected = {assetId, sourceStart, sourceEnd, ...info, clipId: clips.at(-1).id};
    previous = selection;
  }
  const matchedLines = results.filter(line => line.selected).length;
  if (!clips.length) return {status: 'no_draft', draftId: null, matchedLines, lines: results};
  const draft = await stageDraft(projectDir, {expectedRevision, name: 'Script first cut',
    operations: [{type: 'set_clips', clips}]});
  return {status: matchedLines === lines.length ? 'complete' : 'partial', draftId: draft.id, baseRevision: expectedRevision,
    matchedLines, lines: results, preview: {projectDir, expectedRevision, draftId: draft.id,
      kind: 'preview', fromFrame: 0, toFrame: draft.diff.after.durationInFrames - 1}};
}
