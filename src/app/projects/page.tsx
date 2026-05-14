'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

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
  owner?: { name: string | null; username: string | null };
  _count?: { members: number; tasks: number; reference_albums?: number };
}

function canManageProject(project: ProjectItem): boolean {
  return project.my_role === 'admin' || project.my_role === 'project_owner';
}

function projectOwnerName(project: ProjectItem): string {
  const name = project.owner?.name?.trim();
  const username = project.owner?.username?.trim();
  if (name && username && name !== username) return `${name}（${username}）`;
  return name || username || project.owner_user_id;
}

function projectDisplayName(project: ProjectItem): string {
  if (project.type === 'personal') return '个人空间';
  return project.name;
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

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'active' | 'archived'>('active');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

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

  const createProject = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || data.message || '创建项目失败');
      return;
    }
    setName('');
    setDescription('');
    setMessage('项目已创建');
    await loadProjects();
  };

  const updateProjectStatus = async (project: ProjectItem, action: 'archive' | 'restore') => {
    setError('');
    setMessage('');
    const label = action === 'archive' ? '归档为只读' : '恢复';
    const description = action === 'archive'
      ? '归档后项目仍可查看，但不能继续生成或新增素材。'
      : '恢复后项目可继续生成和新增素材。';
    if (!window.confirm(`确定${label}「${projectDisplayName(project)}」吗？\n${description}`)) return;

    const res = await fetch(`/api/projects/${project.id}`, {
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
    await loadProjects();
  };

  const nameCounts = projects.reduce<Record<string, number>>((counts, project) => {
    const name = projectDisplayName(project);
    counts[name] = (counts[name] || 0) + 1;
    return counts;
  }, {});
  const visibleProjects = projects.filter((project) => activeTab === 'active' ? project.status === 'active' : project.status === 'archived');
  const activeCount = projects.filter((project) => project.status === 'active').length;
  const archivedCount = projects.filter((project) => project.status === 'archived').length;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">我的项目</h1>
        <p className="page-description">项目是生成内容的归属空间；只有项目成员才能查看项目内任务和结果。</p>
      </div>

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
          <button className="btn btn-primary" type="submit" disabled={!name.trim()}>
            创建项目
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
              onClick={() => setActiveTab('active')}
            >
              进行中 {activeCount}
            </button>
            <button
              className={`btn ${activeTab === 'archived' ? 'btn-primary' : 'btn-secondary'}`}
              type="button"
              onClick={() => setActiveTab('archived')}
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
          <div className="shell-link-grid">
            {visibleProjects.map((project) => {
              const displayName = projectDisplayName(project);
              return (
              <div key={project.id} className="shell-link-card">
                <Link href={`/projects/${project.id}`} className="link">
                  <strong>
                    {nameCounts[displayName] > 1 ? `${displayName} · ${projectOwnerName(project)}` : displayName}
                  </strong>
                </Link>
                <span>{project.description || `${project.type} · ${project.visibility}`}</span>
                <span>
                  状态：{projectStatusLabel(project.status)}
                  {' · '}负责人：{projectOwnerName(project)}
                </span>
                <span>
                  我的权限：{projectRoleLabel(project.my_role)}
                  {' · '}成员 {project._count?.members ?? 0}
                  {' · '}任务 {project._count?.tasks ?? 0}
                  {' · '}图集 {project._count?.reference_albums ?? 0}
                </span>
                <span>更新 {new Date(project.updated_at).toLocaleDateString('zh-CN')}</span>
                {canManageProject(project) && (
                  <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                    <Link className="btn btn-secondary" href={`/projects/${project.id}`}>
                      管理
                    </Link>
                    {project.status === 'archived' ? (
                      <button className="btn btn-secondary" type="button" onClick={() => updateProjectStatus(project, 'restore')}>
                        恢复
                      </button>
                    ) : (
                      <button
                        className="btn btn-secondary"
                        type="button"
                        onClick={() => updateProjectStatus(project, 'archive')}
                        disabled={project.type !== 'team'}
                      >
                        归档为只读
                      </button>
                    )}
                  </div>
                )}
              </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
