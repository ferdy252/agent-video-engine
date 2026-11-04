import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeTakes} from '../src/take-index.mjs';

function transcript(passages, {gap = 0.15, step = 0.2} = {}) {
  let time = 0;
  const words = [];
  for (const passage of passages) {
    for (const text of passage.split(' ')) {words.push({id: `w${words.length}`, text, start: time, end: time + step * 0.8}); time += step;}
    time += gap;
  }
  return {assetId: 'camera', language: 'en', words};
}

test('three repeated introductions split without punctuation or a long pause', () => {
  const input = transcript(['Here is how you save time', 'Here is how you save time', 'Here is how you save time']);
  const before = structuredClone(input);
  const result = analyzeTakes(input, {duration: 10});
  assert.equal(result.status, 'available');
  assert.equal(result.attempts.length, 3);
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0].attemptIds, ['take-1', 'take-7', 'take-13']);
  assert.equal(result.attempts[1].reason, 'repeated_phrase_restart');
  assert.equal(result.groups[0].kind, 'possible_retakes');
  assert.equal(result.groups[0].evidence.confidence, 'high_textual_overlap');
  assert.deepEqual(result.attempts.flatMap((attempt) => attempt.wordIds), input.words.map((word) => word.id));
  assert.deepEqual(input, before);
});

test('partial first attempt is kept and grouped with its completed restart', () => {
  const input = transcript(['Let me show you', 'Let me show you how this setting works']);
  const result = analyzeTakes(input);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].similarity, 1);
  assert.equal(result.attempts[0].text, 'Let me show you');
  assert.equal(result.attempts[1].end, input.words.at(-1).end);
});

test('a leading hesitation can precede a restart without losing its source words', () => {
  const input = transcript(['Um here is how you save time', 'Here is how you save time']);
  const before = structuredClone(input);
  const result = analyzeTakes(input);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.groups.length, 1);
  assert.equal(result.attempts[0].text, 'Um here is how you save time');
  assert.equal(result.attempts[0].wordIds[0], input.words[0].id);
  assert.deepEqual(result.groups[0].evidence.comparisons[0].ignoredLeadingTokens, {left: ['um'], right: []});
  assert.equal(result.groups[0].sharedText, 'here is how you save time');
  assert.deepEqual(input, before);
});

test('nearby reworded openings group conservatively while an unrelated section stays separate', () => {
  const input = transcript([
    'Today we are going to show you how to save time.',
    'Today we’re going to show you how you can save time.',
    'The battery lasts several hours on a single charge.',
  ], {gap: 1.4});
  const result = analyzeTakes(input);
  assert.equal(result.attempts.length, 3);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].attemptIds.length, 2);
  assert.ok(!result.groups[0].attemptIds.includes(result.attempts[2].id));
  assert.equal(result.attempts[2].text, 'The battery lasts several hours on a single charge.');
});

test('two distinct repeated passages form separate alternative groups', () => {
  const input = transcript([
    'Here is how you save time.', 'Here is how you save time.', 'Here is how you save time.',
    'Change the setting before sharing screenshots.', 'Change the setting before sharing screenshots.', 'Change the setting before sharing screenshots.',
    'The battery lasts several hours on a charge.',
  ], {gap: 1.3, step: 0.075});
  const result = analyzeTakes(input, {duration: 20});
  assert.equal(result.attempts.length, 7);
  assert.deepEqual(result.groups.map((group) => group.attemptIds.length), [3, 3]);
  assert.ok(result.groups.every((group) => !group.attemptIds.includes(result.attempts[6].id)));
});

test('a clean passage and natural two-word repetition do not become alternative takes', () => {
  const clean = analyzeTakes(transcript(['This setting keeps the screen awake during a presentation.']));
  assert.equal(clean.attempts.length, 1);
  assert.deepEqual(clean.groups, []);
  const repeated = analyzeTakes(transcript(['Thank you thank you thank you thank you thank you']));
  assert.equal(repeated.attempts.length, 1);
  assert.deepEqual(repeated.groups, []);
});

test('distant repeated boilerplate does not link unrelated sections across the time window', () => {
  const input = transcript(['Here is how you save time.', 'Here is how you save time.'], {gap: 150});
  assert.equal(analyzeTakes(input).attempts.length, 2);
  assert.deepEqual(analyzeTakes(input).groups, []);
});

test('Unicode punctuation, case and multiword ASR entries preserve original word timing', () => {
  const input = {words: [
    {id: 'a', text: 'ＨＥＲＥ is', start: 0, end: 0.4},
    {id: 'b', text: 'how you', start: 0.3, end: 0.8},
    {id: 'c', text: 'save time！', start: 0.8, end: 0.8},
    {id: 'd', text: 'Here is', start: 1, end: 1.4},
    {id: 'e', text: 'how you', start: 1.4, end: 1.8},
    {id: 'f', text: 'save time.', start: 1.8, end: 2.1},
  ]};
  const result = analyzeTakes(input, {duration: 2.1});
  assert.equal(result.attempts.length, 2);
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.attempts[0].wordIds, ['a', 'b', 'c']);
  assert.equal(result.attempts[0].start, 0);
  assert.equal(result.attempts[0].end, 0.8);
  assert.equal(result.attempts[1].end, 2.1);
});

test('missing or empty transcripts permit a visual-only map, malformed words fail explicitly', () => {
  assert.equal(analyzeTakes(undefined).status, 'missing');
  assert.equal(analyzeTakes({words: []}).status, 'empty');
  const input = transcript(['Here is how this works']);
  input.words[1].id = input.words[0].id;
  assert.throws(() => analyzeTakes(input), {code: 'INVALID_TAKE_INDEX_INPUT'});
  assert.throws(() => analyzeTakes({words: [{id: 'a', text: 'bad', start: 2, end: 1}]}), {code: 'INVALID_TAKE_INDEX_INPUT'});
});

test('long repeated transcripts respect a comparison budget and report incomplete grouping', () => {
  const input = transcript(Array.from({length: 300}, () => 'Here is how you save time.'), {gap: 0.05, step: 0.05});
  const result = analyzeTakes(input, {maxComparisons: 12});
  assert.equal(result.attempts.length, 300);
  assert.ok(result.analysis.comparisons <= 12);
  assert.equal(result.analysis.comparisonLimitReached, true);
  assert.match(result.limitations.at(-1), /comparison budget/);
});
