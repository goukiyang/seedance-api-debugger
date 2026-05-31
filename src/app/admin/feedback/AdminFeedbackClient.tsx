'use client';

import { useEffect, useMemo, useState } from 'react';
import PageBanner from '@/components/PageBanner';
import PaginationControls from '@/components/PaginationControls';

type FeedbackUser = {
  id: string;
  name: string;
  username: string;
  email: string;
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

const FEEDBACK_PAGE_SIZE = 50;

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

function submitter(item: FeedbackItem) {
  return item.user ? `${item.user.name} / ${item.user.username}` : '未登录用户';
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

export default function AdminFeedbackClient({ currentUserName }: { currentUserName: string }) {
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [active, setActive] = useState<FeedbackItem | null>(null);
  const [status, setStatus] = useState('');
  const [hasImage, setHasImage] = useState('');
  const [keyword, setKeyword] = useState('');
  const [pagePath, setPagePath] = useState('');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<FeedbackPagination | null>(null);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const load = async (pageNumber = page) => {
    setLoading(true);
    setError('');
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (hasImage) params.set('hasImage', hasImage);
    if (keyword) params.set('keyword', keyword);
    if (pagePath) params.set('pagePath', pagePath);
    params.set('page', String(pageNumber));
    params.set('pageSize', String(FEEDBACK_PAGE_SIZE));

    try {
      const response = await fetch(`/api/admin/feedback?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json();
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
      setError(err instanceof Error ? err.message : '加载反馈失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(page);
  }, [status, hasImage]);

  useEffect(() => {
    setNote(active?.admin_note || '');
  }, [active]);

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
    if (!window.confirm(`确认归档 ${ids.length} 条反馈？`)) return;
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
    await load(page);
  };

  const saveDetail = async () => {
    if (!active) return;
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
    setActive(data.feedback);
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
    <main className="admin-users-page" style={{ minHeight: '100vh', background: '#101116', color: '#fff', padding: 24 }}>
      <PageBanner
        tone="dark"
        eyebrow="管理员后台"
        title="反馈管理"
        description="查看、归档、备注和导出用户提交的反馈材料。"
        actions={<div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13 }}>{currentUserName}</div>}
      />

      {(message || error) && (
        <div style={{
          marginBottom: 14,
          padding: '10px 12px',
          borderRadius: 8,
          color: error ? '#ff9b9b' : '#86efac',
          background: error ? 'rgba(255,80,80,0.10)' : 'rgba(80,255,140,0.10)',
          border: error ? '1px solid rgba(255,80,80,0.25)' : '1px solid rgba(80,255,140,0.25)',
        }}>
          {error || message}
        </div>
      )}

      <section style={{ display: 'grid', gridTemplateColumns: '160px 160px 1fr 1fr auto', gap: 10, alignItems: 'center', marginBottom: 14 }}>
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
      </section>

      <section style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <button type="button" onClick={() => archive(selectedIds)} style={secondaryButtonStyle}>批量归档</button>
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
        <span style={{ color: 'rgba(255,255,255,0.55)', fontSize: 13 }}>已选择 {selectedIds.length} 条</span>
      </section>

      <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.58)' }}>
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
                  <tr key={item.id} style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
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
                    <td style={tdStyle}>{submitter(item)}</td>
                    <td style={tdStyle}>{item.pathname || item.page_url || '-'}</td>
                    <td style={tdStyle}>{item.task_id || '-'}</td>
                    <td style={tdStyle}>{new Date(item.created_at).toLocaleString('zh-CN')}</td>
                    <td style={tdStyle}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button type="button" onClick={() => setActive(item)} style={miniButtonStyle}>详情</button>
                        <button type="button" onClick={() => archive([item.id])} style={miniButtonStyle}>归档</button>
                        <button type="button" onClick={() => exportSingle(item.id)} style={miniButtonStyle}>PDF</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!loading && items.length === 0 && (
                <tr><td colSpan={9} style={{ ...tdStyle, textAlign: 'center', color: 'rgba(255,255,255,0.55)' }}>暂无反馈</td></tr>
              )}
              {loading && (
                <tr><td colSpan={9} style={{ ...tdStyle, textAlign: 'center', color: 'rgba(255,255,255,0.55)' }}>加载中</td></tr>
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
        <div style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <section style={{ width: 760, maxWidth: '100%', maxHeight: '88vh', overflowY: 'auto', borderRadius: 8, background: '#151821', border: '1px solid rgba(255,255,255,0.1)', padding: 20 }}>
            <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h2 style={{ margin: 0, fontSize: 20 }}>反馈详情</h2>
              <button type="button" onClick={() => setActive(null)} style={miniButtonStyle}>关闭</button>
            </header>
            <dl style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '10px 14px', margin: 0, fontSize: 13 }}>
              <dt style={dtStyle}>完整内容</dt><dd style={ddStyle}>{active.content}</dd>
              <dt style={dtStyle}>提交人</dt><dd style={ddStyle}>{submitter(active)}</dd>
              <dt style={dtStyle}>页面 URL</dt><dd style={ddStyle}>{active.page_url || '-'}</dd>
              <dt style={dtStyle}>UserAgent</dt><dd style={ddStyle}>{active.user_agent || '-'}</dd>
              <dt style={dtStyle}>任务 ID</dt><dd style={ddStyle}>{active.task_id || '-'}</dd>
              <dt style={dtStyle}>状态</dt>
              <dd style={ddStyle}>
                <select value={active.status} onChange={(event) => setActive({ ...active, status: event.target.value })} style={controlStyle}>
                  <option value="new">新反馈</option>
                  <option value="reviewed">已查看</option>
                  <option value="archived">已归档</option>
                </select>
              </dd>
              <dt style={dtStyle}>提交时间</dt><dd style={ddStyle}>{new Date(active.created_at).toLocaleString('zh-CN')}</dd>
              <dt style={dtStyle}>管理员备注</dt>
              <dd style={ddStyle}>
                <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={4} style={{ ...controlStyle, resize: 'vertical' }} />
              </dd>
            </dl>

            {parseImages(active.image_urls_json).length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginTop: 16 }}>
                {parseImages(active.image_urls_json).map((url) => (
                  <a key={url} href={url} target="_blank" rel="noreferrer">
                    <img src={url} alt="反馈图片" style={{ width: '100%', aspectRatio: '4 / 3', objectFit: 'cover', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)' }} />
                  </a>
                ))}
              </div>
            )}

            <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button type="button" onClick={() => archive([active.id])} style={secondaryButtonStyle}>归档</button>
              <button type="button" onClick={() => exportSingle(active.id)} style={secondaryButtonStyle}>下载 PDF</button>
              <button type="button" onClick={saveDetail} style={primaryButtonStyle}>保存</button>
            </footer>
          </section>
        </div>
      )}
    </main>
  );
}

const controlStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '10px 12px',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 8,
  background: '#181b22',
  color: '#fff',
  fontSize: 13,
};

const primaryButtonStyle: React.CSSProperties = {
  border: 'none',
  borderRadius: 8,
  padding: '10px 14px',
  background: '#4f46e5',
  color: '#fff',
  fontWeight: 700,
  cursor: 'pointer',
};

const secondaryButtonStyle: React.CSSProperties = {
  border: '1px solid rgba(255,255,255,0.14)',
  borderRadius: 8,
  padding: '10px 14px',
  background: 'rgba(255,255,255,0.06)',
  color: '#fff',
  cursor: 'pointer',
};

const miniButtonStyle: React.CSSProperties = {
  border: '1px solid rgba(255,255,255,0.14)',
  borderRadius: 8,
  padding: '6px 9px',
  background: 'rgba(255,255,255,0.06)',
  color: '#fff',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const thStyle: React.CSSProperties = { textAlign: 'left', padding: 12, whiteSpace: 'nowrap' };
const tdStyle: React.CSSProperties = { padding: 12, verticalAlign: 'top', color: 'rgba(255,255,255,0.82)' };
const dtStyle: React.CSSProperties = { color: 'rgba(255,255,255,0.52)' };
const ddStyle: React.CSSProperties = { margin: 0, color: 'rgba(255,255,255,0.88)', wordBreak: 'break-word' };
