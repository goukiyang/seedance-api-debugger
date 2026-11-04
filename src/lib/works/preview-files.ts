import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export const WORK_PREVIEW_MAX_BYTES = 128 * 1024 ** 2;
export const workPreviewRootPath = () => process.env.NODE_ENV === 'production' ? '/data/video-api-debugger/var-lib/storage/works-previews' : path.join(process.cwd(), '.cache/works-previews');

/** Resolve a pre-existing task poster only for a current, local video version. */
export async function resolveExistingWorkVideoPoster(taskId: string, sourceUrl: string, sourceUpdatedAt: Date) {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(taskId) || !sourceUrl.startsWith('/videos/')) return null;
  try {
    const root = await fs.realpath(path.join(process.cwd(), 'public/videos'));
    const source = await fs.realpath(path.resolve(root, sourceUrl.slice('/videos/'.length)));
    if (!source.startsWith(root + path.sep)) return null;
    const video = await fs.lstat(source);
    const poster = path.join(root, 'thumbnails', taskId + '.jpg');
    if (!video.isFile() || !video.size || await fs.realpath(poster) !== poster) return null;
    const entry = await fs.lstat(poster);
    if (!entry.isFile() || entry.nlink !== 1 || entry.size < 4 || entry.size > 8 * 1024 ** 2 ||
      entry.mtimeMs < Math.max(video.mtimeMs, sourceUpdatedAt.getTime())) return null;
    const file = await fs.open(poster, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const header = Buffer.alloc(2), opened = await file.stat();
      if (opened.ino !== entry.ino || opened.dev !== entry.dev || opened.size !== entry.size ||
        (await file.read(header, 0, 2, 0)).bytesRead !== 2 || header[0] !== 255 || header[1] !== 216) return null;
    } finally { await file.close(); }
    return poster;
  } catch { return null; }
}

/** Only private version-bound preview/poster references are eligible; callers still enforce current source authorization. */
export async function resolveWorkPreviewFile(reference: string): Promise<string | null> {
  const root = workPreviewRootPath(), relative = path.relative(root, reference);
  if (!/^[a-zA-Z0-9_-]{1,100}\/(?:preview\.mp4|poster\.jpg|poster\.webp)$/.test(relative) || path.resolve(root, relative) !== reference) return null;
  const actual = await fs.realpath(reference).catch(() => null);
  if (actual !== reference || await fs.realpath(root).catch(() => null) !== root) return null;
  const entry = await fs.lstat(reference);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.mode & 0o077 || entry.size < 1 || entry.size > WORK_PREVIEW_MAX_BYTES) return null;
  return reference;
}
