import { parseTaskReuseOperationRequest, taskReuseReceiptKey, type TaskReuseContext, type TaskReuseOperationRequest, type TaskReuseOperationStatus } from './task-reuse-intent';
import type { WorkspaceInputRecovery } from '@/lib/hooks/useWorkspace';
import { parseVideoPromptGroupRefs, type VideoPromptGroupRef } from '@/lib/video/prompt-groups';
export type TaskReuseInputBackup = { version: 1; hadInput?: boolean; workspace: WorkspaceInputRecovery; fields: {
  prompt: string; generationMode: string; ratio: string; duration: number; resolution: string; seed: number;
  generateAudio: boolean; returnLastFrame: boolean; watermark: boolean; resolutionApprovalConfirmed: boolean;
  model: string; provider?: string | null; auxiliary?: string | null; projectId?: string; videoCardId?: string; videoBranchId?: string;
  videoPromptGroups?: VideoPromptGroupRef[];
  draftMode?: boolean;
  unapplied?: { videoPromptGroups?: VideoPromptGroupRef[]; draftMode?: boolean; auxiliary?: string | null; feishu?: boolean; h3?: boolean };
} };
export type TaskReuseTarget = { projectId: string; videoCardId: string; videoBranchId: string };
export type TaskReuseApplied = { reuseKey: number; workspaceBridgeKey: string; target: TaskReuseTarget; inputReplaced: boolean };
export type TaskReuseClientRecord = { version: 2; accountId: string; sourceTaskId: string; operation: TaskReuseOperationRequest;
  context: TaskReuseContext; backup: TaskReuseInputBackup; serverStatus?: TaskReuseOperationStatus['status'] | 'read-only'; applied?: TaskReuseApplied };
