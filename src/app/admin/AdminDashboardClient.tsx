'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { SessionUser } from '@/lib/auth/session';

interface DashboardTaskUser {
  id: string;
  name: string;
  username: string;
  email: string;
}

interface DashboardTask {
  id: string;
  provider: string;
  model: string;
  prompt: string;
  resolution: string | null;
  duration: number | null;
  local_status: string;
  provider_status: string | null;
  estimated_cost: number | null;
  actual_cost: number | null;
  frozen_cost: number | null;
  refund_amount: number | null;
  created_at: string;
  completed_at: string | null;
  user: DashboardTaskUser | null;
  attention_flags: {
    abnormal: boolean;
    still_frozen: boolean;
    long_frozen: boolean;
    refund_relevant: boolean;
  };
  latest_operation: {
    action: string;
    detail: string | null;
    created_at: string;
    operator?: { id: string; name: string; username: string } | null;
  } | null;
}

interface DashboardFlowPoint {
  date: string;
  created_count: number;
  completed_count: number;
  failed_count: number;
  cancelled_count: number;
}

interface DashboardData {
  generated_at: string;
  summary: {
    attention_now_count: number;
    abnormal_count: number;
    still_frozen_count: number;
    long_frozen_count: number;
    failed_count: number;
    refund_relevant_count: number;
    submitted_count: number;
    running_count: number;
  };
  queue_snapshot: {
    submitted_count: number;
    running_count: number;
    created_24h_count: number;
    completed_24h_count: number;
    failed_24h_count: number;
    cancelled_24h_count: number;
  };
  recent_tasks: DashboardTask[];
  recent_flow: DashboardFlowPoint[];
  credit_usage: {
    total_accounts: number;
    total_balance: number;
    total_frozen: number;
    current_monthly_used_field_total: number;
    total_used: number;
    accounts_with_frozen_count: number;
    at_risk_account_count: number;
    deducted_7d: number;
    refunded_7d: number;
    granted_7d: number;
    top_usage_users: Array<{
      user_id: string;
      user: DashboardTaskUser | null;
      balance: number;
      frozen_credits: number;
      monthly_used: number;
      total_used: number;
    }>;
  };
  quick_links: {
    users_total_count: number;
    disabled_user_count: number;
    active_resource_count: number;
    disabled_resource_count: number;
    active_pricing_rule_count: number;
    disabled_pricing_rule_count: number;
  };
}

const surfaceStyle: React.CSSProperties = {
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 8,
  background: 'rgba(255,255,255,0.03)',
};

const actionLinkStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 8,
  padding: '10px 14px',
  color: '#fff',
  textDecoration: 'none',
  background: 'rgba(255,255,255,0.06)',
  fontWeight: 700,
};

function formatDateTime(value: string | null) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN');
}

function formatCredits(value: number | null | undefined) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '-';
  return value.toFixed(2);
}

function formatStatus(status: string) {
  const labels: Record<string, string> = {
    draft: '草稿',
    submitted: '已提交',
    running: '运行中',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };
  return labels[status] || status;
}

function MetricCard({
  href,
  label,
  value,
  detail,
  tone,
}: {
  href: string;
  label: string;
  value: number;
  detail: string;
  tone: string;
}) {
  return (
    <Link href={href} style={{ ...surfaceStyle, padding: 16, color: '#fff', textDecoration: 'none', borderColor: tone }}>
      <div style={{ color: 'rgba(255,255,255,0.58)', fontSize: 13, marginBottom: 10 }}>{label}</div>
      <div style={{ fontSize: 30, fontWeight: 800, marginBottom: 10 }}>{value}</div>
      <div style={{ color: 'rgba(255,255,255,0.74)', fontSize: 13, lineHeight: 1.5 }}>{detail}</div>
    </Link>
  );
}

