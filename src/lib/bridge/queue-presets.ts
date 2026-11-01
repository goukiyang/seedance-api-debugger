import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { displayUserName } from '@/lib/users/display';

/**
 * SD2 生产桥「组合」（GPT 队列预设）。插件 combo-store 的后台版：
 * - 按账号归属，不绑对话；shared=true 进共享池（目前全站可见，team_id 预留）；
 * - 创建者或管理员可改/删/开关共享；其他人可使用、点赞、复制到自己名下；
 * - 图片只存 SD2 相对路径或 HTTPS 地址，不收图片本身。
 */
export class PresetError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

const MAX_ITEMS = 200;
const MAX_TEXT = 8000;
const MAX_IMAGES = 9;
const MAX_JSON = 300_000;
const MAX_PER_USER = 500;

type PresetImage = { name: string; type: string; url: string };
type PresetItem = { text: string; images: PresetImage[] };

const isAdmin = (u: SessionUser) => u.role === 'admin';

/** 入口校验一次：只收文字和 SD2 / https 图片地址 */
export function parseItems(raw: unknown): PresetItem[] {
  if (!Array.isArray(raw)) throw new PresetError('items 必须是数组', 400);
  if (raw.length > MAX_ITEMS) throw new PresetError(`最多 ${MAX_ITEMS} 条`, 400);
  const items = raw.map((it) => {
    const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>;
    const text = typeof o.text === 'string' ? o.text.slice(0, MAX_TEXT) : '';
    const imgs = Array.isArray(o.images) ? o.images : [];
    if (imgs.length > MAX_IMAGES) throw new PresetError(`每条最多 ${MAX_IMAGES} 张图`, 400);
    const images = imgs.map((im) => {
      const m = (im && typeof im === 'object' ? im : {}) as Record<string, unknown>;
      const url = typeof m.url === 'string' ? m.url : '';
      const relative = url.startsWith('/') && !url.includes('\\') && !url.replace(/[\t\r\n]/g, '').startsWith('//');
      if (!url || url.length > 1000 || !(relative || url.startsWith('https://'))) throw new PresetError('图片只能使用 SD2 相对路径或 HTTPS 地址', 400);
      return { name: typeof m.name === 'string' ? m.name.slice(0, 200) : '', type: typeof m.type === 'string' ? m.type.slice(0, 50) : '', url };
    });
    return { text, images };
  });
  if (JSON.stringify(items).length > MAX_JSON) throw new PresetError('组合内容过大', 413);
  return items;
}

export function parseName(raw: unknown) {
  const name = typeof raw === 'string' ? raw.trim().slice(0, 80) : '';
  if (!name) throw new PresetError('组合需要名字', 400);
  return name;
}

type Row = Awaited<ReturnType<typeof prisma.bridgeQueuePreset.findFirst>> & {};

/** 转成插件用的形状；作者名字/头像实时取，likedByMe 按当前用户 */
async function present(rows: Row[], me: SessionUser) {
  if (!rows.length) return [];
  const ownerIds = Array.from(new Set(rows.map((r) => r.owner_id)));
  const [owners, likes] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } }),
    prisma.bridgeQueuePresetLike.findMany({ where: { user_id: me.id, preset_id: { in: rows.map((r) => r.id) } }, select: { preset_id: true } }),
  ]);
  const ownerOf = new Map(owners.map((o) => [o.id, o]));
  const liked = new Set(likes.map((l) => l.preset_id));
  return rows.map((r) => {
    const o = ownerOf.get(r.owner_id);
    let items: PresetItem[] = [];
    try { items = JSON.parse(r.items_json); } catch { items = []; }
    return {
      id: r.id,
      clientId: r.client_id,
      name: r.name,
      items,
      ownerId: r.owner_id,
      ownerName: o ? displayUserName(o) : '已删除的用户',
      ownerAvatar: o?.avatar_url || '',
      shared: r.shared,
      likes: r.like_count,
      likedByMe: liked.has(r.id),
      uses: r.use_count,
      copiedFrom: r.copied_from,
      canEdit: r.owner_id === me.id || isAdmin(me),
      createdAt: r.created_at.getTime(),
      updatedAt: r.updated_at.getTime(),
    };
  });
}

async function mustFind(id: string) {
  const row = await prisma.bridgeQueuePreset.findUnique({ where: { id } });
  if (!row) throw new PresetError('组合不存在或已被删除', 404);
  return row;
}
function mustUse(row: Row, me: SessionUser) {
  if (row.owner_id !== me.id && !row.shared && !isAdmin(me)) throw new PresetError('组合不存在或已被删除', 404);
  return row;
}
function mustEdit(row: Row, me: SessionUser) {
  if (row.owner_id !== me.id && !isAdmin(me)) throw new PresetError('只有创建者或管理员可以修改，可先复制到自己名下', 403);
  return row;
}

