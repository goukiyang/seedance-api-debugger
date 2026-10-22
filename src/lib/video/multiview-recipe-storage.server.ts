// Node filesystem imports make a client build fail, while this module also
// remains importable by the existing raw Node/tsx worker consumers.
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { siteUploadBaseUrls, siteUploadPathFromUrl } from '@/lib/assets/site-url';

export type MultiviewSystemReferenceBinding = { assetId: string; referenceImageId: string; ownerId: string; sha256: string };
type Db = Pick<Prisma.TransactionClient, 'asset' | 'referenceImage' | 'user' | 'platformSetting'>;
type BindingDb = Pick<Prisma.TransactionClient, 'asset' | 'platformSetting'>;
type Reader = { id: string; role: string; account_type?: string; status?: string } | null;
export const MULTIVIEW_PRIVATE_MEDIA_ACCESS_PREFIX = 'multiview_private_media_access_v1:';
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const identity = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,180}$/.test(value);
const unavailable = () => Object.assign(new Error('系统参考图暂时无法确认，主图和原任务已保留；请联系管理员后再生成。'),
  { status: 503, code: 'MULTIVIEW_SYSTEM_REFERENCE_UNAVAILABLE' });

export function parseMultiviewSystemReferenceBinding(value: unknown): MultiviewSystemReferenceBinding | null {
  if (!record(value) || Object.keys(value).some(key => !['assetId', 'referenceImageId', 'ownerId', 'sha256'].includes(key))
    || !identity(value.assetId) || !identity(value.referenceImageId) || !identity(value.ownerId)
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) return null;
  return { assetId: value.assetId, referenceImageId: value.referenceImageId, ownerId: value.ownerId, sha256: value.sha256 };
}

export function multiviewRecipeStorageRoot() {
  return process.env.NODE_ENV === 'production' ? '/data/video-api-debugger/var-lib/storage/multiview-recipes'
    : path.join(process.cwd(), '.cache', 'multiview-recipes');
}

async function privateRoot() {
  const root = multiviewRecipeStorageRoot();
  if (process.env.NODE_ENV === 'production') {
    const [data, system] = await Promise.all([fs.lstat('/data'), fs.stat('/')]);
    if (!data.isDirectory() || data.isSymbolicLink() || data.dev === system.dev || await fs.realpath('/data') !== '/data') throw unavailable();
  }
  let current = path.parse(root).root;
  for (const component of root.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
  }
  const stat = await fs.lstat(root);
  if (await fs.realpath(root) !== root || stat.mode & 0o077) throw unavailable();
  return root;
}

/** Only a binding loaded from an immutable server recipe may call this reader. */
export async function readMultiviewSystemReference(binding: MultiviewSystemReferenceBinding, db: Db = prisma): Promise<{
  assetId: string; referenceImageId: string; sourceUrl: string; mimeType: 'image/png'; bytes: Buffer; sha256: string;
}> {
  const parsed = parseMultiviewSystemReferenceBinding(binding);
  if (!parsed) throw unavailable();
  const [asset, reference, owner] = await Promise.all([
    db.asset.findUnique({ where: { id: parsed.assetId } }),
    db.referenceImage.findUnique({ where: { id: parsed.referenceImageId }, select: { id: true, owner_user_id: true, asset_id: true, status: true } }),
    db.user.findUnique({ where: { id: parsed.ownerId }, select: { status: true } }),
  ]);
  if (!asset || asset.owner_id !== parsed.ownerId || asset.status !== 'active' || asset.type !== 'image'
    || asset.mime_type !== 'image/png' || asset.hash !== null && asset.hash !== parsed.sha256 || !owner || owner.status !== 'active'
    || !reference || reference.status !== 'active' || reference.asset_id !== asset.id || reference.owner_user_id !== parsed.ownerId) throw unavailable();
  const root = await privateRoot().catch(() => { throw unavailable(); });
  const file = path.join(root, `${parsed.sha256}.png`);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw unavailable(); });
  let bytes: Buffer;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.mode & 0o077 || before.size !== asset.file_size
      || before.size < 24 || before.size >= 30_000_000) throw unavailable();
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== before.size || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after])
      || createHash('sha256').update(bytes).digest('hex') !== parsed.sha256
      || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw unavailable();
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height || width * height > 40_000_000 || asset.width !== width || asset.height !== height) throw unavailable();
  } finally { await handle.close(); }
  return { assetId: parsed.assetId, referenceImageId: parsed.referenceImageId, sourceUrl: asset.original_url,
    mimeType: 'image/png', bytes, sha256: parsed.sha256 };
}