function QueueStat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div style={{ ...surfaceStyle, padding: 14 }}>
      <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, marginBottom: 8 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <div style={{ fontSize: 24, fontWeight: 800 }}>{value}</div>
        <div style={{ width: 10, height: 10, borderRadius: 999, background: tone }} />
      </div>
    </div>
  );
}

function AttentionBadges({ task }: { task: DashboardTask }) {
  const badges = [
    task.attention_flags.abnormal ? '已标记异常' : null,
    task.attention_flags.long_frozen ? '长时间冻结' : null,
    task.attention_flags.still_frozen ? '仍有冻结' : null,
    task.attention_flags.refund_relevant ? '退款相关' : null,
  ].filter(Boolean);

  if (badges.length === 0) {
    return <span style={{ color: 'rgba(255,255,255,0.42)' }}>无异常标记</span>;
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {badges.map((badge) => (
        <span key={badge} style={{ padding: '4px 8px', borderRadius: 999, background: 'rgba(99,102,241,0.14)', color: '#c7d2fe', fontSize: 12 }}>
          {badge}
        </span>
      ))}
    </div>
  );
}

export default function AdminDashboardClient({ currentUser }: { currentUser: SessionUser }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    void loadDashboard();
  }, []);

  async function loadDashboard() {
    setLoading(true);
    setError('');

    try {
      const response = await fetch('/api/admin/dashboard', { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '加载仪表盘失败');
      setData(body);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载仪表盘失败');
    } finally {
      setLoading(false);
    }
  }

  const flowMax = useMemo(() => {
    return Math.max(1, ...(data?.recent_flow || []).map((item) => item.created_count));
  }, [data]);

  return (
    <main style={{ minHeight: '100vh', background: '#0f0f13', color: '#fff', padding: 24 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
        <div>
          <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 13 }}>管理员后台</div>
          <h1 style={{ margin: '4px 0 8px', fontSize: 30 }}>控制台首页</h1>
          <div style={{ color: 'rgba(255,255,255,0.62)', maxWidth: 760, lineHeight: 1.6 }}>
            先看异常、冻结和退款风险，再跳转到任务、点数、资源和定价处理现场。这里只展示能直接指导操作的信号。
          </div>
        </div>
        <div style={{ display: 'grid', gap: 10, justifyItems: 'end' }}>
          <div style={{ color: 'rgba(255,255,255,0.62)', fontSize: 13, textAlign: 'right' }}>
            <div>{currentUser.name} · {currentUser.email}</div>
            <div style={{ marginTop: 4 }}>
              {data ? `更新于 ${formatDateTime(data.generated_at)}` : '正在读取最新状态'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <Link href="/admin/tasks?attention=exceptions" style={actionLinkStyle}>异常任务台</Link>
            <Link href="/admin/users" style={actionLinkStyle}>用户与点数</Link>
            <Link href="/admin/resources" style={actionLinkStyle}>资源</Link>
            <Link href="/admin/pricing" style={actionLinkStyle}>计费规则</Link>
            <button type="button" onClick={() => void loadDashboard()} style={{ ...actionLinkStyle, cursor: 'pointer' }}>刷新</button>
          </div>
        </div>
      </header>

      {error ? (
        <div style={{ ...surfaceStyle, padding: 16, marginBottom: 16, color: '#fca5a5', borderColor: 'rgba(248,113,113,0.35)' }}>
          {error}
        </div>
      ) : null}

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 12, marginBottom: 16 }}>
        <MetricCard
          href="/admin/tasks?attention=exceptions"
          label="当前待处理异常"
          value={data?.summary.attention_now_count || 0}
          detail="把已标记异常、失败、长冻结和退款相关任务汇在一个入口。"
          tone="rgba(239,68,68,0.42)"
        />
        <MetricCard
          href="/admin/tasks?attention=abnormal"
          label="已标记异常"
          value={data?.summary.abnormal_count || 0}
          detail="进入已人工标记的问题任务，继续复查、备注或转失败。"
          tone="rgba(249,115,22,0.42)"
        />
        <MetricCard
          href="/admin/tasks?attention=frozen&frozen=1"
          label="仍冻结任务"
          value={data?.summary.still_frozen_count || 0}
          detail="查看仍占用冻结点数的任务，优先释放卡住的成本。"
          tone="rgba(59,130,246,0.42)"
        />
        <MetricCard
          href="/admin/tasks?attention=frozen&frozen=1"
          label="长时间冻结"
          value={data?.summary.long_frozen_count || 0}
          detail="超过 2 小时仍冻结，适合优先人工介入。"
          tone="rgba(234,179,8,0.42)"
        />
        <MetricCard
          href="/admin/tasks?attention=refund"
          label="退款相关"
          value={data?.summary.refund_relevant_count || 0}
          detail="失败、长冻结或已扣费未见退款的任务。"
          tone="rgba(16,185,129,0.42)"
        />
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: 12, marginBottom: 16 }}>
        <QueueStat label="待提交 / 排队" value={data?.queue_snapshot.submitted_count || 0} tone="#93c5fd" />
        <QueueStat label="运行中" value={data?.queue_snapshot.running_count || 0} tone="#818cf8" />
        <QueueStat label="近 24h 新建" value={data?.queue_snapshot.created_24h_count || 0} tone="#c4b5fd" />
        <QueueStat label="近 24h 完成" value={data?.queue_snapshot.completed_24h_count || 0} tone="#86efac" />
        <QueueStat label="近 24h 失败" value={data?.queue_snapshot.failed_24h_count || 0} tone="#fca5a5" />
        <QueueStat label="近 24h 取消" value={data?.queue_snapshot.cancelled_24h_count || 0} tone="#f9a8d4" />
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(340px, 0.8fr)', gap: 16 }}>
        <div style={{ display: 'grid', gap: 16 }}>
          <section style={{ ...surfaceStyle, overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', padding: 16, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>最近任务 / 队列快照</div>
                <div style={{ color: 'rgba(255,255,255,0.52)', fontSize: 13, marginTop: 4 }}>
                  优先展示最近新进、运行中、失败和仍占冻结点数的任务。
                </div>
              </div>
              <Link href="/admin/tasks?attention=exceptions" style={{ color: '#c7d2fe', textDecoration: 'none', fontWeight: 700 }}>
                打开任务台
              </Link>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.55)' }}>
                  <tr>
                    <th style={{ textAlign: 'left', padding: 12 }}>任务</th>
                    <th style={{ textAlign: 'left', padding: 12 }}>用户</th>
                    <th style={{ textAlign: 'left', padding: 12 }}>状态</th>
                    <th style={{ textAlign: 'left', padding: 12 }}>注意点</th>
                    <th style={{ textAlign: 'right', padding: 12 }}>冻结 / 退款</th>
                    <th style={{ textAlign: 'left', padding: 12 }}>最近动作</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={6} style={{ padding: 24, color: 'rgba(255,255,255,0.45)' }}>加载中...</td></tr>
                  ) : !data || data.recent_tasks.length === 0 ? (
                    <tr><td colSpan={6} style={{ padding: 24, color: 'rgba(255,255,255,0.45)' }}>没有可展示的近期任务。</td></tr>
                  ) : data.recent_tasks.map((task) => (
                    <tr key={task.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                      <td style={{ padding: 12, minWidth: 220 }}>
                        <div style={{ fontWeight: 700 }}>{task.id}</div>
                        <div style={{ color: 'rgba(255,255,255,0.46)', marginTop: 4 }}>
                          {task.model} · {task.resolution || task.provider}
                        </div>
                        <div style={{ color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>
                          创建于 {formatDateTime(task.created_at)}
                        </div>
                      </td>
                      <td style={{ padding: 12, minWidth: 160 }}>
                        <div style={{ fontWeight: 700 }}>{task.user?.name || '-'}</div>
                        <div style={{ color: 'rgba(255,255,255,0.46)', marginTop: 4 }}>{task.user?.username || task.user?.email || '-'}</div>
                      </td>
                      <td style={{ padding: 12 }}>
                        <div>{formatStatus(task.local_status)}</div>
                        <div style={{ color: 'rgba(255,255,255,0.46)', marginTop: 4 }}>{task.provider_status || '-'}</div>
                      </td>
                      <td style={{ padding: 12, minWidth: 180 }}>
                        <AttentionBadges task={task} />
                      </td>
                      <td style={{ padding: 12, textAlign: 'right', minWidth: 120 }}>
                        <div>{formatCredits(task.frozen_cost)}</div>
                        <div style={{ color: 'rgba(255,255,255,0.46)', marginTop: 4 }}>退 {formatCredits(task.refund_amount)}</div>
                      </td>
                      <td style={{ padding: 12, minWidth: 200 }}>
                        {task.latest_operation ? (
                          <div>
                            <div style={{ fontWeight: 700 }}>{task.latest_operation.action}</div>
                            <div style={{ color: 'rgba(255,255,255,0.46)', marginTop: 4 }}>
                              {task.latest_operation.operator?.name || '系统'} · {formatDateTime(task.latest_operation.created_at)}
                            </div>
                          </div>
                        ) : (
                          <span style={{ color: 'rgba(255,255,255,0.42)' }}>暂无处理记录</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section style={{ ...surfaceStyle, padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline', marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>当前后台入口</div>
                <div style={{ color: 'rgba(255,255,255,0.52)', fontSize: 13, marginTop: 4 }}>
                  跳到已建好的管理页，不在首页重复造轮子。
                </div>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
              <Link href="/admin/tasks?attention=exceptions" style={{ ...surfaceStyle, padding: 14, color: '#fff', textDecoration: 'none' }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>任务异常</div>
                <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13 }}>待处理 {data?.summary.attention_now_count || 0}</div>
              </Link>
              <Link href="/admin/users" style={{ ...surfaceStyle, padding: 14, color: '#fff', textDecoration: 'none' }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>用户与点数</div>
                <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13 }}>
                  {data?.quick_links.users_total_count || 0} 用户，禁用 {data?.quick_links.disabled_user_count || 0}
                </div>
              </Link>
              <Link href="/admin/resources" style={{ ...surfaceStyle, padding: 14, color: '#fff', textDecoration: 'none' }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>共享资源</div>
                <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13 }}>
                  活跃 {data?.quick_links.active_resource_count || 0}，停用 {data?.quick_links.disabled_resource_count || 0}
                </div>
              </Link>
              <Link href="/admin/pricing" style={{ ...surfaceStyle, padding: 14, color: '#fff', textDecoration: 'none' }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>计费规则</div>
                <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13 }}>
                  生效 {data?.quick_links.active_pricing_rule_count || 0}，停用 {data?.quick_links.disabled_pricing_rule_count || 0}
                </div>
              </Link>
            </div>
          </section>
        </div>

        <div style={{ display: 'grid', gap: 16 }}>
          <section style={{ ...surfaceStyle, padding: 16 }}>
            <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 6 }}>点数 / 使用信号</div>
            <div style={{ color: 'rgba(255,255,255,0.52)', fontSize: 13, lineHeight: 1.6, marginBottom: 16 }}>
              金额来自现有 `credit_account` 与 `credit_ledger` 数据。`monthly_used` 明确标注为账户字段当前值，不当作额外 BI 推算。
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12, marginBottom: 16 }}>
              <div style={{ ...surfaceStyle, padding: 14 }}>
                <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>账户总余额</div>
                <div style={{ fontSize: 24, fontWeight: 800, marginTop: 8 }}>{formatCredits(data?.credit_usage.total_balance)}</div>
              </div>
              <div style={{ ...surfaceStyle, padding: 14 }}>
                <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>当前冻结点数</div>
                <div style={{ fontSize: 24, fontWeight: 800, marginTop: 8 }}>{formatCredits(data?.credit_usage.total_frozen)}</div>
              </div>
              <div style={{ ...surfaceStyle, padding: 14 }}>
                <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>近 7 天成功扣费</div>
                <div style={{ fontSize: 24, fontWeight: 800, marginTop: 8 }}>{formatCredits(data?.credit_usage.deducted_7d)}</div>
              </div>
              <div style={{ ...surfaceStyle, padding: 14 }}>
                <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>近 7 天退款 / 返还</div>
                <div style={{ fontSize: 24, fontWeight: 800, marginTop: 8 }}>{formatCredits(data?.credit_usage.refunded_7d)}</div>
              </div>
            </div>
            <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ color: 'rgba(255,255,255,0.56)' }}>有冻结点数的账户</span>
                <span>{data?.credit_usage.accounts_with_frozen_count || 0}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ color: 'rgba(255,255,255,0.56)' }}>余额小于等于冻结点数的账户</span>
                <span>{data?.credit_usage.at_risk_account_count || 0}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ color: 'rgba(255,255,255,0.56)' }}>近 7 天发放 / 调整</span>
                <span>{formatCredits(data?.credit_usage.granted_7d)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ color: 'rgba(255,255,255,0.56)' }}>账户 `monthly_used` 字段合计</span>
                <span>{formatCredits(data?.credit_usage.current_monthly_used_field_total)}</span>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontWeight: 700 }}>使用较高账户</div>
              <Link href="/admin/users" style={{ color: '#c7d2fe', textDecoration: 'none', fontWeight: 700 }}>去用户页</Link>
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {!data || data.credit_usage.top_usage_users.length === 0 ? (
                <div style={{ color: 'rgba(255,255,255,0.42)' }}>暂无需要额外关注的账户。</div>
              ) : data.credit_usage.top_usage_users.map((account) => (
                <div key={account.user_id} style={{ ...surfaceStyle, padding: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <div>
                      <div style={{ fontWeight: 700 }}>{account.user?.name || account.user_id}</div>
                      <div style={{ color: 'rgba(255,255,255,0.46)', marginTop: 4 }}>{account.user?.username || account.user?.email || '-'}</div>
                    </div>
                    <div style={{ textAlign: 'right', color: 'rgba(255,255,255,0.74)', fontSize: 13 }}>
                      <div>月用量字段 {formatCredits(account.monthly_used)}</div>
                      <div style={{ marginTop: 4 }}>冻结 {formatCredits(account.frozen_credits)}</div>
                      <div style={{ marginTop: 4 }}>余额 {formatCredits(account.balance)}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section style={{ ...surfaceStyle, padding: 16 }}>
            <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 6 }}>近 7 天任务流</div>
            <div style={{ color: 'rgba(255,255,255,0.52)', fontSize: 13, lineHeight: 1.6, marginBottom: 16 }}>
              只展示真实任务量变化，不做装饰性 BI 图。按天看新建、完成、失败与取消。
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              {!data ? (
                <div style={{ color: 'rgba(255,255,255,0.42)' }}>加载中...</div>
              ) : data.recent_flow.map((point) => (
                <div key={point.date} style={{ display: 'grid', gridTemplateColumns: '92px minmax(0, 1fr) 180px', gap: 12, alignItems: 'center' }}>
                  <div style={{ color: 'rgba(255,255,255,0.7)', fontVariantNumeric: 'tabular-nums' }}>
                    {point.date.slice(5)}
                  </div>
                  <div style={{ height: 10, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                    <div
                      style={{
                        width: `${(point.created_count / flowMax) * 100}%`,
                        minWidth: point.created_count > 0 ? 8 : 0,
                        height: '100%',
                        background: '#818cf8',
                      }}
                    />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, color: 'rgba(255,255,255,0.74)', fontVariantNumeric: 'tabular-nums' }}>
                    <span>新建 {point.created_count}</span>
                    <span>完成 {point.completed_count}</span>
                    <span>失败 {point.failed_count}</span>
                    <span>取消 {point.cancelled_count}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
