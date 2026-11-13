import 'server-only';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { requireStudioUser } from '@/lib/template-studio/common';
import { StudioError } from '@/lib/template-studio/errors';
import { transformPrivateVideoRun } from '@/lib/template-studio/private-storage.server';
import type { StudioRunSnapshot } from '@/lib/template-studio/types';
import { USER_VISIBLE_TASK_RETENTION_STATUSES } from '@/lib/tasks/retention';
import { assertCanUseReferenceImage } from '@/lib/reference-albums/permissions';
import { readMultiviewPrivateTaskMarker } from './multiview-task-privacy';
import { readSafePrivateMultiviewInput } from './multiview-private-create.server';
import { getMultiviewWork, multiviewWorkRecipeHash } from './multiview-works';
import { parseMultiviewWorkRecipe } from './multiview-work-contract';
import { parseMultiviewActionInput } from './multiview-action-restore-contract';
import type { MultiviewVideoRestore } from './multiview-action-restore-contract';

export async function restoreMultiviewVideoInput(user: SessionUser, taskId: string): Promise<MultiviewVideoRestore> {
  requireStudioUser(user);
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(taskId)) throw new StudioError('视频编号无效', 400, 'INVALID');
  const task = await prisma.videoTask.findFirst({ where: { id: taskId,
    OR: [{ owner_user_id: user.id }, { owner_user_id: null, user_id: user.id }],
    retention_status: { in: [...USER_VISIBLE_TASK_RETENTION_STATUSES] } } });
  if (!task) throw new StudioError('视频不存在或无权恢复输入', 404, 'NOT_FOUND');
  const marker = readMultiviewPrivateTaskMarker(task);
  if (!marker) throw new StudioError('这条视频没有可恢复的多视图输入', 409, 'CONFLICT');
  if (marker.kind === 'multiview') {
    const value = readSafePrivateMultiviewInput(task);
    const reference = await assertCanUseReferenceImage(user, value.snapshot.mainReferenceImageId);
    if (reference.asset_id !== value.snapshot.mainAssetId) throw new StudioError('原主图已不可用，当前输入保留', 409, 'CONFLICT');
    return { kind: 'rotation', taskId, warnings: [], patch: { provider: 'seedance', model: value.model,
      ratio: value.ratio, duration: value.duration, resolution: value.resolution, supplement: value.snapshot.supplement,
      seed: value.seed, generateAudio: value.generateAudio, returnLastFrame: value.returnLastFrame, watermark: value.watermark,
      projectId: value.projectId, videoCardId: value.videoCardId || '',
      mainImage: { assetId: value.snapshot.mainAssetId, referenceImageId: value.snapshot.mainReferenceImageId } } };
  }
  const binding = marker.actionBinding;
  if (!binding || task.template_studio_run_id !== binding.runId) throw new StudioError('原动作输入记录不完整', 409, 'CONFLICT');
  const row = await prisma.videoStudioRun.findFirst({ where: { id: binding.runId, owner_user_id: user.id, purpose: 'multiview-action', mode: 'direct' } });
  if (!row) throw new StudioError('原动作输入记录不可用', 409, 'CONFLICT');
  const value = transformPrivateVideoRun(JSON.parse(row.snapshot_json) as StudioRunSnapshot, row.id, row.draft_id, false);
  const action = value.multiviewAction;
  if (value.purpose !== 'multiview-action' || value.owner.userId !== user.id || action?.stage !== 'final'
    || action.workId !== binding.workId || action.revision !== binding.revision || action.inputHash !== binding.inputHash
    || action.recipeHash !== binding.recipeHash) throw new StudioError('原动作版本无法核对', 409, 'CONFLICT');
  const input = parseMultiviewActionInput({text:value.input.draftPrompt,parameters:value.parameters});
  if(!input)throw new StudioError('原动作输入不完整，当前草稿保留',409,'CONFLICT');
  const work = await getMultiviewWork(user, action.workId);
  if (!work.info || work.sourceVersion !== action.sourceVersion) throw new StudioError('原视频版本已变化，当前输入保留', 409, 'CONFLICT');
  const candidates = [action.editableRecipe, work.ready?.recipe, work.recipe];
  const recipe = candidates.map(item => parseMultiviewWorkRecipe(item, work.info!)).find(item => item?.schema === 3 && multiviewWorkRecipeHash(item) === action.recipeHash);
  const image = await prisma.asset.findFirst({ where: { id: action.assetId, owner_id: user.id, status: 'active', hash: action.outputHash } });
  return { kind: 'action', taskId, runId: row.id, workId: work.id, text: input.text,
    parameters: input.parameters, info: work.info,
    recipe: recipe?.schema === 3 ? recipe : null, referenceImageUrl: image?.original_url || null,
    warnings: [...(!recipe ? ['这条历史视频未保留完整选帧配方；已恢复文字和规格，可查看原参考图，请重新选择参考帧后生成。'] : []),
      ...(!image ? ['原参考图已不可用，请重新选择有权使用的参考图。'] : [])] };
}
