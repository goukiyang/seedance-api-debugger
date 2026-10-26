'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { TaskVideoThumbnail } from '@/components/TaskVideoThumbnail';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { isExternalUser } from '@/lib/access/external-role';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { readJsonResponse } from '@/lib/http/json-response';
import styles from './multiview-source-picker.module.css';

export type MultiviewSourcePickerProps = {
  open: boolean;
  onClose: () => void;
  onSelect: (taskId: string) => void;
  currentTaskId?: string;
};
type VideoChoice = { id: string; title: string | null; project: string | null };
type PageResult = { owner: string; page: number; totalPages: number; items: VideoChoice[] };
type Notice = { owner: string; text: string };
const PAGE_SIZE = 20;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const name = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null;

function readPage(value: unknown, owner: string, page: number): PageResult {
  if (!object(value) || !Array.isArray(value.tasks) || value.tasks.length > PAGE_SIZE || !object(value.pagination)) throw new Error('invalid_list');
  const pagination = value.pagination;
  if (pagination.page !== page || pagination.limit !== PAGE_SIZE || typeof pagination.total_pages !== 'number'
    || !Number.isSafeInteger(pagination.total_pages) || pagination.total_pages < 0) throw new Error('invalid_pagination');
  const items: VideoChoice[] = [];
  for (const row of value.tasks) {
    if (!object(row) || typeof row.id !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(row.id) || row.local_status !== 'succeeded') continue;
    const hasSource = [row.local_video_path, row.public_video_url, row.result_video_url]
      .some(source => typeof source === 'string' && source.trim().length > 0 && !source.startsWith('h3-internal-output:'));
    if (!hasSource && row.preview_available !== true) continue;
    if (items.some(item => item.id === row.id)) continue;
    items.push({ id: row.id, title: object(row.video_card) ? name(row.video_card.title) : null,
      project: object(row.project) ? name(row.project.name) : null });
  }
  return { owner, page, totalPages: pagination.total_pages, items };
}

function readableInfo(value: unknown, taskId: string) {
  if (!object(value) || !object(value.info)) return false;
  const info = value.info;
  return info.taskId === taskId && typeof info.sourceVersion === 'string' && /^[a-f0-9]{64}$/.test(info.sourceVersion)
    && typeof info.width === 'number' && info.width > 0 && typeof info.height === 'number' && info.height > 0
    && typeof info.duration === 'number' && info.duration > 0 && Array.isArray(info.timestamps) && info.timestamps.length > 0;
}

