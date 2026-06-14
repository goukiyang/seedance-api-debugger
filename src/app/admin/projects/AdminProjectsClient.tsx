'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import PageBanner from '@/components/PageBanner';
import PaginationControls from '@/components/PaginationControls';
import { displayUserName } from '@/lib/users/display';

interface ProjectItem {
  id: string;
  name: string;
  description: string | null;
  type: string;
  visibility: string;
  status: string;
  owner?: { name: string | null; username: string | null };
  _count?: { members: number; tasks: number; reference_albums?: number };
  updated_at: string;
}

type ProjectFilter = 'all' | 'active' | 'archived' | 'empty' | 'smoke';

type MergeCounts = {
  tasks: number;
  video_cards: number;
  canvases: number;
  reference_albums: number;
  reference_images: number;
  provider_requests: number;
  approval_records: number;
  content_audit_logs: number;
  cost_ledgers: number;
  cost_allocations: number;
  members: number;
  budget_accounts: number;
  budget_ledgers: number;
  projects?: number;
};

type MergePreview = {
  target_project: { id: string; name: string; status: string; type: string } | null;
  source_projects: Array<{
    project: { id: string; name: string; status: string; type: string };
    counts: MergeCounts;
    is_empty: boolean;
    can_quick_delete: boolean;
    blockers: string[];
  }>;
  blockers: string[];
  totals: MergeCounts & { projects: number };
};

function ownerLabel(project: ProjectItem): string {
  return displayUserName(project.owner);
}

function canArchive(project: ProjectItem): boolean {
  return project.type === 'team' && project.status !== 'archived';
}

function canDelete(project: ProjectItem): boolean {
  return project.type === 'team' && (project._count?.tasks ?? 0) === 0 && (project._count?.reference_albums ?? 0) === 0;
}

function projectDisplayName(project: ProjectItem): string {
  if (project.type === 'personal') return `个人空间 · ${ownerLabel(project)}`;
  return project.name;
}

function isSmokeProject(project: ProjectItem) {
  return /\bSmoke Project\b/i.test(project.name) || /closure smoke/i.test(project.description || '');
}

function formatDate(value: string) {
  return new Date(value).toLocaleString('zh-CN');
}

function countText(counts: MergeCounts) {
  return [
    `任务 ${counts.tasks}`,
    `视频卡 ${counts.video_cards}`,
    `画布 ${counts.canvases}`,
    `成本账本 ${counts.cost_ledgers}`,
    `成本分摊 ${counts.cost_allocations}`,
  ].join(' / ');
}

const ADMIN_PROJECTS_PAGE_SIZE = 20;
const SMOKE_ARCHIVE_PROJECT_NAME = 'Smoke Project Archive';

