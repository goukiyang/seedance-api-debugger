'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Download } from 'lucide-react';
import PageBanner from '@/components/PageBanner';
import PaginationControls from '@/components/PaginationControls';
import { TaskVideoThumbnail } from '@/components/TaskVideoThumbnail';
import { formatAmountMicrosWithFixedCny, formatAmountMinorWithFixedCny } from '@/lib/costs/currency';
import { taskDetailHref } from '@/lib/navigation/return-to';
import { BULK_VIDEO_DOWNLOAD_CLIENT_LIMIT, downloadBulkVideoZip } from '@/lib/video/download-client';
import type { TaskGenerationMode } from '@/types';
import { TASK_GENERATION_MODE_LABELS } from '@/types';

interface Task {
  id: string;
  provider: string;
  provider_task_id: string | null;
  prompt: string;
  generation_mode: TaskGenerationMode;
  ratio: string | null;
  duration: number | null;
  resolution: string | null;
  local_status: string;
  public_video_url: string | null;
  public_video_storage_provider?: string | null;
  public_video_cached_at?: string | null;
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
  provider_final_amount_minor: number | null;
  provider_official_amount_micros: number | null;
  provider_final_amount_micros: number | null;
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
  if (task.generation_mode === 'enhance_video' || task.provider === 'volcengine_mediakit') return 0;
  const ids = parseJsonArray(task.reference_image_ids);
  if (ids.length > 0) return ids.length;
  return parseJsonArray(task.reference_image_urls).length;
}

function taskParameterText(task: Task) {
  if (task.generation_mode === 'enhance_video' || task.provider === 'volcengine_mediakit') {
    return [
      task.resolution || '-',
      task.duration ? `${task.duration}s` : '-',
      'AI MediaKit',
    ].join(' · ');
  }
  return `${task.resolution || '-'} · ${task.duration ? `${task.duration}s` : '-'} · ${task.ratio || '-'}`;
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
  const amountMicros = task.provider_final_amount_micros ?? task.provider_official_amount_micros;
  if (amountMicros !== null && amountMicros !== undefined) {
    return formatAmountMicrosWithFixedCny(amountMicros, task.provider_cost_currency);
  }
  const amountMinor = task.provider_final_amount_minor ?? task.provider_official_amount_minor;
  if (amountMinor !== null && amountMinor !== undefined) {
    return formatAmountMinorWithFixedCny(amountMinor, task.provider_cost_currency);
  }
  return '待官方确认';
}

function isTaskDownloadable(task: Task) {
  return task.local_status === 'succeeded' && Boolean(task.public_video_url || task.local_video_path || task.result_video_url);
}

