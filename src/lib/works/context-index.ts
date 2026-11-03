import 'server-only';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { frozenStudioInputMainIds } from '@/lib/image-studio/input-main';
import { readPrivateImageTaskSnapshot } from '@/lib/image-studio/private-storage.server';
import { isPrivateMultiviewTask } from '@/lib/video/multiview-task-privacy';
import { readSafePrivateMultiviewInput } from '@/lib/video/multiview-private-create.server';
import type { WorkMethodSetting } from './context-types';

const hash = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function json(value: string | null) { try { return object(JSON.parse(value || '{}')); } catch { return {}; } }
const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,180}$/.test(value) ? value : null;
const version = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_.:+-]{1,256}$/.test(value) ? value : null;
const settingLabels: Record<string, string> = { model: '模型', quality: '画质', resolution: '分辨率', aspectRatio: '比例', duration: '时长（秒）', generateAudio: '生成声音', seed: '种子' };
export function safeWorkMethodSettings(value: unknown): WorkMethodSetting[] {
  const row = object(value);
  return Object.entries(settingLabels).flatMap(([key, label]) => {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean'
      || typeof value === 'string' && /^[A-Za-z0-9_.:/×+-]{1,100}$/.test(value)) return [{ key, label, value }];
    return [];
  });
}
export async function worksContextSchemaReady(db: Prisma.TransactionClient = prisma) {
  const rows = await db.$queryRaw<Array<{ name: string }>>`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('WorkContext','WorkSourceLink','WorkDerivedLink')`;
  return rows.length === 3;
}

