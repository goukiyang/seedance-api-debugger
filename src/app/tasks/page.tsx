'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';

type RecordsView = 'tasks' | 'ledger';

interface TaskRecord {
  id: string;
  provider_task_id: string | null;
  prompt: string;
  model: string;
  local_status: string;
  resolution: string | null;
  duration: number | null;
  estimated_cost: number | null;
  actual_cost: number | null;
  frozen_cost: number | null;
  refund_amount: number | null;
  created_at: string;
  completed_at: string | null;
}

interface RelatedTaskSummary {
  id: string;
  prompt: string;
  local_status: string;
  model: string;
  created_at: string;
}

interface LedgerRecord {
  id: string;
  type: string;
  amount: number;
  balance_before: number;
  balance_after: number;
  frozen_before: number | null;
  frozen_after: number | null;
  related_task_id: string | null;
  reason: string | null;
  created_at: string;
  related_task: RelatedTaskSummary | null;
}

interface Pagination {
  page: number;
  total_pages: number;
  total: number;
}

function formatTime(value: string | null) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN');
}

function formatCredit(value: number | null | undefined) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '-';
  return `${value} pts`;
}

function getStatusText(status: string) {
  const textMap: Record<string, string> = {
    draft: 'Draft',
    submitted: 'Submitted',
    running: 'Running',
    succeeded: 'Succeeded',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };
  return textMap[status] || status;
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

function getLedgerTypeLabel(type: string) {
  const labels: Record<string, string> = {
    task_freeze: 'Freeze',
    task_success_deduct: 'Settlement Deduct',
    task_failed_refund: 'Refund',
    manual_refund: 'Manual Refund',
    periodic_grant: 'Periodic Grant',
    admin_grant: 'Admin Grant',
    admin_deduct: 'Admin Deduct',
    system_adjust: 'System Adjust',
  };
  return labels[type] || type;
}

function getRefundStatus(task: TaskRecord) {
  if ((task.refund_amount ?? 0) > 0) return `Refunded ${task.refund_amount} pts`;
  if ((task.frozen_cost ?? 0) > 0) return `Frozen ${task.frozen_cost} pts`;
  if (task.local_status === 'succeeded' && (task.actual_cost ?? 0) > 0) return 'Settled';
  if (task.local_status === 'failed' || task.local_status === 'cancelled') return 'No refund recorded';
  return 'Pending';
}

function SegmentedButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={active ? 'btn btn-primary' : 'btn btn-secondary'}
      onClick={onClick}
      style={{ minWidth: 140 }}
    >
      {children}
    </button>
  );
}

