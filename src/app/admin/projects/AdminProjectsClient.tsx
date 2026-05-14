'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface ProjectItem {
  id: string;
  name: string;
  type: string;
  visibility: string;
  status: string;
  owner?: { name: string | null; username: string | null };
  _count?: { members: number; tasks: number; reference_albums?: number };
  updated_at: string;
}

function ownerLabel(project: ProjectItem): string {
  const name = project.owner?.name?.trim();
  const username = project.owner?.username?.trim();
  if (name && username && name !== username) return `${name}（${username}）`;
  return name || username || '-';
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

export default function AdminProjectsClient() {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

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
      await loadProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除项目失败');
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">项目管理</h1>
        <p className="page-description">管理员可查看全部项目，归档协作项目，或删除没有内容的空协作项目。</p>
      </div>

      <div className="card">
        {message && <p className="text-green">{message}</p>}
        {error && <p className="text-red">{error}</p>}
        {loading ? (
          <p className="text-gray">加载中...</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
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
              {projects.map((project) => (
                <tr key={project.id}>
                  <td>{projectDisplayName(project)}</td>
                  <td>{project.type} / {project.visibility}</td>
                  <td>{ownerLabel(project)}</td>
                  <td>{project._count?.members ?? 0}</td>
                  <td>任务 {project._count?.tasks ?? 0} / 图集 {project._count?.reference_albums ?? 0}</td>
                  <td>{project.status}</td>
                  <td>{new Date(project.updated_at).toLocaleString('zh-CN')}</td>
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
      </div>
    </div>
  );
}
