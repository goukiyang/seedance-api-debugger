'use client';
import ContentReactions from '@/components/content-reactions/ContentReactions';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Eye } from 'lucide-react';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import MediaPreview from '@/components/MediaPreview';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import { useDialogDismiss } from '@/components/useDialogDismiss';

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
  onConfirm: (referenceImageIds: string[], assets?: ReferenceAlbumSelection[]) => Promise<ReferenceAlbumPickerConfirmResult>;
}

type ReferenceAlbumPickerConfirmResult = boolean | void | { success: boolean; message?: string };

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

function getConfirmFailure(result: ReferenceAlbumPickerConfirmResult) {
  if (result === false) return '所选素材未能加入，请检查选择后重试。';
  if (result && typeof result === 'object' && !result.success) {
    return result.message || '所选素材未能加入，请检查选择后重试。';
  }
  return null;
}

function AlbumThumbnail({ image }: { image: ReferenceImageItem }) {
  const [failed, setFailed] = useState(false);
  const src = (!image.asset?.type || image.asset.type === 'image') ? `/api/reference-images/${encodeURIComponent(image.id)}/content?variant=thumbnail` : image.thumbnail_url;
  useEffect(() => setFailed(false), [src]);
  if (failed || !src) return <div className="album-picker-media-placeholder">暂无封面</div>;
  return <img src={src} alt={image.asset?.file_name || '素材封面'} loading="lazy" onError={() => setFailed(true)} />;
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
  const [selectedAssetsById, setSelectedAssetsById] = useState<Record<string, ReferenceAlbumSelection>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<ReferenceImageItem | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useDialogDismiss({
    open,
    dialogRef,
    dismissSurfaceRef: backdropRef,
    onDismiss: onClose,
  });

  useEffect(() => {
    if (open) return;
    setSelectedImageIds([]);
    setSelectedAssetsById({});
  }, [open]);

  void currentCount;
  const currentReferenceImageIdSet = useMemo(
    () => new Set(currentReferenceImageIds.filter(Boolean)),
    [currentReferenceImageIds],
  );
  const selectedAlbum = useMemo(
    () => albums.find((album) => album.id === selectedAlbumId) || null,
    [albums, selectedAlbumId],
  );

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/reference-albums?scope=${scope}`, { signal: controller.signal })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (controller.signal.aborted) return;
        if (!ok) throw new Error(data.error || data.message || '图集读取失败');
        const list: AlbumItem[] = (data.albums || []).filter((album: AlbumItem) => album.image_count > 0);
        setAlbums(list);
        setSelectedAlbumId((prev) => (list.some((album) => album.id === prev) ? prev : list[0]?.id || ''));
      })
      .catch((err) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '图集读取失败'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, scope]);

  useEffect(() => {
    if (!open || !selectedAlbumId) {
      setImages([]);
      setPreviewImage(null);
      return;
    }
    const controller = new AbortController();
    setImages([]);
    setPreviewImage(null);
    setLoading(true);
    setError(null);
    fetch(`/api/reference-albums/${selectedAlbumId}`, { signal: controller.signal })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (controller.signal.aborted) return;
        if (!ok) throw new Error(data.error || data.message || '图集详情读取失败');
        setImages(data.images || []);
        setPreviewImage(null);
      })
      .catch((err) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '图集详情读取失败'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, selectedAlbumId]);

  if (!open) return null;

  const toggleImage = (imageId: string) => {
    if (selectedImageIds.includes(imageId)) {
      setSelectedImageIds(selectedImageIds.filter((id) => id !== imageId));
      setSelectedAssetsById((current) => {
        const next = { ...current };
        delete next[imageId];
        return next;
      });
      return;
    }
    const image = images.find((item) => item.id === imageId);
    if (!image) return;
    setSelectedImageIds([...selectedImageIds, imageId]);
    setSelectedAssetsById((current) => ({
      ...current,
      [imageId]: { id: imageId, type: selectionTypeFromItem(image) },
    }));
  };

  const handleConfirm = async () => {
    if (selectedImageIds.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const selectedAssets = selectedImageIds
        .map((id) => selectedAssetsById[id])
        .filter((asset): asset is ReferenceAlbumSelection => Boolean(asset));
      if (selectedAssets.length !== selectedImageIds.length) throw new Error('部分已选素材信息暂时不可用，请重新选择后重试。');
      const result = await onConfirm(selectedImageIds, selectedAssets);
      const failure = getConfirmFailure(result);
      if (failure) {
        setError(failure);
        return;
      }
      setSelectedImageIds([]);
      setSelectedAssetsById({});
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '加入工作台失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div ref={backdropRef} className="album-picker-backdrop">
      <div ref={dialogRef} className="album-picker" role="dialog" aria-modal="true" aria-label="选择参考素材">
        <div className="album-picker-header">
          <div>
            <h3>选择参考素材</h3>
            <p>顺序会进入生成工作台；图片、视频和音频会按类型传给生成接口，生成前再检查各自上限。</p>
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
              const typeLabel = mediaTypeLabel(image.asset?.type);
              const isImage = isImageItem(image);
              const previewSrc = `/api/reference-images/${encodeURIComponent(image.id)}/content?variant=preview`;
              const title = image.asset?.file_name || `${typeLabel} ${image.sort_order + 1}`;
              return (
                <article
                  key={image.id}
                  className={[
                    'album-picker-image-card',
                    checked ? 'selected' : '',
                  ].filter(Boolean).join(' ')}
                >
                  <div className="media-reaction-cover" data-reaction-surface>
                  <button
                    type="button"
                    className="album-picker-image-preview"
                    onClick={() => setPreviewImage(image)}
                    title={isImage ? '放大查看' : `预览${typeLabel}`}
                    aria-label={`${isImage ? '放大查看' : `预览${typeLabel}`}${title}`}
                    style={{ position: 'relative' }}
                  >
                    <AlbumThumbnail image={image} />
                    <span aria-hidden="true" style={{ alignItems: 'center', background: 'rgba(17, 24, 39, .76)', borderRadius: 4, color: 'white', display: 'inline-flex', padding: 4, position: 'absolute', right: 7, top: 7 }}><Eye size={14} /></span>
                  </button>
                  <ContentReactions contentKey={`reference_image:${image.id}`} overlay />
                  </div>
                  <label className="album-picker-image-select">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleImage(image.id)}
                      aria-label={`选择${image.asset?.file_name || `${typeLabel} ${image.sort_order + 1}`}`}
                    />
                    <span>{checked ? `已选 ${selectedImageIds.indexOf(image.id) + 1}` : '选择'}</span>
                    {isAlreadyInWorkspace && <small>已在工作台</small>}
                  </label>
                </article>
              );
            })}
          </div>
        </div>

        <div className="album-picker-footer">
          <span>已选 {selectedImageIds.length} 个；生成前会检查图片、视频、音频各自上限</span>
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
            contentKey={`reference_image:${previewImage.id}`}
            src={`/api/reference-images/${encodeURIComponent(previewImage.id)}/content?variant=preview`}
            alt={previewImage.asset?.file_name || '参考图'}
            fileName={previewImage.asset?.file_name || `图 ${previewImage.sort_order + 1}`}
            onClose={() => setPreviewImage(null)}
          />
        )}
        {previewImage && !isImageItem(previewImage) && (
          <MediaPreview
            src={`/api/reference-images/${encodeURIComponent(previewImage.id)}/content?variant=preview`}
            type={previewImage.asset?.type === 'video' ? 'video' : 'audio'}
            title={previewImage.asset?.file_name || `${mediaTypeLabel(previewImage.asset?.type)} ${previewImage.sort_order + 1}`}
            poster={previewImage.thumbnail_url || undefined}
            contentKey={`reference_image:${previewImage.id}`}
            previewKey={previewImage.id}
            details={<div><span>{mediaTypeLabel(previewImage.asset?.type)}</span>{previewImage.asset?.file_size != null && <span>{previewImage.asset.file_size} 字节</span>}</div>}
            onClose={() => setPreviewImage(null)}
          />
        )}
      </div>
    </div>
  );
}
