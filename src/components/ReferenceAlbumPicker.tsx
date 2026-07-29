'use client';

import { useEffect, useMemo, useState } from 'react';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';

type AlbumScope = 'mine' | 'project' | 'shared' | 'public';

interface AlbumItem {
  id: string;
  name: string;
  description: string | null;
  album_type: string;
  visibility: string;
  image_count: number;
  owner?: { id?: string; name: string | null; username: string | null; email?: string | null; avatar_url?: string | null; account_type?: string | null };
  project?: { name: string } | null;
  permissions: {
    view: boolean;
    use: boolean;
    copy: boolean;
    edit: boolean;
  };
}

interface ReferenceImageItem {
  id: string;
  sort_order: number;
  thumbnail_url: string;
  image_url: string;
  asset?: {
    file_name: string;
    type?: string | null;
    mime_type?: string | null;
    file_size?: number | null;
    width: number | null;
    height: number | null;
  } | null;
}

export type ReferenceAlbumSelection = {
  id: string;
  type: 'image' | 'video' | 'audio';
};

interface Props {
  open: boolean;
  currentCount: number;
  currentReferenceImageIds?: string[];
  onClose: () => void;
  onConfirm: (referenceImageIds: string[], assets?: ReferenceAlbumSelection[]) => Promise<void>;
}

const SCOPES: Array<{ value: AlbumScope; label: string }> = [
  { value: 'mine', label: '我的图集' },
  { value: 'project', label: '当前项目图集' },
  { value: 'shared', label: '共享给我的' },
  { value: 'public', label: '公共图集' },
];

function mediaTypeLabel(type: string | null | undefined) {
  if (type === 'video') return '视频';
  if (type === 'audio') return '音频';
  return '图片';
}

function isImageItem(image: ReferenceImageItem | null) {
  return !image?.asset?.type || image.asset.type === 'image';
}

function selectionTypeFromItem(image: ReferenceImageItem): ReferenceAlbumSelection['type'] {
  if (image.asset?.type === 'video') return 'video';
  if (image.asset?.type === 'audio') return 'audio';
  return 'image';
}