export type CompletedTaskReuse = TaskReuseClientRecord & { serverStatus: 'applied'; applied: TaskReuseApplied };
export type TaskReuseUndoScope = TaskReuseTarget & { accountId: string | null; surface: 'normal' | 'ip'; tabId: string; workspaceId: string; workspaceBridgeKey: string };
const backupKey = (owner: string, tab: string) => `sd2:task-reuse-backup:v2:${JSON.stringify([owner, tab])}`;
export function parseTaskReuseClientRecord(raw: string | null, owner: string, taskId: string): TaskReuseClientRecord | null {
  if (!raw || raw.length > 180000) return null;
  try {
    const value = JSON.parse(raw) as TaskReuseClientRecord, operation = parseTaskReuseOperationRequest(value.operation);
    if (value.version !== 2 || value.accountId !== owner || value.sourceTaskId !== taskId || !operation
      || value.backup?.version !== 1 || value.backup.workspace?.ownerId !== owner || value.backup.workspace.tabId !== operation.tabId
      || value.backup.workspace.workspaceId !== operation.workspaceId || !Array.isArray(value.backup.workspace.items) || value.backup.workspace.items.length > 80
      || typeof value.backup.fields?.prompt !== 'string' || value.backup.fields.prompt.length > 20000
      || typeof value.backup.fields.model !== 'string' || !value.context || value.context.accountId !== owner || value.context.tabId !== operation.tabId) return null;
    parseVideoPromptGroupRefs(value.backup.fields.videoPromptGroups);
    return { ...value, operation };
  } catch { return null; }
}
export function saveTaskReuseClientRecord(value: TaskReuseClientRecord) {
  const key = taskReuseReceiptKey(value.accountId, value.operation.tabId, value.sourceTaskId), raw = JSON.stringify(value);
  // Either write failing refuses a new POST; an already written fence remains safe.
  localStorage.setItem(key, raw); sessionStorage.setItem(key, raw);
}
export function readTaskReuseClientRecord(owner: string, tab: string, taskId: string) {
  const key = taskReuseReceiptKey(owner, tab, taskId);
  return parseTaskReuseClientRecord(sessionStorage.getItem(key) || localStorage.getItem(key), owner, taskId);
}
export function finishTaskReuseClientRecord(value: TaskReuseClientRecord, status: TaskReuseOperationStatus['status'] | 'read-only', applied?: TaskReuseApplied) {
  const completed = { ...value, serverStatus: status, applied: status === 'applied' ? applied : undefined };
  localStorage.setItem(backupKey(value.accountId, value.operation.tabId), JSON.stringify(completed));
  const key = taskReuseReceiptKey(value.accountId, value.operation.tabId, value.sourceTaskId);
  sessionStorage.removeItem(key); localStorage.removeItem(key);
  return completed;
}
export function readTaskReuseInputBackup(owner: string, tab: string) {
  const raw = localStorage.getItem(backupKey(owner, tab));
  if (!raw) return null;
  try { const value = JSON.parse(raw); return typeof value?.sourceTaskId === 'string' ? parseTaskReuseClientRecord(raw, owner, value.sourceTaskId)?.backup || null : null; } catch { return null; }
}
export function readCompletedTaskReuse(owner: string, tab: string): CompletedTaskReuse | null {
  try {
    const raw = localStorage.getItem(backupKey(owner, tab)), value = raw && JSON.parse(raw);
    const record = typeof value?.sourceTaskId === 'string' ? parseTaskReuseClientRecord(raw, owner, value.sourceTaskId) : null;
    const applied = record?.applied;
    if (!record || record.serverStatus !== 'applied' || record.operation.tabId !== tab || !applied
      || !Number.isSafeInteger(applied.reuseKey) || applied.reuseKey < 1 || typeof applied.workspaceBridgeKey !== 'string' || !applied.workspaceBridgeKey
      || applied.workspaceBridgeKey !== record.context.workspaceBridgeKey
      || typeof applied.inputReplaced !== 'boolean' || !applied.target
      || !['projectId', 'videoCardId', 'videoBranchId'].every(key => typeof applied.target[key as keyof TaskReuseTarget] === 'string' && applied.target[key as keyof TaskReuseTarget].length <= 128)) return null;
    return record as CompletedTaskReuse;
  } catch { return null; }
}
export function sameTaskReuseReceipt(left: TaskReuseClientRecord, right: TaskReuseClientRecord) {
  return left.accountId === right.accountId && left.sourceTaskId === right.sourceTaskId
    && ['requestId', 'nonce', 'requestHash', 'surface', 'tabId', 'workspaceId'].every(key => left.operation[key as keyof TaskReuseOperationRequest] === right.operation[key as keyof TaskReuseOperationRequest]);
}
export function taskReuseUndoMatches(record: CompletedTaskReuse, current: TaskReuseUndoScope, side: 'undo' | 'redo' = 'undo') {
  const target = side === 'undo' ? record.applied.target : record.backup.fields;
  return record.serverStatus === 'applied' && record.applied.inputReplaced && record.accountId === current.accountId
    && record.operation.surface === current.surface && record.operation.tabId === current.tabId
    && record.operation.workspaceId === current.workspaceId && record.backup.workspace.workspaceId === current.workspaceId
    && record.applied.workspaceBridgeKey === current.workspaceBridgeKey
    && ['projectId', 'videoCardId', 'videoBranchId'].every(key => (target[key as keyof TaskReuseTarget] || '') === current[key as keyof TaskReuseTarget]);
}
export function hasTaskReuseInput(backup: TaskReuseInputBackup) { return backup.hadInput === true || Boolean(backup.fields.prompt.trim() || backup.workspace.items.length || backup.fields.videoPromptGroups?.length); }
export function taskReuseInputSignature(backup: TaskReuseInputBackup) {
  const fields = backup.fields;
  return JSON.stringify([['prompt', 'generationMode', 'ratio', 'duration', 'resolution', 'seed', 'generateAudio', 'returnLastFrame', 'watermark', 'resolutionApprovalConfirmed', 'model', 'provider', 'auxiliary', 'draftMode', 'unapplied']
    .map(key => fields[key as keyof typeof fields] ?? null), [...backup.workspace.items].sort((a, b) => a.sortOrder - b.sortOrder || a.assetId.localeCompare(b.assetId))
    .map(item => [item.assetId, item.referenceImageId || null, item.role || null, item.sortOrder]), fields.videoPromptGroups || []]);
}
export function taskReuseReplacedInput(before: TaskReuseInputBackup, after: TaskReuseInputBackup) {
  return hasTaskReuseInput(before) && taskReuseInputSignature(before) !== taskReuseInputSignature(after);
}
export function taskReuseOperationQuery(operation: TaskReuseOperationRequest) {
  return new URLSearchParams(Object.fromEntries(['requestId', 'nonce', 'requestHash', 'surface', 'tabId', 'workspaceId'].map(key => [key, String(operation[key as keyof TaskReuseOperationRequest])])));
}
export function sameTaskReuseResultItems(expected: unknown, actual: Array<{ id: string; assetId: string; referenceImageId?: string | null; role?: string | null; sortOrder: number }>) {
  if (!Array.isArray(expected) || expected.length !== actual.length) return false;
  const project = (items: typeof actual) => [...items].sort((a, b) => a.id.localeCompare(b.id)).map(item => [item.id, item.assetId, item.referenceImageId || null, item.role || null, item.sortOrder]);
  return JSON.stringify(project(expected)) === JSON.stringify(project(actual));
}

