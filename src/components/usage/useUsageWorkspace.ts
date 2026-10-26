'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import type { UsagePublicQuery, UsageReportDTO } from '@/lib/usage/dto';

const fields = ['month', 'time_zone', 'type', 'project_id', 'member_owner_id', 'status', 'keyword', 'sort', 'page', 'limit'] as const;
export function defaultUsageQuery(projectId?: string): UsagePublicQuery {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return { month: `${parts.find((p) => p.type === 'year')?.value}-${parts.find((p) => p.type === 'month')?.value}`,
    time_zone: timeZone, type: 'video', project_id: projectId || null, member_owner_id: null,
    status: null, keyword: null, sort: 'newest', page: 1, limit: 20 };
}

function normalize(value: unknown, projectId?: string): UsagePublicQuery {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const next = defaultUsageQuery(projectId);
  if (typeof source.month === 'string' && /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(source.month)) next.month = source.month;
  if (typeof source.time_zone === 'string' && source.time_zone.length <= 100) {
    try { new Intl.DateTimeFormat('en', { timeZone: source.time_zone }); next.time_zone = source.time_zone; } catch { /* Use the viewer timezone for invalid saved preferences. */ }
  }
  if (source.type === 'video' || source.type === 'image' || source.type === 'other') next.type = source.type;
  if (source.sort === 'newest' || source.sort === 'oldest' || source.sort === 'cost') next.sort = source.sort;
  for (const key of ['project_id', 'member_owner_id', 'status'] as const) {
    if (typeof source[key] === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(source[key] as string)) next[key] = source[key] as string;
  }
  next.project_id = projectId || next.project_id;
  if (!projectId) next.member_owner_id = null;
  if (typeof source.keyword === 'string') next.keyword = source.keyword.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || null;
  for (const key of ['page', 'limit'] as const) {
    const n = Number(source[key]);
    if (Number.isSafeInteger(n) && n > 0) next[key] = Math.min(n, key === 'limit' ? 50 : 1_000_000_000);
  }
  return next;
}

export function usageQueryParams(query: UsagePublicQuery, projectId?: string) {
  const params = new URLSearchParams();
  for (const key of fields) {
    if (key === 'member_owner_id' && !projectId) continue;
    if (query[key] !== null && query[key] !== '') params.set(key, String(query[key]));
  }
  return params;
}

function pageRange(query: UsagePublicQuery) {
  const { type: _type, page: _page, ...range } = query;
  return JSON.stringify(range);
}

export function useUsageWorkspace(ownerId: string, projectId?: string) {
  const pathname = usePathname();
  const route = useSearchParams().toString();
  const prefix = projectId ? 'usage_' : '';
  const identity = `${ownerId}:${projectId || 'self'}`;
  const key = `sd2:usage:v1:${identity}`;
  const active = useRef(identity); active.current = identity;
  const [state, setState] = useState<{ identity: string; query: UsagePublicQuery } | null>(null);
  const [result, setResult] = useState<{ identity: string; request: string; report: UsageReportDTO } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [revision, setRevision] = useState(0);
  const serial = useRef(0);
  const pages = useRef<Partial<Record<UsagePublicQuery['type'], number>>>({});

  useEffect(() => {
    if (!ownerId) { setState(null); setResult(null); return; }
    const read = () => {
      let saved: unknown = {};
      try { const raw = localStorage.getItem(key); if (raw) saved = JSON.parse(raw); setStorageUnavailable(false); }
      catch { setStorageUnavailable(true); }
      const params = new URLSearchParams(window.location.search);
      const explicit: Record<string, unknown> = {};
      for (const field of fields) if (params.has(prefix + field)) explicit[field] = params.get(prefix + field);
      // Explicit ranges do not inherit hidden filters from an unrelated previous view.
      const base = Object.keys(explicit).length ? defaultUsageQuery(projectId) : normalize(saved, projectId);
      const query = normalize({ ...base, ...explicit }, projectId);
      pages.current = {};
      try {
        const stored = JSON.parse(localStorage.getItem(`${key}:pages`) || '{}');
        if (stored?.range === pageRange(query)) for (const type of ['video', 'image', 'other'] as const) {
          if (Number.isSafeInteger(stored.pages?.[type]) && stored.pages[type] > 0) pages.current[type] = Math.min(stored.pages[type], 1_000_000_000);
        }
      } catch { /* Invalid page memory falls back to the first page. */ }
      setState((previous) => previous?.identity === identity && JSON.stringify(previous.query) === JSON.stringify(query) ? previous : { identity, query });
    };
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, [identity, key, ownerId, prefix, projectId, route]);

  const query = state?.identity === identity ? state.query : null;
  const request = query ? usageQueryParams(query, projectId).toString() : '';
  const endpoint = projectId ? `/api/projects/${encodeURIComponent(projectId)}/usage` : '/api/usage';
  useEffect(() => {
    if (!ownerId || !query) return;
    const controller = new AbortController();
    const current = ++serial.current;
    setBusy(true); setError('');
    void (async () => {
      try {
        const response = await fetch(`${endpoint}?${request}`, { cache: 'no-store', signal: controller.signal, headers: { 'x-app-session-user': ownerId } });
        const data = await response.json();
        if (controller.signal.aborted || active.current !== identity || current !== serial.current) return;
        if (!response.ok) {
          if ([401, 403, 404].includes(response.status)) setResult(null);
          throw new Error(data.message || data.error || '用量暂时无法读取，请重试。');
        }
        if (data.schema !== 1 || data.scope !== (projectId ? 'project' : 'self') || !data.summary || !Array.isArray(data.records?.items)) throw new Error('用量返回内容不完整，请重新读取。');
        setResult({ identity, request, report: data as UsageReportDTO });
      } catch (cause) {
        if (!controller.signal.aborted && active.current === identity && current === serial.current) setError(cause instanceof Error ? cause.message : '用量读取失败');
      } finally { if (!controller.signal.aborted && active.current === identity && current === serial.current) setBusy(false); }
    })();
    return () => controller.abort();
  // Query is represented by its canonical request string.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, identity, ownerId, projectId, request, revision]);

  const update = useCallback((patch: Partial<UsagePublicQuery>, reset = false) => {
    if (!query || !ownerId) return;
    const rangeChanged = Object.keys(patch).some((field) => field !== 'type' && field !== 'page');
    if (reset || rangeChanged) pages.current = {};
    else pages.current[query.type] = result?.request === request ? result.report.records.page : query.page;
    const next = normalize(reset ? defaultUsageQuery(projectId) : { ...query, page: patch.type && !rangeChanged ? pages.current[patch.type] || 1 : 1, ...patch }, projectId);
    pages.current[next.type] = next.page;
    setState({ identity, query: next });
    try { localStorage.setItem(key, JSON.stringify(next)); localStorage.setItem(`${key}:pages`, JSON.stringify({ range: pageRange(next), pages: pages.current })); setStorageUnavailable(false); } catch { setStorageUnavailable(true); }
    const url = new URL(window.location.href);
    for (const field of fields) url.searchParams.delete(prefix + field);
    usageQueryParams(next, projectId).forEach((value, field) => url.searchParams.set(prefix + field, value));
    url.hash = '';
    window.history.replaceState(window.history.state, '', `${pathname}?${url.searchParams.toString()}`);
  }, [identity, key, ownerId, pathname, prefix, projectId, query, request, result]);

  const report = result?.identity === identity ? result.report : null;
  return { query, report, current: Boolean(result?.identity === identity && result.request === request), busy, error, storageUnavailable,
    update, reload: () => setRevision((v) => v + 1), endpoint, request, identity };
}
