import { studioTaskHasViewableOutput, studioOutputFormatForMime } from './dimension-mismatch';
import { imageFeishuMode } from './feishu-source';
import { IMAGE_FEISHU_ORIGINAL_TYPE, IMAGE_FEISHU_ORIGINAL_MAX_BYTES, originalImageFeishuUuid, newOriginalImageFeishuEvent, parseOriginalImageFeishuEvent, originalImageFeishuStatus, originalImageFeishuCanCancel, originalImageFeishuCanRetry } from './feishu-original-contract';
import type { Prisma } from '@prisma/client';
import { videoFeishuActor, videoFeishuBinding } from '@/lib/video/feishu-notification';
import { VideoFeishuError, videoFeishuId } from '@/lib/video/feishu-contract';
import { canUseCompanyTemplates } from './access';
import { canReadStudioAsset } from './protected-assets';
import { IMAGE_FEISHU_NEW_REQUESTS_ENABLED, IMAGE_FEISHU_ORIGINAL_REQUESTS_ENABLED } from './feishu-capability';
import { IMAGE_FEISHU_TYPE, IMAGE_FEISHU_PREFERENCE, normalizeImageFeishuChoice, parseFrozenImageFeishuChoice,
  imageFeishuUuid, newImageFeishuEvent, parseImageFeishuEvent, imageFeishuCanCancel, imageFeishuCanRetry, imageFeishuStatus,
  type ImageFeishuChoice, type ImageFeishuPreference, type FrozenImageFeishuChoice } from './feishu-contract';

