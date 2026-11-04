import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replayWorkRecommendation, type RecommendationStep } from '../src/lib/works/recommendation-score';

function change(id: string, order: number, changes: RecommendationStep['changes']): RecommendationStep {
  return { id, order, changes };
}

const input = change('input', 1, { input: { purpose: 'shot', chain: 'cut', signal: 'input' } });
const download = change('take', 2, { take: { purpose: 'shot', chain: 'cut', signal: 'take' } });
const retained = change('retained', 3, { retained: { purpose: 'shot', chain: 'cut', signal: 'retained' } });
const alternate = change('alternate', 4, { alternate: { purpose: 'cover', chain: 'cover', signal: 'input' } });
const replacement = change('swap', 5, {
  swap: { purpose: 'shot', chain: 'same-replacement', signal: 'replaced' },
  version: { purpose: 'shot', chain: 'same-replacement', signal: 'superseded' },
});
const restored = change('restore', 6, { swap: null, version: null });

test('uses the strongest signal in a chain and sums independently proven purposes', () => {
  assert.equal(replayWorkRecommendation([input, download]).score, 8);
  assert.equal(replayWorkRecommendation([input, download, retained]).score, 12);
  assert.equal(replayWorkRecommendation([input, alternate]).score, 16);
});

test('deduplicates replacement, reverses it and floors each purpose at zero', () => {
  assert.equal(replayWorkRecommendation([replacement, alternate]).score, 8);
  assert.equal(replayWorkRecommendation([input, retained, alternate, replacement]).score, 14);
  assert.equal(replayWorkRecommendation([input, retained, alternate, replacement, restored]).score, 20);
});

test('replays the transition history in effective order and resets the entry gate without it', () => {
  const versionOnly = change('version-only', 4, { version: { purpose: 'shot', chain: 'swap', signal: 'superseded' } });
  const steps = [versionOnly, input, retained, download, retained];
  assert.deepEqual(replayWorkRecommendation(steps, 1), { rule: 1, score: 8, qualified: true });
  assert.equal(replayWorkRecommendation(steps).qualified, false);
  assert.equal(replayWorkRecommendation(steps, 9).qualified, false);
  assert.equal(replayWorkRecommendation([input, retained, replacement], 1).qualified, false);
  assert.equal(replayWorkRecommendation([input, retained, replacement, restored], 1).qualified, true);
  assert.equal(replayWorkRecommendation([input, versionOnly], 1).qualified, false);
});

test('caps comparative revisits and fails closed on conflicting replay ids', () => {
  const revisits = Array.from({ length: 5 }, (_, i) => change('review-' + i, i, {
    ['review-' + i]: { purpose: 'shot', chain: 'comparison-' + i, signal: 'revisit' },
  }));
  assert.equal(replayWorkRecommendation(revisits).score, 3);
  assert.throws(() => replayWorkRecommendation([input, { ...input, order: 42 }]), /Conflicting/);
  assert.throws(() => replayWorkRecommendation([input, { ...download, order: input.order }]), /Ambiguous/);
});
