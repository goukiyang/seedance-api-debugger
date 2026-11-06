import { createHash } from 'node:crypto';
import type { SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { StudioError, publicImageTaskStatus } from '@/lib/image-studio/tasks';
import { canReadStudioAsset } from '@/lib/image-studio/protected-assets';
import { ownedLabAsset, labOutput } from './media';
import { labConfig, labId, labText, parseLabDraft, readLabPlan, readLabWorkspace } from './store';
import { faceLabPrompt, labViewPrompt, resultLabPrompt } from './prompts';
import { publicLabPlan } from './service';
import { characterLabOperations, type CharacterLabOperation, type CharacterLabRecipe, type CharacterLabRestoredSettings } from './types';

export async function labRecipe(user: SessionUser, id: string): Promise<CharacterLabRecipe> {
  const plan = await readLabPlan(user.id, id);
  const batchId = createHash('sha256').update(`${user.id}:${plan.id}`).digest('hex');
  const task = await prisma.imageStudioTask.findFirst({ where: { owner_id: user.id, batch_id: batchId, deleted_at: null },
    select: { id: true, status: true, context: true, prompt: true, asset_id: true } });
  const references: CharacterLabRecipe['references'] = [];
  for (let index = 0; index < plan.referenceIds.length; index++) {
    const id = plan.referenceIds[index];
    const asset = await prisma.asset.findFirst({ where: { id, owner_id: user.id, type: 'image', status: 'active' } });
    const available = Boolean(asset && await canReadStudioAsset(user, asset));
    const previousResult = Boolean(plan.previousResultPlanId && index === plan.referenceIds.length - 1);
    const source = previousResult ? { planId: plan.previousResultPlanId! } : plan.operation === 'refine-face' ? plan.input
      : plan.operation === 'side' ? plan.mainFace
        : plan.operation === 'refine-side' ? index === 0 ? plan.mainFace : plan.input
          : index === 1 ? plan.mainFace : index > 1 ? plan.auxiliaryFaces[index - 2] : undefined;
    const label = previousResult ? '调整前成品' : plan.operation === 'refine-face' ? '微调前正脸'
      : plan.operation === 'side' ? '锁定身份的正脸'
        : plan.operation === 'refine-side' ? index === 0 ? '锁定身份的正脸' : '微调前侧脸'
          : index === 0 ? '原始角色设计' : index === 1 ? '主面部' : '辅助参考';
    references.push({ id, available, label: `参考 ${index + 1} · ${label}`, ...(source ? { source } : {}) });
  }
  const completePrompt = task ? task.prompt.trim() ? `${task.context}\n\n---\n本次画面要求：\n${task.prompt}` : task.context : null;
  return { plan: publicLabPlan(user, plan), taskId: task?.id || null, hasImage: Boolean(task?.asset_id), state: task ? publicImageTaskStatus(task.status) : 'prepared',
    instruction: user.role === 'admin' ? plan.prompt : null, completePrompt: user.role === 'admin' ? completePrompt : null,
    personalText: plan.operation ? plan.adjustment : plan.kind === 'faces' ? plan.context : [plan.context, plan.adjustment].filter(Boolean).join('\n\n'), references };
}

export async function restoreLabSettings(user: SessionUser, body: Record<string, unknown>): Promise<CharacterLabRestoredSettings> {
  const source = await readLabPlan(user.id, labId(body.planId));
  const workspace = await readLabWorkspace(user.id, labId(body.workspaceId));
  if (source.workspaceId !== workspace.id || source.sourceAssetId !== workspace.draft.sourceAssetId) throw new StudioError('原设置属于另一角色或原图，当前输入保留', 409);
  await labOutput(user, source);
  for (const id of source.referenceIds) await ownedLabAsset(user, id);
  return { patch: { ...(!source.operation && source.kind === 'faces' ? { count: source.count, diversity: source.diversity, context: source.context } : {}),
    ...(source.operation?.startsWith('body-') ? { context: source.adjustment || source.context } : {}),
    ...(source.operation === 'side' ? { sideDescription: source.adjustment } : {}),
    model: source.model, channelId: source.channelId, quality: source.quality, resolution: source.resolution,
    ...(!source.operation && source.kind === 'result' ? { context: source.context, auxiliaryFaces: source.auxiliaryFaces, auxiliaryFeatures: source.auxiliaryFeatures,
      adjustment: source.adjustment, adjustmentCell: source.adjustmentCell } : {}),
    settingsSource: { planId: source.id, target: source.operation || source.kind } },
    ...(source.operation ? { operation: source.operation } : {}), ...(source.input ? { input: source.input } : {}), description: source.adjustment };
}

export async function previewLabPrompt(user: SessionUser, body: Record<string, unknown>) {
  const draft = parseLabDraft(body.draft);
  const workspace = await readLabWorkspace(user.id, labId(body.workspaceId));
  if (draft.sourceAssetId !== workspace.draft.sourceAssetId) throw new StudioError('请先保存当前原图再预览生成设置', 409);
  if (body.kind !== 'faces' && body.kind !== 'result') throw new StudioError('生成阶段无效');
  if (body.operation !== undefined && !characterLabOperations.includes(body.operation as CharacterLabOperation)) throw new StudioError('生成用途无效');
  const operation = body.operation as CharacterLabOperation | undefined;
  const config = await labConfig();
  const description = labText(body.description ?? (operation === 'side' ? draft.sideDescription || '' : operation?.startsWith('body-') ? draft.context : ''), 3000, '本次要求');
  const prompt = operation ? labViewPrompt(config, operation, description) : body.kind === 'faces' ? faceLabPrompt(config, draft)
    : resultLabPrompt(config, draft, Boolean(draft.resultPlanId && (draft.adjustment.trim() || draft.adjustmentCell !== null)));
  return { revision: config.revision, prompt: user.role === 'admin' ? prompt : null,
    personalText: operation ? description : body.kind === 'faces' ? draft.context : [draft.context, draft.adjustment].filter(Boolean).join('\n\n') };
}
