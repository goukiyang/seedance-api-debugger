'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
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
  local_video_path: string | null;
  error_message: string | null;
  estimated_cost: number | null;
  actual_cost: number | null;
  frozen_cost: number | null;
  refund_amount: number | null;
  reference_image_ids: string | null;
  reference_image_urls: string | null;
  created_at: string;
  completed_at: string | null;
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

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  useEffect(() => {
    fetchTasks();
  }, [page]);

  const fetchTasks = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/video/list?page=${page}&limit=20`);
      const data = await res.json();
      setTasks(data.tasks || []);
      setPagination(data.pagination || null);
    } catch (error) {
      console.error('Failed to fetch tasks:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="tasks-page">
      <div className="tasks-header">
        <div>
          <div className="task-detail-kicker">我的任务</div>
          <h1 className="tasks-title">任务列表</h1>
          <p className="tasks-description">查看生成进度、复用历史提示词和参考图。</p>
        </div>
        <div className="tasks-header-actions">
          <button className="btn btn-secondary" onClick={fetchTasks}>
            刷新列表
          </button>
          <Link href="/generate" className="btn btn-primary">
            创建新任务
          </Link>
        </div>
      </div>

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
                    </div>
                  </article>
                );
              })}
            </div>

            {pagination && pagination.total_pages > 1 && (
              <div className="tasks-pagination">
                <span className="text-sm text-gray">
                  第 {pagination.page} / {pagination.total_pages} 页，共 {pagination.total} 条
                </span>
                <div className="flex gap-2">
                  <button
                    className="btn btn-secondary"
                    disabled={page <= 1}
                    onClick={() => setPage(page - 1)}
                  >
                    上一页
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={page >= pagination.total_pages}
                    onClick={() => setPage(page + 1)}
                  >
                    下一页
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
