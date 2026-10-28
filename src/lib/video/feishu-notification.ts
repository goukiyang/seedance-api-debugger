import type { Prisma, VideoTask } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { feedbackConfig, recipientIdentity } from '@/lib/feedback/notification';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { isPrivateMultiviewTask } from './multiview-task-privacy';
import { isTaskHiddenFromRegularUsers } from '@/lib/tasks/retention';
import { VIDEO_FEISHU_TYPE, VIDEO_FEISHU_PREFERENCE, VideoFeishuError, normalizeVideoFeishuChoice, videoFeishuHash, videoFeishuId,
  newVideoFeishuEvent, parseVideoFeishuEvent, videoFeishuUuid, videoFeishuCanCancel, videoFeishuStatus, type VideoFeishuPreference } from './feishu-contract';

type Db = Prisma.TransactionClient;
type Stored = { version: 1; enabled: boolean; revision: number; identity: string | null };
export async function videoFeishuActor(db: Db, userId: string): Promise<SessionUser & { feishu_open_id: string | null; feishu_tenant_key: string | null }> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, username: true, email: true, role: true, account_type: true,
    user_profile: true, feature_profile_id: true, status: true, expires_at: true, feishu_open_id: true, feishu_tenant_key: true } });
  if (!user || user.status !== 'active' || user.expires_at && user.expires_at.getTime() <= Date.now()
    || !['admin', 'user'].includes(user.role) || !['internal', 'external'].includes(user.account_type)) throw new VideoFeishuError('account_unavailable', 401);
  return user as SessionUser & { feishu_open_id: string | null; feishu_tenant_key: string | null };
}
export function videoFeishuBinding(user: { id: string; feishu_open_id: string | null; feishu_tenant_key: string | null }) {
  const config = feedbackConfig();
  return config.appId && config.appSecret && config.tenant && user.feishu_tenant_key === config.tenant
    && /^ou_[A-Za-z0-9_-]{1,180}$/.test(user.feishu_open_id || '')
    ? recipientIdentity(user.id, user.feishu_open_id!, config.appId, config.tenant) : null;
}
async function preferenceState(db: Db, userId: string) {
  const user = await videoFeishuActor(db, userId), identity = videoFeishuBinding(user);
  const row = await db.userPreference.findUnique({ where: { user_id_key: { user_id: userId, key: VIDEO_FEISHU_PREFERENCE } } });
  let stored: Stored = { version: 1, enabled: false, revision: 0, identity: null };
  if (row) {
    try { stored = JSON.parse(row.value_json); } catch { throw new VideoFeishuError('preference_unavailable', 503); }
    if (stored?.version !== 1 || typeof stored.enabled !== 'boolean' || !Number.isSafeInteger(stored.revision) || stored.revision < 1
      || stored.identity !== null && !videoFeishuHash(stored.identity)) throw new VideoFeishuError('preference_unavailable', 503);
  }
  const view: VideoFeishuPreference = { version: 1, enabled: Boolean(identity && stored.enabled && stored.identity === identity), revision: stored.revision, available: Boolean(identity) };
  return { user, row, stored, identity, view };
}
export async function readVideoFeishuPreference(db: Db, userId: string) { return (await preferenceState(db, userId)).view; }
export async function saveVideoFeishuPreference(db: Db, userId: string, input: { version: unknown; enabled: unknown; revision: unknown }) {
  if (!input || input.version !== 1 || typeof input.enabled !== 'boolean' || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0
    || Object.keys(input).some(key => !['version', 'enabled', 'revision'].includes(key))) throw new VideoFeishuError('invalid_preference', 400);
  const state = await preferenceState(db, userId);
  if (state.stored.revision !== input.revision) throw new VideoFeishuError('preference_changed', 409);
  if (input.enabled && !state.identity) throw new VideoFeishuError('binding_unavailable', 409);
  const next: Stored = { version: 1, enabled: input.enabled, revision: state.stored.revision + 1, identity: state.identity };
  if (!Number.isSafeInteger(next.revision)) throw new VideoFeishuError('preference_changed', 409);
  if (state.row) {
    const result = await db.userPreference.updateMany({ where: { id: state.row.id, user_id: userId, key: VIDEO_FEISHU_PREFERENCE, value_json: state.row.value_json }, data: { value_json: JSON.stringify(next) } });
    if (result.count !== 1) throw new VideoFeishuError('preference_changed', 409);
  } else {
    try { await db.userPreference.create({ data: { user_id: userId, key: VIDEO_FEISHU_PREFERENCE, value_json: JSON.stringify(next) } }); }
    catch (error) { if ((error as { code?: string }).code === 'P2002') throw new VideoFeishuError('preference_changed', 409); throw error; }
  }
  return { version: 1 as const, enabled: next.enabled, revision: next.revision, available: Boolean(state.identity) };
}
export async function enqueueVideoFeishuNotification(tx: Db, actorId: string,
  task: Pick<VideoTask, 'id' | 'user_id' | 'source_metadata_json'>, choice: unknown): Promise<void> {
  const selected = normalizeVideoFeishuChoice(choice);
  if (!selected.enabled) return;
  if (!videoFeishuId(task.id) || task.user_id !== actorId || isPrivateMultiviewTask(task)) throw new VideoFeishuError('notification_source_forbidden', 403);
  const actual = await tx.videoTask.findUnique({ where: { id: task.id }, select: { id: true, user_id: true, source_metadata_json: true } });
  if (!actual || actual.user_id !== actorId || isPrivateMultiviewTask(actual)) throw new VideoFeishuError('notification_source_forbidden', 403);
  const state = await preferenceState(tx, actorId);
  if (!state.identity || !state.view.enabled || state.view.revision !== selected.preferenceRevision) throw new VideoFeishuError('preference_changed', 409);
  const event = newVideoFeishuEvent(task.id, actorId, state.identity, selected);
  const existing = await tx.notification.findUnique({ where: { id: event.eventId } });
  if (existing) {
    const previous = parseVideoFeishuEvent(existing.metadata_json);
    if (existing.type !== VIDEO_FEISHU_TYPE || existing.target_user_id !== actorId || !previous || previous.taskId !== task.id
      || previous.actorId !== actorId || previous.identity !== event.identity || previous.choice.preferenceRevision !== selected.preferenceRevision) throw new VideoFeishuError('notification_event_conflict', 409);
    return;
  }
  await tx.notification.create({ data: { id: event.eventId, type: VIDEO_FEISHU_TYPE, channel: 'feishu', status: 'pending',
    target_user_id: actorId, actor_user_id: actorId, title: '视频完成通知', body: null, metadata_json: JSON.stringify(event) } });
}
export async function authorizedVideoFeishuTask(db: Db, actorId: string, taskId: string) {
  if (!videoFeishuId(taskId)) throw new VideoFeishuError('task_unavailable', 404);
  const actor = await videoFeishuActor(db, actorId);
  const task = await db.videoTask.findUnique({ where: { id: taskId }, select: { id: true, user_id: true, owner_user_id: true, project_id: true,
    retention_status: true, source_metadata_json: true, local_status: true, local_video_path: true, public_video_url: true,
    public_video_storage_provider: true, public_video_storage_key: true, public_video_file_size: true, public_video_cached_at: true } });
  if (!task || task.user_id !== actorId || isPrivateMultiviewTask(task) || isTaskHiddenFromRegularUsers(task)) throw new VideoFeishuError('task_unavailable', 404);
  try { await assertCanViewTask(actor, task, db); }
  catch (error) { if (error instanceof AuthError) throw new VideoFeishuError('task_unavailable', 404); throw error; }
  return { actor, task };
}
async function taskEvent(db: Db, actorId: string, taskId: string) {
  await authorizedVideoFeishuTask(db, actorId, taskId);
  const row = await db.notification.findUnique({ where: { id: videoFeishuUuid(taskId, 'event') } });
  if (!row) return { row: null, meta: null };
  const meta = parseVideoFeishuEvent(row.metadata_json);
  if (!meta || row.type !== VIDEO_FEISHU_TYPE || row.channel !== 'feishu' || row.target_user_id !== actorId || meta.actorId !== actorId || meta.taskId !== taskId) throw new VideoFeishuError('notification_unavailable', 503);
  return { row, meta };
}
export async function readVideoFeishuStatus(db: Db, actorId: string, taskId: string) { return videoFeishuStatus((await taskEvent(db, actorId, taskId)).meta); }
export async function cancelVideoFeishuNotification(db: Db, actorId: string, taskId: string) {
  const { row, meta } = await taskEvent(db, actorId, taskId);
  if (!row || !meta) return videoFeishuStatus(null);
  if (meta.state === 'cancelled') return videoFeishuStatus(meta);
  if (row.status !== 'pending' || !videoFeishuCanCancel(meta)) throw new VideoFeishuError('notification_cannot_cancel', 409);
  const next = { ...meta, state: 'cancelled' as const, reason: 'cancelled' };
  const result = await db.notification.updateMany({ where: { id: row.id, type: VIDEO_FEISHU_TYPE, status: 'pending', metadata_json: row.metadata_json },
    data: { status: 'failed', metadata_json: JSON.stringify(next), error_message: 'video_feishu_cancelled' } });
  if (result.count !== 1) throw new VideoFeishuError('notification_changed', 409);
  return videoFeishuStatus(next);
}
