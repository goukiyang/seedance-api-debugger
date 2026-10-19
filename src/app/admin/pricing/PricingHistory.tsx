'use client';

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { RelativeTime } from '@/components/RelativeTime';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import type { PricingAdminAction, PricingAdminBasis, PricingAdminHistory, PricingAdminHistoryEntry, PricingAdminSnapshot } from '@/lib/pricing/admin-contract';
import dialogStyles from '@/components/ProductDialog.module.css';
import styles from './pricing.module.css';

export default function PricingHistory({ snapshot, onClose, onRestore, onUnauthorized }: {
  snapshot: PricingAdminSnapshot; onClose(): void; onRestore(action: PricingAdminAction): void; onUnauthorized(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [history, setHistory] = useState<PricingAdminHistory>({ entries: [], nextCursor: null });
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [selected, setSelected] = useState<{ revision: string; rows: string[]; standards: PricingAdminBasis[] }>({ revision: '', rows: [], standards: [] });
  useDialogDismiss({ open: true, nativeDialog: true, dialogRef: dialog, onDismiss: onClose });
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(undefined, controller.signal);
    return () => controller.abort();
    // Only this actor's freshly mounted history may be displayed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.actor.id]);
  async function load(cursor?: string, signal?: AbortSignal) {
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/admin/pricing/history${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { cache: 'no-store', signal, headers: { 'x-app-session-user': snapshot.actor.id } });
      if (response.status === 401 || response.status === 403) { onUnauthorized(); return; }
      const data = await response.json();
      if (data.code === 'pricing_actor_changed') { onUnauthorized(); return; }
      if (!response.ok || !Array.isArray(data.entries)) throw new Error(data.error || '历史暂不可读取');
      setHistory(current => ({ entries: cursor ? [...current.entries, ...data.entries] : data.entries, nextCursor: data.nextCursor }));
    } catch (error) { if (!signal?.aborted) setMessage(error instanceof Error ? error.message : '历史暂不可读取'); }
    finally { if (!signal?.aborted) setBusy(false); }
  }
  function toggle(entry: PricingAdminHistoryEntry, id: string, standard = false) {
    setSelected(current => {
      const next = current.revision === entry.revisionId ? current : { revision: entry.revisionId, rows: [], standards: [] };
      return standard ? { ...next, standards: next.standards.includes(id as PricingAdminBasis) ? next.standards.filter(item => item !== id) : [...next.standards, id as PricingAdminBasis] }
        : { ...next, rows: next.rows.includes(id) ? next.rows.filter(item => item !== id) : [...next.rows, id] };
    });
  }
  return <dialog ref={dialog} className={`${dialogStyles.dialog} ${styles.history}`} aria-modal="true" aria-labelledby="pricing-history-title">
    <header className={dialogStyles.header}><h2 id="pricing-history-title">变更记录</h2><button type="button" className={dialogStyles.close} aria-label="关闭变更记录" title="关闭变更记录" onClick={onClose}><X size={18} /></button></header>
    <div className={styles.historyBody}>
      {history.entries.map(entry => <section key={entry.revisionId}>
        <h3>{entry.actor.displayName} · <RelativeTime value={entry.createdAt} /></h3>
        <p className={styles.muted}>{entry.action === 'unify' ? '统一费率' : entry.action === 'restore' ? '恢复所选费率' : '保存调整'} · {entry.revisionId}</p>
        {entry.authoringBefore?.globalPointsPerCny !== entry.authoringAfter?.globalPointsPerCny && <p>统一换算：{entry.authoringBefore?.globalPointsPerCny ?? '未设置'} → {entry.authoringAfter?.globalPointsPerCny ?? '未设置'} 点/元</p>}
        {entry.authoringBefore && entry.authoringAfter && JSON.stringify(entry.authoringBefore.enhanceGroup) !== JSON.stringify(entry.authoringAfter.enhanceGroup) && <p>视频增强基础点价或系数已调整</p>}
        {(['site_base_cny', 'supplier_cost_cny'] as const).filter(basis => entry.standardsBefore[basis] !== entry.standardsAfter[basis]).map(basis => <label key={basis} className={styles.check}>
          <input type="checkbox" checked={selected.revision === entry.revisionId && selected.standards.includes(basis)} onChange={() => toggle(entry, basis, true)} />
          {basis === 'site_base_cny' ? '站内基价标准' : '供应商成本标准'}：{entry.standardsBefore[basis] || '未设置'} → {entry.standardsAfter[basis] || '未设置'} 点/元
        </label>)}
        {entry.changes.map(change => {
          const exists = snapshot.rows.some(row => row.id === change.id);
          return <label key={change.id} className={styles.historyRow}>
            <input type="checkbox" disabled={!exists} checked={selected.revision === entry.revisionId && selected.rows.includes(change.id)} onChange={() => toggle(entry, change.id)} />
            <span>{change.label}<small>{change.before.currentPointsPerCny || '未设置'} → {change.after.currentPointsPerCny || '未设置'} 点/元 · {change.before.currentUnitCredits ?? '待核'} → {change.after.currentUnitCredits ?? '待核'} 点{!exists ? ' · 当前对象不存在，无法恢复' : ''}</small>
              {change.specifications && <small>适用规格：{Object.values(change.specifications).join(' / ') || '通用规格'}</small>}
              {change.before.baseCny !== change.after.baseCny && <small>基价 ¥{change.before.baseCny ?? '待核'} → ¥{change.after.baseCny ?? '待核'}</small>}
              {change.before.authoringRateMode !== change.after.authoringRateMode && <small>点元关系：{change.before.authoringRateMode === 'follow_global' ? '跟随统一' : change.before.authoringRateMode === 'legacy_follow' ? '旧标准' : '单独设置'} → {change.after.authoringRateMode === 'follow_global' ? '跟随统一' : change.after.authoringRateMode === 'legacy_follow' ? '旧标准' : '单独设置'}</small>}
              {JSON.stringify(change.before.authoringEntry) !== JSON.stringify(change.after.authoringEntry) && <small>基价关系或来源依据已调整，恢复预览会重核适用关系。</small>}
            </span>
          </label>;
        })}
      </section>)}
      {!busy && !history.entries.length && !message && <p>尚无变更记录</p>}
      {busy && <p role="status">正在读取</p>}
      {message && <p role="status">{message} <button type="button" onClick={() => void load(history.nextCursor || undefined)}>重新读取</button></p>}
      {history.nextCursor && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void load(history.nextCursor!)}>加载更早记录</button>}
    </div>
    <footer className={dialogStyles.actions}><span className={styles.muted}>恢复所选修订中的值，预览后建立新修订；其它型号保留。</span><button type="button" className="btn btn-primary" disabled={!selected.rows.length && !selected.standards.length} onClick={() => {
      onRestore({ kind: 'restore', revisionId: selected.revision, ruleIds: selected.rows, ...(selected.standards.length ? { standards: selected.standards } : {}) }); onClose();
    }}>预览恢复所选</button></footer>
  </dialog>;
}
