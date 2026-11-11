import type { FusionRow, FusionSettings } from '@/lib/character-fusion/engine';
import type { FusionCatalogue } from '@/lib/character-fusion/catalogue-model';

export type { FusionWorkspace, FusionWorkspaceState as WorkspaceState, FusionCommand, FusionOperation } from '@/lib/character-fusion/actions';
import type { FusionWorkspace, FusionWorkspaceState, FusionCommand, FusionOperation, FusionWorkspaceRow, FusionFieldChange } from '@/lib/character-fusion/actions';
export type WorkspaceOperation = FusionOperation;
export type RowsPage = { nextCursor: string | null; total: number };
export type WorkspaceReceipt = { workspace: FusionWorkspace; operation: FusionOperation; rowsPage?: RowsPage; rowChanges?: { upsert: FusionWorkspaceRow[]; removedIds: string[]; order?: string[] } };
export type CreationTarget = { rowId: string; version: number; label: string };
export type CreationContinuation = { formatVersion: 1; planId: string; sourceOpId: string; catalogueOpId: string; workspaceOpId: string; mode: 'save' | 'generate'; baseVersion: number; workspaceId: string; entries?: unknown[]; phase?: string };
export type UnappliedProposal = { reply?: string; commands?: unknown[]; drafts?: unknown[]; continuation?: CreationContinuation };
export type OperationLookup = { proposal?: UnappliedProposal; error?: string; reply?: string; phase?: string; status: 'planning' | 'committed' | 'rejected' | 'cancelled' | 'unknown'; workspace?: FusionWorkspace; operation?: FusionOperation; rowsPage?: RowsPage; rowChanges?: WorkspaceReceipt['rowChanges']; drafts?: unknown[]; continuation?: CreationContinuation };
export const WORKSPACE_API = '/api/character-fusion/workspaces';

export class FusionRequestError extends Error {
  constructor(message: string, public status: number, public code?: string, public details?: unknown) { super(message); }
}
export async function fusionRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const data = await response.json();
  if (!response.ok) throw new FusionRequestError(data.error || '操作未确认，当前草稿已保留。', response.status, data.code, data.details);
  return data as T;
}
export function postFusion<T>(url: string, body: unknown, signal?: AbortSignal) {
  return fusionRequest<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
}
export function lookupOperation(workspaceId: string, opId: string, signal?: AbortSignal) {
  return fusionRequest<OperationLookup>(`${WORKSPACE_API}/${encodeURIComponent(workspaceId)}/actions?opId=${encodeURIComponent(opId)}`, { signal });
}

