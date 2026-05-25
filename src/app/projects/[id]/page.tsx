'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

interface ProjectDetail {
  id: string;
  name: string;
  description: string | null;
  type: string;
  visibility: string;
  status: string;
  owner_user_id: string;
  owner?: { name: string; username: string; email: string };
  members: Array<{
    id: string;
    user_id: string;
    role: string;
    joined_at: string;
    user: { id: string; name: string; username: string; email: string; role: string; status: string; account_type: string };
  }>;
  invites: Array<{ id: string; token: string; default_role: string; expires_at: string | null; used_count: number; max_uses: number | null }>;
  _count?: { members: number; tasks: number; reference_albums?: number };
}

interface ReferenceAlbumItem {
  id: string;
  name: string;
  description: string | null;
  status: string;
  updated_at: string;
  image_count: number;
}

interface TaskItem {
  id: string;
  prompt: string;
  local_status: string;
  provider_task_id: string | null;
  result_video_url?: string | null;
  local_video_path?: string | null;
  owner_user_id: string | null;
  user_id: string | null;
  estimated_cost: number | null;
  actual_cost: number | null;
  refund_amount: number | null;
  provider_cost_status: string;
  provider_official_amount_minor: number | null;
  provider_final_amount_minor: number | null;
  provider_official_amount_micros?: number | null;
  provider_final_amount_micros?: number | null;
  provider_cost_currency: string | null;
  provider_billing_status?: string | null;
  created_at: string;
  owner?: { id: string; name: string; username: string } | null;
  user?: { id: string; name: string; username: string } | null;
}

interface ProjectPermissions {
  can_manage_project: boolean;
  can_manage_members: boolean;
  can_manage_assets: boolean;
  can_generate: boolean;
  role: string;
}

interface ReviewTaskItem {
  id: string;
  prompt: string;
  local_status: string;
  estimated_cost: number | null;
  actual_cost?: number | null;
  refund_amount?: number | null;
  provider_cost_status: string;
  error_message?: string | null;
  created_at: string;
  owner?: { name: string; username: string } | null;
  user?: { name: string; username: string } | null;
}

interface ProjectReviewSummary {
  task_count: number;
  succeeded_count: number;
  failed_count: number;
  running_count: number;
  success_rate: number;
  estimated_credits: number;
  charged_credits: number;
  refunded_credits: number;
  official_cost_minor: number;
  official_cost_micros?: number;
  official_cost_currency: string | null;
  official_cost_totals?: Array<{ currency: string; amount_minor: number; amount_micros: number }>;
  official_pending_count: number;
  cost_unknown_count: number;
  high_cost_tasks: ReviewTaskItem[];
  failed_tasks: ReviewTaskItem[];
}

interface CostLedgerItem {
  id: string;
  source_type: string;
  source_id: string | null;
  task_id: string | null;
  user_id: string | null;
  project_id: string | null;
  provider_name: string;
  provider_task_id: string | null;
  event_type: string;
  amount_minor: number | null;
  amount_micros: number | null;
  currency: string | null;
  usage_quantity: number | null;
  usage_unit: string | null;
  cost_source: string;
  confidence: string;
  official_charge_id: string | null;
  reason: string | null;
  occurred_at: string;
  created_at: string;
  user?: { id: string; name: string; username: string; email: string } | null;
  task?: (TaskItem & {
    provider_official_amount_micros?: number | null;
    provider_final_amount_micros?: number | null;
    provider_billing_status?: string | null;
  }) | null;
  allocations?: Array<{
    id: string;
    allocation_type: string;
    allocation_id: string;
    amount_minor: number | null;
    amount_micros: number | null;
    currency: string | null;
    reason: string | null;
  }>;
}

function projectDisplayName(project: ProjectDetail): string {
  if (project.type === 'personal') return '个人空间';
  return project.name;
}

function roleLabel(role: string): string {
  if (role === 'admin') return '管理员';
  if (role === 'project_owner') return '负责人';
  if (role === 'editor') return '可编辑';
  if (role === 'member') return '可生成';
  if (role === 'viewer') return '仅查看';
  return role || '-';
}