export async function listPresets(me: SessionUser, opts: { scope: string; q?: string; sort?: string; limit?: number; offset?: number }) {
  const limit = Math.trunc(Math.min(Math.max(Number(opts.limit) || 100, 1), 200));
  const offset = Number(opts.offset) || 0;
  const skip = Number.isFinite(offset) ? Math.max(Math.trunc(offset), 0) : 0;
  const q = (opts.q || '').trim().slice(0, 80);
  const where = {
    ...(opts.scope === 'shared' ? { shared: true } : { owner_id: me.id }),
    ...(q ? { OR: [{ name: { contains: q } }, { items_json: { contains: q } }] } : {}),
  };
  const orderBy = opts.sort === 'likes' ? [{ like_count: 'desc' as const }, { updated_at: 'desc' as const }]
    : opts.sort === 'uses' ? [{ use_count: 'desc' as const }, { updated_at: 'desc' as const }]
      : [{ updated_at: 'desc' as const }];
  const [rows, total] = await Promise.all([
    prisma.bridgeQueuePreset.findMany({ where, orderBy, take: limit, skip }),
    prisma.bridgeQueuePreset.count({ where }),
  ]);
  return { presets: await present(rows, me), total };
}

/** 新建；带 clientId 时同一用户同一 clientId 只建一次（插件迁移本机组合可重试） */
export async function createPreset(me: SessionUser, body: Record<string, unknown>, copiedFrom?: string) {
  const name = parseName(body.name);
  const items = parseItems(body.items);
  const clientId = typeof body.clientId === 'string' && body.clientId ? body.clientId.slice(0, 64) : null;
  if (clientId) {
    const dup = await prisma.bridgeQueuePreset.findFirst({ where: { owner_id: me.id, client_id: clientId } });
    if (dup) return (await present([dup], me))[0];
  }
  if (await prisma.bridgeQueuePreset.count({ where: { owner_id: me.id } }) >= MAX_PER_USER) throw new PresetError(`每人最多 ${MAX_PER_USER} 个组合`, 409);
  let row: Row;
  try {
    row = await prisma.bridgeQueuePreset.create({
      data: { owner_id: me.id, client_id: clientId, name, items_json: JSON.stringify(items), shared: body.shared === true, copied_from: copiedFrom || null },
    });
  } catch (error) {
    if (clientId && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const target = error.meta?.target;
      if (Array.isArray(target) && target.length === 2 && target.includes('owner_id') && target.includes('client_id')) {
        const dup = await prisma.bridgeQueuePreset.findFirst({ where: { owner_id: me.id, client_id: clientId } }).catch(() => null);
        if (dup) return (await present([dup], me))[0];
      }
    }
    throw error;
  }
  return (await present([row], me))[0];
}

export async function updatePreset(me: SessionUser, id: string, body: Record<string, unknown>) {
  mustEdit(await mustFind(id), me);
  const data: { name?: string; items_json?: string; shared?: boolean } = {};
  if (body.name !== undefined) data.name = parseName(body.name);
  if (body.items !== undefined) data.items_json = JSON.stringify(parseItems(body.items));
  if (typeof body.shared === 'boolean') data.shared = body.shared;
  if (!Object.keys(data).length) throw new PresetError('没有要修改的内容', 400);
  const row = await prisma.bridgeQueuePreset.update({ where: { id }, data });
  return (await present([row], me))[0];
}

export async function deletePreset(me: SessionUser, id: string) {
  mustEdit(await mustFind(id), me);
  await prisma.$transaction([
    prisma.bridgeQueuePresetLike.deleteMany({ where: { preset_id: id } }),
    prisma.bridgeQueuePreset.delete({ where: { id } }),
  ]);
  return { id };
}

/** 点赞切换：点赞表唯一键保证一人一票，计数同事务更新 */
export async function toggleLike(me: SessionUser, id: string) {
  mustUse(await mustFind(id), me);
  const row = await prisma.$transaction(async (tx) => {
    const had = await tx.bridgeQueuePresetLike.findUnique({ where: { preset_id_user_id: { preset_id: id, user_id: me.id } } });
    if (had) await tx.bridgeQueuePresetLike.delete({ where: { id: had.id } });
    else await tx.bridgeQueuePresetLike.create({ data: { preset_id: id, user_id: me.id } });
    const likes = await tx.bridgeQueuePresetLike.count({ where: { preset_id: id } });
    return tx.bridgeQueuePreset.update({ where: { id }, data: { like_count: likes } });
  });
  return (await present([row], me))[0];
}

export async function recordUse(me: SessionUser, id: string) {
  mustUse(await mustFind(id), me);
  // 只加计数，不算「修改」：不动 updated_at 以免把旧组合顶到最新
  await prisma.$executeRaw`UPDATE "BridgeQueuePreset" SET "use_count" = "use_count" + 1 WHERE "id" = ${id}`;
  return (await present([await mustFind(id)], me))[0];
}

export async function copyPreset(me: SessionUser, id: string) {
  const src = mustUse(await mustFind(id), me);
  return createPreset(me, { name: (src.name + '（副本）').slice(0, 80), items: JSON.parse(src.items_json), shared: false }, src.id);
}
