import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  orderRecentTaskCards,
  recentTaskHasVisualPreview,
  recentTaskVisualRank,
  type RecentTaskCardOrderItem,
} from '../src/lib/video/recent-task-card-order';

const tasks: RecentTaskCardOrderItem[] = [
  {
    id: 'h3-failed-newest',
    created_at: '2026-08-16T10:00:00.000Z',
    local_status: 'failed',
  },
  {
    id: 'h3-running',
    created_at: '2026-08-16T09:59:00.000Z',
    local_status: 'running',
  },
  {
    id: 'seedance-with-thumbnail',
    created_at: '2026-08-16T09:40:00.000Z',
    local_status: 'succeeded',
    thumbnail_url: '/api/video/tasks/seedance-with-thumbnail/thumbnail',
  },
  {
    id: 'seedance-with-public-video',
    created_at: '2026-08-16T09:50:00.000Z',
    local_status: 'succeeded',
    public_video_url: '/api/video/tasks/seedance-with-public-video/download',
  },
  {
    id: 'succeeded-preview-pending',
    created_at: '2026-08-16T09:58:00.000Z',
    local_status: 'succeeded',
    preview_available: true,
  },
];

const ordered = orderRecentTaskCards(tasks);

assert.equal(recentTaskHasVisualPreview(tasks[0]), false);
assert.equal(recentTaskHasVisualPreview(tasks[2]), true);
assert.equal(recentTaskVisualRank(tasks[0]), 3);
assert.equal(recentTaskVisualRank(tasks[1]), 2);
assert.equal(recentTaskVisualRank(tasks[2]), 0);
assert.deepEqual(
  ordered.map((task) => task.id),
  [
    'seedance-with-public-video',
    'seedance-with-thumbnail',
    'succeeded-preview-pending',
    'h3-running',
    'h3-failed-newest',
  ],
);

const firstPageWithoutVisuals: RecentTaskCardOrderItem[] = Array.from({ length: 12 }, (_, index) => ({
  id: `h3-no-visual-${index + 1}`,
  created_at: `2026-08-16T10:${String(59 - index).padStart(2, '0')}:00.000Z`,
  local_status: index % 2 === 0 ? 'failed' : 'submitted',
}));
const secondPageWithVisuals: RecentTaskCardOrderItem[] = [
  ...Array.from({ length: 7 }, (_, index) => ({
    id: `h3-no-visual-page2-${index + 1}`,
    created_at: `2026-08-16T09:${String(59 - index).padStart(2, '0')}:00.000Z`,
    local_status: 'failed',
  })),
  {
    id: 'older-seedance-with-real-video',
    created_at: '2026-08-16T09:40:00.000Z',
    local_status: 'succeeded',
    public_video_url: '/api/video/tasks/older-seedance-with-real-video/download',
  },
];
const prefetchedOrder = orderRecentTaskCards([
  ...firstPageWithoutVisuals,
  ...secondPageWithVisuals,
]);

assert.equal(recentTaskHasVisualPreview(orderRecentTaskCards(firstPageWithoutVisuals)[0]!), false);
assert.equal(prefetchedOrder[0]?.id, 'older-seedance-with-real-video');

const generatePageSource = readFileSync('src/components/generate/GeneratePageClient.tsx', 'utf8');
assert.match(generatePageSource, /RECENT_TASK_INITIAL_PREFETCH_MAX_PAGES\s*=\s*4/);
assert.match(generatePageSource, /visualCount\s*<\s*RECENT_TASK_INITIAL_MIN_VISUALS/);
assert.match(generatePageSource, /pagination\.page\s*<\s*pagination\.total_pages/);

console.log(JSON.stringify({
  ok: true,
  firstVisibleTask: ordered[0]?.id,
  firstPrefetchedVisibleTask: prefetchedOrder[0]?.id,
  orderedTaskIds: ordered.map((task) => task.id),
}, null, 2));