function statusLabel(status: string): string {
  if (status === 'active') return '进行中';
  if (status === 'archived') return '已归档';
  return status;
}

function canDeleteProject(project: ProjectDetail): boolean {
  return project.type === 'team' && (project._count?.tasks ?? 0) === 0 && (project._count?.reference_albums ?? 0) === 0;
}

function formatAmountMinor(amount: number | null | undefined, currency?: string | null): string {
  if (amount === null || amount === undefined) return '待官方确认';
  const value = amount / 100;
  if (currency === 'USD') return `$${value.toFixed(2)}`;
  return `¥${value.toFixed(2)}`;
}

function currencyPrefix(currency?: string | null): string {
  if (currency === 'USD') return '$';
  if (!currency || currency === 'CNY') return '¥';
  return `${currency} `;
}

function formatAmountMicros(amount: number | null | undefined, currency?: string | null): string {
  if (amount === null || amount === undefined) return '待官方确认';
  const value = amount / 1000000;
  return `${currencyPrefix(currency)}${value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  })}`;
}

function formatLedgerAmount(item: {
  amount_micros?: number | null;
  amount_minor?: number | null;
  currency?: string | null;
}): string {
  if (item.amount_micros !== null && item.amount_micros !== undefined) {
    return formatAmountMicros(item.amount_micros, item.currency);
  }
  return formatAmountMinor(item.amount_minor, item.currency);
}

function formatCostTotals(totals?: Array<{ currency: string; amount_minor: number; amount_micros: number }>): string {
  if (!totals || totals.length === 0) return '待官方确认';
  return totals.map((item) => formatAmountMicros(item.amount_micros, item.currency)).join(' · ');
}

function costStatusLabel(status: string): string {
  if (status === 'estimated_by_rule') return '规则预估';
  if (status === 'provisional_settled') return '临时结算';
  if (status === 'official_confirmed') return '官方确认';
  if (status === 'reconciled') return '已对账';
  if (status === 'failed_no_charge') return '失败未收费';
  if (status === 'unknown') return '待确认';
  if (status === 'disputed') return '异常';
  return '未记录';
}

function costEventLabel(eventType: string): string {
  if (eventType === 'official_charge') return '官方扣费';
  if (eventType === 'adjustment') return '调整';
  if (eventType === 'reversal') return '冲正';
  return eventType;
}

function confidenceLabel(confidence: string): string {
  if (confidence === 'confirmed') return '已确认';
  if (confidence === 'reconciled') return '已对账';
  if (confidence === 'provisional') return '临时';
  if (confidence === 'estimated') return '预估';
  if (confidence === 'disputed') return '异常';
  if (confidence === 'unknown') return '待确认';
  return confidence || '-';
}

function taskOwnerLabel(task: TaskItem | ReviewTaskItem): string {
  return task.owner?.name || task.owner?.username || task.user?.name || task.user?.username || '-';
}

function ledgerOwnerLabel(ledger: CostLedgerItem): string {
  return ledger.task ? taskOwnerLabel(ledger.task) : ledger.user?.name || ledger.user?.username || '-';
}

function safeVideoSrc(url?: string | null): string | null {
  if (!url) return null;
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('/')) return url;
  return null;
}

