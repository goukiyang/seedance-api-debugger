'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

type PermissionKey = 'view' | 'use' | 'copy' | 'download' | 'viewSource' | 'edit';
type PermissionPreset = 'view' | 'generate' | 'edit' | 'custom';
type ShareTargetType = 'user' | 'project';

type SharePermissions = Record<PermissionKey, boolean>;

export interface ShareAlbumDialogAlbum {
  id: string;
  name: string;
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
  grantee_type: ShareTargetType;
  grantee_id: string;
  permissions?: Partial<SharePermissions> | null;
  expires_at?: string | null;
  created_at: string;
  grantee?: ShareGrantee | null;
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
  const [targetType, setTargetType] = useState<ShareTargetType>('user');
  const [targetId, setTargetId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [preset, setPreset] = useState<PermissionPreset>('generate');
  const [draftPermissions, setDraftPermissions] = useState<SharePermissions>(() => permissionsForPreset('generate'));
  const [loading, setLoading] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shareCount = shares.length;
  const permissionSummary = useMemo(() => formatPermissions(draftPermissions), [draftPermissions]);

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

  useEffect(() => {
    if (!open || !album) return;
    setTargetType('user');
    setTargetId('');
    setExpiresAt('');
    setPreset('generate');
    setDraftPermissions(permissionsForPreset('generate'));
    loadShares();
  }, [album, loadShares, open]);

  if (!open || !album) return null;

  const applyPreset = (nextPreset: PermissionPreset) => {
    setPreset(nextPreset);
    setDraftPermissions(permissionsForPreset(nextPreset));
  };

  const updateDraftPermission = (key: PermissionKey, checked: boolean) => {
    setPreset('custom');
    setDraftPermissions((current) => ({ ...current, [key]: checked }));
  };

  const createShare = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const granteeId = targetId.trim();
    if (!granteeId) {
      setError(targetType === 'user' ? '请输入用户 ID' : '请输入项目 ID');
      return;
    }

    setSavingKey('create');
    setError(null);
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
          <div className="share-dialog-target">
            <label>
              共享给
              <select value={targetType} onChange={(event) => setTargetType(event.target.value as ShareTargetType)}>
                <option value="user">指定用户</option>
                <option value="project">指定项目</option>
              </select>
            </label>
            <label>
              {targetType === 'user' ? '用户 ID' : '项目 ID'}
              <input
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
                placeholder={targetType === 'user' ? '粘贴用户 ID' : '粘贴项目 ID'}
              />
            </label>
            <label>
              过期时间
              <input
                type="datetime-local"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
              />
            </label>
          </div>

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

          <div className="share-dialog-submit">
            <span>{permissionSummary}</span>
            <button type="submit" disabled={savingKey === 'create' || !targetId.trim()}>
              {savingKey === 'create' ? '共享中...' : '添加共享'}
            </button>
          </div>
        </form>

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
