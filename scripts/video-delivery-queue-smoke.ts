import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  isVideoDeliveryJobTerminal,
  nextVideoDeliveryRunAfter,
} from '@/lib/video/delivery-queue';

const base = new Date('2026-08-11T10:00:00.000Z');
assert.equal(nextVideoDeliveryRunAfter(0, base).toISOString(), base.toISOString(), 'first delivery attempt should run immediately');
assert.equal(nextVideoDeliveryRunAfter(1, base).toISOString(), '2026-08-11T10:01:00.000Z', 'second attempt should wait 1 minute');
assert.equal(nextVideoDeliveryRunAfter(3, base).toISOString(), '2026-08-11T10:04:00.000Z', 'retry backoff should grow but stay predictable');
assert.equal(isVideoDeliveryJobTerminal('succeeded'), true);
assert.equal(isVideoDeliveryJobTerminal('failed'), true);
assert.equal(isVideoDeliveryJobTerminal('pending'), false);
assert.equal(isVideoDeliveryJobTerminal('running'), false);

const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
assert.match(schema, /model VideoDeliveryJob \{/, 'schema must define the durable video delivery queue table');
assert.match(schema, /task_id\s+String\s+@unique/, 'one task should only have one active delivery job');
assert.match(schema, /delivery_status\s+String\?/, 'VideoTask should expose stable delivery status separately from local_status');

const queueSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/video/delivery-queue.ts'), 'utf8');
assert.match(queueSource, /updateMany/, 'queue claim must use a conditional update to avoid duplicate worker claims');
assert.match(queueSource, /claim\.count !== 1/, 'queue claim must verify that the worker actually claimed the job');
assert.match(queueSource, /locked_by:\s*job\.locked_by/, 'job completion/failure must only update the lock owned by the current worker');
assert.match(queueSource, /status:\s*VIDEO_DELIVERY_STATUS_RUNNING/, 'stale workers must not overwrite a job after it is no longer running');

const publicStorageSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/assets/public-storage.ts'), 'utf8');
assert.match(publicStorageSource, /PUBLIC_VIDEO_STREAM_TIMEOUT_MS/, 'public video stream delivery must have a real timeout');
assert.match(publicStorageSource, /abortSignal/, 'R2 public video upload must be abortable');
assert.match(publicStorageSource, /signal/, 'public video download spooling must abort stalled streams');
assert.match(publicStorageSource, /uploadPublicVideoFile/, 'media ingest should upload the already-downloaded local video file without re-fetching provider media');

const publicDeliverySource = fs.readFileSync(path.join(process.cwd(), 'src/lib/video/public-delivery.ts'), 'utf8');
assert.match(publicDeliverySource, /ingestTaskMediaFromProvider/, 'provider delivery should delegate to the unified media ingest job');

const mediaIngestSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/video/media-ingest.ts'), 'utf8');
assert.match(mediaIngestSource, /cacheTaskVideoToLocal/, 'media ingest should download provider media once into the local video cache');
assert.match(mediaIngestSource, /ffprobe/, 'media ingest should validate local MP4 readability before exposing a stable download URL');
assert.match(mediaIngestSource, /local_mp4_probe_failed/, 'media ingest should fail closed when local MP4 probing fails');
assert.match(mediaIngestSource, /discardInvalidLocalVideo/, 'media ingest should discard a bad local MP4 so retries can re-download it');
assert.match(mediaIngestSource, /unlink\(absolutePath\)/, 'bad local MP4 files should be removed instead of reused forever');
assert.match(mediaIngestSource, /local_video_path:\s*null/, 'bad local MP4 probing should clear the cached local path');
assert.match(mediaIngestSource, /uploadPublicVideoFile/, 'media ingest should upload the same local file to stable public storage');
assert.match(mediaIngestSource, /ensureTaskThumbnail/, 'media ingest should generate thumbnails from the same local file');
assert.match(mediaIngestSource, /allowRemoteFallback:\s*false/, 'media ingest thumbnails should use the already-downloaded local file instead of re-fetching remote media');

const workerScriptSource = fs.readFileSync(path.join(process.cwd(), 'scripts/process-video-delivery-jobs.ts'), 'utf8');
assert.match(workerScriptSource, /once[\s\S]*process\.exit\(0\)/, 'one-shot worker must exit after a batch even if SDK sockets stay open');

const metricsSource = fs.readFileSync(path.join(process.cwd(), 'scripts/video-delivery-metrics.ts'), 'utf8');
assert.match(metricsSource, /provider_to_ingest_start/, 'metrics should expose provider completion to ingest start latency');
assert.match(metricsSource, /ingest_start_to_public/, 'metrics should expose ingest start to stable public URL latency');
assert.match(metricsSource, /submit_to_stable_download/, 'metrics should expose total submit to stable download latency');
assert.match(metricsSource, /metric_notes/, 'metrics should explain latency segments that cannot be measured yet');

console.log('video-delivery-queue smoke passed');
