'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import PageBanner from '@/components/PageBanner';
import PaginationControls from '@/components/PaginationControls';
import { formatAmountMicrosWithFixedCny, formatAmountMinorWithFixedCny } from '@/lib/costs/currency';
import type { GenerationMode } from '@/types';
import { GENERATION_MODE_LABELS } from '@/types';

interface Task {
  id: string;
  provider_task_id: string | null;
  prompt: string;
  generation_mode: GenerationMode;
  ratio: string | null;
  duration: number | null;
  resolution: string | null;
  local_status: string;
  result_video_url: string | null;
  result_last_frame_url: string | null;
  local_video_path: string | null;
  error_message: string | null;
  estimated_cost: number | null;
  actual_cost: number | null;
  frozen_cost: number | null;
  refund_amount: number | null;
  provider_cost_currency: string | null;
  provider_official_amount_minor: number | null;
  provider_official_amount_micros: number | null;
  reference_image_ids: string | null;
  reference_image_urls: string | null;
  created_at: string;
  completed_at: string | null;
  retention_status?: string | null;
  user_deleted_at?: string | null;
  user_deleted_by?: string | null;
  admin_hidden_at?: string | null;
  admin_hidden_by?: string | null;
  delete_reason?: string | null;
  project?: { id: string; name: string; type: string } | null;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}

function getStatusClass(status: string) {
  const statusMap: Record<string, string> = {
    draft: 'status-draft',
    submitted: 'status-submitted',
    running: 'status-running',
    succeeded: 'status-succeeded',
    failed: 'status-failed',
    cancelled: 'status-cancelled',
  };
  return statusMap[status] || 'status-draft';
}

