'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { SessionUser } from '@/lib/auth/session';

interface TaskUser {
  id: string;
  name: string;
  username: string;
  email: string;
}

interface AdminTaskListItem {
  id: string;
  provider: string;
  model: string;
  prompt: string;
  resolution: string | null;
  duration: number | null;
  local_status: string;
  provider_status: string | null;
  provider_task_id: string | null;
  estimated_cost: number | null;
  actual_cost: number | null;
  frozen_cost: number | null;
  refund_amount: number | null;
  error_message: string | null;
  result_video_url: string | null;
  created_at: string;
  completed_at: string | null;
  user: TaskUser | null;
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
    operator?: { name: string; username: string } | null;
  } | null;
}

interface LedgerEntry {
  id: string;
  type: string;
  amount: number;
  balance_before: number;
  balance_after: number;
  frozen_before: number | null;
  frozen_after: number | null;
  reason: string | null;
  created_at: string;
  user?: TaskUser | null;
}

interface OperationLog {
  id: string;
  action: string;
  detail: string | null;
  created_at: string;
  operator: { id: string; name: string; username: string };
}

interface AdminTaskDetail extends AdminTaskListItem {
  generation_mode: string;
  ratio: string | null;
  seed: number | null;
  generate_audio: boolean | null;
  return_last_frame: boolean | null;
  watermark: boolean | null;
  result_last_frame_url: string | null;
  local_video_path: string | null;
  pricing_snapshot: string | null;
  params_json: string | null;
  raw_create_response: string | null;
  raw_status_response: string | null;
  error_code: string | null;
  first_frame_url: string | null;
  last_frame_url: string | null;
  reference_image_urls: string | null;
  reference_video_urls: string | null;
  reference_audio_urls: string | null;
  frame_image_urls: string | null;
  completed_at: string | null;
  ledger_entries: LedgerEntry[];
  operation_logs: OperationLog[];
}

interface Summary {
  abnormal_count: number;
  still_frozen_count: number;
  long_frozen_count: number;
  failed_count: number;
  refund_relevant_count: number;
}

interface Pagination {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '10px 12px',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 8,
  background: 'rgba(255,255,255,0.06)',
  color: '#fff',
  fontSize: 14,
};

const buttonStyle: React.CSSProperties = {
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 8,
  padding: '10px 14px',
  background: 'rgba(255,255,255,0.06)',
  color: '#fff',
  fontWeight: 700,
  cursor: 'pointer',
};

function formatDate(value: string | null) {
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

function formatLedgerType(type: string) {
  const labels: Record<string, string> = {
    task_freeze: '冻结',
    task_success_deduct: '成功结算',
    task_failed_refund: '失败退款',
    manual_refund: '人工退款',
    admin_grant: '管理员发放',
    admin_deduct: '管理员扣减',
    system_adjust: '系统修正',
  };
  return labels[type] || type;
}

function parseDetail(detail: string | null) {
  if (!detail) return null;
  try {
    return JSON.parse(detail) as Record<string, unknown>;
  } catch {
    return { raw: detail };
  }
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div style={{ border: `1px solid ${tone}`, borderRadius: 8, padding: 16, background: 'rgba(255,255,255,0.03)' }}>
      <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: 13, marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800 }}>{value}</div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div style={{ color: 'rgba(255,255,255,0.48)', fontSize: 12, marginBottom: 4 }}>{label}</div>
      <div style={{ wordBreak: 'break-word' }}>{value || '-'}</div>
    </div>
  );
}

