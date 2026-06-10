'use client';

import { FormEvent, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatCurrencyAmountWithFixedCny, formatUsdCnyEstimateFromInput } from '@/lib/costs/currency';

export type ProviderBalanceSnapshotView = {
  id: string;
  provider_name: string;
  provider_account_id: string | null;
  balance_kind: string;
  amount_decimal: string | null;
  amount_minor: number | null;
  currency: string | null;
  quota_amount: number | null;
  quota_unit: string | null;
  source: string;
  status: string;
  note: string | null;
  error_message: string | null;
  fetched_at: string;
  created_at: string;
};

type SubmitState = {
  type: 'success' | 'error';
  message: string;
} | null;

const BALANCE_STALE_HOURS = 24;
const BALANCE_STALE_MS = BALANCE_STALE_HOURS * 60 * 60 * 1000;

function snapshotStatusLabel(status: string) {
  if (status === 'synced') return '已拉取';
  if (status === 'manual') return '手动记录';
  if (status === 'failed') return '拉取失败';
  return status || '未知';
}

function snapshotSourceLabel(source: string) {
  if (source === 'provider_api') return '供应商接口';
  if (source === 'manual') return '人工录入';
  return source || '未知来源';
}

function formatSnapshotAmount(snapshot: ProviderBalanceSnapshotView | null) {
  if (!snapshot) return '暂无快照';
  if (snapshot.amount_decimal && snapshot.currency) {
    return formatCurrencyAmountWithFixedCny(Number(snapshot.amount_decimal), snapshot.currency);
  }
  if (snapshot.quota_amount !== null && snapshot.quota_amount !== undefined) {
    return `${snapshot.quota_amount} ${snapshot.quota_unit || 'quota'}`;
  }
  return '未识别额度';
}

function shortId(id: string) {
  return id.length > 10 ? `${id.slice(0, 10)}...` : id;
}

function snapshotTrust(snapshot: ProviderBalanceSnapshotView | null) {
  if (!snapshot) {
    return {
      tone: 'warning',
      label: '未建立',
      detail: '先从平台后台确认余额，再手动固化一条快照。',
    };
  }

  if (snapshot.status === 'failed') {
    return {
      tone: 'danger',
      label: '不可用',
      detail: snapshot.error_message || '最近一次拉取失败，需要检查余额接口。',
    };
  }

  // 余额快照超过一天后只作为历史参考，避免管理员误判当前可用资金。
  const fetchedAt = new Date(snapshot.fetched_at);
  const ageMs = Number.isNaN(fetchedAt.getTime()) ? Number.POSITIVE_INFINITY : Date.now() - fetchedAt.getTime();
  if (ageMs > BALANCE_STALE_MS) {
    return {
      tone: 'warning',
      label: '需更新',
      detail: `已超过 ${BALANCE_STALE_HOURS} 小时未更新，建议重新拉取或手动录入。`,
    };
  }

  return {
    tone: 'ok',
    label: '可信',
    detail: '最近快照仍在运营可参考窗口内。',
  };
}

