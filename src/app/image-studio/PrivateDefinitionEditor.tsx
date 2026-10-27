'use client';

import { useEffect, useRef, useState, type RefObject, type MutableRefObject } from 'react';
import { Copy, FileText, RefreshCw, Save, X } from 'lucide-react';
import { isClientSessionBlocked, watchSessionExit } from '@/lib/auth/client-session-boundary';
import styles from './studio.module.css';
import { useProductDialog } from '@/components/useProductDialog';
import { readLegacyPrivateDraft, acknowledgeLegacyPrivateDraft, type LegacyPrivateDraft } from './private-draft-migration';

type Values = { prompt: string; context: string };
type Draft = { revision: number; sourceRevision: string; values: Values; appliedRequestId?: string };
type Loaded = Values & { revision: number; sourceRevision: string; draft: Draft | null };
type Pending = { kind: 'draft' | 'save'; requestId: string };
type Props = { userId: string; moduleId: string; dialog: RefObject<HTMLElement>; blocked: boolean; open?: boolean;
  canRead: boolean; needsIdentity: boolean; onSaved: (revision: number) => void;
  beforeClose: MutableRefObject<(() => Promise<boolean>) | null>; legacyDraftKey?: string; legacyDraftKeys?: string[];
  endpoint?: string; contextOnly?: boolean; label?: string; maxLength?: number; allowEmpty?: boolean };

