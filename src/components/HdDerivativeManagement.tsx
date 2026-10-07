'use client';
import { useEffect, useState } from 'react';
import { Pause, Play, RefreshCw, RotateCcw } from 'lucide-react';
type Status = { total: number; counts: Record<string, number>; reasons: Record<string, number>; control: { paused: boolean; reason?: string }; batches: Array<{ id: string; knownLocalOriginals: number; counts: Record<string, number>; notQueued: number; remoteVersionUnknown: number; unavailable: number }>; newCounts: Record<string, number> };
const reasonLabel: Record<string, string> = { admin_pause: '管理员暂停', operator_pause: '操作员暂停', capacity_guard: '剩余空间不足', load_guard: '服务器忙碌', multi_frame: '多帧原件', pixel_limit: '像素数量超限', high_bit_depth: '高位深原件', wide_gamut: '色彩范围不适用', unverified_color_profile: '色彩配置未确认', existing_webp: '已有WebP，保留原件', original_smaller: '原件更小，使用原件', source_changed: '原件版本已变化', decode_or_source_failed: '读取或解码失败', temporary_io: '临时读取失败', output_integrity: '新文件校验异常', published_integrity: '已准备文件异常', discovery_source_failure: '新原件读取异常', retry_limit: '自动重试已用尽' };
export function HdDerivativeManagement() {
  const [data, setData] = useState<Status | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function load(action?: string) {
    setBusy(true); setError('');
    try { const response = await fetch('/api/admin/hd-derivatives', action ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) } : { cache: 'no-store' });
      const value = await response.json(); if (!response.ok) throw new Error(value.error || '读取失败'); setData(value);
    } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  return <section><h2>高清图准备</h2>{data && <><p>{data.control.paused ? `已暂停 · ${reasonLabel[data.control.reason || ''] || '原因待确认'}` : '后台准备已开启'} · {data.total} 个作业</p><p>可用 {data.counts.ready} · 等待 {data.counts.queued} · 处理中 {data.counts.running} · 失败 {data.counts.failed} · 跳过 {data.counts.skipped}</p>{data.batches.map(batch => <p key={batch.id}>旧库 · 已盘点 {batch.knownLocalOriginals} 个本地原件 · 可用 {batch.counts.ready} · 等待 {batch.counts.queued + batch.counts.running + batch.notQueued} · 失败 {batch.counts.failed} · 跳过 {batch.counts.skipped} · 远程版本未知 {batch.remoteVersionUnknown} · 无法读取 {batch.unavailable}</p>)}<p>本次旧库以外 · 可用 {data.newCounts.ready} · 等待 {data.newCounts.queued + data.newCounts.running}</p><details><summary>原因</summary>{Object.entries(data.reasons).map(([reason, count]) => <p key={reason}>{reasonLabel[reason] || '原因待确认'} · {count}</p>)}</details></>}
    {error && <p role="alert">{error}</p>}<button title="刷新" aria-label="刷新高清状态" disabled={busy} onClick={() => void load()}><RefreshCw size={16} /></button><button disabled={busy || !data} onClick={() => void load(data?.control.paused ? 'resume' : 'pause')}>{data?.control.paused ? <Play size={16} /> : <Pause size={16} />}{data?.control.paused ? '继续准备' : '暂停准备'}</button><button disabled={busy || !data?.counts.failed} onClick={() => void load('retry')}><RotateCcw size={16} />重试失败项</button>
  </section>;
}
