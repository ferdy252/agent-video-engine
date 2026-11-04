/** Deterministic transcript passages and possible retakes, never take selection. */
const invalid = (message) => {throw Object.assign(new Error(message), {code: 'INVALID_TAKE_INDEX_INPUT'});};
const contractions = new Map(Object.entries({
  "i'm": ['i', 'am'], "you're": ['you', 'are'], "we're": ['we', 'are'], "they're": ['they', 'are'],
  "it's": ['it', 'is'], "here's": ['here', 'is'], "that's": ['that', 'is'], "let's": ['let', 'us'],
  "don't": ['do', 'not'], "doesn't": ['does', 'not'], "can't": ['can', 'not'], "won't": ['will', 'not'],
}));
function normalize(text) {
  return (text.normalize('NFKC').toLowerCase().replaceAll('’', "'")
    .match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? []).flatMap((token) => contractions.get(token) ?? [token]);
}
const sentenceEnd = (text) => /[.!?。！？…][”"'’\)\]\}]*$/u.test(text.trim());
const phraseKey = (tokens) => tokens.join('\u0001');
const hesitationTokens = new Set(['um', 'uh', 'erm', 'hmm', 'okay']);
function comparisonPrefix(tokens) {
  let offset = 0;
  while (offset < 2 && hesitationTokens.has(tokens[offset])) offset++;
  return {tokens: tokens.slice(offset, offset + 32), ignored: tokens.slice(0, offset)};
}
function informative(tokens) {
  if (new Set(tokens).size < Math.min(3, tokens.length)) return false;
  return ![1, 2].some((period) => tokens.length >= period * 2 && tokens.every((token, index) => token === tokens[index % period]));
}
function commonPrefix(left, right) {
  let length = 0;
  while (length < Math.min(left.length, right.length) && left[length] === right[length]) length++;
  return length;
}
function lcs(left, right) {
  let previous = Array(right.length + 1).fill(0);
  for (const token of left) {
    const current = [0];
    for (let index = 0; index < right.length; index++) current.push(token === right[index]
      ? previous[index] + 1 : Math.max(previous[index + 1], current[index]));
    previous = current;
  }
  return previous[right.length];
}
function bigrams(tokens) {return new Set(tokens.slice(1).map((token, index) => phraseKey([tokens[index], token])));}
function compare(left, right, minimum) {
  const preparedLeft = comparisonPrefix(left), preparedRight = comparisonPrefix(right);
  const a = preparedLeft.tokens, b = preparedRight.tokens;
  if (Math.min(a.length, b.length) < minimum || !informative(a) || !informative(b)) return null;
  const prefix = commonPrefix(a, b);
  const matched = lcs(a, b);
  if (matched < minimum) return null;
  const prefixRatio = prefix / Math.min(a.length, b.length);
  const lcsRatio = matched / Math.min(a.length, b.length);
  const ab = bigrams(a), bb = bigrams(b);
  const sharedBigrams = [...ab].filter((key) => bb.has(key));
  const dice = 2 * sharedBigrams.length / Math.max(1, ab.size + bb.size);
  const headRatio = lcs(a.slice(0, 6), b.slice(0, 6)) / Math.min(6, a.length, b.length);
  const exactPrefix = prefix >= minimum && prefixRatio >= 0.65;
  const nearPrefix = prefix >= 2 && dice >= 0.45 && lcsRatio >= 0.72 && headRatio >= 0.6;
  if (!exactPrefix && !nearPrefix) return null;
  const score = Math.max(prefixRatio, (lcsRatio + dice) / 2);
  return {similarity: Number(score.toFixed(3)), normalizedSharedPrefix: a.slice(0, prefix).join(' '),
    ignoredLeadingTokens: {left: preparedLeft.ignored, right: preparedRight.ignored},
    sharedWordCount: matched, exactPrefixWords: prefix, bigramSimilarity: Number(dice.toFixed(3)),
    sharedBigrams: sharedBigrams.map((key) => key.replaceAll('\u0001', ' ')).slice(0, 8),
    confidence: exactPrefix && prefixRatio >= 0.8 ? 'high_textual_overlap' : 'moderate_textual_overlap',
    reason: exactPrefix ? 'One nearby passage repeats the beginning of another, including possible partial restarts.'
      : 'Nearby passages have similar opening words and substantial ordered word/bigram overlap.'};
}

function baseResult(status) {
  return {status, attempts: [], groups: [], method: 'source_transcript_heuristics',
    confidenceRubric: {high_textual_overlap: 'At least four normalized opening words repeat and cover at least 80% of the shorter compared prefix.',
      moderate_textual_overlap: 'Nearby openings share substantial ordered words and bigrams, including reworded passages.'},
    limitations: ['Passages and possible retakes are derived from transcript text and timestamps, not visual or audio delivery.',
      'Repeated wording can be intentional. Groups identify possible alternatives, never a best take or a deletion recommendation.',
      'Only timestamped words are segmented. Untranscribed footage, inaccurate punctuation and missed speech can change the apparent boundaries.',
      'A restart inside one multiword transcript entry cannot be split without inventing a source timestamp.']};
}

/** Preserve all original words and source times while deriving searchable passages. */
export function analyzeTakes(transcript, {duration, pauseSeconds = 1.2, minRepeatWords = 4,
  retakeWindowSeconds = 120, maxComparisons = 5000, maxCandidatesPerAttempt = 32} = {}) {
  if (!Number.isFinite(pauseSeconds) || pauseSeconds <= 0) invalid('pauseSeconds must be positive.');
  if (!Number.isInteger(minRepeatWords) || minRepeatWords < 4 || minRepeatWords > 12) invalid('minRepeatWords must be an integer from 4 to 12.');
  if (!Number.isFinite(retakeWindowSeconds) || retakeWindowSeconds <= 0) invalid('retakeWindowSeconds must be positive.');
  if (!Number.isInteger(maxComparisons) || maxComparisons < 1 || maxComparisons > 100000) invalid('maxComparisons must be an integer from 1 to 100000.');
  if (!Number.isInteger(maxCandidatesPerAttempt) || maxCandidatesPerAttempt < 1 || maxCandidatesPerAttempt > 128) invalid('maxCandidatesPerAttempt must be an integer from 1 to 128.');
  if (duration !== undefined && (!Number.isFinite(duration) || duration < 0)) invalid('duration must be finite and nonnegative.');
  if (transcript == null || transcript.words == null) return baseResult('missing');
  if (!Array.isArray(transcript.words)) invalid('transcript.words must be an array.');
  const words = transcript.words;
  if (!words.length) return baseResult('empty');
  const ids = new Set();
  const normalizedWords = [];
  let previousStart = -Infinity;
  for (const word of words) {
    if (!word || typeof word.id !== 'string' || !word.id || ids.has(word.id)) invalid('Transcript word IDs must be unique nonempty strings.');
    ids.add(word.id);
    if (typeof word.text !== 'string' || !word.text.trim()) invalid('Transcript words need nonempty text.');
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.end < word.start || word.start < previousStart) invalid('Transcript word times must be finite, nonnegative and ordered; point and overlapping words are allowed.');
    if (duration !== undefined && word.end > duration + 1e-7) invalid('Transcript word timing exceeds the source duration.');
    previousStart = word.start;
    normalizedWords.push(normalize(word.text));
  }
  const tokens = [], tokenStarts = [];
  for (const row of normalizedWords) {tokenStarts.push(tokens.length); tokens.push(...row);}
  const boundaries = new Map([[0, {type: 'transcript_start', confidence: 'source_boundary', sourceWordId: words[0].id}]]);
  const anchors = new Map();
  let lastBoundaryToken = 0;
  const registerAnchor = (wordIndex) => {
    const tokenStart = tokenStarts[wordIndex];
    for (let shift = 0; shift <= 2; shift++) {
      const phrase = tokens.slice(tokenStart + shift, tokenStart + shift + minRepeatWords);
      if (phrase.length < minRepeatWords || !informative(phrase)) continue;
      const key = phraseKey(phrase), entries = anchors.get(key) ?? [];
      entries.push({wordIndex, tokenStart: tokenStart + shift, phrase, shift});
      anchors.set(key, entries.slice(-16));
    }
  };
  for (let index = 0; index < words.length; index++) {
    const start = tokenStarts[index];
    if (index > 0) {
      const gap = words[index].start - words[index - 1].end;
      if (gap >= pauseSeconds) boundaries.set(index, {type: 'long_source_pause', confidence: 'timestamp_gap',
        sourceWordId: words[index].id, previousWordId: words[index - 1].id, gapSeconds: gap, thresholdSeconds: pauseSeconds});
      else if (sentenceEnd(words[index - 1].text) && start - lastBoundaryToken >= minRepeatWords) boundaries.set(index,
        {type: 'sentence_boundary', confidence: 'punctuation_heuristic', sourceWordId: words[index].id, previousWordId: words[index - 1].id});
      const phrase = tokens.slice(start, start + minRepeatWords);
      // Prefix variants overlap one another. Once a restart has been found,
      // its following opening words are continuation, not more restarts.
      if (start - lastBoundaryToken >= minRepeatWords && phrase.length === minRepeatWords && informative(phrase)) {
        const previous = (anchors.get(phraseKey(phrase)) ?? []).findLast((anchor) => anchor.wordIndex < index &&
          start - anchor.tokenStart >= minRepeatWords && words[index].start - words[anchor.wordIndex].start <= retakeWindowSeconds);
        if (previous) boundaries.set(index, {type: 'repeated_phrase_restart', confidence: 'repeated_opening_words',
          sourceWordId: words[index].id, matchedPriorWordId: words[previous.wordIndex].id,
          matchedPriorStart: words[previous.wordIndex].start, normalizedPrefix: phrase.join(' '),
          matchedTokenCount: minRepeatWords, priorPrefixOffset: previous.shift,
          ...(boundaries.has(index) ? {additionalBoundary: boundaries.get(index)} : {})});
      }
    }
    if (boundaries.has(index)) {registerAnchor(index); lastBoundaryToken = start;}
  }
  const result = baseResult('available');
  const starts = [...boundaries.keys()].sort((a, b) => a - b);
  const attemptTokens = [];
  for (let index = 0; index < starts.length; index++) {
    const from = starts[index], to = starts[index + 1] ?? words.length;
    const passage = words.slice(from, to);
    result.attempts.push({id: `take-${from + 1}`, start: passage[0].start,
      end: passage.reduce((end, word) => Math.max(end, word.end), passage[0].end),
      wordIds: passage.map((word) => word.id), text: passage.map((word) => word.text).join(' '),
      reason: boundaries.get(from).type, boundaryEvidence: {...boundaries.get(from), provenance: 'original_source_word_ids_and_timestamps'}});
    attemptTokens.push(normalizedWords.slice(from, to).flat());
  }
  const candidates = new Map(), parents = result.attempts.map((_, index) => index);
  const clusterStarts = result.attempts.map((attempt) => attempt.start), clusterEnds = [...clusterStarts];
  const find = (index) => {while (parents[index] !== index) {parents[index] = parents[parents[index]]; index = parents[index];} return index;};
  const edges = [];
  let comparisons = 0, limited = false;
  for (let index = 0; index < result.attempts.length; index++) {
    const prefix = attemptTokens[index].slice(0, 12);
    const keys = [...new Set([`head:${prefix[0] ?? ''}`, ...prefix.slice(1, 8).map((token, offset) => `bi:${phraseKey([prefix[offset], token])}`)])];
    const nearby = new Set();
    for (const key of keys) for (const previous of candidates.get(key) ?? []) {
      if (result.attempts[index].start - result.attempts[previous].start <= retakeWindowSeconds) nearby.add(previous);
    }
    const selected = [...nearby].sort((a, b) => b - a).slice(0, maxCandidatesPerAttempt);
    for (const previous of selected) {
      if (comparisons >= maxComparisons) {limited = true; break;}
      comparisons++;
      const evidence = compare(attemptTokens[previous], attemptTokens[index], minRepeatWords);
      if (!evidence) continue;
      const a = find(previous), b = find(index);
      const earliest = Math.min(clusterStarts[a], clusterStarts[b]), latest = Math.max(clusterEnds[a], clusterEnds[b]);
      if (latest - earliest > retakeWindowSeconds) continue;
      if (a !== b) {parents[b] = a; clusterStarts[a] = earliest; clusterEnds[a] = latest;}
      edges.push({attemptIds: [result.attempts[previous].id, result.attempts[index].id],
        timeDistanceSeconds: result.attempts[index].start - result.attempts[previous].start, ...evidence});
    }
    for (const key of keys) {const entries = candidates.get(key) ?? []; entries.push(index); candidates.set(key, entries.slice(-maxCandidatesPerAttempt));}
  }
  const clusters = new Map();
  result.attempts.forEach((attempt, index) => {const key = find(index), members = clusters.get(key) ?? []; members.push(attempt); clusters.set(key, members);});
  const attemptIndexes = new Map(result.attempts.map((attempt, index) => [attempt.id, index]));
  const evidenceByCluster = new Map();
  for (const edge of edges) {
    const key = find(attemptIndexes.get(edge.attemptIds[0])), evidence = evidenceByCluster.get(key) ?? [];
    evidence.push(edge);
    evidenceByCluster.set(key, evidence);
  }
  for (const [cluster, members] of clusters) {
    if (members.length < 2) continue;
    const evidence = evidenceByCluster.get(cluster);
    const strongest = [...evidence].sort((a, b) => b.similarity - a.similarity || b.exactPrefixWords - a.exactPrefixWords)[0];
    let sharedPrefix = comparisonPrefix(attemptTokens[attemptIndexes.get(members[0].id)]).tokens;
    for (const member of members.slice(1)) {
      const prefix = comparisonPrefix(attemptTokens[attemptIndexes.get(member.id)]).tokens;
      sharedPrefix = sharedPrefix.slice(0, commonPrefix(sharedPrefix, prefix));
    }
    result.groups.push({id: `retakes-${result.groups.length + 1}`, kind: 'possible_retakes',
      attemptIds: members.map((attempt) => attempt.id), sharedText: sharedPrefix.join(' ') || strongest.sharedBigrams.join(' / '),
      similarity: Number((evidence.reduce((sum, edge) => sum + edge.similarity, 0) / evidence.length).toFixed(3)),
      evidence: {provenance: 'normalized_source_transcript_overlap', similarityBasis: 'mean_of_supported_pairwise_matches',
        confidence: evidence.every((edge) => edge.confidence === 'high_textual_overlap') ? 'high_textual_overlap' : 'moderate_textual_overlap',
        comparisons: evidence, retakeWindowSeconds,
        interpretation: 'Possible alternative passages based on text only. No take quality or deletion decision is inferred.'}});
  }
  result.analysis = {pauseSeconds, minRepeatWords, retakeWindowSeconds, comparisons, maxComparisons,
    maxCandidatesPerAttempt, comparisonLimitReached: limited, prefixComparisonTokens: 32};
  if (limited) result.limitations.push('The comparison budget was reached. Some later possible retakes may not be grouped.');
  return result;
}
