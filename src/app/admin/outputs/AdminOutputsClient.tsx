'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Eye, EyeOff, RefreshCcw, RotateCcw, Search } from 'lucide-react';
import PageBanner from '@/components/PageBanner';
import PaginationControls from '@/components/PaginationControls';
import { TaskVideoThumbnail } from '@/components/TaskVideoThumbnail';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { formatAmountMicrosWithFixedCny, formatAmountMinorWithFixedCny } from '@/lib/costs/currency';
import { taskDetailHref } from '@/lib/navigation/return-to';
import { displayUserName } from '@/lib/users/display';

type OutputOwner = {
  id: string;
  name: string | null;
  username: string;
  email: string;
  avatar_url?: string | null;
  account_type?: string | null;
} | null;

interface OutputItem {
  id: string;
  prompt: string;
  source_type: string;
  source_label: string | null;
  source_request_id: string | null;
  local_status: string;
  provider_task_id: string | null;
  model: string;
  resolution: string | null;
  duration: number | null;
  ratio: string | null;
  estimated_cost: number | null;
  actual_cost: number | null;
  frozen_cost: number | null;
  refund_amount: number | null;
  provider_cost_status: string;
  provider_official_amount_minor: number | null;
  provider_official_amount_micros: number | null;
  provider_cost_currency: string | null;
  result_video_url: string | null;
  result_last_frame_url: string | null;
  local_video_path: string | null;
  reference_image_ids: string | null;
  reference_album_ids: string | null;
  project_id: string | null;
  owner_user_id: string | null;
  retention_status: string;
  user_deleted_at: string | null;
  admin_hidden_at: string | null;
  restored_at: string | null;
  delete_reason: string | null;
  created_at: string;
  completed_at: string | null;
  owner: OutputOwner;
  user_deleted_by_user: OutputOwner;
  admin_hidden_by_user: OutputOwner;
  restored_by_user: OutputOwner;
  project: { id: string; name: string; type: string; status: string } | null;
}

interface OutputsResponse {
  outputs: OutputItem[];
  summary: {
    total_all: number;
    retention: Record<string, number>;
    statuses: Record<string, number>;
  };
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
}

const statusOptions = [
  ['', '全部状态'],
  ['submitted', '排队中'],
  ['running', '生成中'],
  ['succeeded', '已完成'],
  ['failed', '失败'],
  ['cancelled', '已取消'],
] as const;

const statusTabs = [
  ['', '全部'],
  ['succeeded', '已完成'],
  ['running', '生成中'],
  ['failed', '失败'],
] as const;

const retentionOptions = [
  ['', '全部留存状态'],
  ['active', '可见'],
  ['user_deleted', '用户已移除'],
  ['admin_hidden', '管理员隐藏'],
  ['retained', '留存'],
] as const;

const retentionTabs = [
  ['', '全部'],
  ['active', '可见'],
  ['user_deleted', '用户移除'],
  ['admin_hidden', '管理员隐藏'],
] as const;

const resolutionOptions = [
  ['', '全部清晰度'],
  ['480p', '480p'],
  ['720p', '720p'],
  ['1080p', '1080p'],
  ['unknown', '未记录'],
] as const;

function shortId(value: string | null | undefined, length = 10) {
  if (!value) return '-';
  return value.length > length ? `${value.slice(0, length)}...` : value;
}

function truncate(value: string, length = 64) {
  return value.length > length ? `${value.slice(0, length)}...` : value;
}

function formatShortDate(value: string | null) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function localStatusLabel(value: string) {
  if (value === 'submitted') return '排队中';
  if (value === 'running') return '生成中';
  if (value === 'succeeded') return '已完成';
  if (value === 'failed') return '失败';
  if (value === 'cancelled') return '已取消';
  return value;
}

function localStatusClass(value: string) {
  if (value === 'submitted') return 'status-submitted';
  if (value === 'running') return 'status-running';
  if (value === 'succeeded') return 'status-succeeded';
  if (value === 'failed') return 'status-failed';
  if (value === 'cancelled') return 'status-cancelled';
  return 'status-draft';
}

function retentionLabel(value: string) {
  if (value === 'active') return '可见';
  if (value === 'user_deleted') return '用户已移除';
  if (value === 'admin_hidden') return '管理员隐藏';
  if (value === 'retained') return '留存';
  return value;
}

function retentionClass(value: string) {
  if (value === 'user_deleted') return 'status-failed';
  if (value === 'admin_hidden') return 'status-cancelled';
  if (value === 'retained') return 'status-running';
  return 'status-succeeded';
}

