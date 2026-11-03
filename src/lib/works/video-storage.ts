import { S3Client, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { TosClient } from '@volcengine/tos-sdk';
import { videoFeishuRemoteLocation } from '@/lib/video/feishu-source';
import { isTaskHiddenFromRegularUsers } from '@/lib/tasks/retention';

export type WorkStoredVideoTask = Parameters<typeof videoFeishuRemoteLocation>[0] & { delivery_completed_at: Date | null };
export type WorkStoredVideoBinding = { videoTaskId: string; sourceUrl: string; sourceUpdatedAt: Date };
export type WorkVideoByteStream = AsyncIterable<Uint8Array> & { destroy?: () => void };
export type WorkStoredVideoOrigin = { size: number; etag: string;
  stream: (range?: { start: number; end: number }) => Promise<WorkVideoByteStream>;
  current: () => Promise<boolean>; close: () => Promise<void> };
const unavailable = () => new Error('WORKS_STORED_VIDEO_UNAVAILABLE');
type Entity = { size: number; etag: string; version: string | undefined };
const sameEntity = (left: Entity, right: Entity) => left.size === right.size && left.etag === right.etag && left.version === right.version;

/** Exact persisted object only. This grants no audience access; callers authorize the current Work first. */
export async function openWorkStoredVideo(task: WorkStoredVideoTask, binding: WorkStoredVideoBinding, signal?: AbortSignal): Promise<WorkStoredVideoOrigin> {
  const stamp = task.public_video_cached_at || task.delivery_completed_at;
  if (task.id !== binding.videoTaskId || task.local_status !== 'succeeded' || isTaskHiddenFromRegularUsers(task)
    || (task.local_video_path || task.public_video_url) !== binding.sourceUrl || stamp?.getTime() !== binding.sourceUpdatedAt.getTime()
    || !task.public_video_cached_at || !Number.isSafeInteger(task.public_video_file_size) || task.public_video_file_size! < 1
    || signal?.aborted) throw unavailable();
  const { provider, key } = videoFeishuRemoteLocation(task);
  let head: () => Promise<Entity>;
  let get: (entity: Entity, range?: { start: number; end: number }) => Promise<WorkVideoByteStream>;
  let dispose: () => void;
  let active: WorkVideoByteStream | null = null, closed = false;
  const cancelled = () => { active?.destroy?.(); dispose(); };
  const requestSignal = (timeout: number) => signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  if (provider === 'r2') {
    const account = process.env.R2_ACCOUNT_ID, accessKeyId = process.env.R2_ACCESS_KEY_ID, secretAccessKey = process.env.R2_SECRET_ACCESS_KEY, bucket = process.env.R2_BUCKET;
    if (!account || !/^[a-f0-9]{32}$/.test(account) || !accessKeyId || !secretAccessKey || !bucket) throw unavailable();
    const client = new S3Client({ region: 'auto', endpoint: `https://${account}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey }, maxAttempts: 1 });
    dispose = () => client.destroy();
    head = async () => {
      const item = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: requestSignal(10_000) });
      return { size: Number(item.ContentLength), etag: item.ETag || '', version: item.VersionId };
    };
    get = async (entity, range) => {
      const item = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, IfMatch: entity.etag, VersionId: entity.version,
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) }), { abortSignal: requestSignal(60_000) });
      const body = item.Body as WorkVideoByteStream | undefined;
      if (!body || item.ETag !== entity.etag || item.VersionId !== entity.version
        || item.ContentLength !== (range ? range.end - range.start + 1 : entity.size)
        || range && item.ContentRange !== `bytes ${range.start}-${range.end}/${entity.size}`) { body?.destroy?.(); throw unavailable(); }
      return body;
    };
  } else {
    const accessKeyId = process.env.TOS_ACCESS_KEY, accessKeySecret = process.env.TOS_SECRET_KEY, bucket = process.env.TOS_BUCKET;
    const endpoint = process.env.TOS_ENDPOINT || 'https://tos-ap-southeast-1.volces.com';
    const endpointUrl = new URL(endpoint.startsWith('https://') ? endpoint : `https://${endpoint}`);
    if (!accessKeyId || !accessKeySecret || !bucket || endpointUrl.protocol !== 'https:' || endpointUrl.username || endpointUrl.password
      || endpointUrl.pathname !== '/' || endpointUrl.search || endpointUrl.hash || !/^tos-[a-z0-9-]+\.volces\.com$/.test(endpointUrl.hostname)) throw unavailable();
    const client = new TosClient({ accessKeyId, accessKeySecret, region: process.env.TOS_REGION || 'ap-southeast-1', endpoint: endpointUrl.host,
      requestTimeout: 60_000, connectionTimeout: 10_000, maxRetryCount: 0 });
    dispose = () => { /* The SDK owns its HTTP connection pool; active streams are closed separately. */ };
    head = async () => {
      const item = await client.headObject({ bucket, key });
      if (item.data['x-tos-object-type'] === 'Symlink' || item.data['x-tos-website-redirect-location']) throw unavailable();
      return { size: Number(item.data['content-length']), etag: item.data.etag || '', version: item.data['x-tos-version-id'] };
    };
    get = async (entity, range) => {
      const item = await client.getObjectV2({ bucket, key, ifMatch: entity.etag, versionId: entity.version, dataType: 'stream',
        ...(range ? { rangeStart: range.start, rangeEnd: range.end } : {}) });
      const body = item.data.content as WorkVideoByteStream;
      if (item.data.etag !== entity.etag || item.headers['x-tos-version-id'] !== entity.version
        || Number(item.headers['content-length']) !== (range ? range.end - range.start + 1 : entity.size)
        || range && item.headers['content-range'] !== `bytes ${range.start}-${range.end}/${entity.size}`) { body.destroy?.(); throw unavailable(); }
      return body;
    };
  }
  signal?.addEventListener('abort', cancelled, { once: true });
  const close = async () => { closed = true; signal?.removeEventListener('abort', cancelled); active?.destroy?.(); dispose(); };
  try {
    const initial = await head();
    if (signal?.aborted || !Number.isSafeInteger(initial.size) || initial.size !== task.public_video_file_size || !initial.etag || initial.etag.length > 256) throw unavailable();
    return { size: initial.size, etag: initial.etag,
      stream: async range => {
        if (closed || signal?.aborted || range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
          || range.start < 0 || range.end < range.start || range.end >= initial.size)) throw unavailable();
        try { active = await get(initial, range); } catch { throw unavailable(); }
        if (closed || signal?.aborted) { active.destroy?.(); throw unavailable(); }
        return active;
      },
      current: async () => { try { return !closed && !signal?.aborted && sameEntity(initial, await head()); } catch { return false; } }, close };
  } catch { await close(); throw unavailable(); }
}
