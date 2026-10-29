/**
 * 任务快照服务
 */

import 'server-only';

import { prisma } from '@/lib/prisma';
import { v4 as uuidv4 } from 'uuid';
import type { GenerationMode } from '@/types';
import type { AssetMapping } from './collection';
import { renderPromptWithAssets } from './collection';
import { buildContentArray } from '@/lib/provider/jimeng';
import type { CreateVideoInput } from '@/types';
import { multiviewPrivateTaskMarker, multiviewActionPrivateTaskMarker } from '@/lib/video/multiview-task-privacy';
import type { MultiviewActionBinding } from '@/lib/video/multiview-action-contract';
import type { PrivateOrigin } from '@/lib/security/private-prompts.server';
import { writePrivateFields } from '@/lib/security/private-prompt-fields.server';
import { transformPrivateVideoText } from '@/lib/video/private-storage.server';
import { protectVideoPromptGroupSnapshot } from '@/lib/video/prompt-group-execution.server';

// ============================================================================
// Snapshot 创建
// ============================================================================

export interface CreateSnapshotInput {
  taskId?: string;
  workspaceId?: string;
  generationMode: GenerationMode;
  promptRaw: string;
  input: Omit<CreateVideoInput, 'prompt'> & { prompt: string };
  providerPayloadJson?: string;
  contentOverride?: unknown;
  promptRenderedOverride?: string;
  assetMappingOverride?: AssetMapping;
  protectedRecipeVersion?: string;
  protectedAction?: { binding: MultiviewActionBinding; origins: PrivateOrigin[] };
  protectedGroups?: { origins: PrivateOrigin[] };
}

/**
 * 创建任务快照（自动渲染 prompt + 构建 content）
 */
export async function createTaskSnapshot(input: CreateSnapshotInput) {
  const rendered = input.promptRenderedOverride === undefined
    ? await renderPromptWithAssets(input.promptRaw, input.workspaceId ?? '', input.generationMode)
    : { promptRendered: input.promptRenderedOverride, assetMapping: input.assetMappingOverride || {} };
  const { promptRendered, assetMapping } = rendered;

  // 构建 content 数组（用于调试）
  let contentJson: string | null = null;
  if (input.protectedGroups) {
    contentJson = JSON.stringify(buildContentArray(input.input as CreateVideoInput).filter(item => item.type !== 'text'));
  } else if (input.protectedAction) {
    contentJson = JSON.stringify({ protected_module: multiviewActionPrivateTaskMarker(input.protectedAction.binding) });
  } else if (input.protectedRecipeVersion) {
    contentJson = JSON.stringify({ protected_module: multiviewPrivateTaskMarker(input.protectedRecipeVersion) });
  } else if (input.workspaceId) {
    const content = input.contentOverride !== undefined
      ? input.contentOverride
      : buildContentArray({
          ...input.input,
          prompt: promptRendered,
        } as CreateVideoInput);
    contentJson = JSON.stringify(content, null, 2);
  }

  const data = {
      id: uuidv4(),
      task_id: input.taskId,
      workspace_id: input.workspaceId,
      generation_mode: input.generationMode,
      prompt_raw: input.promptRaw,
      prompt_rendered: promptRendered,
      asset_mapping_json: JSON.stringify(assetMapping),
      content_json: contentJson,
      provider_payload_json: input.protectedAction ? contentJson : input.providerPayloadJson ?? null,
    };
  const snapshot = await prisma.generationTaskSnapshot.create({
    data: input.protectedGroups ? protectVideoPromptGroupSnapshot(data, input.protectedGroups.origins)
      : input.protectedAction ? writePrivateFields(data, 'video-generation-snapshot', data.id,
      ['prompt_raw', 'prompt_rendered'].map(field => ({ field, origins: input.protectedAction!.origins })))
      : transformPrivateVideoText('video-generation-snapshot', data, ['prompt_raw', 'prompt_rendered'], true, Boolean(input.protectedRecipeVersion)),
  });

  return snapshot;
}

export async function getSnapshotById(id: string) {
  return prisma.generationTaskSnapshot.findUnique({ where: { id } });
}

export async function getSnapshotsByWorkspace(workspaceId: string) {
  return prisma.generationTaskSnapshot.findMany({
    where: { workspace_id: workspaceId },
    orderBy: { created_at: 'desc' },
    take: 20,
  });
}

export async function getSnapshotByTaskId(taskId: string) {
  return prisma.generationTaskSnapshot.findFirst({
    where: { task_id: taskId },
  });
}
