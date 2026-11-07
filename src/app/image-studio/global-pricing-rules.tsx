'use client';

import { useEffect, useState } from 'react';
import type { PricingAdminRow, PricingAdminSnapshot } from '@/lib/pricing/admin-contract';
import { pricingAdminEnabled } from '@/lib/pricing/admin-client-state';
import { pricingDisplayFixedCredits, pricingDisplayName, pricingDisplayScope } from '@/lib/pricing/admin-display';
import styles from './global-pricing-rules.module.css';

function price(row: PricingAdminRow) {
  if (!pricingAdminEnabled(row)) return '费率已关闭';
  if (row.mode === 'free') return '0 点';
  if (row.identity.billingMode !== 'fixed') return '按账单结算';
  const credits = pricingDisplayFixedCredits(row, '1') ?? row.currentUnitCredits;
  return credits === null ? '价格待核对' : `${credits} 点 / 张`;
}

export function StudioGlobalPricingRules({ open, ownerId }: { open: boolean; ownerId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<PricingAdminSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!open) setExpanded(false); }, [open]);
  useEffect(() => {
    if (!open || !expanded || !ownerId) return;
    let active = true;
    const controller = new AbortController();
    setLoading(true); setError(''); setSnapshot(null);
    void (async () => {
      try {
        const response = await fetch('/api/admin/pricing', { cache: 'no-store', headers: { 'x-app-session-user': ownerId }, signal: controller.signal });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || '费率暂时无法读取');
        if (value.schemaVersion !== 1 || value.actor?.id !== ownerId || !Array.isArray(value.rows)) throw new Error('账号或费率版本已变化，请重新读取');
        if (active) setSnapshot(value);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : '费率暂时无法读取');
      } finally { if (active) setLoading(false); }
    })();
    const refresh = () => { if (document.visibilityState === 'visible') setRevision(value => value + 1); };
    document.addEventListener('visibilitychange', refresh);
    return () => { active = false; controller.abort(); document.removeEventListener('visibilitychange', refresh); };
  }, [open, expanded, ownerId, revision]);
  const rows = snapshot?.actor.id === ownerId ? snapshot.rows.filter(row => row.identity.kind === 'image') : [];
  return <details className={styles.rules} open={expanded && open} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>通用模型积分规则</summary>
    {expanded && open && <div className={styles.body}>
      <div className={styles.toolbar}><span>启停和改价在费率设置中维护</span><a href="/admin/pricing" target="_blank" rel="noopener noreferrer">费率设置 ↗</a></div>
      {loading && <p role="status">正在读取费率…</p>}
      {error && <p role="alert">{error} <button type="button" onClick={() => setRevision(value => value + 1)}>重新读取</button></p>}
      <div className={styles.list}>{rows.map(row => <div key={row.id} className={styles.row}>
        <span role="switch" aria-checked={pricingAdminEnabled(row)} aria-readonly="true" aria-label={`${pricingDisplayName(row)}费率${pricingAdminEnabled(row) ? '已开启' : '已关闭'}`} className={styles.switch} />
        <div className={styles.name}><strong>{pricingDisplayName(row)}</strong><small>{row.providerLabel} · {pricingDisplayScope(row)}</small>
          {row.availability !== 'ready' && <small>{row.unavailableReason || '通道暂未就绪'}</small>}</div>
        <span className={styles.price}>{price(row)}</span>
      </div>)}</div>
    </div>}
  </details>;
}
