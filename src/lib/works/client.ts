'use client';

import type { WorkOperationReceipt, WorkQuery } from './types';

export class WorksClientError extends Error {
  constructor(message: string, public status = 0, public code = '') { super(message); }
}
export type PendingWorkOperation = { requestId: string; key: string; endpoint?: string };
type OperationResponse = { viewerId: string; operation: WorkOperationReceipt | { requestId: string; state: 'unknown'; result: null } | null };
const pendingKey = (viewerId: string) => `sd2:works:operations:v1:${viewerId}`;
export function pendingWorkOperations(viewerId: string): PendingWorkOperation[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(pendingKey(viewerId)) || '[]');
    return Array.isArray(value) ? value.filter((item): item is PendingWorkOperation => Boolean(item && typeof item.requestId === 'string' && /^[\w-]{8,100}$/.test(item.requestId) && typeof item.key === 'string')).slice(0, 100) : [];
  } catch { return []; }
}
function writePending(viewerId: string, operations: PendingWorkOperation[]) {
  // Persist identities before submitting so a reload can only query the original operation.
  localStorage.setItem(pendingKey(viewerId), JSON.stringify(operations));
}
export async function worksRead<T>(url: string, viewerId: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', headers: { 'x-app-session-user': viewerId }, signal: signal || AbortSignal.timeout(20000) });
  const data = await response.json();
  if (!response.ok) throw new WorksClientError(data.error || '读取未完成，请重试', response.status, data.code);
  if (data.viewerId && data.viewerId !== viewerId) throw new WorksClientError('账号已变化，请回原账号核对', 409, 'WORKS_ACTOR_CHANGED');
  return data as T;
}
export async function queryWorkOperation(viewerId: string, pending: PendingWorkOperation) {
  const url = pending.endpoint === 'project-audience' ? `/api/works/project-audience?requestId=${encodeURIComponent(pending.requestId)}` : `/api/works/operations/${encodeURIComponent(pending.requestId)}`;
  const data = await worksRead<OperationResponse>(url, viewerId);
  if (data.operation?.state === 'committed') {
    writePending(viewerId, pendingWorkOperations(viewerId).filter(item => item.requestId !== pending.requestId));
    return data.operation.result;
  }
  throw new WorksClientError(pending.key.startsWith('method:')
    ? '还没查到草稿，请再点同一作品的「一键参考」继续'
    : '提交结果待确认，请继续核对原操作', 0, 'WORKS_UNKNOWN');
}
export async function worksMutate(viewerId: string, key: string, url: string, body: Record<string, unknown>, method = 'POST') {
  const existing = pendingWorkOperations(viewerId).find(item => item.key === key);
  // Preparing a reference draft and its receipt commit together. An explicit
  // second click can use the same ID even if the first response was lost.
  const canResume = method === 'POST' && key.startsWith('method:') && url === `/api/works/${encodeURIComponent(key.slice(7))}/method`;
  if (existing && !canResume) return queryWorkOperation(viewerId, existing);
  const requestId = existing?.requestId ?? crypto.randomUUID();
  const pending = { requestId, key, ...(url === '/api/works/project-audience' ? { endpoint: 'project-audience' } : {}) };
  if (!existing) {
    try { writePending(viewerId, [...pendingWorkOperations(viewerId), pending]); }
    catch { throw new WorksClientError('浏览器无法保存原操作编号，本次尚未提交'); }
  }
  const unknown = canResume ? '参考草稿暂未确认，请再点同一作品的「一键参考」继续' : '提交结果待确认，请核对原操作';
  let response: Response;
  try {
    response = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'x-app-session-user': viewerId }, body: JSON.stringify({ ...body, viewerId, requestId }), signal: AbortSignal.timeout(25000) });
  } catch { throw new WorksClientError(unknown, 0, 'WORKS_UNKNOWN'); }
  let data: OperationResponse & { error?: string; code?: string };
  try { data = await response.json(); }
  catch { throw new WorksClientError(unknown, 0, 'WORKS_UNKNOWN'); }
  if (data.viewerId && data.viewerId !== viewerId) throw new WorksClientError('账号已变化，请回原账号核对', 409, 'WORKS_ACTOR_CHANGED');
  if (response.ok && data.operation?.state === 'committed') {
    writePending(viewerId, pendingWorkOperations(viewerId).filter(item => item.requestId !== requestId));
    return data.operation.result;
  }
  if (existing && data.code === 'WORK_OPERATION_CONFLICT') return queryWorkOperation(viewerId, existing);
  if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
    writePending(viewerId, pendingWorkOperations(viewerId).filter(item => item.requestId !== requestId));
    throw new WorksClientError(data.error || '操作未完成，输入已保留', response.status, data.code);
  }
  throw new WorksClientError(unknown, 0, 'WORKS_UNKNOWN');
}
export function worksQueryString(query: WorkQuery) {
  const params = new URLSearchParams();
  for (const key of ['q', 'medium', 'scope', 'author', 'project', 'collection'] as const) if (query[key]) params.set(key, query[key]!);
  return params;
}
export function parseWorksQuery(params: URLSearchParams): WorkQuery {
  const query: WorkQuery = { scope: 'recommended' };
  const medium = params.get('medium'), scope = params.get('scope');
  if (medium === 'image' || medium === 'video') query.medium = medium;
  if (scope && ['all', 'recommended', 'mine', 'favorites', 'hidden', 'managed'].includes(scope)) query.scope = scope as WorkQuery['scope'];
  for (const key of ['author', 'project', 'collection'] as const) { const value = params.get(key); if (value && /^[A-Za-z0-9_-]{1,100}$/.test(value)) query[key] = value; }
  const q = params.get('q')?.trim().slice(0, 120); if (q) query.q = q;
  return query;
}

export function workWorkspaceTabId() {
  let tabId = sessionStorage.getItem('workspace_tab_id');
  if (!tabId) { tabId = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; sessionStorage.setItem('workspace_tab_id', tabId); }
  return tabId;
}

/** Optional evidence never blocks copying, viewing, navigation or generation. */
export function recordWorkEvidence(viewerId: string, workId: string, mediaVersion: string, evidence: Record<string, string>) {
  void fetch(`/api/works/${encodeURIComponent(workId)}/evidence`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-app-session-user': viewerId },
    body: JSON.stringify({ viewerId, mediaVersion, ...evidence }), signal: AbortSignal.timeout(5000), keepalive: true,
  }).catch(() => { /* Missing evidence is unknown; it never changes the real operation. */ });
}
