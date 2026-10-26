import assert from 'node:assert/strict';
import {
  CanvasPromptReferenceError,
  compileCanvasPromptReferences,
  parseCanvasPromptMentions,
  type CanvasPromptMentions,
  type CanvasPromptReferenceErrorCode,
} from '../src/lib/canvas-prompt-references';

function mentions(...entries: Array<[string, string]>): CanvasPromptMentions {
  return {
    version: 1,
    items: entries.map(([token, referenceImageId]) => ({ token, referenceImageId })),
  };
}

function assertCode(action: () => unknown, expectedCode: CanvasPromptReferenceErrorCode) {
  assert.throws(action, (error: unknown) => (
    error instanceof CanvasPromptReferenceError && error.code === expectedCode
  ));
}

function test(name: string, run: () => void) {
  run();
  process.stdout.write(`PASS ${name}\n`);
}

test('legacy handwritten image numbers remain byte-for-byte unchanged', () => {
  const prompt = '保留图1的旧语义，@图10也只是原文。';
  const legacy = compileCanvasPromptReferences({ prompt, referenceImageIds: ['image-a'] });
  assert.equal(legacy.bound, false);
  assert.equal(legacy.prompt, prompt);
  assert.deepEqual(legacy.mapping, {});

  const staleBinding = compileCanvasPromptReferences({
    prompt: '继续使用图1。',
    promptMentions: mentions(['@图8', 'removed-image']),
    referenceImageIds: ['image-a'],
  });
  assert.equal(staleBinding.bound, false);
  assert.equal(staleBinding.prompt, '继续使用图1。');
  assert.deepEqual(staleBinding.mapping, {});
});

test('stable bindings follow the final original-image ID order', () => {
  const result = compileCanvasPromptReferences({
    prompt: '@图1作为主图，@图2作为风格。',
    promptMentions: mentions(['@图1', 'image-b'], ['@图2', 'image-a']),
    referenceImageIds: ['image-a', 'image-b'],
  });
  assert.equal(result.bound, true);
  assert.equal(result.prompt, '图2作为主图，图1作为风格。');
  assert.deepEqual(result.referenceImageIds, ['image-a', 'image-b']);
  assert.deepEqual(result.mapping, { 图1: 'image-a', 图2: 'image-b' });
});

test('repeated mentions compile consistently without prefix-matching @图1 and @图10', () => {
  const result = compileCanvasPromptReferences({
    prompt: '@图1、@图1；最后使用@图10。',
    promptMentions: mentions(['@图1', 'image-b'], ['@图10', 'image-a']),
    referenceImageIds: ['image-a', 'image-b'],
  });
  assert.equal(result.prompt, '图2、图2；最后使用图1。');

  assertCode(() => compileCanvasPromptReferences({
    prompt: '@图10',
    promptMentions: mentions(['@图1', 'image-a']),
    referenceImageIds: ['image-a'],
  }), 'UNMAPPED_PROMPT_MENTION');
});

test('a removed or unselected bound image is rejected instead of falling back by position', () => {
  assertCode(() => compileCanvasPromptReferences({
    prompt: '@图3',
    promptMentions: mentions(['@图3', 'removed-image']),
    referenceImageIds: ['replacement-image'],
  }), 'BOUND_REFERENCE_IMAGE_MISSING');
});

test('malformed versions, duplicate tokens, invalid IDs, unmapped markers, and duplicate final IDs reject', () => {
  assert.equal(parseCanvasPromptMentions(null), undefined);
  assertCode(() => parseCanvasPromptMentions({ version: 2, items: [] }), 'UNSUPPORTED_PROMPT_MENTIONS_VERSION');
  assertCode(() => parseCanvasPromptMentions(mentions(['@图1', 'image-a'], ['@图1', 'image-b'])), 'DUPLICATE_PROMPT_MENTION_TOKEN');
  assertCode(() => parseCanvasPromptMentions(mentions(['@图01', 'image-a'])), 'INVALID_PROMPT_MENTIONS');
  assertCode(() => parseCanvasPromptMentions(mentions(['@图1', 'https://example.invalid/image.png'])), 'INVALID_REFERENCE_IMAGE_ID');
  assertCode(() => compileCanvasPromptReferences({
    prompt: '@图1',
    promptMentions: mentions(['@图2', 'image-a']),
    referenceImageIds: ['image-a'],
  }), 'UNMAPPED_PROMPT_MENTION');
  assertCode(() => compileCanvasPromptReferences({
    prompt: '@图1',
    promptMentions: mentions(['@图1', 'image-a']),
    referenceImageIds: ['image-a', 'image-a'],
  }), 'DUPLICATE_REFERENCE_IMAGE_ID');
});

test('bound mentions mixed with legacy bare image numbers reject as ambiguous', () => {
  for (const prompt of ['@图1参考图2', '@图1参考图片2', '@图1参考图 2']) assertCode(() => compileCanvasPromptReferences({
    prompt,
    promptMentions: mentions(['@图1', 'image-a']),
    referenceImageIds: ['image-a'],
  }), 'AMBIGUOUS_LEGACY_IMAGE_MENTION');
});

test('fingerprints are stable for canonical inputs and change with prompt, binding, or ID order', () => {
  const base = {
    prompt: '@图1和@图2',
    promptMentions: mentions(['@图2', 'image-b'], ['@图1', 'image-a']),
    referenceImageIds: ['image-a', 'image-b'],
  };
  const fingerprint = compileCanvasPromptReferences(base).fingerprint;
  assert.equal(compileCanvasPromptReferences(base).fingerprint, fingerprint);
  assert.equal(compileCanvasPromptReferences({
    ...base,
    promptMentions: mentions(['@图1', 'image-a'], ['@图2', 'image-b']),
  }).fingerprint, fingerprint);
  assert.notEqual(compileCanvasPromptReferences({
    ...base,
    promptMentions: mentions(['@图1', 'image-b'], ['@图2', 'image-a']),
  }).fingerprint, fingerprint);
  assert.notEqual(compileCanvasPromptReferences({
    ...base,
    referenceImageIds: ['image-b', 'image-a'],
  }).fingerprint, fingerprint);
  assert.notEqual(compileCanvasPromptReferences({ ...base, prompt: '@图1' }).fingerprint, fingerprint);
});

test('inputs are not mutated and changed request identity cannot reuse the prior fingerprint', () => {
  const promptMentions = Object.freeze({
    version: 1 as const,
    items: Object.freeze([
      Object.freeze({ token: '@图1', referenceImageId: 'image-a' }),
    ]),
  });
  const referenceImageIds = Object.freeze(['image-a', 'image-b']);
  const input = Object.freeze({ prompt: '使用@图1。', promptMentions, referenceImageIds });
  const before = JSON.stringify(input);
  const first = compileCanvasPromptReferences(input);
  const retry = compileCanvasPromptReferences(input);
  const reordered = compileCanvasPromptReferences({
    ...input,
    referenceImageIds: ['image-b', 'image-a'],
  });

  assert.equal(first.fingerprint, retry.fingerprint);
  assert.notEqual(first.fingerprint, reordered.fingerprint);
  assert.equal(JSON.stringify(input), before);
  assert.notStrictEqual(first.referenceImageIds, referenceImageIds);
});

process.stdout.write('CAN37 prompt reference offline smoke cases: 8\n');
