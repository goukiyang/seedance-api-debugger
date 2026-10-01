import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { displayUserName } from '@/lib/users/display';
import { canViewStudioPreset } from '@/lib/image-studio/access';
import { listStudioPresets } from '@/lib/image-studio/presets';
import { IMAGE_STUDIO_MODEL_LABELS } from '@/lib/image-studio/model-catalog';
import {
  canvasStyleFailure, canvasStyleJson, requireCanvasStyleUser,
} from '@/lib/canvas-style-bridge';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PAGE_SIZE = 24;
const REACTION_CHUNK_SIZE = 400;

function decodeRecentIds(params: URLSearchParams) {
  const raw = params.getAll('recentIds').join(',').trim();
  if (!raw) return [] as string[];
  let values: unknown[];
  if (raw.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error();
      values = parsed;
    } catch {
      throw new Error('最近使用记录无效');
    }
  } else {
    values = raw.split(',');
  }
  if (values.length > 60 || values.some(value => typeof value !== 'string')) throw new Error('最近使用记录无效');
  return Array.from(new Set(values.filter((value): value is string => typeof value === 'string'
    && /^image_template:[A-Za-z0-9_-]{1,160}$/.test(value))));
}

function encodeCursor(scope: string, id: string) {
  return Buffer.from(JSON.stringify({ scope, id })).toString('base64url');
}

