'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { buildRawFileUploadRequest } from '@/lib/http/file-upload';
import { readJsonResponse } from '@/lib/http/json-response';
import type { TemplateContextCardBoundImage } from '@/lib/templates/workbench';

type AlbumScope = 'mine' | 'project' | 'shared' | 'public';

type AlbumItem = {
  id: string;
  name: string;
  image_count: number;
  owner?: { id?: string; name: string | null; username: string | null; email?: string | null; avatar_url?: string | null; account_type?: string | null };
  project?: { name: string } | null;
  permissions: { view: boolean; use: boolean };
};

type ReferenceImageItem = {
  id: string;
  sort_order: number;
  thumbnail_url: string;
  image_url: string;
  asset?: {
    id?: string;
    file_name: string;
    width: number | null;
    height: number | null;
  } | null;
};

type UploadedImageItem = {
  id: string;
  originalUrl: string;
  thumbnailUrl: string;
  fileName: string;
  width: number | null;
  height: number | null;
  createdAt: string;
};

type Props = {
  open: boolean;
  currentImage: TemplateContextCardBoundImage | null;
  onClose: () => void;
  onSelect: (image: TemplateContextCardBoundImage) => void;
};

type ApiMessageResponse = {
  error?: string;
  message?: string;
};

type AlbumListResponse = ApiMessageResponse & {
  albums?: AlbumItem[];
};

type AlbumDetailResponse = ApiMessageResponse & {
  images?: ReferenceImageItem[];
};

type HistoryListResponse = ApiMessageResponse & {
  assets?: UploadedImageItem[];
};

type UploadAssetResponse = ApiMessageResponse & {
  asset?: {
    id?: string;
    originalUrl?: string | null;
    thumbnailUrl?: string | null;
    fileName?: string;
    width?: number | null;
    height?: number | null;
  };
};

const SCOPES: Array<{ value: AlbumScope; label: string }> = [
  { value: 'mine', label: '我的图集' },
  { value: 'project', label: '项目图集' },
  { value: 'shared', label: '共享给我' },
  { value: 'public', label: '公共图集' },
];

const PICKER_INVALID_JSON_MESSAGE = '图片选择服务返回了页面内容，请刷新后重试；如果仍出现，请重新登录。';
const UPLOAD_INVALID_JSON_MESSAGE = '图片上传服务返回了页面内容，请刷新后重试；如果仍出现，请重新登录。';

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

