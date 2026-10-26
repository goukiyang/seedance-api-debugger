'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import PageBanner from '@/components/PageBanner';
import { useProductDialog } from '@/components/useProductDialog';
import { RelativeTime } from '@/components/RelativeTime';
import { LoadingSkeleton, LoadingStatus } from '@/components/LoadingState';
import PaginationControls from '@/components/PaginationControls';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { RotateCcw, X } from 'lucide-react';
import { usePageExitRisk } from '@/lib/hooks/page-exit-guard';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import workbenchStyles from '../integrations/workbench.module.css';

type FeedbackUser = {
  id: string;
  name: string;
  username: string;
  email: string;
  avatar_url?: string | null;
  account_type?: string | null;
};

type FeedbackItem = {
  id: string;
  user_id: string | null;
  task_id: string | null;
  content: string;
  image_urls_json: string | null;
  page_url: string | null;
  pathname: string | null;
  user_agent: string | null;
  status: string;
  admin_note: string | null;
  created_at: string;
  user: FeedbackUser | null;
};

type FeedbackPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

const FEEDBACK_PAGE_SIZE = 30;

function parseImages(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function statusLabel(status: string) {
  if (status === 'reviewed') return '已查看';
  if (status === 'archived') return '已归档';
  return '新反馈';
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function feedbackExportFilename(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `feedback_export_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}.pdf`;
}

export default function AdminFeedbackClient({ currentUser, feedbackId }: { currentUser: FeedbackUser; feedbackId?: string }) {
  const searchParams = useSearchParams();
  const { confirm, productDialog } = useProductDialog();
  const actionLock = useRef(false);
  const readSequence = useRef(0);
  const detailSequence = useRef(0);
  const detailRef = useRef<HTMLElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const savedDetail = useRef<FeedbackItem | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const runFeedbackAction = async (action: () => Promise<void>) => {
    if (actionLock.current) return;
    actionLock.current = true;
    try { await action(); }
    catch (error) { setError(error instanceof Error ? error.message : '操作未完成，请重新读取确认结果'); }
    finally { actionLock.current = false; setActionBusy(false); }
  };
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [active, setActive] = useState<FeedbackItem | null>(null);
  const [status, setStatus] = useState('');
  const [hasImage, setHasImage] = useState('');
  const [keyword, setKeyword] = useState('');
  const [pagePath, setPagePath] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [dateFrom, setDateFrom] = useState(''), [dateTo, setDateTo] = useState('');
  const ownLocation = useRef<string | null>(null), skipLocationWrite = useRef(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(FEEDBACK_PAGE_SIZE);
  const [pagination, setPagination] = useState<FeedbackPagination | null>(null);
  const [restored, setRestored] = useState(false);
  const [preview, setPreview] = useState<{ url: string; index: number; feedbackId: string } | null>(null);
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const restoreDetail = useRef<string | null>(null);
  const storageKey = `sd2:admin-feedback:v1:${currentUser.id}`;
  const dirtyDetail = Boolean(active && (note !== (savedDetail.current?.admin_note || '') || active.status !== savedDetail.current?.status));
  usePageExitRisk({ unsaved: dirtyDetail ? ['反馈备注或状态'] : [], busy: actionBusy ? ['反馈保存'] : [], revision: `${active?.id || ''}:${active?.status || ''}:${note}` });
  const removeDetailLink = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('feedbackId');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  };

  const openDetail = (item: FeedbackItem) => {
    detailSequence.current += 1;
    savedDetail.current = item;
    setNote(item.admin_note || '');
    setActive(item);
  };
  const closeDetail = async () => {
    if (actionLock.current) return;
    if (dirtyDetail
      && !await confirm('修改还没保存，放弃修改并关闭？', { title: '未保存修改', confirmLabel: '放弃修改', anchor: null })) return;
    detailSequence.current += 1;
    setActive(null);
    removeDetailLink();
  };
  useDialogDismiss({ open: Boolean(active) && !preview, dialogRef: detailRef, dismissSurfaceRef: backdropRef, onDismiss: () => { void closeDetail(); } });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (ownLocation.current === params.toString()) return;
    skipLocationWrite.current = restored;
    const explicit = ['status', 'hasImage', 'keyword', 'pagePath', 'pathname', 'owner_user_id', 'task_id', 'date_from', 'date_to', 'page', 'page_size', 'pageSize'].some(key => params.has(key));
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (!explicit && saved?.version === 1) {
        setStatus(['', 'new', 'reviewed', 'archived'].includes(saved.status) ? saved.status : '');
        setHasImage(['', 'true', 'false'].includes(saved.hasImage) ? saved.hasImage : '');
        setKeyword('');
        setPagePath(typeof saved.pagePath === 'string' ? saved.pagePath.slice(0, 200) : '');
        setOwnerUserId(typeof saved.ownerUserId === 'string' ? saved.ownerUserId.slice(0, 120) : '');
        setTaskId(typeof saved.taskId === 'string' ? saved.taskId.slice(0, 120) : '');
        setDateFrom(typeof saved.dateFrom === 'string' ? saved.dateFrom.slice(0, 40) : '');
        setDateTo(typeof saved.dateTo === 'string' ? saved.dateTo.slice(0, 40) : '');
        setPage(Number.isInteger(saved.page) && saved.page > 0 && saved.page <= 10000 ? saved.page : 1);
        setPageSize([20, 30, 50, 100].includes(saved.pageSize) ? saved.pageSize : FEEDBACK_PAGE_SIZE);
        setTechnicalOpen(saved.technicalOpen === true);
        restoreDetail.current = typeof saved.activeId === 'string' ? saved.activeId : null;
      }
    } catch { /* Storage is optional; retain usable defaults. */ }
    if (explicit) {
      setStatus(params.get('status') || ''); setHasImage(params.get('hasImage') || '');
      setKeyword(params.get('keyword') || ''); setPagePath(params.get('pagePath') || params.get('pathname') || '');
      setOwnerUserId(params.get('owner_user_id') || ''); setTaskId(params.get('task_id') || '');
      setDateFrom(params.get('date_from') || ''); setDateTo(params.get('date_to') || '');
      const next = Number(params.get('page') || 1); setPage(next);
      const size = Number(params.get('page_size') || params.get('pageSize') || FEEDBACK_PAGE_SIZE); setPageSize(size);
      restoreDetail.current = null;
    }
    setRestored(true);
  }, [storageKey, searchParams]);

  useEffect(() => {
    if (!restored) return;
    if (!['', 'new', 'reviewed', 'archived'].includes(status) || !['', 'true', 'false'].includes(hasImage)
      || !Number.isSafeInteger(page) || page < 1 || page > 10000 || ![20, 30, 50, 100].includes(pageSize)
      || [ownerUserId, taskId].some(value => value.length > 120)
      || [dateFrom, dateTo].some(value => value && !Number.isFinite(Date.parse(value)))) return;
    try { localStorage.setItem(storageKey, JSON.stringify({ version: 1, status, hasImage, pagePath, ownerUserId, taskId, dateFrom, dateTo, page, pageSize, activeId: active?.id || null, technicalOpen })); }
    catch { /* Browsing still works when persistence is unavailable. */ }
  }, [restored, storageKey, status, hasImage, pagePath, ownerUserId, taskId, dateFrom, dateTo, page, pageSize, active?.id, technicalOpen]);

  useEffect(() => {
    if (!restored) return;
    if (skipLocationWrite.current) { skipLocationWrite.current = false; return; }
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ status, hasImage, keyword, pagePath, owner_user_id: ownerUserId, task_id: taskId, date_from: dateFrom, date_to: dateTo })) if (value) params.set(key, value);
    params.set('page', String(page));
    params.set('page_size', String(pageSize));
    const id = new URLSearchParams(window.location.search).get('feedbackId'); if (id) params.set('feedbackId', id);
    ownLocation.current = params.toString();
    if (window.location.search.slice(1) !== ownLocation.current) window.history.replaceState(window.history.state, '', `/admin/feedback?${params}`);
  }, [restored, status, hasImage, keyword, pagePath, ownerUserId, taskId, dateFrom, dateTo, page, pageSize, searchParams]);

  useEffect(() => {
    if (!restored) return;
    const id = feedbackId || restoreDetail.current;
    restoreDetail.current = null;
    if (!id) return;
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) { setError('反馈链接不完整，请在列表查找'); return; }
    const sequence = ++detailSequence.current;
    const controller = new AbortController();
    void fetch(`/api/admin/feedback/${encodeURIComponent(id)}`, { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const data = await response.json();
        if (sequence !== detailSequence.current) return;
        if (!response.ok) throw new Error(data.error || '反馈读取失败，请重试');
        if (!actionLock.current) openDetail(data.feedback);
      }).catch(cause => {
        if (!controller.signal.aborted && sequence === detailSequence.current) setError(cause instanceof Error ? cause.message : '反馈读取失败，请重试');
      });
    return () => { controller.abort(); };
  }, [restored, feedbackId]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const load = async (pageNumber = page) => {
    const sequence = ++readSequence.current;
    setLoading(true);
    setError('');
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (hasImage) params.set('hasImage', hasImage);
    if (keyword) params.set('keyword', keyword);
    if (pagePath) params.set('pagePath', pagePath);
    if (ownerUserId) params.set('owner_user_id', ownerUserId);
    if (taskId) params.set('task_id', taskId);
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    params.set('page', String(pageNumber));
    params.set('page_size', String(pageSize));

    try {
      const response = await fetch(`/api/admin/feedback?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json();
      if (sequence !== readSequence.current) return;
      if (!response.ok) throw new Error(data.error || '加载反馈失败');
      setItems(data.items || []);
      const total = Number(data.total || 0);
      const pageSize = Number(data.pageSize || FEEDBACK_PAGE_SIZE);
      setPagination({
        page: Number(data.page || pageNumber),
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      });
      setSelectedIds((current) => current.filter((id) => (data.items || []).some((item: FeedbackItem) => item.id === id)));
    } catch (err) {
      if (sequence === readSequence.current) setError(err instanceof Error ? err.message : '加载反馈失败');
    } finally {
      if (sequence === readSequence.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!restored) return;
    void load(page);
    return () => { readSequence.current += 1; };
  }, [status, hasImage, keyword, pagePath, ownerUserId, taskId, dateFrom, dateTo, page, pageSize, restored]);

  const toggleAll = () => {
    if (selectedIds.length === items.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(items.map((item) => item.id));
    }
  };

  const archive = async (ids: string[]) => {
    if (!ids.length) {
      setError('请选择反馈');
      return;
    }
    if (!await confirm(`确认归档 ${ids.length} 条反馈？`, { title: '归档反馈', confirmLabel: '归档' })) return;
    setActionBusy(true);
    setError('');
    setMessage('');
    const response = await fetch('/api/admin/feedback/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || '归档失败');
      return;
    }
    setMessage('已归档');
    setActive(null);
    removeDetailLink();
    await load(page);
  };

  const saveDetail = async () => {
    if (!active) return;
    setActionBusy(true);
    setError('');
    const response = await fetch(`/api/admin/feedback/${active.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: active.status, adminNote: note }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || '保存失败');
      return;
    }
    setMessage('已保存');
    savedDetail.current = data.feedback;
    setActive(null);
    removeDetailLink();
    await load(page);
  };

  const exportSingle = async (id: string) => {
    const response = await fetch(`/api/admin/feedback/${id}/pdf`);
    if (!response.ok) {
      setError('PDF 下载失败');
      return;
    }
    downloadBlob(await response.blob(), `feedback-${id}.pdf`);
  };

  const exportBatch = async () => {
    if (!selectedIds.length) {
      setError('请先选择要导出的反馈');
      return;
    }
    const response = await fetch('/api/admin/feedback/export-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedbackIds: selectedIds }),
    });
    if (!response.ok) {
      setError('导出 PDF 失败');
      return;
    }
    downloadBlob(await response.blob(), feedbackExportFilename());
  };

  return (
    <main className={`admin-users-page ${workbenchStyles.surface}`} style={{ color: 'var(--text-primary)', minWidth: 0 }}>
      {productDialog}
      {actionBusy && <LoadingStatus>正在保存反馈操作</LoadingStatus>}
      <PageBanner
        eyebrow="管理员后台"
        title="反馈管理"
        description="查看、归档、备注和导出用户提交的反馈材料。"
        actions={<UserIdentityBadge user={currentUser} size="sm" showEmail />}
      />

      {(message || error) && (
        <div style={{
          marginBottom: 14,
          padding: '10px 12px',
          borderRadius: 8,
          color: 'var(--text-secondary)',
          background: error ? 'var(--bg-input)' : 'var(--tone-success-bg)',
          border: '1px solid var(--border-color)',
        }}>
          {error || message}
        </div>
      )}

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 160px), 1fr))', gap: 10, alignItems: 'center', marginBottom: 14 }}>
        <select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} style={controlStyle}>
          <option value="">全部状态</option>
          <option value="new">新反馈</option>
          <option value="reviewed">已查看</option>
          <option value="archived">已归档</option>
        </select>
        <select value={hasImage} onChange={(event) => { setHasImage(event.target.value); setPage(1); }} style={controlStyle}>
          <option value="">全部图片</option>
          <option value="true">有图片</option>
          <option value="false">无图片</option>
        </select>
        <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索内容、用户、任务" style={controlStyle} />
        <input value={pagePath} onChange={(event) => setPagePath(event.target.value)} placeholder="页面路径" style={controlStyle} />
        <select style={controlStyle} aria-label="每页反馈数量" value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1); }}>{[20, 30, 50, 100].map(size => <option key={size} value={size}>每页 {size} 条</option>)}</select>
        <details style={{ gridColumn: '1 / -1' }}><summary>用户、任务与日期</summary><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 160px), 1fr))', gap: 10 }}>
        <input value={ownerUserId} onChange={event => { setOwnerUserId(event.target.value); setPage(1); }} placeholder="用户 ID" aria-label="反馈用户编号" style={controlStyle} />
        <input value={taskId} onChange={event => { setTaskId(event.target.value); setPage(1); }} placeholder="关联任务 ID" aria-label="关联任务编号" style={controlStyle} />
        <input type="date" value={dateFrom} onChange={event => { setDateFrom(event.target.value); setPage(1); }} aria-label="反馈开始日期" style={controlStyle} />
        <input type="date" value={dateTo} onChange={event => { setDateTo(event.target.value); setPage(1); }} aria-label="反馈结束日期" style={controlStyle} />
        </div></details>
        <button
          type="button"
          onClick={() => {
            setPage(1);
            void load(1);
          }}
          style={primaryButtonStyle}
        >
          筛选
        </button>
        <button type="button" title="重置筛选与上次位置" aria-label="重置筛选与上次位置" style={miniButtonStyle} onClick={() => {
          if (active || actionLock.current) return;
          setStatus(''); setHasImage(''); setKeyword(''); setPagePath(''); setOwnerUserId(''); setTaskId(''); setDateFrom(''); setDateTo(''); setPage(1); setPageSize(FEEDBACK_PAGE_SIZE);
          try { localStorage.removeItem(storageKey); } catch { /* Optional storage. */ }
          window.location.assign('/admin/feedback');
        }}><RotateCcw size={16} /></button>
      </section>

      <section style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <button type="button" disabled={actionBusy} onClick={() => void runFeedbackAction(() => archive(selectedIds))} style={secondaryButtonStyle}>批量归档</button>
        <button
          type="button"
          onClick={exportBatch}
          disabled={!selectedIds.length}
          title={selectedIds.length ? '将勾选反馈合并导出为一个 PDF' : '请先选择要导出的反馈'}
          style={{
            ...secondaryButtonStyle,
            opacity: selectedIds.length ? 1 : 0.45,
            cursor: selectedIds.length ? 'pointer' : 'not-allowed',
          }}
        >
          导出 PDF
        </button>
        <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>已选择 {selectedIds.length} 条</span>
      </section>

      <div style={{ border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead style={{ background: 'var(--bg-input)', color: 'var(--text-secondary)' }}>
              <tr>
                <th style={thStyle}><input type="checkbox" checked={items.length > 0 && selectedIds.length === items.length} onChange={toggleAll} /></th>
                <th style={thStyle}>状态</th>
                <th style={thStyle}>内容</th>
                <th style={thStyle}>图片</th>
                <th style={thStyle}>提交人</th>
                <th style={thStyle}>页面</th>
                <th style={thStyle}>关联任务</th>
                <th style={thStyle}>提交时间</th>
                <th style={thStyle}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const images = parseImages(item.image_urls_json);
                return (
                  <tr key={item.id} style={{ borderTop: '1px solid var(--border-color)' }}>
                    <td style={tdStyle}>
                      <input
                        type="checkbox"
                        checked={selectedSet.has(item.id)}
                        onChange={(event) => {
                          setSelectedIds((current) => event.target.checked
                            ? [...current, item.id]
                            : current.filter((id) => id !== item.id));
                        }}
                      />
                    </td>
                    <td style={tdStyle}>{statusLabel(item.status)}</td>
                    <td style={{ ...tdStyle, maxWidth: 280 }}>{item.content.slice(0, 80)}{item.content.length > 80 ? '...' : ''}</td>
                    <td style={tdStyle}>{images.length}</td>
                    <td style={tdStyle}>
                      <UserIdentityBadge user={item.user} size="sm" showEmail />
                    </td>
                    <td style={tdStyle}>{item.pathname || item.page_url || '-'}</td>
                    <td style={tdStyle}>{item.task_id || '-'}</td>
                    <td style={tdStyle}><RelativeTime value={item.created_at} /></td>
                    <td style={tdStyle}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button type="button" onClick={() => openDetail(item)} style={miniButtonStyle}>详情</button>
                        <button type="button" disabled={actionBusy} onClick={() => void runFeedbackAction(() => archive([item.id]))} style={miniButtonStyle}>归档</button>
                        <button type="button" onClick={() => exportSingle(item.id)} style={miniButtonStyle}>PDF</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!loading && !error && items.length === 0 && (
                <tr><td colSpan={9} style={{ ...tdStyle, textAlign: 'center', color: 'var(--text-secondary)' }}>暂无反馈</td></tr>
              )}
              {loading && (
                <tr><td colSpan={9} style={tdStyle}>{items.length ? <LoadingStatus>正在更新反馈</LoadingStatus> : <LoadingSkeleton label="正在读取反馈" />}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ padding: '0 16px 16px' }}>
          {pagination && (
            <PaginationControls
              page={pagination.page}
              totalPages={pagination.totalPages}
              total={pagination.total}
              pageSize={pagination.pageSize}
              label="反馈"
              onPageChange={(nextPage) => {
                setPage(nextPage);
                void load(nextPage);
              }}
            />
          )}
        </div>
      </div>

      {active && (
        <div ref={backdropRef} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, visibility: preview ? 'hidden' : 'visible' }}>
          <section ref={detailRef} role="dialog" aria-modal="true" aria-labelledby="feedback-detail-title" style={{ width: 760, maxWidth: '100%', maxHeight: '88vh', overflowY: 'auto', borderRadius: 8, background: 'var(--bg-panel)', border: '1px solid var(--border-color)', padding: 20 }}>
            <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h2 id="feedback-detail-title" style={{ margin: 0, fontSize: 20 }}>反馈详情</h2>
              <button type="button" disabled={actionBusy} onClick={() => void closeDetail()} aria-label="关闭" title="关闭" style={miniButtonStyle}><X size={16} /></button>
            </header>
            {error && <p role="alert" style={{ color: 'var(--text-secondary)', margin: '0 0 14px', overflowWrap: 'anywhere' }}>{error}</p>}
            <p style={{ margin: '0 0 16px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 15, lineHeight: 1.65 }}>{active.content}</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', alignItems: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>
              <UserIdentityBadge user={active.user} size="sm" />
              <span style={{ overflowWrap: 'anywhere' }}>{active.pathname || '未提供页面'}</span>
              <RelativeTime value={active.created_at} />
            </div>
            {parseImages(active.image_urls_json).length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: 10, marginTop: 16 }}>
                {parseImages(active.image_urls_json).map((url, index) => (
                  <button key={`${url}-${index}`} type="button" title={`查看截图 ${index + 1}`} aria-label={`查看截图 ${index + 1}`}
                    onClick={() => setPreview({ url, index, feedbackId: active.id })}
                    style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: 0, overflow: 'hidden', cursor: 'zoom-in', background: 'var(--bg-input)' }}>
                    <img src={url} alt={`反馈截图 ${index + 1}`} style={{ display: 'block', width: '100%', aspectRatio: '4 / 3', objectFit: 'contain' }} />
                  </button>
                ))}
              </div>
            )}
            <div style={{ borderTop: '1px solid var(--border-color)', marginTop: 20, paddingTop: 16 }}>
              <label style={{ display: 'block', marginBottom: 8, color: 'var(--text-secondary)', fontSize: 13 }}>状态
                <select disabled={actionBusy} value={active.status} onChange={(event) => setActive({ ...active, status: event.target.value })} style={controlStyle}>
                  <option value="new">新反馈</option>
                  <option value="reviewed">已查看</option>
                  <option value="archived">已归档</option>
                </select>
              </label>
              <label style={{ display: 'block', marginTop: 12, color: 'var(--text-secondary)', fontSize: 13 }}>内部备注
                <textarea disabled={actionBusy} value={note} onChange={(event) => setNote(event.target.value)} rows={4} style={{ ...controlStyle, resize: 'vertical' }} />
              </label>
            </div>
            <details open={technicalOpen} onToggle={event => setTechnicalOpen(event.currentTarget.open)} style={{ marginTop: 16, fontSize: 13 }}>
              <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)', padding: '8px 0' }}>技术信息 / 导出</summary>
              <dl style={{ margin: '8px 0', display: 'grid', gridTemplateColumns: '80px minmax(0, 1fr)', gap: '10px 12px', fontSize: 12 }}>
                <dt style={dtStyle}>反馈编号</dt><dd style={ddStyle}>{active.id}</dd>
                <dt style={dtStyle}>提交人</dt><dd style={ddStyle}><UserIdentityBadge user={active.user} size="sm" showEmail /></dd>
                <dt style={dtStyle}>页面 URL</dt><dd style={ddStyle}>{active.page_url || '-'}</dd>
                <dt style={dtStyle}>UserAgent</dt><dd style={ddStyle}>{active.user_agent || '-'}</dd>
                <dt style={dtStyle}>任务 ID</dt><dd style={ddStyle}>{active.task_id || '-'}</dd>
              </dl>
              <button type="button" onClick={() => exportSingle(active.id)} style={secondaryButtonStyle}>下载 PDF</button>
            </details>
            <footer style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, marginTop: 18, position: 'sticky', bottom: -20, padding: '12px 0', background: 'var(--bg-panel)' }}>
              <button type="button" disabled={actionBusy} onClick={() => void runFeedbackAction(() => archive([active.id]))} style={secondaryButtonStyle}>归档</button>
              <button type="button" disabled={actionBusy} className="sd2-loading-surface" data-busy={actionBusy} onClick={() => void runFeedbackAction(saveDetail)} style={primaryButtonStyle}>保存</button>
            </footer>
          </section>
        </div>
      )}
      {preview && active && <ZoomableImagePreview src={preview.url} alt={`反馈截图 ${preview.index + 1}`} title="反馈截图"
        previewKey={`feedback:${currentUser.id}:${preview.feedbackId}:${preview.index}`} onClose={() => setPreview(null)} />}
    </main>
  );
}

const controlStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '10px 12px',
  border: '1px solid var(--border-color)',
  borderRadius: 8,
  background: 'var(--bg-input)',
  color: 'var(--text-primary)',
  fontSize: 13,
};

const primaryButtonStyle: React.CSSProperties = {
  border: 'none',
  borderRadius: 8,
  padding: '10px 14px',
  background: '#2563eb',
  color: 'white',
  fontWeight: 700,
  cursor: 'pointer',
};

const secondaryButtonStyle: React.CSSProperties = {
  border: '1px solid var(--border-color)',
  borderRadius: 8,
  padding: '10px 14px',
  background: 'var(--bg-input)',
  color: 'var(--text-primary)',
  cursor: 'pointer',
};

const miniButtonStyle: React.CSSProperties = {
  border: '1px solid var(--border-color)',
  borderRadius: 8,
  padding: '6px 9px',
  background: 'var(--bg-input)',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const thStyle: React.CSSProperties = { textAlign: 'left', padding: 12, whiteSpace: 'nowrap' };
const tdStyle: React.CSSProperties = { padding: 12, verticalAlign: 'top', color: 'var(--text-primary)' };
const dtStyle: React.CSSProperties = { color: 'var(--text-secondary)' };
const ddStyle: React.CSSProperties = { margin: 0, color: 'var(--text-primary)', wordBreak: 'break-word' };
