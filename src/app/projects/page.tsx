'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Download } from 'lucide-react';
import PageBanner from '@/components/PageBanner';
import PaginationControls from '@/components/PaginationControls';
import ProjectActionConfirmModal from '@/components/ProjectActionConfirmModal';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { externalFallbackPath, isExternalUser } from '@/lib/access/external-role';
import { BULK_VIDEO_DOWNLOAD_CLIENT_LIMIT, downloadBulkVideoZip } from '@/lib/video/download-client';

interface ProjectItem {
  id: string;
  name: string;
  description: string | null;
  type: string;
  visibility: string;
  status: string;
  owner_user_id: string;
  updated_at: string;
  my_role: string | null;
  downloadable_task_count?: number;
  owner?: { id?: string; name: string | null; username: string | null; email?: string | null; avatar_url?: string | null; account_type?: string | null };
  _count?: { members: number; tasks: number; reference_albums?: number };
}

interface ReviewBudgetSuggestion {
  suggested_credits: number;
  sample_count: number;
  risk_hint: string;
}

type ProjectAction = 'archive' | 'restore' | 'delete';

type PendingProjectAction = {
  project: ProjectItem;
  action: ProjectAction;
};

function canManageProject(project: ProjectItem): boolean {
  return project.my_role === 'admin' || project.my_role === 'project_owner';
}

function canDeleteProject(project: ProjectItem): boolean {
  return project.type === 'team' && (project._count?.tasks ?? 0) === 0 && (project._count?.reference_albums ?? 0) === 0;
}

function canShowDeleteProjectAction(project: ProjectItem): boolean {
  return project.type === 'team';
}

function projectDisplayName(project: ProjectItem): string {
  if (project.type === 'personal') return '个人空间';
  return project.name;
}

function projectOwnerUser(project: ProjectItem) {
  return project.owner || { id: project.owner_user_id, name: null, username: null };
}

function projectRoleLabel(role: string | null): string {
  if (role === 'admin') return '管理员';
  if (role === 'project_owner') return '负责人';
  if (role === 'editor') return '可编辑';
  if (role === 'member') return '可生成';
  if (role === 'viewer') return '仅查看';
  return '-';
}

function projectStatusLabel(status: string): string {
  if (status === 'active') return '进行中';
  if (status === 'archived') return '已归档';
  return status;
}

function projectBillingLabel(project: Pick<ProjectItem, 'type'>): string {
  if (project.type === 'public') return '预算记账';
  if (project.type === 'system') return '系统记账';
  return '默认记账';
}

function projectBillingDescription(project: Pick<ProjectItem, 'type'>): string {
  if (project.type === 'public') return '生成消耗从项目预算池冻结和实扣';
  if (project.type === 'system') return '系统项目按平台规则归集成本';
  return '生成消耗扣发起人的个人积分';
}

function projectActionMeta(project: ProjectItem): string {
  return [
    projectStatusLabel(project.status),
    `任务 ${project._count?.tasks ?? 0}`,
    `图集 ${project._count?.reference_albums ?? 0}`,
  ].join(' · ');
}

const PROJECTS_PAGE_SIZE = 12;

