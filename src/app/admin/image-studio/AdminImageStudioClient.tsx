'use client';

import { useCallback, useEffect, useState } from 'react';
import PageBanner from '@/components/PageBanner';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { IMAGE_STUDIO_MODEL_LABELS, type ImageStudioModel } from '@/lib/image-studio/model-catalog';

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
  asset: { original_url: string; width: number | null; height: number | null } | null;
};

export default function AdminImageStudioClient() {
  const [tasks, setTasks] = useState<AuditTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  const load = useCallback(async (next?: string) => {
    setLoading(true); setError('');
    try {
      const response = await fetch(`/api/admin/image-studio/tasks${next ? `?cursor=${encodeURIComponent(next)}` : ''}`, { cache: 'no-store' });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || '读取失败');
      setTasks(current => next ? [...current, ...value.tasks] : value.tasks);
      setCursor(value.nextCursor || null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '图片任务读取失败'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

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

  return <div className="admin-integrations-page">
    <PageBanner eyebrow="管理后台" title="图片任务审计" description="查看所有用户的图片任务、归属、状态和生成结果；普通用户只能看到自己的任务和资产。" />
    {error && <div className="outputs-message" data-tone="error"><p>{error}</p><button className="btn btn-secondary" type="button" onClick={() => void load()}>重试</button></div>}
    <section className="card">
      <div className="outputs-workbench-head"><div><h2>任务列表</h2><p>管理员审计范围包含已隐藏结果，下载仍需通过管理员专用接口。</p></div><button className="btn btn-secondary" type="button" onClick={() => void load()}>刷新</button></div>
      {loading && <p role="status">正在读取…</p>}
      {!loading && !tasks.length && !error && <p>暂无图片任务。</p>}
      {tasks.length > 0 && <div style={{ overflowX: 'auto' }}><table className="table"><thead><tr><th>预览</th><th>时间</th><th>用户</th><th>模型</th><th>状态</th><th>画面描述</th><th>结果</th><th /></tr></thead><tbody>{tasks.map(task => <tr key={task.id}>
        <td><div style={{ width: 96, height: 64, display: 'grid', placeItems: 'center' }}>{task.asset ?
          // eslint-disable-next-line @next/next/no-img-element
          <img src={task.asset.original_url} alt="生成图片" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : <span>暂无预览</span>}</div></td>
        <td>{new Date(task.createdAt).toLocaleString('zh-CN')}</td>
        <td><UserIdentityBadge user={task.owner || { id: task.ownerId }} size="sm" /></td>
        <td>{IMAGE_STUDIO_MODEL_LABELS[task.model as ImageStudioModel] || task.model}</td><td>{task.deletedAt ? '用户已隐藏' : ({ queued: '等待生成', running: '生成中', succeeded: '已完成', failed: '生成失败', uncertain: '结果未确认' } as Record<string, string>)[task.status] || task.status}</td><td>{task.prompt || '参考图生成'}</td>
        <td>{task.asset ? <a href={task.asset.original_url} target="_blank" rel="noreferrer">查看图片</a> : '-'}</td>
        <td>{task.asset && <button className="btn btn-secondary" type="button" disabled={downloading !== null} onClick={() => void download(task.id)}>{downloading === task.id ? '准备下载' : '下载'}</button>}</td>
      </tr>)}</tbody></table></div>}
      {cursor && <button className="btn btn-secondary" type="button" disabled={loading} onClick={() => void load(cursor)}>加载更多</button>}
    </section>
  </div>;
}
