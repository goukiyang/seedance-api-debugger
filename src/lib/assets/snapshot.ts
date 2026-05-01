/**
 * 任务快照服务
 */

import { prisma } from '@/lib/prisma';
import { v4 as uuidv4 } from 'uuid';
import type { GenerationMode } from '@/types';
import type { AssetMapping } from './collection';
import { renderPromptWithAssets } from './collection';
import { buildContentArray } from '@/lib/provider/jimeng';
import type { CreateVideoInput } from '@/types';

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
}

/**
 * 创建任务快照（自动渲染 prompt + 构建 content）
 */
export async function createTaskSnapshot(input: CreateSnapshotInput) {
  const { promptRendered, assetMapping } = await renderPromptWithAssets(
    input.promptRaw,
    input.workspaceId ?? '',
    input.generationMode
  );

  // 构建 content 数组（用于调试）
  let contentJson: string | null = null;
  if (input.workspaceId) {
    const content = buildContentArray({
      ...input.input,
      prompt: promptRendered,
    } as CreateVideoInput);
    contentJson = JSON.stringify(content, null, 2);
  }

  const snapshot = await prisma.generationTaskSnapshot.create({
    data: {
      id: uuidv4(),
      task_id: input.taskId,
      workspace_id: input.workspaceId,
      generation_mode: input.generationMode,
      prompt_raw: input.promptRaw,
      prompt_rendered: promptRendered,
      asset_mapping_json: JSON.stringify(assetMapping),
      content_json: contentJson,
      provider_payload_json: input.providerPayloadJson ?? null,
    },
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
