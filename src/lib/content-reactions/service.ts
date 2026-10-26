import 'server-only';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { ReactionError, resolveContent } from './content';
import type { ContentCategory, ContentKey, ReactionListResponse, ReactionMutation, ReactionState } from './types';
import { createCutoutContentContext, type CutoutContentContext } from './cutout-content';
import { tryContentKeyParts } from './key';
import { favoriteEntry, favoriteOrganization, readTemplateFavoriteLibrary } from './template-favorites';

async function resolveReactionContent(user: SessionUser, key: ContentKey, context?: CutoutContentContext) {
  try { return await resolveContent(user, key, context); }
  catch (error) {
    // A temporarily unreadable cutout must not block other favorites or removal of the viewer's own mark.
    if (key.startsWith('cutout_result:') && error instanceof Error && error.message === 'cutout_result_read_unavailable') return null;
    throw error;
  }
}

function templateIdentity(key: string) {
  const type = key.split(':')[0];
  if (!['image_template', 'image_module', 'video_template', 'video_draft', 'legacy_template'].includes(type)) return null;
  return { templateKind: ['image_module', 'video_draft'].includes(type) ? 'workpage' : 'definition', templateMedium: type.startsWith('image_') ? 'image' : 'video' };
}

export async function getReactionState(user: SessionUser, key: ContentKey, available: boolean): Promise<ReactionState> {
  const row = await prisma.contentReaction.findUnique({ where: { user_id_content_key: { user_id: user.id, content_key: key } } });
  // Legacy private favorites affect only the viewer's active state, never this public count.
  const likeCount = available ? await prisma.contentReaction.count({ where: { content_key: key, liked: true } }) : null;
  return { key, liked: row?.liked || false, favorited: row?.favorited || false, version: row?.version || 0, available, likeCount };
}

export async function reactionStates(user: SessionUser, inputs: unknown) {
  if (!Array.isArray(inputs) || inputs.length > 50) throw new ReactionError('每次最多读取50项');
  const states: Record<string, ReactionState> = Object.create(null);
  const context = createCutoutContentContext(user.id);
  for (const input of Array.from(new Set(inputs))) {
    const parsed = tryContentKeyParts(input);
    if (!parsed && (typeof input !== 'string' || input.length > 5000 || !await prisma.contentReaction.findUnique({ where: { user_id_content_key: { user_id: user.id, content_key: input } } }))) throw new ReactionError('内容编号无效');
    const key = input as ContentKey;
    const resolved = parsed ? await resolveReactionContent(user, key, context) : null;
    states[key] = await getReactionState(user, resolved?.summary.key || key, Boolean(resolved));
  }
  return { states };
}

export async function setReaction(user: SessionUser, input: ReactionMutation) {
  if (input?.viewerId !== undefined && input.viewerId !== user.id) throw new ReactionError('账号已变化，请重新打开我的喜欢', 409);
  if (!['like', 'favorite'].includes(input?.action) || typeof input.active !== 'boolean' || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(input.requestId)) throw new ReactionError('操作参数无效');
  const parsed = tryContentKeyParts(input.key);
  if (!parsed) {
    if (input.active || typeof input.key !== 'string' || !input.key || input.key.length > 5000) throw new ReactionError('内容编号无效');
    const owned = await prisma.contentReaction.findUnique({ where: { user_id_content_key: { user_id: user.id, content_key: input.key } } });
    if (!owned) throw new ReactionError('标记不存在', 404);
  }
  const requested = input.key as ContentKey;
  const resolved = parsed ? await resolveReactionContent(user, requested) : null;
  const key = resolved?.summary.key || requested;
  const fingerprint = createHash('sha256').update(JSON.stringify([requested, input.action, input.active, input.expectedVersion])).digest('hex');
  const previous = await prisma.contentReactionEvent.findUnique({ where: { user_id_request_id: { user_id: user.id, request_id: input.requestId } } });
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new ReactionError('重复请求内容不一致', 409);
    return { state: await getReactionState(user, previous.content_key as ContentKey, Boolean(resolved)) };
  }
  if (input.active && !resolved) throw new ReactionError('内容已不可用或你已无权访问', 404);
  try {
    await prisma.$transaction(async tx => {
      if (input.viewerId !== undefined) {
        const actor = await tx.user.findUnique({ where: { id: user.id }, select: { status: true, expires_at: true } });
        if (!actor || actor.status !== 'active' || actor.expires_at && actor.expires_at <= new Date()) throw new ReactionError('账号暂不可用', 403);
      }
      const current = await tx.contentReaction.findUnique({ where: { user_id_content_key: { user_id: user.id, content_key: key } } });
      if ((current?.version || 0) !== input.expectedVersion) throw new ReactionError('状态已变化，请按最新状态重试', 409);
      if (!current && !resolved) throw new ReactionError('标记不存在', 404);
      // New likes switch both fields. A cached legacy bookmark must remain private.
      const now = new Date();
      const data = input.action === 'favorite' ? {
        favorited: input.active,
        favorited_at: input.active ? (current?.favorited_at || now) : null,
      } : {
        liked: input.active, favorited: input.active,
        liked_at: input.active ? (current?.liked_at || current?.favorited_at || now) : null,
        favorited_at: input.active ? (current?.favorited_at || current?.liked_at || now) : null,
      };
      if (current) {
        const updated = await tx.contentReaction.updateMany({ where: { id: current.id, version: input.expectedVersion }, data: { ...data, version: { increment: 1 } } });
        if (!updated.count) throw new ReactionError('状态已变化，请重试', 409);
      } else {
        await tx.contentReaction.create({ data: { user_id: user.id, content_key: key, category: resolved!.summary.category, ...data } });
      }
      await tx.contentReactionEvent.create({ data: { user_id: user.id, content_key: key, request_id: input.requestId, fingerprint, action: input.action, active: input.active } });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const replay = await prisma.contentReactionEvent.findUnique({ where: { user_id_request_id: { user_id: user.id, request_id: input.requestId } } });
      if (!replay || replay.fingerprint !== fingerprint) throw new ReactionError('状态已变化，请重试', 409);
    } else throw error;
  }
  return { state: await getReactionState(user, key, Boolean(resolved)) };
}

