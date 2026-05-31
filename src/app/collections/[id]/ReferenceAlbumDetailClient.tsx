'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import PageBanner from '@/components/PageBanner';

interface AlbumDetail {
  id: string;
  name: string;
  description: string | null;
  album_type: string;
  visibility: string;
  image_count: number;
  owner?: { name: string; username: string };
  project?: { name: string } | null;
  permissions: {
    view: boolean;
    use: boolean;
    copy: boolean;
    download: boolean;
    viewSource: boolean;
    edit: boolean;
  };
  can_share: boolean;
}

interface ReferenceImageItem {
  id: string;
  sort_order: number;
  thumbnail_url: string;
  image_url: string;
  asset?: { file_name: string; width: number | null; height: number | null } | null;
}

interface ShareItem {
  id: string;
  grantee_type: string;
  grantee_id: string;
  permissions_json: string;
  created_at: string;
}

export default function ReferenceAlbumDetailClient({ albumId }: { albumId: string }) {
  const [album, setAlbum] = useState<AlbumDetail | null>(null);
  const [images, setImages] = useState<ReferenceImageItem[]>([]);
  const [shares, setShares] = useState<ShareItem[]>([]);
  const [selectedImageIds, setSelectedImageIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [shareType, setShareType] = useState<'user' | 'project'>('user');
  const [shareTarget, setShareTarget] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadAlbum = () => {
    setLoading(true);
    setError(null);
    fetch(`/api/reference-albums/${albumId}`)
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || data.message || '图集读取失败');
        setAlbum(data.album);
        setImages(data.images || []);
      })
      .catch((err) => setError(err instanceof Error ? err.message : '图集读取失败'))
      .finally(() => setLoading(false));
  };

  const loadShares = () => {
    fetch(`/api/reference-albums/${albumId}/shares`)
      .then((res) => res.ok ? res.json() : null)
      .then((data) => setShares(data?.shares || []))
      .catch(() => {});
  };

  useEffect(() => {
    loadAlbum();
  }, [albumId]);

  useEffect(() => {
    if (album?.can_share) loadShares();
  }, [album?.can_share, albumId]);

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const assetIds = [];
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);
        const uploadRes = await fetch('/api/assets/upload', { method: 'POST', body: formData });
        const uploadData = await uploadRes.json();
        if (!uploadRes.ok) throw new Error(uploadData.error || '图片上传失败');
        assetIds.push(uploadData.asset.id);
      }

      const addRes = await fetch(`/api/reference-albums/${albumId}/images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset_ids: assetIds }),
      });
      const addData = await addRes.json();
      if (!addRes.ok) throw new Error(addData.error || addData.message || '保存到图集失败');
      loadAlbum();
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败');
    } finally {
      setLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleUseForGeneration = async () => {
    if (selectedImageIds.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/workspace/assets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tab-id': sessionStorage.getItem('workspace_tab_id') || 'default',
        },
        body: JSON.stringify({ referenceImageIds: selectedImageIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || '加入生成工作台失败');
      window.location.href = '/generate';
    } catch (err) {
      setError(err instanceof Error ? err.message : '加入生成工作台失败');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteImage = async (imageId: string) => {
    if (!window.confirm('删除后历史任务仍会保留引用，新生成不能再使用。确定删除？')) return;
    const res = await fetch(`/api/reference-images/${imageId}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || data.message || '删除失败');
      return;
    }
    setSelectedImageIds((prev) => prev.filter((id) => id !== imageId));
    loadAlbum();
  };

  const handleShare = async () => {
    if (!shareTarget.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/reference-albums/${albumId}/shares`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grantee_type: shareType,
          grantee_id: shareTarget.trim(),
          permissions: { view: true, use: true, copy: true, download: false, viewSource: false, edit: false },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || '共享失败');
      setShareTarget('');
      loadShares();
      loadAlbum();
    } catch (err) {
      setError(err instanceof Error ? err.message : '共享失败');
    } finally {
      setLoading(false);
    }
  };

  const revokeShare = async (shareId: string) => {
    const res = await fetch(`/api/album-shares/${shareId}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || data.message || '取消共享失败');
      return;
    }
    loadShares();
    loadAlbum();
  };

  if (!album && loading) return <div className="card">读取中...</div>;

  return (
    <div>
      <PageBanner
        backHref="/collections"
        backLabel="返回参考图集"
        eyebrow="图集详情"
        title={album?.name || '参考图集'}
        description={album?.description || '图集图片会继承图集权限；取消共享后，被授权用户不能继续访问或使用。'}
      />

      {error && <div className="album-error">{error}</div>}

      {album && (
        <>
          <div className="album-detail-summary">
            <span>{album.image_count} 张图片</span>
            <span>创建者：{album.owner?.name || album.owner?.username || '-'}</span>
            <span>项目：{album.project?.name || '-'}</span>
            <span>范围：{album.visibility}</span>
            <span>权限：{album.permissions.view ? '可查看' : ''} {album.permissions.use ? '可生成' : ''} {album.permissions.edit ? '可编辑' : ''}</span>
          </div>

          <div className="album-detail-actions">
            {album.permissions.edit && (
              <>
                <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handleUpload} />
                <button type="button" onClick={() => fileInputRef.current?.click()} disabled={loading}>上传图片到图集</button>
              </>
            )}
            {album.permissions.use && (
              <button type="button" onClick={handleUseForGeneration} disabled={selectedImageIds.length === 0 || loading}>
                作为参考图生成
              </button>
            )}
          </div>

          <div className="album-image-grid">
            {images.length === 0 ? (
              <div className="album-empty">暂无图片</div>
            ) : (
              images.map((image) => {
                const selected = selectedImageIds.includes(image.id);
                return (
                  <div key={image.id} className={`album-image-card ${selected ? 'selected' : ''}`}>
                    <button
                      type="button"
                      className="album-image-select"
                      onClick={() => setSelectedImageIds((prev) => (
                        prev.includes(image.id) ? prev.filter((id) => id !== image.id) : [...prev, image.id].slice(0, 9)
                      ))}
                    >
                      <img src={image.thumbnail_url} alt={image.asset?.file_name || '参考图'} />
                    </button>
                    <div className="album-image-meta">
                      <span>图 {image.sort_order + 1}</span>
                      {album.permissions.edit && (
                        <button type="button" onClick={() => handleDeleteImage(image.id)}>删除</button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {album.can_share && (
            <div className="album-share-panel">
              <h2>共享图集</h2>
              <p>第一阶段支持共享给指定用户或项目，默认权限为查看、用于生成、复制。</p>
              <div className="album-share-form">
                <select value={shareType} onChange={(event) => setShareType(event.target.value as 'user' | 'project')}>
                  <option value="user">用户</option>
                  <option value="project">项目</option>
                </select>
                <input value={shareTarget} onChange={(event) => setShareTarget(event.target.value)} placeholder={shareType === 'user' ? '用户 ID' : '项目 ID'} />
                <button type="button" onClick={handleShare} disabled={loading || !shareTarget.trim()}>共享</button>
              </div>
              <div className="album-share-list">
                {shares.length === 0 ? (
                  <span>暂无共享</span>
                ) : shares.map((share) => (
                  <div key={share.id}>
                    <span>{share.grantee_type}: {share.grantee_id}</span>
                    <button type="button" onClick={() => revokeShare(share.id)}>取消共享</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
