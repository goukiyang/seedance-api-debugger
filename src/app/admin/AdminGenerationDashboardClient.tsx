'use client';

import { useMemo, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { AlertTriangle, Download, RefreshCcw } from 'lucide-react';
import {
  formatAmountMicrosWithFixedCny,
  formatAmountMinorWithFixedCny,
} from '@/lib/costs/currency';
import { TaskVideoThumbnail } from '@/components/TaskVideoThumbnail';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import type {
  DashboardBreakdownItem,
  DashboardCurrencyTotal,
  DashboardRangeKey,
  DashboardTrendBucket,
  DashboardTrendGranularity,
  DashboardWarning,
  GenerationDashboardData,
} from '@/lib/admin/generation-dashboard';

type ProviderBalanceView = {
  amount: string;
  label: string;
  detail: string;
  source: string;
  sync: string;
  tone: string;
};

type QuickLink = {
  title: string;
  desc: string;
  href: string;
};

type QuickLinkGroup = {
  title: string;
  desc: string;
  links: QuickLink[];
};

type Props = {
  initialDashboard: GenerationDashboardData;
  providerBalance: ProviderBalanceView;
  quickLinks: QuickLinkGroup[];
};

const rangeOptions: Array<{ key: DashboardRangeKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'month', label: '本月' },
  { key: '7d', label: '7天' },
  { key: '30d', label: '30天' },
  { key: 'custom', label: '自定义' },
];

const trendGranularityOptions: Array<{ key: DashboardTrendGranularity; label: string; title: string }> = [
  { key: 'day', label: '按日', title: '每日生成量与成本' },
  { key: 'week', label: '按周', title: '每周生成量与成本' },
  { key: 'month', label: '按月', title: '每月生成量与成本' },
];

const integerFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const TREND_CHART_HEIGHT = 132;
const TREND_CHART_LEFT = 18;
const TREND_CHART_RIGHT_PADDING = 28;
const TREND_CHART_TOP = 22;
const TREND_CHART_BOTTOM = 96;
const TREND_BUCKET_WIDTH = 64;

function formatCurrencyTotals(totals: DashboardCurrencyTotal[], fallback = '待官方确认') {
  if (!totals.length) return fallback;
  return totals.map((item) => formatAmountMicrosWithFixedCny(item.amount_micros, item.currency)).join(' · ');
}

function formatCurrencyRates(totals: DashboardCurrencyTotal[], fallback = '暂无可算均价') {
  if (!totals.length) return fallback;
  return totals.map((item) => `${formatAmountMicrosWithFixedCny(item.amount_micros, item.currency)}/秒`).join(' · ');
}

function formatInteger(value: number) {
  return integerFormatter.format(Math.round(value));
}

