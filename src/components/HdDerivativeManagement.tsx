'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play, RefreshCw, RotateCcw } from 'lucide-react';
import { RelativeTime } from './RelativeTime';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import type { HdControl, HdResourceSample } from '@/lib/media/hd-resource-state';
import styles from './HdDerivativeManagement.module.css';
type Counts = Record<string, number>;
type Status = { total: number; counts: Counts; reasons: Counts; control: HdControl;
  batches: Array<{ id: string; knownLocalOriginals: number; counts: Counts; notQueued: number; remoteVersionUnknown: number; unavailable: number }>;
  newCounts: Counts; lastSuccessAt?: string | null; lastProgressAt?: string | null; stalled?: boolean;
  resource?: HdResourceSample | null; waitSince?: string | null; isolation?: { total: number; retrying: number; held: number };
  discovery?: { checkedAt: string; current: boolean | null };
  canResume: boolean; retryableCount: number; retrySummary?: { queued: number; held: number } };
const reasonLabel: Record<string, string> = { admin_pause: '管理员暂停', operator_pause: '操作员暂停', capacity_guard: '剩余空间不足', load_guard: '服务器忙碌', multi_frame: '多帧原件', pixel_limit: '像素数量超限', high_bit_depth: '高位深原件', wide_gamut: '色彩范围不适用', unverified_color_profile: '色彩配置未确认', existing_webp: '已有WebP，保留原件', original_smaller: '原件更小，使用原件', source_changed: '原件版本已变化', decode_or_source_failed: '读取或解码失败', temporary_io: '临时读取失败', output_integrity: '新文件校验异常', published_integrity: '已准备文件异常', discovery_source_failure: '新原件读取异常', retry_limit: '自动重试已用尽', worker_integrity_failure: '后台文件或读取状态异常' };
const countText = (value: Counts) => `可用 ${value.ready} · 等待 ${value.queued} · 处理中 ${value.running} · 失败 ${value.failed} · 不适配 ${value.skipped}`;
Object.assign(reasonLabel, { load_guard: '上次资源检查触发暂停', resource_wait: '等待服务器空闲', resource_sample_unknown: '暂时无法确认服务器资源', storage_check_unknown: '无法确认存储安全', source_missing: '原件暂时找不到', source_unreadable: '这张原件暂时无法读取', source_incompatible: '原件格式不适配', hd_publish_control_hold: '新文件等待安全核对', worker_interrupted: '上次处理中断' });
type Expanded = { batches: boolean; reasons: boolean };
const collapsed: Expanded = { batches: false, reasons: false };
export function HdDerivativeManagement() {
  const { user, hasLoadedUser, userLoadError, sessionChanged } = useAppSession();
  const account = hasLoadedUser && !userLoadError && !sessionChanged && !isClientSessionBlocked() && user?.role === 'admin' ? user.id : '';
  const [snapshot, setData] = useState<Status | null>(null), [snapshotOwner, setSnapshotOwner] = useState('');
  const data = account && snapshotOwner === account ? snapshot : null;
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Expanded>(collapsed), [preferenceOwner, setPreferenceOwner] = useState('');
  const lock = useRef(false), owner = useRef(account), valueRef = useRef(data);
  const sequence = useRef(0), activeRequest = useRef<AbortController | null>(null);
  owner.current = account; valueRef.current = data;
  const preferenceKey = account ? `sd2:hd-management:v1:${account}` : '';
  const load = useCallback(async (action?: string) => {
    const expectedOwner = account;
    if (!expectedOwner || isClientSessionBlocked() || lock.current) return;
    const requestId = ++sequence.current, controller = new AbortController();
    activeRequest.current = controller;
    const currentSession = () => !controller.signal.aborted && requestId === sequence.current && owner.current === expectedOwner && !isClientSessionBlocked();
    lock.current = true; setBusy(true); setError('');
    try {
      let token = valueRef.current?.control.token;
      if (action) {
        // Resource observations can change while the page is open. Take a fresh
        // read for this one explicit action; a conflicting POST is never replayed.
        const current = await fetch('/api/admin/hd-derivatives', { cache: 'no-store', signal: controller.signal });
        const latest = await current.json();
        if (!currentSession()) return;
        if (!current.ok) throw new Error(latest.error || '暂时无法确认状态');
        token = latest.control.token; setData(latest); setSnapshotOwner(expectedOwner);
      }
      // This synchronous check also closes the GET-to-POST gap before the
      // provider has re-rendered after a cross-tab logout/switch.
      if (!currentSession()) return;
      const response = await fetch('/api/admin/hd-derivatives', action ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, token }), signal: controller.signal } : { cache: 'no-store', signal: controller.signal });
      const value = await response.json();
      if (!currentSession()) return;
      if (!response.ok) throw new Error(value.error || '读取失败'); setData(value); setSnapshotOwner(expectedOwner);
    } catch (cause) { if (currentSession()) setError(cause instanceof Error ? cause.message : '暂时无法确认，请刷新状态后再操作'); }
    finally { if (requestId === sequence.current) { lock.current = false; activeRequest.current = null; if (owner.current === expectedOwner) setBusy(false); } }
  }, [account]);
  useEffect(() => {
    setData(null); setSnapshotOwner(''); setError(''); setBusy(false); setExpanded(collapsed); setPreferenceOwner('');
    if (!preferenceKey) return;
    try { const saved = JSON.parse(localStorage.getItem(preferenceKey) || '{}'); setExpanded({ batches: saved.batches === true, reasons: saved.reasons === true }); } catch { /* Invalid preference falls back safely. */ }
    setPreferenceOwner(preferenceKey);
  }, [preferenceKey]);
  useEffect(() => {
    if (preferenceOwner !== preferenceKey || !preferenceKey) return;
    try { localStorage.setItem(preferenceKey, JSON.stringify(expanded)); } catch { /* Controls remain available. */ }
  }, [expanded, preferenceKey, preferenceOwner]);
  useEffect(() => {
    if (!account || isClientSessionBlocked()) return;
    void load(); const interval = setInterval(() => { if (!document.hidden && !isClientSessionBlocked()) void load(); }, 30_000);
    return () => { clearInterval(interval); sequence.current++; activeRequest.current?.abort(); activeRequest.current = null; lock.current = false; };
  }, [account, load]);
  const state = data?.control.state;
  const hardStop = state === 'hard_pause' && data?.control.reason !== 'load_guard';
  const pending = Boolean(data && data.counts.queued + data.counts.running > 0);
  const discoveryAge = data?.discovery ? Date.now() - Date.parse(data.discovery.checkedAt) : NaN;
  const discoveryCurrent = discoveryAge >= 0 && discoveryAge <= 90_000 ? data?.discovery?.current : null;
  const label = state === 'manual_pause' ? '管理员已暂停' : state === 'hard_pause' ? '需要处理异常'
    : data && !pending ? discoveryCurrent === true ? '当前没有待准备项'
      : discoveryCurrent === false ? '新图片等待登记' : '新图片登记状态待确认'
    : state === 'resource_wait' ? '等待服务器空闲，将自动继续' : data?.counts.running ? '正在准备' : '正在等待下一项准备';
  const sampleLabel = data?.resource?.result === 'safe' ? (pending && state === 'resource_wait' ? '资源已回落，正在确认稳定' : '上次检查资源正常')
    : data?.resource?.result === 'busy' ? '上次检查服务器忙碌' : data?.resource?.result === 'unsafe' ? '存储安全检查未通过' : '资源状态待确认';
  function toggle(key: keyof Expanded, open: boolean) { setExpanded(value => value[key] === open ? value : { ...value, [key]: open }); }
  return <section className={styles.section} aria-labelledby="hd-management-title" aria-busy={busy}><h2 id="hd-management-title">高清图准备</h2>
    {!data && !error && <p role="status">{sessionChanged || isClientSessionBlocked() ? '账号已退出，请刷新页面重新确认账号。' : '正在读取准备状态…'}</p>}{data && <>
    <p className={styles.state}><strong>{label}</strong><span>{data.total} 个作业</span></p>
    <p>{countText(data.counts)}</p>
    <div className={styles.times}><p>最新检查：{sampleLabel}{data.resource && <> · <RelativeTime value={data.resource.checkedAt} /></>}</p>
      {data.waitSince && <p>开始等待：<RelativeTime value={data.waitSince} /></p>}
      <p>最后成功：{data.lastSuccessAt ? <RelativeTime value={data.lastSuccessAt} /> : '尚无成功记录'} · 最后处理进展：{data.lastProgressAt ? <RelativeTime value={data.lastProgressAt} /> : '尚无处理记录'}</p></div>
    {state === 'resource_wait' && pending && <p role="status">后台会自动复核。资源持续稳定后继续准备，原图仍可查看和下载。</p>}
    {state === 'manual_pause' && <p>重新检查后会按当前资源决定继续或等待；不会重发图片生成。</p>}
    {data.control.reason === 'load_guard' && <p role="status">上次资源检查留下了暂停。重新检查会先确认当前资源和安全状态，再进入自动等待。</p>}
    {hardStop && <p role="status">{reasonLabel[data.control.reason || ''] || '暂停原因待核对'}。请由维护人员处理异常后核对恢复。原图仍可查看和下载。</p>}
    {data.stalled && <p role="status">仍有待处理图片，超过10分钟没有处理进展。请核对最新检查和暂停原因，或重新检查；服务在线不代表正在处理。</p>}
    {!!data.isolation?.total && <p>单张原件待处理 {data.isolation.total} 项，其中自动复核 {data.isolation.retrying} 项、需人工核对 {data.isolation.held} 项。其余正常图片继续按队列准备。</p>}
    <details open={preferenceOwner === preferenceKey && expanded.batches} onToggle={event => toggle('batches', event.currentTarget.open)}><summary>旧库与新增任务</summary>{data.batches.map(batch => <p key={batch.id}>旧库 · 已盘点 {batch.knownLocalOriginals} 个本地原件 · {countText(batch.counts)} · 未入队 {batch.notQueued} · 远程版本未知 {batch.remoteVersionUnknown} · 无法读取 {batch.unavailable}</p>)}<p>旧库清单以外 · {countText(data.newCounts)}</p><p>新图和当前查看优先；每处理4个此类任务，给旧库1次机会。不适配和未知来源不计作完成。</p></details>
    <details open={preferenceOwner === preferenceKey && expanded.reasons} onToggle={event => toggle('reasons', event.currentTarget.open)}><summary>处理原因</summary>{Object.entries(data.reasons).map(([reason, count]) => <p key={reason}>{reasonLabel[reason] || '原因待确认'} · {count}</p>)}<button type="button" className="btn btn-secondary" onClick={() => setExpanded(collapsed)}>收起详情</button></details>
    {data.retrySummary && <p role="status">已重新排队 {data.retrySummary.queued} 项；仍需核对 {data.retrySummary.held} 项。未解除安全暂停。</p>}
  </>}
    {error && <p role="alert">{error}</p>}<div className={styles.actions}>
      <button type="button" className={data?.canResume ? 'btn btn-primary' : 'btn btn-secondary'} disabled={busy || !data || hardStop} onClick={() => void load('recheck')}><Play size={16} />{busy ? '正在核对…' : '重新检查并继续'}</button>
      <button type="button" className="btn btn-secondary" disabled={busy || !data || state === 'manual_pause' || hardStop} onClick={() => void load('pause')}><Pause size={16} />暂停准备</button>
      <button type="button" className="btn btn-secondary" title="刷新" aria-label="刷新高清状态" disabled={busy || !account || isClientSessionBlocked()} onClick={() => void load()}><RefreshCw size={16} />刷新状态</button>
      <button type="button" className="btn btn-secondary" disabled={busy || !data?.retryableCount} onClick={() => void load('retry')}><RotateCcw size={16} />重试临时失败{data?.retryableCount ? `（${data.retryableCount}）` : ''}</button>
    </div>
  </section>;
}
