'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import PageBanner from '@/components/PageBanner';
import PaginationControls from '@/components/PaginationControls';
import ShareAlbumDialog from '@/components/ShareAlbumDialog';
import UserIdentityBadge from '@/components/UserIdentityBadge';

type Scope = 'mine' | 'project' | 'other_project' | 'shared' | 'public' | 'all';

interface ProjectOption {
  id: string;
  name: string;
  type: string;
  my_role: string | null;
  can_manage_assets?: boolean;
}

interface PublicFolder {
  id: string;
  name: string;
  description: string | null;
  sort_order: number;
  album_count: number;
}

interface AlbumItem {
  id: string;
  name: string;
  description: string | null;
  album_type: string;
  visibility: string;
  public_folder_id?: string | null;
  public_folder?: { id: string; name: string } | null;
  cover_image_id: string | null;
  cover_image_url: string | null;
  image_count: number;
  active_share_count: number;
  updated_at: string;
  owner?: { id?: string; name: string | null; username: string | null; email?: string | null; avatar_url?: string | null; account_type?: string | null };
  project?: { name: string } | null;
  permissions: {
    view: boolean;
    use: boolean;
    copy: boolean;
    edit: boolean;
  };
  can_share?: boolean;
}

interface AuthUser {
  id: string;
  role: string;
}

interface PublicSubmission {
  id: string;
  source_album_id: string;
  public_folder_id: string | null;
  name: string;
  description: string | null;
  submit_note: string | null;
  status: string;
  created_at: string;
  submitted_by?: { id: string; name: string | null; username?: string | null; email?: string | null; avatar_url?: string | null; account_type?: string | null } | null;
  public_folder?: { id: string; name: string } | null;
  source_album?: {
    id: string;
    name: string;
    description: string | null;
    image_count: number;
    cover_image_url: string | null;
  } | null;
}

const TABS: Array<{ value: Scope; label: string }> = [
  { value: 'mine', label: '我的图集' },
  { value: 'project', label: '项目图集' },
  { value: 'other_project', label: '其他人的项目图集' },
  { value: 'shared', label: '共享给我的' },
  { value: 'public', label: '公共图集' },
  { value: 'all', label: '全部图集' },
];

const ALBUMS_PAGE_SIZE = 12;

