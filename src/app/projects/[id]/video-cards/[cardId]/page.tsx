'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import PageBanner from '@/components/PageBanner';
import TaskVideoThumbnail from '@/components/TaskVideoThumbnail';
import { taskDetailHref } from '@/lib/navigation/return-to';
import { formatAmountMicrosWithFixedCny } from '@/lib/costs/currency';
import { displayUserName } from '@/lib/users/display';

interface VideoCardSummary {
  task_count: number;
  succeeded_count: number;
  failed_count: number;
  running_count: number;
  estimated_credits: number;
  charged_credits: number;
  refunded_credits: number;
  official_cost_totals: Array<{ currency: string; amount_minor: number; amount_micros: number }>;
  resolution_distribution: Record<string, number>;
}

interface VideoCardDetail {
  id: string;
  project_id: string;
  project: { id: string; name: string; type: string; status: string };
  title: string;
  objective: string | null;
  status: string;
  owner_user_id: string | null;
  owner?: { id: string; name: string; username: string; email?: string } | null;
  platform: string | null;
  ratio: string | null;
  duration: number | null;
  target_resolution: string | null;
  budget_credits: number | null;
  budget_currency: string | null;
  current_best_task_id: string | null;
  final_task_id: string | null;
  is_fallback: boolean;
  sealed_at: string | null;
  created_at: string;
  updated_at: string;
  summary: VideoCardSummary | null;
}

interface TaskItem {
  id: string;
  prompt: string;
  local_status: string;
  result_video_url: string | null;
  result_last_frame_url?: string | null;
  local_video_path: string | null;
  estimated_cost: number | null;
  actual_cost: number | null;
  refund_amount: number | null;
  version_role: string;
  provider_final_amount_micros?: number | null;
  provider_official_amount_micros?: number | null;
  provider_cost_currency?: string | null;
  created_at: string;
  owner?: { id: string; name: string; username: string } | null;
  user?: { id: string; name: string; username: string } | null;
}

interface Permissions {
  can_generate: boolean;
  can_manage: boolean;
  project_role: string | null;
}

function statusLabel(status: string) {
  if (status === 'draft') return '草稿';
  if (status === 'active') return '生成中';
  if (status === 'reviewing') return '评审中';
  if (status === 'finalized') return '已定稿';
  if (status === 'sealed') return '已封板';
  if (status === 'archived') return '已归档';
  return status || '-';
}

function taskStatusLabel(status: string) {
  if (status === 'submitted') return '排队中';
  if (status === 'running') return '生成中';
  if (status === 'succeeded') return '已完成';
  if (status === 'failed') return '失败';
  if (status === 'cancelled') return '已取消';
  return status || '-';
}

function roleLabel(role: string) {
  if (role === 'current_best') return '当前最佳';
  if (role === 'final') return '最终版';
  if (role === 'candidate') return '候选';
  if (role === 'discarded') return '废弃';
  return '普通版本';
}

function formatOfficialCost(totals?: Array<{ currency: string; amount_micros: number }>) {
  if (!totals || totals.length === 0) return '待官方确认';
  return totals.map((item) => formatAmountMicrosWithFixedCny(item.amount_micros, item.currency)).join(' · ');
}

