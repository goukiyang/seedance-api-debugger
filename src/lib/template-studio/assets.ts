import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '@/lib/prisma';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';
import { getReferenceImageByIdForAccess, canUseAlbumImage } from '@/lib/reference-albums/permissions';
import { isPrivateNetworkHost } from '@/lib/media/public-url';
import { StudioError } from './errors';
import type { SessionUser } from '@/lib/auth/session';
import type { StudioAssetInput } from './types';

function isConfiguredStorageUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || isPrivateNetworkHost(url.hostname)) return false;
  const bases = [process.env.R2_PUBLIC_BASE_URL, process.env.TOS_PUBLIC_BASE_URL].filter((item): item is string => Boolean(item));
  return bases.some((base) => {
    try {
      const trusted = new URL(base);
      return trusted.protocol === 'https:' && trusted.origin === url.origin
        && url.pathname.startsWith(`${trusted.pathname.replace(/\/+$/, '')}/`);
    } catch { return false; }
  });
}

async function assertAssetIsReadable(originalUrl: string) {
  const uploadPath = siteUploadPathFromUrl(originalUrl);
  if (uploadPath) {
    try {
      const root = await fs.realpath(path.join(process.cwd(), 'public/uploads'));
      const file = await fs.realpath(path.resolve(process.cwd(), 'public', uploadPath.replace(/^\/+/, '')));
      if (!file.startsWith(`${root}${path.sep}`) || !(await fs.stat(file)).isFile()) throw new Error('invalid file');
      const handle = await fs.open(file, 'r');
      await handle.close();
      return;
    } catch {
      throw new StudioError('素材文件当前不可读取，请重新选择或上传', 409, 'CONFLICT');
    }
  }
  if (!isConfiguredStorageUrl(originalUrl)) throw new StudioError('素材存储地址不受信任，无法安全读取', 409, 'CONFLICT');
  try {
    const response = await fetch(originalUrl, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('unavailable');
  } catch {
    throw new StudioError('素材文件当前不可读取，请重新选择或上传', 409, 'CONFLICT');
  }
}

async function canReadAsset(user: SessionUser, asset: { id: string; owner_id: string; original_url: string }) {
  if (user.role === 'admin' || asset.owner_id === user.id) return true;
  const refs = await prisma.referenceImage.findMany({ where: { asset_id: asset.id, status: 'active' }, select: { id: true } });
  for (const ref of refs) {
    const image = await getReferenceImageByIdForAccess(ref.id);
    if (image && await canUseAlbumImage(user, image)) return true;
  }
  return false;
}

export async function authorizeStudioAssets(user: SessionUser, assets: StudioAssetInput[]) {
  if (!assets.length) return [];
  const rows = await prisma.asset.findMany({
    where: { id: { in: assets.map((asset) => asset.assetId) }, status: 'active' },
    select: { id: true, owner_id: true, type: true, original_url: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const input of assets) {
    const row = byId.get(input.assetId);
    if (!row || row.type !== input.type) {
      throw new StudioError('素材不存在、已停用或无权使用', 403, 'FORBIDDEN');
    }
    if (!(await canReadAsset(user, row))) throw new StudioError('无权使用此素材', 403, 'FORBIDDEN');
    await assertAssetIsReadable(row.original_url);
  }
  return assets;
}

export async function getAuthorizedAssetRows(user: SessionUser, assets: StudioAssetInput[]) {
  await authorizeStudioAssets(user, assets);
  if (!assets.length) return [];
  const rows = await prisma.asset.findMany({
    where: { id: { in: assets.map((asset) => asset.assetId) } },
    select: { id: true, type: true, original_url: true, thumbnail_url: true, created_at: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return assets.map((asset) => ({ asset, row: byId.get(asset.assetId)! }));
}