type Db = Prisma.TransactionClient;
type Stored = { version: 1; enabled: boolean; revision: number; identity: string | null };
async function actor(db: Db, actorId: string) {
  const user = await videoFeishuActor(db, actorId);
  if (!canUseCompanyTemplates(user)) throw new VideoFeishuError('account_unavailable', 403);
  return user;
}
async function preference(db: Db, actorId: string) {
  const user = await actor(db, actorId), identity = videoFeishuBinding(user);
  const row = await db.userPreference.findUnique({ where: { user_id_key: { user_id: actorId, key: IMAGE_FEISHU_PREFERENCE } } });
  let value: Stored = { version: 1, enabled: false, revision: 0, identity: null };
  try { if (row) value = JSON.parse(row.value_json); } catch { throw new VideoFeishuError('preference_unavailable', 503); }
  if (value.version !== 1 || typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.revision) || value.revision < (row ? 1 : 0)
    || value.identity !== null && !/^[a-f0-9]{64}$/.test(value.identity)) throw new VideoFeishuError('preference_unavailable', 503);
  const available = Boolean(identity && IMAGE_FEISHU_NEW_REQUESTS_ENABLED);
  const view: ImageFeishuPreference = { version: 1, enabled: Boolean(available && value.enabled && value.identity === identity), revision: value.revision, available };
  return { row, value, view, identity };
}
export async function readImageFeishuPreference(db: Db, actorId: string) { return (await preference(db, actorId)).view; }
export async function saveImageFeishuPreference(db: Db, actorId: string, input: { version: unknown; enabled: unknown; revision: unknown }) {
  if (!input || input.version !== 1 || typeof input.enabled !== 'boolean' || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0
    || Object.keys(input).some(key => !['version', 'enabled', 'revision'].includes(key))) throw new VideoFeishuError('invalid_preference', 400);
  const state = await preference(db, actorId);
  if (state.value.revision !== input.revision) throw new VideoFeishuError('preference_changed', 409);
  if (input.enabled && !state.view.available) throw new VideoFeishuError('binding_unavailable', 409);
  const next: Stored = { version: 1, enabled: input.enabled, revision: state.value.revision + 1, identity: state.identity };
  if (!Number.isSafeInteger(next.revision)) throw new VideoFeishuError('preference_changed', 409);
  if (state.row) {
    if ((await db.userPreference.updateMany({ where: { id: state.row.id, user_id: actorId, key: IMAGE_FEISHU_PREFERENCE, value_json: state.row.value_json },
      data: { value_json: JSON.stringify(next) } })).count !== 1) throw new VideoFeishuError('preference_changed', 409);
  } else {
    try { await db.userPreference.create({ data: { user_id: actorId, key: IMAGE_FEISHU_PREFERENCE, value_json: JSON.stringify(next) } }); }
    catch (error) { if ((error as { code?: string }).code === 'P2002') throw new VideoFeishuError('preference_changed', 409); throw error; }
  }
  return { version: 1 as const, enabled: next.enabled, revision: next.revision, available: state.view.available };
}
/** Called only inside the new request's acceptance transaction, after original-request recovery. */
export async function freezeImageFeishuChoice(db: Db, actorId: string, choice: ImageFeishuChoice | undefined): Promise<FrozenImageFeishuChoice | null> {
  const selected = normalizeImageFeishuChoice(choice);
  if (!selected?.enabled) return null;
  if (!IMAGE_FEISHU_NEW_REQUESTS_ENABLED) throw new VideoFeishuError('notification_accepting_disabled', 503);
  const current = await preference(db, actorId);
  if (!current.identity || !current.view.enabled || current.view.revision !== selected.preferenceRevision) throw new VideoFeishuError('preference_changed', 409);
  return { version: 1, actorId, identity: current.identity, choice: selected };
}
/** A delayed batch child uses the parent's already accepted choice, never today's preference. */
export async function enqueueFrozenImageFeishuNotification(db: Db, task: { id: string; owner_id: string }, frozen: FrozenImageFeishuChoice | null | undefined) {
  if (!frozen) return;
  const binding = parseFrozenImageFeishuChoice(frozen);
  if (!binding || binding.actorId !== task.owner_id || !videoFeishuId(task.id)) throw new VideoFeishuError('notification_source_forbidden', 403);
  const actual = await db.imageStudioTask.findUnique({ where: { id: task.id }, select: { owner_id: true } });
  if (!actual || actual.owner_id !== binding.actorId) throw new VideoFeishuError('notification_source_forbidden', 403);
  const event = newImageFeishuEvent(task.id, binding), previous = await db.notification.findUnique({ where: { id: event.eventId } });
  if (previous) {
    const parsed = parseImageFeishuEvent(previous.metadata_json);
    if (previous.type !== IMAGE_FEISHU_TYPE || previous.channel !== 'feishu' || previous.target_user_id !== binding.actorId
      || !parsed || parsed.taskId !== task.id || parsed.identity !== binding.identity
      || JSON.stringify(parsed.choice) !== JSON.stringify(binding.choice)) throw new VideoFeishuError('notification_event_conflict', 409);
    return;
  }
  await db.notification.create({ data: { id: event.eventId, type: IMAGE_FEISHU_TYPE, channel: 'feishu', status: 'pending',
    target_user_id: binding.actorId, actor_user_id: binding.actorId, title: '图片完成通知', body: null, metadata_json: JSON.stringify(event) } });
}
export async function authorizedImageFeishuTask(db: Db, actorId: string, taskId: string) {
  if (!videoFeishuId(taskId)) throw new VideoFeishuError('task_unavailable', 404);
  const user = await actor(db, actorId);
  const task = await db.imageStudioTask.findUnique({ where: { id: taskId }, select: { id: true, owner_id: true, module_id: true, batch_id: true,
    status: true, asset_id: true, deleted_at: true, usage_json: true, finished_at: true } });
  if (!task || task.owner_id !== actorId || task.deleted_at) throw new VideoFeishuError('task_unavailable', 404);
  const asset = task.asset_id ? await db.asset.findFirst({ where: { id: task.asset_id, owner_id: actorId, type: 'image', status: 'active' },
    select: { id: true, owner_id: true, original_url: true, mime_type: true, file_size: true, hash: true, width: true, height: true } }) : null;
  if (task.asset_id && (!asset || !await canReadStudioAsset(user, asset, db))) throw new VideoFeishuError('task_unavailable', 404);
  return { actor: user, task, asset };
}
async function eventFor(db: Db, actorId: string, taskId: string) {
  await authorizedImageFeishuTask(db, actorId, taskId);
  const row = await db.notification.findUnique({ where: { id: imageFeishuUuid(taskId, 'event') } });
  if (!row) return { row: null, meta: null };
  const meta = parseImageFeishuEvent(row.metadata_json);
  if (!meta || row.type !== IMAGE_FEISHU_TYPE || row.channel !== 'feishu' || row.target_user_id !== actorId || meta.actorId !== actorId) throw new VideoFeishuError('notification_unavailable', 503);
  return { row, meta };
}
export async function readImageFeishuStatus(db: Db, actorId: string, taskId: string) { return imageFeishuStatus((await eventFor(db, actorId, taskId)).meta); }
/** Output completion only touches its existing opt-in event; no scan or historical backfill. */
export async function wakeImageFeishuAfterOutputReady(db: Db, task: { id: string; owner_id: string }) {
  const row = await db.notification.findUnique({ where: { id: imageFeishuUuid(task.id, 'event') } });
  const meta = row && parseImageFeishuEvent(row.metadata_json);
  if (!row || !meta || row.type !== IMAGE_FEISHU_TYPE || row.channel !== 'feishu' || row.target_user_id !== task.owner_id
    || meta.actorId !== task.owner_id || !['pending', 'failed'].includes(meta.state) || (meta.leaseUntil || 0) > Date.now()
    || !['generation_not_ready', 'generation_wait_ended'].includes(meta.reason || '') || meta.externalStartedAt !== null
    || meta.upload.startedAt !== null || [meta.image, meta.explanation].some(s => s.firstSendAt !== null || s.receiptId || s.ambiguous)) return false;
  meta.state = 'pending'; meta.reason = null; meta.nextAttemptAt = Date.now(); meta.leaseToken = null; meta.leaseUntil = null;
  for (const s of [meta.image, meta.explanation]) if (s.state === 'failed') s.state = 'pending';
  return (await db.notification.updateMany({ where: { id: row.id, type: IMAGE_FEISHU_TYPE, status: row.status, metadata_json: row.metadata_json },
    data: { status: 'pending', error_message: null, metadata_json: JSON.stringify(meta) } })).count === 1;
}
/** Batched, owner-only projection. It never exposes metadata, recipients, upload keys or prompts. */
export async function imageFeishuTaskStatuses(db: Db, ownerId: string, ids: string[]) {
  const rows = ids.length ? await db.notification.findMany({ where: { type: { in: [IMAGE_FEISHU_TYPE, IMAGE_FEISHU_ORIGINAL_TYPE] }, channel: 'feishu', target_user_id: ownerId,
    id: { in: ids.flatMap(id => [imageFeishuUuid(id, 'event'), originalImageFeishuUuid(id, 'event')]) } }, select: { id: true, metadata_json: true } }) : [];
  return new Map(ids.map(id => {
    const raw = rows.find(row => row.id === imageFeishuUuid(id, 'event')); const meta = raw && parseImageFeishuEvent(raw.metadata_json);
    const status = imageFeishuStatus(meta && meta.actorId === ownerId && meta.taskId === id ? meta : null);
    const originalRow = rows.find(row => row.id === originalImageFeishuUuid(id, 'event'));
    const original = originalRow && parseOriginalImageFeishuEvent(originalRow.metadata_json);
    const originalView = original && original.actorId === ownerId && original.taskId === id ? originalImageFeishuStatus(original) : originalRow
      ? { ...originalImageFeishuStatus(null), state: 'unknown', canSend: false, reason: 'notification_unavailable' } : null;
    return [id, { ...(raw && !meta ? { ...status, state: 'unknown', reason: 'notification_unavailable' } : status), ...(originalView ? { original: originalView } : {}) }] as const;
  }));
}
export async function changeImageFeishuNotification(db: Db, actorId: string, taskId: string, action: 'cancel' | 'retry') {
  const { row, meta } = await eventFor(db, actorId, taskId);
  if (!row || !meta) throw new VideoFeishuError('notification_unavailable', 404);
  if (action === 'cancel') {
    if (meta.state === 'cancelled') return imageFeishuStatus(meta);
    if (!imageFeishuCanCancel(meta)) throw new VideoFeishuError('notification_cannot_cancel', 409);
    meta.state = 'cancelled'; meta.reason = 'cancelled';
  } else {
    if (!imageFeishuCanRetry(meta)) throw new VideoFeishuError('notification_cannot_retry', 409);
    const current = await authorizedImageFeishuTask(db, actorId, taskId);
    if (videoFeishuBinding(current.actor) !== meta.identity) throw new VideoFeishuError('binding_changed', 409);
    meta.state = 'pending'; meta.reason = null; meta.preparations = 0; meta.nextAttemptAt = Date.now();
    for (const step of [meta.image, meta.explanation]) if (!step.receiptId && step.firstSendAt === null) step.state = 'pending';
  }
  if ((await db.notification.updateMany({ where: { id: row.id, type: IMAGE_FEISHU_TYPE, channel: 'feishu', status: row.status, metadata_json: row.metadata_json },
    data: { status: action === 'cancel' ? 'failed' : 'pending', error_message: action === 'cancel' ? 'image_feishu_cancelled' : null, metadata_json: JSON.stringify(meta) } })).count !== 1) throw new VideoFeishuError('notification_changed', 409);
  return imageFeishuStatus(meta);
}

