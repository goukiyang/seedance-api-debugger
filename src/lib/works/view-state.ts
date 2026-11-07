'use client';

import { parseWorksQuery, worksQueryString } from './client';
import type { WorkQuery } from './types';

export type WorkAnchor = { id: string; offset: number; focusId?: string; focusAction?: string };
export type WorkRestore = WorkAnchor & { navigationEpoch: number; generation: number };
export type SavedWorkView = { query: WorkQuery & { work?: string }; window: string; anchor: WorkAnchor | null; atStart?: boolean };
const sessionKey = (viewerId: string) => `sd2:works:view:v1:${viewerId}`;
const fallbackKey = (viewerId: string) => `sd2:works:last-view:v1:${viewerId}`;
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
function snapshot(value: unknown): SavedWorkView | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!raw.query || typeof raw.query !== 'object' || typeof raw.window !== 'string' || raw.window.length > 4096) return null;
  const source = raw.query as Record<string, unknown>, params = new URLSearchParams();
  for (const key of ['q', 'medium', 'scope', 'author', 'project', 'collection'] as const) if (typeof source[key] === 'string') params.set(key, source[key]);
  const query: SavedWorkView['query'] = parseWorksQuery(params);
  if (safeId(source.work)) query.work = source.work;
  const anchor = raw.anchor as Record<string, unknown> | null;
  return { query, window: raw.window, atStart: raw.atStart === true, anchor: anchor && safeId(anchor.id) && typeof anchor.offset === 'number' && Number.isFinite(anchor.offset) ? { id: anchor.id, offset: anchor.offset, ...(safeId(anchor.focusId) ? { focusId: anchor.focusId } : {}), ...(typeof anchor.focusAction === 'string' && /^[a-z-]{1,40}$/.test(anchor.focusAction) ? { focusAction: anchor.focusAction } : {}) } : null };
}
function sessionViews(viewerId: string): SavedWorkView[] {
  try { const raw: unknown = JSON.parse(sessionStorage.getItem(sessionKey(viewerId)) || '[]'); return Array.isArray(raw) ? raw.map(snapshot).filter((view): view is SavedWorkView => Boolean(view)).slice(0, 6) : []; }
  catch { return []; }
}
export function savedWorkView(viewerId: string, queryKey?: string): SavedWorkView | null {
  const views = sessionViews(viewerId);
  const session = queryKey === undefined ? views[0] : views.find(view => worksQueryString(view.query).toString() === queryKey);
  if (session) return session;
  try {
    const last = snapshot(JSON.parse(localStorage.getItem(fallbackKey(viewerId)) || 'null'));
    return last && (queryKey === undefined || worksQueryString(last.query).toString() === queryKey) ? last : null;
  } catch { return null; }
}
export function saveWorkView(viewerId: string, view: SavedWorkView) {
  // Only the whitelisted query, opaque window and work ID/local offset survive a tab close.
  const clean = snapshot(view); if (!clean) return;
  const key = worksQueryString(clean.query).toString();
  try { sessionStorage.setItem(sessionKey(viewerId), JSON.stringify([clean, ...sessionViews(viewerId).filter(item => worksQueryString(item.query).toString() !== key)].slice(0, 6))); } catch { /* Optional per-tab restoration. */ }
  try { localStorage.setItem(fallbackKey(viewerId), JSON.stringify(clean)); } catch { /* Browsing remains usable when optional storage is unavailable. */ }
}
export function savedWorkUrl(view: SavedWorkView, pathname = '/works') {
  const params = worksQueryString(view.query);
  if (view.query.work) params.set('work', view.query.work);
  if (!params.size) params.set('scope', 'all');
  return `${pathname}?${params}`;
}
