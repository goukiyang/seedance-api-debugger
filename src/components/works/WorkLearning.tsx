'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RelativeTime } from '@/components/RelativeTime';
import { pendingWorkOperations, queryWorkOperation, worksMutate, worksRead, WorksClientError, type PendingWorkOperation } from '@/lib/works/client';
import type { WorkCard, WorkPage } from '@/lib/works/types';
import type { WorkDerivationPage, WorkLearningEntry, WorkLearningKind, WorkLearningPage } from '@/lib/works/learning-types';
import styles from './WorkLearning.module.css';

type Editor = { kind: WorkLearningKind; parentId: string | null; entryId: string | null; revision: number; body: string; time: string; submitted?: PendingWorkOperation };
const message = (cause: unknown) => cause instanceof Error ? cause.message : '读取未完成，请重试';
const timeText = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;

export function WorkLearning({ work, viewerId, disabled = false, onSeek, onOpenWork }: {
  work: WorkCard; viewerId: string; disabled?: boolean; onSeek?: (timeSeconds: number) => void; onOpenWork?: (work: WorkCard) => void;
}) {
  const identity = `${viewerId}:${work.id}:${work.mediaVersion}`;
  const prefix = `learning:${work.id}:${work.mediaVersion}:`;
  const draftKey = `sd2:works:learning-draft:v1:${identity}`;
  const endpoint = `/api/works/${encodeURIComponent(work.id)}/learning`;
  const derivationsEndpoint = `/api/works/${encodeURIComponent(work.id)}/derivations`;
  const [page, setPage] = useState<WorkLearningPage | null>(null), [answers, setAnswers] = useState<WorkLearningPage | null>(null);
  const [links, setLinks] = useState<WorkDerivationPage | null>(null), [openQuestion, setOpenQuestion] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null), [draftReady, setDraftReady] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [reading, setReading] = useState(false), [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(() => pendingWorkOperations(viewerId).filter(item => item.key.startsWith(prefix)));
  const [ownPage, setOwnPage] = useState<WorkPage | null>(null), [pickerOpen, setPickerOpen] = useState(false), [selected, setSelected] = useState('');
  const current = useRef(identity); current.current = identity;
  const editorRef = useRef(editor); editorRef.current = editor;
  const isAuthor = viewerId === work.author.id;
  const blocked = disabled || busy || pending.length > 0;
  const canTime = work.medium === 'video' && work.duration !== null && Number.isFinite(work.duration) && work.duration > 0;
  const editorKey = (value: Editor) => `${prefix}${value.entryId || value.kind + ':' + (value.parentId || 'new')}`;

  const load = useCallback(async (signal?: AbortSignal) => {
    const captured = identity;
    setReading(true);
    try {
      const query = new URLSearchParams({ version: work.mediaVersion });
      const [next, nextLinks] = await Promise.all([
        worksRead<WorkLearningPage>(`${endpoint}?${query}`, viewerId, signal),
        worksRead<WorkDerivationPage>(`${derivationsEndpoint}?${query}`, viewerId, signal),
      ]);
      if (current.current !== captured || signal?.aborted) return;
      setPage(next); setLinks(nextLinks); setError('');
    } catch (cause) {
      if (current.current !== captured || signal?.aborted) return;
      if (cause instanceof WorksClientError && [403, 404, 409].includes(cause.status)) { setPage(null); setLinks(null); setAnswers(null); }
      setError(message(cause));
    } finally { if (current.current === captured && !signal?.aborted) setReading(false); }
  }, [identity, work.mediaVersion, endpoint, derivationsEndpoint, viewerId]);

  useEffect(() => {
    const controller = new AbortController();
    setPage(null); setLinks(null); setAnswers(null); setOpenQuestion(null); setOwnPage(null); setPickerOpen(false); setSelected(''); setNotice(''); setBusy(false);
    setPending(pendingWorkOperations(viewerId).filter(item => item.key.startsWith(prefix)));
    setEditor(null);
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) || 'null') as Editor | null;
      if (saved && ['experience', 'question', 'answer'].includes(saved.kind) && typeof saved.body === 'string' && saved.body.length <= 4000
        && typeof saved.time === 'string' && (saved.entryId === null || typeof saved.entryId === 'string')
        && (saved.parentId === null || typeof saved.parentId === 'string') && Number.isSafeInteger(saved.revision)) {
        const original = saved.submitted;
        if (original && (typeof original.requestId !== 'string' || !/^[\w-]{8,100}$/.test(original.requestId) || typeof original.key !== 'string' || !original.key.startsWith(prefix))) delete saved.submitted;
        setEditor(saved);
        if (saved.submitted) setPending(previous => [...previous.filter(item => item.requestId !== saved.submitted!.requestId), saved.submitted!]);
      }
    } catch { /* The editor remains usable when browser draft storage is unavailable. */ }
    setDraftReady(identity);
    void load(controller.signal);
    return () => controller.abort();
  }, [identity, prefix, viewerId, draftKey, load]);

  useEffect(() => {
    if (draftReady !== identity) return;
    try { if (editor) localStorage.setItem(draftKey, JSON.stringify(editor)); else localStorage.removeItem(draftKey); }
    catch { /* The durable operation ID is still required and checked by worksMutate before sending. */ }
  }, [editor, draftReady, identity, draftKey]);

  async function readAnswers(parentId: string, after?: string) {
    const captured = identity; setBusy(true); setError('');
    try {
      const query = new URLSearchParams({ version: work.mediaVersion, parentId, ...(after ? { after } : {}) });
      const data = await worksRead<WorkLearningPage>(`${endpoint}?${query}`, viewerId);
      if (current.current === captured) { setOpenQuestion(parentId); setAnswers(data); }
    } catch (cause) { if (current.current === captured) { setAnswers(null); setError(message(cause)); } }
    finally { if (current.current === captured) setBusy(false); }
  }
  function begin(kind: WorkLearningKind, entry?: WorkLearningEntry, parentId: string | null = null) {
    setNotice(''); setError('');
    setEditor({ kind, parentId: entry?.parentId ?? parentId, entryId: entry?.id || null, revision: entry?.revision || 0,
      body: entry?.body || '', time: entry?.timeSeconds != null ? String(entry.timeSeconds) : '' });
  }
  async function write(key: string, url: string, body: Record<string, unknown>, method = 'POST') {
    const captured = identity; setBusy(true); setError(''); setNotice('');
    let original: PendingWorkOperation | undefined;
    try {
      const submission = worksMutate(viewerId, key, url, body, method);
      original = pendingWorkOperations(viewerId).find(item => item.key === key);
      // Remember the original ID with this draft before yielding to the network.
      // Another mounted catalog consumer may reconcile the shared pending list.
      if (original && editorRef.current && editorKey(editorRef.current) === key) {
        const submitted = { ...editorRef.current, submitted: original };
        setEditor(submitted);
        try { localStorage.setItem(draftKey, JSON.stringify(submitted)); } catch { /* Shared pending identity remains saved by worksMutate. */ }
      }
      const result = await submission;
      if (current.current !== captured) return null;
      setPending(pendingWorkOperations(viewerId).filter(item => item.key.startsWith(prefix)));
      return result;
    } catch (cause) {
      if (current.current === captured) {
        const outstanding = pendingWorkOperations(viewerId).filter(item => item.key.startsWith(prefix));
        const rejected = cause instanceof WorksClientError && cause.status >= 400 && cause.status < 500 && ![408, 429].includes(cause.status);
        if (rejected && editorRef.current?.submitted?.key === key) {
          const draft = { ...editorRef.current }; delete draft.submitted;
          setEditor(draft);
          try { localStorage.setItem(draftKey, JSON.stringify(draft)); } catch { /* The input stays in the current editor. */ }
        } else if (!rejected && original && !outstanding.some(item => item.requestId === original!.requestId)) outstanding.push(original);
        setError(message(cause)); setPending(outstanding);
      }
      return null;
    } finally { if (current.current === captured) setBusy(false); }
  }
  async function save() {
    if (!editor || blocked || !editor.body.trim()) return;
    const draft = editor;
    const time = draft.time.trim() ? Number(draft.time) : null;
    if (time !== null && (!canTime || !Number.isFinite(time) || time < 0 || time > work.duration!)) {
      setError('时间点请填写当前视频时长内的秒数，或留空。'); return;
    }
    const result = await write(editorKey(draft), endpoint, {
      expectedMediaVersion: work.mediaVersion, ...(draft.entryId ? { entryId: draft.entryId, expectedRevision: draft.revision }
        : { kind: draft.kind, parentId: draft.parentId }), body: draft.body, timeSeconds: time,
    }, draft.entryId ? 'PATCH' : 'POST');
    if (!result) return;
    if (editorRef.current && editorKey(editorRef.current) === editorKey(draft)) setEditor(null);
    setNotice('已保存。'); await load();
    if (draft.parentId) await readAnswers(draft.parentId);
  }
  async function remove(entry: WorkLearningEntry) {
    const result = await write(`${prefix}${entry.id}`, endpoint, {
      expectedMediaVersion: work.mediaVersion, entryId: entry.id, expectedRevision: entry.revision,
    }, 'DELETE');
    if (!result) return;
    if (editorRef.current?.entryId === entry.id) setEditor(null);
    setNotice('已删除本人记录。'); await load();
    if (entry.parentId) await readAnswers(entry.parentId);
    else { setAnswers(null); setOpenQuestion(null); }
  }
  async function reconcile() {
    const captured = identity;
    const originals = Array.from(new Map([...pending, ...pendingWorkOperations(viewerId).filter(item => item.key.startsWith(prefix))]
      .map(item => [item.requestId, item])).values());
    const resolved = new Set<string>();
    setBusy(true); setError('');
    try {
      for (const item of originals) {
        const result = await queryWorkOperation(viewerId, item);
        if (current.current !== captured) return;
        resolved.add(item.requestId);
        if (result.kind === 'work-learning' && editorRef.current && editorKey(editorRef.current) === item.key) setEditor(null);
      }
      if (current.current !== captured) return;
      setNotice('已核对原操作。'); await load();
      if (openQuestion) await readAnswers(openQuestion);
    } catch (cause) { if (current.current === captured) setError(message(cause)); }
    finally { if (current.current === captured) {
      setPending(Array.from(new Map([...originals.filter(item => !resolved.has(item.requestId)),
        ...pendingWorkOperations(viewerId).filter(item => item.key.startsWith(prefix))].map(item => [item.requestId, item])).values())); setBusy(false);
    } }
  }
  async function nextQuestions() {
    if (!page?.nextCursor) return;
    const captured = identity;
    setBusy(true);
    try {
      const query = new URLSearchParams({ version: work.mediaVersion, after: page.nextCursor });
      const next = await worksRead<WorkLearningPage>(`${endpoint}?${query}`, viewerId);
      if (current.current === captured) { setPage(next); setAnswers(null); setOpenQuestion(null); }
    } catch (cause) { if (current.current === captured) setError(message(cause)); } finally { if (current.current === captured) setBusy(false); }
  }
  async function readOwn(after?: string) {
    const captured = identity; setBusy(true); setError('');
    try {
      const query = new URLSearchParams({ scope: 'mine', ...(after && ownPage ? { after, window: ownPage.window } : {}) });
      const data = await worksRead<WorkPage>(`/api/works?${query}`, viewerId);
      if (current.current === captured) { setOwnPage(data); setPickerOpen(true); setSelected(''); }
    } catch (cause) { if (current.current === captured) setError(message(cause)); }
    finally { if (current.current === captured) setBusy(false); }
  }
  async function attach() {
    const chosen = ownPage?.items.find(item => item.id === selected);
    if (!chosen) return;
    const captured = identity;
    const query = new URLSearchParams({ version: work.mediaVersion, derivedWorkId: chosen.id });
    let revision: number;
    try {
      const state = await worksRead<WorkDerivationPage & { ownRevision: number }>(`${derivationsEndpoint}?${query}`, viewerId);
      if (current.current !== captured) return;
      revision = state.ownRevision;
    } catch (cause) { if (current.current === captured) setError(message(cause)); return; }
    const result = await write(`${prefix}derivation:${chosen.id}`, derivationsEndpoint, { expectedMediaVersion: work.mediaVersion,
      derivedWorkId: chosen.id, expectedDerivedMediaVersion: chosen.mediaVersion, expectedRevision: revision });
    if (result) { setNotice('已关联本人实践作品。'); setPickerOpen(false); await load(); }
  }
  function entryView(entry: WorkLearningEntry) {
    return <article key={entry.id} className={styles.entry}>
      <div className={styles.entryMeta}><span>{entry.author.name}</span><RelativeTime value={entry.createdAt} />
        {entry.timeSeconds !== null && <button type="button" disabled={!onSeek || disabled} onClick={() => onSeek?.(entry.timeSeconds!)} aria-label={`跳到视频 ${timeText(entry.timeSeconds)}`}>{timeText(entry.timeSeconds)}</button>}
      </div><p className={styles.body}>{entry.body}</p>
      <div className={styles.row}>
        {entry.kind === 'question' && <button type="button" disabled={busy || disabled} onClick={() => openQuestion === entry.id ? (setOpenQuestion(null), setAnswers(null)) : void readAnswers(entry.id)}>{openQuestion === entry.id ? '收起回答' : '查看 / 回答'}</button>}
        {entry.canEdit && <><button type="button" disabled={blocked} onClick={() => begin(entry.kind, entry)}>编辑</button><button type="button" disabled={blocked} onClick={() => void remove(entry)}>删除</button></>}
      </div>
      {entry.kind === 'question' && openQuestion === entry.id && <div className={styles.answers}>
        {answers?.items.map(entryView)}
        {answers && !answers.items.length && <p className={styles.muted}>还没有回答。</p>}
        <div className={styles.row}><button type="button" disabled={blocked} onClick={() => begin('answer', undefined, entry.id)}>写回答</button>
          {answers?.nextCursor && <button type="button" disabled={busy} onClick={() => void readAnswers(entry.id, answers.nextCursor!)}>后续回答</button>}</div>
      </div>}
    </article>;
  }
  return <section className={styles.learning} aria-label="作品学习">
    <header className={styles.heading}><h2>学习与交流</h2><button type="button" disabled={reading || busy} onClick={() => { void load(); setAnswers(null); setOpenQuestion(null); }}>{reading ? '读取中…' : '刷新'}</button></header>
    {error && <p className={styles.error} role="status">{error}</p>}
    {pending.length > 0 && <div className={styles.pending} role="status"><span>提交结果待确认，当前输入已保留。</span><button type="button" disabled={busy} onClick={() => void reconcile()}>核对原操作</button></div>}
    {notice && <p className={styles.muted} role="status">{notice}</p>}
    {page && page.workId === work.id && page.mediaVersion === work.mediaVersion && <>
      <div className={styles.experience}><h3>作者的一句经验</h3>{page.experience ? entryView(page.experience) : <p className={styles.muted}>{isAuthor ? '有想分享的做法时，留一句就好。' : '作者暂未分享经验。'}</p>}
        {isAuthor && !page.experience && <button type="button" disabled={blocked} onClick={() => begin('experience')}>分享一句经验</button>}</div>
      <div className={styles.heading}><h3>问答</h3><button type="button" disabled={blocked} onClick={() => begin('question')}>提问</button></div>
      {page.items.map(entryView)}
      {!page.items.length && <p className={styles.muted}>还没有问题。</p>}
      {page.nextCursor && <button type="button" disabled={busy} onClick={() => void nextQuestions()}>更早的问题</button>}
    </>}
    {editor && draftReady === identity && <form className={styles.editor} onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>{editor.entryId ? '编辑' : editor.kind === 'experience' ? '一句经验' : editor.kind === 'answer' ? '回答' : '问题'}
        <textarea value={editor.body} maxLength={editor.kind === 'experience' ? 500 : 4000} disabled={blocked} rows={editor.kind === 'experience' ? 2 : 4} onChange={event => setEditor({ ...editor, body: event.target.value })} /></label>
      {editor.kind !== 'experience' && canTime && <label className={styles.timeInput}>视频时间点（秒，可选）<input type="number" min="0" max={work.duration!} step="0.1" value={editor.time} disabled={blocked} onChange={event => setEditor({ ...editor, time: event.target.value })} /></label>}
      <div className={styles.row}><button type="submit" disabled={blocked || !editor.body.trim()}>{busy ? '保存中…' : '保存'}</button><button type="button" disabled={busy || pending.length > 0} onClick={() => setEditor(null)}>收起编辑</button></div>
    </form>}
    {links && links.workId === work.id && links.mediaVersion === work.mediaVersion && <div className={styles.derivations}><div className={styles.heading}><h3>从这件作品出发的实践</h3><button type="button" disabled={blocked} onClick={() => void readOwn()}>关联我的作品</button></div>
      {links.items.map(({ link, work: linked }) => <div key={link.id} className={styles.linkedWork}><a href={`/works?work=${encodeURIComponent(linked.id)}`} onClick={event => {
        if (onOpenWork && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); onOpenWork(linked); }
      }}>{linked.title}<span>{linked.author.name}</span></a>
        {link.canEdit && <button type="button" disabled={blocked} onClick={async () => { const result = await write(`${prefix}derivation:${linked.id}`, derivationsEndpoint, {
          expectedMediaVersion: work.mediaVersion, linkId: link.id, expectedRevision: link.revision,
        }, 'DELETE'); if (result) { setNotice('已取消本人声明的关联。'); await load(); } }}>取消关联</button>}</div>)}
      {!links.items.length && <p className={styles.muted}>实践后可自愿关联自己的作品。</p>}
      {links.nextCursor && <button type="button" disabled={busy} onClick={async () => { const captured = identity; try {
        const next = await worksRead<WorkDerivationPage>(`${derivationsEndpoint}?${new URLSearchParams({ version: work.mediaVersion, after: links.nextCursor! })}`, viewerId);
        if (current.current === captured) setLinks(next);
      } catch (cause) { setError(message(cause)); } }}>更多实践</button>}
      {pickerOpen && <div className={styles.picker}><label>选择本人实践作品<select value={selected} disabled={blocked} onChange={event => setSelected(event.target.value)}><option value="">请选择</option>
        {ownPage?.items.filter(item => item.id !== work.id).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        <div className={styles.row}><button type="button" disabled={blocked || !selected} onClick={() => void attach()}>确认关联</button>
          {ownPage?.nextCursor && <button type="button" disabled={busy} onClick={() => void readOwn(ownPage.nextCursor!)}>下一页本人作品</button>}
          <button type="button" disabled={busy} onClick={() => setPickerOpen(false)}>收起</button></div></div>}
    </div>}
  </section>;
}
