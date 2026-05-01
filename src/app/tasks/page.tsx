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
  local_status: string;
  local_video_path: string | null;
  created_at: string;
  completed_at: string | null;
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
    <div>
      <div className="page-header">
        <h1 className="page-title">任务列表</h1>
        <p className="page-description">查看所有视频生成任务</p>
      </div>

      <div className="card">
        {loading ? (
          <p className="text-gray">加载中...</p>
        ) : tasks.length === 0 ? (
          <div>
            <p className="text-gray mb-4">暂无任务</p>
            <Link href="/generate" className="btn btn-primary">
              创建第一个任务
            </Link>
          </div>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>任务 ID</th>
                  <th>Provider ID</th>
                  <th>模式</th>
                  <th>提示词</th>
                  <th>状态</th>
                  <th>本地</th>
                  <th>创建时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={task.id}>
                    <td className="truncate" style={{ maxWidth: 100 }} title={task.id}>
                      {task.id.substring(0, 12)}...
                    </td>
                    <td className="truncate" style={{ maxWidth: 80 }} title={task.provider_task_id || '-'}>
                      {task.provider_task_id ? `${task.provider_task_id.substring(0, 10)}...` : '-'}
                    </td>
                    <td className="text-sm">
                      {GENERATION_MODE_LABELS[task.generation_mode] || task.generation_mode}
                    </td>
                    <td className="truncate" style={{ maxWidth: 150 }} title={task.prompt}>
                      {task.prompt}
                    </td>
                    <td>
                      <span className={`status-badge ${getStatusClass(task.local_status)}`}>
                        {getStatusText(task.local_status)}
                      </span>
                    </td>
                    <td>
                      {task.local_video_path ? (
                        <span className="text-green" title={task.local_video_path}>✅ 已保存</span>
                      ) : task.local_status === 'succeeded' ? (
                        <span className="text-gray">远程</span>
                      ) : '-'}
                    </td>
                    <td className="text-sm">
                      {new Date(task.created_at).toLocaleString('zh-CN')}
                    </td>
                    <td>
                      <Link href={`/tasks/${task.id}`} className="table-link">
                        查看详情
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {pagination && pagination.total_pages > 1 && (
              <div className="flex justify-between items-center mt-4">
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

      <div className="flex gap-4 mt-4">
        <Link href="/generate" className="btn btn-primary">
          创建新任务
        </Link>
        <button className="btn btn-secondary" onClick={fetchTasks}>
          刷新列表
        </button>
      </div>
    </div>
  );
}
