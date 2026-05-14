'use client';

import { useState } from 'react';
import Link from 'next/link';

type ImportResult = {
  row_number: number;
  status: 'ready' | 'imported' | 'duplicated' | 'unmatched' | 'ambiguous' | 'invalid' | 'failed';
  message: string;
  task_id?: string;
  provider_task_id?: string | null;
  official_charge_id?: string;
  amount_minor?: number | null;
  currency?: string;
  ledger_id?: string;
};

type ImportResponse = {
  ok?: boolean;
  dry_run?: boolean;
  summary?: Record<string, number>;
  results?: ImportResult[];
  error?: string;
  message?: string;
};

const EXAMPLE_CSV = `official_charge_id,provider_task_id,amount,currency,reason
bill-20260514-001,seedance-provider-task-id,2.37,CNY,官方账单导入`;

const STATUS_LABELS: Record<ImportResult['status'], string> = {
  ready: '可导入',
  imported: '已入账',
  duplicated: '已存在',
  unmatched: '未匹配',
  ambiguous: '多重匹配',
  invalid: '格式错误',
  failed: '导入失败',
};

function formatAmountMinor(amount: number | null | undefined, currency?: string) {
  if (amount === null || amount === undefined) return '-';
  const value = amount / 100;
  if (currency === 'USD') return `$${value.toFixed(2)}`;
  return `¥${value.toFixed(2)}`;
}

function summaryText(summary?: Record<string, number>) {
  if (!summary) return '暂无结果';
  const order: Array<keyof typeof STATUS_LABELS> = ['ready', 'imported', 'duplicated', 'unmatched', 'ambiguous', 'invalid', 'failed'];
  const parts = order
    .filter((key) => summary[key])
    .map((key) => `${STATUS_LABELS[key]} ${summary[key]}`);
  return parts.length > 0 ? parts.join(' · ') : '暂无结果';
}

export default function OfficialChargeImportForm() {
  const [csv, setCsv] = useState(EXAMPLE_CSV);
  const [defaultCurrency, setDefaultCurrency] = useState('CNY');
  const [reason, setReason] = useState('官方账单批量导入');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ImportResponse | null>(null);

  const submit = async (dryRun: boolean) => {
    setSubmitting(true);
    setResult(null);

    try {
      const res = await fetch('/api/admin/costs/import-official-charges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          csv,
          default_currency: defaultCurrency,
          reason,
          dry_run: dryRun,
        }),
      });
      const data = await res.json();
      setResult(res.ok ? data : { error: data.error || data.message || '导入失败' });
    } catch (error) {
      setResult({ error: error instanceof Error ? error.message : '导入失败' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="card">
      <h2 className="section-title">批量导入官方账单</h2>
      <p className="text-gray mb-4">
        粘贴官方账单 CSV 后先预检。系统会优先用 task_id 匹配；没有 task_id 时用 provider_task_id 匹配。无法匹配的行不会入账。
      </p>

      <div className="official-import-controls">
        <div className="form-group official-import-currency">
          <label className="form-label" htmlFor="official-import-currency">默认币种</label>
          <select
            id="official-import-currency"
            className="input"
            value={defaultCurrency}
            onChange={(event) => setDefaultCurrency(event.target.value)}
          >
            <option value="CNY">CNY</option>
            <option value="USD">USD</option>
          </select>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="official-import-reason">默认备注</label>
          <input
            id="official-import-reason"
            className="input"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
      </div>

      <textarea
        className="official-import-textarea"
        value={csv}
        onChange={(event) => setCsv(event.target.value)}
        spellCheck={false}
      />

      <div className="official-import-actions">
        <button className="btn btn-secondary" type="button" onClick={() => submit(true)} disabled={submitting || !csv.trim()}>
          {submitting ? '处理中...' : '预检'}
        </button>
        <button className="btn btn-primary" type="button" onClick={() => submit(false)} disabled={submitting || !csv.trim()}>
          {submitting ? '处理中...' : '确认导入可匹配行'}
        </button>
      </div>

      {result?.error && (
        <div className="alert alert-error mt-4">{result.error}</div>
      )}

      {result?.results && (
        <div className="official-import-result">
          <div className="official-import-summary">
            <strong>{result.dry_run ? '预检结果' : '导入结果'}</strong>
            <span>{summaryText(result.summary)}</span>
          </div>

          <table className="table">
            <thead>
              <tr>
                <th>行</th>
                <th>状态</th>
                <th>任务</th>
                <th>官方扣费 ID</th>
                <th>金额</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {result.results.slice(0, 50).map((row) => (
                <tr key={`${row.row_number}-${row.official_charge_id || row.message}`}>
                  <td>{row.row_number}</td>
                  <td>{STATUS_LABELS[row.status]}</td>
                  <td>
                    {row.task_id ? <Link className="link" href={`/tasks/${row.task_id}`}>{row.task_id.slice(0, 10)}...</Link> : '-'}
                  </td>
                  <td>{row.official_charge_id || '-'}</td>
                  <td>{formatAmountMinor(row.amount_minor, row.currency)}</td>
                  <td className="truncate" style={{ maxWidth: 360 }} title={row.message}>{row.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.results.length > 50 && <p className="form-hint">只展示前 50 行，完整结果请缩小批次后处理。</p>}
        </div>
      )}
    </div>
  );
}
