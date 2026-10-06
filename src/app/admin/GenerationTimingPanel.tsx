'use client';

import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import type { GenerationTimingData, TimingMetric, TimingRow } from '@/lib/admin/generation-timing';
import styles from './GenerationTimingPanel.module.css';

const metrics: Array<{ key: TimingMetric; label: string; detail: string }> = [
  { key: 'completion', label: '任务完成', detail: '从系统建立生成任务开始，视频到记录生成完成，图片到保存完成。不含此前的描述分析、素材上传；含排队及视频状态回查延迟，不是纯模型耗时。' },
  { key: 'ready', label: '结果可下载', detail: '从系统建立生成任务到结果保存成功。只有完整保存时间的记录参与统计；历史补保存也计入等待。' },
  { key: 'delivery', label: '接收与保存', detail: '视频从生成完成记录到保存成功，图片从接口返回记录到保存完成。包含接收、下载、校验、保存和恢复等待。' },
];
const kindLabels = { video: '普通视频', enhance: '视频超分', image: '图片生成' };
const providerLabels: Record<string, string> = {
  seedance: 'Seedance', volcengine_ark: '火山方舟', volcengine_mediakit: '火山 MediaKit',
  aimediakit: 'AI MediaKit', ai_media_vip: 'AI Media VIP', musk: 'Musk',
};

export function formatElapsed(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '未记录';
  if (value === 0) return '0 秒';
  if (value < 1) return '<1 秒';
  const seconds = Math.round(value);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

function TimingTable({ rows, metric, models = false }: { rows: TimingRow[]; metric: TimingMetric; models?: boolean }) {
  return <div className={styles.scroll}>
    <table className={styles.table}>
      <thead><tr><th scope="col">{models ? '模型 / 线路' : '生成类型'}</th><th scope="col">有效记录 / 成功</th>
        <th scope="col">平均耗时</th><th scope="col">中位用时（50%）</th><th scope="col">90%完成用时</th><th scope="col">最长耗时</th></tr></thead>
      <tbody>{rows.map(row => {
        const value = row.metrics[metric];
        return <tr key={row.key}>
          <th scope="row"><strong>{models ? row.model || '模型未记录' : kindLabels[row.kind]}</strong>
            <small>{models ? `${kindLabels[row.kind]} · ${row.provider ? providerLabels[row.provider] || row.provider : '线路未记录'}`
              : `未完成 ${row.unfinished_count} · 失败/取消 ${row.failed_count}`}</small></th>
          <td>{value.sample_count} / {row.succeeded_count}<small>缺完整记录 {value.missing_count}</small></td>
          <td>{formatElapsed(value.average_seconds)}</td><td>{formatElapsed(value.median_seconds)}</td>
          <td>{formatElapsed(value.p90_seconds)}</td><td>{formatElapsed(value.longest_seconds)}</td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

export default function GenerationTimingPanel({ data }: { data: GenerationTimingData }) {
  const { user } = useAppSession();
  const storageKey = user ? `sd2:admin-generation-timing:v1:${user.id}` : null;
  const [metric, setMetric] = useState<TimingMetric>('completion');
  const [expanded, setExpanded] = useState(false);
  const [restoredKey, setRestoredKey] = useState<string | null>(null);
  useEffect(() => {
    if (!storageKey) return;
    let saved: { metric?: unknown; expanded?: unknown } | null = null;
    try { saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch {}
    setMetric(metrics.some(item => item.key === saved?.metric) ? saved!.metric as TimingMetric : 'completion');
    setExpanded(saved?.expanded === true); setRestoredKey(storageKey);
  }, [storageKey]);
  useEffect(() => {
    if (!storageKey || restoredKey !== storageKey) return;
    try { localStorage.setItem(storageKey, JSON.stringify({ metric, expanded })); } catch {}
  }, [storageKey, restoredKey, metric, expanded]);
  const selected = metrics.find(item => item.key === metric)!;
  return <section className={styles.panel} aria-labelledby="generation-timing-title">
    <div className={styles.header}>
      <h2 id="generation-timing-title">生成耗时</h2>
      <div className={styles.controls}>
        <div className={styles.modes} role="group" aria-label="耗时口径">
          {metrics.map(item => <button key={item.key} type="button" aria-pressed={metric === item.key}
            onClick={() => setMetric(item.key)}>{item.label}</button>)}
        </div>
        <button className={styles.reset} type="button" title="恢复默认耗时口径" aria-label="恢复默认耗时口径"
          onClick={() => { setMetric('completion'); setExpanded(false); }}><RotateCcw size={16} /></button>
      </div>
    </div>
    <p className={styles.note}>{selected.detail} 仅统计成功且有完整时间记录的任务。</p>
    <TimingTable rows={data.summary} metric={metric} />
    {!data.images_included && <p className={styles.note}>当前项目或视频清晰度筛选不适用于图片，未纳入图片统计。</p>}
    <details className={styles.details} open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>模型与线路明细（{data.models.length} 项）</summary>
      {data.models.length ? <TimingTable rows={data.models} metric={metric} models /> : <p className={styles.note}>当前范围暂无生成任务。</p>}
    </details>
  </section>;
}
