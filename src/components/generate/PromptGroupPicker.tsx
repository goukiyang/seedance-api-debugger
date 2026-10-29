'use client';

import { useEffect, useRef, useState, type ReactNode, type RefObject, type UIEventHandler } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, Check, ChevronLeft, ChevronRight, Copy, ImageIcon, Info, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2, Undo2, UserRound, X } from 'lucide-react';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { usePageExitRisk } from '@/lib/hooks/page-exit-guard';
import { useProductDialog } from '@/components/useProductDialog';
import { RelativeTime } from '@/components/RelativeTime';
import { ResourceLibraryPicker, type ResourceLibraryPickerProps } from '@/components/ResourceLibraryPicker';
import { VIDEO_GROUP_LIMIT, parseVideoPromptGroupRefs, type VideoPromptGroupRef, type VideoPromptGroupSummary } from '@/lib/video/prompt-groups';
import styles from './PromptGroupSelection.module.css';

type Group = VideoPromptGroupRef & Partial<VideoPromptGroupSummary> & { copyFrom?: VideoPromptGroupRef };
const api = '/api/video/prompt-groups';
const editorScope = (accountId: string) => `sd2:video-group-editor:v1:${accountId}`;
function retainedEditor(accountId: string): Group | null {
  try {
    const value = JSON.parse(localStorage.getItem(editorScope(accountId)) || sessionStorage.getItem(editorScope(accountId)) || 'null');
    if (!value) return null;
    const [ref] = parseVideoPromptGroupRefs([{ groupId: value.groupId, versionId: value.versionId }]);
    return { groupId: ref.groupId, versionId: ref.versionId, ...(Number.isSafeInteger(value.revision) ? { revision: value.revision } : {}),
      ...(value.copyFrom ? { copyFrom: parseVideoPromptGroupRefs([value.copyFrom])[0] } : {}) };
  } catch { return null; }
}
function retainedRequests(key: string): { pending: string | null; draftPending: string | null; action?: 'save' | 'delete'; use?: boolean } {
  try {
    const value = JSON.parse(localStorage.getItem(key) || sessionStorage.getItem(key) || '{}');
    const valid = (id: unknown) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id) ? id : null;
    return { pending: valid(value.pending), draftPending: valid(value.draftPending), action: value.action === 'delete' ? 'delete' : 'save', use: value.use === true };
  } catch { return { pending: null, draftPending: null }; }
}
async function read(url: string, options?: RequestInit) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || '读取尚未完成，请重试'), { status: response.status });
  return data;
}
function Modal({ open, title, children, footer, onClose, narrow = false, scrollRef, onScroll }: {
  open: boolean; title: string; children: ReactNode; footer?: ReactNode; onClose: () => void; narrow?: boolean;
  scrollRef?: RefObject<HTMLDivElement>; onScroll?: UIEventHandler<HTMLDivElement>;
}) {
  const dialog = useRef<HTMLDivElement>(null), backdrop = useRef<HTMLDivElement>(null);
  useDialogDismiss({ open, dialogRef: dialog, dismissSurfaceRef: backdrop, onDismiss: onClose });
  if (!open || typeof document === 'undefined') return null;
  return createPortal(<div ref={backdrop} className={styles.overlay}><div ref={dialog} className={`${styles.panel} ${narrow ? styles.narrow : ''}`}
    role="dialog" aria-modal="true" aria-label={title}>
    <header className={styles.header}><h2>{title}</h2><button type="button" className={styles.icon} title="关闭" aria-label="关闭" onClick={onClose}><X size={20} /></button></header>
    <div ref={scrollRef} onScroll={onScroll} className={styles.scroll}>{children}</div>{footer && <footer className={styles.footer}>{footer}</footer>}
  </div></div>, document.body);
}
function Cover({ item, small = false }: { item: Group; small?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.coverUrl]);
  if (item.coverUrl && !failed) return <img className={small ? styles.thumb : undefined} src={item.coverUrl} alt="" loading="lazy" onError={() => setFailed(true)} />;
  return <span className={small ? styles.thumb : styles.cover}><ImageIcon size={small ? 18 : 28} aria-hidden="true" /></span>;
}
function Author({ item, onClick }: { item: Group; onClick?: () => void }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.author?.avatar_url]);
  const content = <>
    {item.author?.avatar_url && !failed ? <img src={item.author.avatar_url} alt="" className={styles.avatar} onError={() => setFailed(true)} />
      : <span className={styles.avatar}><UserRound size={15} aria-hidden="true" /></span>}
    <span>{item.author?.name || '原作者'}</span></>;
  return onClick ? <button type="button" className={styles.author} onClick={onClick} title="查看作者资料">{content}</button>
    : <span className={styles.author}>{content}</span>;
}
export function useVideoPromptGroupSummaries(refs: VideoPromptGroupRef[]) {
  const { user, sessionChanged } = useAppSession();
  const key = JSON.stringify([user?.id, refs, sessionChanged]);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ key: string; groups: Group[]; error: string }>({ key: '', groups: [], error: '' });
  useEffect(() => {
    const controller = new AbortController();
    if (!user?.id || sessionChanged || !refs.length) { setState({ key, groups: [], error: '' }); return; }
    void read(`${api}?refs=${encodeURIComponent(JSON.stringify(refs))}`, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setState({ key, groups: data.groups, error: '' });
    }).catch(error => { if (!controller.signal.aborted) setState({ key, groups: refs.map(ref => ({ ...ref, unavailable: true })), error: error.message }); });
    return () => controller.abort();
    // The key includes exact refs/order and account identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry]);
  const groups: Group[] = state.key === key ? state.groups : refs.map(ref => ({ ...ref, name: '正在核对…' }));
  return { groups,
    loading: refs.length > 0 && state.key !== key, error: state.key === key ? state.error : '', refresh: () => setRetry(v => v + 1) };
}
function GroupDetail({ item, onClose, onUse, onEdit, onCopy }: { item: Group | null; onClose: () => void; onUse?: () => void; onEdit?: () => void; onCopy?: () => void }) {
  const { user, sessionChanged } = useAppSession();
  const [profile, setProfile] = useState(false);
  const [loadedContent, setContent] = useState<(Group & { body?: string; actorId: string }) | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [retry, setRetry] = useState(0);
  const content = loadedContent?.actorId === user?.id && loadedContent?.groupId === item?.groupId && loadedContent?.versionId === item?.versionId ? loadedContent : null;
  useEffect(() => {
    const controller = new AbortController(); setContent(null); setError(''); setLoading(false);
    if (!item || !user?.id || sessionChanged) return;
    setLoading(true);
    void read(`${api}?mode=detail&groupId=${item.groupId}&versionId=${item.versionId}`, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setContent({ ...value, actorId: user.id });
    }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [item?.groupId, item?.versionId, user?.id, sessionChanged, retry]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setProfile(false), [item?.groupId]);
  return <><Modal open={Boolean(item) && Boolean(user?.id) && !sessionChanged} narrow title="提示词组详情" onClose={onClose} footer={<>
    {content?.canManage && onEdit && <button type="button" className={styles.button} onClick={onEdit}><Pencil size={15} />编辑当前原组</button>}
    {content?.canCopy && onCopy && <button type="button" className={styles.button} onClick={onCopy}><Copy size={15} />另存私人副本</button>}
    {onUse && <button type="button" className={`${styles.button} ${styles.primary}`} disabled={Boolean(item?.unavailable)} onClick={onUse}>选用</button>}
  </>}>{item && <div className={styles.detail}><div className={styles.cover}><Cover item={item} /></div><h3>{item.name || '提示词组不可用'}</h3>
    <Author item={item} onClick={() => setProfile(true)} /><p>{item.description || item.reason || '暂无用途简介'}</p>{item.conditions && <p>{item.conditions}</p>}
    <p className={styles.meta}>{item.shared ? '共享给同事' : '仅本人'} · {item.versionId === item.latestVersionId ? '当前版本' : '当时版本'}{item.disabled ? ' · 已停用' : ''}{content?.deleted ? ' · 已删除，历史保留' : ''}</p>
    {loading && <p role="status">正在读取当时版本…</p>}{error && <p role="status">{error}<button type="button" className={styles.icon} title="重试" aria-label="重试" onClick={() => setRetry(v => v + 1)}><RefreshCw size={16} /></button></p>}
    {content?.canReadContent && typeof content.body === 'string' ? <pre className={styles.bodyText}>{content.body}</pre> : !loading && !error && <p className={styles.meta}>选用权限不包含内部正文读取权。</p>}
    </div>}</Modal>
    <Modal open={Boolean(item) && profile} narrow title="作者资料" onClose={() => setProfile(false)}>{item && <Author item={item} />}</Modal></>;
}

type EditorFields = { name: string; description: string; conditions: string; body: string; coverAssetId: string | null; shared: boolean; disabled: boolean; copyFrom?: VideoPromptGroupRef };
const empty: EditorFields = { name: '', description: '', conditions: '', body: '', coverAssetId: null, shared: false, disabled: false };
function GroupEditor({ open, item, onClose, onSaved, onUploadFile }: { open: boolean; item: Group; onClose: () => void;
  onSaved: (value: VideoPromptGroupRef, use: boolean, deleted?: boolean) => void; onUploadFile?: ResourceLibraryPickerProps['onUploadFile'] }) {
  const { confirm, productDialog } = useProductDialog();
  const { user } = useAppSession();
  const [editorId, setEditorId] = useState(item.groupId);
  const receiptKey = `${editorScope(user?.id || 'anonymous')}:${editorId}:requests`;
  const [fields, setFields] = useState<EditorFields>(empty), [revision, setRevision] = useState(0), [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [pending, setPending] = useState<string | null>(() => retainedRequests(receiptKey).pending);
  const [conflict, setConflict] = useState(false), [coverOpen, setCoverOpen] = useState(false);
  const [draftRevision, setDraftRevision] = useState(0), [durable, setDurable] = useState('');
  const [draftPending, setDraftPending] = useState<string | null>(() => retainedRequests(receiptKey).draftPending);
  const [latestView, setLatestView] = useState<EditorFields | null>(null), [readFailed, setReadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [sourceVersion, setSourceVersion] = useState(item.versionId);
  const requestIntent = useRef({ action: retainedRequests(receiptKey).action || 'save', use: retainedRequests(receiptKey).use === true });
  const [versions, setVersions] = useState<Array<{ versionId: string; name: string; createdAt: string; current: boolean }> | null>(null);
  const initial = useRef(JSON.stringify(empty)), sequence = useRef(0), liveFields = useRef(fields); liveFields.current = fields;
  const serialized = JSON.stringify(fields);
  const remember = (saveId: string | null, draftId: string | null) => {
    try { localStorage.setItem(receiptKey, JSON.stringify({ pending: saveId, draftPending: draftId, ...requestIntent.current })); return true; }
    catch { setNotice('浏览器无法保留原保存编号，未发送新保存；当前编辑保留。'); return false; }
  };
  useEffect(() => { remember(pending, draftPending); }, [receiptKey, pending, draftPending]); // eslint-disable-line react-hooks/exhaustive-deps
  usePageExitRisk({ unsaved: !loading && serialized !== initial.current && serialized !== durable ? ['提示词组编辑'] : [], busy: pending || draftPending ? ['正在核对原保存'] : [], revision: serialized });
  useEffect(() => {
    const controller = new AbortController(), version = ++sequence.current;
    setLoading(true); setReadFailed(false);
    const url = item.revision ? `${api}?mode=editor&groupId=${item.groupId}&versionId=${item.latestVersionId || item.versionId}&latest=1` : `${api}?mode=draft&groupId=${item.groupId}`;
    void read(url, { signal: controller.signal }).then(async data => {
      const source = item.copyFrom ? await read(`${api}?mode=detail&groupId=${item.copyFrom.groupId}&versionId=${item.copyFrom.versionId}`, { signal: controller.signal }) : null;
      if (source && (!source.canCopy || typeof source.body !== 'string')) throw new Error('来源正文不可完整读取，未打开空稿');
      if (controller.signal.aborted || version !== sequence.current) return;
      const value: EditorFields = item.revision ? { name: data.name, description: data.description, conditions: data.conditions,
        body: data.body, coverAssetId: data.coverAssetId, shared: data.shared, disabled: data.disabled } : source ? { name: `${source.name.slice(0, 77)} 副本`, description: source.description, conditions: source.conditions,
          body: source.body, coverAssetId: source.coverAssetId, shared: false, disabled: false, copyFrom: item.copyFrom } : empty;
      initial.current = JSON.stringify(value); setRevision(data.revision || 0); setSourceVersion(data.versionId || item.copyFrom?.versionId || item.versionId);
      let restored = value;
      if (data.draft?.values) {
        restored = { ...value, ...JSON.parse(data.draft.values.metadata), body: data.draft.values.body };
        if (data.draft.sourceRevision !== String(data.revision || 0)) { setConflict(true); setNotice('原组已有新版本，草稿保留，可查看最新版或另存副本'); }
      }
      setFields(restored); setDraftRevision(data.draft?.revision || 0); setDurable(JSON.stringify(restored)); setLoading(false);
    }).catch(error => { if (!controller.signal.aborted) { setNotice(error.message); setReadFailed(true); setLoading(false); } });
    return () => { controller.abort(); sequence.current++; };
  }, [item.groupId, item.versionId, item.latestVersionId, item.revision, reload]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open || loading || readFailed || conflict || pending || draftPending || busy || serialized === durable) return;
    const requestId = crypto.randomUUID(), value = serialized, generation = sequence.current;
    const timer = window.setTimeout(() => {
      if (!remember(pending, requestId)) return;
      setDraftPending(requestId);
      const { body, ...metadata } = JSON.parse(value) as EditorFields;
      void read(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'save-draft',
        groupId: editorId, expectedRevision: draftRevision, sourceRevision: String(revision), requestId, values: { body, metadata: JSON.stringify(metadata) } }) }).then(data => {
        if (generation !== sequence.current) return;
        if (data.draft?.revision) { setDraftRevision(data.draft.revision); setDurable(value); setDraftPending(null); }
        else if (data.draft?.state === 'not-applied') { setDraftPending(null); setConflict(true); setNotice('草稿已有其他修改，当前编辑保留，可另存私人副本。'); }
        else setNotice('草稿保存结果待确认，请核对原保存。');
      }).catch(() => { if (generation === sequence.current) setNotice('草稿保存结果待确认，当前编辑保留，请核对原保存。'); });
    }, 900);
    return () => window.clearTimeout(timer);
  }, [open, loading, readFailed, conflict, pending, draftPending, busy, serialized, durable, editorId, draftRevision, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = async () => {
    if (pending || draftPending) { setNotice('请先核对原保存，当前编辑仍保留。'); return; }
    if (serialized !== initial.current && serialized !== durable && !await confirm('当前编辑尚未可靠保存，关闭会丢失这次修改。', { title: '尚未保存', confirmLabel: '关闭' })) return;
    onClose();
  };
  const applyResult = (data: VideoPromptGroupRef & { state: string }) => {
    if (data.state === 'saved' || data.state === 'deleted') { remember(null, null); setPending(null); onSaved(data, requestIntent.current.use, data.state === 'deleted'); onClose(); }
    else if (data.state === 'conflict') { setPending(null); setConflict(true); setNotice('提示词组已有新版本，当前修改保留。'); }
    else setNotice('保存结果待确认，请继续查询原保存，勿重复保存。');
  };
  const save = async (use = false) => {
    if (pending || draftPending || busy) return;
    const requestId = crypto.randomUUID();
    requestIntent.current = { action: 'save', use };
    if (!remember(requestId, draftPending)) return;
    setBusy(true); setPending(requestId); setNotice('');
    const generation = sequence.current;
    try { const data = await read(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...fields, groupId: editorId, revision, draftRevision, requestId }) }); if (generation === sequence.current) applyResult(data); }
    catch (error) {
      if (generation !== sequence.current) return;
      if (error && typeof error === 'object' && 'status' in error && Number(error.status) >= 400 && Number(error.status) < 500) setPending(null);
      setNotice(error instanceof Error ? error.message : '保存结果待确认，请核对原保存');
    }
    finally { if (generation === sequence.current) setBusy(false); }
  };
  const remove = async () => {
    if (pending || draftPending || busy || readFailed || conflict || !item.revision) return;
    if (!await confirm(`删除“${fields.name}”？它将退出可用目录，历史、原图和已受理任务保留；已有引用不会自动移除。`, { title: '删除提示词组', confirmLabel: '删除', danger: true })) return;
    const generation = sequence.current, requestId = crypto.randomUUID(); requestIntent.current = { action: 'delete', use: false };
    if (!remember(requestId, draftPending)) return;
    setBusy(true); setPending(requestId); setNotice('');
    try { const data = await read(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', groupId: editorId, versionId: sourceVersion, revision, requestId }) }); if (generation === sequence.current) applyResult(data); }
    catch (cause) { if (generation === sequence.current) { if ((cause as { status?: number }).status! < 500) setPending(null); setNotice(cause instanceof Error ? cause.message : '删除结果待确认，请核对原操作'); } }
    finally { if (generation === sequence.current) setBusy(false); }
  };
  const query = async () => {
    const generation = sequence.current;
    setBusy(true);
    try {
      if (pending) { const result = await read(`${api}?mode=save-status&requestId=${encodeURIComponent(pending)}`); if (generation !== sequence.current) return; applyResult(result); }
      if (draftPending) {
        const data = await read(`${api}?mode=draft-status&groupId=${editorId}&requestId=${draftPending}`);
        if (generation !== sequence.current) return;
        if (data.draft?.revision) { setDraftRevision(data.draft.revision); setDurable(JSON.stringify({ ...JSON.parse(data.draft.values.metadata), body: data.draft.values.body })); setDraftPending(null); setNotice(''); }
        else if (data.draft?.state === 'not-applied') { setDraftPending(null); setConflict(true); setNotice('原草稿未覆盖他人修改，当前编辑保留，可另存私人副本。'); }
        else setNotice('草稿保存尚未确认，保留当前编辑。');
      }
    } catch (error) { if (generation === sequence.current) setNotice(error instanceof Error ? error.message : '原保存尚未确认'); } finally { if (generation === sequence.current) setBusy(false); }
  };
  const prepareCopy = () => {
    if (pending || draftPending || busy || readFailed || loading) return;
    const id = crypto.randomUUID(), source = fields.copyFrom || (revision > 0 ? { groupId: item.groupId, versionId: sourceVersion } : undefined);
    try { localStorage.setItem(editorScope(user?.id || 'anonymous'), JSON.stringify({ groupId: id, versionId: id, copyFrom: source })); }
    catch { setNotice('浏览器无法保留副本现场，当前修改保留'); return; }
    setEditorId(id); setRevision(0); setDraftRevision(0); setDurable(''); setFields(v => ({ ...v, shared: false, disabled: false, copyFrom: source })); setConflict(false); setNotice('已准备私人副本，请保存');
  };
  return <><Modal open={open} narrow title={revision ? '编辑提示词组' : '新建提示词组'} onClose={() => void close()} footer={<>
    {notice && <p className={styles.meta} role="status">{notice}</p>}
    {(conflict || revision > 0) && <button type="button" className={styles.button} disabled={Boolean(pending || draftPending) || busy || loading || readFailed} onClick={prepareCopy}><Copy size={15} />另存私人副本</button>}
    {conflict && <>
      <button type="button" className={styles.button} onClick={() => { const generation = sequence.current; void read(`${api}?mode=editor&groupId=${item.groupId}&versionId=${item.versionId}&latest=1`).then(value => { if (generation === sequence.current) setLatestView(value); }).catch(cause => { if (generation === sequence.current) setNotice(cause.message); }); }}>查看最新版</button></>}
    <div className={styles.actions}><button type="button" className={styles.button} onClick={() => void close()}>取消</button>
      {pending || draftPending ? <button type="button" className={styles.button} disabled={busy} onClick={() => void query()}><RefreshCw size={15} />核对原保存</button>
        : <><button type="button" className={styles.button} disabled={busy || loading || readFailed || conflict || !fields.name.trim() || !fields.body.trim()} onClick={() => void save()}>保存</button>
          <button type="button" className={`${styles.button} ${styles.primary}`} disabled={busy || loading || readFailed || conflict || fields.disabled || !fields.name.trim() || !fields.body.trim()} onClick={() => void save(true)}>保存并选用</button></>}</div>
  </>}>{loading ? <p role="status">正在读取…</p> : readFailed ? <p role="status">完整内容读取失败，未开放空稿保存。<button type="button" className={styles.button} onClick={() => setReload(v => v + 1)}><RefreshCw size={16} />重新读取</button></p> : <fieldset className={styles.form} disabled={Boolean(pending)}>
    <label>名称<input maxLength={80} value={fields.name} onChange={e => setFields(v => ({ ...v, name: e.target.value }))} /></label>
    <label>用途简介<textarea maxLength={800} value={fields.description} onChange={e => setFields(v => ({ ...v, description: e.target.value }))} /></label>
    <label>适用条件<textarea maxLength={800} value={fields.conditions} onChange={e => setFields(v => ({ ...v, conditions: e.target.value }))} /></label>
    {onUploadFile && <button type="button" className={styles.button} onClick={() => setCoverOpen(true)}><ImageIcon size={16} />{fields.coverAssetId ? '更换封面' : '选择封面'}</button>}
    <label>内部提示词<textarea className={styles.body} maxLength={8000} value={fields.body} onChange={e => setFields(v => ({ ...v, body: e.target.value }))} /></label>
    <label className={styles.toggle}><input type="checkbox" role="switch" disabled={Boolean(fields.copyFrom)} checked={fields.shared} onChange={e => setFields(v => ({ ...v, shared: e.target.checked }))} />共享给同事</label>
    {revision > 0 && <details><summary>管理</summary><label className={styles.toggle}><input type="checkbox" checked={fields.disabled} onChange={e => setFields(v => ({ ...v, disabled: e.target.checked }))} />停用</label>
      <button type="button" className={styles.button} onClick={() => { void read(`${api}?mode=versions&groupId=${item.groupId}&versionId=${item.versionId}`).then(value => setVersions(value.versions)).catch(cause => setNotice(cause.message)); }}>版本记录</button>
      {versions?.map(version => <p className={styles.meta} key={version.versionId}>{version.name} · {version.current ? '当前版本' : '已保存版本'} · <RelativeTime value={version.createdAt} /></p>)}
      <button type="button" className={`${styles.button} ${styles.danger}`} disabled={busy || Boolean(pending || draftPending) || conflict} onClick={() => void remove()}><Trash2 size={15} />删除提示词组</button>
    </details>}
  </fieldset>}</Modal><Modal open={open && Boolean(latestView)} narrow title="当前已保存版本" onClose={() => setLatestView(null)}>{latestView && <div className={styles.detail}><h3>{latestView.name}</h3><p>{latestView.description}</p><pre style={{ whiteSpace: 'pre-wrap' }}>{latestView.body}</pre></div>}</Modal>{onUploadFile && <ResourceLibraryPicker open={open && coverOpen} onClose={() => setCoverOpen(false)} title="选择提示词组封面" imageOnly currentCount={0}
    currentAssetIds={[]} maxSelection={1} onUploadFile={onUploadFile} onConfirm={async ids => { setFields(v => ({ ...v, coverAssetId: ids[0] || null })); setCoverOpen(false); return true; }} />}{productDialog}</>;
}

export function PromptGroupPicker({ open, refs, onApply, onClose, onUploadFile }: { open: boolean; refs: VideoPromptGroupRef[];
  onApply: (refs: VideoPromptGroupRef[]) => void; onClose: () => void; onUploadFile?: ResourceLibraryPickerProps['onUploadFile'] }) {
  const { user, sessionChanged } = useAppSession();
  const [selection, setSelection] = useState<Group[]>([]), [groups, setGroups] = useState<Group[]>([]);
  const visibleOpen = open && !sessionChanged && Boolean(user?.id);
  const [query, setQuery] = useState(''), [scope, setScope] = useState('all'), [pages, setPages] = useState<string[]>(['']), [next, setNext] = useState<string | null>(null);
  const [selectedOnly, setSelectedOnly] = useState(false), [canCreate, setCanCreate] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [createReason, setCreateReason] = useState(''), [needsIdentity, setNeedsIdentity] = useState(false), [located, setLocated] = useState<Group | null>(null);
  const [refresh, setRefresh] = useState(0), [detail, setDetail] = useState<Group | null>(null), [profile, setProfile] = useState<Group | null>(null), [editor, setEditor] = useState<Group | null>(null);
  const preferencesKey = `sd2:video-group-picker:v1:${user?.id || 'anonymous'}`;
  const [preferencesReady, setPreferencesReady] = useState('');
  const listBody = useRef<HTMLDivElement>(null), scrollPosition = useRef(0), restorePosition = useRef(true), savedSequence = useRef(0);
  useEffect(() => {
    try {
      const value = JSON.parse(localStorage.getItem(preferencesKey) || '{}');
      setQuery(typeof value.query === 'string' ? value.query.slice(0, 160) : ''); setScope(['mine', 'shared'].includes(value.scope) ? value.scope : 'all');
      setPages(Array.isArray(value.pages) && value.pages.length > 0 && value.pages.length <= 30 && value.pages.every((id: unknown) => id === '' || typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) ? value.pages : ['']);
      scrollPosition.current = Number.isFinite(value.scroll) ? Math.max(0, Math.min(value.scroll, 1000000)) : 0;
    } catch { /* Invalid optional preferences fall back to the catalog. */ }
    setPreferencesReady(preferencesKey);
    return () => { savedSequence.current++; };
  }, [preferencesKey]);
  const rememberPosition = () => {
    if (preferencesReady !== preferencesKey) return;
    try { localStorage.setItem(preferencesKey, JSON.stringify({ query, scope, pages, scroll: scrollPosition.current })); } catch { /* Optional list position does not gate selection. */ }
  };
  useEffect(rememberPosition, [query, scope, pages, preferencesReady, preferencesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { restorePosition.current = true; }, [visibleOpen, editor, detail, profile]);
  useEffect(() => {
    if (visibleOpen && !editor && !detail && !profile && !loading && restorePosition.current && listBody.current) {
      listBody.current.scrollTop = scrollPosition.current; restorePosition.current = false;
    }
  }, [visibleOpen, editor, detail, profile, loading]);
  const selectionRef = useRef(selection); selectionRef.current = selection;
  useEffect(() => { if (open) { setSelection(refs); setError(''); setSelectedOnly(false); if (user?.id) setEditor(retainedEditor(user.id)); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!visibleOpen || !refs.length) return;
    const controller = new AbortController();
    void read(`${api}?refs=${encodeURIComponent(JSON.stringify(refs))}`, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setSelection(items => items.map(item => data.groups.find((value: Group) => value.groupId === item.groupId && value.versionId === item.versionId) || item));
    }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [visibleOpen, refresh, user?.id, JSON.stringify(refs)]); // eslint-disable-line react-hooks/exhaustive-deps
  const openEditor = (value: Group, copy = false) => {
    const target: Group = copy ? (() => { const id = crypto.randomUUID(); return { groupId: id, versionId: id, copyFrom: { groupId: value.groupId, versionId: value.versionId } }; })() : value;
    try { localStorage.setItem(editorScope(user?.id || 'anonymous'), JSON.stringify({ groupId: target.groupId, versionId: target.versionId, revision: target.revision, copyFrom: target.copyFrom })); setEditor(target); setDetail(null); }
    catch { setError('浏览器无法保留编辑现场，尚未打开编辑。'); }
  };
  const closeEditor = () => { setEditor(null); };
  useEffect(() => {
    if (!open || !user?.id || sessionChanged || preferencesReady !== preferencesKey) return;
    const controller = new AbortController(); setLoading(true); setError('');
    const search = new URLSearchParams({ query, scope, cursor: pages[pages.length - 1] });
    void read(`${api}?${search}`, { signal: controller.signal }).then(data => {
      if (controller.signal.aborted) return;
      setGroups(data.groups); setNext(data.nextCursor); setCanCreate(data.canCreate); setCreateReason(data.createReason || ''); setNeedsIdentity(data.requiresIdentityVerification === true);
      setSelection(current => current.map(item => data.groups.find((g: Group) => g.groupId === item.groupId && g.versionId === item.versionId) || item));
    }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, user?.id, sessionChanged, query, scope, pages, refresh, preferencesReady, preferencesKey]);
  const toggle = (item: Group) => setSelection(current => current.some(v => v.groupId === item.groupId) ? current.filter(v => v.groupId !== item.groupId)
    : current.length < VIDEO_GROUP_LIMIT ? [...current, item] : current);
  const edited = (ref: VideoPromptGroupRef, use: boolean, deleted = false) => {
    setRefresh(v => v + 1); setDetail(null);
    try { localStorage.removeItem(editorScope(user?.id || 'anonymous')); sessionStorage.removeItem(editorScope(user?.id || 'anonymous')); } catch { /* Server receipt remains authoritative. */ }
    if (deleted) {
      setSelection(items => items.map(item => item.groupId === ref.groupId ? { ...item, unavailable: true, deleted: true, reason: '已删除，历史保留，请移除或替换' } : item));
      setLocated(null); return;
    }
    setQuery(''); setScope('all'); setPages(['']); setSelectedOnly(false); scrollPosition.current = 0;
    const sequence = ++savedSequence.current;
    void read(`${api}?refs=${encodeURIComponent(JSON.stringify([{ groupId: ref.groupId, versionId: ref.versionId }]))}`).then(data => {
      const group = data.groups[0] as Group;
      if (sequence !== savedSequence.current) return;
      setLocated(group);
      if (use && !selectionRef.current.some(item => item.groupId === group.groupId) && selectionRef.current.length >= VIDEO_GROUP_LIMIT) setError('已保存；本次已选满12个，请先移除一项后再选用');
      if (use && !group.unavailable) setSelection(items => items.some(item => item.groupId === group.groupId) ? items.map(item => item.groupId === group.groupId ? group : item) : items.length < VIDEO_GROUP_LIMIT ? [...items, group] : items);
    }).catch(cause => setError(`已保存，目录定位尚未完成：${cause.message}`));
  };
  const visible = selectedOnly ? selection : located ? [located, ...groups.filter(item => item.groupId !== located.groupId)] : groups;
  const closePicker = () => { savedSequence.current++; rememberPosition(); onClose(); };
  return <><Modal open={visibleOpen && !editor && !detail && !profile} title="选择提示词组" onClose={closePicker} scrollRef={listBody} onScroll={event => { scrollPosition.current = event.currentTarget.scrollTop; rememberPosition(); }} footer={<>
    <button type="button" className={styles.plain} onClick={() => setSelectedOnly(v => !v)}>已选 {selection.length} 个{selectedOnly ? ' · 返回目录' : ' · 查看已选'}</button>
    {!selectedOnly && <div className={styles.actions}><button type="button" className={styles.icon} title="上一页" aria-label="上一页" disabled={pages.length === 1 || loading} onClick={() => setPages(v => v.slice(0, -1))}><ChevronLeft size={18} /></button>
      <span className={styles.meta}>第 {pages.length} 页</span><button type="button" className={styles.icon} title="下一页" aria-label="下一页" disabled={!next || loading} onClick={() => next && setPages(v => [...v, next])}><ChevronRight size={18} /></button></div>}
    <div className={styles.actions}><button type="button" className={styles.button} onClick={closePicker}>取消</button><button type="button" className={`${styles.button} ${styles.primary}`} onClick={() => { onApply(selection.map(({ groupId, versionId }) => ({ groupId, versionId }))); closePicker(); }}>确认选择</button></div>
  </>}><div className={styles.filters}><div className={styles.tabs} role="tablist" aria-label="提示词组来源">
    {[['all', '全部'], ['mine', '我的'], ['shared', '共享']].map(([id, label]) => <button type="button" key={id} role="tab" aria-selected={scope === id} onClick={() => { setScope(id); setPages(['']); setLocated(null); }}>{label}</button>)}</div>
    <input type="search" aria-label="搜索标题或作者" placeholder="搜索标题或作者" value={query} onChange={e => { setQuery(e.target.value); setPages(['']); setLocated(null); }} />
    {canCreate && <button type="button" className={styles.button} onClick={() => { const id = crypto.randomUUID(); openEditor({ groupId: id, versionId: id }); }}><Plus size={16} />新建</button>}</div>
    {error && <p className={styles.status} role="status">{error}<button type="button" className={styles.icon} title="重试" aria-label="重试" onClick={() => setRefresh(v => v + 1)}><RefreshCw size={16} /></button></p>}
    {!loading && !canCreate && createReason && <p className={styles.meta} role="status">{createReason}{needsIdentity && <button type="button" className={styles.plain} onClick={() => window.location.assign(`/api/auth/feishu/authorize?next=${encodeURIComponent(window.location.pathname + window.location.search)}`)}>验证身份</button>}</p>}
    {loading && <p className={styles.status} role="status">正在读取…</p>}
    <div className={styles.grid}>{visible.map(item => { const selected = selection.some(v => v.groupId === item.groupId); return <article key={item.groupId} className={styles.card} data-selected={selected}>
      <button type="button" className={styles.choose} aria-pressed={selected} disabled={Boolean(item.unavailable && !selected)} onClick={() => toggle(item)}><span className={styles.cover}><Cover item={item} /></span>
        <strong className={styles.title}>{item.name || '已选提示词组'}</strong><span className={styles.check} data-selected={selected}>{selected && <Check size={18} />}</span></button>
      <div className={styles.cardFoot}><Author item={item} onClick={() => setProfile(item)} /><button type="button" className={styles.icon} title="详情" aria-label="详情" onClick={() => setDetail(item)}><Info size={16} /></button>
        {(item.canManage || item.canCopy) && <details className={styles.menu}><summary className={styles.icon} title="管理提示词组" aria-label={`管理${item.name || '提示词组'}`}><MoreHorizontal size={16} /></summary><div className={styles.menuItems}>
          {item.canManage && <button type="button" onClick={() => openEditor(item)}><Pencil size={15} />编辑当前原组</button>}
          {item.canCopy && <button type="button" onClick={() => openEditor(item, true)}><Copy size={15} />另存私人副本</button>}
        </div></details>}</div></article>; })}</div>
    {!loading && !error && !visible.length && <p className={styles.status}>{query || scope !== 'all' ? '没有匹配的提示词组' : '暂无提示词组'}{query || scope !== 'all' ? <button type="button" className={styles.plain} onClick={() => { setQuery(''); setScope('all'); setPages(['']); }}>清除筛选</button> : canCreate && <button type="button" className={styles.button} onClick={() => { const id = crypto.randomUUID(); openEditor({ groupId: id, versionId: id }); }}><Plus size={16} />新建提示词组</button>}</p>}
  </Modal><GroupDetail item={visibleOpen ? detail : null} onClose={() => setDetail(null)} onUse={() => { if (detail) { if (!selectionRef.current.some(item => item.groupId === detail.groupId)) toggle(detail); setDetail(null); } }} onEdit={() => { if (detail) openEditor(detail); }} onCopy={() => { if (detail) openEditor(detail, true); }} />
    <Modal open={visibleOpen && Boolean(profile)} narrow title="作者资料" onClose={() => setProfile(null)}>{profile && <div className={styles.detail}><Author item={profile} /><p className={styles.meta}>提示词组原作者</p></div>}</Modal>
    {editor && <GroupEditor key={`${user?.id}:${editor.groupId}`} open={visibleOpen} item={editor} onClose={closeEditor} onSaved={edited} onUploadFile={onUploadFile} />}</>;
}

export function PromptGroupSelection({ refs, onChange, disabled = false, onUploadFile }: { refs: VideoPromptGroupRef[];
  onChange: (refs: VideoPromptGroupRef[]) => void; disabled?: boolean; onUploadFile?: ResourceLibraryPickerProps['onUploadFile'] }) {
  const { user } = useAppSession(), summaries = useVideoPromptGroupSummaries(refs);
  const [open, setOpen] = useState(false), [expanded, setExpanded] = useState(false), [detail, setDetail] = useState<Group | null>(null), [undo, setUndo] = useState<VideoPromptGroupRef[] | null>(null);
  const container = useRef<HTMLDivElement>(null), [visibleLimit, setVisibleLimit] = useState(2);
  useEffect(() => {
    const element = container.current; if (!element) return;
    const observer = new ResizeObserver(entries => setVisibleLimit(Math.max(1, Math.floor((entries[0].contentRect.width - 72) / 280)) * 2));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  const change = (next: VideoPromptGroupRef[]) => { setUndo(refs); onChange(next); };
  const move = (index: number, step: number) => { const next = [...refs]; [next[index], next[index + step]] = [next[index + step], next[index]]; change(next); };
  return <><div ref={container} className={styles.selection} aria-label="本次提示词组">
    {(expanded ? summaries.groups : summaries.groups.slice(0, visibleLimit)).map((item, index) => <div className={styles.attachment} key={item.groupId}>
      <button type="button" className={styles.plain} title={item.reason || item.name || '查看详情'} onClick={() => setDetail(item)}><Cover item={item} small /><strong>{item.name || '提示词组不可用'}{item.unavailable ? ' · 不可用' : ''}</strong></button>
      <button type="button" className={styles.icon} title="前移" aria-label="前移" disabled={disabled || index === 0} onClick={() => move(index, -1)}><ArrowLeft size={13} /></button>
      <button type="button" className={styles.icon} title="后移" aria-label="后移" disabled={disabled || index === refs.length - 1} onClick={() => move(index, 1)}><ArrowRight size={13} /></button>
      {item.latestVersionId && item.latestVersionId !== item.versionId && <button type="button" className={styles.icon} title="使用最新版本" aria-label="使用最新版本" disabled={disabled} onClick={() => change(refs.map(ref => ref.groupId === item.groupId ? { ...ref, versionId: item.latestVersionId! } : ref))}><RefreshCw size={14} /></button>}
      <button type="button" className={styles.icon} title="移除本次引用" aria-label="移除本次引用" disabled={disabled} onClick={() => change(refs.filter(ref => ref.groupId !== item.groupId))}><X size={14} /></button></div>)}
    <button type="button" className={styles.add} title="添加提示词组" aria-label="添加提示词组" disabled={disabled} onClick={() => setOpen(true)}><Plus size={18} /><span>提示词组</span></button>
    {refs.length > visibleLimit && <button type="button" className={styles.plain} onClick={() => setExpanded(v => !v)}>{expanded ? '收起' : `全部 ${refs.length} 个`}</button>}
    {undo && <button type="button" className={styles.icon} title="撤销组选取修改" aria-label="撤销组选取修改" disabled={disabled} onClick={() => { onChange(undo); setUndo(null); }}><Undo2 size={16} /></button>}
    {summaries.error && <span className={styles.meta} role="status">{summaries.error}<button type="button" className={styles.icon} title="重新核对提示词组" aria-label="重新核对提示词组" onClick={summaries.refresh}><RefreshCw size={14} /></button></span>}
  </div><PromptGroupPicker key={user?.id || 'anonymous'} open={open} refs={refs} onApply={next => { change(next); summaries.refresh(); }} onClose={() => { setOpen(false); summaries.refresh(); }} onUploadFile={onUploadFile} /><GroupDetail item={detail} onClose={() => setDetail(null)} /></>;
}
export function PromptGroupHistory({ refs, label = '提示词组' }: { refs: VideoPromptGroupRef[]; label?: string }) {
  const { groups, error, refresh } = useVideoPromptGroupSummaries(refs), [detail, setDetail] = useState<Group | null>(null);
  if (!refs.length) return null;
  return <section className={styles.history}><h3>{label} · {refs.length}</h3><div className={styles.grid}>{groups.map(item => <article key={item.groupId} className={styles.card}>
    <button type="button" className={styles.choose} onClick={() => setDetail(item)}><span className={styles.cover}><Cover item={item} /></span><strong className={styles.title}>{item.name || '提示词组不可用'}</strong></button>
    <div className={styles.cardFoot}><Author item={item} onClick={() => setDetail(item)} /><span className={styles.meta}>当时版本</span></div></article>)}</div>
    {error && <p role="status">{error}<button type="button" className={styles.icon} title="重试" aria-label="重试" onClick={refresh}><RefreshCw size={16} /></button></p>}<GroupDetail item={detail} onClose={() => setDetail(null)} /></section>;
}