function sourceLabel(output: OutputItem) {
  if (output.source_type === 'codex_api') return output.source_label || 'Codex API';
  if (output.source_type === 'web') return output.source_label || 'Web UI';
  return output.source_label || output.source_type || '未知';
}

function officialChargeText(output: OutputItem) {
  if (output.provider_official_amount_micros !== null && output.provider_official_amount_micros !== undefined) {
    return formatAmountMicrosWithFixedCny(output.provider_official_amount_micros, output.provider_cost_currency);
  }
  if (output.provider_official_amount_minor !== null && output.provider_official_amount_minor !== undefined) {
    return formatAmountMinorWithFixedCny(output.provider_official_amount_minor, output.provider_cost_currency);
  }
  return '待官方确认';
}

function pointCostText(output: OutputItem) {
  if (output.actual_cost !== null && output.actual_cost !== undefined) return `点数 ${output.actual_cost}`;
  if (output.frozen_cost) return `冻结 ${output.frozen_cost}`;
  if (output.estimated_cost !== null && output.estimated_cost !== undefined) return `预估 ${output.estimated_cost}`;
  return '未记录';
}

function parseReferenceCount(value: string | null) {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function outputSpec(output: OutputItem) {
  return [
    output.resolution,
    output.duration ? `${output.duration}s` : null,
    output.ratio,
  ].filter(Boolean).join(' · ') || '未记录规格';
}

function outputPrimaryMeta(output: OutputItem, referenceCount: number) {
  return [
    output.model,
    outputSpec(output),
    referenceCount > 0 ? `参考图 ${referenceCount}` : null,
  ].filter(Boolean).join(' · ');
}

function deletionSummary(output: OutputItem) {
  if (output.user_deleted_at) return `用户移除 ${formatShortDate(output.user_deleted_at)}`;
  if (output.admin_hidden_at) return `管理员隐藏 ${formatShortDate(output.admin_hidden_at)}`;
  return '正常留存';
}

function sourceSummary(output: OutputItem) {
  return sourceLabel(output);
}

function OutputFramePreview({ output }: { output: OutputItem }) {
  return (
    <TaskVideoThumbnail
      taskId={output.id}
      localVideoPath={output.local_video_path}
      resultVideoUrl={output.result_video_url}
      resultLastFrameUrl={output.result_last_frame_url}
      status={output.local_status}
      href={taskDetailHref(output.id, '/admin/outputs')}
      size="medium"
      className="outputs-preview"
    />
  );
}

export default function AdminOutputsClient() {
  const searchParams = useSearchParams();
  const [outputs, setOutputs] = useState<OutputItem[]>([]);
  const [summary, setSummary] = useState<OutputsResponse['summary'] | null>(null);
  const [pagination, setPagination] = useState<OutputsResponse['pagination'] | null>(null);
  const [keyword, setKeyword] = useState(() => searchParams.get('keyword') || '');
  const [status, setStatus] = useState(() => searchParams.get('status') || '');
  const [retentionStatus, setRetentionStatus] = useState(() => searchParams.get('retention_status') || '');
  const [ownerUserId, setOwnerUserId] = useState(() => searchParams.get('owner_user_id') || '');
  const [projectId, setProjectId] = useState(() => searchParams.get('project_id') || '');
  const [resolution, setResolution] = useState(() => searchParams.get('resolution') || '');
  const [dateFrom, setDateFrom] = useState(() => searchParams.get('date_from') || '');
  const [dateTo, setDateTo] = useState(() => searchParams.get('date_to') || '');
  const [includeDeleted, setIncludeDeleted] = useState(true);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState<string | null>(null);
  const [confirmingHideId, setConfirmingHideId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const query = useMemo(() => {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', '30');
    params.set('include_deleted', includeDeleted ? 'true' : 'false');
    if (keyword.trim()) params.set('keyword', keyword.trim());
    if (status) params.set('status', status);
    if (retentionStatus) params.set('retention_status', retentionStatus);
    if (ownerUserId.trim()) params.set('owner_user_id', ownerUserId.trim());
    if (projectId.trim()) params.set('project_id', projectId.trim());
    if (resolution) params.set('resolution', resolution);
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    return params.toString();
  }, [dateFrom, dateTo, includeDeleted, keyword, ownerUserId, page, projectId, resolution, retentionStatus, status]);

  const loadOutputs = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/outputs?${query}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '加载产出失败');
      setOutputs(data.outputs || []);
      setSummary(data.summary || null);
      setPagination(data.pagination || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载产出失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadOutputs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const runAction = async (output: OutputItem, action: 'restore' | 'hide') => {
    setActingId(output.id);
    setMessage('');
    setError('');
    try {
      const res = await fetch(`/api/admin/outputs/tasks/${output.id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: action === 'hide' ? JSON.stringify({ reason: '管理员隐藏产出' }) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '操作失败');
      setMessage(action === 'restore' ? '已恢复产出' : '已隐藏产出');
      setConfirmingHideId(null);
      await loadOutputs();
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setActingId(null);
    }
  };

  const currentTotal = pagination?.total ?? outputs.length;
  const activeCount = summary?.retention?.active ?? 0;
  const hiddenCount = (summary?.retention?.user_deleted ?? 0) + (summary?.retention?.admin_hidden ?? 0);
  const failedCount = summary?.statuses?.failed ?? 0;
  const succeededCount = summary?.statuses?.succeeded ?? 0;

  const resetFilters = () => {
    setKeyword('');
    setStatus('');
    setRetentionStatus('');
    setOwnerUserId('');
    setProjectId('');
    setResolution('');
    setDateFrom('');
    setDateTo('');
    setIncludeDeleted(true);
    setConfirmingHideId(null);
    setPage(1);
  };

  return (
    <div className="outputs-page">
      <PageBanner
        eyebrow="管理员后台"
        title="产出留存"
        description="按视频画面核对产出，处理隐藏、恢复和归属追溯。"
        actions={(
          <button className="btn btn-secondary" type="button" onClick={() => void loadOutputs()} disabled={loading}>
            <RefreshCcw size={15} />
            {loading ? '刷新中' : '刷新'}
          </button>
        )}
      />

      {(message || error) && (
        <div className="outputs-message" data-tone={error ? 'error' : 'success'}>
          <p className={error ? 'text-red' : 'text-green'}>{error || message}</p>
        </div>
      )}

      <section className="outputs-workbench">
        <div className="outputs-workbench-head">
          <div>
            <h2>产出队列</h2>
            <p>当前筛选 {currentTotal} 条，优先处理失败、隐藏和归属异常。</p>
          </div>
          <div className="outputs-summary-strip" aria-label="产出概览">
            <span><strong>{succeededCount}</strong> 已完成</span>
            <span><strong>{activeCount}</strong> 可见</span>
            <span><strong>{hiddenCount}</strong> 已移除或隐藏</span>
            <span><strong>{failedCount}</strong> 失败</span>
          </div>
        </div>

        <div className="outputs-filter-panel">
          <label className="outputs-search">
            <Search size={16} />
            <input
              value={keyword}
              onChange={(event) => {
                setKeyword(event.target.value);
                setPage(1);
              }}
              placeholder="搜索提示词、任务 ID、来源请求"
            />
          </label>

          <div className="outputs-filter-row" aria-label="任务状态">
            {statusTabs.map(([value, label]) => (
              <button
                key={value || 'all'}
                type="button"
                className={`outputs-filter-chip${status === value ? ' is-active' : ''}`}
                onClick={() => {
                  setStatus(value);
                  setPage(1);
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="outputs-filter-row" aria-label="留存状态">
            {retentionTabs.map(([value, label]) => (
              <button
                key={value || 'all'}
                type="button"
                className={`outputs-filter-chip${retentionStatus === value ? ' is-active' : ''}`}
                onClick={() => {
                  setRetentionStatus(value);
                  setPage(1);
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <details className="outputs-advanced-filters">
            <summary>高级筛选</summary>
            <div>
              <select className="input" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
                {statusOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <select className="input" value={retentionStatus} onChange={(event) => { setRetentionStatus(event.target.value); setPage(1); }}>
                {retentionOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <select className="input" value={resolution} onChange={(event) => { setResolution(event.target.value); setPage(1); }}>
                {resolutionOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <input
                className="input"
                type="date"
                value={dateFrom}
                onChange={(event) => {
                  setDateFrom(event.target.value);
                  setPage(1);
                }}
                aria-label="开始日期"
              />
              <input
                className="input"
                type="date"
                value={dateTo}
                onChange={(event) => {
                  setDateTo(event.target.value);
                  setPage(1);
                }}
                aria-label="结束日期"
              />
              <input
                className="input"
                value={ownerUserId}
                onChange={(event) => {
                  setOwnerUserId(event.target.value);
                  setPage(1);
                }}
                placeholder="用户 ID"
              />
              <input
                className="input"
                value={projectId}
                onChange={(event) => {
                  setProjectId(event.target.value);
                  setPage(1);
                }}
                placeholder="项目 ID"
              />
              <label className="outputs-checkbox">
                <input
                  type="checkbox"
                  checked={includeDeleted}
                  onChange={(event) => {
                    setIncludeDeleted(event.target.checked);
                    setPage(1);
                  }}
                />
                包含用户移除和管理员隐藏
              </label>
            </div>
          </details>

          <button className="outputs-reset" type="button" onClick={resetFilters}>清空筛选</button>
        </div>

        {loading ? (
          <div className="outputs-loading-list" aria-label="加载产出">
            {Array.from({ length: 4 }).map((_, index) => (
              <div className="outputs-loading-row" key={index} />
            ))}
          </div>
        ) : outputs.length === 0 ? (
          <div className="outputs-empty">
            <h3>没有符合条件的产出</h3>
            <p>调整状态或清空筛选后再查看。</p>
            <button className="btn btn-secondary" type="button" onClick={resetFilters}>清空筛选</button>
          </div>
        ) : (
          <div className="outputs-list">
            {outputs.map((output) => {
              const referenceCount = parseReferenceCount(output.reference_image_ids);
              return (
                <article key={output.id} className="outputs-item">
                  <OutputFramePreview output={output} />

                  <div className="outputs-item-main">
                    <div className="outputs-item-kicker">
                      <span className={`status-badge ${localStatusClass(output.local_status)}`}>
                        {localStatusLabel(output.local_status)}
                      </span>
                      <span className={`status-badge ${retentionClass(output.retention_status)}`}>
                        {retentionLabel(output.retention_status)}
                      </span>
                      <span>{sourceSummary(output)}</span>
                    </div>

                    <Link className="outputs-item-title" href={taskDetailHref(output.id, '/admin/outputs')}>
                      {truncate(output.prompt || '无提示词', 112)}
                    </Link>

                    <div className="outputs-item-meta">
                      <span>{outputPrimaryMeta(output, referenceCount)}</span>
                      <UserIdentityBadge user={output.owner} size="sm" showEmail />
                      {output.project ? (
                        <Link href={`/projects/${output.project.id}`}>{output.project.name}</Link>
                      ) : (
                        <span>未归属项目</span>
                      )}
                      <span>创建 {formatShortDate(output.created_at)}</span>
                      {output.completed_at && <span>完成 {formatShortDate(output.completed_at)}</span>}
                    </div>

                    <details className="outputs-audit-details">
                      <summary>审计信息</summary>
                      <div>
                        <span>任务：{shortId(output.id, 14)}</span>
                        <span>来源请求：{shortId(output.source_request_id, 18)}</span>
                        <span>Provider：{shortId(output.provider_task_id, 18)}</span>
                        <span>成本状态：{output.provider_cost_status}</span>
                        <span>留存：{deletionSummary(output)}</span>
                        {output.delete_reason && <span>原因：{output.delete_reason}</span>}
                        {output.user_deleted_by_user && <span>操作人：{displayUserName(output.user_deleted_by_user)}</span>}
                        {output.admin_hidden_by_user && <span>操作人：{displayUserName(output.admin_hidden_by_user)}</span>}
                        {output.restored_by_user && <span>恢复人：{displayUserName(output.restored_by_user)}</span>}
                      </div>
                    </details>
                  </div>

                  <div className="outputs-item-side">
                    <div className="outputs-cost">
                      <span>实际扣除</span>
                      <strong>{officialChargeText(output)}</strong>
                      <small>{pointCostText(output)}</small>
                    </div>
                    <div className="outputs-actions">
                      <Link className="btn btn-secondary" href={taskDetailHref(output.id, '/admin/outputs')}>
                        <Eye size={15} />
                        详情
                      </Link>
                      {output.retention_status !== 'active' && (
                        <button
                          className="btn btn-secondary"
                          type="button"
                          disabled={actingId === output.id}
                          onClick={() => {
                            setConfirmingHideId(null);
                            void runAction(output, 'restore');
                          }}
                        >
                          <RotateCcw size={15} />
                          恢复
                        </button>
                      )}
                      {output.retention_status !== 'admin_hidden' && (
                        <button
                          className="btn btn-danger"
                          type="button"
                          disabled={actingId === output.id}
                          onClick={() => {
                            if (confirmingHideId === output.id) {
                              void runAction(output, 'hide');
                              return;
                            }
                            setConfirmingHideId(output.id);
                          }}
                        >
                          <EyeOff size={15} />
                          {confirmingHideId === output.id ? '确认隐藏' : '隐藏'}
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {pagination && (
          <PaginationControls
            page={pagination.page}
            totalPages={pagination.total_pages}
            total={pagination.total}
            pageSize={pagination.limit}
            label="产出"
            onPageChange={setPage}
          />
        )}
      </section>
    </div>
  );
}
