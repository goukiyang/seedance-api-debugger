import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { canUseCompanyTemplates, type ImageStudioIdentity } from './access';
import { siteUploadBaseUrls, siteUploadPathFromUrl } from '@/lib/assets/site-url';

type Client = Pick<Prisma.TransactionClient, 'platformSetting' | 'asset'>;
type Protection = { assetId: string; ownerId: string; kind: 'template' | 'style' };

export function studioProtectedBindings(rows: Array<{ key: string; value_json: string }>): Protection[] {
  return rows.flatMap(row => {
    let value: Record<string, unknown>;
    try { value = JSON.parse(row.value_json); } catch { throw new Error('参考内容权限记录无法读取'); }
    if (!value || typeof value.ownerId !== 'string' || !Array.isArray(value.references)) throw new Error('参考内容权限记录无效');
    return value.references.flatMap(item => {
      if (!item || typeof item.assetId !== 'string') throw new Error('参考内容权限记录无效');
      return [{ assetId: item.assetId, ownerId: value.ownerId as string,
        kind: row.key.startsWith('studio_style_group_v1:') ? 'style' as const : 'template' as const }];
    });
  });
}

export function canInspectStudioBinding(user: Pick<ImageStudioIdentity, 'id' | 'role' | 'account_type'> | null, binding: Protection) {
  if (!user || user.account_type !== 'internal') return false;
  return user.role === 'admin' || (binding.kind === 'style' && binding.ownerId === user.id);
}

// Match underlying files as well as ids: older template application copied an
// Asset row with the same URL, so checking just the source id leaves a bypass.
export async function studioHiddenAssetUrls(user: ImageStudioIdentity | null, client: Client = prisma): Promise<string[]> {
  if (user?.role === 'admin' && canUseCompanyTemplates(user)) return [];
  const rows = await client.platformSetting.findMany({ where: { OR: [
    { key: { startsWith: 'studio_fixed_references_v1:' } },
    { key: { startsWith: 'studio_style_group_v1:' } },
  ] }, select: { key: true, value_json: true } });
  const allBindings = studioProtectedBindings(rows);
  const ownedStyleIds = new Set(allBindings.filter(binding => binding.kind === 'style' && canInspectStudioBinding(user, binding)).map(binding => binding.assetId));
  const bindings = allBindings.filter(binding => !canInspectStudioBinding(user, binding)
    && (binding.kind === 'template' || !ownedStyleIds.has(binding.assetId)));
  if (!bindings.length) return [];
  const assets = await client.asset.findMany({ where: { id: { in: Array.from(new Set(bindings.map(binding => binding.assetId))) } },
    select: { original_url: true, thumbnail_url: true } });
  return Array.from(new Set(assets.flatMap(asset => [asset.original_url, ...(asset.thumbnail_url ? [asset.thumbnail_url] : [])]).flatMap(url => {
    const pathname = siteUploadPathFromUrl(url);
    return pathname ? [url, pathname, ...siteUploadBaseUrls().map(base => `${base}${pathname}`)] : [url];
  })));
}

export async function studioVisibleAssetWhere(user: ImageStudioIdentity, client: Client = prisma): Promise<Prisma.AssetWhereInput> {
  const hidden = await studioHiddenAssetUrls(user, client);
  return hidden.length ? { original_url: { notIn: hidden } } : {};
}

export async function canReadStudioAsset(user: ImageStudioIdentity, asset: { original_url: string }, client: Client = prisma) {
  return !(await studioHiddenAssetUrls(user, client)).includes(asset.original_url);
}

export async function studioVisibleReferenceWhere(user: ImageStudioIdentity): Promise<Prisma.ReferenceImageWhereInput> {
  const hidden = await studioHiddenAssetUrls(user);
  return hidden.length ? { AND: [{ url: { notIn: hidden } }, { OR: [{ asset: null }, { asset: { original_url: { notIn: hidden } } }] }] } : {};
}
