'use client';
import { useEffect, useRef, useState } from 'react';
import { Pause, Play, RefreshCw, RotateCcw } from 'lucide-react';
import { RelativeTime } from './RelativeTime';
type Counts = Record<string, number>;
type Status = { total: number; counts: Counts; reasons: Counts; control: { paused: boolean; reason?: string; updatedAt?: string };
  batches: Array<{ id: string; knownLocalOriginals: number; counts: Counts; notQueued: number; remoteVersionUnknown: number; unavailable: number }>;
  newCounts: Counts; lastSuccessAt?: string | null; lastProgressAt?: string | null; stalled?: boolean;
  canResume: boolean; retryableCount: number; retrySummary?: { queued: number; held: number } };
const reasonLabel: Record<string, string> = { admin_pause: '管理员暂停', operator_pause: '操作员暂停', capacity_guard: '剩余空间不足', load_guard: '服务器忙碌', multi_frame: '多帧原件', pixel_limit: '像素数量超限', high_bit_depth: '高位深原件', wide_gamut: '色彩范围不适用', unverified_color_profile: '色彩配置未确认', existing_webp: '已有WebP，保留原件', original_smaller: '原件更小，使用原件', source_changed: '原件版本已变化', decode_or_source_failed: '读取或解码失败', temporary_io: '临时读取失败', output_integrity: '新文件校验异常', published_integrity: '已准备文件异常', discovery_source_failure: '新原件读取异常', retry_limit: '自动重试已用尽', worker_integrity_failure: '后台文件或读取状态异常' };
const countText = (value: Counts) => `可用 ${value.ready} · 等待 ${value.queued} · 处理中 ${value.running} · 失败 ${value.failed} · 不适配 ${value.skipped}`;
export function HdDerivativeManagement() {
  const [data, setData] = useState<Status | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const lock = useRef(false);
  async function load(action?: string) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const response = await fetch('/api/admin/hd-derivatives', action ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) } : { cache: 'no-store' });
      const value = await response.json(); if (!response.ok) throw new Error(value.error || '读取失败'); setData(value);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '暂时无法确认，请刷新状态后再操作'); }
    finally { lock.current = false; setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  const safetyStop = Boolean(data?.control.paused && !data.canResume);
  return <section aria-labelledby="hd-management-title"><h2 id="hd-management-title">高清图准备</h2>{data && <>
    <p><strong>{data.control.paused ? `已暂停 · ${reasonLabel[data.control.reason || ''] || '原因待确认'}` : data.stalled ? '等待处理，暂未看到推进' : '后台准备已开启'}</strong> · {data.total} 个作业</p>
    <p>{countText(data.counts)}</p>
    <p>最后成功：{data.lastSuccessAt ? <RelativeTime value={data.lastSuccessAt} /> : '尚无成功记录'} · 最后处理进展：{data.lastProgressAt ? <RelativeTime value={data.lastProgressAt} /> : '尚无处理记录'}</p>
    {data.stalled && <p role="status">仍有待处理图片，超过10分钟没有处理进展，请检查工作进程；服务在线不代表正在处理。</p>}
    {safetyStop && <p role="status">先核对暂停原因、完成小批校验后再继续。原图查看和下载不受此暂停限制。</p>}
    <details><summary>旧库与新增任务</summary>{data.batches.map(batch => <p key={batch.id}>旧库 · 已盘点 {batch.knownLocalOriginals} 个本地原件 · {countText(batch.counts)} · 未入队 {batch.notQueued} · 远程版本未知 {batch.remoteVersionUnknown} · 无法读取 {batch.unavailable}</p>)}<p>旧库清单以外 · {countText(data.newCounts)}</p><p>新图和当前查看优先；每处理4个此类任务，给旧库1次机会。不适配和未知来源不计作完成。</p></details>
    <details><summary>原因</summary>{Object.entries(data.reasons).map(([reason, count]) => <p key={reason}>{reasonLabel[reason] || '原因待确认'} · {count}</p>)}</details>
    {data.retrySummary && <p role="status">已重新排队 {data.retrySummary.queued} 项；仍需核对 {data.retrySummary.held} 项。未解除安全暂停。</p>}
  </>}
    {error && <p role="alert">{error}</p>}<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
      <button type="button" className="btn btn-secondary" title="刷新" aria-label="刷新高清状态" disabled={busy} onClick={() => void load()}><RefreshCw size={16} />刷新状态</button>
      <button type="button" className={data?.control.paused && data.canResume ? 'btn btn-primary' : 'btn btn-secondary'} disabled={busy || !data || safetyStop} onClick={() => void load(data?.control.paused ? 'resume' : 'pause')}>{data?.control.paused ? <Play size={16} /> : <Pause size={16} />}{data?.control.paused ? '继续准备' : '暂停准备'}</button>
      <button type="button" className="btn btn-secondary" disabled={busy || !data?.retryableCount} onClick={() => void load('retry')}><RotateCcw size={16} />重试临时失败{data?.retryableCount ? `（${data.retryableCount}）` : ''}</button>
    </div>
  </section>;
}
