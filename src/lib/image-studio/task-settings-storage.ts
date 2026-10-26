import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import { canViewStudioPreset, type ImageStudioIdentity } from './access';
import { studioPresetArchived } from './preset-lifecycle';
import { parseStudioTaskSettings, STUDIO_TASK_SETTINGS_PROTOCOL, StudioTaskSettingsError, type StudioTaskSettings } from './task-settings';

type Client = Pick<Prisma.TransactionClient, 'platformSetting'>;
export const STUDIO_TASK_SETTINGS_FILES = [
  'src/lib/image-studio/task-settings.ts', 'src/lib/image-studio/task-settings-storage.ts',
  'src/lib/image-studio/shared-contract.ts', 'src/lib/image-studio/tasks.ts', 'src/lib/image-studio/batches.ts',
  'src/lib/image-studio/modules.ts', 'src/lib/image-studio/presets.ts',
] as const;
let moduleHashes: Record<string, string> | undefined;

export const studioTaskSettingsWriterEnabled = () => process.env.STUDIO_TASK_SETTINGS_V2_WRITE === '1';

// Writers are enabled only after the compatible worker and rollback pair are admitted.
export async function assertStudioTaskSettingsWriter(client: Client) {
  if (!studioTaskSettingsWriterEnabled()) throw new StudioTaskSettingsError('设置更新服务尚未就绪，当前输入保留');
  const row = await client.platformSetting.findUnique({ where: { key: 'studio_shared_worker_v1' }, select: { value_json: true } });
  try {
    const receipt = JSON.parse(row?.value_json || 'null');
    moduleHashes ??= Object.fromEntries(STUDIO_TASK_SETTINGS_FILES.map(file => [file,
      createHash('sha256').update(readFileSync(path.join(process.cwd(), file))).digest('hex')]));
    if (receipt?.taskSettingsProtocol !== STUDIO_TASK_SETTINGS_PROTOCOL || !(Date.parse(receipt.expiresAt) > Date.now())
      || STUDIO_TASK_SETTINGS_FILES.some(file => receipt.loadedModuleSha?.[file] !== moduleHashes![file])) throw new Error('reader-not-ready');
  } catch { throw new StudioTaskSettingsError('设置处理服务尚未就绪，本次未受理；当前输入保留'); }
}

export type StudioWorkspaceSource = { version: 2; ownerId: string; moduleId: string; sourceTaskId: string | null; taskSettings: StudioTaskSettings };
// Same reproduction namespace; this record contains source/mode metadata only, never global text.
const workspaceSourceKey = (moduleId: string, kind: 'workspace' | 'preset') => `studio_shared_reproduction_v1:${kind}:${moduleId}`;
export async function readStudioWorkspaceSource(client: Client, ownerId: string, moduleId: string, kind: 'workspace' | 'preset' = 'workspace'): Promise<StudioWorkspaceSource | null> {
  const row = await client.platformSetting.findUnique({ where: { key: workspaceSourceKey(moduleId, kind) }, select: { value_json: true } });
  if (!row) return null;
  try {
    const value = JSON.parse(row.value_json);
    const taskSettings = parseStudioTaskSettings(value.taskSettings);
    if (value.version !== 2 || value.ownerId !== ownerId || value.moduleId !== moduleId || !taskSettings
      || value.sourceTaskId !== null && (typeof value.sourceTaskId !== 'string' || !/^[a-zA-Z0-9-]{1,120}$/.test(value.sourceTaskId))) throw new Error();
    return { version: 2, ownerId, moduleId, sourceTaskId: value.sourceTaskId, taskSettings };
  } catch { throw new StudioTaskSettingsError('已保存的设置来源无法确认，当前输入保留'); }
}

export async function writeStudioWorkspaceSource(client: Client, value: StudioWorkspaceSource, kind: 'workspace' | 'preset' = 'workspace') {
  await assertStudioTaskSettingsWriter(client);
  const key = workspaceSourceKey(value.moduleId, kind), value_json = JSON.stringify(value);
  await client.platformSetting.upsert({ where: { key }, create: { key, value_json, updated_by: value.ownerId }, update: { value_json, updated_by: value.ownerId } });
}

export function assertStudioTaskSettingsWrite(prior: StudioTaskSettings | undefined, incoming: StudioTaskSettings | undefined) {
  if (prior && !incoming) throw new StudioTaskSettingsError('此模板使用新的设置模式，请更新页面后保存；当前输入保留');
}

export async function studioSettingsSourceContext(client: Prisma.TransactionClient, actor: ImageStudioIdentity, sourceTaskId: string) {
  const task = await client.imageStudioTask.findFirst({ where: { id: sourceTaskId, owner_id: actor.id, deleted_at: null }, select: { snapshot_json: true, source_preset_id: true } });
  if (!task?.snapshot_json) throw new StudioTaskSettingsError('历史设置来源已不可用，当前输入保留');
  let snapshot;
  try { snapshot = JSON.parse(task.snapshot_json); } catch { throw new StudioTaskSettingsError('历史设置来源无法读取'); }
  if (typeof snapshot.globalContext !== 'string') throw new StudioTaskSettingsError('历史记录没有完整通用设置');
  const presetId = task.source_preset_id || (typeof snapshot.sourcePresetId === 'string' ? snapshot.sourcePresetId : null);
  if (presetId) {
    const source = await client.imageStudioPreset.findUnique({ where: { id: presetId } });
    if (!source || !canViewStudioPreset(actor, source) || await studioPresetArchived(presetId, client)) throw new StudioTaskSettingsError('原模板已不可用，当前输入保留');
  }
  return snapshot.globalContext as string;
}