/** Immutable versions keep old file aliases protected after an administrator changes the current recipe. */
export async function multiviewSystemReferenceBindings(db: BindingDb = prisma): Promise<MultiviewSystemReferenceBinding[]> {
  const rows = await db.platformSetting.findMany({ where: { OR: [
    { key: 'multiview_rotation_preset_v1:current' }, { key: { startsWith: 'multiview_rotation_preset_v1:version:' } },
  ] }, select: { value_json: true } });
  const found = new Map<string, MultiviewSystemReferenceBinding>();
  for (const row of rows) {
    let state: unknown;
    try { state = JSON.parse(row.value_json); } catch { throw unavailable(); }
    if (!record(state) || !record(state.preset)) throw unavailable();
    if (state.preset.compositionReference === undefined) continue;
    const binding = parseMultiviewSystemReferenceBinding(state.preset.compositionReference);
    if (!binding) throw unavailable();
    found.set(`${binding.assetId}:${binding.referenceImageId}:${binding.sha256}`, binding);
  }
  return Array.from(found.values());
}

export function multiviewFileAliases(url: string | null | undefined) {
  if (!url) return [];
  const local = siteUploadPathFromUrl(url);
  return local ? [url, local, ...siteUploadBaseUrls().map(base => `${base}${local}`)] : [url];
}

async function durableProtectedFiles(db: BindingDb) {
  const rows = await db.platformSetting.findMany({ where: { key: { startsWith: MULTIVIEW_PRIVATE_MEDIA_ACCESS_PREFIX } }, select: { key: true, value_json: true } });
  return rows.map(row => {
    let value: unknown;
    try { value = JSON.parse(row.value_json); } catch { throw unavailable(); }
    if (!record(value) || value.schema !== 1 || value.kind !== 'system-reference' || !identity(value.assetId) || !identity(value.ownerId)
      || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
      || row.key !== MULTIVIEW_PRIVATE_MEDIA_ACCESS_PREFIX + value.sha256 || !Array.isArray(value.urls) || !value.urls.length
      || value.urls.some(url => typeof url !== 'string' || !siteUploadPathFromUrl(url))) throw unavailable();
    return { assetId: value.assetId, ownerId: value.ownerId, urls: value.urls.flatMap(url => multiviewFileAliases(url as string)) };
  });
}

export async function hiddenMultiviewSystemReferenceUrls(user: Reader, db: BindingDb = prisma): Promise<string[]> {
  const durable = (await durableProtectedFiles(db)).filter(file => !user
    || user.status !== undefined && user.status !== 'active' || user.id !== file.ownerId && !(user.role === 'admin' && user.account_type === 'internal'));
  const bindings = (await multiviewSystemReferenceBindings(db)).filter(binding => !user
    || user.status !== undefined && user.status !== 'active' || user.id !== binding.ownerId && !(user.role === 'admin' && user.account_type === 'internal'));
  if (!bindings.length) return Array.from(new Set(durable.flatMap(file => file.urls)));
  const assets = await db.asset.findMany({ where: { OR: bindings.map(binding => ({ id: binding.assetId })) },
    select: { original_url: true, thumbnail_url: true } });
  return Array.from(new Set([...durable.flatMap(file => file.urls), ...assets.flatMap(asset => [...multiviewFileAliases(asset.original_url), ...multiviewFileAliases(asset.thumbnail_url)])]));
}

export async function multiviewSystemReferenceFileAccess(user: Reader, rawUrl: string, db: BindingDb = prisma) {
  const local = siteUploadPathFromUrl(rawUrl);
  const aliases = new Set([rawUrl, ...(local ? multiviewFileAliases(local) : [])]);
  const durable = (await durableProtectedFiles(db)).filter(file => file.urls.some(url => aliases.has(url)));
  const bindings = await multiviewSystemReferenceBindings(db);
  if (!bindings.length && !durable.length) return { protected: false, allowed: true };
  const assets = await db.asset.findMany({ where: { id: { in: Array.from(new Set(bindings.map(binding => binding.assetId))) } },
    select: { id: true, original_url: true, thumbnail_url: true } });
  const matches = assets.filter(asset => [...multiviewFileAliases(asset.original_url), ...multiviewFileAliases(asset.thumbnail_url)].some(url => aliases.has(url)));
  if (!matches.length && !durable.length) return { protected: false, allowed: true };
  const allowed = Boolean(user && (user.status === undefined || user.status === 'active') && (user.role === 'admin' && user.account_type === 'internal'
    || durable.some(file => file.ownerId === user.id)
    || bindings.some(binding => binding.ownerId === user.id && matches.some(asset => asset.id === binding.assetId))));
  return { protected: true, allowed };
}
