'use client';

import { useEffect, useMemo, useState } from 'react';
import { displayUserName } from '@/lib/users/display';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';

type AlbumScope = 'mine' | 'project' | 'shared' | 'public';

interface AlbumItem {
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
    width: number | null;
    height: number | null;
  } | null;
}

interface Props {
  open: boolean;
  currentCount: number;
  currentReferenceImageIds?: string[];
  onClose: () => void;
  onConfirm: (referenceImageIds: string[]) => Promise<void>;
}

const SCOPES: Array<{ value: AlbumScope; label: string }> = [
  { value: 'mine', label: '我的图集' },
  { value: 'project', label: '当前项目图集' },
  { value: 'shared', label: '共享给我的' },
  { value: 'public', label: '公共图集' },
];

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
        const list: AlbumItem[] = data.albums || [];
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
      await onConfirm(selectedImageIds);
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
            <h3>选择参考图</h3>
            <p>最多 9 张，顺序会进入生成工作台并对应 @图片1、@图片2、@图片3。</p>
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
                  <strong>{album.name}</strong>
                  <span>{album.image_count} 张 · {album.project?.name || (album.owner ? displayUserName(album.owner) : '个人')}</span>
                </button>
              ))
            )}
          </div>

          <div className="album-picker-images">
            {loading && <div className="album-picker-empty">读取中...</div>}
            {!loading && selectedAlbum && !selectedAlbum.permissions.use && (
              <div className="album-picker-empty">当前图集没有“用作参考图生成”权限</div>
            )}
            {!loading && selectedAlbum?.permissions.use && images.length === 0 && (
              <div className="album-picker-empty">这个图集还没有图片</div>
            )}
            {!loading && selectedAlbum?.permissions.use && images.map((image) => {
              const checked = selectedImageIds.includes(image.id);
              const isAlreadyInWorkspace = currentReferenceImageIdSet.has(image.id);
              const disabledByLimit = !checked && !isAlreadyInWorkspace && selectedNewCount >= remaining;
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
                    title="放大查看"
                    aria-label={`放大查看${image.asset?.file_name || `图 ${image.sort_order + 1}`}`}
                  >
                    <img src={image.thumbnail_url} alt={image.asset?.file_name || '参考图'} />
                  </button>
                  <button
                    type="button"
                    className="album-picker-image-select"
                    onClick={() => toggleImage(image.id)}
                    disabled={disabledByLimit}
                  >
                    {checked ? '已选择' : isAlreadyInWorkspace ? '已在工作台' : `图 ${image.sort_order + 1}`}
                  </button>
                </article>
              );
            })}
          </div>
        </div>

        <div className="album-picker-footer">
          <span>已选 {selectedImageIds.length} 张，其中新增 {selectedNewCount} 张，当前工作台还可新增 {remaining} 张</span>
          <div>
            <button type="button" className="album-picker-cancel" onClick={onClose}>取消</button>
            <button
              type="button"
              className="album-picker-confirm"
              onClick={handleConfirm}
              disabled={selectedImageIds.length === 0 || loading}
            >
              加入并插入 @图片
            </button>
          </div>
        </div>
        {previewImage && (
          <ZoomableImagePreview
            src={previewImage.image_url || previewImage.thumbnail_url}
            alt={previewImage.asset?.file_name || '参考图'}
            fileName={previewImage.asset?.file_name || `图 ${previewImage.sort_order + 1}`}
            onClose={() => setPreviewImage(null)}
          />
        )}
      </div>
    </div>
  );
}
