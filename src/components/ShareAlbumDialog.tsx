'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

type PermissionKey = 'view' | 'use' | 'copy' | 'download' | 'viewSource' | 'edit';
type PermissionPreset = 'view' | 'generate' | 'edit' | 'custom';
type AlbumShareTargetType = 'user' | 'project';
type ShareTargetType = AlbumShareTargetType | 'public_folder';

type SharePermissions = Record<PermissionKey, boolean>;

export interface ShareAlbumDialogAlbum {
  id: string;
  name: string;
  description?: string | null;
  album_type: string;
  visibility: string;
  active_share_count?: number;
}

interface ShareGrantee {
  id: string;
  type: string;
  label: string;
  subtitle?: string | null;
  status?: string | null;
  account_type?: string | null;
}

interface ShareItem {
  id: string;
  grantee_type: AlbumShareTargetType;
  grantee_id: string;
  permissions?: Partial<SharePermissions> | null;
  expires_at?: string | null;
  created_at: string;
  grantee?: ShareGrantee | null;
}

interface ProjectOption {
  id: string;
  name: string;
  type?: string | null;
  status?: string | null;
  my_role?: string | null;
  can_manage_assets?: boolean;
}

interface PublicFolderOption {
  id: string;
  name: string;
  description?: string | null;
  album_count?: number;
}

interface ShareAlbumDialogProps {
  open: boolean;
  album: ShareAlbumDialogAlbum | null;
  onClose: () => void;
  onChanged?: () => void;
}

const PERMISSION_LABELS: Array<{ key: PermissionKey; label: string; description: string }> = [
  { key: 'view', label: '查看图集', description: '可以打开图集和查看缩略图' },
  { key: 'use', label: '用于生成', description: '可以把图片加入生成工作台' },
  { key: 'copy', label: '复制到自己的图集', description: '可以复用图片继续整理' },
  { key: 'download', label: '下载原图', description: '可以下载原始图片文件' },
  { key: 'viewSource', label: '查看来源', description: '可以看到来源任务和元数据' },
  { key: 'edit', label: '协作编辑', description: '可以上传、删除和管理图集内容' },
];

const PRESETS: Array<{ value: PermissionPreset; label: string; description: string }> = [
  { value: 'view', label: '只查看', description: '只给浏览权限' },
  { value: 'generate', label: '可生成', description: '允许生成和复制' },
  { value: 'edit', label: '协作编辑', description: '允许维护图集内容' },
];

