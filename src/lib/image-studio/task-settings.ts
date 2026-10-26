export const STUDIO_TASK_SETTINGS_PROTOCOL = 'task-settings-v2' as const;
export type StudioTaskSettings = { protocol: typeof STUDIO_TASK_SETTINGS_PROTOCOL; mode: 'current' | 'historical'; sourceTaskId?: string };

export class StudioTaskSettingsError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}

export function parseStudioTaskSettings(value: unknown): StudioTaskSettings | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StudioTaskSettingsError('设置模式无效，请重新读取原设置');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !['protocol', 'mode', 'sourceTaskId'].includes(key)) || record.protocol !== STUDIO_TASK_SETTINGS_PROTOCOL
    || record.mode !== 'current' && record.mode !== 'historical') throw new StudioTaskSettingsError('设置模式尚不支持，请更新页面后重试');
  if (record.sourceTaskId !== undefined && (typeof record.sourceTaskId !== 'string' || !/^[a-zA-Z0-9-]{1,120}$/.test(record.sourceTaskId))) throw new StudioTaskSettingsError('设置来源无效');
  return { protocol: STUDIO_TASK_SETTINGS_PROTOCOL, mode: record.mode, ...(typeof record.sourceTaskId === 'string' ? { sourceTaskId: record.sourceTaskId } : {}) };
}

export function studioTaskSettings(mode: StudioTaskSettings['mode'], sourceTaskId?: string | null): StudioTaskSettings {
  return { protocol: STUDIO_TASK_SETTINGS_PROTOCOL, mode, ...(sourceTaskId ? { sourceTaskId } : {}) };
}

export function sameStudioTaskSettings(a: unknown, b: unknown) {
  const left = parseStudioTaskSettings(a), right = parseStudioTaskSettings(b);
  return left?.protocol === right?.protocol && left?.mode === right?.mode && left?.sourceTaskId === right?.sourceTaskId;
}
