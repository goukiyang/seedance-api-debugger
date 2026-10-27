import path from 'node:path';
import fs from 'node:fs/promises';
import { siteUploadPathFromUrl, siteUploadBaseUrls } from '@/lib/assets/site-url';
import { hdDirectory } from './hd-storage-root';

export type MediaRoot = 'uploads' | 'videos' | 'display' | 'hd' | 'supplier' | 'delivery';
export type MediaLocation = { root: MediaRoot; relative: string };

export function mediaDataRoot() {
  const configured = process.env.MEDIA_DATA_ROOT;
  const root = configured || (process.env.NODE_ENV === 'production' ? '/data/video-api-debugger/var-lib' : path.join(process.cwd(), '.media'));
  if (!path.isAbsolute(root) || path.normalize(root) !== root || root === path.parse(root).root
    || root === path.join(process.cwd(), 'public') || root.startsWith(path.join(process.cwd(), 'public') + path.sep)
    || process.env.NODE_ENV === 'production' && root !== '/data/video-api-debugger/var-lib') throw new Error('media_storage_root_invalid');
  return root;
}

export function mediaRoot(root: MediaRoot): string {
  const base = mediaDataRoot();
  return root === 'uploads' ? path.join(base, 'uploads') : root === 'videos' ? path.join(base, 'videos')
    : root === 'display' ? path.join(base, 'storage', 'studio-thumbnails') : root === 'hd' ? hdDirectory()
      : root === 'delivery' ? path.join(base, 'storage', 'media-outlet') : path.join(base, 'storage', 'supplier-media');
}

export function safeMediaRelative(relative: string) {
  return relative.length > 0 && relative.length <= 1000 && relative.split('/').every(part => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== '.' && part !== '..');
}

export function mediaFilePath(location: MediaLocation): string {
  if (!safeMediaRelative(location.relative)) throw new Error('media_path_invalid');
  return path.join(mediaRoot(location.root), location.relative);
}

export function localMediaLocation(source: string): MediaLocation | null {
  let pathname = siteUploadPathFromUrl(source);
  if (!pathname) {
    if (source.startsWith('/videos/')) pathname = source.split(/[?#]/)[0];
    else {
      try { const url = new URL(source); if (siteUploadBaseUrls().includes(url.origin) && url.pathname.startsWith('/videos/')) pathname = url.pathname; } catch {}
    }
  }
  if (!pathname) return null;
  const root = pathname.startsWith('/uploads/') ? 'uploads' : 'videos';
  const relative = pathname.slice(root === 'uploads' ? '/uploads/'.length : '/videos/'.length);
  if (!safeMediaRelative(relative)) throw new Error('media_path_invalid');
  return { root, relative };
}

export function localMediaPath(source: string): string {
  const location = localMediaLocation(source);
  if (!location) throw new Error('media_not_local');
  return mediaFilePath(location);
}

export function mediaFileLocation(file: string): MediaLocation {
  for (const root of ['uploads', 'videos', 'display', 'hd', 'supplier', 'delivery'] as const) {
    const directory = mediaRoot(root);
    if (file.startsWith(directory + path.sep)) {
      const relative = path.relative(directory, file).split(path.sep).join('/');
      if (safeMediaRelative(relative)) return { root, relative };
    }
  }
  throw new Error('media_file_outside_roots');
}

// Nginx also disables symlinks. No release/static-tree fallback is permitted.
export async function checkedMediaFile(location: MediaLocation) {
  const file = mediaFilePath(location), root = mediaRoot(location.root);
  if (await fs.realpath(root) !== root || await fs.realpath(file) !== file) throw new Error('media_symlink_rejected');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new Error('media_file_unavailable');
  return { file, stat, version: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` };
}

export function mediaInternalUri(location: MediaLocation) {
  mediaFilePath(location);
  return `/_protected_media/${location.root}/${location.relative.split('/').map(encodeURIComponent).join('/')}`;
}
