import { isEncryptedStudioPersonalPrompt } from './personal-prompt';

export type RestoredStudioSettings = { protocol: 'task-settings-v1'; sourceTaskId: string };
export { isEncryptedStudioPersonalPrompt, studioPersonalPromptProjection } from './personal-prompt';
export type { StudioPersonalPromptProjection, StudioPersonalPromptState } from './personal-prompt';

export class RestoredStudioSettingsError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}

export function parseRestoredStudioSettings(value: unknown): RestoredStudioSettings | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RestoredStudioSettingsError('恢复设置来源无效，请重新选择原记录');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !['protocol', 'sourceTaskId'].includes(key))
    || record.protocol !== 'task-settings-v1' || typeof record.sourceTaskId !== 'string'
    || !/^[a-zA-Z0-9-]{1,120}$/.test(record.sourceTaskId)) {
    throw new RestoredStudioSettingsError('恢复设置来源无效，请重新选择原记录');
  }
  return { protocol: record.protocol, sourceTaskId: record.sourceTaskId };
}

export function assertRestoredStudioDraft(input: {
  restoredSettings?: RestoredStudioSettings; reproduceFromTaskId?: unknown;
  draft?: { moduleContext?: unknown; globalContext?: unknown; fixedReferences?: unknown;
    styleGroupIds?: string[]; styleGroupVersions?: Record<string, number>; skillIds?: string[]; skillVersions?: Record<string, string> };
}) {
  if (!input.restoredSettings) {
    if (input.draft?.styleGroupVersions !== undefined) throw new RestoredStudioSettingsError('风格版本只能用于明确恢复的本次设置');
    return;
  }
  const draft = input.draft;
  if (input.reproduceFromTaskId !== undefined || draft?.moduleContext !== undefined
    || draft?.globalContext !== undefined || draft?.fixedReferences !== undefined) {
    throw new RestoredStudioSettingsError('恢复设置不能混入未保存的模板内容，请重新选择原记录；个人输入仍保留');
  }
  if (draft?.styleGroupIds !== undefined && (!draft.styleGroupVersions
    || Object.keys(draft.styleGroupVersions).length !== draft.styleGroupIds.length
    || draft.styleGroupIds.some(id => !Number.isSafeInteger(draft.styleGroupVersions![id]) || draft.styleGroupVersions![id] < 0))) {
    throw new RestoredStudioSettingsError('本次改选的风格缺少版本，请重新选择后生成');
  }
  if (draft?.skillIds !== undefined && (!draft.skillVersions
    || Object.keys(draft.skillVersions).length !== draft.skillIds.length
    || draft.skillIds.some(id => !draft.skillVersions![id]))) {
    throw new RestoredStudioSettingsError('本次改选的提示词组缺少版本，请重新选择后生成');
  }
}

export function hasSharedStudioPrompt(snapshot: Record<string, unknown>) {
  return snapshot.sharedLive !== undefined || snapshot.sharedSourceRevision !== undefined || snapshot.sharedSourceOwnerId !== undefined
    || typeof snapshot.templatePrompt === 'string' && snapshot.templatePrompt.length > 0;
}

export function restoredStudioTemplatePrompt(snapshot: Record<string, unknown>) {
  if (typeof snapshot.templatePrompt === 'string' && !isEncryptedStudioPersonalPrompt(snapshot.templatePrompt)) return snapshot.templatePrompt;
  if (isEncryptedStudioPersonalPrompt(snapshot.templatePrompt)) {
    throw new RestoredStudioSettingsError('这条旧记录的模板提示词无法安全读取，未显示原密文；请使用当前模板并填写本次描述');
  }
  if (hasSharedStudioPrompt(snapshot)) throw new RestoredStudioSettingsError('这条旧共享记录没有分开保存模板与个人描述，无法安全恢复；请使用当前模板并填写本次描述');
  return '';
}

export function assertRestoredStudioSourceRelation(source: {
  module_id: string | null; source_preset_id: string | null;
}, snapshot: Record<string, unknown>, current: { moduleId: string; presetId: string | null; allowOrdinaryModulePromotion?: boolean }) {
  const shared = snapshot.sharedLive && typeof snapshot.sharedLive === 'object' && !Array.isArray(snapshot.sharedLive)
    ? snapshot.sharedLive as Record<string, unknown> : null;
  if (snapshot.sharedLive !== undefined && (!shared || shared.protocol !== 'shared-live-v1' || typeof shared.presetId !== 'string')) {
    throw new RestoredStudioSettingsError('原记录的模板来源无法确认，请重新选择记录');
  }
  const presets = [source.source_preset_id, snapshot.sourcePresetId, shared?.presetId]
    .filter((value): value is string => typeof value === 'string' && Boolean(value));
  const modules = [source.module_id, snapshot.moduleId].filter((value): value is string => typeof value === 'string' && Boolean(value));
  const ownedOrdinaryPromotion = current.allowOrdinaryModulePromotion === true && !hasSharedStudioPrompt(snapshot)
    && source.module_id === current.moduleId;
  if (new Set(presets).size > 1 || new Set(modules).size > 1
    || presets.length > 0 && presets.some(id => id !== current.presetId) && !ownedOrdinaryPromotion
    || !presets.length && !modules.includes(current.moduleId)) {
    throw new RestoredStudioSettingsError('这条记录不属于当前模板，请回到原模板恢复设置', 403);
  }
}

export function historicalStudioTemplateReferences(snapshot: Record<string, unknown>): Record<string, unknown>[] {
  const raw = snapshot.templateReferenceImages !== undefined ? snapshot.templateReferenceImages
    : Array.isArray(snapshot.referenceImages) ? snapshot.referenceImages.filter(item => item && typeof item === 'object'
      && (item as Record<string, unknown>).referenceRole === 'template-reference') : [];
  if (!Array.isArray(raw) || raw.some(item => !item || typeof item !== 'object' || Array.isArray(item)
    || typeof (item as Record<string, unknown>).id !== 'string' || !(item as Record<string, unknown>).id)) {
    throw new RestoredStudioSettingsError('原记录的模板参考图无法确认，请重新选择原记录');
  }
  return raw as Record<string, unknown>[];
}

export function assertRestoredStudioStyleVersions(groups: Array<{ id: string; revision: number }>, expected: Record<string, number>) {
  if (groups.length !== Object.keys(expected).length || groups.some(group => expected[group.id] !== group.revision)) {
    throw new RestoredStudioSettingsError('本次改选的风格已更新，请重新选择后生成');
  }
}
