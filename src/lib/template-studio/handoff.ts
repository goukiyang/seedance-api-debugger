import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { authorizeStudioAssets } from './assets';
import { makeFingerprint, requireStudioUser } from './common';
import { StudioError } from './errors';
import { getStudioTemplate } from './templates';
import { normalizeRecipe, normalizePrompt, stableJson } from './validation';
import { containsPrivateContext, publicRunSnapshot, visibleRunPrompt } from './projection';
import type { StudioGenerationHandoff, StudioRunSnapshot } from './types';

function readRunSnapshot(json: string): StudioRunSnapshot {
  try {
    const snapshot = JSON.parse(json) as StudioRunSnapshot;
    if (!snapshot || typeof snapshot.prompt !== 'string' || !snapshot.owner || !Array.isArray(snapshot.assets) || !snapshot.parameters) throw new Error('invalid');
    return snapshot;
  } catch {
    throw new StudioError('运行快照无法读取', 500, 'UNAVAILABLE');
  }
}

export async function ensureStudioSnapshotSourceStillUsable(user: SessionUser, snapshot: StudioRunSnapshot) {
  const ref = snapshot.templateVersion;
  if (!ref) return null;
  if (ref.templateSource === 'legacy') {
    const current = await getStudioTemplate(user, ref.templateId, 'legacy');
    if (!ref.sourceRevision || ref.sourceRevision !== `legacy:${current.template.updatedAt}`) {
      throw new StudioError('旧模板内容已变化，请回原生成流程重新确认', 409, 'CONFLICT');
    }
    return ref.templateId;
  }
  const current = await prisma.videoStudioTemplate.findUnique({ where: { id: ref.templateId } });
  if (!current || current.status === 'archived') throw new StudioError('模板已归档或撤销，不能提交生成', 409, 'CONFLICT');
  await getStudioTemplate(user, ref.templateId, 'studio');
  if (ref.versionId) {
    const version = await prisma.videoStudioTemplateVersion.findFirst({ where: { id: ref.versionId, template_id: ref.templateId } });
    if (!version || stableJson(normalizeRecipe(JSON.parse(version.recipe_json))) !== stableJson(snapshot.recipe)) {
      throw new StudioError('模板版本不可用，请回工作台重新确认', 409, 'CONFLICT');
    }
  } else if ((ref.sourceRevision && ref.sourceRevision !== `studio:${current.revision}`)
    || stableJson(normalizeRecipe(JSON.parse(current.recipe_json))) !== stableJson(snapshot.recipe)) {
    throw new StudioError('模板内容已变化，请回工作台重新确认', 409, 'CONFLICT');
  }
  return null;
}

export async function authorizeStudioRunForGeneration(user: SessionUser, runId: string): Promise<StudioGenerationHandoff> {
  requireStudioUser(user);
  const run = await prisma.videoStudioRun.findFirst({ where: { id: runId, owner_user_id: user.id } });
  if (!run) throw new StudioError('运行记录不存在或无权访问', 404, 'NOT_FOUND');
  if (run.status !== 'succeeded') throw new StudioError('只有已完成的运行记录可以提交生成', 409, 'CONFLICT');
  const snapshot = readRunSnapshot(run.snapshot_json);
  const legacyTemplateId = await ensureStudioSnapshotSourceStillUsable(user, snapshot);
  await authorizeStudioAssets(user, snapshot.assets);
  const prompt = visibleRunPrompt(run);
  if (!prompt) throw new StudioError('这条记录没有可安全使用的文案，请重新整理', 409, 'CONFLICT');
  return {
    runId: run.id,
    prompt,
    parameters: snapshot.parameters,
    assets: snapshot.assets,
    snapshot: publicRunSnapshot(snapshot),
    legacyTemplateId,
  };
}

export async function getStudioRunHandoff(user: SessionUser, runId: string) {
  return authorizeStudioRunForGeneration(user, runId);
}

export async function saveStudioFinalText(user: SessionUser, runId: string, input: unknown) {
  requireStudioUser(user);
  const value = input as { prompt?: unknown };
  if (typeof value?.prompt !== 'string' || value.prompt.length > 12000) throw new StudioError('最终文案必须是12000字以内的文本', 400, 'INVALID');
  const prompt = normalizePrompt(value?.prompt).trim();
  if (!prompt) throw new StudioError('请先填写最终文案', 400, 'INVALID');
  const run = await prisma.videoStudioRun.findFirst({ where: { id: runId, owner_user_id: user.id } });
  if (!run) throw new StudioError('记录不存在或无权访问', 404, 'NOT_FOUND');
  if (run.status !== 'succeeded') throw new StudioError('请等待文案完成后再继续', 409, 'CONFLICT');
  const snapshot = readRunSnapshot(run.snapshot_json);
  await ensureStudioSnapshotSourceStillUsable(user, snapshot);
  await authorizeStudioAssets(user, snapshot.assets);
  if (containsPrivateContext(prompt, snapshot)) throw new StudioError('文案疑似包含内部规则，不能带到视频生成', 400, 'INVALID');
  const fingerprint = makeFingerprint({ sourceRunId: run.id, prompt });
  const requestId = `final:${fingerprint}`;
  // An immutable, idempotent revision retains the original run and makes all downstream consumers use the final text.
  const finalSnapshot: StudioRunSnapshot = { ...snapshot, sourceRunId: run.id, prompt,
    privateContext: snapshot.privateContext || { global: '', module: snapshot.recipe?.instruction || '', globalRevision: 0, moduleRevision: 0 } };
  const revision = await prisma.videoStudioRun.upsert({
    where: { owner_user_id_request_id: { owner_user_id: user.id, request_id: requestId } },
    update: {},
    create: {
      owner_user_id: user.id, draft_id: run.draft_id, draft_revision: run.draft_revision,
      request_id: requestId, request_fingerprint: fingerprint, source: run.source, mode: 'direct',
      status: 'succeeded', delivery_state: 'not_sent', prompt, snapshot_json: JSON.stringify(finalSnapshot), completed_at: new Date(),
    },
  });
  return { runId: revision.id, sourceRunId: run.id };
}
