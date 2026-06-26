'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import PageBanner from '@/components/PageBanner';
import ShareAlbumDialog, { type ShareAlbumDialogAlbum } from '@/components/ShareAlbumDialog';
import { displayUserName } from '@/lib/users/display';

interface AlbumDetail {
  id: string;
  name: string;
  description: string | null;
  album_type: string;
  visibility: string;
  cover_image_id: string | null;
  cover_image_url: string | null;
  status: string;
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
  active_share_count: number;
}

interface ReferenceImageItem {
  id: string;
  sort_order: number;
  thumbnail_url: string;
  image_url: string;
  asset?: { file_name: string; width: number | null; height: number | null } | null;
}

export default function ReferenceAlbumDetailClient({ albumId }: { albumId: string }) {
  const [album, setAlbum] = useState<AlbumDetail | null>(null);
  const [images, setImages] = useState<ReferenceImageItem[]>([]);
  const [selectedImageIds, setSelectedImageIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [shareDialogAlbum, setShareDialogAlbum] = useState<ShareAlbumDialogAlbum | null>(null);
  const [sharingImageId, setSharingImageId] = useState<string | null>(null);
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

  useEffect(() => {
    loadAlbum();
  }, [albumId]);

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

  const handleShareSingleImage = async (image: ReferenceImageItem) => {
    setSharingImageId(image.id);
    setError(null);
    try {
      const res = await fetch(`/api/reference-images/${image.id}/share-album`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: image.asset?.file_name ? `单图共享 - ${image.asset.file_name}` : `单图共享 - 图 ${image.sort_order + 1}`,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.message || '单图共享创建失败');
      setShareDialogAlbum(data.album);
    } catch (err) {
      setError(err instanceof Error ? err.message : '单图共享创建失败');
    } finally {
      setSharingImageId(null);
    }
  };

  const handleRenameAlbum = async () => {
    if (!album) return;
    const nextName = window.prompt('输入新的图集名称', album.name)?.trim();
    if (!nextName || nextName === album.name) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/reference-albums/${album.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nextName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || '重命名失败');
      setAlbum((current) => current ? { ...current, name: data.album?.name || nextName } : current);
    } catch (err) {
      setError(err instanceof Error ? err.message : '重命名失败');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteAlbum = async () => {
    if (!album) return;
    const confirmed = window.confirm(`删除图集「${album.name}」？图集会从列表隐藏，历史任务引用的参考图仍会保留。`);
    if (!confirmed) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/reference-albums/${album.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.message || '删除图集失败');
      window.location.href = '/collections';
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除图集失败');
      setLoading(false);
    }
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
            <span>创建者：{displayUserName(album.owner)}</span>
            <span>项目：{album.project?.name || '-'}</span>
            <span>范围：{album.visibility}</span>
            {album.can_share && <span>共享：{album.active_share_count || 0} 个对象</span>}
            <span>权限：{album.permissions.view ? '可查看' : ''} {album.permissions.use ? '可生成' : ''} {album.permissions.edit ? '可编辑' : ''}</span>
          </div>

          <div className="album-detail-actions">
            {album.permissions.edit && (
              <>
                <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handleUpload} />
                <button type="button" onClick={() => fileInputRef.current?.click()} disabled={loading}>上传图片到图集</button>
                <button type="button" onClick={handleRenameAlbum} disabled={loading}>重命名图集</button>
                <button type="button" className="danger" onClick={handleDeleteAlbum} disabled={loading}>删除图集</button>
              </>
            )}
            {album.permissions.use && (
              <button type="button" onClick={handleUseForGeneration} disabled={selectedImageIds.length === 0 || loading}>
                作为参考图生成
              </button>
            )}
            {album.can_share && !['public', 'system'].includes(album.album_type) && (
              <button type="button" onClick={() => setShareDialogAlbum(album)} disabled={loading}>
                {album.active_share_count > 0 ? '共享设置' : '转为共享图集'}
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
                      {album.permissions.copy && (
                        <button
                          type="button"
                          onClick={() => handleShareSingleImage(image)}
                          disabled={sharingImageId === image.id}
                        >
                          {sharingImageId === image.id ? '创建中...' : '共享'}
                        </button>
                      )}
                      {album.permissions.edit && (
                        <button type="button" onClick={() => handleDeleteImage(image.id)}>删除</button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <ShareAlbumDialog
            open={Boolean(shareDialogAlbum)}
            album={shareDialogAlbum}
            onClose={() => setShareDialogAlbum(null)}
            onChanged={() => {
              if (shareDialogAlbum?.id === album.id) loadAlbum();
            }}
          />
        </>
      )}
    </div>
  );
}
