import assert from 'node:assert/strict';
import { buildGenerationTimings, elapsedSeconds, summarizeTimings, videoTimings } from '../src/lib/admin/generation-timing';

const start = new Date('2026-10-06T00:00:00Z');
const end = (seconds: number) => new Date(start.getTime() + seconds * 1000);
assert.equal(elapsedSeconds(null, end(1)), null);
assert.equal(elapsedSeconds(start, end(-1)), null);
assert.equal(elapsedSeconds(start, end(0.25)), 0.25);
assert.equal(summarizeTimings([]).average_seconds, null);
const summary = summarizeTimings([0, 5, 100, null, NaN, -1]);
assert.equal(summary.sample_count, 3);
assert.equal(summary.missing_count, 3);
assert.equal(summary.median_seconds, 5);
assert.equal(summary.p90_seconds, 100);
const video = { provider: 'seedance', model: 'test-model', generation_mode: 'text_to_video', local_status: 'succeeded',
  created_at: start, completed_at: end(20), public_video_url: 'https://example.test/video.mp4', public_video_cached_at: end(35),
  delivery_status: 'succeeded', delivery_completed_at: end(40) };
assert.deepEqual(videoTimings(video), { completion: 20, ready: 35, delivery: 15 });
assert.equal(videoTimings({ ...video, public_video_url: null }).ready, null);
const result = buildGenerationTimings([video, { ...video, local_status: 'failed' }, { ...video, local_status: 'running' },
  { ...video, local_status: 'succeeded', completed_at: null }], [{ model: 'image-test', status: 'succeeded', created_at: start,
    finished_at: end(60), usage_json: JSON.stringify({ studioDelivery: { returnedAt: end(45).getTime() } }) }], true);
assert.equal(result.summary[0].succeeded_count, 2);
assert.equal(result.summary[0].failed_count, 1);
assert.equal(result.summary[0].unfinished_count, 1);
assert.equal(result.summary[0].metrics.completion.missing_count, 1);
assert.equal(result.summary[2].metrics.delivery.average_seconds, 15);
assert.equal(buildGenerationTimings([], [], false).summary.some(row => row.kind === 'image'), false);
console.log('Generation timing pure-data checks passed; no database or provider requests.');
