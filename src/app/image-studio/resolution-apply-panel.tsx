'use client';

import { RefreshCw, RotateCcw, Square } from 'lucide-react';
import { RelativeTime } from '@/components/RelativeTime';
import type { useResolutionApply } from './use-resolution-apply';
import styles from './studio.module.css';

const phaseNames = { preview: '待确认', defaultConfirmed: '默认值已保存，旧模板待应用', applying: '正在应用', partial: '已结束，有模板冲突',
  complete: '已完成', paused: '通用设置已变化，旧批次已暂停', cancelled: '剩余条目已停止', restoring: '正在撤销已应用条目', restored: '撤销已结束' };
const buckets = { change: '将改', unchanged: '已是目标', reproduction: '复现保护', dirty: '未保存草稿', unsupported: '模型不支持' };
export function ResolutionApplyPanel({ batch, onRestore, onContinue }: { batch: ReturnType<typeof useResolutionApply>; onRestore: () => void; onContinue: () => void }) {
  const receipt = batch.value;
  const operation = receipt?.operation;
  return <div className={styles.resolutionApply}>
    {batch.history.length > 0 && <label>已有操作<select aria-label="查询已有分辨率操作" value={operation?.requestId || ''} disabled={batch.busy}
      onChange={event => { if (event.target.value) void batch.query(event.target.value); }}>
      <option value="">选择操作</option>{batch.history.map(item => <option key={item.requestId} value={item.requestId}>{item.resolution} · {phaseNames[item.phase]} · {item.requestId.slice(0, 8)}</option>)}
    </select></label>}
    {operation && <>
      <p role="status"><strong>{phaseNames[operation.phase]}</strong> · {operation.resolution} · <RelativeTime value={new Date(operation.createdAt).toISOString()} /></p>
      <p>全部 {operation.counts.total} · 将改 {operation.counts.change} · 已是目标 {operation.counts.unchanged} · 复现保护 {operation.counts.reproduction} · 未保存草稿 {operation.counts.dirty} · 不支持 {operation.counts.unsupported}</p>
      {operation.globalRevision !== undefined && <p>默认值已保存。已有模板已改 {operation.counts.applied}/{operation.counts.change} · 冲突 {operation.counts.conflicts}；撤销 {operation.counts.restored}/{operation.counts.applied} · 撤销冲突 {operation.counts.restoreConflicts}</p>}
      <details><summary>查看模板清单</summary><ul className={styles.resolutionTargets}>{receipt.entries.map(entry => <li key={entry.id}>
        <strong>{entry.name}</strong><span>{entry.resolution} → {operation.resolution} · {buckets[entry.bucket]}{entry.result ? ` · ${entry.result === 'applied' ? '已应用' : '冲突'}` : ''}{entry.restoreResult ? ` · ${entry.restoreResult === 'restored' ? '已撤销' : '撤销冲突'}` : ''}</span>
        {(entry.reason || entry.restoreReason) && <small>{entry.restoreReason || entry.reason}</small>}
      </li>)}</ul>{receipt.nextCursor !== null && <button type="button" disabled={batch.busy} onClick={() => void batch.more()}>下一页</button>}</details>
      <div className={styles.resolutionActions}>
        <button type="button" title="查询操作结果" disabled={batch.busy} onClick={() => void batch.query()}><RefreshCw size={16} />查询结果</button>
        {['defaultConfirmed', 'applying'].includes(operation.phase) && <button type="button" className={styles.primary} disabled={batch.busy} onClick={onContinue}>继续应用</button>}
        {batch.busy && <button type="button" onClick={batch.stop}><Square size={14} />本批结束后暂停</button>}
        {!['complete', 'partial', 'cancelled', 'restored', 'restoring'].includes(operation.phase) && <button type="button" disabled={batch.busy} onClick={() => void batch.cancel()}>停止剩余条目</button>}
        {operation.counts.applied > operation.counts.restored + operation.counts.restoreConflicts && <button type="button" disabled={batch.busy} onClick={onRestore}><RotateCcw size={16} />撤销已应用</button>}
      </div>
      {operation.phase === 'preview' && !batch.canCommit && <p className={styles.muted}>原预览草稿未保留或已改变。停止旧操作后重新预览，不会改动已有模板。</p>}
    </>}
    {batch.scope && (!operation || ['complete', 'partial', 'cancelled', 'restored'].includes(operation.phase)) && <button type="button" disabled={batch.busy} onClick={() => void batch.prepare()}>预览我的已有模板</button>}
    {batch.error && <p role="alert" className={styles.error}>{batch.error}<button type="button" disabled={batch.busy} onClick={() => void batch.query()}><RefreshCw size={16} />查询原操作</button></p>}
  </div>;
}
