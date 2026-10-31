'use client';

import { useEffect, useRef, useState, type RefObject, type MutableRefObject } from 'react';
import { Copy, FileText, RefreshCw, Save, X } from 'lucide-react';
import { isClientSessionBlocked, watchSessionExit } from '@/lib/auth/client-session-boundary';
import styles from './studio.module.css';
import { useProductDialog } from '@/components/useProductDialog';
import { readLegacyPrivateDraft, acknowledgeLegacyPrivateDraft, type LegacyPrivateDraft } from './private-draft-migration';
import { usePageExitRisk } from '@/lib/hooks/page-exit-guard';

type Values = { prompt: string; context: string };
type Draft = { revision: number; sourceRevision: string; values: Values; appliedRequestId?: string };
type Loaded = Values & { revision: number; sourceRevision: string; draft: Draft | null };
type Pending = { kind: 'draft' | 'save'; requestId: string };
type PendingOperations = { draft: Pending | null; save: Pending | null };
type Submitted = Pending & { values: Values; editVersion: number };
type Props = { userId: string; moduleId: string; dialog: RefObject<HTMLElement>; blocked: boolean; open?: boolean;
  canRead: boolean; needsIdentity: boolean; onSaved: (revision: number, keepEditing?: boolean) => void;
  beforeClose: MutableRefObject<(() => Promise<boolean>) | null>; legacyDraftKey?: string; legacyDraftKeys?: string[];
  endpoint?: string; contextOnly?: boolean; label?: string; maxLength?: number; allowEmpty?: boolean };