function getStatusText(status: string) {
  const textMap: Record<string, string> = {
    draft: '草稿',
    submitted: '已提交',
    running: '生成中',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };
  return textMap[status] || status;
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatDate(value: string | null): string {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN');
}

function truncatePrompt(prompt: string, maxLen = 140): string {
  if (prompt.length <= maxLen) return prompt;
  return `${prompt.slice(0, maxLen)}...`;
}

function taskReferenceCount(task: Task): number {
  const ids = parseJsonArray(task.reference_image_ids);
  if (ids.length > 0) return ids.length;
  return parseJsonArray(task.reference_image_urls).length;
}

function taskCostText(task: Task): string {
  const actual = task.actual_cost ?? null;
  if (actual !== null) return `扣除 ${actual}`;
  if (task.frozen_cost && task.frozen_cost > 0) return `冻结 ${task.frozen_cost}`;
  if (task.estimated_cost !== null && task.estimated_cost !== undefined) return `预估 ${task.estimated_cost}`;
  if (task.refund_amount && task.refund_amount > 0) return `返还 ${task.refund_amount}`;
  return '未记录';
}

function taskOfficialChargeText(task: Task): string {
  if (task.provider_official_amount_micros !== null && task.provider_official_amount_micros !== undefined) {
    return formatAmountMicrosWithFixedCny(task.provider_official_amount_micros, task.provider_cost_currency);
  }
  if (task.provider_official_amount_minor !== null && task.provider_official_amount_minor !== undefined) {
    return formatAmountMinorWithFixedCny(task.provider_official_amount_minor, task.provider_cost_currency);
  }
  return '待官方确认';
}

type TaskPreviewModel = {
  kind: 'image' | 'empty';
  src?: string;
  label: string;
};

function getTaskPreview(task: Task, failedSrcs: string[] = []): TaskPreviewModel {
  const thumbnailSrc = `/api/video/thumbnail/${task.id}`;
  const hasThumbnailSource = !!(task.local_video_path || task.result_video_url || task.result_last_frame_url);

  if (hasThumbnailSource && !failedSrcs.includes(thumbnailSrc)) {
    return { kind: 'image', src: thumbnailSrc, label: '视频帧' };
  }

  if (task.local_status === 'failed') {
    return { kind: 'empty', label: '失败无视频帧' };
  }

  if (['submitted', 'running'].includes(task.local_status)) {
    return { kind: 'empty', label: '等待视频帧' };
  }

  return { kind: 'empty', label: '暂无视频帧' };
}

function TaskPreview({ task }: { task: Task }) {
  const [failedSrcs, setFailedSrcs] = useState<string[]>([]);
  const preview = getTaskPreview(task, failedSrcs);
  const markFailed = (src?: string) => {
    if (!src) return;
    setFailedSrcs((current) => current.includes(src) ? current : [...current, src]);
  };

  return (
    <Link
      href={`/tasks/${task.id}`}
      className={`tasks-preview tasks-preview-${preview.kind}`}
      aria-label={`查看任务 ${task.id} 的截图和详情`}
    >
      {preview.kind === 'image' && preview.src && (
        <img
          src={preview.src}
          alt="任务截图"
          loading="lazy"
          onError={() => markFailed(preview.src)}
        />
      )}
      {preview.kind === 'empty' && (
        <div className="tasks-preview-empty">
          <span>{getStatusText(task.local_status)}</span>
        </div>
      )}
      <span className="tasks-preview-label">
        {preview.label}
      </span>
    </Link>
  );
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    fetchTasks();
  }, [page]);

  const fetchTasks = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/video/list?page=${page}&limit=20`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || '任务加载失败');
      setTasks(data.tasks || []);
      setPagination(data.pagination || null);
    } catch (error) {
      console.error('Failed to fetch tasks:', error);
      setError(error instanceof Error ? error.message : '任务加载失败');
    } finally {
      setLoading(false);
    }
  };

  const removeTask = async (task: Task) => {
    if (!window.confirm('从我的任务列表移除此记录？管理员仍可在后台留存区审计和恢复。')) return;

    setDeletingTaskId(task.id);
    setMessage('');
    setError('');
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: '用户从任务列表移除' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || '移除失败');

      setTasks((current) => current.filter((item) => item.id !== task.id));
      setPagination((current) => current
        ? { ...current, total: Math.max(0, current.total - 1) }
        : current);
      setMessage('任务已从你的列表移除，管理员仍可在后台留存区查看。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '移除失败');
    } finally {
      setDeletingTaskId(null);
    }
  };

  return (
    <div className="tasks-page">
      <PageBanner
        eyebrow="我的任务"
        title="任务列表"
        description="查看生成进度、复用历史提示词和参考图。"
        actions={(
          <>
          <button className="btn btn-secondary" onClick={fetchTasks}>
            刷新列表
          </button>
          <Link href="/generate" className="btn btn-primary">
            创建新任务
          </Link>
          </>
        )}
      />

      {(message || error) && (
        <div className="card" style={{ borderColor: error ? 'rgba(248,113,113,0.35)' : 'rgba(74,222,128,0.35)' }}>
          <p className={error ? 'text-red' : 'text-green'}>{error || message}</p>
        </div>
      )}

      <div className="tasks-list-shell">
        {loading ? (
          <p className="text-gray">加载中...</p>
        ) : tasks.length === 0 ? (
          <div className="tasks-empty">
            <h2>暂无任务</h2>
            <p>先创建一个视频任务，生成记录会出现在这里。</p>
            <Link href="/generate" className="btn btn-primary">
              创建第一个任务
            </Link>
          </div>
        ) : (
          <>
            <div className="tasks-card-list">
              {tasks.map((task) => {
                const referenceCount = taskReferenceCount(task);
                const modeLabel = GENERATION_MODE_LABELS[task.generation_mode] || task.generation_mode;
                return (
                  <article key={task.id} className="tasks-card">
                    <TaskPreview task={task} />

                    <div className="tasks-card-main">
                      <div className="tasks-card-topline">
                        <span className={`status-badge ${getStatusClass(task.local_status)}`}>
                          {getStatusText(task.local_status)}
                        </span>
                        <span className="tasks-card-id" title={task.id}>{task.id.slice(0, 12)}...</span>
                        {task.project && (
                          <Link href={`/projects/${task.project.id}`} className="tasks-project-link">
                            {task.project.name}
                          </Link>
                        )}
                      </div>
                      <h2 className="tasks-card-title" title={task.prompt}>
                        {truncatePrompt(task.prompt, 96)}
                      </h2>
                      {task.error_message && task.local_status === 'failed' && (
                        <p className="tasks-card-error">{task.error_message}</p>
                      )}
                      <div className="tasks-meta-grid">
                        <div>
                          <span>模式</span>
                          <strong>{modeLabel}</strong>
                        </div>
                        <div>
                          <span>参数</span>
                          <strong>{task.resolution || '-'} · {task.duration ? `${task.duration}s` : '-'} · {task.ratio || '-'}</strong>
                        </div>
                        <div>
                          <span>参考图</span>
                          <strong>{referenceCount > 0 ? `${referenceCount} 张` : '无'}</strong>
                        </div>
                        <div>
                          <span>实际扣除</span>
                          <strong>{taskOfficialChargeText(task)}</strong>
                        </div>
                        <div>
                          <span>点数</span>
                          <strong>{taskCostText(task)}</strong>
                        </div>
                        <div>
                          <span>创建时间</span>
                          <strong>{formatDate(task.created_at)}</strong>
                        </div>
                        <div>
                          <span>完成时间</span>
                          <strong>{formatDate(task.completed_at)}</strong>
                        </div>
                      </div>
                    </div>

                    <div className="tasks-card-actions">
                      <Link href={`/tasks/${task.id}`} className="btn btn-secondary">
                        查看详情
                      </Link>
                      <Link href={`/generate?reuse_task_id=${task.id}`} className="btn btn-primary">
                        重新生成
                      </Link>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={deletingTaskId === task.id}
                        onClick={() => void removeTask(task)}
                      >
                        {deletingTaskId === task.id ? '移除中...' : '从列表移除'}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>

            {pagination && (
              <PaginationControls
                page={pagination.page}
                totalPages={pagination.total_pages}
                total={pagination.total}
                pageSize={pagination.limit}
                label="任务"
                onPageChange={setPage}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
