import { parseTaskReuseOperationRequest, taskReuseReceiptKey, type TaskReuseContext, type TaskReuseOperationRequest, type TaskReuseOperationStatus } from './task-reuse-intent';
import type { WorkspaceInputRecovery } from '@/lib/hooks/useWorkspace';
export type TaskReuseInputBackup = { version: 1; hadInput?: boolean; workspace: WorkspaceInputRecovery; fields: {
  prompt: string; generationMode: string; ratio: string; duration: number; resolution: string; seed: number;
  generateAudio: boolean; returnLastFrame: boolean; watermark: boolean; resolutionApprovalConfirmed: boolean;
  model: string; provider?: string | null; auxiliary?: string | null; projectId?: string; videoCardId?: string; videoBranchId?: string;
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
export function hasTaskReuseInput(backup: TaskReuseInputBackup) { return backup.hadInput === true || Boolean(backup.fields.prompt.trim() || backup.workspace.items.length); }
export function taskReuseInputSignature(backup: TaskReuseInputBackup) {
  const fields = backup.fields;
  return JSON.stringify([['prompt', 'generationMode', 'ratio', 'duration', 'resolution', 'seed', 'generateAudio', 'returnLastFrame', 'watermark', 'resolutionApprovalConfirmed', 'model', 'provider', 'auxiliary']
    .map(key => fields[key as keyof typeof fields] ?? null), [...backup.workspace.items].sort((a, b) => a.sortOrder - b.sortOrder || a.assetId.localeCompare(b.assetId))
    .map(item => [item.assetId, item.referenceImageId || null, item.role || null, item.sortOrder])]);
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