export default function ReferenceAlbumsClient() {
  const [scope, setScope] = useState<Scope>('mine');
  const [albums, setAlbums] = useState<AlbumItem[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [folders, setFolders] = useState<PublicFolder[]>([]);
  const [pendingSubmissions, setPendingSubmissions] = useState<PublicSubmission[]>([]);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [canManagePublicFolders, setCanManagePublicFolders] = useState(false);
  const [loading, setLoading] = useState(false);
  const [folderLoading, setFolderLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [albumType, setAlbumType] = useState<'personal' | 'project'>('personal');
  const [projectId, setProjectId] = useState('');
  const [projectFilterId, setProjectFilterId] = useState('all');
  const [selectedFolderId, setSelectedFolderId] = useState('all');
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderDescription, setNewFolderDescription] = useState('');
  const [submitAlbum, setSubmitAlbum] = useState<AlbumItem | null>(null);
  const [submitFolderId, setSubmitFolderId] = useState('');
  const [submitName, setSubmitName] = useState('');
  const [submitDescription, setSubmitDescription] = useState('');
  const [submitNote, setSubmitNote] = useState('');
  const [submitPendingSubmission, setSubmitPendingSubmission] = useState<PublicSubmission | null>(null);
  const [shareAlbum, setShareAlbum] = useState<AlbumItem | null>(null);
  const [page, setPage] = useState(1);
  const [actionAlbumId, setActionAlbumId] = useState<string | null>(null);
  const [actionFolderId, setActionFolderId] = useState<string | null>(null);
  const [actionSubmissionId, setActionSubmissionId] = useState<string | null>(null);
  const [failedCoverIds, setFailedCoverIds] = useState<Set<string>>(() => new Set());

  const projectChoices = useMemo(
    () => projects.filter((project) => project.can_manage_assets),
    [projects],
  );
  const isAdmin = currentUser?.role === 'admin';
  const visibleTabs = useMemo(
    () => (isAdmin ? TABS : TABS.filter((tab) => tab.value !== 'other_project')),
    [isAdmin],
  );
  const projectFilterChoices = useMemo(
    () => projects.filter((project) => project.type !== 'system'),
    [projects],
  );
  const totalPages = Math.max(1, Math.ceil(albums.length / ALBUMS_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pagedAlbums = albums.slice(
    (currentPage - 1) * ALBUMS_PAGE_SIZE,
    currentPage * ALBUMS_PAGE_SIZE,
  );

  function projectDisplayName(project: ProjectOption) {
    return project.type === 'personal' ? '个人空间' : project.name;
  }

  function canSubmitAlbumToPublic(album: AlbumItem) {
    return album.permissions.edit && !['public', 'system'].includes(album.album_type);
  }

  function canManageAlbumSharing(album: AlbumItem) {
    return Boolean(album.can_share) && !['public', 'system'].includes(album.album_type);
  }

  const loadFolders = useCallback(() => {
    setFolderLoading(true);
    fetch('/api/reference-album-folders', { cache: 'no-store' })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || data.message || '公共文件夹读取失败');
        const list: PublicFolder[] = data.folders || [];
        setFolders(list);
        setCanManagePublicFolders(Boolean(data.can_manage));
        setSubmitFolderId((current) => current || list[0]?.id || '');
        setSelectedFolderId((current) => (
          current === 'all' || list.some((folder) => folder.id === current) ? current : 'all'
        ));
      })
      .catch((err) => setError(err instanceof Error ? err.message : '公共文件夹读取失败'))
      .finally(() => setFolderLoading(false));
  }, []);

  const loadAlbums = useCallback(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ scope });
    if ((scope === 'project' || scope === 'other_project') && projectFilterId !== 'all') {
      params.set('project_id', projectFilterId);
    }
    if (scope === 'public' && selectedFolderId !== 'all') params.set('public_folder_id', selectedFolderId);
    fetch(`/api/reference-albums?${params.toString()}`, { cache: 'no-store' })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || data.message || '图集读取失败');
        setAlbums(data.albums || []);
        setPage(1);
      })
      .catch((err) => setError(err instanceof Error ? err.message : '图集读取失败'))
      .finally(() => setLoading(false));
  }, [projectFilterId, scope, selectedFolderId]);

  const loadPendingSubmissions = useCallback(() => {
    if (!isAdmin) return;
    fetch('/api/admin/reference-album-submissions?status=pending', { cache: 'no-store' })
      .then((res) => res.ok ? res.json() : null)
      .then((data) => setPendingSubmissions(data?.submissions || []))
      .catch(() => {});
  }, [isAdmin]);

  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((res) => res.ok ? res.json() : null)
      .then((data) => setCurrentUser(data?.user || null))
      .catch(() => {});
    loadFolders();
  }, [loadFolders]);

  useEffect(() => {
    loadAlbums();
  }, [loadAlbums]);

  useEffect(() => {
    loadPendingSubmissions();
  }, [loadPendingSubmissions]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initialScope = params.get('scope') as Scope | null;
    const initialProjectId = params.get('project_id') || '';
    if (initialScope && TABS.some((tab) => tab.value === initialScope)) setScope(initialScope);
    if (initialProjectId) {
      setProjectId(initialProjectId);
      setProjectFilterId(initialProjectId);
    }

    fetch('/api/projects')
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        const list: ProjectOption[] = data?.projects || [];
        setProjects(list);
        setProjectId((current) => current || list.find((project) => project.can_manage_assets)?.id || '');
        setProjectFilterId((current) => (
          current !== 'all' && list.some((project) => project.id === current) ? current : 'all'
        ));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (currentUser && !isAdmin && scope === 'other_project') {
      setScope('project');
    }
  }, [currentUser, isAdmin, scope]);

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

  const handleCreateFolder = async () => {
    const folderName = newFolderName.trim();
    if (!folderName) return;
    setFolderLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/reference-album-folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: folderName, description: newFolderDescription }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || '创建公共文件夹失败');
      setNewFolderName('');
      setNewFolderDescription('');
      setSelectedFolderId(data.folder.id);
      loadFolders();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建公共文件夹失败');
    } finally {
      setFolderLoading(false);
    }
  };

  const handleRenameFolder = async (folder: PublicFolder) => {
    const nextName = window.prompt('输入新的公共文件夹名称', folder.name)?.trim();
    if (!nextName || nextName === folder.name) return;
    setActionFolderId(folder.id);
    setError(null);
    try {
      const res = await fetch(`/api/reference-album-folders/${folder.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nextName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || '重命名公共文件夹失败');
      loadFolders();
    } catch (err) {
      setError(err instanceof Error ? err.message : '重命名公共文件夹失败');
    } finally {
      setActionFolderId(null);
    }
  };

  const handleDeleteFolder = async (folder: PublicFolder) => {
    const confirmed = window.confirm(`删除公共文件夹「${folder.name}」？只有空文件夹可以删除。`);
    if (!confirmed) return;
    setActionFolderId(folder.id);
    setError(null);
    try {
      const res = await fetch(`/api/reference-album-folders/${folder.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.message || '删除公共文件夹失败');
      setSelectedFolderId('all');
      loadFolders();
      loadAlbums();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除公共文件夹失败');
    } finally {
      setActionFolderId(null);
    }
  };

  const handleRenameAlbum = async (album: AlbumItem) => {
    const nextName = window.prompt('输入新的图集名称', album.name)?.trim();
    if (!nextName || nextName === album.name) return;

    setActionAlbumId(album.id);
    setError(null);
    try {
      const res = await fetch(`/api/reference-albums/${album.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nextName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || '重命名失败');
      setAlbums((current) => current.map((item) => (
        item.id === album.id
          ? { ...item, name: data.album?.name || nextName, updated_at: data.album?.updated_at || item.updated_at }
          : item
      )));
    } catch (err) {
      setError(err instanceof Error ? err.message : '重命名失败');
    } finally {
      setActionAlbumId(null);
    }
  };

  const handleDeleteAlbum = async (album: AlbumItem) => {
    const confirmed = window.confirm(`删除图集「${album.name}」？图集会从列表隐藏，历史任务引用的参考图仍会保留。`);
    if (!confirmed) return;

    setActionAlbumId(album.id);
    setError(null);
    try {
      const res = await fetch(`/api/reference-albums/${album.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.message || '删除图集失败');
      setAlbums((current) => current.filter((item) => item.id !== album.id));
      loadFolders();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除图集失败');
    } finally {
      setActionAlbumId(null);
    }
  };

  const openSubmitPanel = async (album: AlbumItem) => {
    setSubmitAlbum(album);
    setError(null);
    setSubmitPendingSubmission(null);
    setSubmitName(album.name);
    setSubmitDescription(album.description || '');
    setSubmitNote('');
    setSubmitFolderId(folders[0]?.id || '');

    try {
      const res = await fetch(`/api/reference-albums/${album.id}/public-submissions`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const pending: PublicSubmission | null = data?.submission || null;
      if (!pending || pending.status !== 'pending') return;
      setSubmitPendingSubmission(pending);
      setSubmitName(pending.name || album.name);
      setSubmitDescription(pending.description || album.description || '');
      setSubmitNote(pending.submit_note || '');
      if (pending.public_folder_id) setSubmitFolderId(pending.public_folder_id);
    } catch {
      // ignore
    }
  };

  const handleSubmitToPublic = async (replace = false) => {
    if (!submitAlbum) return;
    if (!submitFolderId) {
      setError('请先选择公共文件夹');
      return;
    }
    setActionAlbumId(submitAlbum.id);
    setError(null);
    try {
      const res = await fetch(`/api/reference-albums/${submitAlbum.id}/public-submissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          public_folder_id: submitFolderId,
          name: submitName,
          description: submitDescription,
          submit_note: submitNote,
          replace,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || '提交公共图集失败');
      if (data.deduplicated) {
        setSubmitPendingSubmission(data.submission || null);
        setError('该图集已有待审核提交，请先确认覆盖重提，避免重复等待。');
        return;
      }

      setSubmitAlbum(null);
      setSubmitPendingSubmission(null);
      setScope(isAdmin ? 'public' : scope);
      setError(isAdmin
        ? data.replaced ? '已更新并同步到公共图集' : '已复制到公共图集'
        : (replace ? '已覆盖重提，等待管理员审核' : '已提交审核，管理员通过后会进入公共图集'));
      loadAlbums();
      loadFolders();
      loadPendingSubmissions();
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交公共图集失败');
    } finally {
      setActionAlbumId(null);
    }
  };

  const handleReviewSubmission = async (submission: PublicSubmission, action: 'approve' | 'reject') => {
    const reviewNoteInput = action === 'reject'
      ? window.prompt('填写拒绝原因，可留空')
      : '';
    if (reviewNoteInput === null) return;
    const reviewNote = reviewNoteInput.trim();
    setActionSubmissionId(submission.id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/reference-album-submissions/${submission.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, review_note: reviewNote }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || '审核失败');
      loadPendingSubmissions();
      loadAlbums();
      loadFolders();
    } catch (err) {
      setError(err instanceof Error ? err.message : '审核失败');
    } finally {
      setActionSubmissionId(null);
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
        {visibleTabs.map((tab) => (
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

      {(scope === 'project' || scope === 'other_project') && (
        <section className="album-project-filter">
          <div>
            <strong>{scope === 'other_project' ? '其他人的项目图集' : '项目图集'}</strong>
            <span>
              {scope === 'other_project'
                ? '管理员可按项目筛选其他人创建的项目图集。'
                : '默认显示所有可访问项目图集，也可收窄到单个项目。'}
            </span>
          </div>
          <select value={projectFilterId} onChange={(event) => setProjectFilterId(event.target.value)}>
            <option value="all">{scope === 'other_project' ? '全部他人项目' : '全部项目'}</option>
            {projectFilterChoices.map((project) => (
              <option key={project.id} value={project.id}>{projectDisplayName(project)}</option>
            ))}
          </select>
        </section>
      )}

      {scope === 'public' && (
        <section className="album-public-folders">
          <div className="album-public-folder-head">
            <div>
              <h2>公共文件夹</h2>
              <p>公共图集按文件夹组织；删除文件夹前必须先移走或归档里面的图集。</p>
            </div>
            {folderLoading && <span>同步中...</span>}
          </div>
          <div className="album-folder-strip" role="tablist" aria-label="公共图集文件夹">
            <button
              type="button"
              className={selectedFolderId === 'all' ? 'active' : ''}
              onClick={() => setSelectedFolderId('all')}
            >
              全部
              <span>{folders.reduce((sum, folder) => sum + folder.album_count, 0)}</span>
            </button>
            {folders.map((folder) => (
              <div key={folder.id} className={`album-folder-chip ${selectedFolderId === folder.id ? 'active' : ''}`}>
                <button type="button" onClick={() => setSelectedFolderId(folder.id)}>
                  {folder.name}
                  <span>{folder.album_count}</span>
                </button>
                {canManagePublicFolders && (
                  <div className="album-folder-actions">
                    <button type="button" onClick={() => handleRenameFolder(folder)} disabled={actionFolderId === folder.id}>改名</button>
                    <button type="button" onClick={() => handleDeleteFolder(folder)} disabled={actionFolderId === folder.id}>删除</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {canManagePublicFolders && (
            <div className="album-folder-create">
              <input value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} placeholder="新公共文件夹" />
              <input value={newFolderDescription} onChange={(event) => setNewFolderDescription(event.target.value)} placeholder="说明，可选" />
              <button type="button" onClick={handleCreateFolder} disabled={!newFolderName.trim() || folderLoading}>新建文件夹</button>
            </div>
          )}
        </section>
      )}

      {scope === 'public' && isAdmin && pendingSubmissions.length > 0 && (
        <section className="album-review-panel">
          <div className="album-review-head">
            <h2>待审核提交</h2>
            <span>{pendingSubmissions.length} 个</span>
          </div>
          <div className="album-review-list">
            {pendingSubmissions.map((submission) => (
              <article key={submission.id} className="album-review-item">
                <div className="album-review-cover">
                  {submission.source_album?.cover_image_url ? (
                    <img src={submission.source_album.cover_image_url} alt={submission.name} />
                  ) : (
                    <span>{submission.source_album?.image_count || 0} 张</span>
                  )}
                </div>
                <div className="album-review-copy">
                  <strong>{submission.name}</strong>
                  <span className="album-review-submitter">
                    <UserIdentityBadge user={submission.submitted_by} size="sm" />
                    <span>提交到 {submission.public_folder?.name || '未指定文件夹'}</span>
                  </span>
                  {submission.submit_note && <p>{submission.submit_note}</p>}
                </div>
                <div className="album-review-actions">
                  <button
                    type="button"
                    onClick={() => handleReviewSubmission(submission, 'reject')}
                    disabled={actionSubmissionId === submission.id}
                  >
                    拒绝
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => handleReviewSubmission(submission, 'approve')}
                    disabled={actionSubmissionId === submission.id}
                  >
                    通过并复制
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

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

      {submitAlbum && (
        <section className="album-public-submit-panel">
          <div>
            <h2>提交到公共图集</h2>
            <p>系统会复制一份公共版本，原图集仍保持私有或项目权限。</p>
          </div>
          <div className="album-public-submit-form">
            <select value={submitFolderId} onChange={(event) => setSubmitFolderId(event.target.value)}>
              <option value="">选择公共文件夹</option>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>{folder.name}</option>
              ))}
            </select>
            <input value={submitName} onChange={(event) => setSubmitName(event.target.value)} placeholder="公共图集名称" />
            <input value={submitDescription} onChange={(event) => setSubmitDescription(event.target.value)} placeholder="公共说明，可选" />
            <textarea value={submitNote} onChange={(event) => setSubmitNote(event.target.value)} placeholder="给管理员的说明，可选" />
            {submitPendingSubmission && (
              <div className="album-public-submit-pending">
                当前已有待审核提交：{new Date(submitPendingSubmission.created_at).toLocaleString('zh-CN')}，
                提交到 {submitPendingSubmission.public_folder?.name || '原文件夹'}
              </div>
            )}
          </div>
          <div className="album-public-submit-actions">
            <button
              type="button"
              onClick={() => {
                setSubmitAlbum(null);
                setSubmitPendingSubmission(null);
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => handleSubmitToPublic()}
              disabled={!submitFolderId || !submitName.trim() || actionAlbumId === submitAlbum.id}
            >
              {isAdmin ? '直接复制到公共库' : '提交审核'}
            </button>
            {submitPendingSubmission && !isAdmin && (
              <button type="button" onClick={() => handleSubmitToPublic(true)} disabled={!submitFolderId || !submitName.trim() || actionAlbumId === submitAlbum.id}>
                覆盖重提
              </button>
            )}
          </div>
        </section>
      )}

      <ShareAlbumDialog
        open={Boolean(shareAlbum)}
        album={shareAlbum}
        onClose={() => setShareAlbum(null)}
        onChanged={loadAlbums}
      />

      {error && <div className={`album-error ${error.includes('已') ? 'success' : ''}`}>{error}</div>}

      <div className="album-grid">
        {loading && albums.length === 0 ? (
          <div className="album-empty">读取中...</div>
        ) : albums.length === 0 ? (
          <div className="album-empty">暂无图集</div>
        ) : (
          pagedAlbums.map((album) => {
            const coverFailed = failedCoverIds.has(album.id);
            const canSubmitPublic = canSubmitAlbumToPublic(album);
            const canShareAlbum = canManageAlbumSharing(album);
            return (
              <article key={album.id} className="album-card">
                <Link href={`/collections/${album.id}`} className="album-card-main">
                  <div className="album-card-cover">
                    {album.cover_image_url && !coverFailed ? (
                      <img
                        src={album.cover_image_url}
                        alt={`${album.name} 封面`}
                        onError={() => setFailedCoverIds((current) => new Set(current).add(album.id))}
                      />
                    ) : (
                      <span>{album.image_count > 0 ? `${album.image_count} 张` : '空图集'}</span>
                    )}
                  </div>
                  <div className="album-card-body">
                    <div className="album-card-title-row">
                      <UserIdentityBadge user={album.owner} size="sm" />
                      <div className="album-card-title">{album.name}</div>
                    </div>
                    <div className="album-card-meta">
                      <span>
                        {album.public_folder?.name
                          || album.project?.name
                          || (album.album_type === 'public' ? '公共图集' : album.album_type === 'project' ? '项目图集' : '个人图集')}
                      </span>
                    </div>
                    <div className="album-card-perms">
                      {album.permissions.view && <span>可查看</span>}
                      {album.permissions.use && <span>可生成</span>}
                      {album.permissions.copy && <span>可复制</span>}
                      {album.permissions.edit && <span>可编辑</span>}
                      {album.active_share_count > 0 && (
                        <span className="album-card-share-count">已共享 {album.active_share_count}</span>
                      )}
                    </div>
                    <div className="album-card-footer">
                      <span>{album.visibility}</span>
                      <span>{new Date(album.updated_at).toLocaleDateString('zh-CN')}</span>
                    </div>
                  </div>
                </Link>
                <div className="album-card-actions" aria-label={`${album.name} 管理动作`}>
                  {canShareAlbum && (
                    <button type="button" onClick={() => setShareAlbum(album)} disabled={actionAlbumId === album.id}>
                      {album.active_share_count > 0 ? '共享设置' : '转为共享'}
                    </button>
                  )}
                  {canSubmitPublic && (
                    <button type="button" onClick={() => openSubmitPanel(album)} disabled={actionAlbumId === album.id || folders.length === 0}>
                      提交公共
                    </button>
                  )}
                  {album.permissions.edit && (
                    <>
                      <button type="button" onClick={() => handleRenameAlbum(album)} disabled={actionAlbumId === album.id}>
                        重命名
                      </button>
                      <button type="button" className="danger" onClick={() => handleDeleteAlbum(album)} disabled={actionAlbumId === album.id}>
                        删除
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })
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