/** Explicit original delivery has its own immutable per-output operation and never reopens an auto notice. */
export async function readOriginalImageFeishuStatus(db: Db, actorId: string, taskId: string) {
  const current = await authorizedImageFeishuTask(db, actorId, taskId), identity = videoFeishuBinding(current.actor);
  const row = await db.notification.findUnique({ where: { id: originalImageFeishuUuid(taskId, 'event') } });
  if (row) {
    const meta = parseOriginalImageFeishuEvent(row.metadata_json);
    if (!meta || row.type !== IMAGE_FEISHU_ORIGINAL_TYPE || row.channel !== 'feishu' || row.target_user_id !== actorId || meta.actorId !== actorId) throw new VideoFeishuError('notification_unavailable', 503);
    return { ...originalImageFeishuStatus(meta), fileSize: meta.source?.size ?? current.asset?.file_size ?? null };
  }
  const automatic = await db.notification.findUnique({ where: { id: imageFeishuUuid(taskId, 'event') } });
  if (automatic) {
    const meta = parseImageFeishuEvent(automatic.metadata_json);
    if (!meta || automatic.type !== IMAGE_FEISHU_TYPE || automatic.channel !== 'feishu' || automatic.target_user_id !== actorId || meta.actorId !== actorId) throw new VideoFeishuError('notification_unavailable', 503);
    const sameOriginal = meta.identity === identity && meta.assetId === current.asset?.id && meta.contentHash === current.asset?.hash
      && meta.mode === 'image' && (meta.version === 1 || meta.presentation?.kind === 'original' && meta.presentation.contentHash === current.asset?.hash);
    if (sameOriginal && meta.image.receiptId) return { ...originalImageFeishuStatus(null), state: 'sent', canSend: false, originalSent: true,
      mode: 'image' as const, fileSize: current.asset?.file_size ?? null, source: 'automatic' as const };
    const format = studioOutputFormatForMime(current.asset?.mime_type);
    const automaticOriginal = meta.identity === identity && meta.mode === 'image' && (sameOriginal || meta.sourceVersion === null && format && current.asset
      && imageFeishuMode(format.extension === 'jpg' ? 'jpeg' : format.extension, current.asset.file_size || 0, current.asset.width || 0, current.asset.height || 0).mode === 'image');
    if (automaticOriginal && (['pending','unknown'].includes(meta.state) || ['uploading','unknown'].includes(meta.upload.state) || meta.image.ambiguous)) return { ...originalImageFeishuStatus(null), state: meta.state === 'unknown' ? 'unknown' : 'pending',
      canSend: false, mode: 'image' as const, fileSize: current.asset?.file_size ?? null, source: 'automatic' as const, reason: 'automatic_original_pending' };
  }
  const base = { ...originalImageFeishuStatus(null), fileSize: current.asset?.file_size ?? null };
  const reason = !identity ? 'binding_unavailable' : !studioTaskHasViewableOutput(current.task) || !current.asset ? 'generation_not_completed'
    : (current.asset.file_size || 0) > IMAGE_FEISHU_ORIGINAL_MAX_BYTES ? 'image_original_too_large'
      : !IMAGE_FEISHU_ORIGINAL_REQUESTS_ENABLED ? 'notification_accepting_disabled' : null;
  return { ...base, canSend: !reason, reason };
}
export async function requestOriginalImageFeishu(db: Db, actorId: string, taskId: string) {
  const view = await readOriginalImageFeishuStatus(db, actorId, taskId);
  if (view.state !== 'not_requested') return view;
  if (!view.canSend) throw new VideoFeishuError(view.reason || 'notification_unavailable', 409);
  const current = await authorizedImageFeishuTask(db, actorId, taskId), identity = videoFeishuBinding(current.actor);
  if (!identity) throw new VideoFeishuError('binding_unavailable', 409);
  const meta = newOriginalImageFeishuEvent(taskId, actorId, identity);
  try { await db.notification.create({ data: { id: meta.eventId, type: IMAGE_FEISHU_ORIGINAL_TYPE, channel: 'feishu', status: 'pending',
    target_user_id: actorId, actor_user_id: actorId, title: '原图', body: null, metadata_json: JSON.stringify(meta) } }); }
  catch (error) { if ((error as { code?: string }).code !== 'P2002') throw error; }
  return readOriginalImageFeishuStatus(db, actorId, taskId);
}
export async function changeOriginalImageFeishu(db: Db, actorId: string, taskId: string, action: 'cancel' | 'retry') {
  const current = await authorizedImageFeishuTask(db, actorId, taskId);
  const row = await db.notification.findUnique({ where: { id: originalImageFeishuUuid(taskId, 'event') } });
  const meta = row && parseOriginalImageFeishuEvent(row.metadata_json);
  if (!row || !meta || row.type !== IMAGE_FEISHU_ORIGINAL_TYPE || row.channel !== 'feishu' || row.target_user_id !== actorId || meta.actorId !== actorId) throw new VideoFeishuError('notification_unavailable', 404);
  if (action === 'cancel') {
    if (!originalImageFeishuCanCancel(meta)) throw new VideoFeishuError('notification_cannot_cancel', 409);
    meta.state = 'cancelled'; meta.reason = 'cancelled';
  } else {
    if (!originalImageFeishuCanRetry(meta)) throw new VideoFeishuError('notification_cannot_retry', 409);
    if (videoFeishuBinding(current.actor) !== meta.identity) throw new VideoFeishuError('binding_changed', 409);
    meta.state = 'pending'; meta.reason = meta.version === 1 && meta.reason === 'image_upload_rejected' ? meta.reason : null; meta.preparations = 0; meta.nextAttemptAt = Date.now(); if (meta.version === 2 && meta.message.receiptId && meta.mode === 'file') meta.navigationStep.state = 'pending';
    else meta.message.state = 'pending';
  }
  if ((await db.notification.updateMany({ where: { id: row.id, type: IMAGE_FEISHU_ORIGINAL_TYPE, status: row.status, metadata_json: row.metadata_json },
    data: { status: action === 'cancel' ? 'failed' : 'pending', error_message: action === 'cancel' ? 'image_feishu_cancelled' : null, metadata_json: JSON.stringify(meta) } })).count !== 1) throw new VideoFeishuError('notification_changed', 409);
  return readOriginalImageFeishuStatus(db, actorId, taskId);
}