export default function ProviderBalancePanel({
  latest,
  snapshots,
  syncEnabled,
}: {
  latest: ProviderBalanceSnapshotView | null;
  snapshots: ProviderBalanceSnapshotView[];
  syncEnabled: boolean;
}) {
  const router = useRouter();
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [providerAccountId, setProviderAccountId] = useState('');
  const [note, setNote] = useState('管理员手动记录供应商账户额度');
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitState, setSubmitState] = useState<SubmitState>(null);
  const cnyEstimate = formatUsdCnyEstimateFromInput(amount, currency);
  const trust = useMemo(() => snapshotTrust(latest), [latest]);

  const latestMeta = useMemo(() => {
    if (!latest) return '还没有拉取或手动记录过供应商账户额度';
    const parts = [
      snapshotStatusLabel(latest.status),
      snapshotSourceLabel(latest.source),
      new Date(latest.fetched_at).toLocaleString('zh-CN'),
    ];
    if (latest.provider_account_id) parts.splice(1, 0, latest.provider_account_id);
    return parts.join(' · ');
  }, [latest]);

  const syncBalance = async () => {
    setSyncing(true);
    setSubmitState(null);
    try {
      const res = await fetch('/api/admin/costs/provider-balance/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider_name: 'seedance' }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSubmitState({ type: 'error', message: data.error || data.message || '拉取失败' });
        router.refresh();
        return;
      }
      setSubmitState({ type: 'success', message: '供应商账户额度已拉取并固化为快照。' });
      router.refresh();
    } catch (error) {
      setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '拉取失败' });
    } finally {
      setSyncing(false);
    }
  };

  const saveManualSnapshot = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setSubmitState(null);

    try {
      const res = await fetch('/api/admin/costs/provider-balance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider_name: 'seedance',
          provider_account_id: providerAccountId,
          amount,
          currency,
          note,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSubmitState({ type: 'error', message: data.error || data.message || '保存失败' });
        return;
      }
      setSubmitState({ type: 'success', message: '供应商账户额度已手动固化为快照。' });
      setAmount('');
      router.refresh();
    } catch (error) {
      setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '保存失败' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card provider-balance-panel">
      <div className="provider-balance-head">
        <div>
          <h2 className="section-title mb-0">供应商账户额度</h2>
          <p className="text-gray text-sm mt-2">
            记录 Seedance 账户当前还剩多少预存金额。它是账户快照，不参与项目成本分摊。
            {!syncEnabled ? ' 自动拉取需要先配置余额接口。' : ''}
          </p>
        </div>
        <button className="btn btn-primary" type="button" onClick={syncBalance} disabled={syncing || !syncEnabled}>
          {syncing ? '正在拉取' : (syncEnabled ? '从供应商拉取' : '未配置余额接口')}
        </button>
      </div>

      <div className="provider-balance-summary">
        <div>
          <span className="stat-label">当前快照</span>
          <strong className="provider-balance-value">{formatSnapshotAmount(latest)}</strong>
          <span className="stat-sub">{latestMeta}</span>
        </div>
        <div>
          <span className="stat-label">可信度</span>
          <strong className={`provider-balance-status provider-balance-status-${trust.tone}`}>
            {trust.label}
          </strong>
          <span className="stat-sub">{trust.detail}</span>
        </div>
        <div>
          <span className="stat-label">失败保护</span>
          <strong className="provider-balance-status">
            {latest?.status === 'failed' ? '需检查接口' : '已留痕'}
          </strong>
          <span className="stat-sub">拉取失败也会记录快照，方便复盘接口状态。</span>
        </div>
      </div>

      <form className="provider-balance-form" onSubmit={saveManualSnapshot}>
        <div className="form-group">
          <label className="form-label" htmlFor="provider-balance-amount">手动余额</label>
          <input
            id="provider-balance-amount"
            className="input"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="例如 128.50"
            inputMode="decimal"
            required
          />
          {cnyEstimate ? <div className="form-hint">{cnyEstimate}</div> : null}
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="provider-balance-currency">币种</label>
          <select
            id="provider-balance-currency"
            className="input"
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
          >
            <option value="USD">USD</option>
            <option value="CNY">CNY</option>
          </select>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="provider-balance-account">账户标识</label>
          <input
            id="provider-balance-account"
            className="input"
            value={providerAccountId}
            onChange={(event) => setProviderAccountId(event.target.value)}
            placeholder="可选，供应商账户或团队名"
          />
        </div>
        <div className="form-group provider-balance-note">
          <label className="form-label" htmlFor="provider-balance-note">备注</label>
          <input
            id="provider-balance-note"
            className="input"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <div className="provider-balance-actions">
          <button className="btn btn-secondary" type="submit" disabled={saving || !amount.trim()}>
            {saving ? '正在保存' : '手动固化快照'}
          </button>
        </div>
      </form>

      {submitState && (
        <div className={`alert ${submitState.type === 'success' ? 'alert-success' : 'alert-error'} mt-4`}>
          {submitState.message}
        </div>
      )}

      <div className="provider-balance-history">
        <h3>最近快照</h3>
        {snapshots.length === 0 ? (
          <p className="text-gray">暂无供应商账户额度快照。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>时间</th>
                <th>来源</th>
                <th>状态</th>
                <th>额度</th>
                <th>账户</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((snapshot) => (
                <tr key={snapshot.id}>
                  <td>{new Date(snapshot.fetched_at).toLocaleString('zh-CN')}</td>
                  <td>{snapshotSourceLabel(snapshot.source)}</td>
                  <td>{snapshotStatusLabel(snapshot.status)}</td>
                  <td>{formatSnapshotAmount(snapshot)}</td>
                  <td>{snapshot.provider_account_id || shortId(snapshot.id)}</td>
                  <td className="truncate" style={{ maxWidth: 360 }} title={snapshot.error_message || snapshot.note || ''}>
                    {snapshot.error_message || snapshot.note || '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