export default function AdminProjectsClient() {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [keyword, setKeyword] = useState('');
  const [filter, setFilter] = useState<ProjectFilter>('active');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [mergeOpen, setMergeOpen] = useState(false);
  const [targetProjectId, setTargetProjectId] = useState('');
  const [mergeReason, setMergeReason] = useState('合并历史 smoke 测试项目');
  const [mergeConfirmed, setMergeConfirmed] = useState(false);
  const [mergePreview, setMergePreview] = useState<MergePreview | null>(null);
  const [mergeLoading, setMergeLoading] = useState(false);
  const [mergeError, setMergeError] = useState('');

  const loadProjects = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/projects?include_archived=true&include_all=true', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '加载项目失败');
      setProjects(data.projects || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载项目失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProjects();
  }, []);

  const selectedProjects = useMemo(
    () => projects.filter((project) => selectedIds.has(project.id)),
    [projects, selectedIds],
  );

  const filteredProjects = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    return projects.filter((project) => {
      const matchesKeyword = !normalizedKeyword
        || project.name.toLowerCase().includes(normalizedKeyword)
        || project.id.toLowerCase().includes(normalizedKeyword)
        || ownerLabel(project).toLowerCase().includes(normalizedKeyword)
        || (project.description || '').toLowerCase().includes(normalizedKeyword);
      if (!matchesKeyword) return false;
      if (filter === 'active') return project.status === 'active';
      if (filter === 'archived') return project.status === 'archived';
      if (filter === 'empty') return canDelete(project);
      if (filter === 'smoke') return isSmokeProject(project);
      return true;
    });
  }, [filter, keyword, projects]);

  const targetCandidates = useMemo(
    () => projects.filter((project) => project.status !== 'deleted' && !selectedIds.has(project.id)),
    [projects, selectedIds],
  );

  const totalPages = Math.max(1, Math.ceil(filteredProjects.length / ADMIN_PROJECTS_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pagedProjects = filteredProjects.slice(
    (currentPage - 1) * ADMIN_PROJECTS_PAGE_SIZE,
    currentPage * ADMIN_PROJECTS_PAGE_SIZE,
  );

  useEffect(() => {
    setPage(1);
  }, [filter, keyword]);

  const toggleProject = (projectId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
    setMergePreview(null);
    setMergeConfirmed(false);
  };

  const toggleCurrentPage = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      const allSelected = pagedProjects.every((project) => next.has(project.id));
      for (const project of pagedProjects) {
        if (allSelected) next.delete(project.id);
        else next.add(project.id);
      }
      return next;
    });
    setMergePreview(null);
    setMergeConfirmed(false);
  };

  const openMergePanel = () => {
    const preferred = targetCandidates.find((project) => project.name === SMOKE_ARCHIVE_PROJECT_NAME)
      || targetCandidates.find((project) => project.status === 'active' && project.type === 'team')
      || targetCandidates[0];
    setTargetProjectId(preferred?.id || '');
    setMergeOpen(true);
    setMergePreview(null);
    setMergeConfirmed(false);
    setMergeError('');
  };

  const updateProjectStatus = async (project: ProjectItem, action: 'archive' | 'restore') => {
    setMessage('');
    setError('');
    const label = action === 'archive' ? '归档为只读' : '恢复';
    const description = action === 'archive'
      ? '归档后项目仍可查看，但不能继续生成或新增素材。'
      : '恢复后项目可继续生成和新增素材。';
    if (!window.confirm(`确定${label}「${projectDisplayName(project)}」吗？\n${description}`)) return;

    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || `${label}项目失败`);
      setMessage(`项目已${label}`);
      await loadProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label}项目失败`);
    }
  };

  const deleteProject = async (project: ProjectItem) => {
    setMessage('');
    setError('');
    if (!window.confirm(`确定删除空项目「${projectDisplayName(project)}」吗？删除后不会出现在项目列表。`)) return;

    try {
      const res = await fetch(`/api/projects/${project.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || '删除项目失败');
      setMessage('项目已删除');
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(project.id);
        return next;
      });
      await loadProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除项目失败');
    }
  };

  const createArchiveProject = async () => {
    setMergeError('');
    setMergeLoading(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: SMOKE_ARCHIVE_PROJECT_NAME,
          type: 'team',
          description: 'closure smoke reusable project',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || '创建归档项目失败');
      await loadProjects();
      setTargetProjectId(data.project?.id || '');
      setMessage('已创建 Smoke Project Archive');
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : '创建归档项目失败');
    } finally {
      setMergeLoading(false);
    }
  };

  const loadMergePreview = async () => {
    setMergeError('');
    setMergePreview(null);
    setMergeConfirmed(false);
    if (selectedIds.size === 0) {
      setMergeError('请选择要合并的源项目');
      return;
    }
    if (!targetProjectId) {
      setMergeError('请选择目标项目');
      return;
    }
    setMergeLoading(true);
    try {
      const res = await fetch('/api/admin/projects/merge/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_project_ids: Array.from(selectedIds),
          target_project_id: targetProjectId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || '生成合并预览失败');
      setMergePreview(data.preview);
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : '生成合并预览失败');
    } finally {
      setMergeLoading(false);
    }
  };

  const applyMerge = async () => {
    setMergeError('');
    setMessage('');
    if (!mergePreview || mergePreview.blockers.length > 0) {
      setMergeError('请先生成无阻断项的合并预览');
      return;
    }
    if (!mergeConfirmed) {
      setMergeError('请先勾选确认合并');
      return;
    }
    setMergeLoading(true);
    try {
      const res = await fetch('/api/admin/projects/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_project_ids: Array.from(selectedIds),
          target_project_id: targetProjectId,
          reason: mergeReason,
          confirm: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || '项目合并失败');
      setMessage(`已合并 ${data.result?.counts?.projects_archived || selectedIds.size} 个项目`);
      setSelectedIds(new Set());
      setMergeOpen(false);
      setMergePreview(null);
      await loadProjects();
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : '项目合并失败');
    } finally {
      setMergeLoading(false);
    }
  };

  return (
    <div>
      <PageBanner
        eyebrow="管理员后台"
        title="项目管理"
        description="查看全部项目，归档协作项目，删除空项目，或把历史测试项目合并到固定项目。"
      />

      <div className="card admin-projects-shell">
        {message && <p className="text-green">{message}</p>}
        {error && <p className="text-red">{error}</p>}

        <div className="admin-projects-toolbar">
          <input
            className="input"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索项目、ID、负责人、描述"
          />
          <div className="admin-projects-filter-row" aria-label="项目筛选">
            {([
              ['all', '全部'],
              ['active', '活跃'],
              ['archived', '归档'],
              ['empty', '空项目'],
              ['smoke', '疑似测试项目'],
            ] as Array<[ProjectFilter, string]>).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={filter === value ? 'btn btn-primary' : 'btn btn-secondary'}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {selectedIds.size > 0 && (
          <div className="admin-projects-bulkbar">
            <span>已选 {selectedIds.size} 个项目</span>
            <span>疑似测试 {selectedProjects.filter(isSmokeProject).length} 个</span>
            <button className="btn btn-primary" type="button" onClick={openMergePanel}>
              合并到项目
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => setSelectedIds(new Set())}>
              取消选择
            </button>
          </div>
        )}

        {loading ? (
          <p className="text-gray">加载中...</p>
        ) : (
          <table className="table admin-projects-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    checked={pagedProjects.length > 0 && pagedProjects.every((project) => selectedIds.has(project.id))}
                    onChange={toggleCurrentPage}
                    aria-label="选择当前页项目"
                  />
                </th>
                <th>项目</th>
                <th>类型</th>
                <th>负责人</th>
                <th>成员</th>
                <th>内容</th>
                <th>状态</th>
                <th>更新</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {pagedProjects.map((project) => (
                <tr key={project.id} className={selectedIds.has(project.id) ? 'is-selected' : ''}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(project.id)}
                      onChange={() => toggleProject(project.id)}
                      aria-label={`选择 ${projectDisplayName(project)}`}
                    />
                  </td>
                  <td>
                    <div className="admin-projects-title-cell">
                      <span>{projectDisplayName(project)}</span>
                      {isSmokeProject(project) && <small>疑似测试项目</small>}
                    </div>
                  </td>
                  <td>{project.type} / {project.visibility}</td>
                  <td>{ownerLabel(project)}</td>
                  <td>{project._count?.members ?? 0}</td>
                  <td>任务 {project._count?.tasks ?? 0} / 图集 {project._count?.reference_albums ?? 0}</td>
                  <td>{project.status}</td>
                  <td>{formatDate(project.updated_at)}</td>
                  <td>
                    <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <Link className="link" href={`/projects/${project.id}`}>管理</Link>
                      {project.status === 'archived' ? (
                        <button className="btn btn-secondary" type="button" onClick={() => updateProjectStatus(project, 'restore')}>
                          恢复
                        </button>
                      ) : (
                        <button
                          className="btn btn-secondary"
                          type="button"
                          onClick={() => updateProjectStatus(project, 'archive')}
                          disabled={!canArchive(project)}
                        >
                          归档为只读
                        </button>
                      )}
                      <button
                        className="btn btn-danger"
                        type="button"
                        onClick={() => deleteProject(project)}
                        disabled={!canDelete(project)}
                        title={canDelete(project) ? '删除空协作项目' : '仅没有任务和图集的空协作项目可删除'}
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <PaginationControls
          page={currentPage}
          totalPages={totalPages}
          total={filteredProjects.length}
          pageSize={ADMIN_PROJECTS_PAGE_SIZE}
          label="项目"
          onPageChange={setPage}
        />
      </div>

      {mergeOpen && (
        <div className="admin-projects-drawer-shell" role="dialog" aria-modal="true" aria-label="项目合并">
          <button className="admin-projects-drawer-backdrop" type="button" aria-label="关闭" onClick={() => setMergeOpen(false)} />
          <aside className="admin-projects-drawer">
            <header>
              <div>
                <span>项目合并</span>
                <h2>把历史测试项目收进一个项目</h2>
              </div>
              <button className="btn btn-secondary" type="button" onClick={() => setMergeOpen(false)}>关闭</button>
            </header>

            {mergeError && <p className="text-red">{mergeError}</p>}

            <section>
              <h3>源项目</h3>
              <p>已选 {selectedIds.size} 个项目，其中疑似测试项目 {selectedProjects.filter(isSmokeProject).length} 个。</p>
              <div className="admin-projects-selected-list">
                {selectedProjects.slice(0, 8).map((project) => (
                  <span key={project.id}>{projectDisplayName(project)}</span>
                ))}
                {selectedProjects.length > 8 && <span>还有 {selectedProjects.length - 8} 个</span>}
              </div>
            </section>

            <section>
              <h3>目标项目</h3>
              <select className="input" value={targetProjectId} onChange={(event) => {
                setTargetProjectId(event.target.value);
                setMergePreview(null);
                setMergeConfirmed(false);
              }}>
                <option value="">选择目标项目</option>
                {targetCandidates.map((project) => (
                  <option key={project.id} value={project.id}>
                    {projectDisplayName(project)} · {project.status}
                  </option>
                ))}
              </select>
              {!targetCandidates.some((project) => project.name === SMOKE_ARCHIVE_PROJECT_NAME) && (
                <button className="btn btn-secondary" type="button" onClick={createArchiveProject} disabled={mergeLoading}>
                  创建 Smoke Project Archive
                </button>
              )}
            </section>

            <section>
              <h3>合并原因</h3>
              <textarea
                className="input"
                rows={3}
                value={mergeReason}
                onChange={(event) => setMergeReason(event.target.value)}
              />
            </section>

            <div className="admin-projects-drawer-actions">
              <button className="btn btn-secondary" type="button" onClick={loadMergePreview} disabled={mergeLoading}>
                {mergeLoading ? '生成中...' : '生成 dry-run 预览'}
              </button>
            </div>

            {mergePreview && (
              <section className="admin-projects-preview">
                <h3>预览结果</h3>
                <div className="admin-projects-preview-grid">
                  <span>项目 {mergePreview.totals.projects}</span>
                  <span>任务 {mergePreview.totals.tasks}</span>
                  <span>视频卡 {mergePreview.totals.video_cards}</span>
                  <span>画布 {mergePreview.totals.canvases}</span>
                  <span>成本账本 {mergePreview.totals.cost_ledgers}</span>
                  <span>成本分摊 {mergePreview.totals.cost_allocations}</span>
                </div>
                {mergePreview.blockers.length > 0 ? (
                  <div className="admin-projects-blockers">
                    {mergePreview.blockers.map((blocker, index) => <p key={`${blocker}-${index}`}>{blocker}</p>)}
                  </div>
                ) : (
                  <p className="text-green">没有阻断项，可以执行合并。</p>
                )}
                <div className="admin-projects-preview-list">
                  {mergePreview.source_projects.map((item) => (
                    <div key={item.project.id}>
                      <strong>{item.project.name}</strong>
                      <span>{countText(item.counts)}</span>
                      {item.blockers.length > 0 && <em>{item.blockers.join('；')}</em>}
                    </div>
                  ))}
                </div>
                <label className="admin-projects-confirm-row">
                  <input
                    type="checkbox"
                    checked={mergeConfirmed}
                    onChange={(event) => setMergeConfirmed(event.target.checked)}
                    disabled={mergePreview.blockers.length > 0}
                  />
                  <span>确认把以上源项目合并到目标项目，源项目合并后进入归档区。</span>
                </label>
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={applyMerge}
                  disabled={mergeLoading || mergePreview.blockers.length > 0 || !mergeConfirmed}
                >
                  执行合并
                </button>
              </section>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
