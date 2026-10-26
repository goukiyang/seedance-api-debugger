import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateUploadDirectory, uploadFileHash, uploadFileVersion, VerifiedUploadError, type VerifiedUpload } from '@/lib/assets/verified-upload';

const PREFIX = 'api-private://';
const KEY = /^(uploads|videos)\/[a-f0-9]{64}\/[a-f0-9]{64}\.(png|jpg|webp|gif|bmp|mp4|mov|webm|mp3|wav|ogg)$/;

export async function apiMediaRoot() {
  const parent = await privateUploadDirectory();
  const root = path.join(parent, 'api-clients');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || await fs.realpath(root) !== root) throw new Error('Private API media unavailable');
  return root;
}

export async function privateMediaPath(url: string, ownerHash?: string) {
  if (!url.startsWith(PREFIX)) return null;
  const key = url.slice(PREFIX.length);
  if (!KEY.test(key) || ownerHash && key.split('/')[1] !== ownerHash) throw new Error('Invalid private media reference');
  const root = await apiMediaRoot();
  const file = path.join(root, key);
  const real = await fs.realpath(file).catch(() => null);
  if (!real || real !== file || !real.startsWith(root + path.sep)) return null;
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('Invalid private media file');
  return file;
}

export async function publishPrivateMedia(proof: VerifiedUpload, ownerHash: string, kind: 'uploads' | 'videos' = 'uploads') {
  const key = `${kind}/${ownerHash}/${proof.hash}.${proof.extension}`;
  if (!KEY.test(key) || await uploadFileVersion(proof.file) !== proof.version) throw new VerifiedUploadError('UPLOAD_SOURCE_CHANGED', '上传源已变化。');
  const root = await apiMediaRoot();
  const directory = path.join(root, kind, ownerHash);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  for (const entry of [path.join(root, kind), directory]) {
    const stat = await fs.lstat(entry);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || await fs.realpath(entry) !== entry) throw new Error('Invalid private media directory');
  }
  const file = path.join(root, key), temporary = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    await fs.copyFile(proof.file, temporary, 1); await fs.chmod(temporary, 0o600);
    const handle = await fs.open(temporary, 'r'); try { await handle.sync(); } finally { await handle.close(); }
    try { await fs.link(temporary, file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size !== proof.bytes || await uploadFileHash(file) !== proof.hash) throw new Error('Private media integrity mismatch');
    const dir = await fs.open(directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
    return { url: `${PREFIX}${key}`, file, version: await uploadFileVersion(file) };
  } finally { await fs.unlink(temporary).catch(() => {}); }
}
