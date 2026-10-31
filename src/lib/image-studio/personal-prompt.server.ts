import 'server-only';
import { canonicalPrivateBinding, inspectPrivatePrompt, privateOrigin, readPrivatePrompt,
  type PrivateBinding } from '@/lib/security/private-prompts.server';
import { hasMixedStudioPersonalPrompt, isEncryptedStudioPersonalPrompt, studioPersonalPromptProjection,
  type StudioPersonalPromptProjection, type StudioPersonalPromptState } from './personal-prompt';

export type StudioPromptTask = {
  id: string;
  owner_id?: string;
  prompt: string;
  snapshot_json: string | null;
};

export type ServerStudioPersonalPromptProjection = Omit<StudioPersonalPromptProjection, 'personalPromptState'> & {
  personalPromptState: StudioPersonalPromptState | 'unavailable';
  personalPromptReason?: string;
};

const OWNER_REASON = '仅任务本人可以恢复这条个人描述；当前输入仍可重新填写。';
const UNKNOWN_REASON = '这条旧记录没有可证明的独立个人描述，未自动恢复；请在当前输入中重新填写。';
const UNAVAILABLE_REASON = '这条旧记录的个人描述暂时无法安全读取，未显示原密文；请在当前输入中重新填写。';

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function storedSnapshot(task: StudioPromptTask, supplied: Record<string, unknown>) {
  try {
    if (!task.snapshot_json) return null;
    const value = JSON.parse(task.snapshot_json);
    if (!record(value) || JSON.stringify(value) !== JSON.stringify(supplied)) return null;
    return value;
  } catch { return null; }
}

function unavailable(reason: string): ServerStudioPersonalPromptProjection {
  return { personalPromptState: 'unavailable', personalPromptReason: reason };
}

export function serverStudioPersonalPromptProjection(task: StudioPromptTask, snapshot: Record<string, unknown>,
  viewerOwnerId?: string): ServerStudioPersonalPromptProjection {
  if (!task.owner_id || viewerOwnerId !== task.owner_id) return unavailable(OWNER_REASON);
  const original = storedSnapshot(task, snapshot);
  if (!original) return unavailable(UNKNOWN_REASON);

  const projection = studioPersonalPromptProjection(original);
  if (projection.personalPrompt !== undefined) return projection;
  if (Object.hasOwn(original, 'personalPrompt') || hasMixedStudioPersonalPrompt(original)) {
    return unavailable(UNKNOWN_REASON);
  }

  const raw = original.prompt;
  if (!isEncryptedStudioPersonalPrompt(raw)) return { personalPromptState: 'unknown', personalPromptReason: UNKNOWN_REASON };
  if (typeof raw !== 'string' || !raw.startsWith('ppenc:')) return unavailable(UNAVAILABLE_REASON);

  try {
    if (!Object.hasOwn(original, 'sourcePresetId')) return unavailable(UNKNOWN_REASON);
    const sourcePresetId = original.sourcePresetId;
    if (sourcePresetId !== null && (typeof sourcePresetId !== 'string' || !sourcePresetId)) return unavailable(UNKNOWN_REASON);
    const moduleId = original.moduleId;
    if (sourcePresetId === null && (typeof moduleId !== 'string' || !moduleId)) return unavailable(UNKNOWN_REASON);
    const kind = sourcePresetId ? 'image-preset' : 'image-module';
    const id = sourcePresetId || moduleId as string;
    const origin = privateOrigin(kind, id);
    if (!origin || origin.ownerId !== task.owner_id) return unavailable(UNKNOWN_REASON);
    const binding: PrivateBinding = canonicalPrivateBinding({
      kind: 'image-task-snapshot', id: task.id, field: 'prompt', origins: [origin],
    });
    const envelope = inspectPrivatePrompt(raw);
    if (JSON.stringify(envelope.binding) !== JSON.stringify(binding)) return unavailable(UNKNOWN_REASON);
    const personalPrompt = readPrivatePrompt(raw, binding);
    if (isEncryptedStudioPersonalPrompt(personalPrompt)) return unavailable(UNAVAILABLE_REASON);
    return { personalPromptState: 'legacy-personal', personalPrompt };
  } catch { return unavailable(UNAVAILABLE_REASON); }
}