function decodeCursor(value: string, expectedScope: string) {
  try {
    if (value.length > 512) throw new Error();
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    const cursor = parsed as Record<string, unknown>;
    if (cursor.scope !== expectedScope || typeof cursor.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(cursor.id)) throw new Error();
    return cursor.id;
  } catch {
    throw new Error('分页位置已失效，请重新加载风格库');
  }
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireCanvasStyleUser();
    const params = request.nextUrl.searchParams;
    const query = (params.get('query') || '').trim().slice(0, 160);
    const category = (params.get('category') || 'all').trim();
    const model = (params.get('model') || 'all').trim();
    const requestedTab = (params.get('tab') || 'all').trim();
    const tab = requestedTab === 'gallery' ? 'all' : requestedTab;
    if (params.get('query')?.trim().length && params.get('query')!.trim().length > 160) {
      return canvasStyleJson({ error: '搜索内容最多 160 字' }, 400);
    }
    if (!['all', 'favorites', 'recent'].includes(tab)) return canvasStyleJson({ error: '风格库分类页签无效' }, 400);
    const recentIds = decodeRecentIds(params);
    const presets = await listStudioPresets(user);
    const authorizedIds = presets.map(preset => preset.id);
    const [authorizedRows, reactionRows] = await Promise.all([
      (async () => {
        const rows = [];
        for (let index = 0; index < authorizedIds.length; index += REACTION_CHUNK_SIZE) {
          rows.push(...await prisma.imageStudioPreset.findMany({
            where: { id: { in: authorizedIds.slice(index, index + REACTION_CHUNK_SIZE) } },
            select: { id: true, owner_id: true, scope: true, is_shared: true },
          }));
        }
        return rows;
      })(),
      (async () => {
        const keys = authorizedIds.map(id => `image_template:${id}`);
        const rows = [];
        for (let index = 0; index < keys.length; index += REACTION_CHUNK_SIZE) {
          rows.push(...await prisma.contentReaction.findMany({
            where: { user_id: user.id, content_key: { in: keys.slice(index, index + REACTION_CHUNK_SIZE) } },
            select: { content_key: true, favorited: true, version: true },
          }));
        }
        return rows;
      })(),
    ]);
    const presetAccess = new Map(authorizedRows.map(row => [row.id, row]));
    const reactionByKey = new Map(reactionRows.map(row => [row.content_key, row]));
    const visible = presets.filter(preset => {
      const current = presetAccess.get(preset.id);
      return Boolean(current && canViewStudioPreset(user, current));
    });
    const ownerIds = Array.from(new Set(visible.map(preset => presetAccess.get(preset.id)!.owner_id)));
    const owners = [];
    for (let index = 0; index < ownerIds.length; index += REACTION_CHUNK_SIZE) {
      owners.push(...await prisma.user.findMany({
        where: { id: { in: ownerIds.slice(index, index + REACTION_CHUNK_SIZE) } },
        select: { id: true, name: true, username: true, avatar_url: true },
      }));
    }
    const ownerById = new Map(owners.map(owner => [owner.id, owner]));
    const presetById = new Map(visible.map(preset => [preset.id, preset]));
    const projected = visible.map(preset => {
      const access = presetAccess.get(preset.id)!;
      const key = `image_template:${preset.id}`;
      const reaction = reactionByKey.get(key);
      const groupName = preset.groupName.trim() || '未分组';
      const coverUrl = preset.banner?.thumbnailUrl || preset.images[0]?.thumbnailUrl || null;
      const owner = ownerById.get(access.owner_id);
      return {
        id: preset.id,
        key,
        name: preset.name,
        category: groupName,
        model: preset.model,
        coverUrl,
        author: { name: displayUserName(owner), avatarUrl: owner?.avatar_url || null },
        favorited: reaction?.favorited || false,
        reactionVersion: reaction?.version || 0,
        commercialAllowed: null,
        ...(preset.prompt.trim() ? { description: preset.prompt.trim().slice(0, 400) } : {}),
      };
    });

    const categoryIds = Array.from(new Set(projected.map(item => item.category))).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const modelIds = Array.from(new Set(projected.map(item => item.model))).sort();
    const categoryFilter = category === 'all' ? null : category;
    const modelFilter = model === 'all' ? null : model;
    const normalizedQuery = query.toLocaleLowerCase();
    let filtered = projected.filter(item =>
      (!categoryFilter || item.category === categoryFilter)
      && (!modelFilter || item.model === modelFilter)
      && (!normalizedQuery || `${item.name}\n${item.category}\n${presetById.get(item.id)?.prompt || ''}`.toLocaleLowerCase().includes(normalizedQuery))
      && (tab !== 'favorites' || item.favorited));
    if (tab === 'recent') {
      const recentOrder = new Map(recentIds.map((key, index) => [key, index]));
      filtered = filtered.filter(item => recentOrder.has(item.key))
        .sort((a, b) => recentOrder.get(a.key)! - recentOrder.get(b.key)!);
    }

    const scope = createHash('sha256').update(JSON.stringify([user.id, normalizedQuery, category, model, tab, recentIds])).digest('hex');
    const cursorValue = params.get('cursor');
    let offset = 0;
    if (cursorValue) {
      const afterId = decodeCursor(cursorValue, scope);
      const index = filtered.findIndex(item => item.id === afterId);
      if (index < 0) return canvasStyleJson({ error: '分页位置已失效，请重新加载风格库' }, 400);
      offset = index + 1;
    }
    const items = filtered.slice(offset, offset + PAGE_SIZE);
    const last = items.at(-1);
    const nextCursor = last && offset + items.length < filtered.length ? encodeCursor(scope, last.id) : null;
    return canvasStyleJson({
      items,
      nextCursor,
      categories: categoryIds.map(id => ({ id, label: id })),
      models: modelIds.map(id => ({ id, label: IMAGE_STUDIO_MODEL_LABELS[id as keyof typeof IMAGE_STUDIO_MODEL_LABELS] || id })),
      commercialFilterAvailable: false,
    });
  } catch (error) {
    if (error instanceof Error && error.message === '最近使用记录无效') return canvasStyleJson({ error: error.message }, 400);
    if (error instanceof Error && error.message === '分页位置已失效，请重新加载风格库') return canvasStyleJson({ error: error.message }, 400);
    return canvasStyleFailure(error, '风格库暂时无法读取，请重试');
  }
}
