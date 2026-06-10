'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';
import { formatUsdCnyEstimateFromInput } from '@/lib/costs/currency';
import { taskDetailHref } from '@/lib/navigation/return-to';

type PendingTaskOption = {
  id: string;
  prompt: string;
  provider_task_id: string | null;
};

type SubmitState = {
  type: 'success' | 'error';
  message: string;
  taskId?: string;
} | null;

export default function OfficialChargeForm({ pendingTasks }: { pendingTasks: PendingTaskOption[] }) {
  const [taskId, setTaskId] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('CNY');
  const [officialChargeId, setOfficialChargeId] = useState('');
  const [reason, setReason] = useState('管理员录入官方实际扣费');
  const [submitting, setSubmitting] = useState(false);
  const [submitState, setSubmitState] = useState<SubmitState>(null);
  const cnyEstimate = formatUsdCnyEstimateFromInput(amount, currency);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setSubmitState(null);

    try {
      const res = await fetch('/api/admin/costs/official-charge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task_id: taskId,
          amount,
          currency,
          official_charge_id: officialChargeId,
          reason,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSubmitState({ type: 'error', message: data.error || data.message || '录入失败' });
        return;
      }
      setSubmitState({
        type: 'success',
        message: data.deduplicated ? '这条官方扣费已入账，本次没有重复记账。' : '官方扣费已入账，并已归属到任务当前项目。',
        taskId: data.task?.id || taskId,
      });
      setAmount('');
      setOfficialChargeId('');
    } catch (error) {
      setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '录入失败' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="card">
      <h2 className="section-title">录入官方实际扣费</h2>
      <p className="text-gray mb-4">用于把官方账单行落到内部任务和项目成本。官方扣费 ID 必填，重复提交同一个 ID 不会重复入账。</p>

      <form onSubmit={submit} className="official-charge-form">
        <div className="form-group">
          <label className="form-label" htmlFor="official-task-id">任务 ID</label>
          <input
            id="official-task-id"
            className="input"
            list="pending-cost-tasks"
            value={taskId}
            onChange={(event) => setTaskId(event.target.value)}
            placeholder="粘贴内部任务 ID"
            required
          />
          <datalist id="pending-cost-tasks">
            {pendingTasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.provider_task_id ? `${task.provider_task_id} · ` : ''}{task.prompt}
              </option>
            ))}
          </datalist>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="official-amount">官方扣费</label>
          <input
            id="official-amount"
            className="input"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="例如 2.37，0 表示官方未收费"
            inputMode="decimal"
            required
          />
          {cnyEstimate ? <div className="form-hint">{cnyEstimate}</div> : null}
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="official-currency">币种</label>
          <select
            id="official-currency"
            className="input"
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
          >
            <option value="CNY">CNY</option>
            <option value="USD">USD</option>
          </select>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="official-charge-id">官方扣费 ID</label>
          <input
            id="official-charge-id"
            className="input"
            value={officialChargeId}
            onChange={(event) => setOfficialChargeId(event.target.value)}
            placeholder="账单行 ID / 官方请求 ID / 人工唯一编号"
            required
          />
        </div>

        <div className="form-group official-charge-form-wide">
          <label className="form-label" htmlFor="official-reason">备注</label>
          <input
            id="official-reason"
            className="input"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="说明来源或处理原因"
          />
        </div>

        <div className="official-charge-form-actions">
          <button className="btn btn-primary" type="submit" disabled={submitting}>
            {submitting ? '正在入账' : '确认入账'}
          </button>
        </div>
      </form>

      {submitState && (
        <div className={`alert ${submitState.type === 'success' ? 'alert-success' : 'alert-error'} mt-4`}>
          {submitState.message}
          {submitState.type === 'success' && submitState.taskId ? (
            <Link className="link" style={{ marginLeft: 8 }} href={taskDetailHref(submitState.taskId, '/admin/costs')}>查看任务</Link>
          ) : null}
        </div>
      )}
    </div>
  );
}
