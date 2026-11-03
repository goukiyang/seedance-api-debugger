'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RelativeTime } from '@/components/RelativeTime';
import { WorkAuthor } from './WorkAuthor';
import { WorkEmojiPicker } from './WorkEmojiPicker';
import { pendingWorkOperations, queryWorkOperation, worksMutate, worksRead, WorksClientError, type PendingWorkOperation } from '@/lib/works/client';
import type { WorkCard } from '@/lib/works/types';
import type { WorkLearningEntry, WorkLearningKind, WorkLearningPage } from '@/lib/works/learning-types';
import styles from './WorkLearning.module.css';

type Editor = { kind: WorkLearningKind; parentId: string | null; entryId: string | null; revision: number; body: string; time: string; submitted?: PendingWorkOperation };
const message = (cause: unknown) => cause instanceof Error ? cause.message : '读取未完成，请重试';
const timeText = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;

export function WorkLearning({ work, viewerId, disabled = false, onSeek }: {
  work: WorkCard; viewerId: string; disabled?: boolean; onSeek?: (timeSeconds: number) => void;
}) {
  const identity = `${viewerId}:${work.id}:${work.mediaVersion}`;
  const prefix = `learning:${work.id}:${work.mediaVersion}:`;
  const draftKey = `sd2:works:learning-draft:v1:${identity}`;
  const endpoint = `/api/works/${encodeURIComponent(work.id)}/learning`;
  const [page, setPage] = useState<WorkLearningPage | null>(null), [answers, setAnswers] = useState<WorkLearningPage | null>(null);
  const [openQuestion, setOpenQuestion] = useState<string | null>(null);
  const draftStash = useRef<Record<string, Editor>>({});
  const [editor, setEditor] = useState<Editor | null>(null), [draftReady, setDraftReady] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [reading, setReading] = useState(false), [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(() => pendingWorkOperations(viewerId).filter(item => item.key.startsWith(prefix)));
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const current = useRef(identity); current.current = identity;
  const editorRef = useRef(editor); editorRef.current = editor;
  const blocked = disabled || busy || pending.length > 0;
  const canTime = work.medium === 'video' && work.duration !== null && Number.isFinite(work.duration) && work.duration > 0;
  const editorKey = useCallback((value: Editor) => `${prefix}${value.entryId || value.kind + ':' + (value.parentId || 'new')}`, [prefix]);

  const load = useCallback(async (signal?: AbortSignal) => {
    const captured = identity;
    setReading(true);
    try {
      const query = new URLSearchParams({ version: work.mediaVersion });
      const next = await worksRead<WorkLearningPage>(`${endpoint}?${query}`, viewerId, signal);
      if (current.current !== captured || signal?.aborted) return;
      setPage(next); setError('');
    } catch (cause) {
      if (current.current !== captured || signal?.aborted) return;
      if (cause instanceof WorksClientError && [403, 404, 409].includes(cause.status)) { setPage(null); setAnswers(null); }
      setError(message(cause));
    } finally { if (current.current === captured && !signal?.aborted) setReading(false); }
  }, [identity, work.mediaVersion, endpoint, viewerId]);

  useEffect(() => {
    const controller = new AbortController();
    setPage(null); setAnswers(null); setOpenQuestion(null); setNotice(''); setBusy(false);
    draftStash.current = {};
    try { const targets = JSON.parse(localStorage.getItem(`${draftKey}:targets`) || '{}'); if (targets && typeof targets === 'object' && !Array.isArray(targets)) draftStash.current = targets; } catch { /* The active draft remains usable. */ }
    setPending(pendingWorkOperations(viewerId).filter(item => item.key.startsWith(prefix)));
    setEditor(null);
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) || 'null') as Editor | null;
      if (saved && ['experience', 'question', 'answer'].includes(saved.kind) && typeof saved.body === 'string' && saved.body.length <= 4000
        && typeof saved.time === 'string' && (saved.entryId === null || typeof saved.entryId === 'string')
        && (saved.parentId === null || typeof saved.parentId === 'string') && Number.isSafeInteger(saved.revision)) {
        const original = saved.submitted;
        if (original && (typeof original.requestId !== 'string' || !/^[\w-]{8,100}$/.test(original.requestId) || typeof original.key !== 'string' || !original.key.startsWith(prefix))) delete saved.submitted;
        if (saved.kind !== 'experience') setEditor(saved); else draftStash.current[editorKey(saved)] = saved;
        if (saved.submitted) setPending(previous => [...previous.filter(item => item.requestId !== saved.submitted!.requestId), saved.submitted!]);
      }
    } catch { /* The editor remains usable when browser draft storage is unavailable. */ }
    setDraftReady(identity);
    void load(controller.signal);
    return () => controller.abort();
  }, [identity, prefix, viewerId, draftKey, load, editorKey]);

  useEffect(() => {
    if (draftReady !== identity) return;
    try { if (editor) { localStorage.setItem(draftKey, JSON.stringify(editor)); draftStash.current[editorKey(editor)] = editor; } else localStorage.removeItem(draftKey); localStorage.setItem(`${draftKey}:targets`, JSON.stringify(draftStash.current)); }
    catch { /* The durable operation ID is still required and checked by worksMutate before sending. */ }
  }, [editor, draftReady, identity, draftKey, editorKey]);

  async function readAnswers(parentId: string, after?: string) {
    const captured = identity; setBusy(true); setError('');
    try {
      const query = new URLSearchParams({ version: work.mediaVersion, parentId, ...(after ? { after } : {}) });
      const data = await worksRead<WorkLearningPage>(`${endpoint}?${query}`, viewerId);
      if (current.current === captured) { setOpenQuestion(parentId); setAnswers(previous => after && previous && openQuestion === parentId ? { ...data, items: [...previous.items, ...data.items] } : data); }
    } catch (cause) { if (current.current === captured) { setAnswers(null); setError(message(cause)); } }
    finally { if (current.current === captured) setBusy(false); }
  }
  function begin(kind: WorkLearningKind, entry?: WorkLearningEntry, parentId: string | null = null) {
    setNotice(''); setError('');
    if (editorRef.current) draftStash.current[editorKey(editorRef.current)] = editorRef.current;
    const next: Editor = { kind, parentId: entry?.parentId ?? parentId, entryId: entry?.id || null, revision: entry?.revision || 0,
      body: entry?.body || '', time: entry?.timeSeconds != null ? String(entry.timeSeconds) : '' };
    const retained = draftStash.current[editorKey(next)];
    setEditor(retained && retained.kind === kind && retained.parentId === next.parentId && retained.entryId === next.entryId && typeof retained.time === 'string' && typeof retained.body === 'string' && retained.body.length <= 4000 ? retained : next);
    try { localStorage.setItem(`${draftKey}:targets`, JSON.stringify(draftStash.current)); } catch { /* Current inputs stay mounted. */ }
    if (next.parentId && openQuestion !== next.parentId) void readAnswers(next.parentId);
    requestAnimationFrame(() => composerRef.current?.focus());
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
    delete draftStash.current[editorKey(draft)];
    if (editorRef.current && editorKey(editorRef.current) === editorKey(draft)) setEditor(draftStash.current[`${prefix}question:new`] || null);
    try { localStorage.setItem(`${draftKey}:targets`, JSON.stringify(draftStash.current)); } catch { /* Only the original operation may be reconciled. */ }
    setNotice(''); await load();
    if (draft.parentId) await readAnswers(draft.parentId);
  }
  async function remove(entry: WorkLearningEntry) {
    const result = await write(`${prefix}${entry.id}`, endpoint, {
      expectedMediaVersion: work.mediaVersion, entryId: entry.id, expectedRevision: entry.revision,
    }, 'DELETE');
    if (!result) return;
    delete draftStash.current[`${prefix}${entry.id}`];
    if (editorRef.current?.entryId === entry.id) setEditor(draftStash.current[`${prefix}question:new`] || null);
    setNotice(''); await load();
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
        if (result.kind === 'work-learning') { delete draftStash.current[item.key]; if (editorRef.current && editorKey(editorRef.current) === item.key) setEditor(draftStash.current[`${prefix}question:new`] || null); }
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
      if (current.current === captured) { setPage(previous => previous ? { ...next, items: [...previous.items, ...next.items] } : next); }
    } catch (cause) { if (current.current === captured) setError(message(cause)); } finally { if (current.current === captured) setBusy(false); }
  }
  const composer: Editor = editor || { kind: 'question', parentId: null, entryId: null, revision: 0, body: '', time: '' };
  function renderComposer() {
    return <form className={styles.editor} onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>{composer.entryId ? '编辑留言' : composer.kind === 'answer' ? '回复本对话' : '写留言'}
        <textarea ref={composerRef} value={composer.body} maxLength={4000} disabled={blocked} rows={3} placeholder="说点什么…" onChange={event => setEditor({ ...composer, body: event.target.value })} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void save(); } }} /></label>
      {canTime && <details className={styles.timeInput}><summary>添加视频时间点</summary><label>秒<input type="number" min="0" max={work.duration!} step="0.1" value={composer.time} disabled={blocked} onChange={event => setEditor({ ...composer, time: event.target.value })} /></label></details>}
      <div className={styles.composerActions}><WorkEmojiPicker disabled={blocked} onSelect={emoji => {
        const input = composerRef.current, start = input?.selectionStart ?? composer.body.length, end = input?.selectionEnd ?? start;
        const body = composer.body.slice(0, start) + emoji + composer.body.slice(end); if (body.length > 4000) return;
        setEditor({ ...composer, body }); requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(start + emoji.length, start + emoji.length); });
      }} /><span className={styles.composerEnd} /><button type="submit" disabled={blocked || !composer.body.trim()}>{busy ? '发送中…' : composer.entryId ? '保存修改' : composer.kind === 'answer' ? '发送回复' : '发送'}</button>{editor && (editor.entryId || editor.kind !== 'question') && <button type="button" disabled={busy || pending.length > 0} onClick={() => begin('question')}>收起</button>}</div>
    </form>;

  }
  function entryView(entry: WorkLearningEntry) {
    return <article key={entry.id} className={styles.entry}>
      <div className={styles.entryMeta}><WorkAuthor author={entry.author} /><RelativeTime value={entry.createdAt} />
        {entry.timeSeconds !== null && <button type="button" disabled={!onSeek || disabled} onClick={() => onSeek?.(entry.timeSeconds!)} aria-label={`跳到视频 ${timeText(entry.timeSeconds)}`}>{timeText(entry.timeSeconds)}</button>}
      </div><p className={styles.body}>{entry.body}</p>
      <div className={styles.entryActions}>
        {entry.kind === 'question' && (openQuestion === entry.id || (entry.replyCount ?? 0) > 0) && <button type="button" disabled={busy || disabled} onClick={() => openQuestion === entry.id ? (setOpenQuestion(null), setAnswers(null)) : void readAnswers(entry.id)}>{openQuestion === entry.id ? '收起对话' : `${entry.replyCount} 条回复`}</button>}
        <button type="button" disabled={blocked} onClick={() => { const parent = entry.parentId || entry.id; begin('answer', undefined, parent); }}>回复</button>
        {entry.canEdit && <><button type="button" disabled={blocked} onClick={() => begin(entry.kind, entry)}>编辑</button><button type="button" disabled={blocked} onClick={() => void remove(entry)}>删除</button></>}
      </div>
      {entry.kind === 'question' && openQuestion === entry.id && <div className={styles.answers}>
        {answers?.items.map(entryView)}
        {editor?.parentId === entry.id && renderComposer()}
        <div className={styles.row}>
          {answers?.nextCursor && <button type="button" disabled={busy} onClick={() => void readAnswers(entry.id, answers.nextCursor!)}>更多回复</button>}</div>
      </div>}
    </article>;
  }
  return <section className={styles.learning} aria-label="留言板">
    <header className={styles.heading}><h2>留言板</h2><button type="button" disabled={reading || busy} onClick={() => { void load(); setAnswers(null); setOpenQuestion(null); }}>{reading ? '读取中…' : '刷新'}</button></header>
    {error && <p className={styles.error} role="status">{error}</p>}
    {pending.length > 0 && <div className={styles.pending} role="status"><span>提交结果待确认，当前输入已保留。</span><button type="button" disabled={busy} onClick={() => void reconcile()}>核对原操作</button></div>}
    {notice && <p className={styles.muted} role="status">{notice}</p>}
    {draftReady === identity && (!editor?.parentId || openQuestion !== editor.parentId) && renderComposer()}
    {page && page.workId === work.id && page.mediaVersion === work.mediaVersion && <>
      {page.items.map(entryView)}
      {!page.items.length && <p className={styles.muted}>还没有留言。</p>}
      {page.nextCursor && <button type="button" disabled={busy} onClick={() => void nextQuestions()}>更早的留言</button>}
    </>}

  </section>;
}