export function settingsChanges(before: FusionSettings, after: FusionSettings): FusionFieldChange[] {
  const walk = (a: unknown, b: unknown, path: string[]): FusionFieldChange[] => {
    if (['catalogue.dynamic.snapshot', 'catalogue.dynamic.formatVersion'].includes(path.join('.'))) return [];
    if (JSON.stringify(a) === JSON.stringify(b)) return [];
    if (b && typeof b === 'object' && !Array.isArray(b) && (a === undefined || a === null || typeof a === 'object' && !Array.isArray(a))) {
      const previous = (a || {}) as Record<string, unknown>, next = b as Record<string, unknown>;
      return Array.from(new Set([...Object.keys(previous), ...Object.keys(next)])).flatMap(key => walk(previous[key], next[key], [...path, key]));
    }
    return [{ path, value: b ?? null, expected: a ?? null }];
  };
  return walk(before, after, []);
}
export function stateCommands(before: FusionWorkspaceState, after: FusionWorkspaceState): FusionCommand[] {
  const commands: FusionCommand[] = [], changes = settingsChanges(before.settings, after.settings);
  if (changes.length) commands.push({ type: 'patchSettings', changes });
  if (before.idea !== after.idea || before.summary !== after.summary) commands.push({ type: 'context', ...(before.idea !== after.idea ? { idea: after.idea } : {}), ...(before.summary !== after.summary ? { summary: after.summary } : {}), expected: { idea: before.idea, summary: before.summary } });
  if (JSON.stringify(before.intent?.requirements || []) !== JSON.stringify(after.intent?.requirements || [])) commands.push({ type: 'intent', requirements: after.intent?.requirements || [], expected: before.intent || { requirements: [] } });
  if (JSON.stringify(before.selectedIds) !== JSON.stringify(after.selectedIds) || JSON.stringify(before.retainedIds) !== JSON.stringify(after.retainedIds)) commands.push({ type: 'selection', ...(JSON.stringify(before.selectedIds) !== JSON.stringify(after.selectedIds) ? { selectedIds: after.selectedIds, expected: { selectedIds: before.selectedIds } } : {}), ...(JSON.stringify(before.retainedIds) !== JSON.stringify(after.retainedIds) ? { retainedIds: after.retainedIds, expected: { ...(JSON.stringify(before.selectedIds) !== JSON.stringify(after.selectedIds) ? { selectedIds: before.selectedIds } : {}), retainedIds: before.retainedIds } } : {}) });
  return commands;
}
/** Keep edits made after the request started while accepting unrelated server changes. */
export function mergeWorkspaceState(base: FusionWorkspaceState, local: FusionWorkspaceState, remote: FusionWorkspaceState): FusionWorkspaceState {
  const merge = (a: unknown, b: unknown, c: unknown, path: string[] = []): unknown => {
    if (JSON.stringify(a) === JSON.stringify(b)) return c;
    if (path.join('.') === 'settings.catalogue.dynamic.snapshot' && b && c) {
      const localSnapshot = b as FusionCatalogue, remoteSnapshot = c as FusionCatalogue;
      return { version: remoteSnapshot.version, categories: Array.from(new Map([...localSnapshot.categories, ...remoteSnapshot.categories].map(category => [category.id, category])).values()), terms: Array.from(new Map([...localSnapshot.terms, ...remoteSnapshot.terms].map(term => [term.id, term])).values()) };
    }
    if (b && c && typeof b === 'object' && typeof c === 'object' && !Array.isArray(b) && !Array.isArray(c) && (a === undefined || a === null || typeof a === 'object' && !Array.isArray(a))) {
      const previous = (a || {}) as Record<string, unknown>, current = b as Record<string, unknown>, next = c as Record<string, unknown>;
      return Object.fromEntries(Array.from(new Set([...Object.keys(current), ...Object.keys(next)])).map(key => [key, merge(previous[key], current[key], next[key], [...path, key])]));
    }
    return b;
  };
  const compatibleRemote = { ...remote, intent: remote.intent ?? base.intent, formatVersion: remote.formatVersion ?? base.formatVersion, summaryMeta: remote.summaryMeta ?? base.summaryMeta, identity: remote.identity ?? base.identity };
  return { ...merge(base, local, compatibleRemote) as FusionWorkspaceState, messages: remote.messages, formatVersion: compatibleRemote.formatVersion, summaryMeta: compatibleRemote.summaryMeta, identity: compatibleRemote.identity };
}

export function mergeWorkspaceRows(current: FusionRow[], receipt: Pick<WorkspaceReceipt, 'workspace' | 'rowChanges'>, replace = false, appendPage = false): FusionWorkspaceRow[] {
  if (replace) return receipt.workspace.rows;
  const removed = new Set(receipt.rowChanges?.removedIds || []), updates = new Map([...(receipt.workspace.rows || []), ...(receipt.rowChanges?.upsert || [])].map(row => [row.id, row]));
  const existing = new Map(current.filter(row => !removed.has(row.id)).map(row => [row.id, row as FusionWorkspaceRow]));
  updates.forEach((next, id) => { if (!existing.has(id) || next.version >= existing.get(id)!.version) existing.set(id, next); });
  const prefix = appendPage ? [] : receipt.workspace.rows.map(row => row.id), order = Array.from(new Set([...(receipt.rowChanges?.order || []), ...prefix, ...current.map(row => row.id), ...Array.from(updates.keys())]));
  return order.flatMap(id => { const row = existing.get(id); return row ? [row] : []; });
}

export type WorkspaceConflict = { path: string[]; draft: unknown; remote: unknown };
export function workspaceConflicts(base: FusionWorkspaceState, local: FusionWorkspaceState, remote: FusionWorkspaceState): WorkspaceConflict[] {
  const walk = (a: unknown, b: unknown, c: unknown, path: string[]): WorkspaceConflict[] => {
    if (path.join('.') === 'settings.catalogue.dynamic.snapshot' || ['messages', 'formatVersion', 'summaryMeta', 'identity'].includes(path[0]) || JSON.stringify(a) === JSON.stringify(b) || JSON.stringify(a) === JSON.stringify(c) || JSON.stringify(b) === JSON.stringify(c)) return [];
    if (b && c && typeof b === 'object' && typeof c === 'object' && !Array.isArray(b) && !Array.isArray(c) && (a === undefined || a === null || typeof a === 'object' && !Array.isArray(a))) {
      const original = (a || {}) as Record<string, unknown>, draft = b as Record<string, unknown>, server = c as Record<string, unknown>;
      return Array.from(new Set([...Object.keys(draft), ...Object.keys(server)])).flatMap(key => walk(original[key], draft[key], server[key], [...path, key]));
    }
    return [{ path, draft: b, remote: c }];
  };
  return walk(base, local, { ...remote, intent: remote.intent ?? base.intent }, []);
}
