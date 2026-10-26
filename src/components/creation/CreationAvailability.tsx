'use client';
import { useEffect, useState } from 'react';
import type { CreationContextController } from '@/lib/hooks/use-creation-context';
import { RelativeTime } from '@/components/RelativeTime';
import styles from './creation.module.css';
export default function CreationAvailability({ controller, onBaselineChange }: { controller: CreationContextController; onBaselineChange?: (id: string) => void }) {
  const { context, intent, loading, error } = controller;
  const [baselines, setBaselines] = useState<Array<{ id: string; model: string; resolution: string | null; preview_url: string | null }>>([]);
  useEffect(() => {
    let active = true; setBaselines([]);
    if (!context?.project.id || !intent?.availability?.reasons.some(item => item.code === 'creation_approval_required')) return;
    void fetch(`/api/creation/baselines?project_id=${encodeURIComponent(context.project.id)}`, { cache: 'no-store' }).then(async response => { if (!response.ok) return; const data = await response.json(); if (active) setBaselines(data.items || []); }).catch(() => undefined);
    return () => { active = false; };
  }, [context?.project.id, intent?.id, intent?.revision]);
  const [reason, setReason] = useState(''), [baseline, setBaseline] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  useEffect(() => { setMessage(''); setBaseline(intent?.spec?.baseline_task_id || ''); }, [intent?.id]);
  const action = async (name: 'approval' | 'close') => {
    if (!intent) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/video/creation-intents/${intent.id}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_revision: intent.revision, reason }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || '暂时无法确认，请查询原请求');
      setMessage(name === 'approval' ? '申请已提交，批准后请主动点击生成。' : '已核对原请求，请查看当前状态。');
      await controller.queryIntent(intent.id);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : '暂时无法确认'); }
    finally { setBusy(false); }
  };
  if (!loading && !error && !intent) return context ? <p className={styles.summary}>保存到 {context.project.name} · {context.payer.label}{context.legacyCard ? ` · 原视频卡：${context.legacyCard.title}` : ''}</p> : null;
  return <div className={styles.status} aria-live="polite">
    {loading && <p>正在确认保存位置</p>}
    {error && <p>{error} <button className="btn btn-secondary" type="button" onClick={controller.refresh}>重新读取</button></p>}
    {intent?.availability?.reasons.map(item => <p key={`${item.code}:${item.field}`}><button className={styles.textAction} type="button" onClick={() => document.querySelector<HTMLElement>(`[name="${item.field}"], [data-creation-field="${item.field}"]`)?.focus()}>{item.message}</button></p>)}
    {intent?.approval && <p>高清申请：{({ pending: '待负责人审批', approved: '已通过', rejected: '已拒绝', cancelled: '已撤销' } as Record<string,string>)[intent.approval.status] || intent.approval.status}{intent.approval.reason ? ` · ${intent.approval.reason}` : ''}{intent.approval.expires_at && <> · 到期 <RelativeTime value={intent.approval.expires_at} /></>}</p>}
    {intent?.availability?.reasons.some(item => item.code === 'creation_approval_required') && <details open><summary>本次高清申请</summary>
      <p>{context?.project.name} · {intent.spec?.input.model as string} · {intent.spec?.input.resolution as string} · {intent.spec?.input.duration as number}秒 × {intent.spec?.count || 1}{intent.quote ? ` · 合计 ${(intent.quote.estimated_cost * (intent.spec?.count || 1)).toFixed(1)} 点` : ''}</p>
      {onBaselineChange && <label>基准视频 <select className="input" value={baseline} onChange={event => { setBaseline(event.target.value); onBaselineChange(event.target.value); }}><option value="">选择本项目已就绪视频</option>{baselines.map(item => <option key={item.id} value={item.id}>{item.model} · {item.resolution || "规格待确认"} · {item.id}</option>)}</select>{baselines.find(item => item.id === baseline)?.preview_url && <video style={{ width: "min(100%, 260px)" }} controls preload="none" src={baselines.find(item => item.id === baseline)?.preview_url || undefined} />}</label>}
      <label>预计用途 <input className="input" value={reason} onChange={event => setReason(event.target.value)} /></label>
      <div className={styles.actions}><button type="button" className="btn btn-primary" disabled={busy || !reason.trim() || !intent.spec?.baseline_task_id} onClick={() => void action('approval')}>申请高清</button><a href="/approvals">查看审批</a><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void controller.queryIntent(intent.id)}>重新读取批准</button></div>
    </details>}
    {intent && !intent.accepted_task_id && !intent.batch_id && !['closed','rejected'].includes(intent.state) && <button className={styles.textAction} type="button" disabled={busy} onClick={() => void action('close')}>核对并结束本次准备</button>}
    {message && <p role="status">{message}</p>}
  </div>;
}
