import 'server-only';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { canUseCompanyTemplates, canViewStudioPreset, canViewStudioModule } from '@/lib/image-studio/access';
import { archivedPresetKey } from '@/lib/image-studio/preset-lifecycle';
import { readableStudioCoverIds } from '@/lib/image-studio/protected-assets';
import type { HomeTemplate, HomeTemplates } from '@/lib/home/types';
import type { ContentKey } from './types';
import { parseContentKey, ReactionError } from './content';

const presetSelect = { id: true, owner_id: true, scope: true, is_shared: true, name: true, banner_asset_id: true } as const;
type Projection = { key: ContentKey; title: string; href: string; kind: 'definition' | 'workpage'; ownerId: string; bannerId: string | null };

async function projectTemplates(user: SessionUser, keys: ContentKey[]): Promise<Projection[]> {
  if (!canUseCompanyTemplates(user)) return [];
  const definitions = keys.filter(key => key.startsWith('image_template:')).map(key => key.split(':')[1]);
  const moduleIds = keys.filter(key => key.startsWith('image_module:')).map(key => key.split(':')[1]);
  const modules = await prisma.imageStudioModule.findMany({ where: { id: { in: moduleIds }, owner_id: user.id }, take: 40,
    select: { id: true, owner_id: true, name: true, banner_asset_id: true, source_preset_id: true } });
  const presetIds = Array.from(new Set([...definitions, ...modules.flatMap(row => row.source_preset_id ? [row.source_preset_id] : [])]));
  const presets = await prisma.imageStudioPreset.findMany({ where: { id: { in: presetIds } }, take: 80, select: presetSelect });
  const archived = new Set((await prisma.platformSetting.findMany({ where: { key: { in: presetIds.map(archivedPresetKey) } }, take: 80, select: { key: true } })).map(row => row.key));
  const byId = new Map(presets.filter(row => !archived.has(archivedPresetKey(row.id))).map(row => [row.id, row]));
  const byModule = new Map(modules.map(row => [row.id, row]));
  return keys.flatMap<Projection>(key => {
    const [type, id] = key.split(':');
    if (type === 'image_template') {
      const row = byId.get(id);
      return row && canViewStudioPreset(user, row) ? [{ key, title: row.name, href: `/template-studio?type=image&presetId=${encodeURIComponent(id)}`,
        kind: 'definition' as const, ownerId: row.owner_id, bannerId: row.banner_asset_id }] : [];
    }
    const row = byModule.get(id), source = row?.source_preset_id ? byId.get(row.source_preset_id) || null : null;
    return row && canViewStudioModule(user, row, source) ? [{ key, title: row.name, href: `/template-studio?type=image&moduleId=${encodeURIComponent(id)}`,
      kind: 'workpage' as const, ownerId: row.owner_id, bannerId: row.banner_asset_id }] : [];
  });
}

async function covers(user: SessionUser, rows: Projection[]) {
  const ids = rows.flatMap(row => row.bannerId ? [row.bannerId] : []);
  const assets = await prisma.asset.findMany({ where: { id: { in: ids }, status: 'active', type: 'image' }, take: 40,
    select: { id: true, owner_id: true, original_url: true, mime_type: true, file_name: true } });
  let readable = new Set<string>();
  try { readable = await readableStudioCoverIds(user, assets); } catch { /* No cover is safer than an uncertain private image. */ }
  return new Map(rows.flatMap(row => {
    const asset = assets.find(asset => asset.id === row.bannerId && asset.owner_id === row.ownerId && readable.has(asset.id));
    return asset ? [[row.key, asset] as const] : [];
  }));
}

export async function homeTemplateCover(user: SessionUser, input: string, assetId: string) {
  const key = parseContentKey(input);
  if (!key.startsWith('image_template:') && !key.startsWith('image_module:')) return null;
  const rows = await projectTemplates(user, [key]);
  const asset = (await covers(user, rows)).get(key);
  return asset?.id === assetId ? asset : null;
}

export async function homeTemplates(user: SessionUser, params: URLSearchParams): Promise<HomeTemplates> {
  if (!canUseCompanyTemplates(user)) return { items: [], nextCursor: null };
  const requestedLimit = params.get('limit');
  if (requestedLimit !== null && !/^[1-5]$/.test(requestedLimit)) throw new ReactionError('收藏数量无效');
  const limit = requestedLimit === null ? 5 : Number(requestedLimit);
  let cursor: { time: Date; id: string } | null = null;
  const input = params.get('cursor');
  if (input) {
    try {
      if (input.length > 400) throw new Error();
      const value = JSON.parse(Buffer.from(input, 'base64url').toString());
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value.id) || typeof value.time !== 'string' || !Number.isFinite(Date.parse(value.time))) throw new Error();
      cursor = { id: value.id, time: new Date(value.time) };
    } catch { throw new ReactionError('收藏位置已失效，请重新读取'); }
  }
  const candidates = await prisma.contentReaction.findMany({ where: { user_id: user.id, category: 'template', AND: [
    { OR: [{ liked: true }, { favorited: true }] },
    { OR: [{ content_key: { startsWith: 'image_template:' } }, { content_key: { startsWith: 'image_module:' } }] },
    ...(cursor ? [{ OR: [{ updated_at: { lt: cursor.time } }, { updated_at: cursor.time, id: { lt: cursor.id } }] }] : []),
  ] }, orderBy: [{ updated_at: 'desc' }, { id: 'desc' }], take: 41,
  select: { id: true, content_key: true, liked: true, favorited: true, version: true, updated_at: true } });
  const batch = candidates.slice(0, 40);
  const projected = await projectTemplates(user, batch.map(row => parseContentKey(row.content_key)));
  const byKey = new Map(projected.map(row => [row.key, row]));
  const selected: Array<{ row: typeof batch[number]; projection: Projection }> = [];
  let consumed = 0;
  for (const row of batch) {
    consumed++;
    const projection = byKey.get(row.content_key as ContentKey);
    if (projection) selected.push({ row, projection });
    if (selected.length === limit) break;
  }
  const coverByKey = await covers(user, selected.map(item => item.projection));
  const items: HomeTemplate[] = selected.map(({ row, projection }) => {
    const asset = coverByKey.get(projection.key);
    return { key: projection.key, title: projection.title, href: projection.href, kind: projection.kind,
      thumbnailUrl: asset ? `/api/image-studio/template-assets/${encodeURIComponent(asset.id)}?thumbnail=1&homeContentKey=${encodeURIComponent(projection.key)}` : null,
      state: { key: projection.key, liked: row.liked, favorited: row.favorited, version: row.version, available: true, likeCount: null } };
  });
  const last = batch[consumed - 1];
  const nextCursor = last && (consumed < batch.length || candidates.length > 40)
    ? Buffer.from(JSON.stringify({ id: last.id, time: last.updated_at.toISOString() })).toString('base64url') : null;
  return { items, nextCursor };
}