export default function ProjectsPage() {
  const router = useRouter();
  const { user: currentUser, hasLoadedUser, loadingUser, refreshUser } = useAppSession();
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'active' | 'archived'>('active');
  const [page, setPage] = useState(1);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [billingMode, setBillingMode] = useState<'default' | 'budget'>('default');
  const [initialBudgetCredits, setInitialBudgetCredits] = useState('');
  const [reviewBudgetSuggestion, setReviewBudgetSuggestion] = useState<ReviewBudgetSuggestion | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [downloadProject, setDownloadProject] = useState<ProjectItem | null>(null);
  const [downloadingProjectId, setDownloadingProjectId] = useState<string | null>(null);
  const [pendingProjectAction, setPendingProjectAction] = useState<PendingProjectAction | null>(null);
  const [projectActionBusy, setProjectActionBusy] = useState(false);

  useEffect(() => {
    if (!hasLoadedUser && !loadingUser) void refreshUser();
  }, [hasLoadedUser, loadingUser, refreshUser]);

  useEffect(() => {
    if (hasLoadedUser && isExternalUser(currentUser)) {
      router.replace(externalFallbackPath());
    }
  }, [currentUser, hasLoadedUser, router]);

  const loadProjects = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/projects?include_archived=true', { cache: 'no-store' });
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      const data = await res.json();
      setProjects(data.projects || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : '项目加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProjects();
  }, []);

  useEffect(() => {
    if (billingMode !== 'budget') return;
    let cancelled = false;
    fetch('/api/review-cards?project_type=public&limit=5', { cache: 'no-store' })
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (cancelled || !data?.review_cards?.length) return;
        const cards = data.review_cards
          .map((card: { budget_suggestion_credits?: number | null; failure_rate?: number | null }) => ({
            budget: Number(card.budget_suggestion_credits || 0),
            failureRate: Number(card.failure_rate || 0),
          }))
          .filter((item: { budget: number }) => item.budget > 0);
        if (cards.length === 0) return;
        const averageBudget = cards.reduce((sum: number, item: { budget: number }) => sum + item.budget, 0) / cards.length;
        const averageFailureRate = cards.reduce((sum: number, item: { failureRate: number }) => sum + item.failureRate, 0) / cards.length;
        setReviewBudgetSuggestion({
          suggested_credits: Math.ceil(averageBudget),
          sample_count: cards.length,
          risk_hint: averageFailureRate >= 0.25 ? '历史失败率偏高，建议预留更多试错预算。' : '历史失败率正常，可按建议预算作为起点。',
        });
      })
      .catch(() => {
        if (!cancelled) setReviewBudgetSuggestion(null);
      });
    return () => {
      cancelled = true;
    };
  }, [billingMode]);

  const createProject = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');
    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    if (!trimmedName) {
      setError('项目名称不能为空');
      return;
    }
    if (billingMode === 'budget') {
      const params = new URLSearchParams({
        type: 'project_create',
        reason: `申请公共项目预算记账立项：${trimmedName}${trimmedDescription ? `。项目说明：${trimmedDescription}` : ''}`,
        project_name: trimmedName,
      });
      if (trimmedDescription) params.set('project_description', trimmedDescription);
      if (initialBudgetCredits.trim()) params.set('initial_budget_credits', initialBudgetCredits.trim());
      window.location.href = `/approvals?${params.toString()}`;
      return;
    }
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmedName, description: trimmedDescription, type: 'team' }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || data.message || '创建项目失败');
      return;
    }
    setName('');
    setDescription('');
    setBillingMode('default');
    setInitialBudgetCredits('');
    setMessage('项目已创建，记账方式：默认记账（生成扣发起人的个人积分）');
    await loadProjects();
  };

  const requestProjectAction = (project: ProjectItem, action: ProjectAction) => {
    setError('');
    setMessage('');
    setPendingProjectAction({ project, action });
  };

  const confirmProjectAction = async () => {
    if (!pendingProjectAction) return;

    const { project, action } = pendingProjectAction;
    const label = action === 'archive' ? '归档为只读' : action === 'restore' ? '恢复' : '删除';

    setProjectActionBusy(true);
    try {
      const res = await fetch(`/api/projects/${project.id}`, action === 'delete'
        ? { method: 'DELETE' }
        : {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action }),
          });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || data.message || `${label}项目失败`);
        return;
      }
      setPendingProjectAction(null);
      setMessage(action === 'delete' ? '项目已删除' : `项目已${label}`);
      await loadProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label}项目失败`);
      setPendingProjectAction(null);
    } finally {
      setProjectActionBusy(false);
    }
  };

  const handleProjectDownload = async () => {
    if (!downloadProject) return;
    const count = downloadProject.downloadable_task_count || 0;
    if (count <= 0 || count > BULK_VIDEO_DOWNLOAD_CLIENT_LIMIT) return;

    setError('');
    setMessage('');
    setDownloadingProjectId(downloadProject.id);
    try {
      const result = await downloadBulkVideoZip({ projectId: downloadProject.id });
      setMessage(`已开始下载项目视频包：${result.success} 个视频${result.failed ? `，${result.failed} 个失败见 manifest` : ''}`);
      setDownloadProject(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '项目视频包下载失败');
    } finally {
      setDownloadingProjectId(null);
    }
  };

  const nameCounts = projects.reduce<Record<string, number>>((counts, project) => {
    const name = projectDisplayName(project);
    counts[name] = (counts[name] || 0) + 1;
    return counts;
  }, {});
  const visibleProjects = projects.filter((project) => activeTab === 'active' ? project.status === 'active' : project.status === 'archived');
  const activeCount = projects.filter((project) => project.status === 'active').length;
  const archivedCount = projects.filter((project) => project.status === 'archived').length;
  const totalPages = Math.max(1, Math.ceil(visibleProjects.length / PROJECTS_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pagedProjects = visibleProjects.slice(
    (currentPage - 1) * PROJECTS_PAGE_SIZE,
    currentPage * PROJECTS_PAGE_SIZE,
  );

  return (
    <div>
      <PageBanner
        eyebrow="项目"
        title="我的项目"
        description="项目是生成内容的归属空间；只有项目成员才能查看项目内任务和结果。"
      />

      {(message || error) && (
        <div className="card" style={{ borderColor: error ? 'rgba(248,113,113,0.35)' : 'rgba(74,222,128,0.35)' }}>
          <p className={error ? 'text-red' : 'text-green'}>{error || message}</p>
        </div>
      )}

      <div className="card">
        <h2 className="section-title">创建协作项目</h2>
        <form onSubmit={createProject} style={{ display: 'grid', gap: 12, maxWidth: 620 }}>
          <input
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="项目名称"
          />
          <textarea
            className="input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="项目说明（可选）"
            rows={3}
          />
          <div className="project-billing-choice-group" role="radiogroup" aria-label="项目记账方式">
            <label className={`project-billing-choice ${billingMode === 'default' ? 'is-selected' : ''}`}>
              <input
                type="radio"
                name="projectBillingMode"
                value="default"
                checked={billingMode === 'default'}
                onChange={() => setBillingMode('default')}
              />
              <span>
                <strong>默认记账</strong>
                <small>创建普通协作项目，生成消耗扣发起人的个人积分。</small>
              </span>
            </label>
            <label className={`project-billing-choice ${billingMode === 'budget' ? 'is-selected' : ''}`}>
              <input
                type="radio"
                name="projectBillingMode"
                value="budget"
                checked={billingMode === 'budget'}
                onChange={() => setBillingMode('budget')}
              />
              <span>
                <strong>预算记账</strong>
                <small>用于公共项目，生成消耗走项目预算池；需要先发起公共项目立项审批。</small>
              </span>
            </label>
          </div>
          {billingMode === 'budget' && (
            <>
              <input
                className="input"
                value={initialBudgetCredits}
                onChange={(event) => setInitialBudgetCredits(event.target.value)}
                placeholder="初始项目预算点数，可选"
                inputMode="decimal"
              />
              {reviewBudgetSuggestion && (
                <div className="project-budget-suggestion">
                  <div>
                    <strong>历史复盘建议预算：{reviewBudgetSuggestion.suggested_credits} 点</strong>
                    <span>
                      {reviewBudgetSuggestion.sample_count} 个公共项目复盘样本
                      {' · '}
                      {reviewBudgetSuggestion.risk_hint}
                    </span>
                  </div>
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={() => setInitialBudgetCredits(String(reviewBudgetSuggestion.suggested_credits))}
                  >
                    使用建议预算
                  </button>
                </div>
              )}
            </>
          )}
          <button className="btn btn-primary" type="submit" disabled={!name.trim()}>
            {billingMode === 'budget' ? '发起预算记账立项审批' : '创建项目'}
          </button>
        </form>
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-4" style={{ gap: 12, flexWrap: 'wrap' }}>
          <h2 className="section-title mb-0">项目列表</h2>
          <div className="flex items-center" style={{ gap: 8 }}>
            <button
              className={`btn ${activeTab === 'active' ? 'btn-primary' : 'btn-secondary'}`}
              type="button"
              onClick={() => {
                setActiveTab('active');
                setPage(1);
              }}
            >
              进行中 {activeCount}
            </button>
            <button
              className={`btn ${activeTab === 'archived' ? 'btn-primary' : 'btn-secondary'}`}
              type="button"
              onClick={() => {
                setActiveTab('archived');
                setPage(1);
              }}
            >
              已归档 {archivedCount}
            </button>
          </div>
        </div>
        {loading ? (
          <p className="text-gray">加载中...</p>
        ) : visibleProjects.length === 0 ? (
          <p className="text-gray">{activeTab === 'active' ? '暂无进行中的项目' : '暂无归档项目'}</p>
        ) : (
          <>
            <div className="shell-link-grid">
            {pagedProjects.map((project) => {
              const displayName = projectDisplayName(project);
              const downloadableCount = project.downloadable_task_count || 0;
              const downloadTooLarge = downloadableCount > BULK_VIDEO_DOWNLOAD_CLIENT_LIMIT;
              return (
              <div key={project.id} className="shell-link-card">
                <Link href={`/projects/${project.id}`} className="link">
                  <strong>{displayName}</strong>
                </Link>
                <span>{project.description || `${project.type} · ${project.visibility}`}</span>
                <span className="project-owner-meta">
                  状态：{projectStatusLabel(project.status)}
                  {' · '}负责人：
                  <UserIdentityBadge user={projectOwnerUser(project)} size="sm" />
                </span>
                <span>
                  我的权限：{projectRoleLabel(project.my_role)}
                  {' · '}成员 {project._count?.members ?? 0}
                  {' · '}任务 {project._count?.tasks ?? 0}
                  {' · '}图集 {project._count?.reference_albums ?? 0}
                </span>
                <span>
                  记账：{projectBillingLabel(project)}
                  {' · '}{projectBillingDescription(project)}
                </span>
                <span>可下载视频 {downloadableCount}</span>
                <span>更新 {new Date(project.updated_at).toLocaleDateString('zh-CN')}</span>
                <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={() => setDownloadProject(project)}
                    disabled={downloadableCount <= 0}
                    title={downloadableCount <= 0 ? '该项目暂无可下载视频' : downloadTooLarge ? '视频数量超过第一批即时打包上限，后续走后台任务' : '下载该项目的视频包'}
                  >
                    <Download size={16} aria-hidden="true" />
                    {downloadableCount <= 0 ? '暂无可下载视频' : '下载视频包'}
                  </button>
                  {canManageProject(project) && (
                    <>
                    <Link className="btn btn-secondary" href={`/projects/${project.id}`}>
                      管理
                    </Link>
                    {project.status === 'archived' ? (
                      <button className="btn btn-secondary" type="button" onClick={() => requestProjectAction(project, 'restore')}>
                        恢复
                      </button>
                    ) : (
                      <button
                        className="btn btn-secondary"
                        type="button"
                        onClick={() => requestProjectAction(project, 'archive')}
                        disabled={project.type !== 'team'}
                      >
                        归档为只读
                      </button>
                    )}
                    {canShowDeleteProjectAction(project) && (
                      <button
                        className="btn btn-danger"
                        type="button"
                        onClick={() => requestProjectAction(project, 'delete')}
                        disabled={!canDeleteProject(project)}
                        title={canDeleteProject(project) ? '删除空协作项目' : '仅没有任务和图集的协作项目可删除'}
                      >
                        删除空项目
                      </button>
                    )}
                    </>
                  )}
                </div>
              </div>
              );
            })}
            </div>
            <PaginationControls
              page={currentPage}
              totalPages={totalPages}
              total={visibleProjects.length}
              pageSize={PROJECTS_PAGE_SIZE}
              label="项目"
              onPageChange={setPage}
            />
          </>
        )}
      </div>

      {downloadProject && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="下载项目视频包">
          <div className="modal-panel bulk-download-modal">
            <div className="modal-header">
              <div>
                <h2>下载项目视频包</h2>
                <p>{projectDisplayName(downloadProject)}</p>
              </div>
              <button className="modal-close" type="button" onClick={() => setDownloadProject(null)} aria-label="关闭">
                ×
              </button>
            </div>
            <div className="bulk-download-summary">
              <div>
                <span>可下载视频</span>
                <strong>{downloadProject.downloadable_task_count || 0}</strong>
              </div>
              <div>
                <span>即时打包上限</span>
                <strong>{BULK_VIDEO_DOWNLOAD_CLIENT_LIMIT}</strong>
              </div>
            </div>
            {(downloadProject.downloadable_task_count || 0) > BULK_VIDEO_DOWNLOAD_CLIENT_LIMIT ? (
              <p className="text-gray">
                该项目视频数量超过第一批即时打包上限，后续会走后台任务打包。当前先不发起同步下载，避免页面长时间等待。
              </p>
            ) : (
              <p className="text-gray">
                将该项目下你可见的已完成视频打包为 ZIP，ZIP 内会包含视频文件和 manifest.csv。
              </p>
            )}
            <div className="modal-actions">
              <button className="btn btn-secondary" type="button" onClick={() => setDownloadProject(null)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                type="button"
                onClick={handleProjectDownload}
                disabled={
                  downloadingProjectId === downloadProject.id
                  || (downloadProject.downloadable_task_count || 0) <= 0
                  || (downloadProject.downloadable_task_count || 0) > BULK_VIDEO_DOWNLOAD_CLIENT_LIMIT
                }
              >
                <Download size={16} aria-hidden="true" />
                {downloadingProjectId === downloadProject.id ? '打包中...' : '确认下载'}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingProjectAction && (
        <ProjectActionConfirmModal
          action={pendingProjectAction.action}
          projectName={projectDisplayName(pendingProjectAction.project)}
          meta={projectActionMeta(pendingProjectAction.project)}
          busy={projectActionBusy}
          onCancel={() => setPendingProjectAction(null)}
          onConfirm={() => void confirmProjectAction()}
        />
      )}
    </div>
  );
}