export function PrivateDefinitionEditor(props: Props) {
  const { confirm, productDialog } = useProductDialog();
  const endpoint = props.endpoint || '/api/image-studio/modules';
  const label = props.label || '模板原文';
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [values, setValues] = useState<Values>({ prompt: '', context: '' });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState<PendingOperations>({ draft: null, save: null });
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [accessExpired, setAccessExpired] = useState(false);
  const [legacy, setLegacy] = useState<LegacyPrivateDraft | null>(null);
  const migrating = useRef<LegacyPrivateDraft | null>(null);
  const epoch = useRef(0), locked = useRef(false);
  const draftBlocked = useRef(false);
  const editVersion = useRef(0);
  const submitted = useRef<Partial<Record<Pending['kind'], Submitted>>>({});
  const state = useRef({ loaded, values, draft }); state.current = { loaded, values, draft };
  const storageBlocked = useRef(false);
  const live = useRef(props); live.current = props;
  const retained = useRef<PendingOperations>({ draft: null, save: null });
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
  const sameValues = (a: Values, b: Values) => a.prompt === b.prompt && a.context === b.context;
  function needsDraft() {
    const latest = state.current;
    if (!latest.loaded || !editVersion.current && !migrating.current) return false;
    if (retained.current.draft || draftBlocked.current) return true;
    const recovery = latest.draft && !latest.draft.appliedRequestId ? latest.draft.values : latest.loaded;
    return Boolean(migrating.current) || !sameValues(latest.values, recovery);
  }
  function edit(next: Values) {
    editVersion.current++;
    state.current.values = next; setValues(next);
  }
  function clear() {
    epoch.current++; locked.current = false; setBusy(false); setWriting(false); setLoaded(null);
    setValues({ prompt: '', context: '' }); setDraft(null); setNotice(''); setConflict(false); setLegacy(null); migrating.current = null;
    state.current = { loaded: null, values: { prompt: '', context: '' }, draft: null };
    editVersion.current = 0; submitted.current = {}; draftBlocked.current = false;
  }
  useEffect(() => {
    clear(); setAccessExpired(false); retained.current = { draft: null, save: null }; setPending(retained.current); storageBlocked.current = false;
    try {
      const restored: PendingOperations = { draft: null, save: null };
      for (const key of [storageKey, `${storageKey}:draft`]) {
        const raw = sessionStorage.getItem(key);
        if (!raw) continue;
        const value = JSON.parse(raw) as Pending;
        if (!['draft', 'save'].includes(value.kind) || !/^[a-z0-9-]{36}$/i.test(value.requestId)) throw new Error();
        if (key !== storageKey && value.kind !== 'draft') throw new Error();
        if (restored[value.kind] && restored[value.kind]?.requestId !== value.requestId) throw new Error();
        restored[value.kind] = value;
      }
      retained.current = restored; setPending(restored);
    } catch { setNotice('原保存编号无法读取，请保留当前页面'); storageBlocked.current = true; }
    const dialog = props.dialog.current;
    dialog?.addEventListener('close', clear);
    const stop = watchSessionExit(clear);
    return () => { epoch.current++; stop(); dialog?.removeEventListener('close', clear); };
    // Scope changes revoke both displayed text and late responses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);
  useEffect(() => { if (props.blocked || !props.canRead || props.open === false) clear(); }, [props.blocked, props.canRead, props.open]);
  function retain(kind: Pending['kind'], next: Pending | null) {
    const operations = { ...retained.current, [kind]: next };
    const persist = (key: string, value: Pending) => {
      const raw = JSON.stringify(value); sessionStorage.setItem(key, raw);
      if (sessionStorage.getItem(key) !== raw) throw new Error('原保存编号未保留');
    };
    // The legacy v1 slot always contains a real pending operation, with definition saves first.
    // A second draft id is metadata only; neither slot contains the private text.
    if (operations.save && operations.draft) persist(`${storageKey}:draft`, operations.draft);
    const primary = operations.save || operations.draft;
    if (primary) persist(storageKey, primary);
    else sessionStorage.removeItem(storageKey);
    if (!operations.save || !operations.draft) sessionStorage.removeItem(`${storageKey}:draft`);
    retained.current = operations; setPending(operations);
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
  async function read(keepInput = false) {
    if (locked.current || storageBlocked.current || props.blocked || !props.canRead) return;
    const scope = capture(); locked.current = true; setBusy(true); setNotice('');
    try {
      const result = await responseJSON(await fetch(`${endpoint}?mode=private-editor&id=${encodeURIComponent(props.moduleId)}`,
        { cache: 'no-store', signal: AbortSignal.timeout(30000) }), scope) as Loaded;
      if (!current(scope)) return;
      const firstRead = !state.current.loaded;
      draftBlocked.current = false;
      state.current.loaded = result; state.current.draft = result.draft;
      setLoaded(result); setDraft(result.draft); setConflict(false);
      try { setLegacy(nextLegacyDraft()); }
      catch { setNotice('本机旧草稿暂时无法读取，未清理任何内容'); }
      if (firstRead) {
        const initial = result.draft && !result.draft.appliedRequestId && result.draft.sourceRevision === result.sourceRevision
          ? result.draft.values : { prompt: result.prompt, context: result.context };
        state.current.values = initial; setValues(initial);
      }
      if (keepInput) {
        editVersion.current++;
        setNotice('已核对最新版本，当前输入保留；保存原文后才会生效');
      } else if (result.draft && !result.draft.appliedRequestId && result.draft.sourceRevision !== result.sourceRevision) {
        setConflict(!firstRead && editVersion.current > 0);
        setNotice(firstRead ? '当前显示已保存原文；旧版本加密草稿仍保留，可主动恢复'
          : '当前输入已保留；旧版本加密草稿仍可主动恢复');
      }
    } catch (error) { if (current(scope)) setNotice((error as Error).message); }
    finally { if (current(scope)) { locked.current = false; setBusy(false); } }
  }
  async function saveDraft(snapshot = state.current.values) {
    const baseline = state.current.loaded;
    if (!baseline || locked.current || storageBlocked.current || draftBlocked.current || retained.current.draft || retained.current.save || props.blocked) return false;
    const scope = capture();
    if (!current(scope)) return false;
    locked.current = true; setBusy(true); setWriting(true);
    const original = { kind: 'draft', requestId: crypto.randomUUID() } satisfies Pending;
    submitted.current.draft = { ...original, values: snapshot, editVersion: editVersion.current };
    try {
      retain('draft', original);
      const saved = await responseJSON(await fetch(endpoint, { method: 'PUT', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000),
        body: JSON.stringify({ action: 'save-private-draft', id: props.moduleId, requestId: original.requestId,
          expectedRevision: state.current.draft?.revision || 0, sourceRevision: baseline.sourceRevision, values: snapshot }) }), scope) as Draft | { state: 'not-applied' };
      if (!current(scope)) return false;
      if ('state' in saved) { retain('draft', null); draftBlocked.current = true; setNotice('草稿已有更新，当前输入保留；可核对草稿或直接保存原文'); return false; }
      retain('draft', null); state.current.draft = saved; setDraft(saved); setNotice('');
      if (migrating.current) {
        try {
          const cleared = acknowledgeLegacyPrivateDraft(migrating.current, saved.values);
          migrating.current = null; setLegacy(nextLegacyDraft());
          if (!cleared) setNotice('加密草稿已保存；不同内容的旧副本仍保留，未覆盖或删除');
        }
        catch { migrating.current = null; setNotice('加密草稿已保存，本机旧副本暂未移除'); }
      }
      return true;
    } catch (error) { if (current(scope)) setNotice(`草稿保存待确认，请核对原保存。${(error as Error).message === 'stale-private-editor' ? '' : (error as Error).message}`); return false; }
    finally { if (current(scope)) { locked.current = false; setBusy(false); setWriting(false); } }
  }
  function acceptSave(result: { state?: string; requestId?: string; revision?: number }, requestId: string) {
    if (result.requestId !== requestId || !['saved', 'not-applied'].includes(result.state || '')) return false;
    if (!Number.isSafeInteger(result.revision) || (result.revision as number) < 0) return false;
    retain('save', null);
    if (result.state === 'saved') {
      const sent = submitted.current.save?.requestId === requestId ? submitted.current.save : null;
      const changedAfterSave = sent ? editVersion.current !== sent.editVersion : editVersion.current > 0;
      if (!changedAfterSave) { clear(); live.current.onSaved(result.revision as number); }
      else {
        const latest = state.current.loaded;
        if (latest && sent) {
          const next = { ...latest, ...sent.values, revision: result.revision as number, sourceRevision: String(result.revision) };
          state.current.loaded = next; setLoaded(next);
          if (state.current.draft && sameValues(state.current.draft.values, sent.values)) {
            const applied = { ...state.current.draft, appliedRequestId: requestId };
            state.current.draft = applied; setDraft(applied);
          }
        }
        if (!sent) setConflict(true);
        setNotice(sent ? '原文已保存；之后输入的新修改仍保留，请继续编辑或保存'
          : '原保存已确认；当前输入仍保留，请核对最新版本后继续保存');
        live.current.onSaved(result.revision as number, true);
      }
    }
    else { setConflict(true); setNotice('原文已有更新，本次未保存。当前输入仍在页面中，请重新读取并核对'); }
    return true;
  }
  async function save() {
    if (!loaded || locked.current || storageBlocked.current || retained.current.save || conflict || props.blocked) return;
    if (props.allowEmpty === false && !values.context.trim()) { setNotice('请填写提示词'); return; }
    const scope = capture(), version = editVersion.current, snapshot = values;
    if (props.contextOnly && loaded.context.trim() && !values.context.trim()
      && !await confirm('清空通用上下文将影响之后的新生成，确定清空吗？', { title: '清空通用上下文', confirmLabel: '清空并保存', danger: true })) return;
    if (!current(scope)) return;
    if (!retained.current.draft && !draftBlocked.current && (!draft || draft.sourceRevision !== loaded.sourceRevision || draft.values.prompt !== values.prompt || draft.values.context !== values.context)) {
      if (!await saveDraft(snapshot) && !retained.current.draft && !draftBlocked.current) return;
    }
    if (!current(scope)) return;
    if (version !== editVersion.current) { setNotice('加密草稿已保存；有新的输入，请再次保存原文'); return; }
    locked.current = true; setBusy(true); setWriting(true);
    const original = { kind: 'save', requestId: crypto.randomUUID() } satisfies Pending;
    submitted.current.save = { ...original, values: snapshot, editVersion: version };
    try {
      retain('save', original);
      const result = await responseJSON(await fetch(endpoint, { method: 'PUT', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000),
        body: JSON.stringify({ action: 'save-private-definition', id: props.moduleId, requestId: original.requestId,
          revision: loaded.revision, sourceRevision: loaded.sourceRevision, ...snapshot,
          ...(props.contextOnly ? { confirmContextClear: loaded.context.trim().length > 0 && !snapshot.context.trim() } : {}) }) }), scope);
      if (current(scope) && !acceptSave(result, original.requestId)) setNotice('保存待确认，请核对原保存');
    } catch { if (current(scope)) setNotice('保存待确认，请核对原保存'); }
    finally { if (current(scope)) { locked.current = false; setBusy(false); setWriting(false); } }
  }
  async function query(kind: Pending['kind']) {
    const original = retained.current[kind];
    if (!original || locked.current || props.blocked) return;
    const scope = capture(); locked.current = true; setBusy(true);
    try {
      const result = await responseJSON(await fetch(`${endpoint}?mode=private-${original.kind}-status&id=${encodeURIComponent(props.moduleId)}&requestId=${encodeURIComponent(original.requestId)}`,
        { cache: 'no-store', signal: AbortSignal.timeout(30000) }), scope);
      if (!current(scope)) return;
      if (original.kind === 'draft' && result.requestId === original.requestId && result.draft) {
        retain('draft', null);
        if (result.draft.state === 'not-applied') { draftBlocked.current = true; setNotice('原草稿未应用，当前输入保留；可核对最新版本或直接保存原文'); }
        else {
          if (!state.current.draft || result.draft.revision >= state.current.draft.revision) {
            state.current.draft = result.draft; setDraft(result.draft);
          }
          setNotice('原草稿已保存，当前输入已保留');
        }
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
  const draftDirty = needsDraft();
  usePageExitRisk({
    unsaved: endpoint === '/api/image-studio/settings' && draftDirty ? [label] : [],
    busy: endpoint === '/api/image-studio/settings' && writing ? [`${label}正在保存`] : [],
    revision: `${editVersion.current}:${pending.draft?.requestId || ''}:${pending.save?.requestId || ''}`,
  });
  async function beforeClose() {
    if (!state.current.loaded || props.blocked || !needsDraft()) return true;
    if (!locked.current && !retained.current.draft && !retained.current.save && !conflict && await saveDraft() && !needsDraft()) return true;
    return confirm('当前修改还没有确认保存为加密草稿。关闭会丢失这部分输入；原保存编号仍会保留，可重新打开核对。确定放弃未保存的修改吗？',
      { title: '正文尚未保存', confirmLabel: '放弃修改并关闭', danger: true });
  }
  useEffect(() => {
    props.beforeClose.current = beforeClose;
    return () => { props.beforeClose.current = null; };
  });
  useEffect(() => {
    if (!loaded || !draftDirty || pending.draft || pending.save || busy || conflict || draftBlocked.current || props.blocked) return;
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
    {loaded && props.canRead && !accessExpired && <>
      {draft && !draft.appliedRequestId && draft.sourceRevision !== loaded.sourceRevision && <button type="button" disabled={busy || Boolean(pending.save)} onClick={() => {
        edit(draft.values); setConflict(false); setNotice('已恢复旧版本加密草稿，保存原文后才会替换当前定义');
      }}>恢复旧版本加密草稿</button>}
      {legacy && <button type="button" disabled={busy || Boolean(pending.draft || pending.save)} onClick={() => {
        migrating.current = legacy; edit({ prompt: legacy.prompt ?? values.prompt, context: legacy.context ?? values.context });
      }}>恢复本机文案草稿</button>}
      {!props.contextOnly && <label className={styles.label}>模板提示词<button type="button" title="复制模板提示词" aria-label="复制模板提示词" onClick={() => void copy(values.prompt)}><Copy size={16} /></button><textarea rows={4} value={values.prompt} maxLength={20000}
        onChange={event => edit({ ...state.current.values, prompt: event.target.value })} /></label>}
      <label className={styles.label}>{props.contextOnly ? label : '模块上下文'}<button type="button" title="复制原文" aria-label="复制原文" onClick={() => void copy(values.context)}><Copy size={16} /></button><textarea rows={10} value={values.context} maxLength={props.maxLength || 20000}
        onChange={event => edit({ ...state.current.values, context: event.target.value })} /></label>
      <div className={styles.moduleSettingsActions}>
        <button type="button" disabled={busy || Boolean(pending.save) || conflict} onClick={() => void save()}><Save size={16} />保存原文</button>
        <button type="button" onClick={async () => { if (await beforeClose()) clear(); }}><X size={16} />收起</button>
      </div>
      {conflict && !pending.save && <button type="button" disabled={busy} onClick={() => void read(true)}>核对最新版本并保留当前输入</button>}
      {draftDirty && <p className={styles.muted} role="status">{pending.draft || pending.save ? '草稿或原文保存待确认，当前输入仍保留' : busy ? '正在保存加密草稿，可继续输入' : '当前修改尚未保存为加密草稿'}</p>}
    </>}
    {pending.draft && <button type="button" disabled={busy} onClick={() => void query('draft')}><RefreshCw size={16} />核对原草稿</button>}
    {pending.save && <button type="button" disabled={busy} onClick={() => void query('save')}><RefreshCw size={16} />核对原文保存</button>}
    {notice && <p role="status" className={styles.muted}>{notice}{loaded && !pending.save && <button type="button" disabled={busy} onClick={() => void read()}>核对最新版本</button>}</p>}
  </section>;
}
