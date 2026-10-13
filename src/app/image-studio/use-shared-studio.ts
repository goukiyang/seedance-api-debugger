'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { UploadedAssetPayload } from '@/lib/http/file-upload';
import type { SharedStudioDefaults, SharedStudioIntent } from '@/lib/image-studio/shared-types';
import type { ModuleCoverDTO } from '@/lib/image-studio/module-cover-types';
import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_QUALITY_OPTIONS, IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS } from '@/lib/image-studio/model-catalog';
import { MAX_REFERENCE_IMAGES } from '@/lib/image-studio/limits';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';

export function hasSharedDefaults(value: unknown): value is SharedStudioDefaults {
  if (!value || typeof value !== 'object') return false;
  const defaults = value as SharedStudioDefaults;
  const policy = defaults.referencePolicy;
  return ['model', 'quality', 'resolution', 'aspectRatio'].every(key => typeof (value as Record<string, unknown>)[key] === 'string' && Boolean((value as Record<string, unknown>)[key]))
    && IMAGE_STUDIO_MODELS.includes(defaults.model) && IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[defaults.model].includes(defaults.quality)
    && IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS[defaults.model].includes(defaults.resolution)
    && Number.isInteger(defaults.count) && defaults.count >= 1 && defaults.count <= 8
    && Number.isInteger(defaults.referenceLimit) && defaults.referenceLimit >= 1 && defaults.referenceLimit <= MAX_REFERENCE_IMAGES
    && Boolean(policy) && Array.isArray(policy.primaryIds) && policy.primaryIds.every(id => typeof id === 'string')
    && [policy.primaryMin, policy.primaryMax, policy.auxiliaryMax].every(limit => Number.isInteger(limit) && limit >= 0 && limit <= MAX_REFERENCE_IMAGES)
    && [policy.styleMax, policy.referenceMax].every(limit => limit === undefined || Number.isInteger(limit) && limit >= 0 && limit <= MAX_REFERENCE_IMAGES)
    && policy.primaryMax >= 1 && policy.primaryMin <= policy.primaryMax && typeof policy.useFixedReferences === 'boolean';
}

export type SharedStudioEntry = {
  presetId: string; name: string; groupName: string; banner?: UploadedAssetPayload | null;
  isShared: boolean; fixedCover?: ModuleCoverDTO | null;
  revision?: string; available: boolean; unavailableReason?: string;
};
type SharedModule = { id: string; sharedLive?: { intent: SharedStudioIntent; available: boolean } | null };
type Catalog = { owner: string; items: SharedStudioEntry[]; revision: string; cursor: string | null; pages: number; ready: boolean };
class SharedReadError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
async function readShared<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  const value = await response.json();
  if (!response.ok) throw new SharedReadError(response.status, value.error || '模板同步暂不可用');
  return value as T;
}

