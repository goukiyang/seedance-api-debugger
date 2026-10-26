import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
assert.match(studio, /showLatestResults\.current\(String\(pendingSubmission\.requestId\)\)/,
  'a confirmed original submission must navigate without resubmitting');
assert.match(studio, /likedResults\.choose\(false\)[\s\S]*setLatestResultsRequestId\(requestId\)/,
  'new generation results must leave the liked-only view before resetting paging');
assert.equal(results.includes('ImageBillingBadge'), false, 'generated cards must not show the reconciliation badge');
assert.equal(assets.includes('ImageBillingBadge'), false, 'asset cards must not show the reconciliation badge');

console.log('PASS latest-result navigation, shared bottom pager, and reconciliation-badge removal contracts; no generation or billing calls.');