export default function ShareAlbumDialog({ open, album, onClose, onChanged }: ShareAlbumDialogProps) {
  const [shares, setShares] = useState<ShareItem[]>([]);
  const [targetType, setTargetType] = useState<ShareTargetType>('project');
  const [targetId, setTargetId] = useState('');
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [publicFolders, setPublicFolders] = useState<PublicFolderOption[]>([]);
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null);
  const [folderLoadError, setFolderLoadError] = useState<string | null>(null);
  const [publicFolderId, setPublicFolderId] = useState('');
  const [publicName, setPublicName] = useState('');
  const [publicDescription, setPublicDescription] = useState('');
  const [submitNote, setSubmitNote] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [preset, setPreset] = useState<PermissionPreset>('generate');
  const [draftPermissions, setDraftPermissions] = useState<SharePermissions>(() => permissionsForPreset('generate'));
  const [loading, setLoading] = useState(false);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const shareCount = shares.length;
  const permissionSummary = useMemo(() => formatPermissions(draftPermissions), [draftPermissions]);
  const shareableProjects = useMemo(
    () => projects.filter((project) => project.status !== 'deleted' && project.type !== 'system'),
    [projects],
  );
  const defaultProjectId = useMemo(() => {
    const teamProject = shareableProjects.find((project) => project.type !== 'personal');
    return teamProject?.id || shareableProjects[0]?.id || '';
  }, [shareableProjects]);

  const loadShares = useCallback(async () => {
    if (!album) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/reference-albums/${album.id}/shares`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.message || '共享列表读取失败');
      setShares(data.shares || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : '共享列表读取失败');
    } finally {
      setLoading(false);
    }
  }, [album]);

  const loadShareTargets = useCallback(async () => {
    setOptionsLoading(true);
    setProjectLoadError(null);
    setFolderLoadError(null);
    try {
      const [projectsResult, foldersResult] = await Promise.allSettled([
        fetchJson<{ projects?: ProjectOption[] }>('/api/projects', '项目列表读取失败'),
        fetchJson<{ folders?: PublicFolderOption[] }>('/api/reference-album-folders', '共享文件夹读取失败'),
      ]);

      if (projectsResult.status === 'fulfilled') {
        setProjects(Array.isArray(projectsResult.value.projects) ? projectsResult.value.projects : []);
      } else {
        setProjects([]);
        setProjectLoadError(projectsResult.reason instanceof Error ? projectsResult.reason.message : '项目列表读取失败');
      }

      if (foldersResult.status === 'fulfilled') {
        setPublicFolders(Array.isArray(foldersResult.value.folders) ? foldersResult.value.folders : []);
      } else {
        setPublicFolders([]);
        setFolderLoadError(foldersResult.reason instanceof Error ? foldersResult.reason.message : '共享文件夹读取失败');
      }
    } catch (err) {
      setProjectLoadError(err instanceof Error ? err.message : '共享目标读取失败');
      setFolderLoadError(err instanceof Error ? err.message : '共享目标读取失败');
    } finally {
      setOptionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || !album) return;
    setTargetType('project');
    setTargetId('');
    setPublicFolderId('');
    setPublicName(album.name);
    setPublicDescription(album.description || '');
    setSubmitNote('');
    setExpiresAt('');
    setPreset('generate');
    setDraftPermissions(permissionsForPreset('generate'));
    setNotice(null);
    loadShares();
    loadShareTargets();
  }, [album, loadShareTargets, loadShares, open]);

  useEffect(() => {
    if (!open) return;
    if (targetType === 'project' && !targetId && defaultProjectId) {
      setTargetId(defaultProjectId);
    }
    if (targetType === 'public_folder' && !publicFolderId && publicFolders[0]?.id) {
      setPublicFolderId(publicFolders[0].id);
    }
  }, [defaultProjectId, open, publicFolderId, publicFolders, targetId, targetType]);

  if (!open || !album) return null;

  const canSubmit = targetType === 'public_folder'
    ? Boolean(publicFolderId && publicName.trim() && publicFolders.length > 0 && !folderLoadError)
    : targetType === 'project'
      ? Boolean(targetId.trim() && shareableProjects.length > 0 && !projectLoadError)
      : Boolean(targetId.trim());

  const applyPreset = (nextPreset: PermissionPreset) => {
    setPreset(nextPreset);
    setDraftPermissions(permissionsForPreset(nextPreset));
  };

  const updateDraftPermission = (key: PermissionKey, checked: boolean) => {
    setPreset('custom');
    setDraftPermissions((current) => ({ ...current, [key]: checked }));
  };

  const changeTargetType = (nextType: ShareTargetType) => {
    if (nextType === 'public_folder' && publicFolders.length === 0) {
      setNotice(null);
      setError(folderLoadError || '还没有可用共享文件夹，请先让管理员创建共享文件夹。');
      return;
    }
    setTargetType(nextType);
    setError(null);
    setNotice(null);
    if (nextType === 'project') {
      setTargetId(defaultProjectId);
    } else if (nextType === 'user') {
      setTargetId('');
    } else {
      setPublicFolderId(publicFolders[0]?.id || '');
    }
  };

  const createShare = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (targetType === 'public_folder') {
      if (!publicFolderId) {
        setError('请选择共享文件夹');
        return;
      }
      if (!publicName.trim()) {
        setError('请输入公共图集名称');
        return;
      }

      setSavingKey('create');
      setError(null);
      setNotice(null);
      try {
        const res = await fetch(`/api/reference-albums/${album.id}/public-submissions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            public_folder_id: publicFolderId,
            name: publicName.trim(),
            description: publicDescription.trim() || null,
            submit_note: submitNote.trim() || null,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || data.message || '提交到共享文件夹失败');
        if (data.public_album) {
          setNotice('已复制到共享文件夹，公共库可以直接查看。');
        } else if (data.deduplicated) {
          setNotice('已有待审核的共享文件夹提交，管理员审核后会进入公共库。');
        } else {
          setNotice('已提交到共享文件夹，等待管理员审核。');
        }
        onChanged?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : '提交到共享文件夹失败');
      } finally {
        setSavingKey(null);
      }
      return;
    }

    const granteeId = targetId.trim();
    if (!granteeId) {
      setError(targetType === 'user' ? '请输入用户 ID' : '请输入项目 ID');
      return;
    }

    setSavingKey('create');
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/reference-albums/${album.id}/shares`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grantee_type: targetType,
          grantee_id: granteeId,
          permissions: draftPermissions,
          expires_at: expiresAt || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.message || '共享失败');
      setTargetId('');
      setExpiresAt('');
      setNotice('共享对象已添加。');
      await loadShares();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : '共享失败');
    } finally {
      setSavingKey(null);
    }
  };

  const updateSharePermissions = async (share: ShareItem, nextPreset: PermissionPreset) => {
    const permissions = permissionsForPreset(nextPreset);
    setSavingKey(`share-${share.id}`);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/album-shares/${share.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissions }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.message || '权限更新失败');
      await loadShares();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : '权限更新失败');
    } finally {
      setSavingKey(null);
    }
  };

  const revokeShare = async (share: ShareItem) => {
    const label = share.grantee?.label || share.grantee_id;
    if (!window.confirm(`取消共享给「${label}」？对方将不能继续访问这个图集。`)) return;

    setSavingKey(`share-${share.id}`);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/album-shares/${share.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.message || '取消共享失败');
      await loadShares();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : '取消共享失败');
    } finally {
      setSavingKey(null);
    }
  };

  const revokeAllShares = async () => {
    if (shares.length === 0) return;
    if (!window.confirm(`关闭「${album.name}」的全部共享？所有被授权对象都会失去访问权限。`)) return;

    setSavingKey('revoke-all');
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/reference-albums/${album.id}/shares/revoke-all`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.message || '关闭全部共享失败');
      await loadShares();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : '关闭全部共享失败');
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <div
      className="share-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="share-dialog" role="dialog" aria-modal="true" aria-label={`共享 ${album.name}`}>
        <div className="share-dialog-head">
          <div>
            <span>共享图集</span>
            <h2>{album.name}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭共享设置">关闭</button>
        </div>

        <div className="share-dialog-status">
          <span>{album.album_type === 'project' ? '项目图集' : '个人图集'}</span>
          <span>当前范围：{album.visibility}</span>
          <strong>{shareCount} 个共享对象</strong>
        </div>

        <form className="share-dialog-form" onSubmit={createShare}>
          <div className={`share-dialog-target ${targetType === 'public_folder' ? 'public-folder-mode' : ''}`}>
            <label>
              共享方式
              <select value={targetType} onChange={(event) => changeTargetType(event.target.value as ShareTargetType)}>
                <option value="project">共享给项目</option>
                <option value="public_folder" disabled={publicFolders.length === 0}>
                  提交到共享文件夹{publicFolders.length === 0 ? '（暂无文件夹）' : ''}
                </option>
                <option value="user">指定用户</option>
              </select>
            </label>
            {targetType === 'project' && (
              <label>
                选择项目
                <select
                  value={targetId}
                  onChange={(event) => setTargetId(event.target.value)}
                  disabled={optionsLoading || shareableProjects.length === 0}
                >
                  {shareableProjects.length === 0 ? (
                    <option value="">{optionsLoading ? '正在读取项目...' : '暂无可选项目'}</option>
                  ) : (
                    shareableProjects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name} · {formatProjectType(project.type)} · {formatProjectRole(project.my_role)}
                      </option>
                    ))
                  )}
                </select>
              </label>
            )}
            {targetType === 'user' && (
              <label>
                用户 ID
                <input
                  value={targetId}
                  onChange={(event) => setTargetId(event.target.value)}
                  placeholder="粘贴用户 ID"
                />
              </label>
            )}
            {targetType === 'public_folder' && (
              <label>
                共享文件夹
                <select
                  value={publicFolderId}
                  onChange={(event) => setPublicFolderId(event.target.value)}
                  disabled={optionsLoading || publicFolders.length === 0}
                >
                  {publicFolders.length === 0 ? (
                    <option value="">{optionsLoading ? '正在读取共享文件夹...' : '暂无共享文件夹'}</option>
                  ) : (
                    publicFolders.map((folder) => (
                      <option key={folder.id} value={folder.id}>
                        {folder.name}{typeof folder.album_count === 'number' ? ` · ${folder.album_count} 个图集` : ''}
                      </option>
                    ))
                  )}
                </select>
              </label>
            )}
            {targetType === 'public_folder' ? (
              <label>
                公共图集名称
                <input
                  value={publicName}
                  onChange={(event) => setPublicName(event.target.value)}
                  maxLength={80}
                  placeholder={album.name}
                />
              </label>
            ) : (
              <label>
                过期时间
                <input
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(event) => setExpiresAt(event.target.value)}
                />
              </label>
            )}
          </div>

          {targetType === 'project' && projectLoadError && (
            <div className="share-dialog-inline-warning">{projectLoadError}</div>
          )}
          {targetType === 'project' && !projectLoadError && shareableProjects.length === 0 && !optionsLoading && (
            <div className="share-dialog-inline-warning">暂无可共享项目，请先创建或加入一个可管理素材的项目。</div>
          )}
          {folderLoadError && targetType !== 'public_folder' && (
            <div className="share-dialog-inline-note">共享文件夹暂不可用，不影响共享给项目或指定用户。</div>
          )}
          {targetType === 'public_folder' && folderLoadError && (
            <div className="share-dialog-inline-warning">{folderLoadError}</div>
          )}
          {targetType === 'public_folder' && !folderLoadError && publicFolders.length === 0 && !optionsLoading && (
            <div className="share-dialog-inline-warning">还没有可用共享文件夹，请先让管理员创建共享文件夹。</div>
          )}

          {targetType === 'public_folder' ? (
            <div className="share-dialog-public-fields">
              <label>
                公共说明
                <textarea
                  value={publicDescription}
                  onChange={(event) => setPublicDescription(event.target.value)}
                  placeholder="给公共库浏览者看的说明"
                  rows={3}
                />
              </label>
              <label>
                提交备注
                <textarea
                  value={submitNote}
                  onChange={(event) => setSubmitNote(event.target.value)}
                  placeholder="给管理员审核看的备注，可不填"
                  rows={2}
                />
              </label>
              <p>
                提交到共享文件夹会生成一份公共图集副本；普通用户需要管理员审核，管理员会直接复制到公共库。
              </p>
            </div>
          ) : (
            <>
              <div className="share-dialog-presets" role="group" aria-label="共享权限预设">
                {PRESETS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    className={preset === item.value ? 'active' : ''}
                    onClick={() => applyPreset(item.value)}
                  >
                    <strong>{item.label}</strong>
                    <span>{item.description}</span>
                  </button>
                ))}
              </div>

              <div className="share-dialog-permissions">
                {PERMISSION_LABELS.map((item) => (
                  <label key={item.key}>
                    <input
                      type="checkbox"
                      checked={draftPermissions[item.key]}
                      onChange={(event) => updateDraftPermission(item.key, event.target.checked)}
                    />
                    <span>
                      <strong>{item.label}</strong>
                      <em>{item.description}</em>
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}

          <div className="share-dialog-submit">
            <span>
              {targetType === 'public_folder'
                ? '公共库共享需要选择共享文件夹'
                : permissionSummary}
            </span>
            <button type="submit" disabled={savingKey === 'create' || !canSubmit}>
              {savingKey === 'create'
                ? (targetType === 'public_folder' ? '提交中...' : '共享中...')
                : (targetType === 'public_folder' ? '提交到共享文件夹' : '添加共享')}
            </button>
          </div>
        </form>

        {notice && <div className="share-dialog-notice">{notice}</div>}
        {error && <div className="share-dialog-error">{error}</div>}

        <div className="share-dialog-list-head">
          <h3>已共享对象</h3>
          {shareCount > 0 && (
            <button type="button" onClick={revokeAllShares} disabled={savingKey === 'revoke-all'}>
              {savingKey === 'revoke-all' ? '关闭中...' : '关闭全部共享'}
            </button>
          )}
        </div>

        <div className="share-dialog-list">
          {loading ? (
            <div className="share-dialog-empty">读取共享对象...</div>
          ) : shares.length === 0 ? (
            <div className="share-dialog-empty">暂无共享对象。添加第一个对象后，私有图集会自动转为共享图集。</div>
          ) : (
            shares.map((share) => {
              const currentPermissions = normalizePermissions(share.permissions);
              const sharePreset = presetFromPermissions(currentPermissions);
              const saving = savingKey === `share-${share.id}`;
              return (
                <article key={share.id} className="share-dialog-item">
                  <div className="share-dialog-grantee">
                    <strong>{share.grantee?.label || share.grantee_id}</strong>
                    <span>
                      {share.grantee_type === 'project' ? '项目' : '用户'} · {share.grantee?.subtitle || share.grantee_id}
                    </span>
                  </div>
                  <div className="share-dialog-item-perms">
                    <span>
                      {formatPermissions(currentPermissions)}
                      {share.expires_at ? ` · ${formatExpiresAt(share.expires_at)}` : ''}
                    </span>
                    <select
                      value={sharePreset}
                      onChange={(event) => updateSharePermissions(share, event.target.value as PermissionPreset)}
                      disabled={saving}
                    >
                      {sharePreset === 'custom' && <option value="custom">自定义权限</option>}
                      {PRESETS.map((item) => (
                        <option key={item.value} value={item.value}>{item.label}</option>
                      ))}
                    </select>
                  </div>
                  <button type="button" onClick={() => revokeShare(share)} disabled={saving}>
                    {saving ? '处理中...' : '移除'}
                  </button>
                </article>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}

function permissionsForPreset(preset: PermissionPreset): SharePermissions {
  if (preset === 'view') {
    return { view: true, use: false, copy: false, download: false, viewSource: false, edit: false };
  }
  if (preset === 'edit') {
    return { view: true, use: true, copy: true, download: false, viewSource: false, edit: true };
  }
  return { view: true, use: true, copy: true, download: false, viewSource: false, edit: false };
}

function normalizePermissions(input?: Partial<SharePermissions> | null): SharePermissions {
  return {
    view: input?.view ?? true,
    use: input?.use ?? true,
    copy: input?.copy ?? true,
    download: Boolean(input?.download),
    viewSource: Boolean(input?.viewSource),
    edit: Boolean(input?.edit),
  };
}

function presetFromPermissions(permissions: SharePermissions): PermissionPreset {
  const view = permissionsForPreset('view');
  const generate = permissionsForPreset('generate');
  const edit = permissionsForPreset('edit');
  if (samePermissions(permissions, view)) return 'view';
  if (samePermissions(permissions, generate)) return 'generate';
  if (samePermissions(permissions, edit)) return 'edit';
  return 'custom';
}

function samePermissions(a: SharePermissions, b: SharePermissions) {
  return PERMISSION_LABELS.every((item) => a[item.key] === b[item.key]);
}

function formatPermissions(permissions: SharePermissions) {
  const labels = PERMISSION_LABELS
    .filter((item) => permissions[item.key])
    .map((item) => item.label);
  return labels.length > 0 ? labels.join(' / ') : '无权限';
}

function formatExpiresAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '过期时间未知';
  return `${date.toLocaleString('zh-CN')} 过期`;
}

async function fetchJson<T>(url: string, fallbackMessage: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data.error === 'string'
      ? data.error
      : typeof data.message === 'string'
        ? data.message
        : fallbackMessage;
    throw new Error(message);
  }
  return data as T;
}

function formatProjectType(type?: string | null) {
  if (type === 'company') return '公司级项目';
  if (type === 'team') return '团队项目';
  if (type === 'public') return '公共项目';
  if (type === 'personal') return '个人项目';
  return '项目';
}

function formatProjectRole(role?: string | null) {
  if (role === 'admin') return '管理员';
  if (role === 'project_owner') return '负责人';
  if (role === 'editor') return '可编辑';
  if (role === 'viewer') return '可查看';
  return '成员';
}
