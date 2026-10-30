import 'server-only';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { validStudioModuleId } from './modules';
import { studioTemplateTaskWhere } from './task-visibility';
import { studioTaskDTOs } from './tasks';
import { readableStudioPins, studioPinScope, studioPinState, StudioPinError } from './result-pins';
import { STUDIO_RESULT_FEED, type SharedStudioPinnedImage } from './result-pin-types';
import { studioOutputTaskWhere, studioTaskHasViewableOutput } from './dimension-mismatch';
import { likedStudioTaskPage } from './liked-task-page';

type Cursor = { v: 1; user: string; module: string; liked: boolean; epoch: string; pin: number; task: string | null };
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function readCursor(value: string | undefined, scope: Omit<Cursor, 'v' | 'pin' | 'task'>): Cursor {
  if (!value) return { v: 1, ...scope, pin: 0, task: null };
  try {
    if (value.length > 2000) throw new Error();
    const c = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (c.v !== 1 || c.user !== scope.user || c.module !== scope.module || c.liked !== scope.liked || c.epoch !== scope.epoch
      || !Number.isSafeInteger(c.pin) || c.pin < 0 || c.pin > 200 || c.task !== null && (typeof c.task !== 'string' || c.task.length > 160)) throw new Error();
    return c;
  } catch { throw new StudioPinError('置顶或结果目录已变化，请刷新目录', 409); }
}
/** Explicit v1 opt-in only; legacy task clients never receive another owner's task or output DTO. */
export async function listStudioResultFeed(user: SessionUser, moduleId: string, cursor?: string, liked = false) {
  if (!validStudioModuleId(moduleId, user.id)) throw new StudioPinError('模块编号无效');
  const scope = await studioPinScope(user, moduleId);
  const readable = scope ? await readableStudioPins(user, scope.presetId) : null;
  const allPins = readable?.pins || [];
  const marks = liked && allPins.length ? await prisma.contentReaction.findMany({ where: { user_id: user.id, content_key: { in: allPins.map(pin => `asset:${pin.assetId}`) },
    OR: [{ liked: true }, { favorited: true }] }, select: { content_key: true } }) : [];
  const likedAssets = liked ? await prisma.asset.findMany({ where: { id: { in: marks.map(m => m.content_key.slice(6)) },
    status: 'active' }, select: { id: true } }) : [];
  const likedIds = new Set(likedAssets.map(asset => asset.id));
  const pins = allPins.filter(pin => !liked || likedIds.has(pin.assetId));
  const epoch = fingerprint([scope?.presetId || null, readable?.document.revision || 0,
    pins.map(p => [p.assetId, p.taskId, p.pinnedAt])]);
  const state = readCursor(cursor, { user: user.id, module: moduleId, liked, epoch });
  if (state.pin > pins.length || state.task && state.pin < pins.length) throw new StudioPinError('结果目录已变化，请刷新目录', 409);
  const ownPinIds = pins.filter(p => p.ownerId === user.id).map(p => p.taskId);
  const where: Prisma.ImageStudioTaskWhereInput = {
    AND: [studioTemplateTaskWhere(user.id, moduleId), ...(liked ? [studioOutputTaskWhere] : [])], id: { notIn: ownPinIds },
  };
  if (!liked && state.task && !await prisma.imageStudioTask.findFirst({ where: { ...where, id: state.task }, select: { id: true } })) {
    throw new StudioPinError('结果目录已变化，请刷新目录', 409);
  }
  const pagePins = pins.slice(state.pin, state.pin + 24);
  const capacity = 24 - pagePins.length;
  const likedPage = liked ? await likedStudioTaskPage(prisma, user.id, moduleId, state.task || undefined, capacity > 0 ? capacity + 1 : 0, ownPinIds) : null;
  if (likedPage && !likedPage.valid) throw new StudioPinError('结果目录已变化，请刷新目录', 409);
  const ownTotal = likedPage?.total ?? await prisma.imageStudioTask.count({ where });
  const ordinary = likedPage ? likedPage.rows : capacity > 0 ? await prisma.imageStudioTask.findMany({ where,
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: capacity + 1,
    ...(state.task ? { cursor: { id: state.task }, skip: 1 } : {}) }) : [];
  const pageTasks = ordinary.slice(0, capacity);
  const ownPinnedTasks = await prisma.imageStudioTask.findMany({ where: { id: { in: pagePins.filter(p => p.ownerId === user.id).map(p => p.taskId) },
    owner_id: user.id, deleted_at: null, AND: [studioOutputTaskWhere] } });
  const tasks = await studioTaskDTOs(user.id, user.role === 'admin', [...ownPinnedTasks.filter(studioTaskHasViewableOutput), ...pageTasks]);
  const shared = pagePins.filter(p => p.ownerId !== user.id);
  const owners = await prisma.user.findMany({ where: { id: { in: shared.map(p => p.ownerId) } }, select: { id: true, name: true, avatar_url: true } });
  const byOwner = new Map(owners.map(o => [o.id, { name: o.name || '模板使用者', avatar_url: o.avatar_url }]));
  const sharedPins: SharedStudioPinnedImage[] = shared.map(pin => {
    const url = `/api/content-reactions/media?key=${encodeURIComponent(`asset:${pin.assetId}`)}`;
    return { id: `pin:${pin.assetId}`, assetId: pin.assetId, pinnedAt: pin.pinnedAt, createdAt: pin.task.created_at.toISOString(),
      owner: byOwner.get(pin.ownerId) || null, previewUrl: `${url}&variant=preview`, thumbnailUrl: `${url}&variant=thumbnail`,
      width: pin.asset.width, height: pin.asset.height };
  });
  const resultOrder = [...pagePins.map(p => p.ownerId === user.id ? p.taskId : `pin:${p.assetId}`), ...pageTasks.map(t => t.id)];
  const pin = state.pin + pagePins.length;
  const more = pin < pins.length || capacity === 0 ? pin < pins.length || ownTotal > 0 : ordinary.length > capacity;
  const next: Cursor = { ...state, pin, task: pageTasks.at(-1)?.id || state.task };
  // Re-check the shared revision after the owner projection; a racing mutation is not a stable page.
  const latest = scope ? await readableStudioPins(user, scope.presetId) : null;
  if (scope && (!latest || latest.document.revision !== readable?.document.revision
    || fingerprint(latest.pins.filter(p => !liked || likedIds.has(p.assetId)).map(p => [p.assetId, p.taskId, p.pinnedAt]))
      !== fingerprint(pins.map(p => [p.assetId, p.taskId, p.pinnedAt])))) throw new StudioPinError('置顶顺序已变化，请刷新目录', 409);
  return { protocol: STUDIO_RESULT_FEED, viewerId: user.id, tasks, sharedPins, resultOrder,
    eligiblePinAssetIds: pins.map(pin => pin.assetId),
    total: ownTotal + pins.length, nextCursor: more ? Buffer.from(JSON.stringify(next)).toString('base64url') : null,
    pinState: studioPinState(scope?.presetId || null, readable?.document.revision, allPins.map(p => p.assetId)) };
}