export async function listReactions(user: SessionUser, params: URLSearchParams): Promise<ReactionListResponse> {
  const action = params.get('action') || 'like';
  if (action !== 'favorite' && action !== 'like') throw new ReactionError('列表类型无效');
  const category = params.get('category') || 'all';
  if (!['all', 'image', 'video', 'audio', 'template', 'prompt'].includes(category)) throw new ReactionError('分类无效');
  const search = (params.get('q') || '').trim().toLocaleLowerCase().slice(0, 160);
  const limit = Math.min(40, Math.max(1, Number(params.get('limit')) || 24));
  const organized = category === 'template' && params.get('organize') === '1';
  const rows = await prisma.contentReaction.findMany({ where: { user_id: user.id, ...(organized ? { category: 'template' } : {}), OR: [{ liked: true }, { favorited: true }] } });
  const markedAt = (row: typeof rows[number]) => new Date(Math.max(row.liked_at?.getTime() || 0, row.favorited_at?.getTime() || 0) || row.created_at.getTime()).toISOString();
  rows.sort((a, b) => markedAt(a) === markedAt(b) ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : markedAt(a) < markedAt(b) ? 1 : -1);
  const counts = { all: 0, image: 0, video: 0, audio: 0, template: 0, prompt: 0 };
  const matches: Array<{ row: typeof rows[number]; resolved: Awaited<ReturnType<typeof resolveContent>> }> = [];
  const context = createCutoutContentContext(user.id);
  const personal = organized ? await readTemplateFavoriteLibrary(user.id) : null;
  const requestedGroup = params.get('group') || 'all';
  if (organized && requestedGroup !== 'all' && requestedGroup !== 'ungrouped' && !/^[0-9a-f-]{36}$/i.test(requestedGroup)) throw new ReactionError('分组筛选无效');
  const selectedGroup = personal && requestedGroup !== 'all' && requestedGroup !== 'ungrouped' && !personal.library.groups.some(group => group.id === requestedGroup) ? 'all' : requestedGroup;
  // Search only current, authorized projections. Unavailable entries never retain searchable private text.
  for (const row of rows) {
    if (personal && selectedGroup !== 'all') {
      const groupId = favoriteEntry(personal.library, row.content_key).groupId;
      if (selectedGroup === 'ungrouped' ? groupId !== null : groupId !== selectedGroup) continue;
    }
    const parsed = tryContentKeyParts(row.content_key);
    const resolved = parsed ? await resolveReactionContent(user, parsed.key, context) : null;
    if (search && (!resolved || !(resolved.prompt || resolved.summary.title).toLocaleLowerCase().includes(search))) continue;
    const template = resolved?.summary || templateIdentity(row.content_key);
    if (category === 'template' && params.get('templateKind') && template?.templateKind !== params.get('templateKind')) continue;
    if (category === 'template' && params.get('templateMedium') && template?.templateMedium !== params.get('templateMedium')) continue;
    counts.all++;
    if (row.category in counts) counts[row.category as ContentCategory]++;
    if (category === 'all' || category === row.category) matches.push({ row, resolved });
  }
  let cursor: { time: string; id: string } | null = null;
  if (params.get('cursor')) {
    try {
      cursor = JSON.parse(Buffer.from(params.get('cursor')!, 'base64url').toString());
      if (!cursor || typeof cursor.time !== 'string' || typeof cursor.id !== 'string' || !Number.isFinite(Date.parse(cursor.time))) throw new Error();
    } catch { throw new ReactionError('加载位置已失效，请刷新列表'); }
  }
  const after = matches.filter(({ row }) => !cursor || markedAt(row) < cursor.time || (markedAt(row) === cursor.time && row.id < cursor.id));
  const page = after.slice(0, limit);
  const items: ReactionListResponse['items'] = [];
  for (const { row, resolved } of page) {
    const entry = personal ? favoriteEntry(personal.library, row.content_key) : null;
    items.push({ key: row.content_key as ContentKey, category: row.category as ContentCategory, markedAt: markedAt(row), state: await getReactionState(user, row.content_key as ContentKey, Boolean(resolved)), content: resolved?.summary || null,
      ...(entry ? { personalAlias: entry.alias, groupId: entry.groupId } : {}) });
  }
  const last = page.at(-1)?.row;
  return { items, total: matches.length, counts, nextCursor: after.length > limit && last ? Buffer.from(JSON.stringify({ time: markedAt(last), id: last.id })).toString('base64url') : null,
    ...(personal ? { organization: await favoriteOrganization(personal.library), selectedGroup } : {}) };
}
