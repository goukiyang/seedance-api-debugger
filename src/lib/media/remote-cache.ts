import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fetchPublicMedia } from './preview-response';
import { checkedMediaFile, mediaRoot, type MediaLocation } from './storage-roots';

const pending = new Map<string, Promise<MediaLocation>>();

// Caller supplies a stored source only after decideMedia. Reuse the existing
// pinned public-only transport; never accept an arbitrary browser proxy URL.
export async function cachedRemoteMedia(source: string, mime: string): Promise<MediaLocation> {
  const key = createHash('sha256').update(source).digest('hex');
  const location: MediaLocation = { root: 'uploads', relative: `media-cache/${key}.bin` };
  try { await checkedMediaFile(location); return location; } catch {}
  const active = pending.get(key);
  if (active) return active;
  if (pending.size >= 4) throw Object.assign(new Error('media_cache_busy'), { status: 503 });
  const job = (async () => {
    const directory = path.join(mediaRoot('uploads'), 'media-cache');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.${key}.${randomUUID()}.tmp`);
    try {
      const request = new Request('http://media-cache.invalid/internal', { signal: AbortSignal.timeout(600000) });
      const response = await fetchPublicMedia(request, source, mime);
      if (response.status !== 200 || !response.body) throw new Error('media_remote_unavailable');
      await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      const stat = await fs.stat(temporary);
      const length = response.headers.get('content-length');
      if (stat.size <= 0 || length !== null && stat.size !== Number(length)) throw new Error('media_cache_incomplete');
      const destination = path.join(directory, `${key}.bin`);
      await fs.link(temporary, destination).catch(error => { if (error.code !== 'EEXIST') throw error; });
      await checkedMediaFile(location);
      return location;
    } finally { await fs.unlink(temporary).catch(() => {}); }
  })();
  pending.set(key, job);
  try { return await job; } finally { pending.delete(key); }
}
