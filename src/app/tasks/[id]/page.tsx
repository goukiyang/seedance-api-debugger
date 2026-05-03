'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { GENERATION_MODE_LABELS, type GenerationMode } from '@/types';

interface CreditLedgerEntry {
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
}

interface TaskDetail {
  id: string;
  provider: string;
  model: string;
  generation_mode: GenerationMode;
  prompt: string;
  ratio: string | null;
  duration: number | null;
  resolution: string | null;
  seed: number | null;
  generate_audio: boolean | null;
  return_last_frame: boolean | null;
  watermark: boolean | null;
  local_status: string;
  provider_task_id: string | null;
  provider_status: string | null;
  result_video_url: string | null;
  local_video_path: string | null;
  error_message: string | null;
  estimated_cost: number | null;
  actual_cost: number | null;
  frozen_cost: number | null;
  refund_amount: number | null;
  pricing_snapshot: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  ledger_entries: CreditLedgerEntry[];
}

interface PricingSnapshot {
  model?: string;
  resolution?: string;
  duration?: number;
  baseCostPerSecond?: number;
  internalMultiplier?: number;
  finalCostPerSecond?: number;
  estimatedCost?: number;
  formula?: string;
  pricingRuleId?: string;
  pricingRuleVersion?: number;
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

function getRefundSummary(task: TaskDetail) {
  if ((task.refund_amount ?? 0) > 0) return `Refunded ${task.refund_amount} pts`;
  if ((task.frozen_cost ?? 0) > 0) return `Frozen ${task.frozen_cost} pts`;
  if (task.local_status === 'succeeded' && (task.actual_cost ?? 0) > 0) return `Settled ${task.actual_cost} pts`;
  if (task.local_status === 'failed' || task.local_status === 'cancelled') return 'No refund recorded';
  return 'Pending settlement';
}

function getStatusMessage(task: TaskDetail) {
  if (task.local_status === 'succeeded') {
    return 'The task reached a terminal success state. Video output and billing settlement are shown below.';
  }
  if (task.local_status === 'failed') {
    return `The task failed.${task.error_message ? ` Reason: ${task.error_message}` : ''} ${getRefundSummary(task)}.`;
  }
  if (task.local_status === 'cancelled') {
    return `The task was cancelled. ${getRefundSummary(task)}.`;
  }
  if (task.provider_status === 'unknown') {
    return 'The provider status could not be refreshed just now. The task remains non-terminal and may still be processing.';
  }
  if ((task.frozen_cost ?? 0) > 0) {
    return `The task is still in progress. ${task.frozen_cost} pts remain frozen until terminal settlement.`;
  }
  return 'The task has not reached a terminal state yet. Please refresh again later.';
}

function Field({
  label,
  value,
}: {
  label: string;
  value: string | number | boolean | null | undefined;
}) {
  return (
    <div style={{ minWidth: 180 }}>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{label}</div>
      <div style={{ fontWeight: 500, wordBreak: 'break-word' }}>
        {typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value ?? '-'}
      </div>
    </div>
  );
}

export default function TaskDetailPage() {
  const params = useParams();
  const taskId = params.id as string;
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchTask(true);
  }, [taskId]);

  useEffect(() => {
    if (!task || ['succeeded', 'failed', 'cancelled'].includes(task.local_status)) {
      return undefined;
    }

    const timer = setInterval(() => {
      void fetchTask(false);
    }, 5000);

    return () => clearInterval(timer);
  }, [task, taskId]);

  async function fetchTask(initial: boolean) {
    if (initial) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }

    try {
      const res = await fetch(`/api/video/status/${taskId}`);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || data.error || 'Failed to load task detail');
      }

      setTask(data);
      setError(null);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : 'Failed to load task detail');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  const pricingSnapshot = useMemo(() => {
    if (!task?.pricing_snapshot) return null;

    try {
      return JSON.parse(task.pricing_snapshot) as PricingSnapshot;
    } catch {
      return null;
    }
  }, [task?.pricing_snapshot]);

  const previewUrl = task?.result_video_url || task?.local_video_path || null;

  if (loading) {
    return (
      <div className="card">
        <p style={{ color: '#6b7280' }}>Loading task detail...</p>
      </div>
    );
  }

  if (error || !task) {
    return (
      <div className="card">
        <p style={{ color: '#b91c1c' }}>{error || 'Task not found.'}</p>
        <div style={{ marginTop: 16 }}>
          <Link href="/tasks" className="btn btn-secondary">
            Back to Records
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Task Detail</h1>
        <p className="page-description">Input, output, pricing snapshot, and ledger settlement for this task.</p>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <Link href="/tasks" className="btn btn-secondary">
          Back to Records
        </Link>
        <button type="button" className="btn btn-secondary" onClick={() => void fetchTask(false)} disabled={refreshing}>
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
        <span className={`status-badge ${getStatusClass(task.local_status)}`}>{getStatusText(task.local_status)}</span>
      </div>

      <div className="card">
        <h2 className="section-title">Task Input</h2>
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>Prompt</div>
          <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{task.prompt}</div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          <Field label="Generation Mode" value={GENERATION_MODE_LABELS[task.generation_mode] || task.generation_mode} />
          <Field label="Provider" value={task.provider} />
          <Field label="Model" value={task.model} />
          <Field label="Resolution" value={task.resolution} />
          <Field label="Duration" value={task.duration ? `${task.duration}s` : '-'} />
          <Field label="Ratio" value={task.ratio} />
          <Field label="Seed" value={task.seed} />
          <Field label="Generate Audio" value={task.generate_audio} />
          <Field label="Return Last Frame" value={task.return_last_frame} />
          <Field label="Watermark" value={task.watermark} />
          <Field label="Created At" value={formatTime(task.created_at)} />
        </div>
      </div>

      <div className="card">
        <h2 className="section-title">Task Output</h2>
        <div style={{ marginBottom: 16, color: '#374151', lineHeight: 1.6 }}>{getStatusMessage(task)}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 16 }}>
          <Field label="Provider Task ID" value={task.provider_task_id} />
          <Field label="Provider Status" value={task.provider_status} />
          <Field label="Completed At" value={formatTime(task.completed_at)} />
          <Field label="Estimated Cost" value={formatCredit(task.estimated_cost)} />
          <Field label="Actual Cost" value={formatCredit(task.actual_cost)} />
          <Field label="Refund Status" value={getRefundSummary(task)} />
        </div>

        {task.local_status === 'succeeded' && previewUrl && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>Video Preview</div>
            <video
              controls
              src={previewUrl}
              style={{ width: '100%', maxWidth: 880, borderRadius: 8, background: '#111827' }}
            />
          </div>
        )}

        {task.local_status === 'succeeded' && task.result_video_url && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>Result Video URL</div>
            <a href={task.result_video_url} target="_blank" rel="noreferrer" className="table-link">
              {task.result_video_url}
            </a>
          </div>
        )}

        {(task.local_status === 'failed' || task.local_status === 'cancelled') && (
          <div style={{ color: '#374151' }}>
            <div style={{ marginBottom: 8 }}>
              <strong>Failure Reason:</strong> {task.error_message || 'No provider error message recorded.'}
            </div>
            <div>
              <strong>Refund State:</strong> {getRefundSummary(task)}
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="section-title">Pricing Snapshot</h2>
        {pricingSnapshot ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
            <Field label="Model" value={pricingSnapshot.model || task.model} />
            <Field label="Resolution" value={pricingSnapshot.resolution || task.resolution} />
            <Field label="Duration" value={pricingSnapshot.duration ? `${pricingSnapshot.duration}s` : task.duration ? `${task.duration}s` : '-'} />
            <Field label="Base Cost / Second" value={pricingSnapshot.baseCostPerSecond ?? '-'} />
            <Field label="Internal Multiplier" value={pricingSnapshot.internalMultiplier ?? '-'} />
            <Field label="Final Cost / Second" value={pricingSnapshot.finalCostPerSecond ?? '-'} />
            <Field label="Estimated Cost" value={pricingSnapshot.estimatedCost ?? task.estimated_cost ?? '-'} />
            <Field label="Pricing Rule ID" value={pricingSnapshot.pricingRuleId || '-'} />
            <Field label="Pricing Rule Version" value={pricingSnapshot.pricingRuleVersion ?? '-'} />
            <div style={{ flexBasis: '100%' }}>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>Formula</div>
              <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{pricingSnapshot.formula || '-'}</div>
            </div>
          </div>
        ) : (
          <div>
            <p style={{ color: '#6b7280', marginBottom: 12 }}>No parseable pricing snapshot was stored for this task.</p>
            {task.pricing_snapshot && <pre className="json-viewer">{task.pricing_snapshot}</pre>}
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="section-title">Related Credit Ledger Entries</h2>
        {task.ledger_entries.length === 0 ? (
          <p style={{ color: '#6b7280' }}>No related ledger entries recorded yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Type</th>
                  <th>Amount Delta</th>
                  <th>Balance Change</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {task.ledger_entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{formatTime(entry.created_at)}</td>
                    <td>{getLedgerTypeLabel(entry.type)}</td>
                    <td style={{ color: entry.amount >= 0 ? '#047857' : '#b91c1c', fontWeight: 600 }}>
                      {entry.amount > 0 ? `+${entry.amount}` : entry.amount} pts
                    </td>
                    <td style={{ minWidth: 220 }}>
                      <div>{`${entry.balance_before} -> ${entry.balance_after} pts`}</div>
                      {(entry.frozen_before !== null || entry.frozen_after !== null) && (
                        <div style={{ fontSize: 12, color: '#6b7280' }}>
                          Frozen {entry.frozen_before ?? 0} {'->'} {entry.frozen_after ?? 0} pts
                        </div>
                      )}
                    </td>
                    <td style={{ minWidth: 280 }}>{entry.reason || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