export function TemplateBoundImagePicker({ open, currentImage, onClose, onSelect }: Props) {
  const [tab, setTab] = useState<'album' | 'history'>('album');
  const [scope, setScope] = useState<AlbumScope>('mine');
  const [albums, setAlbums] = useState<AlbumItem[]>([]);
  const [selectedAlbumId, setSelectedAlbumId] = useState('');
  const [referenceImages, setReferenceImages] = useState<ReferenceImageItem[]>([]);
  const [historyImages, setHistoryImages] = useState<UploadedImageItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const selectedAlbum = useMemo(
    () => albums.find((album) => album.id === selectedAlbumId) || null,
    [albums, selectedAlbumId],
  );

  useEffect(() => {
    if (!open || tab !== 'album') return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const loadAlbums = async () => {
      try {
        const res = await fetch(`/api/reference-albums?scope=${scope}`, { cache: 'no-store' });
        const data = await readJsonResponse<AlbumListResponse>(res, {
          invalidJsonMessage: PICKER_INVALID_JSON_MESSAGE,
        });
        if (!res.ok) throw new Error(data.error || data.message || '图集读取失败');
        const list: AlbumItem[] = (data.albums || []).filter((album: AlbumItem) => album.image_count > 0);
        if (cancelled) return;
        setAlbums(list);
        setSelectedAlbumId((current) => (list.some((album) => album.id === current) ? current : list[0]?.id || ''));
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : '图集读取失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void loadAlbums();
    return () => {
      cancelled = true;
    };
  }, [open, scope, tab]);

  useEffect(() => {
    if (!open || tab !== 'album' || !selectedAlbumId) {
      setReferenceImages([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const loadAlbumImages = async () => {
      try {
        const res = await fetch(`/api/reference-albums/${selectedAlbumId}`, { cache: 'no-store' });
        const data = await readJsonResponse<AlbumDetailResponse>(res, {
          invalidJsonMessage: PICKER_INVALID_JSON_MESSAGE,
        });
        if (!res.ok) throw new Error(data.error || data.message || '图集详情读取失败');
        if (cancelled) return;
        setReferenceImages(data.images || []);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : '图集详情读取失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void loadAlbumImages();
    return () => {
      cancelled = true;
    };
  }, [open, selectedAlbumId, tab]);

  const loadHistoryImages = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/assets/history?page=1&limit=60', { cache: 'no-store' });
      const data = await readJsonResponse<HistoryListResponse>(res, {
        invalidJsonMessage: PICKER_INVALID_JSON_MESSAGE,
      });
      if (!res.ok) throw new Error(data.error || data.message || '历史上传图读取失败');
      setHistoryImages(data.assets || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '历史上传图读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || tab !== 'history') return;
    void loadHistoryImages();
  }, [loadHistoryImages, open, tab]);

  if (!open) return null;

  const chooseReferenceImage = (image: ReferenceImageItem) => {
    onSelect({
      source: 'reference_album',
      id: image.id,
      reference_image_id: image.id,
      asset_id: image.asset?.id || null,
      label: image.asset?.file_name || `参考图 ${image.sort_order + 1}`,
      url: image.image_url,
      thumbnail_url: image.thumbnail_url,
    });
    onClose();
  };

  const chooseHistoryImage = (image: UploadedImageItem) => {
    onSelect({
      source: 'upload_history',
      id: image.id,
      reference_image_id: null,
      asset_id: image.id,
      label: image.fileName,
      url: image.originalUrl,
      thumbnail_url: image.thumbnailUrl,
    });
    onClose();
  };

  const handleUploadClick = () => {
    if (uploading) return;
    uploadInputRef.current?.click();
  };

  const handleUploadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = Array.from(event.target.files || []).find((item) => item.type.startsWith('image/'));
    if (!file) return;

    setUploading(true);
    setError(null);
    try {
      const res = await fetch('/api/assets/upload', {
        ...buildRawFileUploadRequest(file),
      });
      const data = await readJsonResponse<UploadAssetResponse>(res, {
        invalidJsonMessage: UPLOAD_INVALID_JSON_MESSAGE,
      });
      if (!res.ok) throw new Error(data.error || data.message || '图片上传失败');
      const asset = data.asset;
      if (!asset?.id) throw new Error('图片上传成功，但没有返回素材 ID');
      const assetId = asset.id;
      const nextImage: TemplateContextCardBoundImage = {
        source: 'upload_history',
        id: assetId,
        reference_image_id: null,
        asset_id: assetId,
        label: asset.fileName || file.name,
        url: asset.originalUrl || asset.thumbnailUrl || null,
        thumbnail_url: asset.thumbnailUrl || asset.originalUrl || null,
      };
      setHistoryImages((current) => [
        {
          id: assetId,
          originalUrl: asset.originalUrl || asset.thumbnailUrl || '',
          thumbnailUrl: asset.thumbnailUrl || asset.originalUrl || '',
          fileName: asset.fileName || file.name,
          width: asset.width ?? null,
          height: asset.height ?? null,
          createdAt: new Date().toISOString(),
        },
        ...current.filter((item) => item.id !== asset.id),
      ]);
      setTab('history');
      onSelect(nextImage);
      onClose();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : '图片上传失败');
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = '';
    }
  };

  return (
    <div className="template-bound-image-backdrop" onClick={onClose}>
      <div className="template-bound-image-picker" onClick={(event) => event.stopPropagation()}>
        <input
          ref={uploadInputRef}
          type="file"
          accept="image/*"
          className="template-bound-image-file-input"
          onChange={(event) => { void handleUploadFile(event); }}
        />
        <header className="template-bound-image-head">
          <div>
            <h3>选择绑定图片</h3>
            <p>一次只绑定 1 张图片，可随时更换。</p>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭图片选择">x</button>
        </header>

        <div className="template-bound-image-tabs" role="tablist" aria-label="图片来源">
          <button type="button" className={tab === 'album' ? 'is-active' : ''} onClick={() => setTab('album')}>参考图集</button>
          <button type="button" className={tab === 'history' ? 'is-active' : ''} onClick={() => setTab('history')}>历史上传图</button>
        </div>

        {error && <div className="template-drawer-error">{error}</div>}

        {tab === 'album' ? (
          <div className="template-bound-image-body">
            <aside className="template-bound-image-sidebar">
              <div className="template-bound-image-scope">
                {SCOPES.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    className={scope === item.value ? 'is-active' : ''}
                    onClick={() => setScope(item.value)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <div className="template-bound-image-albums">
                {albums.length === 0 && !loading ? (
                  <div className="template-bound-image-empty">暂无图集</div>
                ) : albums.map((album) => (
                  <button
                    key={album.id}
                    type="button"
                    className={album.id === selectedAlbumId ? 'is-active' : ''}
                    onClick={() => setSelectedAlbumId(album.id)}
                  >
                    <span className="template-bound-image-album-title">
                      <UserIdentityBadge user={album.owner} size="sm" avatarOnly />
                      <strong>{album.name}</strong>
                    </span>
                    <span>
                      {album.image_count} 张
                      {album.project?.name ? ` · ${album.project.name}` : ''}
                    </span>
                  </button>
                ))}
              </div>
            </aside>
            <main className="template-bound-image-grid">
              {loading && <div className="template-bound-image-empty">读取中...</div>}
              {!loading && selectedAlbum && !selectedAlbum.permissions.use && (
                <div className="template-bound-image-empty">当前图集没有使用权限</div>
              )}
              {!loading && selectedAlbum?.permissions.use && referenceImages.length === 0 && (
                <div className="template-bound-image-empty">这个图集还没有图片</div>
              )}
              {!loading && selectedAlbum?.permissions.use && referenceImages.map((image) => {
                const selected = currentImage?.reference_image_id === image.id || currentImage?.id === image.id;
                return (
                  <button
                    key={image.id}
                    type="button"
                    className={selected ? 'is-selected' : ''}
                    onClick={() => chooseReferenceImage(image)}
                  >
                    <img src={image.thumbnail_url} alt={image.asset?.file_name || '参考图'} />
                    <span>{image.asset?.file_name || `图 ${image.sort_order + 1}`}</span>
                    {selected && <em>已绑定</em>}
                  </button>
                );
              })}
            </main>
          </div>
        ) : (
          <div className="template-bound-image-history">
            {loading && <div className="template-bound-image-empty">读取中...</div>}
            {!loading && historyImages.length === 0 && <div className="template-bound-image-empty">还没有历史上传图</div>}
            {!loading && historyImages.map((image) => {
              const selected = currentImage?.asset_id === image.id || currentImage?.id === image.id;
              const dimensions = image.width && image.height ? `${image.width}x${image.height}` : '未知尺寸';
              return (
                <button
                  key={image.id}
                  type="button"
                  className={selected ? 'is-selected' : ''}
                  onClick={() => chooseHistoryImage(image)}
                >
                  <img src={image.thumbnailUrl} alt={image.fileName} />
                  <strong>{image.fileName}</strong>
                  <span>{dimensions} · {formatDate(image.createdAt)}</span>
                  {selected && <em>已绑定</em>}
                </button>
              );
            })}
          </div>
        )}

        <footer className="template-bound-image-footer">
          <span>{currentImage ? `当前绑定：${currentImage.label}` : '当前没有绑定图片'}</span>
          <div className="template-bound-image-footer-actions">
            <button
              type="button"
              className="template-bound-image-upload"
              onClick={handleUploadClick}
              disabled={uploading || loading}
            >
              {uploading ? '上传中...' : '上传并绑定图片'}
            </button>
            <button type="button" onClick={onClose}>取消</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