export type VideoInputSurface = 'normal' | 'ip';
export type ModeInputDraft = { fields: TaskReuseInputBackup['fields']; workspace: WorkspaceInputRecovery | null };
export type VideoModelChoice = { id: string; surface: VideoInputSurface; model: string; label: string; detail: string; disabled?: boolean; disabledReason?: string };
export type ModeSwitchHandoff = {
  version: 1; source: 'mode-switch'; nonce: string; owner: string; tab: string; revision: number;
  sourceSurface: VideoInputSurface; targetSurface: VideoInputSurface; sourceContext: string; targetContext: string;
  sourceInput: TaskReuseInputBackup; targetInput: TaskReuseInputBackup; previousTarget: ModeInputDraft | null;
};
export const videoInputContext = (owner: string, tab: string, surface: VideoInputSurface) => `${owner}:${surface === 'ip' ? 'ip:ip' : 'ordinary:standard'}:tab:${tab}`;
export const videoInputDraftKey = (context: string) => `sd2:video-input-draft:v2:${context}`;
const modeSwitchKey = (owner: string, tab: string, context: string) => `sd2:video-mode-switch:v1:${JSON.stringify([owner, tab, context])}`;
const modeRecoveryKey = (owner: string, tab: string, context: string) => `sd2:video-mode-recovery:v1:${JSON.stringify([owner, tab, context])}`;
function validInputFields(value: TaskReuseInputBackup['fields']): boolean {
  try {
    return Boolean(value && typeof value.prompt === 'string' && value.prompt.length <= 20000
      && ['all_in_one_reference', 'first_last_frame', 'smart_multi_frame'].includes(value.generationMode)
      && typeof value.ratio === 'string' && value.ratio.length <= 32 && typeof value.resolution === 'string' && value.resolution.length <= 32
      && Number.isFinite(value.duration) && value.duration > 0 && Number.isFinite(value.seed)
      && typeof value.model === 'string' && value.model.length <= 200
      && ['generateAudio', 'returnLastFrame', 'watermark'].every(key => typeof value[key as keyof typeof value] === 'boolean')
      && parseVideoPromptGroupRefs(value.videoPromptGroups)
      && (!value.unapplied || parseVideoPromptGroupRefs(value.unapplied.videoPromptGroups)));
  } catch { return false; }
}
export function validModeWorkspace(value: WorkspaceInputRecovery | null | undefined, owner: string, tab: string): value is WorkspaceInputRecovery {
  return Boolean(value && value.ownerId === owner && value.tabId === tab && typeof value.workspaceId === 'string' && value.workspaceId
    && Number.isSafeInteger(value.epoch) && Array.isArray(value.items) && value.items.length <= 80
    && new Set(value.items.map(item => item.assetId)).size === value.items.length
    && value.items.every(item => typeof item.assetId === 'string' && item.assetId.length > 0 && item.assetId.length <= 128
      && (item.referenceImageId == null || typeof item.referenceImageId === 'string' && item.referenceImageId.length <= 128)
      && (item.role == null || typeof item.role === 'string' && item.role.length <= 64) && Number.isSafeInteger(item.sortOrder)));
}
export function parseModeInputDraft(raw: string | null, owner: string, tab: string): ModeInputDraft | null {
  if (!raw || raw.length > 180000) return null;
  try {
    const value = JSON.parse(raw);
    if (value.version !== 2 || !validInputFields(value)) return null;
    const backup = value.inputBackup as TaskReuseInputBackup | undefined;
    if (backup && (backup.version !== 1 || !validInputFields(backup.fields) || !validModeWorkspace(backup.workspace, owner, tab))) return null;
    return { fields: backup?.fields || value, workspace: backup?.workspace || null };
  } catch { return null; }
}
export function modeSwitchInput(source: TaskReuseInputBackup, target: VideoModelChoice, feishu = false): TaskReuseInputBackup {
  const fields = source.fields;
  const unapplied = target.surface === 'ip' ? { videoPromptGroups: fields.videoPromptGroups, draftMode: fields.draftMode,
    auxiliary: fields.auxiliary, feishu: feishu || fields.unapplied?.feishu, h3: fields.provider === 'h3' } : undefined;
  return { ...source, fields: { ...fields, model: target.model, provider: target.model === 'h3' ? 'h3' : 'seedance',
    videoPromptGroups: target.surface === 'ip' ? [] : fields.unapplied?.videoPromptGroups || fields.videoPromptGroups,
    draftMode: target.surface === 'ip' ? false : fields.unapplied?.draftMode ?? fields.draftMode,
    auxiliary: target.surface === 'ip' ? null : fields.unapplied?.auxiliary ?? fields.auxiliary,
    unapplied } };
}
type VideoInputStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export function writeVideoInputDraft(storage: VideoInputStorage, context: string, backup: TaskReuseInputBackup) {
  const raw = JSON.stringify({ version: 2, ...backup.fields, inputBackup: backup });
  storage.setItem(videoInputDraftKey(context), raw);
  if (storage.getItem(videoInputDraftKey(context)) !== raw) throw new Error('输入尚未可靠保存，未切换线路。');
}
export function prepareVideoModeSwitch(storage: VideoInputStorage, sourceContext: string, sourceSurface: VideoInputSurface,
  sourceInput: TaskReuseInputBackup, target: VideoModelChoice, revision: number, nonce: string, feishu = false): ModeSwitchHandoff {
  const { ownerId: owner, tabId: tab } = sourceInput.workspace;
  if (target.disabled || target.surface === sourceSurface || sourceContext !== videoInputContext(owner, tab, sourceSurface)
    || !validModeWorkspace(sourceInput.workspace, owner, tab) || !validInputFields(sourceInput.fields)
    || !Number.isSafeInteger(revision) || revision < 0 || !/^[a-f0-9-]{36}$/i.test(nonce)) throw new Error('当前输入身份尚未确认，未切换线路。');
  const targetContext = videoInputContext(owner, tab, target.surface), oldRaw = storage.getItem(videoInputDraftKey(targetContext));
  const previousTarget = parseModeInputDraft(oldRaw, owner, tab);
  if (oldRaw && !previousTarget) throw new Error('目标线路旧稿暂时无法读取，两份输入均未替换。');
  const value: ModeSwitchHandoff = { version: 1, source: 'mode-switch', nonce, owner, tab, revision, sourceSurface,
    targetSurface: target.surface, sourceContext, targetContext, sourceInput, targetInput: modeSwitchInput(sourceInput, target, feishu), previousTarget };
  writeVideoInputDraft(storage, sourceContext, sourceInput);
  const raw = JSON.stringify(value), recovery = modeRecoveryKey(owner, tab, targetContext), pending = modeSwitchKey(owner, tab, targetContext);
  storage.setItem(recovery, raw);
  if (storage.getItem(recovery) !== raw) throw new Error('目标线路旧稿尚未可靠保留，未切换线路。');
  storage.setItem(pending, raw);
  if (storage.getItem(pending) !== raw) throw new Error('输入交接尚未可靠保存，未切换线路。');
  return value;
}
export function readVideoModeSwitch(storage: VideoInputStorage, owner: string, tab: string, context: string, nonce?: string): ModeSwitchHandoff | null {
  try {
    const pending = nonce ? storage.getItem(modeSwitchKey(owner, tab, context)) : null;
    const raw = pending || storage.getItem(modeRecoveryKey(owner, tab, context));
    if (!raw || raw.length > 400000) return null;
    const value = JSON.parse(raw) as ModeSwitchHandoff;
    if (value.version !== 1 || value.source !== 'mode-switch' || value.owner !== owner || value.tab !== tab || value.targetContext !== context
      || nonce && value.nonce !== nonce || !['ip', 'normal'].includes(value.sourceSurface) || !['ip', 'normal'].includes(value.targetSurface)
      || value.sourceSurface === value.targetSurface || value.sourceContext !== videoInputContext(owner, tab, value.sourceSurface)
      || value.targetContext !== videoInputContext(owner, tab, value.targetSurface) || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !validModeWorkspace(value.sourceInput?.workspace, owner, tab) || !validModeWorkspace(value.targetInput?.workspace, owner, tab)
      || value.sourceInput.workspace.workspaceId !== value.targetInput.workspace.workspaceId
      || !validInputFields(value.sourceInput?.fields) || !validInputFields(value.targetInput?.fields)
      || value.previousTarget && (!validInputFields(value.previousTarget.fields) || value.previousTarget.workspace && !validModeWorkspace(value.previousTarget.workspace, owner, tab))) return null;
    if (nonce && !pending) {
      const applied = parseModeInputDraft(storage.getItem(videoInputDraftKey(context)), owner, tab);
      if (!applied?.workspace || JSON.stringify(applied.fields) !== JSON.stringify(value.targetInput.fields)
        || JSON.stringify(applied.workspace.items) !== JSON.stringify(value.targetInput.workspace.items)) return null;
    }
    return value;
  } catch { return null; }
}
export function finishVideoModeSwitch(storage: VideoInputStorage, value: ModeSwitchHandoff, current: WorkspaceInputRecovery, revision: number) {
  const pending = readVideoModeSwitch(storage, current.ownerId, current.tabId, value.targetContext, value.nonce);
  if (!pending || JSON.stringify(pending) !== JSON.stringify(value) || revision !== 0
    || current.workspaceId !== value.targetInput.workspace.workspaceId
    || JSON.stringify(current.items) !== JSON.stringify(value.targetInput.workspace.items)) throw new Error('输入或素材已变化，未覆盖当前输入。两份原稿仍保留。');
  writeVideoInputDraft(storage, value.targetContext, { ...value.targetInput, workspace: current });
  storage.removeItem(modeSwitchKey(value.owner, value.tab, value.targetContext));
}
export function retainModeRecoveryDraft(storage: VideoInputStorage, context: string, current: TaskReuseInputBackup) {
  const record = readVideoModeSwitch(storage, current.workspace.ownerId, current.workspace.tabId, context);
  if (!record) throw new Error('换线恢复记录尚未确认，两份输入仍保留。');
  const raw = JSON.stringify({ ...record, previousTarget: { fields: current.fields, workspace: current.workspace } });
  const key = modeRecoveryKey(record.owner, record.tab, context);
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw new Error('当前输入尚未可靠保留，未恢复旧稿。');
}
