'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CreationPayer, VideoCreationIntentDTO, CreationEntry } from '@/lib/creation/contract';
export type CreationContextDTO = { project: { id: string; name: string; type: string }; payer: CreationPayer;
  legacyCard: { id: string; title: string; status: string } | null; contextRevision: string; v2Available: boolean };
export type CreationProject = { id: string; name: string; type: string; status?: string; can_generate?: boolean; owner_user_id?: string };
export function isResolvedCreationIntent(intent: VideoCreationIntentDTO | null | undefined) {
  return Boolean(intent && ['accepted', 'closed', 'batch_active', 'batch_settled', 'rejected'].includes(intent.state));
}
type PreparationReceipt = { id?: string; request_id?: string };
async function readOriginal(saved: PreparationReceipt, signal?: AbortSignal) {
  if (!saved.id && !saved.request_id) throw new Error('原准备请求记录无法读取，请保留当前输入');
  return read<{ intent: VideoCreationIntentDTO | null; state?: string }>(saved.id
    ? `/api/video/creation-intents/${encodeURIComponent(saved.id)}`
    : `/api/video/creation-intents?request_id=${encodeURIComponent(saved.request_id!)}`, { signal });
}
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
  const current = useRef({ scope });
  if (current.current.scope !== scope) current.current = { scope };
  const scopeToken = current.current;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const onProject = useRef(options.onProjectChange); onProject.current = options.onProjectChange;
  const sequence = useRef(0);
  const intentSequence = useRef(0);
  const [context, setContext] = useState<CreationContextDTO | null>(null);
  const [loadedScope, setLoadedScope] = useState(scopeToken);
  const [projects, setProjects] = useState<CreationProject[]>([]);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [refreshRevision, refresh] = useState(0);
  const receiptKey = `sd2-creation-preparation-v2:${ownerId || 'session'}:${entry}:${effectiveDraftId}:${projectId || ''}:${legacyCardId || ''}`;
  const [intentRecord, storeIntent] = useState<{ scope: typeof scopeToken; value: VideoCreationIntentDTO | null }>({ scope: scopeToken, value: null });
  const intentRef = useRef(intentRecord); intentRef.current = intentRecord;
  const intent = intentRecord.scope === scopeToken ? intentRecord.value : null;
  const setIntent = useCallback((value: VideoCreationIntentDTO | null) => {
    if (!mounted.current || current.current !== scopeToken) return;
    const record = { scope: scopeToken, value };
    intentRef.current = record; storeIntent(record);
  }, [scopeToken]);
  useEffect(() => {
    const revision = ++sequence.current, captured = scopeToken, controller = new AbortController();
    setLoadedScope(captured);
    setContext(null); setIntent(null); setError('');
    if (!ownerId || !enabled || !tabId) { setLoading(false); return; }
    setLoading(true);
    const active = () => mounted.current && sequence.current === revision && current.current === captured;
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
        const readRevision = intentSequence.current;
        const saved = JSON.parse(receipt) as PreparationReceipt;
        const original = await readOriginal(saved, controller.signal);
        if (!active() || intentSequence.current !== readRevision || sessionStorage.getItem(receiptKey) !== receipt) return;
        if (original.intent) setIntent(original.intent);
        else if (original.state === 'rejected') sessionStorage.removeItem(receiptKey);
        else setError('原准备请求结果待确认，请保留原号后重新读取');
      }
      localStorage.setItem(`sd2-creation-destination-v2:${ownerId}:${entry}:${effectiveDraftId}`, destination);
      if (destination !== projectId) onProject.current?.(destination);
    })().catch(cause => { if (active() && cause.name !== 'AbortError') setError(cause.message); })
      .finally(() => { if (active()) setLoading(false); });
    return () => { controller.abort(); sequence.current++; };
  }, [scopeToken, ownerId, enabled, entry, effectiveDraftId, tabId, projectId, legacyCardId, refreshRevision, receiptKey, setIntent]);
  const prepare = useCallback(async (body: Record<string, unknown>, requestId: string, previous?: VideoCreationIntentDTO | null) => {
    const captured = scopeToken;
    const operation = ++intentSequence.current;
    const assertCurrent = () => {
      if (!mounted.current || current.current !== captured || intentSequence.current !== operation || !ownerId || !tabId) throw new Error('账号、保存位置或原准备已变化，请保留原号后核对');
    };
    assertCurrent();
    const retained = sessionStorage.getItem(receiptKey);
    // A caller's ready snapshot is not proof that the retained request is still unaccepted.
    const saved = retained ? JSON.parse(retained) as PreparationReceipt : previous ? { id: previous.id, request_id: previous.request_id } : null;
    previous = null;
    if (saved) {
      const original = await readOriginal(saved);
      assertCurrent();
      if (!original.intent && original.state === 'rejected') sessionStorage.removeItem(receiptKey);
      else if (!original.intent) throw new Error('原准备请求仍待确认，只能查询原号');
      if (original.intent) {
        setIntent(original.intent);
        if (!isResolvedCreationIntent(original.intent)) { previous = original.intent; requestId = original.intent.request_id; }
        // First adopt a newly discovered result. A later explicit submit may start a new request.
        else if (requestId === original.intent.request_id) return original.intent;
      }
    }
    assertCurrent();
    sessionStorage.setItem(receiptKey, JSON.stringify({ request_id: requestId, ...(previous ? { id: previous.id } : {}) }));
    const data = await read<{ intent: VideoCreationIntentDTO }>('/api/video/creation-intents', { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(ownerId ? { 'x-app-session-user': ownerId } : {}) },
      body: JSON.stringify({ ...body, entry: body.entry || entry, project_id: body.project_id || projectId,
        video_card_id: body.video_card_id ?? legacyCardId ?? null, video_branch_id: body.video_branch_id ?? null,
        request_id: requestId, ...(previous ? { expected_revision: previous.revision } : {}) }) });
    assertCurrent();
    sessionStorage.setItem(receiptKey, JSON.stringify({ id: data.intent.id, request_id: data.intent.request_id }));
    setIntent(data.intent); return data.intent;
  }, [scopeToken, ownerId, tabId, entry, projectId, legacyCardId, receiptKey, setIntent]);
  const queryIntent = useCallback(async (id: string) => {
    if (!mounted.current || current.current !== scopeToken) throw new Error('工作现场已变化，请回原位置核对');
    const operation = ++intentSequence.current;
    const data = await read<{ intent: VideoCreationIntentDTO }>(`/api/video/creation-intents/${encodeURIComponent(id)}`);
    if (!mounted.current || current.current !== scopeToken || intentSequence.current !== operation) throw new Error('工作现场已变化，原请求保留');
    setIntent(data.intent); setError('');
    return data.intent;
  }, [scopeToken, setIntent]);
  const queryOriginal = useCallback(async () => {
    if (!mounted.current || current.current !== scopeToken) throw new Error('工作现场已变化，请回原位置核对');
    const operation = ++intentSequence.current;
    const retained = sessionStorage.getItem(receiptKey);
    const value = intentRef.current.scope === scopeToken ? intentRef.current.value : null;
    const original = await readOriginal(retained ? JSON.parse(retained) : { id: value?.id, request_id: value?.request_id });
    if (!mounted.current || current.current !== scopeToken || intentSequence.current !== operation) throw new Error('工作现场已变化，原请求保留');
    if (original.intent) { setIntent(original.intent); setError(''); return original.intent; }
    if (original.state === 'rejected') { sessionStorage.removeItem(receiptKey); setIntent(null); setError(''); return null; }
    throw new Error('原准备请求仍待确认，只能查询原号');
  }, [scopeToken, receiptKey, setIntent]);
  const acceptTask = useCallback(async (requestId: string, taskId: string) => {
    if (!mounted.current || current.current !== scopeToken) return;
    const retained = sessionStorage.getItem(receiptKey);
    const saved = retained ? JSON.parse(retained) as PreparationReceipt : null;
    const value = intentRef.current.scope === scopeToken ? intentRef.current.value : null;
    if (saved?.request_id && saved.request_id !== requestId || value && value.request_id !== requestId) return;
    if (value?.accepted_task_id === taskId && isResolvedCreationIntent(value)) return;
    const operation = ++intentSequence.current;
    const original = value || (await readOriginal(saved || { request_id: requestId })).intent;
    if (!mounted.current || current.current !== scopeToken || intentSequence.current !== operation || !original || original.request_id !== requestId) return;
    // A task returned by the authenticated creation/status API is an acceptance receipt, not a new create.
    setIntent({ ...original, state: 'accepted', accepted_task_id: taskId }); setError('');
    sessionStorage.setItem(receiptKey, JSON.stringify({ id: original.id, request_id: requestId }));
  }, [scopeToken, receiptKey, setIntent]);
  const isCurrent = useCallback(() => mounted.current && current.current === scopeToken, [scopeToken]);
  return { context: loadedScope === scopeToken ? context : null, projects: loadedScope === scopeToken ? projects : [],
    loading: loadedScope !== scopeToken || loading, error: loadedScope === scopeToken ? error : '', intent,
    prepare, queryIntent, queryOriginal, acceptTask, setIntent, isCurrent, entry,
    refresh: () => refresh(value => value + 1), contextKey: `${ownerId || 'session'}:${entry}:${effectiveDraftId}` };
}
export type CreationContextController = ReturnType<typeof useCreationContext>;