export function ReferenceAlbumPicker({
  open,
  currentCount,
  currentReferenceImageIds = [],
  onClose,
  onConfirm,
}: Props) {
  const [scope, setScope] = useState<AlbumScope>('mine');
  const [albums, setAlbums] = useState<AlbumItem[]>([]);
  const [selectedAlbumId, setSelectedAlbumId] = useState<string>('');
  const [images, setImages] = useState<ReferenceImageItem[]>([]);
  const [selectedImageIds, setSelectedImageIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<ReferenceImageItem | null>(null);

  const remaining = Math.max(0, 9 - currentCount);
  const currentReferenceImageIdSet = useMemo(
    () => new Set(currentReferenceImageIds.filter(Boolean)),
    [currentReferenceImageIds],
  );
  const selectedNewCount = useMemo(
    () => selectedImageIds.filter((id) => !currentReferenceImageIdSet.has(id)).length,
    [currentReferenceImageIdSet, selectedImageIds],
  );
  const selectedAlbum = useMemo(
    () => albums.find((album) => album.id === selectedAlbumId) || null,
    [albums, selectedAlbumId],
  );

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    fetch(`/api/reference-albums?scope=${scope}`)
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || data.message || '图集读取失败');
        const list: AlbumItem[] = (data.albums || []).filter((album: AlbumItem) => album.image_count > 0);
        setAlbums(list);
        setSelectedAlbumId((prev) => (list.some((album) => album.id === prev) ? prev : list[0]?.id || ''));
      })
      .catch((err) => setError(err instanceof Error ? err.message : '图集读取失败'))
      .finally(() => setLoading(false));
  }, [open, scope]);

  useEffect(() => {
    if (!open || !selectedAlbumId) {
      setImages([]);
      setSelectedImageIds([]);
      setPreviewImage(null);
      return;
    }
    setLoading(true);
    setError(null);
    fetch(`/api/reference-albums/${selectedAlbumId}`)
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || data.message || '图集详情读取失败');
        setImages(data.images || []);
        setSelectedImageIds([]);
        setPreviewImage(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : '图集详情读取失败'))
      .finally(() => setLoading(false));
  }, [open, selectedAlbumId]);

  if (!open) return null;

  const toggleImage = (imageId: string) => {
    setSelectedImageIds((prev) => {
      if (prev.includes(imageId)) return prev.filter((id) => id !== imageId);
      const isAlreadyInWorkspace = currentReferenceImageIdSet.has(imageId);
      const prevNewCount = prev.filter((id) => !currentReferenceImageIdSet.has(id)).length;
      const nextNewCount = prevNewCount + (isAlreadyInWorkspace ? 0 : 1);
      if (nextNewCount > remaining) return prev;
      return [...prev, imageId];
    });
  };

  const handleConfirm = async () => {
    if (selectedImageIds.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const itemById = new Map(images.map((image) => [image.id, image]));
      const selectedAssets = selectedImageIds
        .map((id) => itemById.get(id))
        .filter((image): image is ReferenceImageItem => Boolean(image))
        .map((image) => ({ id: image.id, type: selectionTypeFromItem(image) }));
      await onConfirm(selectedImageIds, selectedAssets);
      setSelectedImageIds([]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '加入工作台失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="album-picker-backdrop" onClick={onClose}>
      <div className="album-picker" onClick={(event) => event.stopPropagation()}>
        <div className="album-picker-header">
          <div>
            <h3>选择参考素材</h3>
            <p>最多 9 个，顺序会进入生成工作台；图片、视频和音频会按类型传给生成接口。</p>
          </div>
          <button type="button" className="album-picker-close" onClick={onClose}>×</button>
        </div>

        <div className="album-picker-tabs">
          {SCOPES.map((item) => (
            <button
              key={item.value}
              type="button"
              className={scope === item.value ? 'active' : ''}
              onClick={() => setScope(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {error && <div className="album-picker-error">{error}</div>}

        <div className="album-picker-body">
          <div className="album-picker-albums">
            {albums.length === 0 && !loading ? (
              <div className="album-picker-empty">暂无图集</div>
            ) : (
              albums.map((album) => (
                <button
                  key={album.id}
                  type="button"
                  className={album.id === selectedAlbumId ? 'active' : ''}
                  onClick={() => setSelectedAlbumId(album.id)}
                >
                  <span className="album-picker-album-title">
                    <UserIdentityBadge user={album.owner} size="sm" avatarOnly />
                    <strong>{album.name}</strong>
                  </span>
                  <span className="album-picker-album-meta">
                    <span>{album.image_count} 个</span>
                    {album.project?.name ? (
                      <span>{album.project.name}</span>
                    ) : (
                      <span>个人</span>
                    )}
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="album-picker-images">
            {loading && <div className="album-picker-empty">读取中...</div>}
            {!loading && selectedAlbum && !selectedAlbum.permissions.use && (
              <div className="album-picker-empty">当前图集没有“用作参考素材生成”权限</div>
            )}
            {!loading && selectedAlbum?.permissions.use && images.length === 0 && (
              <div className="album-picker-empty">这个图集还没有素材</div>
            )}
            {!loading && selectedAlbum?.permissions.use && images.map((image) => {
              const checked = selectedImageIds.includes(image.id);
              const isAlreadyInWorkspace = currentReferenceImageIdSet.has(image.id);
              const disabledByLimit = !checked && !isAlreadyInWorkspace && selectedNewCount >= remaining;
              const typeLabel = mediaTypeLabel(image.asset?.type);
              const isImage = isImageItem(image);
              const isVideo = image.asset?.type === 'video';
              return (
                <article
                  key={image.id}
                  className={[
                    'album-picker-image-card',
                    checked ? 'selected' : '',
                    disabledByLimit ? 'disabled' : '',
                  ].filter(Boolean).join(' ')}
                >
                  <button
                    type="button"
                    className="album-picker-image-preview"
                    onClick={() => setPreviewImage(image)}
                    title={isImage ? '放大查看' : `预览${typeLabel}`}
                    aria-label={`${isImage ? '放大查看' : `预览${typeLabel}`}${image.asset?.file_name || `${typeLabel} ${image.sort_order + 1}`}`}
                  >
                    {isImage ? (
                      <img src={image.thumbnail_url} alt={image.asset?.file_name || '参考图'} />
                    ) : isVideo ? (
                      <video src={image.thumbnail_url || image.image_url} muted playsInline preload="metadata" />
                    ) : (
                      <div className="album-picker-media-placeholder">音频</div>
                    )}
                  </button>
                  <button
                    type="button"
                    className="album-picker-image-select"
                    onClick={() => toggleImage(image.id)}
                    disabled={disabledByLimit}
                  >
                    {checked ? '已选择' : isAlreadyInWorkspace ? '已在工作台' : `${typeLabel} ${image.sort_order + 1}`}
                  </button>
                </article>
              );
            })}
          </div>
        </div>

        <div className="album-picker-footer">
          <span>已选 {selectedImageIds.length} 个，其中新增 {selectedNewCount} 个，当前工作台还可新增 {remaining} 个</span>
          <div>
            <button type="button" className="album-picker-cancel" onClick={onClose}>取消</button>
            <button
              type="button"
              className="album-picker-confirm"
              onClick={handleConfirm}
              disabled={selectedImageIds.length === 0 || loading}
            >
              加入参考区
            </button>
          </div>
        </div>
        {previewImage && isImageItem(previewImage) && (
          <ZoomableImagePreview
            src={previewImage.image_url || previewImage.thumbnail_url}
            alt={previewImage.asset?.file_name || '参考图'}
            fileName={previewImage.asset?.file_name || `图 ${previewImage.sort_order + 1}`}
            onClose={() => setPreviewImage(null)}
          />
        )}
        {previewImage && !isImageItem(previewImage) && (
          <div className="album-media-preview-backdrop" onClick={() => setPreviewImage(null)}>
            <div className="album-media-preview-modal" onClick={(event) => event.stopPropagation()}>
              <button type="button" className="album-media-preview-close" onClick={() => setPreviewImage(null)}>×</button>
              <strong>{previewImage.asset?.file_name || `${mediaTypeLabel(previewImage.asset?.type)} ${previewImage.sort_order + 1}`}</strong>
              {previewImage.asset?.type === 'video' ? (
                <video src={previewImage.thumbnail_url || previewImage.image_url} controls playsInline />
              ) : (
                <audio src={previewImage.thumbnail_url || previewImage.image_url} controls />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