function providerTaskIdLabel(ledger: CostLedgerItem): string {
  return ledger.provider_task_id || ledger.task?.provider_task_id || '-';
}

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [costLedgers, setCostLedgers] = useState<CostLedgerItem[]>([]);
  const [referenceAlbums, setReferenceAlbums] = useState<ReferenceAlbumItem[]>([]);
  const [reviewSummary, setReviewSummary] = useState<ProjectReviewSummary | null>(null);
  const [permissions, setPermissions] = useState<ProjectPermissions>({
    can_manage_project: false,
    can_manage_members: false,
    can_manage_assets: false,
    can_generate: false,
    role: '',
  });
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [memberUserId, setMemberUserId] = useState('');
  const [memberRole, setMemberRole] = useState('member');
  const [joinUrl, setJoinUrl] = useState('');
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');

  const loadProject = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/projects/${projectId}`, { cache: 'no-store' });
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || data.message || '项目加载失败');
        setProject(null);
        return;
      }
      setProject(data.project);
      setEditName(data.project?.name || '');
      setEditDescription(data.project?.description || '');
      setTasks(data.tasks || []);
      setCostLedgers(data.cost_ledgers || []);
      setReferenceAlbums(data.reference_albums || []);
      setReviewSummary(data.review_summary || null);
      setPermissions(data.permissions || {
        can_manage_project: false,
        can_manage_members: false,
        can_manage_assets: false,
        can_generate: false,
        role: '',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '项目加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProject();
  }, [projectId]);

  const addMember = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');
    const res = await fetch(`/api/projects/${projectId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: memberUserId, role: memberRole }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || data.message || '添加成员失败');
      return;
    }
    setMemberUserId('');
    setMessage('成员已加入项目');
    await loadProject();
  };

  const createInvite = async () => {
    setError('');
    setMessage('');
    const res = await fetch(`/api/projects/${projectId}/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ default_role: 'member', expires_days: 7 }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || data.message || '创建邀请失败');
      return;
    }
    const url = `${window.location.origin}${data.join_url}`;
    setJoinUrl(url);
    setMessage('邀请链接已创建');
    await loadProject();
  };

  const updateProjectInfo = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');
    const res = await fetch(`/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editName, description: editDescription }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || data.message || '更新项目失败');
      return;
    }
    setMessage('项目信息已更新');
    await loadProject();
  };

  const updateProjectStatus = async (action: 'archive' | 'restore') => {
    if (!project) return;
    const label = action === 'archive' ? '归档为只读' : '恢复';
    const description = action === 'archive'
      ? '归档后项目仍可查看，但不能继续生成或新增素材。'
      : '恢复后项目可继续生成和新增素材。';
    setError('');
    setMessage('');
    if (!window.confirm(`确定${label}「${projectDisplayName(project)}」吗？\n${description}`)) return;
    const res = await fetch(`/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || data.message || `${label}项目失败`);
      return;
    }
    setMessage(`项目已${label}`);
    await loadProject();
  };

  const deleteProject = async () => {
    if (!project) return;
    setError('');
    setMessage('');
    if (!window.confirm(`确定删除空项目「${projectDisplayName(project)}」吗？删除后不会出现在项目列表。`)) return;
    const res = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || data.message || '删除项目失败');
      return;
    }
    window.location.href = '/projects';
  };

  const removeMember = async (userId: string) => {
    if (!project) return;
    setError('');
    setMessage('');
    if (!window.confirm('确定移除此项目成员吗？')) return;
    const res = await fetch(`/api/projects/${projectId}/members/${userId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || data.message || '移除成员失败');
      return;
    }
    setMessage('成员已移除');
    await loadProject();
  };

  if (loading) {
    return <div className="card"><p className="text-gray">加载中...</p></div>;
  }

  if (!project) {
    return (
      <div className="card">
        <p className="text-red">{error || '项目不存在或无权访问'}</p>
        <Link href="/projects" className="btn btn-secondary mt-4">返回项目列表</Link>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{projectDisplayName(project)}</h1>
        <p className="page-description">{project.description || '项目中的生成任务、参考图集和成员协作。'}</p>
      </div>

      {(message || error) && (
        <div className="card" style={{ borderColor: error ? 'rgba(248,113,113,0.35)' : 'rgba(74,222,128,0.35)' }}>
          <p className={error ? 'text-red' : 'text-green'}>{error || message}</p>
          {joinUrl && (
            <p className="text-sm mt-2">
              邀请链接：<a className="link" href={joinUrl}>{joinUrl}</a>
            </p>
          )}
        </div>
      )}

      {project.status === 'archived' && (
        <div className="card" style={{ borderColor: 'rgba(250,204,21,0.35)' }}>
          <p className="text-gray">此项目已归档为只读，历史任务和图集仍可查看，但不能继续生成或新增素材。</p>
        </div>
      )}

      <div className="card">
        <div className="flex items-center justify-between" style={{ gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h2 className="section-title mb-0">项目概览</h2>
            <p className="text-gray text-sm mt-2">
              {statusLabel(project.status)} · {roleLabel(permissions.role)} · 成员 {project._count?.members ?? 0} · 任务 {project._count?.tasks ?? 0} · 图集 {project._count?.reference_albums ?? 0}
            </p>
          </div>
          {permissions.can_generate ? (
            <Link href={`/generate?project_id=${project.id}`} className="btn btn-primary">
              在此项目生成
            </Link>
          ) : (
            <span className="text-gray text-sm">当前状态或权限不可生成</span>
          )}
        </div>
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-4" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 className="section-title mb-0">项目复盘</h2>
            <p className="text-gray text-sm mt-2">这里看项目怎么被使用：点数、任务、失败和官方成本确认状态。</p>
          </div>
          <Link className="btn btn-secondary" href={`/api/projects/${project.id}/costs/export`}>
            导出明细
          </Link>
        </div>

        <div className="stats-grid">
          <div className="stat-card">
            <span className="stat-label">任务数</span>
            <strong className="stat-value">{reviewSummary?.task_count ?? 0}</strong>
            <span className="stat-sub">成功率 {reviewSummary?.success_rate ?? 0}%</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">点数消耗</span>
            <strong className="stat-value">{reviewSummary?.charged_credits ?? 0}</strong>
            <span className="stat-sub">预估 {reviewSummary?.estimated_credits ?? 0} · 返还 {reviewSummary?.refunded_credits ?? 0}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">官方成本</span>
            <strong className="stat-value">
              {reviewSummary?.official_cost_totals
                ? formatCostTotals(reviewSummary.official_cost_totals)
                : formatAmountMinor(reviewSummary?.official_cost_minor, reviewSummary?.official_cost_currency)}
            </strong>
            <span className="stat-sub">待确认 {reviewSummary?.official_pending_count ?? 0} 条</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">失败 / 异常</span>
            <strong className="stat-value">{reviewSummary?.failed_count ?? 0}</strong>
            <span className="stat-sub">成本待确认 {reviewSummary?.cost_unknown_count ?? 0} 条</span>
          </div>
        </div>

        {reviewSummary && reviewSummary.high_cost_tasks.length > 0 && (
          <div className="mt-6">
            <h3 className="section-title">高点数任务</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>任务</th>
                  <th>创建者</th>
                  <th>状态</th>
                  <th>点数</th>
                  <th>成本状态</th>
                </tr>
              </thead>
              <tbody>
                {reviewSummary.high_cost_tasks.map((task) => (
                  <tr key={task.id}>
                    <td className="truncate" style={{ maxWidth: 360 }}>
                      <Link className="link" href={`/tasks/${task.id}`}>{task.prompt || task.id}</Link>
                    </td>
                    <td>{taskOwnerLabel(task)}</td>
                    <td>{task.local_status}</td>
                    <td>{task.actual_cost ?? task.estimated_cost ?? 0}</td>
                    <td>{costStatusLabel(task.provider_cost_status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-4" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 className="section-title mb-0">官方真实成本明细</h2>
            <p className="text-gray text-sm mt-2">按 official_charge / adjustment / reversal 账本行展示，可从每笔成本追到视频任务。</p>
          </div>
          <span className="text-gray text-sm">最近 {costLedgers.length} 条</span>
        </div>

        {costLedgers.length === 0 ? (
          <p className="text-gray">暂无官方真实成本账本。Seedance 返回实际扣费后，或管理员录入官方账单后会显示在这里。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>视频 / 任务</th>
                <th>创建人</th>
                <th>Provider Task</th>
                <th>官方成本</th>
                <th>成本状态</th>
                <th>时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {costLedgers.map((ledger) => {
                const task = ledger.task;
                const videoUrl = safeVideoSrc(task?.result_video_url || task?.local_video_path);
                const providerTaskId = providerTaskIdLabel(ledger);

                return (
                  <tr key={ledger.id}>
                    <td>
                      <div className="flex items-center" style={{ gap: 10, minWidth: 300 }}>
                        {videoUrl ? (
                          <video
                            src={videoUrl}
                            muted
                            preload="metadata"
                            style={{ width: 72, height: 44, objectFit: 'cover', borderRadius: 8, background: 'rgba(15,23,42,0.8)' }}
                          />
                        ) : (
                          <div style={{
                            width: 72,
                            height: 44,
                            borderRadius: 8,
                            display: 'grid',
                            placeItems: 'center',
                            background: 'rgba(15,23,42,0.8)',
                            color: 'rgba(148,163,184,0.95)',
                            fontSize: 12,
                          }}>
                            无视频
                          </div>
                        )}
                        <div style={{ minWidth: 0 }}>
                          {task ? (
                            <Link className="link truncate" style={{ display: 'block', maxWidth: 320 }} href={`/tasks/${task.id}`} title={task.prompt || task.id}>
                              {task.prompt || task.id}
                            </Link>
                          ) : (
                            <span className="truncate" style={{ display: 'block', maxWidth: 320 }} title={ledger.reason || ledger.source_id || ledger.id}>
                              {ledger.reason || ledger.source_id || ledger.id}
                            </span>
                          )}
                          <span className="text-gray text-sm">
                            {task?.local_status || ledger.source_type} · {costEventLabel(ledger.event_type)}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td>{ledgerOwnerLabel(ledger)}</td>
                    <td>
                      <span title={providerTaskId} style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                        {providerTaskId === '-' ? '-' : `${providerTaskId.slice(0, 18)}${providerTaskId.length > 18 ? '...' : ''}`}
                      </span>
                    </td>
                    <td>
                      <strong>{formatLedgerAmount(ledger)}</strong>
                      {ledger.allocations && ledger.allocations.length > 0 && (
                        <div className="text-gray text-sm">
                          项目分摊 {formatLedgerAmount(ledger.allocations[0])}
                        </div>
                      )}
                    </td>
                    <td>
                      <span>{task ? costStatusLabel(task.provider_cost_status) : confidenceLabel(ledger.confidence)}</span>
                      <div className="text-gray text-sm">
                        {confidenceLabel(ledger.confidence)}
                        {task?.provider_billing_status ? ` · ${task.provider_billing_status}` : ''}
                      </div>
                    </td>
                    <td>{new Date(ledger.occurred_at || ledger.created_at).toLocaleString('zh-CN')}</td>
                    <td>
                      {task ? (
                        <Link className="link" href={`/tasks/${task.id}`}>查看任务</Link>
                      ) : (
                        <span className="text-gray">无任务</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2 className="section-title">生成任务</h2>
        {tasks.length === 0 ? (
          <p className="text-gray">暂无生成任务</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>任务 ID</th>
                <th>提示词</th>
                <th>状态</th>
                <th>创建者</th>
                <th>点数</th>
                <th>成本状态</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.id}>
                  <td>{task.id.slice(0, 10)}...</td>
                  <td className="truncate" style={{ maxWidth: 280 }} title={task.prompt}>{task.prompt}</td>
                  <td>{task.local_status}</td>
                  <td>{taskOwnerLabel(task)}</td>
                  <td>{task.actual_cost ?? task.estimated_cost ?? '-'}</td>
                  <td>{costStatusLabel(task.provider_cost_status)}</td>
                  <td>{new Date(task.created_at).toLocaleString('zh-CN')}</td>
                  <td><Link className="link" href={`/tasks/${task.id}`}>详情</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-4" style={{ gap: 12, flexWrap: 'wrap' }}>
          <h2 className="section-title mb-0">项目参考图集</h2>
          <Link className="btn btn-secondary" href={`/collections?scope=project&project_id=${project.id}`}>
            查看图集
          </Link>
        </div>
        {referenceAlbums.length === 0 ? (
          <p className="text-gray">暂无项目图集</p>
        ) : (
          <div className="shell-link-grid">
            {referenceAlbums.map((album) => (
              <Link key={album.id} className="shell-link-card" href={`/collections/${album.id}`}>
                <strong>{album.name}</strong>
                <span>{album.description || '项目参考图集'}</span>
                <span>{album.image_count} 张 · {statusLabel(album.status)}</span>
                <span>更新 {new Date(album.updated_at).toLocaleDateString('zh-CN')}</span>
              </Link>
            ))}
          </div>
        )}
        {!permissions.can_manage_assets && (
          <p className="text-gray text-sm mt-4">当前角色可查看或使用项目素材，但不能修改项目图集。</p>
        )}
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="section-title mb-0">项目成员</h2>
          <span className="text-gray text-sm">{project.members.length} 人</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>成员</th>
              <th>账号类型</th>
              <th>平台角色</th>
              <th>项目权限</th>
              <th>加入时间</th>
              {permissions.can_manage_members && <th>操作</th>}
            </tr>
          </thead>
          <tbody>
            {project.members.map((member) => (
              <tr key={member.id}>
                <td>{member.user.name} <span className="text-gray">({member.user.username})</span></td>
                <td>{member.user.account_type}</td>
                <td>{member.user.role}</td>
                <td>{roleLabel(member.role)}</td>
                <td>{new Date(member.joined_at).toLocaleString('zh-CN')}</td>
                {permissions.can_manage_members && (
                  <td>
                    <button
                      className="btn btn-danger"
                      type="button"
                      onClick={() => removeMember(member.user_id)}
                      disabled={member.user_id === project.owner_user_id}
                    >
                      移除
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {permissions.can_manage_members && (
        <div className="card">
          <h2 className="section-title">成员管理</h2>
          <form onSubmit={addMember} style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 1fr) 180px auto', gap: 12, alignItems: 'center' }}>
            <input className="input" value={memberUserId} onChange={(event) => setMemberUserId(event.target.value)} placeholder="用户 ID" />
            <select className="input" value={memberRole} onChange={(event) => setMemberRole(event.target.value)}>
              <option value="editor">可编辑</option>
              <option value="member">可生成</option>
              <option value="viewer">仅查看</option>
            </select>
            <button className="btn btn-primary" type="submit" disabled={!memberUserId.trim()}>添加成员</button>
          </form>
          <button className="btn btn-secondary mt-4" type="button" onClick={createInvite}>
            生成 7 天邀请链接
          </button>
        </div>
      )}

      {permissions.can_manage_project && (
        <div className="card">
          <h2 className="section-title">项目设置</h2>
          <form onSubmit={updateProjectInfo} style={{ display: 'grid', gap: 12, maxWidth: 680 }}>
            <input
              className="input"
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
              placeholder="项目名称"
              disabled={project.type === 'personal'}
            />
            <textarea
              className="input"
              value={editDescription}
              onChange={(event) => setEditDescription(event.target.value)}
              placeholder="项目说明"
              rows={3}
            />
            <button className="btn btn-primary" type="submit" disabled={!editName.trim()}>
              保存信息
            </button>
          </form>
        </div>
      )}

      {permissions.can_manage_project && (
        <div className="card" style={{ borderColor: 'rgba(248,113,113,0.25)' }}>
          <h2 className="section-title">危险操作</h2>
          <div className="flex items-center" style={{ gap: 10, flexWrap: 'wrap' }}>
            {project.status === 'archived' ? (
              <button className="btn btn-secondary" type="button" onClick={() => updateProjectStatus('restore')}>
                恢复项目
              </button>
            ) : (
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => updateProjectStatus('archive')}
                disabled={project.type !== 'team'}
              >
                归档为只读
              </button>
            )}
            <button
              className="btn btn-danger"
              type="button"
              onClick={deleteProject}
              disabled={!canDeleteProject(project)}
              title={canDeleteProject(project) ? '删除空协作项目' : '仅没有任务和图集的协作项目可删除'}
            >
              删除空项目
            </button>
          </div>
          <p className="text-gray text-sm mt-4">
            归档会保留历史任务和图集；删除只允许没有任务和图集的协作项目。
          </p>
        </div>
      )}
    </div>
  );
}
