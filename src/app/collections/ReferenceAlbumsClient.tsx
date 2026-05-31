'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import PageBanner from '@/components/PageBanner';
import PaginationControls from '@/components/PaginationControls';

type Scope = 'mine' | 'project' | 'shared' | 'public' | 'all';

interface ProjectOption {
  id: string;
  name: string;
  type: string;
  my_role: string | null;
  can_manage_assets?: boolean;
}

interface AlbumItem {
  id: string;
  name: string;
  description: string | null;
  album_type: string;
  visibility: string;
  image_count: number;
  updated_at: string;
  owner?: { name: string; username: string };
  project?: { name: string } | null;
  permissions: {
    view: boolean;
    use: boolean;
    copy: boolean;
    edit: boolean;
  };
}

const TABS: Array<{ value: Scope; label: string }> = [
  { value: 'mine', label: '我的图集' },
  { value: 'project', label: '项目图集' },
  { value: 'shared', label: '共享给我的' },
  { value: 'public', label: '公共图集' },
  { value: 'all', label: '全部图集' },
];

const ALBUMS_PAGE_SIZE = 12;

export default function ReferenceAlbumsClient() {
  const [scope, setScope] = useState<Scope>('mine');
  const [albums, setAlbums] = useState<AlbumItem[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [albumType, setAlbumType] = useState<'personal' | 'project'>('personal');
  const [projectId, setProjectId] = useState('');
  const [page, setPage] = useState(1);

  const projectChoices = useMemo(
    () => projects.filter((project) => project.can_manage_assets),
    [projects],
  );

  function projectDisplayName(project: ProjectOption) {
    return project.type === 'personal' ? '个人空间' : project.name;
  }

  const totalPages = Math.max(1, Math.ceil(albums.length / ALBUMS_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pagedAlbums = albums.slice(
    (currentPage - 1) * ALBUMS_PAGE_SIZE,
    currentPage * ALBUMS_PAGE_SIZE,
  );

  const loadAlbums = () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ scope });
    if (scope === 'project' && projectId) params.set('project_id', projectId);
    fetch(`/api/reference-albums?${params.toString()}`)
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || data.message || '图集读取失败');
        setAlbums(data.albums || []);
        setPage(1);
      })
      .catch((err) => setError(err instanceof Error ? err.message : '图集读取失败'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadAlbums();
  }, [scope, projectId]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initialScope = params.get('scope') as Scope | null;
    const initialProjectId = params.get('project_id') || '';
    if (initialScope && TABS.some((tab) => tab.value === initialScope)) setScope(initialScope);
    if (initialProjectId) setProjectId(initialProjectId);

    fetch('/api/projects')
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        const list: ProjectOption[] = data?.projects || [];
        setProjects(list);
        setProjectId((current) => current || list.find((project) => project.can_manage_assets)?.id || '');
      })
      .catch(() => {});
  }, []);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/reference-albums', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description,
          album_type: albumType,
          project_id: albumType === 'project' ? projectId : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || '创建图集失败');
      setName('');
      setDescription('');
      setScope(albumType === 'project' ? 'project' : 'mine');
      loadAlbums();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建图集失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <PageBanner
        eyebrow="参考资产"
        title="参考图集"
        description="管理可被生成流程调用的参考资产库，支持个人、项目、共享与公共图集。"
      />

      <div className="album-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            className={scope === tab.value ? 'active' : ''}
            onClick={() => {
              setScope(tab.value);
              setPage(1);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="album-create-card">
        <div>
          <h2>新建图集</h2>
          <p>个人图集默认私有；项目图集默认项目成员可见。</p>
        </div>
        <div className="album-create-controls">
          <select value={albumType} onChange={(event) => setAlbumType(event.target.value as 'personal' | 'project')}>
            <option value="personal">个人图集</option>
            <option value="project">项目图集</option>
          </select>
          {albumType === 'project' && (
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              {projectChoices.map((project) => (
                <option key={project.id} value={project.id}>{projectDisplayName(project)}</option>
              ))}
            </select>
          )}
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="图集名称" />
          <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="说明，可选" />
          <button type="button" onClick={handleCreate} disabled={loading || !name.trim() || (albumType === 'project' && !projectId)}>
            创建
          </button>
        </div>
      </div>

      {error && <div className="album-error">{error}</div>}

      <div className="album-grid">
        {loading && albums.length === 0 ? (
          <div className="album-empty">读取中...</div>
        ) : albums.length === 0 ? (
          <div className="album-empty">暂无图集</div>
        ) : (
          pagedAlbums.map((album) => (
            <Link key={album.id} href={`/collections/${album.id}`} className="album-card">
              <div className="album-card-cover">
                {album.image_count > 0 ? `${album.image_count} 张` : '空图集'}
              </div>
              <div className="album-card-body">
                <div className="album-card-title">{album.name}</div>
                <div className="album-card-meta">
                  <span>{album.project?.name || (album.album_type === 'project' ? '项目图集' : '个人图集')}</span>
                  <span>{album.owner?.name || album.owner?.username || '-'}</span>
                </div>
                <div className="album-card-perms">
                  {album.permissions.view && <span>可查看</span>}
                  {album.permissions.use && <span>可生成</span>}
                  {album.permissions.copy && <span>可复制</span>}
                  {album.permissions.edit && <span>可编辑</span>}
                </div>
                <div className="album-card-footer">
                  <span>{album.visibility}</span>
                  <span>{new Date(album.updated_at).toLocaleDateString('zh-CN')}</span>
                </div>
              </div>
            </Link>
          ))
        )}
      </div>
      <PaginationControls
        page={currentPage}
        totalPages={totalPages}
        total={albums.length}
        pageSize={ALBUMS_PAGE_SIZE}
        label="图集"
        onPageChange={setPage}
      />
    </div>
  );
}
