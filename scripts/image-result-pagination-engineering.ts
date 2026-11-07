import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gridPageCapacity } from '../src/components/useResultPages';

const originalStyle = globalThis.getComputedStyle;
try {
  for (const [columns, expected] of [[1, 12], [4, 12], [5, 15], [8, 24], [9, 27], [10, 30], [12, 36]]) {
    globalThis.getComputedStyle = () => ({ gridTemplateColumns: Array(columns).fill('220px').join(' ') }) as CSSStyleDeclaration;
    assert.equal(gridPageCapacity({} as HTMLElement, true), expected, `${columns} columns retain complete template rows`);
    assert.ok(gridPageCapacity({} as HTMLElement) <= 24, 'other existing pagers retain their original bound');
  }
} finally { globalThis.getComputedStyle = originalStyle; }

const results = readFileSync('src/components/GeneratedImageResults.tsx', 'utf8');
const studio = readFileSync('src/app/image-studio/studio.tsx', 'utf8');
const assets = readFileSync('src/app/assets/page.tsx', 'utf8');

assert.match(results, /latestPageRequest[\s\S]*pages\.reset\(\)/,
  'a confirmed generation request must replace the restored result page with the newest page');
assert.match(results, /\{pagination\('bottom'\)\}/,
  'the shared result pager must also render below the grid');
assert.equal((results.match(/const pagination =/g) || []).length, 1,
  'the result list must keep one shared pager implementation for both placements');
assert.equal(results.includes("paginationSlot === undefined && pagination('bottom')"), false,
  'using the header pager must not hide the bottom pager');
assert.match(studio, /showLatestResults\.current\(payload\.requestId\)/,
  'single-image generation admission must navigate to newest results');
assert.match(studio, /showLatestResults\.current\(batchPayload\.requestId\)/,
  'batch generation admission must navigate to newest results');
assert.match(studio, /const requestId = String\(pendingSubmission\.requestId\), scope = taskReadScope;[\s\S]*?showLatestResults\.current\(requestId\)/,
  'a confirmed original submission must navigate without resubmitting');
assert.match(studio, /likedResults\.choose\(false\)[\s\S]*setLatestResultsRequestId\(requestId\)/,
  'new generation results must leave the liked-only view before resetting paging');
assert.equal(results.includes('ImageBillingBadge'), false, 'generated cards must not show the reconciliation badge');
assert.equal(assets.includes('ImageBillingBadge'), false, 'asset cards must not show the reconciliation badge');

console.log('PASS latest-result navigation, shared bottom pager, and reconciliation-badge removal contracts; no generation or billing calls.');