// One serial loop owns revision, catalog pages and active definition reads.
export function useSharedStudio<T extends SharedModule>({ userId, activeModule, onDefinition, onUnavailable }: {
  userId: string; activeModule?: T; onDefinition: (module: T) => void;
  onUnavailable: (presetId: string | null, reason: string) => void;
}) {
  const { sessionChanged } = useAppSession();
  const presetId = activeModule?.sharedLive?.intent.presetId || '';
  const moduleId = activeModule?.id || '';
  const scopeKey = `${userId}:${presetId}:${moduleId}`;
  const scope = useRef({ key: scopeKey });
  if (scope.current.key !== scopeKey) scope.current = { key: scopeKey };
  const latest = useRef({ activeModule, onDefinition, onUnavailable });
  latest.current = { activeModule, onDefinition, onUnavailable };
  const [catalog, setCatalog] = useState<Catalog>({ owner: userId, items: [], revision: '', cursor: null, pages: 0, ready: false });
  const catalogRef = useRef(catalog); catalogRef.current = catalog;
  const [feedback, setFeedback] = useState({ owner: userId, error: '', loading: true });
  const wake = useRef<(force?: boolean, more?: boolean) => void>(() => {});
  const generation = useRef(0);
  const refresh = useCallback(() => wake.current(true), []);
  const loadMore = useCallback(() => wake.current(false, true), []);

  useEffect(() => {
    if (sessionChanged || isClientSessionBlocked()) return;
    const current = scope.current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false, queued = false, force = true, more = false;
    let consecutiveFailures = 0;
    let appliedToken = '';
    const valid = () => !isClientSessionBlocked() && scope.current === current && !controller.signal.aborted;
    const online = () => !document.hidden && navigator.onLine;
    if (catalogRef.current.owner !== userId) {
      const empty: Catalog = { owner: userId, items: [], revision: '', cursor: null, pages: 0, ready: false };
      catalogRef.current = empty; setCatalog(empty);
    }
    const commit = (next: Catalog) => { if (valid()) { catalogRef.current = next; setCatalog(next); } };
    const run = async () => {
      if (!valid() || !online()) return;
      if (running) { queued = true; return; }
      running = true; queued = false;
      const epoch = generation.current;
      const currentRead = () => valid() && generation.current === epoch && online();
      const forced = force, append = more;
      force = false; more = false;
      const initial = catalogRef.current;
      if (!initial.ready || append) setFeedback({ owner: userId, error: '', loading: true });
      try {
        const revision = await readShared<{ catalogRevision: string; activeDefinitionToken: string | null; activeAvailable: boolean }>(
          `/api/image-studio/shared?mode=revision${presetId ? `&activePresetId=${encodeURIComponent(presetId)}` : ''}`, controller.signal);
        if (!currentRead()) return;
        if (typeof revision.catalogRevision !== 'string') throw new Error('模板同步暂不可用');
        const changed = initial.revision !== revision.catalogRevision;
        if (forced || changed || !initial.ready || append && initial.cursor) {
          const items = new Map<string, SharedStudioEntry>();
          let cursor: string | null = null, pages = 0;
          if (!forced && !changed && initial.ready && append) {
            initial.items.forEach(item => items.set(item.presetId, item));
            cursor = initial.cursor; pages = initial.pages;
          }
          const targetPages = !forced && !changed && append ? pages + 1 : Math.max(1, initial.pages + (append ? 1 : 0));
          const seenCursors = new Set<string>();
          do {
            const params = new URLSearchParams({ limit: '100', catalogRevision: revision.catalogRevision });
            if (cursor) params.set('cursor', cursor);
            const page = await readShared<{ items: SharedStudioEntry[]; nextCursor: string | null; catalogRevision: string }>(`/api/image-studio/shared?${params}`, controller.signal);
            if (!currentRead()) return;
            if (page.catalogRevision !== revision.catalogRevision) throw new SharedReadError(409, '模板目录已变化');
            if (!Array.isArray(page.items)) throw new Error('模板同步暂不可用');
            page.items.forEach(item => { if (item && typeof item.presetId === 'string') items.set(item.presetId, item); });
            cursor = page.nextCursor || null; pages++;
            if (cursor && seenCursors.has(cursor)) throw new Error('模板目录暂不可用');
            if (cursor) seenCursors.add(cursor);
          } while (cursor && pages < targetPages);
          if (!cursor) for (const prior of initial.items) if (!items.has(prior.presetId)) latest.current.onUnavailable(prior.presetId, '模板已停止共享或不可用');
          commit({ owner: userId, items: Array.from(items.values()), revision: revision.catalogRevision, cursor, pages, ready: true });
        }
        if (presetId && revision.activeAvailable === false) {
          appliedToken = '';
          latest.current.onUnavailable(presetId, '模板已不可用');
        } else if (presetId && (forced || revision.activeDefinitionToken !== appliedToken)) {
          const data = await readShared<{ modules: T[] }>(`/api/image-studio/modules?ids=${encodeURIComponent(moduleId)}`, controller.signal);
          if (!currentRead()) return;
          const workspace = data.modules.find(item => item.id === moduleId && item.sharedLive?.intent.presetId === presetId);
          if (!workspace?.sharedLive?.available) latest.current.onUnavailable(presetId, '模板已不可用');
          else {
            // A definition can change between revision and detail. Its own token is authoritative.
            appliedToken = workspace.sharedLive.intent.definitionToken;
            latest.current.onDefinition(workspace);
          }
        }
        if (currentRead()) {
          consecutiveFailures = 0;
          setFeedback({ owner: userId, error: '', loading: false });
        }
      } catch (cause) {
        if (!currentRead()) return;
        consecutiveFailures++;
        if (cause instanceof SharedReadError && [401, 403].includes(cause.status)) {
          commit({ owner: userId, items: [], revision: '', cursor: null, pages: 0, ready: true });
          latest.current.onUnavailable(null, '模板已不可用');
        } else if (cause instanceof SharedReadError && cause.status === 404 && presetId) {
          latest.current.onUnavailable(presetId, '模板已不可用');
        } else if (cause instanceof SharedReadError && cause.status === 409) force = true;
        setFeedback({ owner: userId, error: '模板同步暂不可用', loading: false });
      } finally {
        running = false;
        const delay = consecutiveFailures ? Math.min(30000, 2000 * 2 ** Math.min(consecutiveFailures, 4)) : queued ? 0 : 2000;
        if (valid() && online()) timer = setTimeout(() => { void run(); }, delay);
      }
    };
    wake.current = (fresh = false, next = false) => {
      if (!valid()) return;
      if (fresh) generation.current++;
      force ||= fresh; more ||= next;
      if (timer) clearTimeout(timer);
      if (running) queued = true; else void run();
    };
    const resume = () => {
      if (timer) clearTimeout(timer);
      if (online()) wake.current(true);
      else generation.current++;
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    window.addEventListener('offline', resume);
    void run();
    return () => {
      controller.abort(); if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', resume);
      window.removeEventListener('offline', resume);
    };
  }, [sessionChanged, scopeKey, userId, presetId, moduleId]);

  const visible = catalog.owner === userId ? catalog : null;
  return { items: visible?.items || [], ready: visible?.ready || false, hasMore: Boolean(visible?.cursor),
    catalogRevision: visible?.revision || '', loading: feedback.owner !== userId || feedback.loading,
    error: feedback.owner === userId ? feedback.error : '', refresh, loadMore };
}
