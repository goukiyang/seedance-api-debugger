import type { SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { multiviewFileAliases } from './multiview-recipe-storage.server';

export function isMultiviewOutputMetadata(raw: string | null | undefined) {
  try {
    const value = JSON.parse(raw || '{}');
    return value?.multiviewOutput?.schema === 1;
  } catch { return Boolean(raw?.includes('"multiviewOutput"')); }
}

type Reader = { id: string; role: string; account_type?: string; status?: string } | null;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** A removed Asset must not turn a reused, formerly public filename public again. */
async function hasDurableOutputAlias(aliases: string[]) {
  const rows = await prisma.platformSetting.findMany({ where: { key: { startsWith: 'multiview_output_registration_v1:receipt:' },
    OR: aliases.map(url => ({ value_json: { contains: JSON.stringify(url) } })) }, select: { value_json: true } });
  for (const row of rows) {
    let value: unknown;
    try { value = JSON.parse(row.value_json); } catch { throw new Error('作品素材权限暂时无法确认'); }
    if (!record(value) || value.schema !== 1 || value.state !== 'registered' || !Array.isArray(value.outputs)) {
      throw new Error('作品素材权限暂时无法确认');
    }
    if (value.outputs.some(output => record(output) && output.state === 'registered'
      && [output.originalUrl, output.thumbnailUrl].some(url => typeof url === 'string'
        && multiviewFileAliases(url).some(alias => aliases.includes(alias))))) return true;
  }
  return false;
}

/** Output originals use the existing Asset/explicit-album rights, never recipe rights. */
export async function multiviewOutputFileAccess(user: Reader, rawUrl: string, original = true): Promise<{ protected: boolean; allowed: boolean }> {
  const aliases = multiviewFileAliases(rawUrl);
  const [rows, durable] = await Promise.all([
    prisma.asset.findMany({ where: { OR: [{ original_url: { in: aliases } }, { thumbnail_url: { in: aliases } }] },
      select: { id: true, owner_id: true, status: true, original_url: true, metadata_json: true } }),
    hasDurableOutputAlias(aliases),
  ]);
  const assets = rows.filter(asset => isMultiviewOutputMetadata(asset.metadata_json) || asset.original_url.includes('/uploads/multiview-outputs/'));
  // A published file is not readable in the gap before its Asset transaction.
  const specialPath = rawUrl.includes('/uploads/multiview-outputs/');
  if (!assets.length) return { protected: specialPath || durable, allowed: !specialPath && !durable };
  if (!user || user.status !== undefined && user.status !== 'active') return { protected: true, allowed: false };
  const active = assets.filter(asset => asset.status === 'active');
  if (!active.length) return { protected: true, allowed: false };
  if (user.role === 'admin' && user.account_type === 'internal' || active.some(asset => asset.owner_id === user.id)) return { protected: true, allowed: true };
  // Do not invent output sharing. Reuse only a real, explicit existing album
  // grant, including the distinct original-download permission.
  const refs = await prisma.referenceImage.findMany({ where: { asset_id: { in: active.map(asset => asset.id) }, status: 'active', album: { status: { not: 'deleted' } } },
    select: { album_id: true } });
  if (!refs.length) return { protected: true, allowed: false };
  const { getAlbumByIdForAccess, getAlbumAccess } = await import('@/lib/reference-albums/permissions');
  const actor = { ...user, status: user.status || 'active' } as SessionUser;
  for (const albumId of Array.from(new Set(refs.map(ref => ref.album_id)))) {
    const album = await getAlbumByIdForAccess(albumId);
    if (!album) continue;
    const access = await getAlbumAccess(actor, album);
    if (original ? access.permissions.download : access.permissions.view) return { protected: true, allowed: true };
  }
  return { protected: true, allowed: false };
}
