import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { authorizeStudioAssets } from './assets';
import { requireStudioUser } from './common';
import { StudioError } from './errors';
import { getStudioTemplate } from './templates';
import { normalizeRecipe, stableJson } from './validation';
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
  return {
    runId: run.id,
    prompt: run.prompt || snapshot.prompt,
    parameters: snapshot.parameters,
    assets: snapshot.assets,
    snapshot,
    legacyTemplateId,
  };
}

export async function getStudioRunHandoff(user: SessionUser, runId: string) {
  return authorizeStudioRunForGeneration(user, runId);
}
