import fs from 'node:fs/promises';
import path from 'node:path';

export const WORK_PREVIEW_MAX_BYTES = 128 * 1024 ** 2;
export const workPreviewRootPath = () => process.env.NODE_ENV === 'production' ? '/data/video-api-debugger/var-lib/storage/works-previews' : path.join(process.cwd(), '.cache/works-previews');

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
