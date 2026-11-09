import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replayWorkRecommendation, replayCommunityRecommendation, WORK_RECOMMENDATION_RULE, type RecommendationStep } from '../src/lib/works/recommendation-score';

function change(id: string, order: number, changes: RecommendationStep['changes']): RecommendationStep {
  return { id, order, changes };
}

test('community recommendation needs a recent real use by someone other than the author', () => {
  const now = Date.now();
  const fact = (actor: string, signal: 'input' | 'retained' | 'take' | 'replaced', order: number, at = now): RecommendationStep => ({
    id: String(order), order, at, changes: { [String(order)]: { actor, purpose: actor, chain: 'input', signal } },
  });
  assert.equal(replayCommunityRecommendation([fact('author', 'retained', 1), fact('colleague', 'take', 2)], 'author', now).qualified, false);
  const use = fact('colleague', 'input', 3);
  assert.equal(replayCommunityRecommendation([use, fact('colleague', 'retained', 4)], 'author', now).score, 1);
  assert.equal(replayCommunityRecommendation([use, fact('another', 'input', 4)], 'author', now).score, 2);
  assert.equal(replayCommunityRecommendation([use, fact('colleague', 'replaced', 4)], 'author', now).qualified, false);
  assert.equal(replayCommunityRecommendation([fact('colleague', 'input', 1, now - 31 * 86400000)], 'author', now).qualified, false);
  const restored: RecommendationStep = { id: 'restored', order: 5, at: now, changes: { '4': null } };
  assert.equal(replayCommunityRecommendation([use, fact('colleague', 'replaced', 4), restored], 'author', now).score, 1);
});

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
  assert.deepEqual(replayWorkRecommendation(steps, 1), { rule: WORK_RECOMMENDATION_RULE, score: 8, qualified: true });
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

test('unknown purpose overlaps known purposes without double counting or punishing another positive use', () => {
  const unknown = change('unknown', 1, { unknown: { purpose: 'actor:a', chain: 'unknown', signal: 'input', actor: 'a', ambiguous: true } });
  const shot = change('shot', 2, { shot: { purpose: 'canvas:a:shot', chain: 'shot', signal: 'input', actor: 'a' } });
  const cover = change('cover', 3, { cover: { purpose: 'canvas:a:cover', chain: 'cover', signal: 'input', actor: 'a' } });
  assert.equal(replayWorkRecommendation([unknown, shot]).score, 8);
  assert.equal(replayWorkRecommendation([unknown, shot, cover]).score, 16);
  const kept = change('kept', 4, { kept: { purpose: 'actor:a', chain: 'unknown', signal: 'retained', actor: 'a', ambiguous: true } });
  assert.equal(replayWorkRecommendation([unknown, shot, kept]).score, 12);
  assert.equal(replayWorkRecommendation([unknown, shot, cover, kept]).score, 16);
});

test('distinct real projects are independent while a project and its own canvas overlap', () => {
  const projectA = change('project-a', 1, { a: { purpose: 'project:a', chain: 'a', signal: 'input', actor: 'person', ambiguous: true, family: 'a' } });
  const projectB = change('project-b', 2, { b: { purpose: 'project:b', chain: 'b', signal: 'input', actor: 'person', ambiguous: true, family: 'b' } });
  const canvasA = change('canvas-a', 3, { canvas: { purpose: 'canvas:a:node', chain: 'node', signal: 'input', actor: 'person', family: 'a' } });
  assert.equal(replayWorkRecommendation([projectA, canvasA]).score, 8);
  assert.equal(replayWorkRecommendation([projectA, projectB, canvasA]).score, 16);
});