export default function TasksPage() {
  const [view, setView] = useState<RecordsView>('tasks');
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [ledger, setLedger] = useState<LedgerRecord[]>([]);
  const [tasksPagination, setTasksPagination] = useState<Pagination | null>(null);
  const [ledgerPagination, setLedgerPagination] = useState<Pagination | null>(null);
  const [tasksPage, setTasksPage] = useState(1);
  const [ledgerPage, setLedgerPage] = useState(1);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [ledgerLoading, setLedgerLoading] = useState(true);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [ledgerError, setLedgerError] = useState<string | null>(null);

  useEffect(() => {
    void fetchTasks(tasksPage);
  }, [tasksPage]);

  useEffect(() => {
    void fetchLedger(ledgerPage);
  }, [ledgerPage]);

  async function fetchTasks(page: number) {
    setTasksLoading(true);
    setTasksError(null);

    try {
      const res = await fetch(`/api/video/list?page=${page}&limit=10`);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || data.error || 'Failed to load task records');
      }

      setTasks(data.tasks || []);
      setTasksPagination(data.pagination || null);
    } catch (error) {
      setTasksError(error instanceof Error ? error.message : 'Failed to load task records');
    } finally {
      setTasksLoading(false);
    }
  }

  async function fetchLedger(page: number) {
    setLedgerLoading(true);
    setLedgerError(null);

    try {
      const res = await fetch(`/api/me/credits/ledger?page=${page}&page_size=10`);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || data.error || 'Failed to load credit ledger');
      }

      setLedger(data.records || []);
      setLedgerPagination({
        page: data.page,
        total_pages: data.total_pages,
        total: data.total,
      });
    } catch (error) {
      setLedgerError(error instanceof Error ? error.message : 'Failed to load credit ledger');
    } finally {
      setLedgerLoading(false);
    }
  }

  function renderPagination(
    pagination: Pagination | null,
    page: number,
    onPageChange: (nextPage: number) => void,
  ) {
    if (!pagination || pagination.total_pages <= 1) return null;

    return (
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
        <span style={{ fontSize: 14, color: '#6b7280' }}>
          Page {pagination.page} / {pagination.total_pages}, total {pagination.total}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            Previous
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={page >= pagination.total_pages}
            onClick={() => onPageChange(page + 1)}
          >
            Next
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">My Records</h1>
        <p className="page-description">Review your task history, credit freeze, settlement, and refunds.</p>
      </div>

      <div className="card">
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
          <SegmentedButton active={view === 'tasks'} onClick={() => setView('tasks')}>
            Task Records
          </SegmentedButton>
          <SegmentedButton active={view === 'ledger'} onClick={() => setView('ledger')}>
            Credit Ledger
          </SegmentedButton>
          <Link href="/generate" className="btn btn-secondary">
            New Task
          </Link>
        </div>

        {view === 'tasks' ? (
          <>
            {tasksLoading ? (
              <p style={{ color: '#6b7280' }}>Loading task records...</p>
            ) : tasksError ? (
              <p style={{ color: '#b91c1c' }}>{tasksError}</p>
            ) : tasks.length === 0 ? (
              <p style={{ color: '#6b7280' }}>No task records yet.</p>
            ) : (
              <>
                <div style={{ overflowX: 'auto' }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Task</th>
                        <th>Status</th>
                        <th>Model</th>
                        <th>Resolution</th>
                        <th>Duration</th>
                        <th>Estimated</th>
                        <th>Actual</th>
                        <th>Refund</th>
                        <th>Created</th>
                        <th>Completed</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tasks.map((task) => (
                        <tr key={task.id}>
                          <td style={{ minWidth: 260 }}>
                            <div title={task.prompt} style={{ fontWeight: 500, marginBottom: 4 }}>
                              {task.prompt.length > 72 ? `${task.prompt.slice(0, 72)}...` : task.prompt}
                            </div>
                            <div style={{ fontSize: 12, color: '#6b7280' }}>
                              {task.provider_task_id ? `Provider: ${task.provider_task_id}` : `Task ID: ${task.id}`}
                            </div>
                          </td>
                          <td>
                            <span className={`status-badge ${getStatusClass(task.local_status)}`}>
                              {getStatusText(task.local_status)}
                            </span>
                          </td>
                          <td>{task.model || '-'}</td>
                          <td>{task.resolution || '-'}</td>
                          <td>{task.duration ? `${task.duration}s` : '-'}</td>
                          <td>{formatCredit(task.estimated_cost)}</td>
                          <td>{formatCredit(task.actual_cost)}</td>
                          <td>{getRefundStatus(task)}</td>
                          <td>{formatTime(task.created_at)}</td>
                          <td>{formatTime(task.completed_at)}</td>
                          <td>
                            <Link href={`/tasks/${task.id}`} className="table-link">
                              View Details
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {renderPagination(tasksPagination, tasksPage, setTasksPage)}
              </>
            )}
          </>
        ) : (
          <>
            {ledgerLoading ? (
              <p style={{ color: '#6b7280' }}>Loading credit ledger...</p>
            ) : ledgerError ? (
              <p style={{ color: '#b91c1c' }}>{ledgerError}</p>
            ) : ledger.length === 0 ? (
              <p style={{ color: '#6b7280' }}>No credit ledger entries yet.</p>
            ) : (
              <>
                <div style={{ overflowX: 'auto' }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Type</th>
                        <th>Amount Delta</th>
                        <th>Balance Change</th>
                        <th>Related Task</th>
                        <th>Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ledger.map((record) => (
                        <tr key={record.id}>
                          <td>{formatTime(record.created_at)}</td>
                          <td>{getLedgerTypeLabel(record.type)}</td>
                          <td style={{ color: record.amount >= 0 ? '#047857' : '#b91c1c', fontWeight: 600 }}>
                            {record.amount > 0 ? `+${record.amount}` : record.amount} pts
                          </td>
                          <td style={{ minWidth: 220 }}>
                            <div>{`${record.balance_before} -> ${record.balance_after} pts`}</div>
                            {(record.frozen_before !== null || record.frozen_after !== null) && (
                              <div style={{ fontSize: 12, color: '#6b7280' }}>
                                Frozen {record.frozen_before ?? 0} {'->'} {record.frozen_after ?? 0} pts
                              </div>
                            )}
                          </td>
                          <td style={{ minWidth: 220 }}>
                            {record.related_task ? (
                              <div>
                                <Link href={`/tasks/${record.related_task.id}`} className="table-link">
                                  {record.related_task.prompt.length > 40
                                    ? `${record.related_task.prompt.slice(0, 40)}...`
                                    : record.related_task.prompt}
                                </Link>
                                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                                  {getStatusText(record.related_task.local_status)}
                                </div>
                              </div>
                            ) : (
                              '-'
                            )}
                          </td>
                          <td style={{ minWidth: 220 }}>{record.reason || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {renderPagination(ledgerPagination, ledgerPage, setLedgerPage)}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