export default function AdminTasksClient({ currentUser }: { currentUser: SessionUser }) {
  const [tasks, setTasks] = useState<AdminTaskListItem[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminTaskDetail | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [actionLoading, setActionLoading] = useState('');
  const [filters, setFilters] = useState({
    user: '',
    status: '',
    model: '',
    from: '',
    to: '',
    frozen: false,
    attention: 'exceptions',
    page: 1,
  });

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) || detail || null,
    [detail, selectedTaskId, tasks],
  );

  useEffect(() => {
    void loadTasks();
  }, [filters.page, filters.attention]);

  async function loadTasks(resetPage = false) {
    setLoading(true);
    setError('');

    const query = new URLSearchParams();
    if (filters.user) query.set('user', filters.user);
    if (filters.status) query.set('status', filters.status);
    if (filters.model) query.set('model', filters.model);
    if (filters.from) query.set('from', filters.from);
    if (filters.to) query.set('to', filters.to);
    if (filters.frozen) query.set('frozen', '1');
    query.set('attention', filters.attention);
    query.set('page', String(resetPage ? 1 : filters.page));
    query.set('page_size', '20');

    try {
      const res = await fetch(`/api/admin/tasks?${query.toString()}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '加载任务失败');
      setTasks(data.tasks || []);
      setSummary(data.summary || null);
      setPagination(data.pagination || null);

      if (resetPage && filters.page !== 1) {
        setFilters((prev) => ({ ...prev, page: 1 }));
      }

      const nextSelected = selectedTaskId && (data.tasks || []).some((task: AdminTaskListItem) => task.id === selectedTaskId)
        ? selectedTaskId
        : data.tasks?.[0]?.id || null;
      setSelectedTaskId(nextSelected);
      if (nextSelected) {
        void loadDetail(nextSelected);
      } else {
        setDetail(null);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载任务失败');
    } finally {
      setLoading(false);
    }
  }

  async function loadDetail(taskId: string) {
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/admin/tasks/${taskId}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '加载详情失败');
      setDetail(data);
    } catch (detailError) {
      setError(detailError instanceof Error ? detailError.message : '加载详情失败');
    } finally {
      setDetailLoading(false);
    }
  }

  async function submitAction(action: 'recheck' | 'refund' | 'mark-abnormal' | 'mark-failed' | 'note') {
    if (!selectedTaskId) return;
    if (!reason.trim()) {
      setError('请先填写处理原因');
      return;
    }
    if (action === 'note' && !note.trim()) {
      setError('请填写备注内容');
      return;
    }

    setActionLoading(action);
    setError('');
    setMessage('');
    try {
      const res = await fetch(`/api/admin/tasks/${selectedTaskId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: reason.trim(),
          note: note.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '操作失败');
      setMessage(action === 'refund' && data.alreadyRefunded ? '该任务已完成退款，无重复入账' : '操作已完成');
      setReason('');
      setNote('');
      await loadTasks();
      await loadDetail(selectedTaskId);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : '操作失败');
    } finally {
      setActionLoading('');
    }
  }

  return (
    <main style={{ minHeight: '100vh', background: '#0f0f13', color: '#fff', padding: 24 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 24 }}>
        <div>
          <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 13 }}>管理员后台</div>
          <h1 style={{ margin: '4px 0 8px', fontSize: 28 }}>任务与异常处理</h1>
          <div style={{ color: 'rgba(255,255,255,0.6)', maxWidth: 720 }}>
            默认聚焦异常、冻结和退款相关任务，方便先处理积压问题，再回看全量记录。
          </div>
        </div>
        <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, textAlign: 'right' }}>
          <div>{currentUser.name} · {currentUser.email}</div>
          <div style={{ marginTop: 8, display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <Link href="/admin/users" style={{ ...buttonStyle, textDecoration: 'none' }}>用户与点数</Link>
            <Link href="/admin/resources" style={{ ...buttonStyle, textDecoration: 'none', background: '#334155' }}>资源</Link>
            <Link href="/admin/pricing" style={{ ...buttonStyle, textDecoration: 'none', background: '#334155' }}>计费规则</Link>
          </div>
        </div>
      </header>

      {(message || error) && (
        <div style={{
          marginBottom: 16,
          padding: '10px 12px',
          borderRadius: 8,
          color: error ? '#ff8a8a' : '#86efac',
          background: error ? 'rgba(255,80,80,0.1)' : 'rgba(80,255,140,0.1)',
          border: error ? '1px solid rgba(255,80,80,0.25)' : '1px solid rgba(80,255,140,0.25)',
        }}>
          {error || message}
        </div>
      )}

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 12, marginBottom: 16 }}>
        <SummaryCard label="已标记异常" value={summary?.abnormal_count || 0} tone="rgba(251, 146, 60, 0.45)" />
        <SummaryCard label="仍冻结任务" value={summary?.still_frozen_count || 0} tone="rgba(96, 165, 250, 0.45)" />
        <SummaryCard label="长时间冻结" value={summary?.long_frozen_count || 0} tone="rgba(250, 204, 21, 0.45)" />
        <SummaryCard label="失败任务" value={summary?.failed_count || 0} tone="rgba(248, 113, 113, 0.45)" />
        <SummaryCard label="退款相关" value={summary?.refund_relevant_count || 0} tone="rgba(52, 211, 153, 0.45)" />
      </section>

      <section style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: 12 }}>
          <input style={inputStyle} placeholder="用户 / 邮箱 / 账号" value={filters.user} onChange={(e) => setFilters((prev) => ({ ...prev, user: e.target.value }))} />
          <select style={inputStyle} value={filters.status} onChange={(e) => setFilters((prev) => ({ ...prev, status: e.target.value }))}>
            <option value="">全部状态</option>
            <option value="submitted">已提交</option>
            <option value="running">运行中</option>
            <option value="succeeded">已完成</option>
            <option value="failed">失败</option>
            <option value="cancelled">已取消</option>
          </select>
          <input style={inputStyle} placeholder="模型" value={filters.model} onChange={(e) => setFilters((prev) => ({ ...prev, model: e.target.value }))} />
          <input style={inputStyle} type="datetime-local" value={filters.from} onChange={(e) => setFilters((prev) => ({ ...prev, from: e.target.value }))} />
          <input style={inputStyle} type="datetime-local" value={filters.to} onChange={(e) => setFilters((prev) => ({ ...prev, to: e.target.value }))} />
          <label style={{ ...inputStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={filters.frozen} onChange={(e) => setFilters((prev) => ({ ...prev, frozen: e.target.checked }))} />
            仅看仍冻结任务
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          {[
            ['exceptions', '异常优先'],
            ['abnormal', '已标记异常'],
            ['failed', '失败任务'],
            ['frozen', '冻结任务'],
            ['refund', '退款相关'],
            ['all', '全部任务'],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              style={{
                ...buttonStyle,
                background: filters.attention === value ? '#6366f1' : 'rgba(255,255,255,0.06)',
                borderColor: filters.attention === value ? '#6366f1' : 'rgba(255,255,255,0.12)',
              }}
              onClick={() => setFilters((prev) => ({ ...prev, attention: value, page: 1 }))}
            >
              {label}
            </button>
          ))}
          <button type="button" style={{ ...buttonStyle, background: '#6366f1', borderColor: '#6366f1' }} onClick={() => void loadTasks(true)}>
            刷新筛选
          </button>
        </div>
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(420px, 0.8fr)', gap: 16 }}>
        <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: 16, borderBottom: '1px solid rgba(255,255,255,0.08)', fontWeight: 700 }}>
            任务队列
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.55)' }}>
                <tr>
                  <th style={{ textAlign: 'left', padding: 12 }}>任务</th>
                  <th style={{ textAlign: 'left', padding: 12 }}>用户</th>
                  <th style={{ textAlign: 'left', padding: 12 }}>状态</th>
                  <th style={{ textAlign: 'left', padding: 12 }}>模型</th>
                  <th style={{ textAlign: 'right', padding: 12 }}>分辨率</th>
                  <th style={{ textAlign: 'right', padding: 12 }}>时长</th>
                  <th style={{ textAlign: 'right', padding: 12 }}>预估</th>
                  <th style={{ textAlign: 'right', padding: 12 }}>实扣</th>
                  <th style={{ textAlign: 'right', padding: 12 }}>冻结</th>
                  <th style={{ textAlign: 'left', padding: 12 }}>创建 / 完成</th>
                  <th style={{ textAlign: 'left', padding: 12 }}>详情</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={11} style={{ padding: 24, color: 'rgba(255,255,255,0.45)' }}>加载中...</td></tr>
                ) : tasks.length === 0 ? (
                  <tr><td colSpan={11} style={{ padding: 24, color: 'rgba(255,255,255,0.45)' }}>当前筛选下没有任务</td></tr>
                ) : tasks.map((task) => (
                  <tr
                    key={task.id}
                    style={{
                      borderTop: '1px solid rgba(255,255,255,0.06)',
                      background: selectedTaskId === task.id ? 'rgba(99,102,241,0.12)' : 'transparent',
                    }}
                  >
                    <td style={{ padding: 12, minWidth: 220 }}>
                      <div style={{ fontWeight: 700 }}>{task.id}</div>
                      <div style={{ color: 'rgba(255,255,255,0.45)', marginTop: 4 }}>
                        {task.attention_flags.abnormal ? '异常标记 · ' : ''}
                        {task.attention_flags.long_frozen ? '长冻 · ' : ''}
                        {task.provider_task_id || task.provider}
                      </div>
                    </td>
                    <td style={{ padding: 12, minWidth: 160 }}>
                      <div style={{ fontWeight: 700 }}>{task.user?.name || '-'}</div>
                      <div style={{ color: 'rgba(255,255,255,0.45)' }}>{task.user?.username || '-'}</div>
                    </td>
                    <td style={{ padding: 12 }}>
                      <div>{formatStatus(task.local_status)}</div>
                      <div style={{ color: 'rgba(255,255,255,0.45)', marginTop: 4 }}>{task.provider_status || '-'}</div>
                    </td>
                    <td style={{ padding: 12, maxWidth: 160, wordBreak: 'break-word' }}>{task.model}</td>
                    <td style={{ padding: 12, textAlign: 'right' }}>{task.resolution || '-'}</td>
                    <td style={{ padding: 12, textAlign: 'right' }}>{task.duration ? `${task.duration}s` : '-'}</td>
                    <td style={{ padding: 12, textAlign: 'right' }}>{formatCredits(task.estimated_cost)}</td>
                    <td style={{ padding: 12, textAlign: 'right' }}>{formatCredits(task.actual_cost)}</td>
                    <td style={{ padding: 12, textAlign: 'right' }}>{formatCredits(task.frozen_cost)}</td>
                    <td style={{ padding: 12, minWidth: 168 }}>
                      <div>{formatDate(task.created_at)}</div>
                      <div style={{ color: 'rgba(255,255,255,0.45)', marginTop: 4 }}>{formatDate(task.completed_at)}</div>
                    </td>
                    <td style={{ padding: 12 }}>
                      <button
                        type="button"
                        style={{ ...buttonStyle, padding: '7px 10px' }}
                        onClick={() => {
                          setSelectedTaskId(task.id);
                          void loadDetail(task.id);
                        }}
                      >
                        查看
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pagination && pagination.total_pages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: 13 }}>
                第 {pagination.page} / {pagination.total_pages} 页，共 {pagination.total} 条
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" style={buttonStyle} disabled={filters.page <= 1} onClick={() => setFilters((prev) => ({ ...prev, page: prev.page - 1 }))}>上一页</button>
                <button type="button" style={buttonStyle} disabled={filters.page >= pagination.total_pages} onClick={() => setFilters((prev) => ({ ...prev, page: prev.page + 1 }))}>下一页</button>
              </div>
            </div>
          )}
        </div>

        <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: 16, minHeight: 720 }}>
          {!selectedTask ? (
            <div style={{ color: 'rgba(255,255,255,0.45)' }}>请选择任务查看异常处理详情。</div>
          ) : detailLoading && !detail ? (
            <div style={{ color: 'rgba(255,255,255,0.45)' }}>详情加载中...</div>
          ) : detail ? (
            <div style={{ display: 'grid', gap: 16 }}>
              <div>
                <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 8 }}>{detail.id}</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>
                  <span>用户：{detail.user?.name || '-'}</span>
                  <span>本地状态：{formatStatus(detail.local_status)}</span>
                  <span>Provider：{detail.provider_status || '-'}</span>
                </div>
              </div>

              <section style={{ display: 'grid', gap: 12 }}>
                <div style={{ fontWeight: 700 }}>处理动作</div>
                <textarea
                  style={{ ...inputStyle, minHeight: 86, resize: 'vertical' }}
                  placeholder="所有处理动作都需要填写原因"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <textarea
                  style={{ ...inputStyle, minHeight: 72, resize: 'vertical' }}
                  placeholder="备注内容（仅用于添加备注）"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {[
                    ['recheck', '复查结果'],
                    ['refund', '人工退款'],
                    ['mark-abnormal', '标记异常'],
                    ['mark-failed', '标记失败'],
                    ['note', '添加备注'],
                  ].map(([action, label]) => (
                    <button
                      key={action}
                      type="button"
                      style={{
                        ...buttonStyle,
                        background: action === 'refund' ? '#065f46' : action === 'mark-failed' ? '#991b1b' : '#6366f1',
                        borderColor: 'transparent',
                      }}
                      disabled={actionLoading !== ''}
                      onClick={() => void submitAction(action as 'recheck' | 'refund' | 'mark-abnormal' | 'mark-failed' | 'note')}
                    >
                      {actionLoading === action ? '处理中...' : label}
                    </button>
                  ))}
                </div>
              </section>

              <section style={{ display: 'grid', gap: 12 }}>
                <div style={{ fontWeight: 700 }}>任务输入 / 输出</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
                  <Field label="Provider Task ID" value={detail.provider_task_id} />
                  <Field label="视频 URL" value={detail.result_video_url ? <a href={detail.result_video_url} target="_blank" rel="noreferrer" style={{ color: '#a5b4fc' }}>打开结果</a> : '-'} />
                  <Field label="生成模式" value={detail.generation_mode} />
                  <Field label="尾帧 URL" value={detail.result_last_frame_url || detail.last_frame_url} />
                  <Field label="分辨率" value={detail.resolution} />
                  <Field label="时长" value={detail.duration ? `${detail.duration}s` : '-'} />
                  <Field label="比例" value={detail.ratio} />
                  <Field label="错误原因" value={detail.error_message || '-'} />
                </div>
                <div>
                  <div style={{ color: 'rgba(255,255,255,0.48)', fontSize: 12, marginBottom: 4 }}>Prompt</div>
                  <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6, padding: 12, borderRadius: 8, background: 'rgba(255,255,255,0.04)' }}>{detail.prompt}</div>
                </div>
              </section>

              <section style={{ display: 'grid', gap: 12 }}>
                <div style={{ fontWeight: 700 }}>计费快照</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
                  <Field label="预估成本" value={formatCredits(detail.estimated_cost)} />
                  <Field label="实际扣费" value={formatCredits(detail.actual_cost)} />
                  <Field label="冻结成本" value={formatCredits(detail.frozen_cost)} />
                  <Field label="退款金额" value={formatCredits(detail.refund_amount)} />
                  <Field label="创建时间" value={formatDate(detail.created_at)} />
                  <Field label="完成时间" value={formatDate(detail.completed_at)} />
                </div>
                <pre style={{ margin: 0, padding: 12, borderRadius: 8, background: 'rgba(255,255,255,0.04)', overflowX: 'auto', fontSize: 12 }}>
                  {detail.pricing_snapshot || '无 pricing snapshot'}
                </pre>
              </section>

              <section style={{ display: 'grid', gap: 12 }}>
                <div style={{ fontWeight: 700 }}>相关点数流水</div>
                {detail.ledger_entries.length === 0 ? (
                  <div style={{ color: 'rgba(255,255,255,0.45)' }}>暂无关联流水</div>
                ) : detail.ledger_entries.map((entry) => (
                  <div key={entry.id} style={{ padding: 12, borderRadius: 8, background: 'rgba(255,255,255,0.04)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                      <div>{formatLedgerType(entry.type)}</div>
                      <div>{formatDate(entry.created_at)}</div>
                    </div>
                    <div style={{ marginTop: 6, color: 'rgba(255,255,255,0.7)' }}>
                      amount {entry.amount} | balance {entry.balance_before} -&gt; {entry.balance_after} | frozen {entry.frozen_before ?? 0} -&gt; {entry.frozen_after ?? 0}
                    </div>
                    <div style={{ marginTop: 6, color: 'rgba(255,255,255,0.55)' }}>{entry.reason || '-'}</div>
                  </div>
                ))}
              </section>

              <section style={{ display: 'grid', gap: 12 }}>
                <div style={{ fontWeight: 700 }}>操作记录</div>
                {detail.operation_logs.length === 0 ? (
                  <div style={{ color: 'rgba(255,255,255,0.45)' }}>暂无操作记录</div>
                ) : detail.operation_logs.map((log) => {
                  const parsed = parseDetail(log.detail);
                  return (
                    <div key={log.id} style={{ padding: 12, borderRadius: 8, background: 'rgba(255,255,255,0.04)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                        <div>{log.action}</div>
                        <div>{formatDate(log.created_at)}</div>
                      </div>
                      <div style={{ marginTop: 6, color: 'rgba(255,255,255,0.7)' }}>{log.operator.name} · {log.operator.username}</div>
                      <pre style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap', fontSize: 12, color: 'rgba(255,255,255,0.65)' }}>
                        {parsed ? JSON.stringify(parsed, null, 2) : log.detail}
                      </pre>
                    </div>
                  );
                })}
              </section>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