export function PrivateDefinitionEditor(props: Props) {
  const { confirm, productDialog } = useProductDialog();
  const endpoint = props.endpoint || '/api/image-studio/modules';
  const label = props.label || '模板原文';
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [values, setValues] = useState<Values>({ prompt: '', context: '' });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [accessExpired, setAccessExpired] = useState(false);
  const [legacy, setLegacy] = useState<LegacyPrivateDraft | null>(null);
  const migrating = useRef<LegacyPrivateDraft | null>(null);
  const epoch = useRef(0), locked = useRef(false);
  const storageBlocked = useRef(false);
  const live = useRef(props); live.current = props;
  const retained = useRef<Pending | null>(null);
  const storageKey = `sd2:private-editor:pending:v1:${props.userId}:${encodeURIComponent(endpoint)}:${props.moduleId}`;
  function nextLegacyDraft() {
    const keys = [...(live.current.legacyDraftKey ? [live.current.legacyDraftKey] : []), ...(live.current.legacyDraftKeys || [])];
    for (const key of keys) {
      const found = readLegacyPrivateDraft(key);
      if (found) return found;
    }
    return null;
  }
  const capture = () => ({ epoch: epoch.current, userId: props.userId, moduleId: props.moduleId });
  const current = (scope: ReturnType<typeof capture>) => scope.epoch === epoch.current
    && scope.userId === live.current.userId && scope.moduleId === live.current.moduleId
    && live.current.canRead && !live.current.blocked && !isClientSessionBlocked()
    && (live.current.open ?? (live.current.dialog.current as HTMLDialogElement | null)?.open);
  function clear() {
    epoch.current++; locked.current = false; setBusy(false); setLoaded(null);
    setValues({ prompt: '', context: '' }); setDraft(null); setNotice(''); setConflict(false); setLegacy(null); migrating.current = null;
  }
  useEffect(() => {
    clear(); setAccessExpired(false); retained.current = null; setPending(null); storageBlocked.current = false;
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) {
        const value = JSON.parse(raw) as Pending;
        if (!['draft', 'save'].includes(value.kind) || !/^[a-z0-9-]{36}$/i.test(value.requestId)) throw new Error();
        retained.current = value; setPending(value);
      }
    } catch { setNotice('原保存编号无法读取，请保留当前页面'); storageBlocked.current = true; }
    const dialog = props.dialog.current;
    dialog?.addEventListener('close', clear);
    const stop = watchSessionExit(clear);
    return () => { epoch.current++; stop(); dialog?.removeEventListener('close', clear); };
    // Scope changes revoke both displayed text and late responses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);
  useEffect(() => { if (props.blocked || !props.canRead || props.open === false) clear(); }, [props.blocked, props.canRead, props.open]);
  function retain(next: Pending | null) {
    if (next) {
      const raw = JSON.stringify(next);
      sessionStorage.setItem(storageKey, raw);
      if (sessionStorage.getItem(storageKey) !== raw) throw new Error('原保存编号未保留');
    } else sessionStorage.removeItem(storageKey);
    retained.current = next; setPending(next);
  }
  async function responseJSON(response: Response, scope: ReturnType<typeof capture>) {
    if (!current(scope)) throw new Error('stale-private-editor');
    if (response.status === 401 || response.status === 403) {
      clear(); setAccessExpired(true); setNotice('请重新验证身份后查看原文'); throw new Error('请重新验证身份后查看原文');
    }
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : '暂时无法完成，请重试');
    return result;
  }
  async function read() {
    if (locked.current || storageBlocked.current || props.blocked || !props.canRead) return;
    const scope = capture(); locked.current = true; setBusy(true); setNotice('');
    try {
      const result = await responseJSON(await fetch(`${endpoint}?mode=private-editor&id=${encodeURIComponent(props.moduleId)}`,
        { cache: 'no-store', signal: AbortSignal.timeout(30000) }), scope) as Loaded;
      if (!current(scope)) return;
      setLoaded(result); setDraft(result.draft); setConflict(false);
      try { setLegacy(nextLegacyDraft()); }
      catch { setNotice('本机旧草稿暂时无法读取，未清理任何内容'); }
      if (!loaded) setValues(result.draft && !result.draft.appliedRequestId ? result.draft.values : { prompt: result.prompt, context: result.context });
      if (!loaded && result.draft && !result.draft.appliedRequestId && result.draft.sourceRevision !== result.sourceRevision) {
        setConflict(true); setNotice('模板已有更新，已保留你的草稿；核对后再保存');
      }
    } catch (error) { if (current(scope)) setNotice((error as Error).message); }
    finally { if (current(scope)) { locked.current = false; setBusy(false); } }
  }
  async function saveDraft() {
    if (!loaded || locked.current || storageBlocked.current || retained.current || props.blocked) return false;
    const scope = capture(); locked.current = true; setBusy(true);
    const original = { kind: 'draft', requestId: crypto.randomUUID() } satisfies Pending;
    try {
      retain(original);
      const saved = await responseJSON(await fetch(endpoint, { method: 'PUT', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000),
        body: JSON.stringify({ action: 'save-private-draft', id: props.moduleId, requestId: original.requestId,
          expectedRevision: draft?.revision || 0, sourceRevision: loaded.sourceRevision, values }) }), scope) as Draft | { state: 'not-applied' };
      if (!current(scope)) return false;
      if ('state' in saved) { retain(null); setConflict(true); setNotice('草稿已有更新，当前输入保留，请核对最新版本'); return false; }
      retain(null); setDraft(saved); setNotice('');
      if (migrating.current) {
        try {
          const cleared = acknowledgeLegacyPrivateDraft(migrating.current, saved.values);
          migrating.current = null; setLegacy(nextLegacyDraft());
          if (!cleared) setNotice('加密草稿已保存；不同内容的旧副本仍保留，未覆盖或删除');
        }
        catch { migrating.current = null; setNotice('加密草稿已保存，本机旧副本暂未移除'); }
      }
      return true;
    } catch { if (current(scope)) setNotice('草稿保存待确认，请核对原保存'); return false; }
    finally { if (current(scope)) { locked.current = false; setBusy(false); } }
  }
  function acceptSave(result: { state?: string; requestId?: string; revision?: number }, requestId: string) {
    if (result.requestId !== requestId || !['saved', 'not-applied'].includes(result.state || '')) return false;
    if (!Number.isSafeInteger(result.revision) || (result.revision as number) < 0) return false;
    retain(null);
    if (result.state === 'saved') { clear(); live.current.onSaved(result.revision as number); }
    else { setConflict(true); setNotice('模板已有更新，本次未保存。草稿已保留，请重新读取并核对'); }
    return true;
  }
  async function save() {
    if (!loaded || locked.current || storageBlocked.current || retained.current || conflict || props.blocked) return;
    if (props.allowEmpty === false && !values.context.trim()) { setNotice('请填写提示词'); return; }
    const scope = capture();
    if (props.contextOnly && loaded.context.trim() && !values.context.trim()
      && !await confirm('清空通用上下文将影响之后的新生成，确定清空吗？', { title: '清空通用上下文', confirmLabel: '清空并保存', danger: true })) return;
    if (!current(scope)) return;
    if (!draft || draft.sourceRevision !== loaded.sourceRevision || draft.values.prompt !== values.prompt || draft.values.context !== values.context) {
      if (!await saveDraft()) return;
    }
    if (!current(scope)) return;
    locked.current = true; setBusy(true);
    const original = { kind: 'save', requestId: crypto.randomUUID() } satisfies Pending;
    try {
      retain(original);
      const result = await responseJSON(await fetch(endpoint, { method: 'PUT', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000),
        body: JSON.stringify({ action: 'save-private-definition', id: props.moduleId, requestId: original.requestId,
          revision: loaded.revision, sourceRevision: loaded.sourceRevision, ...values,
          ...(props.contextOnly ? { confirmContextClear: loaded.context.trim().length > 0 && !values.context.trim() } : {}) }) }), scope);
      if (current(scope) && !acceptSave(result, original.requestId)) setNotice('保存待确认，请核对原保存');
    } catch { if (current(scope)) setNotice('保存待确认，请核对原保存'); }
    finally { if (current(scope)) { locked.current = false; setBusy(false); } }
  }
  async function query() {
    const original = retained.current;
    if (!original || locked.current || props.blocked) return;
    const scope = capture(); locked.current = true; setBusy(true);
    try {
      const result = await responseJSON(await fetch(`${endpoint}?mode=private-${original.kind}-status&id=${encodeURIComponent(props.moduleId)}&requestId=${encodeURIComponent(original.requestId)}`,
        { cache: 'no-store', signal: AbortSignal.timeout(30000) }), scope);
      if (!current(scope)) return;
      if (original.kind === 'draft' && result.requestId === original.requestId && result.draft) {
        retain(null);
        if (result.draft.state === 'not-applied') { setConflict(true); setNotice('草稿已有更新，当前输入保留，请核对最新版本'); }
        else { setDraft(result.draft); setValues(result.draft.values); setNotice('草稿已保存'); }
      } else if (original.kind === 'save' && acceptSave(result, original.requestId)) return;
      else setNotice('尚未确认原保存结果，不会重新发送');
    } catch (error) { if (current(scope)) setNotice((error as Error).message); }
    finally { if (current(scope)) { locked.current = false; setBusy(false); } }
  }
  async function copy(value: string) {
    const scope = capture();
    if (!current(scope)) return;
    try { await navigator.clipboard.writeText(value); if (current(scope)) setNotice('已复制'); }
    catch { if (current(scope)) setNotice('复制失败，可选中文字复制'); }
  }
  const draftDirty = loaded && (Boolean(migrating.current) || !draft || draft.sourceRevision !== loaded.sourceRevision
    || draft.values.prompt !== values.prompt || draft.values.context !== values.context);
  useEffect(() => {
    props.beforeClose.current = async () => {
      if (!loaded || props.blocked) return true;
      if (locked.current || conflict) return false;
      if (retained.current) return !draftDirty;
      return !draftDirty || await saveDraft();
    };
    return () => { props.beforeClose.current = null; };
  });
  useEffect(() => {
    if (!loaded || !draftDirty || pending || busy || conflict || props.blocked) return;
    const timer = setTimeout(() => { void saveDraft(); }, 700);
    return () => clearTimeout(timer);
    // Draft writes are serialized by locked and retain their original request id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, loaded, draftDirty, pending, busy, conflict, props.blocked]);
  if (props.blocked) return null;
  return <section aria-label={label}>{productDialog}
    {!loaded && props.canRead && !accessExpired && <button type="button" disabled={busy} onClick={() => void read()}><FileText size={16} />查看{label}</button>}
    {(accessExpired || !props.canRead && props.needsIdentity) && <button type="button" onClick={() => {
      window.location.assign(`/api/auth/feishu/authorize?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    }}>验证身份后查看</button>}
    {loaded && <>
      {legacy && <button type="button" disabled={busy || Boolean(pending)} onClick={() => {
        migrating.current = legacy; setValues({ prompt: legacy.prompt ?? values.prompt, context: legacy.context ?? values.context });
      }}>恢复本机文案草稿</button>}
      {!props.contextOnly && <label className={styles.label}>模板提示词<button type="button" title="复制模板提示词" aria-label="复制模板提示词" onClick={() => void copy(values.prompt)}><Copy size={16} /></button><textarea rows={4} value={values.prompt} maxLength={20000} disabled={busy || Boolean(pending)}
        onChange={event => setValues(current => ({ ...current, prompt: event.target.value }))} /></label>}
      <label className={styles.label}>{props.contextOnly ? label : '模块上下文'}<button type="button" title="复制原文" aria-label="复制原文" onClick={() => void copy(values.context)}><Copy size={16} /></button><textarea rows={10} value={values.context} maxLength={props.maxLength || 20000} disabled={busy || Boolean(pending)}
        onChange={event => setValues(current => ({ ...current, context: event.target.value }))} /></label>
      <div className={styles.moduleSettingsActions}>
        <button type="button" disabled={busy || Boolean(pending) || conflict} onClick={() => void save()}><Save size={16} />保存原文</button>
        <button type="button" disabled={busy || Boolean(pending) || Boolean(draftDirty)} onClick={clear}><X size={16} />收起</button>
      </div>
    </>}
    {pending && <button type="button" disabled={busy} onClick={() => void query()}><RefreshCw size={16} />核对原保存</button>}
    {notice && <p role="status" className={styles.muted}>{notice}{loaded && !pending && <button type="button" disabled={busy} onClick={() => void read()}>核对最新版本</button>}</p>}
  </section>;
}
