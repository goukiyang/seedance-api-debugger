import { constants } from 'node:fs';
import { open, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Asset, Prisma } from '@prisma/client';
import { BridgeFeishuError, BRIDGE_FEISHU_MAX_BYTES, type BridgeFeishuAsset } from './feishu-contract';

const formats: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/x-icon': 'ico' };
export function bridgeFeishuAssetSnapshot(asset: Asset): BridgeFeishuAsset {
  if (asset.file_size > BRIDGE_FEISHU_MAX_BYTES) throw new BridgeFeishuError('单张原图不能超过飞书的 10 MB 上限', 413);
  if (asset.type !== 'image' || asset.status !== 'active' || !formats[asset.mime_type]) throw new BridgeFeishuError('这张图片不可用或飞书不支持此原图格式');
  if (!asset.hash || !/^[a-f0-9]{64}$/.test(asset.hash) || asset.file_size < 1
    || asset.original_url !== `/uploads/assets/${asset.hash}.${formats[asset.mime_type]}`) throw new BridgeFeishuError('图片原件不可用，请重新上传', 409);
  return { id: asset.id, hash: asset.hash, original_url: asset.original_url, mime_type: asset.mime_type, file_size: asset.file_size };
}
export async function ownBridgeFeishuAssets(db: Prisma.TransactionClient, actorId: string, assetIds: string[]) {
  const rows = await db.asset.findMany({ where: { id: { in: assetIds } } });
  if (rows.length !== assetIds.length || rows.some(asset => asset.owner_id !== actorId)) throw new BridgeFeishuError('只能发送你自己的图片', 403);
  return assetIds.map(id => {
    const asset = rows.find(row => row.id === id)!;
    return bridgeFeishuAssetSnapshot(asset);
  });
}
export async function readBridgeFeishuOriginal(asset: BridgeFeishuAsset) {
  const unavailable = () => new BridgeFeishuError('图片原件不可用或已变化，请重新上传', 409);
  try {
    const root = await realpath(path.join(process.cwd(), 'public/uploads'));
    const file = path.join(root, 'assets', `${asset.hash}.${formats[asset.mime_type]}`);
    if (await realpath(file) !== file || !file.startsWith(root + path.sep)) throw unavailable();
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size !== asset.file_size) throw unavailable();
      const same = (value: typeof before) => value.isFile() && value.dev === before.dev && value.ino === before.ino
        && value.size === before.size && value.mtimeMs === before.mtimeMs && value.ctimeMs === before.ctimeMs;
      const bytes = await handle.readFile();
      if (!same(await handle.stat()) || !same(await lstat(file)) || createHash('sha256').update(bytes).digest('hex') !== asset.hash) throw unavailable();
      return { file: new Blob([Uint8Array.from(bytes)], { type: asset.mime_type }), extension: formats[asset.mime_type],
        current: async () => { try { return await realpath(file) === file && same(await lstat(file)); } catch { return false; } } };
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof BridgeFeishuError) throw error;
    throw unavailable();
  }
}
