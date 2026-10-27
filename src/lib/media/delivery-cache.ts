import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkedMediaFile, mediaRoot, type MediaLocation } from './storage-roots';

const pending = new Map<string, Promise<MediaLocation>>();

// A separate nginx-readable directory keeps HD manifests, originals and their
// private permissions untouched. Only already-authorized exact bytes enter it.
export async function mediaDeliveryFile(source: MediaLocation, expectedVersion?: string): Promise<MediaLocation> {
  if (source.root === 'delivery') return source;
  const original = await checkedMediaFile(source);
  if (expectedVersion && original.version !== expectedVersion) throw Object.assign(new Error('media_source_changed'), { status: 409 });
  const key = createHash('sha256').update(JSON.stringify([source, original.version])).digest('hex');
  const location: MediaLocation = { root: 'delivery', relative: `${key}.bin` };
  const current = async () => {
    const saved = await checkedMediaFile(location);
    if (saved.stat.size !== original.stat.size || saved.stat.mode & 0o007) throw new Error('media_delivery_invalid');
    return location;
  };
  try { return await current(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const existing = pending.get(key);
  if (existing) return existing;
  if (pending.size >= 4) throw Object.assign(new Error('media_delivery_busy'), { status: 503 });
  const job = (async () => {
    const directory = mediaRoot('delivery');
    if (process.env.NODE_ENV !== 'production') await fs.mkdir(directory, { recursive: true, mode: 0o750 });
    const dir = await fs.lstat(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || await fs.realpath(directory) !== directory
      || dir.uid !== process.getuid?.() || dir.mode & 0o027) throw new Error('media_delivery_permissions');
    if (process.env.NODE_ENV === 'production' && (!/^\d+$/.test(process.env.MEDIA_DELIVERY_GROUP_ID || '')
      || dir.gid !== Number(process.env.MEDIA_DELIVERY_GROUP_ID) || !(dir.mode & 0o2000))) throw new Error('media_delivery_group');
    const temporary = path.join(directory, `.${key}.${randomUUID()}.tmp`);
    try {
      await fs.copyFile(original.file, temporary, 1);
      await fs.chmod(temporary, 0o640);
      const handle = await fs.open(temporary, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
      if ((await checkedMediaFile(source)).version !== original.version) throw Object.assign(new Error('media_source_changed'), { status: 409 });
      await fs.link(temporary, path.join(directory, location.relative)).catch(error => { if (error.code !== 'EEXIST') throw error; });
      return await current();
    } finally { await fs.unlink(temporary).catch(() => {}); }
  })();
  pending.set(key, job);
  try { return await job; } finally { pending.delete(key); }
}