function formatPoint(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatSeconds(value: number) {
  return `${formatInteger(value)} 秒`;
}

function statusLabel(status: string) {
  if (status === 'succeeded') return '已完成';
  if (status === 'failed') return '失败';
  if (status === 'running') return '生成中';
  if (status === 'submitted') return '排队中';
  if (status === 'cancelled') return '已取消';
  return status;
}

function taskOfficialCost(task: GenerationDashboardData['recent_tasks'][number]) {
  if (task.official_amount_micros !== null && task.official_amount_micros !== undefined) {
    return formatAmountMicrosWithFixedCny(task.official_amount_micros, task.official_currency);
  }
  if (task.official_amount_minor !== null && task.official_amount_minor !== undefined) {
    return formatAmountMinorWithFixedCny(task.official_amount_minor, task.official_currency);
  }
  return '待官方确认';
}

function dateTimeText(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function shortPrompt(value: string, length = 54) {
  return value.length > length ? `${value.slice(0, length)}...` : value;
}

function warningClass(warning: DashboardWarning) {
  if (warning.tone === 'danger') return 'is-danger';
  if (warning.tone === 'warning') return 'is-warning';
  return 'is-info';
}

function maxBreakdownCount(items: DashboardBreakdownItem[]) {
  return Math.max(1, ...items.map((item) => item.count));
}

const donutColors = ['#2563eb', '#22a06b', '#f59e0b', '#7c3aed', '#06b6d4', '#94a3b8'];
type DonutMetric = 'official_cost' | 'points' | 'count';

function officialMicrosTotal(item: DashboardBreakdownItem) {
  return item.official_costs.reduce((sum, total) => sum + total.amount_micros, 0);
}

function donutMetric(items: DashboardBreakdownItem[]): DonutMetric {
  if (items.some((item) => officialMicrosTotal(item) > 0)) return 'official_cost';
  if (items.some((item) => item.points > 0)) return 'points';
  return 'count';
}

function breakdownWeight(item: DashboardBreakdownItem, metric: DonutMetric) {
  if (metric === 'official_cost') return officialMicrosTotal(item);
  if (metric === 'points') return item.points;
  return item.count;
}

function breakdownWeightTotal(items: DashboardBreakdownItem[], metric: DonutMetric) {
  return items.reduce((sum, item) => sum + breakdownWeight(item, metric), 0);
}

function breakdownShare(item: DashboardBreakdownItem, items: DashboardBreakdownItem[]) {
  const metric = donutMetric(items);
  const total = breakdownWeightTotal(items, metric);
  if (total <= 0) return '0%';
  return `${((breakdownWeight(item, metric) / total) * 100).toFixed(1)}%`;
}

function donutGradient(items: DashboardBreakdownItem[]) {
  const metric = donutMetric(items);
  const total = breakdownWeightTotal(items, metric);
  if (total <= 0) return '#e2e8f0 0deg 360deg';

  let cursor = 0;
  return items
    .map((item, index) => {
      const start = cursor;
      const end = index === items.length - 1 ? 360 : cursor + (breakdownWeight(item, metric) / total) * 360;
      cursor = end;
      const color = donutColors[index % donutColors.length];
      return `${color} ${start.toFixed(2)}deg ${end.toFixed(2)}deg`;
    })
    .join(', ');
}

function DonutChart({
  items,
  centerLabel,
  centerValue,
  ariaLabel,
}: {
  items: DashboardBreakdownItem[];
  centerLabel: string;
  centerValue: string;
  ariaLabel: string;
}) {
  return (
    <div
      className="admin-dashboard-donut"
      role="img"
      aria-label={ariaLabel}
      style={{ '--donut-gradient': donutGradient(items) } as CSSProperties}
    >
      <div className="admin-dashboard-donut-center">
        <span>{centerLabel}</span>
        <strong>{centerValue}</strong>
      </div>
    </div>
  );
}

function DonutLegend({ items }: { items: DashboardBreakdownItem[] }) {
  return (
    <div className="admin-dashboard-donut-legend">
      {items.map((item, index) => (
        <Link className="admin-dashboard-donut-legend-row" href={item.href} key={item.key}>
          <span
            className="admin-dashboard-donut-color"
            style={{ backgroundColor: donutColors[index % donutColors.length] }}
            aria-hidden="true"
          />
          <span>
            <strong>
                      <UserIdentityBadge user={item.user || { id: item.key, name: item.label, username: null }} size="sm" />
                    </strong>
            <small>{item.count} 条 · {formatCurrencyTotals(item.official_costs)}</small>
          </span>
          <b>{breakdownShare(item, items)}</b>
        </Link>
      ))}
    </div>
  );
}

function trendOfficialMicros(bucket: DashboardTrendBucket) {
  return bucket.official_costs.reduce((sum, total) => sum + total.amount_micros, 0);
}

function mergeTrendOfficialCosts(buckets: DashboardTrendBucket[]) {
  const currencyMap = new Map<string, number>();
  buckets.forEach((bucket) => {
    bucket.official_costs.forEach((total) => {
      currencyMap.set(total.currency, (currencyMap.get(total.currency) || 0) + total.amount_micros);
    });
  });
  return Array.from(currencyMap.entries())
    .map(([currency, amountMicros]) => ({
      currency,
      amount_micros: amountMicros,
      amount_minor: Math.round(amountMicros / 10_000),
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

function formatTrendCostShort(bucket: DashboardTrendBucket) {
  if (!bucket.official_costs.length) return '';
  const [first] = bucket.official_costs;
  const amount = first.amount_micros / 1_000_000;
  const currency = first.currency.toUpperCase();
  if (currency === 'USD') return `$${amount.toFixed(2)}`;
  if (currency === 'CNY') return `¥${amount.toFixed(2)}`;
  return `${amount.toFixed(2)} ${currency}`;
}

function formatTrendBucketCost(bucket: DashboardTrendBucket) {
  if (bucket.official_costs.length) return formatCurrencyTotals(bucket.official_costs, '$0.00');
  return bucket.task_count > 0 ? '待官方确认' : '$0.00';
}

function trendBucketClass(bucket: DashboardTrendBucket) {
  if (bucket.official_costs.length) return 'has-cost';
  if (bucket.task_count > 0) return 'needs-cost';
  return 'is-empty';
}

function trendChartWidth(bucketCount: number) {
  return TREND_CHART_LEFT + TREND_CHART_RIGHT_PADDING + Math.max(1, bucketCount) * TREND_BUCKET_WIDTH;
}

function trendChartRight(chartWidth: number) {
  return chartWidth - TREND_CHART_RIGHT_PADDING;
}

function trendX(index: number) {
  return TREND_CHART_LEFT + index * TREND_BUCKET_WIDTH + TREND_BUCKET_WIDTH / 2;
}

function trendY(value: number, max: number) {
  if (max <= 0) return TREND_CHART_BOTTOM;
  return TREND_CHART_BOTTOM - (value / max) * (TREND_CHART_BOTTOM - TREND_CHART_TOP);
}

function trendPolyline(buckets: DashboardTrendBucket[], value: (bucket: DashboardTrendBucket) => number, max: number) {
  return buckets.map((bucket, index) => `${trendX(index)},${trendY(value(bucket), max)}`).join(' ');
}

function trendCostLabelY(y: number) {
  return y < TREND_CHART_TOP + 18 ? y + 15 : y - 7;
}

function TrendChart({ buckets }: { buckets: DashboardTrendBucket[] }) {
  const countMax = Math.max(1, ...buckets.map((bucket) => bucket.task_count));
  const secondsMax = Math.max(1, ...buckets.map((bucket) => bucket.duration_seconds));
  const costMax = Math.max(1, ...buckets.map(trendOfficialMicros));
  const chartWidth = trendChartWidth(buckets.length);
  const chartRight = trendChartRight(chartWidth);
  const barWidth = 26;
  const hasCost = buckets.some((bucket) => trendOfficialMicros(bucket) > 0);
  const hasSeconds = buckets.some((bucket) => bucket.duration_seconds > 0);

  return (
    <div className="admin-dashboard-trend-chart">
      <div className="admin-dashboard-trend-viewport">
        <svg
          className="admin-dashboard-trend-plot"
          width={chartWidth}
          height={TREND_CHART_HEIGHT}
          viewBox={`0 0 ${chartWidth} ${TREND_CHART_HEIGHT}`}
          role="img"
          aria-label={`生成次数、生成秒数和官方额度趋势图，共 ${buckets.length} 个时间桶`}
        >
          {[TREND_CHART_TOP, 40, 58, 76, TREND_CHART_BOTTOM].map((y) => (
            <line className="admin-dashboard-trend-gridline" key={y} x1={TREND_CHART_LEFT} x2={chartRight} y1={y} y2={y} />
          ))}
          {buckets.map((bucket, index) => {
            const x = trendX(index);
            const valueY = trendY(bucket.task_count, countMax);
            const barHeight = bucket.task_count > 0 ? TREND_CHART_BOTTOM - valueY : 2;
            const barY = bucket.task_count > 0 ? valueY : TREND_CHART_BOTTOM - barHeight;
            return (
              <g key={bucket.key}>
                <rect
                  className={`admin-dashboard-trend-bar ${bucket.task_count > 0 ? '' : 'is-empty'}`}
                  x={x - barWidth / 2}
                  y={barY}
                  width={barWidth}
                  height={barHeight}
                  rx="3"
                >
                  <title>{bucket.label}：{bucket.task_count} 次，{formatSeconds(bucket.duration_seconds)}，{formatTrendBucketCost(bucket)}</title>
                </rect>
                <text className="admin-dashboard-trend-count-label" x={x} y={Math.max(12, barY - 5)} textAnchor="middle">
                  {formatInteger(bucket.task_count)}
                </text>
              </g>
            );
          })}
          {hasSeconds && (
            <polyline
              className="admin-dashboard-trend-line is-seconds"
              points={trendPolyline(buckets, (bucket) => bucket.duration_seconds, secondsMax)}
            />
          )}
          {hasCost && (
            <polyline
              className="admin-dashboard-trend-line is-cost"
              points={trendPolyline(buckets, trendOfficialMicros, costMax)}
            />
          )}
          {buckets.map((bucket, index) => {
            const x = trendX(index);
            const costMicros = trendOfficialMicros(bucket);
            const costY = trendY(costMicros, costMax);
            const secondsY = trendY(bucket.duration_seconds, secondsMax);
            return (
              <g key={`${bucket.key}-points`}>
                {hasSeconds && (
                  <circle className="admin-dashboard-trend-dot is-seconds" cx={x} cy={secondsY} r="3.2">
                    <title>{bucket.label}：{formatSeconds(bucket.duration_seconds)}</title>
                  </circle>
                )}
                {hasCost && (
                  <circle className="admin-dashboard-trend-dot is-cost" cx={x} cy={costY} r="3.2">
                    <title>{bucket.label}：{formatTrendBucketCost(bucket)}</title>
                  </circle>
                )}
                {hasCost && costMicros > 0 && (
                  <text className="admin-dashboard-trend-node-label is-cost" x={x} y={trendCostLabelY(costY)} textAnchor="middle">
                    {formatTrendCostShort(bucket)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        <div
          className="admin-dashboard-trend-axis"
          aria-hidden="true"
          style={{
            width: chartWidth,
            gridTemplateColumns: `repeat(${Math.max(1, buckets.length)}, ${TREND_BUCKET_WIDTH}px)`,
            paddingLeft: TREND_CHART_LEFT,
            paddingRight: TREND_CHART_RIGHT_PADDING,
          }}
        >
          {buckets.map((bucket) => (
            <span key={bucket.key}>{bucket.label}</span>
          ))}
        </div>
      </div>
      <div className="admin-dashboard-trend-daily" aria-label="每日金额明细">
        {buckets.map((bucket) => (
          <div className={`admin-dashboard-trend-day ${trendBucketClass(bucket)}`} key={`${bucket.key}-daily`}>
            <span>{bucket.label}</span>
            <strong>{formatTrendBucketCost(bucket)}</strong>
            <small>{formatInteger(bucket.task_count)} 次 · {formatSeconds(bucket.duration_seconds)}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AdminGenerationDashboardClient({ initialDashboard, providerBalance, quickLinks }: Props) {
  const [dashboard, setDashboard] = useState(initialDashboard);
  const [range, setRange] = useState<DashboardRangeKey>(initialDashboard.range.key);
  const [dateFrom, setDateFrom] = useState(initialDashboard.range.date_from);
  const [dateTo, setDateTo] = useState(initialDashboard.range.date_to);
  const [trendGranularity, setTrendGranularity] = useState<DashboardTrendGranularity>(
    initialDashboard.range.key === 'all' ? 'month' : 'day',
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const queryString = useMemo(() => {
    const params = new URLSearchParams({ range });
    if (range === 'custom') {
      params.set('date_from', dateFrom);
      params.set('date_to', dateTo);
    }
    return params.toString();
  }, [dateFrom, dateTo, range]);

  const exportHref = `/api/admin/generation-dashboard/export?${queryString}`;

  const loadDashboard = async (nextRange = range) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ range: nextRange });
      if (nextRange === 'custom') {
        params.set('date_from', dateFrom);
        params.set('date_to', dateTo);
      }
      const res = await fetch(`/api/admin/generation-dashboard?${params.toString()}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '加载驾驶舱失败');
      setDashboard(data.dashboard);
      setRange(data.dashboard.range.key);
      setDateFrom(data.dashboard.range.date_from);
      setDateTo(data.dashboard.range.date_to);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载驾驶舱失败');
    } finally {
      setLoading(false);
    }
  };

  const maxMemberCount = maxBreakdownCount(dashboard.member_ranking);
  const trendBuckets = useMemo(
    () => dashboard.trends[trendGranularity] || [],
    [dashboard.trends, trendGranularity],
  );
  const trendSummary = useMemo(() => {
    const taskCount = trendBuckets.reduce((sum, bucket) => sum + bucket.task_count, 0);
    const durationSeconds = trendBuckets.reduce((sum, bucket) => sum + bucket.duration_seconds, 0);
    return {
      taskCount,
      durationSeconds,
      officialCosts: mergeTrendOfficialCosts(trendBuckets),
    };
  }, [trendBuckets]);
  const trendTitle = trendGranularityOptions.find((option) => option.key === trendGranularity)?.title || '生成量与成本';

  return (
    <div className="admin-generation-dashboard">
      <section className="admin-dashboard-toolbar" aria-label="驾驶舱时间范围">
        <div className="admin-dashboard-range-tabs">
          {rangeOptions.map((option) => (
            <button
              key={option.key}
              type="button"
              className={range === option.key ? 'is-active' : ''}
              onClick={() => {
                setRange(option.key);
                if (option.key === 'all') setTrendGranularity('month');
                if (option.key !== 'custom') void loadDashboard(option.key);
              }}
              disabled={loading}
            >
              {option.label}
            </button>
          ))}
        </div>
        {range === 'custom' && (
          <div className="admin-dashboard-date-range">
            <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
            <span>至</span>
            <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
            <button type="button" className="btn btn-secondary" onClick={() => void loadDashboard('custom')} disabled={loading}>
              应用
            </button>
          </div>
        )}
        <div className="admin-dashboard-actions">
          <button className="btn btn-secondary" type="button" onClick={() => void loadDashboard()} disabled={loading}>
            <RefreshCcw size={15} />
            {loading ? '刷新中' : '刷新'}
          </button>
          <Link className="btn btn-primary" href={exportHref}>
            <Download size={15} />
            导出当前口径
          </Link>
        </div>
      </section>

      {error && <div className="admin-dashboard-message is-danger">{error}</div>}

      <section className="admin-dashboard-kpi-grid" aria-label="本周期关键指标">
        <div className="admin-dashboard-kpi is-primary">
          <span>视频生成量</span>
          <strong>{dashboard.kpis.total_tasks}</strong>
          <small>{dashboard.range.label} · 成功 {dashboard.kpis.succeeded_tasks} · 失败 {dashboard.kpis.failed_tasks}</small>
        </div>
        <div className="admin-dashboard-kpi">
          <span>官方成本</span>
          <strong>{formatCurrencyTotals(dashboard.kpis.official_costs)}</strong>
          <small>已确认 {dashboard.kpis.official_cost_task_count} 条 · 待确认 {dashboard.kpis.pending_official_count}</small>
        </div>
        <div className="admin-dashboard-kpi">
          <span>平均单条官方成本</span>
          <strong>{formatCurrencyTotals(dashboard.kpis.average_official_costs)}</strong>
          <small>仅统计已有官方金额的任务</small>
        </div>
        <div className="admin-dashboard-kpi">
          <span>全量每秒均价</span>
          <strong>{formatCurrencyRates(dashboard.kpis.official_cost_per_second)}</strong>
          <small>按已确认官方成本的 {formatSeconds(dashboard.kpis.official_cost_duration_seconds)} 视频时长计算</small>
        </div>
        <Link className="admin-dashboard-kpi is-warning" href="/admin/costs">
          <span>异常待办</span>
          <strong>{dashboard.kpis.warning_count}</strong>
          <small>点击进入计费与成本复盘</small>
        </Link>
      </section>

      <section className="admin-dashboard-panel admin-dashboard-trend-panel">
        <div className="admin-dashboard-section-head">
          <div>
            <span className="admin-dashboard-kicker">趋势</span>
            <h2>{trendTitle}</h2>
          </div>
          <div className="admin-dashboard-segmented" role="tablist" aria-label="趋势统计粒度">
            {trendGranularityOptions.map((option) => (
              <button
                key={option.key}
                type="button"
                className={trendGranularity === option.key ? 'is-active' : ''}
                onClick={() => setTrendGranularity(option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="admin-dashboard-trend-summary">
          <span><strong>{formatInteger(trendSummary.taskCount)}</strong>生成次数</span>
          <span><strong>{formatSeconds(trendSummary.durationSeconds)}</strong>生成秒数</span>
          <span><strong>{formatCurrencyTotals(trendSummary.officialCosts, '待官方确认')}</strong>官方额度</span>
        </div>
        <div className="admin-dashboard-trend-legend" aria-label="趋势图例">
          <span className="is-count">生成次数</span>
          <span className="is-seconds">生成秒数</span>
          <span className="is-cost">官方额度</span>
        </div>
        <TrendChart buckets={trendBuckets} />
      </section>

      <section className="admin-dashboard-main-grid">
        <div className="admin-dashboard-panel admin-dashboard-project-share-panel">
          <div className="admin-dashboard-section-head">
            <div>
              <span className="admin-dashboard-kicker">项目</span>
              <h2>项目成本占比</h2>
            </div>
            <Link href="/admin/projects">项目管理</Link>
          </div>
          {dashboard.project_breakdown.length === 0 ? (
            <p className="admin-dashboard-empty">当前周期暂无项目数据。</p>
          ) : (
            <div className="admin-dashboard-donut-layout">
              <DonutChart
                items={dashboard.project_breakdown}
                centerLabel="总任务"
                centerValue={`${dashboard.project_breakdown.reduce((sum, item) => sum + item.count, 0)} 条`}
                ariaLabel="项目成本占比圆环图"
              />
              <DonutLegend items={dashboard.project_breakdown} />
            </div>
          )}
        </div>

        <div className="admin-dashboard-resolution-stage admin-dashboard-share-panel">
          <div className="admin-dashboard-section-head">
            <div>
              <span className="admin-dashboard-kicker">主成本维度</span>
              <h2>清晰度成本与秒价</h2>
            </div>
            <span>{dashboard.range.date_from} - {dashboard.range.date_to}</span>
          </div>
          <div className="admin-dashboard-donut-layout is-compact">
            <DonutChart
              items={dashboard.resolution_breakdown}
              centerLabel="总生成"
              centerValue={`${dashboard.kpis.total_tasks} 条`}
              ariaLabel="清晰度消耗占比圆环图"
            />
            <DonutLegend items={dashboard.resolution_breakdown} />
          </div>
          <div className="admin-dashboard-resolution-rate-list">
            {dashboard.resolution_breakdown.map((item) => (
              <Link className="admin-dashboard-resolution-rate-row" href={item.href} key={`${item.key}-rate`}>
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.count} 条 · {formatSeconds(item.duration_seconds)}</small>
                </span>
                <span>
                  <strong>{formatCurrencyRates(item.official_cost_per_second)}</strong>
                  <small>每秒均价 · 样本 {formatSeconds(item.official_cost_duration_seconds)}</small>
                </span>
              </Link>
            ))}
          </div>
        </div>

        <aside className={`admin-dashboard-balance admin-balance-strip-${providerBalance.tone}`}>
          <span className="admin-dashboard-kicker">Seedance 供应商余额</span>
          <strong>{providerBalance.amount}</strong>
          <p>{providerBalance.detail}</p>
          <div>
            <span>{providerBalance.label}</span>
            <span>{providerBalance.source}</span>
            <span>{providerBalance.sync}</span>
          </div>
          <Link className="btn btn-secondary" href="/admin/costs">更新余额</Link>
        </aside>
      </section>

      <section className="admin-dashboard-two-column">
        <div className="admin-dashboard-panel">
          <div className="admin-dashboard-section-head">
            <div>
              <span className="admin-dashboard-kicker">成员</span>
              <h2>成员效率排行</h2>
            </div>
            <Link href="/admin/users">用户与点数</Link>
          </div>
          {dashboard.member_ranking.length === 0 ? (
            <p className="admin-dashboard-empty">当前周期暂无成员数据。</p>
          ) : (
            <div className="admin-dashboard-breakdown-list">
              {dashboard.member_ranking.map((item) => (
                <Link className="admin-dashboard-breakdown-row" href={item.href} key={item.key}>
                  <div>
                    <strong>{item.label}</strong>
                    <span>{item.count} 条 · 成功 {item.succeeded} · 点数 {formatPoint(item.points)}</span>
                  </div>
                  <div className="admin-dashboard-row-meter" aria-hidden="true">
                    <span style={{ width: `${Math.max(6, (item.count / maxMemberCount) * 100)}%` }} />
                  </div>
                  <div>
                    <strong>{formatCurrencyTotals(item.official_costs)}</strong>
                    <span>点数 {formatPoint(item.points)}</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        <section className="admin-dashboard-warning-list" aria-label="异常预警">
          <div className="admin-dashboard-section-head">
            <div>
              <span className="admin-dashboard-kicker">风险</span>
              <h2>异常预警</h2>
            </div>
            <Link href="/admin/costs">处理成本异常</Link>
          </div>
          {dashboard.warnings.length === 0 ? (
            <p className="admin-dashboard-empty">当前周期暂无异常预警。</p>
          ) : (
            dashboard.warnings.map((warning) => (
              <Link className={`admin-dashboard-warning ${warningClass(warning)}`} href={warning.href} key={warning.id}>
                <AlertTriangle size={18} />
                <div>
                  <strong>{warning.title}</strong>
                  <span>{warning.detail}</span>
                </div>
                <b>{warning.count}</b>
              </Link>
            ))
          )}
        </section>
      </section>

      <section className="admin-dashboard-panel">
        <div className="admin-dashboard-section-head">
          <div>
            <span className="admin-dashboard-kicker">明细</span>
            <h2>最近生成记录</h2>
          </div>
          <Link href="/admin/outputs">全部产出</Link>
        </div>
        <div className="admin-dashboard-recent-table">
          <div className="admin-dashboard-recent-head">
            <span>截图</span>
            <span>任务</span>
            <span>归属</span>
            <span>规格</span>
            <span>官方成本</span>
            <span>点数</span>
            <span>状态</span>
          </div>
          {dashboard.recent_tasks.length === 0 ? (
            <p className="admin-dashboard-empty">当前周期暂无生成记录。</p>
          ) : (
            dashboard.recent_tasks.map((task) => (
              <Link className="admin-dashboard-recent-row" href={task.href} key={task.id}>
                <span>
                  <TaskVideoThumbnail
                    taskId={task.id}
                    localVideoPath={task.local_video_path}
                    resultVideoUrl={task.result_video_url}
                    resultLastFrameUrl={task.result_last_frame_url}
                    status={task.local_status}
                    provider={task.provider}
                    generationMode={task.generation_mode}
                    size="compact"
                  />
                </span>
                <span>
                  <strong>{shortPrompt(task.prompt || task.id)}</strong>
                  <small>{dateTimeText(task.created_at)}</small>
                </span>
                <span>
                  <strong>{task.project?.name || '未归属项目'}</strong>
                  <small>
                    <UserIdentityBadge user={task.owner} size="sm" />
                  </small>
                </span>
                <span>{task.resolution === 'unknown' ? '未记录' : task.resolution} · {task.duration ? `${task.duration}s` : '-'} · {task.ratio || '-'}</span>
                <span>{taskOfficialCost(task)}</span>
                <span>{task.actual_cost !== null && task.actual_cost !== undefined ? formatPoint(task.actual_cost) : '未记录'}</span>
                <span>{statusLabel(task.local_status)}</span>
              </Link>
            ))
          )}
        </div>
      </section>

      <section className="admin-dashboard-bottom-grid">
        <div className="admin-dashboard-panel">
          <div className="admin-dashboard-section-head">
            <div>
              <span className="admin-dashboard-kicker">入口</span>
              <h2>管理入口</h2>
            </div>
          </div>
          <div className="admin-dashboard-quick-links">
            {quickLinks.map((group) => (
              <section className="admin-dashboard-quick-group" key={group.title}>
                <div>
                  <strong>{group.title}</strong>
                  <span>{group.desc}</span>
                </div>
                <div className="admin-dashboard-quick-group-links">
                  {group.links.map((link) => (
                    <Link href={link.href} key={link.href}>
                      <strong>{link.title}</strong>
                      <span>{link.desc}</span>
                    </Link>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
        <div className="admin-dashboard-data-notes">
          <div className="admin-dashboard-section-head">
            <div>
              <span className="admin-dashboard-kicker">口径</span>
              <h2>数据口径</h2>
            </div>
          </div>
          <ul>
            {dashboard.data_notes.map((note) => <li key={note}>{note}</li>)}
          </ul>
        </div>
      </section>
    </div>
  );
}
