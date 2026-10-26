'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CreationPayer, VideoCreationIntentDTO, CreationEntry } from '@/lib/creation/contract';
export type CreationContextDTO = { project: { id: string; name: string; type: string }; payer: CreationPayer;
  legacyCard: { id: string; title: string; status: string } | null; contextRevision: string; v2Available: boolean };
export type CreationProject = { id: string; name: string; type: string; status?: string; can_generate?: boolean; owner_user_id?: string };
async function read<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.message || value.error || '暂时无法确认，请保留当前输入'), { code: value.code, field: value.field, action: value.action, status: response.status });
  return value as T;
}
/** Browsing another project never writes this destination. All late responses are scoped to actor/draft/revision. */
export function useCreationContext(options: { ownerId?: string | null; entry: CreationEntry; draftId: string;
  projectId?: string | null; legacyCardId?: string | null; enabled?: boolean; onProjectChange?: (id: string) => void }) {
  const { ownerId, entry, draftId, projectId, legacyCardId, enabled = true } = options;
  const [tabId, setTabId] = useState<string | null>(null);
  useEffect(() => { try { let tab = sessionStorage.getItem('workspace_tab_id'); if (!tab) { tab = crypto.randomUUID(); sessionStorage.setItem('workspace_tab_id', tab); } setTabId(tab); } catch { setTabId(null); } }, []);
  const effectiveDraftId = `${draftId}:tab:${tabId || 'pending'}`;
  const scope = JSON.stringify([ownerId, entry, effectiveDraftId, projectId || '', legacyCardId || '']);
  const current = useRef(scope); current.current = scope;
  const onProject = useRef(options.onProjectChange); onProject.current = options.onProjectChange;
  const sequence = useRef(0);
  const [context, setContext] = useState<CreationContextDTO | null>(null);
  const [projects, setProjects] = useState<CreationProject[]>([]);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [refreshRevision, refresh] = useState(0);
  const receiptKey = `sd2-creation-preparation-v2:${ownerId || 'session'}:${entry}:${effectiveDraftId}:${projectId || ''}:${legacyCardId || ''}`;
  const [intent, setIntent] = useState<VideoCreationIntentDTO | null>(null);
  useEffect(() => {
    const revision = ++sequence.current, captured = scope, controller = new AbortController();
    setContext(null); setIntent(null); setError('');
    if (!ownerId || !enabled || !tabId) { setLoading(false); return; }
    setLoading(true);
    const active = () => sequence.current === revision && current.current === captured;
    void (async () => {
      let destination = projectId || '';
      if (!destination) {
        const key = `sd2-creation-destination-v2:${ownerId}:${entry}:${effectiveDraftId}`;
        const explicit = new URLSearchParams(window.location.search).get('project_id');
        destination = explicit || localStorage.getItem(key) || '';
        if (!destination) {
          const directory = await read<{ projects: CreationProject[] }>('/api/projects?lite=true', { signal: controller.signal });
          if (!active()) return;
          setProjects(directory.projects);
          const personal = directory.projects.find(row => row.type === 'personal' && row.owner_user_id === ownerId && row.can_generate !== false);
          destination = personal?.id || '';
          // Only a proven absent personal space for a brand-new independent draft may be initialized.
          if (!destination && !legacyCardId) {
            const created = await read<{ project?: CreationProject }>('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'personal', name: '个人空间' }) });
            destination = created.project?.id || '';
          }
        }
      }
      if (!active()) return;
      if (!destination) throw new Error('请选择保存到的项目');
      const query = new URLSearchParams({ project_id: destination });
      if (legacyCardId) query.set('video_card_id', legacyCardId);
      const value = await read<CreationContextDTO>(`/api/creation/context?${query}`, { signal: controller.signal });
      if (!active()) return;
      setContext(value);
      const receipt = sessionStorage.getItem(receiptKey);
      if (receipt) {
        const saved = JSON.parse(receipt) as { id?: string; request_id?: string };
        const original = saved.id ? await read<{ intent: VideoCreationIntentDTO }>(`/api/video/creation-intents/${encodeURIComponent(saved.id)}`, { signal: controller.signal })
          : saved.request_id ? await read<{ intent: VideoCreationIntentDTO | null; state?: string }>(`/api/video/creation-intents?request_id=${encodeURIComponent(saved.request_id)}`, { signal: controller.signal }) : null;
        if (active() && original?.intent) setIntent(original.intent);
        else if (active() && original && 'state' in original && original.state === 'rejected') sessionStorage.removeItem(receiptKey);
        else if (active() && !saved.id) setError('原准备请求结果待确认，请保留原号后重新读取');
      }
      localStorage.setItem(`sd2-creation-destination-v2:${ownerId}:${entry}:${effectiveDraftId}`, destination);
      if (destination !== projectId) onProject.current?.(destination);
    })().catch(cause => { if (active() && cause.name !== 'AbortError') setError(cause.message); })
      .finally(() => { if (active()) setLoading(false); });
    return () => { controller.abort(); sequence.current++; };
  }, [scope, ownerId, enabled, entry, effectiveDraftId, tabId, projectId, legacyCardId, refreshRevision, receiptKey]);
  const prepare = useCallback(async (body: Record<string, unknown>, requestId: string, previous?: VideoCreationIntentDTO | null) => {
    const captured = current.current;
    const retained = sessionStorage.getItem(receiptKey);
    if (retained && !previous) {
      const saved = JSON.parse(retained) as { id?: string; request_id?: string };
      const original = saved.id ? await read<{intent: VideoCreationIntentDTO}>(`/api/video/creation-intents/${encodeURIComponent(saved.id)}`)
        : await read<{intent: VideoCreationIntentDTO | null; state?: string}>(`/api/video/creation-intents?request_id=${encodeURIComponent(saved.request_id || '')}`);
      if (!original.intent && 'state' in original && original.state === 'rejected') sessionStorage.removeItem(receiptKey);
      else if (!original.intent) throw new Error('原准备请求仍待确认，只能查询原号');
      if (original.intent && !['accepted','closed','batch_active','batch_settled','rejected'].includes(original.intent.state)) { previous = original.intent; requestId = original.intent.request_id; }
    }
    sessionStorage.setItem(receiptKey, JSON.stringify({ request_id: requestId, ...(previous ? { id: previous.id } : {}) }));
    const data = await read<{ intent: VideoCreationIntentDTO }>('/api/video/creation-intents', { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(ownerId ? { 'x-app-session-user': ownerId } : {}) },
      body: JSON.stringify({ ...body, entry: body.entry || entry, project_id: body.project_id || projectId,
        video_card_id: body.video_card_id ?? legacyCardId ?? null, video_branch_id: body.video_branch_id ?? null,
        request_id: requestId, ...(previous ? { expected_revision: previous.revision } : {}) }) }).catch(cause => {
          if (!previous && Number(cause.status) >= 400 && Number(cause.status) < 500) sessionStorage.removeItem(receiptKey);
          throw cause;
        });
    if (current.current !== captured) throw new Error('账号或保存位置已变化，原请求保留，请回原位置核对');
    sessionStorage.setItem(receiptKey, JSON.stringify({ id: data.intent.id, request_id: data.intent.request_id }));
    setIntent(data.intent); return data.intent;
  }, [ownerId, entry, projectId, legacyCardId, receiptKey]);
  const queryIntent = useCallback(async (id: string) => {
    const captured = current.current;
    const data = await read<{ intent: VideoCreationIntentDTO }>(`/api/video/creation-intents/${encodeURIComponent(id)}`);
    if (current.current === captured) setIntent(data.intent);
    return data.intent;
  }, []);
  return { context, projects, loading, error, intent, prepare, queryIntent, setIntent,
    refresh: () => refresh(value => value + 1), contextKey: `${ownerId || 'session'}:${entry}:${effectiveDraftId}` };
}
export type CreationContextController = ReturnType<typeof useCreationContext>;
