import 'server-only';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { parseContentKey, ReactionError, resolveContent } from './content';
import type { ContentCategory, ContentKey, ReactionAction, ReactionListResponse, ReactionMutation, ReactionState } from './types';

export async function getReactionState(user: SessionUser, key: ContentKey, available: boolean): Promise<ReactionState> {
  const row = await prisma.contentReaction.findUnique({ where: { user_id_content_key: { user_id: user.id, content_key: key } } });
  // Legacy private favorites affect only the viewer's active state, never this public count.
  const likeCount = available ? await prisma.contentReaction.count({ where: { content_key: key, liked: true } }) : null;
  return { key, liked: row?.liked || false, favorited: row?.favorited || false, version: row?.version || 0, available, likeCount };
}

export async function reactionStates(user: SessionUser, inputs: unknown) {
  if (!Array.isArray(inputs) || inputs.length > 50) throw new ReactionError('每次最多读取50项');
  const states: Record<string, ReactionState> = {};
  for (const input of Array.from(new Set(inputs))) {
    const key = parseContentKey(input);
    const resolved = await resolveContent(user, key);
    states[key] = await getReactionState(user, resolved?.summary.key || key, Boolean(resolved));
  }
  return { states };
}

export async function setReaction(user: SessionUser, input: ReactionMutation) {
  const requested = parseContentKey(input?.key);
  if (!['like', 'favorite'].includes(input?.action) || typeof input.active !== 'boolean' || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(input.requestId)) throw new ReactionError('操作参数无效');
  const resolved = await resolveContent(user, requested);
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
  const rows = await prisma.contentReaction.findMany({ where: { user_id: user.id, OR: [{ liked: true }, { favorited: true }] } });
  const markedAt = (row: typeof rows[number]) => new Date(Math.max(row.liked_at?.getTime() || 0, row.favorited_at?.getTime() || 0) || row.created_at.getTime()).toISOString();
  rows.sort((a, b) => markedAt(a) === markedAt(b) ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : markedAt(a) < markedAt(b) ? 1 : -1);
  const counts = { all: 0, image: 0, video: 0, audio: 0, template: 0, prompt: 0 };
  const matches: Array<{ row: typeof rows[number]; resolved: Awaited<ReturnType<typeof resolveContent>> }> = [];
  // Search only current, authorized projections. Unavailable entries never retain searchable private text.
  for (const row of rows) {
    const resolved = await resolveContent(user, parseContentKey(row.content_key));
    if (search && (!resolved || !(resolved.prompt || resolved.summary.title).toLocaleLowerCase().includes(search))) continue;
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
    items.push({ key: row.content_key as ContentKey, category: row.category as ContentCategory, markedAt: markedAt(row), state: await getReactionState(user, row.content_key as ContentKey, Boolean(resolved)), content: resolved?.summary || null });
  }
  const last = page.at(-1)?.row;
  return { items, total: matches.length, counts, nextCursor: after.length > limit && last ? Buffer.from(JSON.stringify({ time: markedAt(last), id: last.id })).toString('base64url') : null };
}