function taskDownloadDisabledReason(task: Task) {
  if (task.local_status !== 'succeeded') return '任务未完成，暂不能下载';
  if (!task.public_video_url && !task.local_video_path && !task.result_video_url) return '任务没有可用视频链接';
  return '';
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkDownloading, setBulkDownloading] = useState(false);

  const selectedSet = new Set(selectedTaskIds);
  const downloadableTasks = tasks.filter(isTaskDownloadable);
  const selectedTasks = tasks.filter((task) => selectedSet.has(task.id));
  const selectedDownloadableTasks = selectedTasks.filter(isTaskDownloadable);
  const selectedTooMany = selectedDownloadableTasks.length > BULK_VIDEO_DOWNLOAD_CLIENT_LIMIT;

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
      setSelectedTaskIds([]);
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
      setSelectedTaskIds((current) => current.filter((id) => id !== task.id));
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

  const toggleTaskSelection = (task: Task, checked: boolean) => {
    if (!isTaskDownloadable(task)) return;
    setSelectedTaskIds((current) => {
      if (checked) return current.includes(task.id) ? current : [...current, task.id];
      return current.filter((id) => id !== task.id);
    });
  };

  const toggleCurrentPageDownloadable = (checked: boolean) => {
    if (checked) {
      setSelectedTaskIds(downloadableTasks.map((task) => task.id));
    } else {
      setSelectedTaskIds([]);
    }
  };

  const handleBulkDownload = async () => {
    if (selectedDownloadableTasks.length === 0 || selectedTooMany) return;
    setBulkDownloading(true);
    setError('');
    setMessage('');
    try {
      const result = await downloadBulkVideoZip({
        taskIds: selectedDownloadableTasks.map((task) => task.id),
      });
      setMessage(`已开始下载视频包：${result.success} 个视频${result.failed ? `，${result.failed} 个失败见 manifest` : ''}`);
      setBulkConfirmOpen(false);
      setSelectedTaskIds([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量下载失败');
    } finally {
      setBulkDownloading(false);
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
            <div className="bulk-download-toolbar">
              <label className="bulk-download-check">
                <input
                  type="checkbox"
                  checked={downloadableTasks.length > 0 && selectedDownloadableTasks.length === downloadableTasks.length}
                  disabled={downloadableTasks.length === 0}
                  onChange={(event) => toggleCurrentPageDownloadable(event.target.checked)}
                />
                <span>选择本页可下载视频</span>
              </label>
              <div className="bulk-download-toolbar-meta">
                已选 {selectedDownloadableTasks.length} 个
                {downloadableTasks.length > 0 && ` · 本页可下载 ${downloadableTasks.length} 个`}
              </div>
              <div className="bulk-download-toolbar-actions">
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={selectedDownloadableTasks.length === 0 || selectedTooMany}
                  onClick={() => setBulkConfirmOpen(true)}
                  title={selectedTooMany ? `第一批最多支持 ${BULK_VIDEO_DOWNLOAD_CLIENT_LIMIT} 个视频即时打包` : '将选中视频打包为 ZIP'}
                >
                  <Download size={16} aria-hidden="true" />
                  批量下载 ZIP
                </button>
                <button
                  className="btn btn-secondary"
                  type="button"
                  disabled={selectedTaskIds.length === 0}
                  onClick={() => setSelectedTaskIds([])}
                >
                  清空选择
                </button>
              </div>
            </div>
            {selectedTooMany && (
              <div className="alert alert-warning">
                第一批即时打包最多支持 {BULK_VIDEO_DOWNLOAD_CLIENT_LIMIT} 个视频；更大批量后续走后台任务。
              </div>
            )}
            <div className="tasks-card-list">
              {tasks.map((task) => {
                const referenceCount = taskReferenceCount(task);
                const modeLabel = TASK_GENERATION_MODE_LABELS[task.generation_mode] || task.generation_mode;
                const downloadable = isTaskDownloadable(task);
                return (
	                  <article key={task.id} className="tasks-card">
	                    <div className="tasks-preview-cell">
	                      <TaskVideoThumbnail
	                        taskId={task.id}
	                        localVideoPath={task.local_video_path}
	                        resultVideoUrl={task.result_video_url}
	                        resultLastFrameUrl={task.result_last_frame_url}
	                        status={task.local_status}
	                        provider={task.provider}
	                        generationMode={task.generation_mode}
	                        href={taskDetailHref(task.id, '/tasks')}
	                        size="medium"
	                        className="tasks-preview"
	                      />
	                      <label
	                        className="tasks-card-select"
	                        title={downloadable ? '选择此视频加入批量下载' : taskDownloadDisabledReason(task)}
	                      >
	                        <input
	                          type="checkbox"
	                          checked={selectedSet.has(task.id)}
	                          disabled={!downloadable}
	                          onChange={(event) => toggleTaskSelection(task, event.target.checked)}
	                        />
	                      </label>
	                    </div>

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
                          <strong>{taskParameterText(task)}</strong>
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
                      <Link href={taskDetailHref(task.id, '/tasks')} className="btn btn-secondary">
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

      {bulkConfirmOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="批量下载视频">
          <div className="modal-panel bulk-download-modal">
            <div className="modal-header">
              <div>
                <h2>批量下载视频</h2>
                <p>将选中的已完成视频打包为 ZIP</p>
              </div>
              <button className="modal-close" type="button" onClick={() => setBulkConfirmOpen(false)} aria-label="关闭">
                ×
              </button>
            </div>
            <div className="bulk-download-summary">
              <div>
                <span>选中视频</span>
                <strong>{selectedDownloadableTasks.length}</strong>
              </div>
              <div>
                <span>即时打包上限</span>
                <strong>{BULK_VIDEO_DOWNLOAD_CLIENT_LIMIT}</strong>
              </div>
            </div>
            <p className="text-gray">
              ZIP 内会包含视频文件和 manifest.csv。外链过期的视频会先尝试刷新并缓存，失败项会写入 manifest。
            </p>
            <div className="modal-actions">
              <button className="btn btn-secondary" type="button" onClick={() => setBulkConfirmOpen(false)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                type="button"
                onClick={handleBulkDownload}
                disabled={bulkDownloading || selectedDownloadableTasks.length === 0 || selectedTooMany}
              >
                <Download size={16} aria-hidden="true" />
                {bulkDownloading ? '打包中...' : '确认下载'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