/** Called only by background ingestion. Never indexes prompt text, private reference slots or provider/billing data. */
export async function indexWorkContext(db: Prisma.TransactionClient, work: { id: string; source_kind: string; source_id: string; author_id: string }, mediaVersionId: string) {
  let submissionKey: string | null = null, templateModule: string | null = null, templateId: string | null = null, templateVersion: string | null = null, templateToken: string | null = null;
  let settings: WorkMethodSetting[] = [];
  let complete = true;
  const links: Array<{ source_kind: string; source_id: string; relation: string }> = [];
  if (work.source_kind === 'image_task') {
    const task = await db.imageStudioTask.findUnique({ where: { id: work.source_id } });
    if (!task || task.owner_id !== work.author_id) return;
    const snapshot = json(task.snapshot_json);
    // Only the exact ordinary submission. Specialized parent batches can carry independent inputs.
    if (!snapshot.avatar && !snapshot.avatarLayout && !snapshot.characterLab && !task.tool_flow_run_id && snapshot.batchId === task.batch_id) {
      let inputFingerprint = snapshot.inputFingerprint;
      if (typeof inputFingerprint === 'string' && !/^[a-f0-9]{64}$/.test(inputFingerprint)) {
        try { inputFingerprint = readPrivateImageTaskSnapshot(task).inputFingerprint; }
        catch { inputFingerprint = null; complete = false; } // Output admission does not depend on private recipe key availability.
      }
      if (typeof inputFingerprint === 'string' && /^[a-f0-9]{64}$/.test(inputFingerprint)) submissionKey = hash(['image', task.owner_id, task.batch_id, inputFingerprint]);
    }
    const restored = object(snapshot.restoredSource);
    const shared = object(snapshot.sharedLive);
    const preset = task.source_preset_id || id(snapshot.sourcePresetId) || id(shared.presetId);
    if (preset) {
      templateModule = 'image-preset'; templateId = preset;
      templateVersion = version(snapshot.sharedSourceRevision) || version(restored.sharedSourceRevision);
      templateToken = version(shared.definitionToken);
    } else if (task.module_id && Number.isSafeInteger(snapshot.moduleRevision)) {
      templateModule = 'image-module'; templateId = task.module_id; templateVersion = `module:${snapshot.moduleRevision}`;
    }
    settings = safeWorkMethodSettings({ model: task.model, quality: task.quality, aspectRatio: task.aspect_ratio, resolution: snapshot.resolution });
    for (const sourceId of frozenStudioInputMainIds(task.snapshot_json, task.reference_ids) || []) links.push({ source_kind: 'asset', source_id: sourceId, relation: 'direct-input' });
    // The explicit original result, unlike a shared template's internal references, is a true derivation source.
    const reproduced = id(snapshot.reproducedFromTaskId);
    if (reproduced) links.push({ source_kind: 'image_task', source_id: reproduced, relation: 'restored' });
  } else if (work.source_kind === 'video_task') {
    const task = await db.videoTask.findUnique({ where: { id: work.source_id } });
    if (!task || (task.owner_user_id || task.user_id) !== work.author_id) return;
    settings = safeWorkMethodSettings({ model: task.model, resolution: task.resolution, aspectRatio: task.ratio, duration: task.duration, generateAudio: task.generate_audio, seed: task.seed });
    const protectedTask = isPrivateMultiviewTask(task);
    if (!protectedTask) {
      const snapshot = json(task.template_studio_snapshot_json), source = object(snapshot.sourceSnapshot), ref = object(source.templateVersion);
      if (id(ref.templateId) && (ref.templateSource === 'studio' || ref.templateSource === 'legacy')) {
        templateModule = ref.templateSource === 'studio' ? 'video-studio' : 'video-legacy'; templateId = id(ref.templateId);
        templateVersion = version(ref.versionId) || version(ref.sourceRevision);
      }
      // Only server-resolved reference IDs; URLs and arbitrary source metadata never establish a relation.
      let references: unknown; try { references = JSON.parse(task.reference_image_ids || '[]'); } catch { references = []; }
      if (Array.isArray(references) && references.length <= 32 && references.every(item => id(item))) {
        const rows = await db.referenceImage.findMany({ where: { id: { in: references as string[] }, asset_id: { not: null } }, select: { asset_id: true } });
        for (const row of rows) if (row.asset_id) links.push({ source_kind: 'asset', source_id: row.asset_id, relation: 'direct-input' });
      }
    } else {
      // Only this validated public input role is safe. Provider/system reference slots remain private.
      let mainReferenceId: string | null = null;
      try { mainReferenceId = readSafePrivateMultiviewInput(task).snapshot.mainReferenceImageId; }
      catch { /* Unknown private recipes grant no provenance projection. */ }
      if (mainReferenceId) {
        const reference = await db.referenceImage.findUnique({ where: { id: mainReferenceId }, select: { asset_id: true } });
        if (reference?.asset_id) links.push({ source_kind: 'asset', source_id: reference.asset_id, relation: 'direct-input' });
      }
    }
    for (const sourceId of [task.derived_from_task_id, task.source_draft_task_id]) if (sourceId) links.push({ source_kind: 'video_task', source_id: sourceId, relation: 'post-process' });
  } else if (work.source_kind === 'multiview_work') {
    const collage = await db.multiviewWork.findUnique({ where: { id: work.source_id }, select: { owner_id: true, source_task_id: true } });
    if (collage?.owner_id === work.author_id) links.push({ source_kind: 'video_task', source_id: collage.source_task_id, relation: 'collage' });
  }
  await db.workContext.upsert({ where: { work_id: work.id }, create: { work_id: work.id, media_version_id: mediaVersionId, schema_version: complete ? 1 : 0, submission_key: submissionKey,
    template_module: templateModule, template_id: templateId, template_version: templateVersion, template_token: templateToken, settings_json: JSON.stringify(settings) },
    update: { media_version_id: mediaVersionId, schema_version: complete ? 1 : 0, submission_key: submissionKey, template_module: templateModule,
      template_id: templateId, template_version: templateVersion, template_token: templateToken, settings_json: JSON.stringify(settings), indexed_at: new Date() } });
  await db.workSourceLink.deleteMany({ where: { work_id: work.id } });
  for (const link of Array.from(new Map(links.map(link => [`${link.source_kind}:${link.source_id}`, link])).values())) await db.workSourceLink.create({
    data: { work_id: work.id, media_version_id: mediaVersionId, ...link } });
}

/** A durable bounded checkpoint fills old catalog rows. Current media changes are caught again in the next cycle. */
export async function backfillWorkContexts(pageSize = 12) {
  return prisma.$transaction(async db => {
    if (!await worksContextSchemaReady(db)) return 0;
    const checkpoint = await db.workDiscoveryCheckpoint.upsert({ where: { source_kind: 'work_context:v1' }, create: { source_kind: 'work_context:v1' }, update: {} });
    const upper = checkpoint.upper_at || new Date();
    const rows = await db.work.findMany({ where: { current_version_id: { not: null }, admitted_at: { lte: upper },
      ...(checkpoint.cursor_id ? { id: { gt: checkpoint.cursor_id } } : {}) }, orderBy: { id: 'asc' }, take: Math.min(40, Math.max(1, pageSize)) });
    for (const work of rows) {
      const indexed = await db.workContext.findUnique({ where: { work_id: work.id }, select: { media_version_id: true, schema_version: true } });
      if (indexed?.media_version_id !== work.current_version_id || indexed.schema_version !== 1) await indexWorkContext(db, work, work.current_version_id!);
    }
    const last = rows[rows.length - 1];
    await db.workDiscoveryCheckpoint.update({ where: { source_kind: checkpoint.source_kind }, data: rows.length < pageSize
      ? { cursor_id: null, upper_at: null, cycles: { increment: 1 } } : { cursor_id: last.id, upper_at: upper } });
    return rows.length;
  }, { timeout: 15000 });
}
