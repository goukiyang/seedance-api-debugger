'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import PageBanner from '@/components/PageBanner';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_LABELS, type ImageStudioModel } from '@/lib/image-studio/model-catalog';
import { RelativeTime } from '@/components/RelativeTime';
import PaginationControls from '@/components/PaginationControls';
import { imageBillingLabel, type ImageBillingView } from '@/lib/image-studio/billing-contract';
import workbenchStyles from '../integrations/workbench.module.css';

type AuditTask = {
  id: string;
  ownerId: string;
  owner: { id: string; name: string | null; username: string; email: string; avatar_url: string | null } | null;
  model: string;
  status: string;
  prompt: string;
  unitCredits: number;
  providerCostUsd: number | null;
  createdAt: string;
  deletedAt: string | null;
  billing: ImageBillingView | null;
  costStatus: 'pending' | 'conflict' | 'confirmed' | 'unconnected';
  asset: { original_url: string; width: number | null; height: number | null } | null;
};

export default function AdminImageStudioClient({ accountId }: { accountId: string }) {
  const router = useRouter(), searchParams = useSearchParams();
  const query = searchParams.toString();
  const sequence = useRef(0);
  const [restored, setRestored] = useState(false);
  const [tasks, setTasks] = useState<AuditTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pagination, setPagination] = useState<{ page: number; pageSize: number; total: number; totalPages: number } | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  const load = useCallback(async () => {
    const seq = ++sequence.current;
    setLoading(true); setError('');
    try {
      const response = await fetch(`/api/admin/image-studio/tasks?${query}`, { cache: 'no-store' });
      const value = await response.json();
      if (seq !== sequence.current) return;
      if (!response.ok) throw new Error(value.error || '读取失败');
      const safe = new URLSearchParams(), params = new URLSearchParams(query);
      for (const key of ['status', 'cost_status', 'result_status', 'model', 'owner_user_id', 'ownerId', 'task_id', 'moduleId', 'date_from', 'date_to', 'page', 'page_size']) {
        const item = params.get(key); if (item && item.length <= 120) safe.set(key, item);
      }
      try { localStorage.setItem(`sd2-admin-image-audit-v1:${accountId}`, JSON.stringify(safe.toString())); } catch { /* Persist only successfully read filters. */ }
      setTasks(value.tasks); setPagination(value.pagination);
    } catch (cause) { if (seq === sequence.current) setError(cause instanceof Error ? cause.message : '图片任务读取失败'); }
    finally { if (seq === sequence.current) setLoading(false); }
  }, [accountId, query]);

  useEffect(() => {
    if (!window.location.search) {
      try {
        const saved: unknown = JSON.parse(localStorage.getItem(`sd2-admin-image-audit-v1:${accountId}`) || 'null');
        if (typeof saved === 'string' && saved.length < 2000 && saved) router.replace(`/admin/image-studio?${saved}`, { scroll: false });
      } catch { /* Browsing remains available without storage. */ }
    }
    setRestored(true);
  }, [accountId, router]);
  useEffect(() => {
    if (!restored) return;
    void load(); return () => { sequence.current++; };
  }, [accountId, load, query, restored]);
  function filter(key: string, value: string) {
    const params = new URLSearchParams(query); params.delete('cursor'); params.delete('page');
    if (key === 'owner_user_id') params.delete('ownerId');
    if (value) params.set(key, value); else params.delete(key);
    if (key === 'result_status' && value) params.set('status', 'succeeded');
    if (key === 'status' && value !== 'succeeded') params.delete('result_status');
    router.replace(`/admin/image-studio?${params}`, { scroll: false });
  }

  async function download(id: string) {
    setDownloading(id); setError('');
    try {
      const response = await fetch(`/api/admin/image-studio/download?id=${encodeURIComponent(id)}`);
      if (!response.ok) { const value = await response.json().catch(() => ({})); throw new Error(value.error || '下载失败'); }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `image-studio-${id.slice(0, 10)}.png`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '下载失败，请重试'); }
    finally { setDownloading(null); }
  }

  return <div className={`admin-integrations-page ${workbenchStyles.surface}`}>
    <PageBanner eyebrow="管理后台" title="图片任务审计" description="查看所有用户的图片任务、归属、状态和生成结果；普通用户只能看到自己的任务和资产。" />
    {error && <div className="outputs-message" data-tone="error"><p>{error}</p><button className="btn btn-secondary" type="button" onClick={() => void load()}>重试</button></div>}
    <section className="card">
      <div className="outputs-workbench-head"><div><h2>任务列表</h2><p>管理员审计范围包含已隐藏结果，下载仍需通过管理员专用接口。</p></div><button className="btn btn-secondary" type="button" onClick={() => void load()}>刷新</button></div>
      <div className="outputs-filter-row" style={{ flexWrap: 'wrap', marginBottom: 16 }}>
        <select className="input" aria-label="图片执行状态" value={searchParams.get('status') || ''} onChange={event => filter('status', event.target.value)}>
          <option value="">全部执行状态</option><option value="queued">等待生成</option><option value="running">生成中</option><option value="succeeded">已生成</option><option value="failed">生成失败</option><option value="uncertain">结果未确认</option>
        </select>
        <select className="input" aria-label="图片费用状态" value={searchParams.get('cost_status') || ''} onChange={event => filter('cost_status', event.target.value)}>
          <option value="">全部费用状态</option><option value="pending">供应商费用待核</option><option value="conflict">费用冲突</option><option value="confirmed">已有确认费用记录</option><option value="unconnected">供应商费用未接入</option>
        </select>
        <select className="input" aria-label="图片结果文件" value={searchParams.get('result_status') || ''} onChange={event => filter('result_status', event.target.value)}>
          <option value="">全部结果文件</option><option value="not_ready">已生成，结果文件未就绪</option><option value="ready">结果文件已登记</option>
        </select>
        <input className="input" aria-label="用户编号" placeholder="用户 ID" value={searchParams.get('owner_user_id') || searchParams.get('ownerId') || ''} onChange={event => filter('owner_user_id', event.target.value)} />
        <input className="input" aria-label="原图片任务编号" placeholder="原任务 ID" maxLength={120} value={searchParams.get('task_id') || ''} onChange={event => filter('task_id', event.target.value)} />
        <select className="input" aria-label="每页图片任务数量" value={searchParams.get('page_size') || '30'} onChange={event => filter('page_size', event.target.value)}>{[20, 30, 50, 100].map(size => <option key={size} value={size}>每页 {size} 条</option>)}</select>
        <details style={{ flexBasis: '100%' }} open={Boolean(searchParams.get('model') || searchParams.get('moduleId') || searchParams.get('date_from') || searchParams.get('date_to'))}><summary>型号、模块与日期</summary>
          <div className="outputs-filter-row">
            <select className="input" aria-label="图片型号" value={searchParams.get('model') || ''} onChange={event => filter('model', event.target.value)}><option value="">全部型号</option>{IMAGE_STUDIO_MODELS.map(model => <option key={model} value={model}>{IMAGE_STUDIO_MODEL_LABELS[model]}</option>)}</select>
            <input className="input" aria-label="图片模块编号" placeholder="模块 ID" value={searchParams.get('moduleId') || ''} onChange={event => filter('moduleId', event.target.value)} />
            <input className="input" type="date" aria-label="图片开始日期" value={searchParams.get('date_from') || ''} onChange={event => filter('date_from', event.target.value)} />
            <input className="input" type="date" aria-label="图片结束日期" value={searchParams.get('date_to') || ''} onChange={event => filter('date_to', event.target.value)} />
          </div>
        </details>
        <button className="btn btn-secondary" type="button" onClick={() => { try { localStorage.removeItem(`sd2-admin-image-audit-v1:${accountId}`); } catch {} router.replace('/admin/image-studio?page=1', { scroll: false }); }}>重置筛选</button>
      </div>
      {loading && <p role="status">{tasks.length ? '正在更新，以下仍是上次读取内容' : '正在读取…'}</p>}
      {!loading && !tasks.length && !error && <p>暂无图片任务。</p>}
      {tasks.length > 0 && <div style={{ overflowX: 'auto' }}><table className="table"><thead><tr><th>预览</th><th>时间</th><th>用户</th><th>模型</th><th>执行状态</th><th>费用状态</th><th>画面描述</th><th>结果</th><th /></tr></thead><tbody>{tasks.map(task => <tr key={task.id}>
        <td><div style={{ width: 96, height: 64, display: 'grid', placeItems: 'center' }}>{task.asset ?
          // eslint-disable-next-line @next/next/no-img-element
          <img src={task.asset.original_url} alt="生成图片" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : <span>暂无预览</span>}</div></td>
        <td><RelativeTime value={task.createdAt} /></td>
        <td><UserIdentityBadge user={task.owner || { id: task.ownerId }} size="sm" /></td>
        <td>{IMAGE_STUDIO_MODEL_LABELS[task.model as ImageStudioModel] || task.model}</td><td>{({ queued: '等待生成', running: '生成中', succeeded: '已生成', failed: '生成失败', uncertain: '结果未确认' } as Record<string, string>)[task.status] || task.status}{task.deletedAt && <span className="text-gray"> · 用户已隐藏</span>}</td><td>{({ pending: '供应商费用待核', conflict: '费用记录冲突', confirmed: '已有确认费用记录', unconnected: '供应商费用未接入' })[task.costStatus]}<div className="text-gray text-sm">{task.billing ? imageBillingLabel(task.billing) : '站内结算未记录'}</div></td><td>{task.prompt || '参考图生成'}</td>
        <td>{task.asset ? <a href={task.asset.original_url} target="_blank" rel="noreferrer">查看图片</a> : '-'}</td>
        <td>{task.asset && <button className="btn btn-secondary" type="button" disabled={downloading !== null} onClick={() => void download(task.id)}>{downloading === task.id ? '准备下载' : '下载'}</button>}</td>
      </tr>)}</tbody></table></div>}
      {pagination && <PaginationControls {...pagination} label="图片任务" onPageChange={page => { const params = new URLSearchParams(query); params.set('page', String(page)); params.delete('cursor'); router.replace(`/admin/image-studio?${params}`, { scroll: false }); }} />}
    </section>
  </div>;
}
