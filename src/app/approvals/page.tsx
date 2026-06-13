'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import PageBanner from '@/components/PageBanner';
import UserIdentityBadge from '@/components/UserIdentityBadge';

type ApprovalUser = {
  id: string;
  name: string;
  username: string;
  email?: string;
  avatar_url?: string | null;
  account_type?: string | null;
};

type ApprovalItem = {
  id: string;
  type: string;
  status: string;
  project_id: string | null;
  video_card_id: string | null;
  task_id: string | null;
  reason: string | null;
  decision_reason: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  expires_at: string | null;
  created_at: string;
  project?: { id: string; name: string; type: string; status: string } | null;
  videoCard?: { id: string; title: string; status: string; project_id: string } | null;
  task?: { id: string; prompt: string; local_status: string } | null;
  requester?: ApprovalUser | null;
  approver?: ApprovalUser | null;
};

const APPROVAL_TYPE_OPTIONS = [
  ['resolution_1080p', '1080p 生成'],
  ['budget_increase', '追加预算'],
  ['ratio_change', '比例变更'],
  ['video_card_reopen', '视频卡重开'],
  ['project_create', '公共项目立项'],
] as const;

function typeLabel(type: string) {
  return APPROVAL_TYPE_OPTIONS.find(([value]) => value === type)?.[1] || type;
}

function statusLabel(status: string) {
  if (status === 'pending') return '待审批';
  if (status === 'approved') return '已通过';
  if (status === 'rejected') return '已拒绝';
  if (status === 'expired') return '已失效';
  if (status === 'cancelled') return '已取消';
  return status;
}

function formatTime(value?: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN') : '-';
}

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [type, setType] = useState('resolution_1080p');
  const [projectId, setProjectId] = useState('');
  const [videoCardId, setVideoCardId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/approvals', { cache: 'no-store' });
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || data.message || '审批加载失败');
        return;
      }
      setApprovals(data.approvals || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : '审批加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const createApproval = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');
    setSubmitting(true);
    try {
      const res = await fetch('/api/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          project_id: projectId.trim() || null,
          video_card_id: videoCardId.trim() || null,
          task_id: taskId.trim() || null,
          reason: reason.trim() || null,
          payload: { source: 'approvals_page' },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || data.message || '审批发起失败');
        return;
      }
      setMessage('审批已发起');
      setReason('');
      await load();
    } finally {
      setSubmitting(false);
    }
  };

  const decide = async (approval: ApprovalItem, action: 'approve' | 'reject') => {
    setError('');
    setMessage('');
    const label = action === 'approve' ? '通过' : '拒绝';
    const decisionReason = window.prompt(`${label}审批：${typeLabel(approval.type)}`, action === 'approve' ? '审批通过' : '审批拒绝');
    if (decisionReason === null) return;
    const res = await fetch(`/api/approvals/${approval.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, reason: decisionReason }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || data.message || `${label}审批失败`);
      return;
    }
    setMessage(`审批已${label}`);
    await load();
  };

  return (
    <div>
      <PageBanner
        eyebrow="审批中心"
        title="成本与规格审批"
        description="集中处理 1080p、预算、比例变更和视频卡重开。"
        actions={<Link className="btn btn-secondary" href="/generate">返回生成页</Link>}
      />

      {(message || error) && (
        <div className="card" style={{ borderColor: error ? 'rgba(248,113,113,0.35)' : 'rgba(74,222,128,0.35)' }}>
          <p className={error ? 'text-red' : 'text-green'}>{error || message}</p>
        </div>
      )}

      <div className="card">
        <h2 className="section-title">发起审批</h2>
        <form className="approval-form" onSubmit={createApproval}>
          <select className="input" value={type} onChange={(event) => setType(event.target.value)}>
            {APPROVAL_TYPE_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <input className="input" value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="项目 ID" />
          <input className="input" value={videoCardId} onChange={(event) => setVideoCardId(event.target.value)} placeholder="视频卡 ID，可选" />
          <input className="input" value={taskId} onChange={(event) => setTaskId(event.target.value)} placeholder="任务 ID，可选" />
          <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="申请理由" />
          <button className="btn btn-primary" type="submit" disabled={submitting}>{submitting ? '提交中...' : '提交审批'}</button>
        </form>
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-4" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 className="section-title mb-0">审批记录</h2>
            <p className="text-gray text-sm mt-2">待审批、我发起的、已通过和已拒绝记录集中在这里。</p>
          </div>
          <button className="btn btn-secondary" type="button" onClick={load}>刷新</button>
        </div>

        {loading ? (
          <p className="text-gray">加载中...</p>
        ) : approvals.length === 0 ? (
          <p className="text-gray">暂无审批记录。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>类型</th>
                <th>项目 / 视频卡</th>
                <th>申请人</th>
                <th>状态</th>
                <th>原因</th>
                <th>有效期</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {approvals.map((approval) => (
                <tr key={approval.id}>
                  <td>{typeLabel(approval.type)}</td>
                  <td>
                    {approval.project ? (
                      <Link className="link" href={`/projects/${approval.project.id}`}>{approval.project.name}</Link>
                    ) : approval.project_id || '-'}
                    {approval.videoCard && (
                      <div className="text-gray text-sm">
                        <Link className="link" href={`/projects/${approval.videoCard.project_id}/video-cards/${approval.videoCard.id}`}>{approval.videoCard.title}</Link>
                      </div>
                    )}
                  </td>
                  <td><UserIdentityBadge user={approval.requester} size="sm" /></td>
                  <td>{statusLabel(approval.status)}</td>
                  <td className="truncate" style={{ maxWidth: 280 }} title={approval.reason || ''}>{approval.reason || '-'}</td>
                  <td>{formatTime(approval.expires_at)}</td>
                  <td>
                    {approval.status === 'pending' ? (
                      <div className="approval-actions">
                        <button className="btn btn-secondary" type="button" onClick={() => decide(approval, 'approve')}>通过</button>
                        <button className="btn btn-danger" type="button" onClick={() => decide(approval, 'reject')}>拒绝</button>
                      </div>
                    ) : (
                      <span className="text-gray">{approval.approver ? `处理人：${approval.approver.name}` : statusLabel(approval.status)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