export default function VideoCardDetailPage() {
  const params = useParams<{ id: string; cardId: string }>();
  const projectId = params.id;
  const videoCardId = params.cardId;
  const returnTo = `/projects/${projectId}/video-cards/${videoCardId}`;
  const [videoCard, setVideoCard] = useState<VideoCardDetail | null>(null);
  const [permissions, setPermissions] = useState<Permissions>({ can_generate: false, can_manage: false, project_role: null });
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busyTaskId, setBusyTaskId] = useState('');
  const [sealing, setSealing] = useState(false);

  const loadVideoCard = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [cardRes, tasksRes] = await Promise.all([
        fetch(`/api/video-cards/${videoCardId}`, { cache: 'no-store' }),
        fetch(`/api/video-cards/${videoCardId}/tasks?limit=80`, { cache: 'no-store' }),
      ]);
      const cardData = await cardRes.json();
      const tasksData = await tasksRes.json();
      if (!cardRes.ok) {
        setError(cardData.error || cardData.message || '视频卡加载失败');
        setVideoCard(null);
        return;
      }
      if (cardData.video_card?.project_id && cardData.video_card.project_id !== projectId) {
        setError('视频卡不属于当前项目');
        setVideoCard(null);
        return;
      }
      if (!tasksRes.ok) {
        setError(tasksData.error || tasksData.message || '视频卡任务加载失败');
        setVideoCard(cardData.video_card || null);
        return;
      }
      setVideoCard(cardData.video_card);
      setPermissions(cardData.permissions || { can_generate: false, can_manage: false, project_role: null });
      setTasks(tasksData.tasks || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : '视频卡加载失败');
    } finally {
      setLoading(false);
    }
  }, [projectId, videoCardId]);

  useEffect(() => {
    void loadVideoCard();
  }, [loadVideoCard]);

  const patchVideoCard = async (payload: Record<string, unknown>, successMessage: string, taskId?: string) => {
    setError('');
    setMessage('');
    if (taskId) setBusyTaskId(taskId);
    try {
      const res = await fetch(`/api/video-cards/${videoCardId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || data.message || '视频卡更新失败');
        return;
      }
      setMessage(successMessage);
      await loadVideoCard();
    } finally {
      setBusyTaskId('');
    }
  };

  const sealVideoCard = async () => {
    if (!window.confirm('封板后默认不能继续在此视频卡下生成，确定封板吗？')) return;
    setSealing(true);
    await patchVideoCard({ seal: true }, '视频卡已封板');
    setSealing(false);
  };

  if (loading) return <div className="card"><p className="text-gray">加载中...</p></div>;

  if (!videoCard) {
    return (
      <div className="card">
        <p className="text-red">{error || '视频卡不存在或无权访问'}</p>
        <Link className="btn btn-secondary mt-4" href="/projects">返回项目</Link>
      </div>
    );
  }

  const summary = videoCard.summary;
  const canGenerate = permissions.can_generate && videoCard.status !== 'sealed' && videoCard.status !== 'archived';

  return (
    <div>
      <PageBanner
        eyebrow="视频卡"
        title={videoCard.title}
        description={videoCard.objective || `归属项目：${videoCard.project.name}`}
        backHref={`/projects/${videoCard.project_id}`}
        backLabel="返回项目"
      />

      {(message || error) && (
        <div className="card" style={{ borderColor: error ? 'rgba(248,113,113,0.35)' : 'rgba(74,222,128,0.35)' }}>
          <p className={error ? 'text-red' : 'text-green'}>{error || message}</p>
        </div>
      )}

      <div className="video-card-workbench">
        <section className="card">
          <div className="flex items-center justify-between mb-4" style={{ gap: 12, flexWrap: 'wrap' }}>
            <div>
              <h2 className="section-title mb-0">卡片信息</h2>
              <p className="text-gray text-sm mt-2">
                {statusLabel(videoCard.status)} · {displayUserName(videoCard.owner)} · {videoCard.is_fallback ? '历史兜底卡' : '正式视频卡'}
              </p>
            </div>
            <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap' }}>
              {canGenerate && (
                <Link className="btn btn-primary" href={`/generate?project_id=${videoCard.project_id}&video_card_id=${videoCard.id}`}>
                  再生成
                </Link>
              )}
              {permissions.can_manage && videoCard.status !== 'sealed' && (
                <button className="btn btn-secondary" type="button" onClick={sealVideoCard} disabled={sealing}>
                  {sealing ? '封板中...' : '封板'}
                </button>
              )}
            </div>
          </div>

          <div className="video-card-detail-grid">
            <span>项目：<Link className="link" href={`/projects/${videoCard.project_id}`}>{videoCard.project.name}</Link></span>
            <span>平台：{videoCard.platform || '-'}</span>
            <span>比例：{videoCard.ratio || '-'}</span>
            <span>时长：{videoCard.duration ? `${videoCard.duration}s` : '-'}</span>
            <span>目标分辨率：{videoCard.target_resolution || '-'}</span>
            <span>预算：{videoCard.budget_credits ?? '-'} {videoCard.budget_currency || ''}</span>
          </div>
        </section>

        <section className="card">
          <h2 className="section-title">成本摘要</h2>
          <div className="stats-grid">
            <div className="stat-card">
              <span className="stat-label">生成次数</span>
              <strong className="stat-value">{summary?.task_count ?? 0}</strong>
              <span className="stat-sub">成功 {summary?.succeeded_count ?? 0} · 失败 {summary?.failed_count ?? 0}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">点数消耗</span>
              <strong className="stat-value">{summary?.charged_credits ?? 0}</strong>
              <span className="stat-sub">预估 {summary?.estimated_credits ?? 0} · 返还 {summary?.refunded_credits ?? 0}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">官方成本</span>
              <strong className="stat-value">{formatOfficialCost(summary?.official_cost_totals)}</strong>
              <span className="stat-sub">按当前视频卡归属聚合</span>
            </div>
          </div>
        </section>
      </div>

      <section className="card">
        <div className="flex items-center justify-between mb-4" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 className="section-title mb-0">生成记录</h2>
            <p className="text-gray text-sm mt-2">当前最佳和最终版只能各保留一个；标记后任务详情仍保留完整审计信息。</p>
          </div>
          <span className="text-gray text-sm">{tasks.length} 条</span>
        </div>

        {tasks.length === 0 ? (
          <div className="video-card-empty">
            <strong>还没有生成记录</strong>
            <span>从此视频卡进入生成页后，新任务会自动归档在这里。</span>
          </div>
        ) : (
          <div className="video-card-task-list">
            {tasks.map((task) => {
              const officialMicros = task.provider_final_amount_micros ?? task.provider_official_amount_micros;
              return (
                <article key={task.id} className="video-card-task-item">
                  <TaskVideoThumbnail
                    taskId={task.id}
                    localVideoPath={task.local_video_path}
                    resultVideoUrl={task.result_video_url}
                    resultLastFrameUrl={task.result_last_frame_url}
                    status={task.local_status}
                    href={taskDetailHref(task.id, returnTo)}
                    size="card"
                    tone="dark"
                  />
                  <div className="video-card-task-body">
                    <div className="video-card-task-head">
                      <Link className="link" href={taskDetailHref(task.id, returnTo)}>{task.prompt || task.id}</Link>
                      <span className={`video-card-task-role ${task.version_role}`}>{roleLabel(task.version_role)}</span>
                    </div>
                    <div className="video-card-task-meta">
                      <span>{taskStatusLabel(task.local_status)}</span>
                      <span>{displayUserName(task.owner || task.user)}</span>
                      <span>点数 {task.actual_cost ?? task.estimated_cost ?? '-'}</span>
                      <span>官方 {officialMicros ? formatAmountMicrosWithFixedCny(officialMicros, task.provider_cost_currency) : '待确认'}</span>
                      <span>{new Date(task.created_at).toLocaleString('zh-CN')}</span>
                    </div>
                    {permissions.can_manage && (
                      <div className="video-card-task-actions">
                        <button
                          className="btn btn-secondary"
                          type="button"
                          disabled={busyTaskId === task.id}
                          onClick={() => patchVideoCard({ current_best_task_id: task.id }, '已标记当前最佳', task.id)}
                        >
                          标记当前最佳
                        </button>
                        <button
                          className="btn btn-primary"
                          type="button"
                          disabled={busyTaskId === task.id}
                          onClick={() => patchVideoCard({ final_task_id: task.id }, '已标记最终版', task.id)}
                        >
                          标记最终版
                        </button>
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