export function MultiviewSourcePicker({ open, onClose, onSelect, currentTaskId }: MultiviewSourcePickerProps) {
  const { user, hasLoadedUser, loadingUser, userLoadError, sessionChanged, refreshUser } = useAppSession();
  const external = isExternalUser(user);
  const owner = user ? [user.id, user.role, user.account_type || '', user.feature_profile_id || '', external].join(':') : '';
  const ready = Boolean(owner && hasLoadedUser && !userLoadError && !sessionChanged && !isClientSessionBlocked());
  const [pageState, setPageState] = useState({ owner: '', page: 1 });
  const page = pageState.owner === owner ? pageState.page : 1;
  const [result, setResult] = useState<PageResult | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const querySequence = useRef(0);
  const selectionSequence = useRef(0);
  const selectionRequest = useRef<AbortController | null>(null);
  const selecting = useRef(false);
  const dismissed = useRef(false);
  const live = useRef({ open, owner, ready, currentTaskId });
  live.current = { open, owner, ready, currentTaskId };
  const titleId = useId();
  const descriptionId = useId();

  const close = useCallback(() => {
    dismissed.current = true;
    querySequence.current++;
    selectionSequence.current++;
    selectionRequest.current?.abort();
    onClose();
  }, [onClose]);
  useDialogDismiss({ open, dialogRef: dialog, nativeDialog: true, initialFocusRef: closeButton, onDismiss: close });
  useEffect(() => {
    if (!open) return;
    dismissed.current = false;
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => { element?.close(); };
  }, [open]);
  useEffect(() => {
    if (open && !hasLoadedUser && !loadingUser) void refreshUser();
  }, [open, hasLoadedUser, loadingUser, refreshUser]);
  useEffect(() => {
    const sequence = ++querySequence.current;
    selectionSequence.current++;
    selectionRequest.current?.abort();
    selecting.current = false;
    setChecking(null);
    setResult(null);
    setNotice(null);
    if (!open || !ready) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    const current = () => !controller.signal.aborted && !dismissed.current && sequence === querySequence.current
      && live.current.open && live.current.ready && live.current.owner === owner && !isClientSessionBlocked();
    const endpoint = external ? '/api/ip/video/list' : '/api/video/list';
    void (async () => {
      try {
        const response = await fetch(endpoint + '?' + new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) }),
          { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
        if (!current()) return;
        if (!response.ok) {
          setNotice({ owner, text: response.status === 401 || response.status === 403
            ? '当前账号暂不能读取视频列表，请确认登录状态后重试。' : '视频列表未能读取，请重试；当前来源未改变。' });
          return;
        }
        const data = await readJsonResponse<unknown>(response, { invalidJsonMessage: '视频列表暂不可用' });
        if (current()) setResult(readPage(data, owner, page));
      } catch {
        if (current()) setNotice({ owner, text: '视频列表未能读取，请重试；当前来源未改变。' });
      } finally { if (current()) setLoading(false); }
    })();
    return () => { controller.abort(); querySequence.current++; };
  }, [open, owner, ready, external, page, reload]);
  useEffect(() => () => { selectionSequence.current++; selectionRequest.current?.abort(); }, []);

  async function choose(taskId: string) {
    if (!ready || selecting.current || dismissed.current || isClientSessionBlocked()
      || result?.owner !== owner || result.page !== page || !result.items.some(item => item.id === taskId)) return;
    const sequence = ++selectionSequence.current;
    const controller = new AbortController();
    selectionRequest.current?.abort();
    selectionRequest.current = controller;
    selecting.current = true;
    setChecking(taskId);
    setNotice(null);
    const current = () => !controller.signal.aborted && !dismissed.current && sequence === selectionSequence.current
      && live.current.open && live.current.ready && live.current.owner === owner
      && live.current.currentTaskId === currentTaskId && !isClientSessionBlocked();
    try {
      const response = await fetch('/api/video/multiview/' + encodeURIComponent(taskId), { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]) });
      if (!current()) return;
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) setResult(null);
        setNotice({ owner, text: [401, 403, 404].includes(response.status)
          ? '视频已不可用或访问权限已变化，请重新读取列表；当前来源未改变。'
          : '这段视频暂不可读取，请稍后重试或选择其他视频；当前来源未改变。' });
        return;
      }
      const data = await readJsonResponse<unknown>(response, { invalidJsonMessage: '视频暂不可读取' });
      if (!current()) return;
      if (!readableInfo(data, taskId)) throw new Error('unreadable_source');
      onSelect(taskId);
      close();
    } catch {
      if (current()) setNotice({ owner, text: '视频尚未确认可读，请重试；当前来源未改变。' });
    } finally {
      if (sequence === selectionSequence.current) {
        selecting.current = false;
        selectionRequest.current = null;
        setChecking(null);
      }
    }
  }

  if (!open || typeof document === 'undefined') return null;
  const visible = ready && result?.owner === owner && result.page === page ? result : null;
  const message = ready ? notice?.owner === owner ? notice.text : '' : hasLoadedUser
    ? '请先确认当前登录账号，再选择已有视频。' : '正在确认登录状态…';
  // A paged media selector needs room for thumbnails; the shared native modal preserves focus and return context on small screens.
  return createPortal(<dialog ref={dialog} className={styles.dialog} aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
    <header className={styles.header}>
      <div><h2 id={titleId}>使用已有视频</h2><p id={descriptionId}>每页读取20条任务，仅显示本页已完成且有视频来源的记录。</p></div>
      <button ref={closeButton} type="button" className={styles.close} aria-label="关闭视频选择" onClick={close}><X size={20} /></button>
    </header>
    <div className={styles.body} aria-busy={loading || Boolean(checking)}>
      {message && <div className={styles.notice} role="status"><span>{message}</span>{ready && <button type="button" disabled={Boolean(checking)} onClick={() => setReload(value => value + 1)}>重新读取</button>}</div>}
      {checking && <p className={styles.status} role="status">正在确认所选视频可读…</p>}
      {ready && loading && <div className={styles.skeleton} role="status" aria-label="正在读取视频列表"><span /><span /><span /></div>}
      {visible && <ul className={styles.list}>{visible.items.map(task => <li key={task.id}>
        <button type="button" className={styles.row} disabled={Boolean(checking)} aria-current={task.id === currentTaskId ? 'true' : undefined} onClick={() => void choose(task.id)}>
          <TaskVideoThumbnail taskId={task.id} thumbnailUrl={'/api/video/thumbnail/' + encodeURIComponent(task.id)} status="succeeded" className={styles.thumbnail} reactions={false} />
          <span className={styles.labels}><strong>{task.title || '已完成视频'}</strong>{task.project && <span>{task.project}</span>}</span>
          <span className={styles.action}>{checking === task.id ? '确认中…' : task.id === currentTaskId ? '当前视频' : '选择'}</span>
        </button>
      </li>)}</ul>}
      {visible && !visible.items.length && <p className={styles.empty}>本页没有可选的完成视频。{page > 1 || page < visible.totalPages ? '可翻页查看其他任务。' : ''}</p>}
    </div>
    <footer className={styles.footer}>
      <span>{visible ? '任务第' + page + (visible.totalPages >= page ? ' / ' + visible.totalPages : '') + '页，本页可选' + visible.items.length + '个视频' : '按原任务顺序分页'}</span>
      <div><button type="button" disabled={!visible || page <= 1 || loading || Boolean(checking)} onClick={() => setPageState({ owner, page: page - 1 })}>上一页</button>
        <button type="button" disabled={!visible || page >= visible.totalPages || loading || Boolean(checking)} onClick={() => setPageState({ owner, page: page + 1 })}>下一页</button></div>
    </footer>
  </dialog>, document.body);
}
