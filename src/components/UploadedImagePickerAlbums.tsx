'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft, FolderOpen, RefreshCw } from 'lucide-react';
import { readJsonResponse } from '@/lib/http/json-response';
import type { UploadedAssetSelection } from '@/components/UploadedImagePicker';
import styles from './UploadedImagePickerAlbums.module.css';

type PrivateAlbum = {
  id: string;
  name: string;
  image_count?: number;
  album_type: string;
  visibility: string;
  status: string;
};

type AlbumImage = {
  id: string;
  asset_id: string | null;
  asset?: { id: string; type: string } | null;
};

type AlbumImageSelection = {
  referenceId: string;
  assetId: string | null;
  asset: HistoryAsset | null;
};

type HistoryAsset = UploadedAssetSelection & {
  type: 'image';
  originalUrl: string;
  thumbnailUrl?: string;
  fileName?: string;
  width?: number | null;
  height?: number | null;
};

type AlbumListResponse = { albums?: PrivateAlbum[]; error?: string; message?: string };
type AlbumImagesResponse = { images?: AlbumImage[]; error?: string; message?: string };
type HistoryResponse = {
  assets?: HistoryAsset[];
  error?: string;
  message?: string;
};
type CreateAlbumResponse = { album?: PrivateAlbum; error?: string; message?: string };
type AttachAssetsResponse = { images?: Array<{ id: string }>; error?: string; message?: string };

interface Props {
  selectedAssetIds: string[];
  selectedAssets: UploadedAssetSelection[];
  currentAssetIds: string[];
  maxSelection?: number;
  onToggleAsset: (asset: UploadedAssetSelection) => void;
}

const PAGE_SIZE = 40;
const ALBUMS_INVALID_JSON = '私人图集服务返回了无法读取的内容，请刷新后重试。';
const HISTORY_INVALID_JSON = '本人图片素材暂时无法核对，请重试。';

function apiError(data: { error?: string; message?: string }, fallback: string) {
  return data.error || data.message || fallback;
}

function AlbumImagePreview({ asset }: { asset: HistoryAsset }) {
  const [failed, setFailed] = useState(false);
  const src = asset.thumbnailUrl || asset.originalUrl;
  useEffect(() => setFailed(false), [src]);

  if (failed) return <span className={styles.unavailableMedia}>预览不可用</span>;
  return <img src={src} alt={asset.fileName || '图集图片'} loading="lazy" onError={() => setFailed(true)} />;
}

export function UploadedImagePickerAlbums({
  selectedAssetIds,
  selectedAssets,
  currentAssetIds,
  maxSelection,
  onToggleAsset,
}: Props) {
  const [albums, setAlbums] = useState<PrivateAlbum[]>([]);
  const [albumsLoading, setAlbumsLoading] = useState(false);
  const [albumsError, setAlbumsError] = useState<string | null>(null);
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const [targetAlbumId, setTargetAlbumId] = useState('');
  const [albumImages, setAlbumImages] = useState<AlbumImageSelection[]>([]);
  const [albumImagesLoading, setAlbumImagesLoading] = useState(false);
  const [albumImagesError, setAlbumImagesError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<'create' | 'attach' | null>(null);
  const [createFailed, setCreateFailed] = useState(false);
  const [retryCreatedAlbumId, setRetryCreatedAlbumId] = useState<string | null>(null);
  const [retryExistingAlbumId, setRetryExistingAlbumId] = useState<string | null>(null);
  const [newAlbumName, setNewAlbumName] = useState('');
  const [visibleAlbumCount, setVisibleAlbumCount] = useState(PAGE_SIZE);
  const [visibleImageCount, setVisibleImageCount] = useState(PAGE_SIZE);
  const [imagePageStart, setImagePageStart] = useState(0);
  const imageLoadSequence = useRef(0);

  const selectedImageIds = useMemo(
    () => Array.from(new Set(selectedAssets.filter((asset) => asset.type === 'image').map((asset) => asset.id))),
    [selectedAssets],
  );
  const currentAssetIdSet = useMemo(() => new Set(currentAssetIds), [currentAssetIds]);
  const albumById = useMemo(() => new Map(albums.map((album) => [album.id, album])), [albums]);
  const selectedAlbum = selectedAlbumId ? albumById.get(selectedAlbumId) ?? null : null;
  const visibleAlbums = albums.slice(0, visibleAlbumCount);
  const visibleImages = albumImages.slice(0, visibleImageCount);
  const availableCount = visibleImages.filter((image) => image.asset).length;
  const unavailableCount = visibleImages.length - availableCount;

  const loadAlbums = useCallback(async () => {
    setAlbumsLoading(true);
    setAlbumsError(null);
    try {
      const res = await fetch('/api/reference-albums?scope=mine', { cache: 'no-store' });
      const data = await readJsonResponse<AlbumListResponse>(res, { invalidJsonMessage: ALBUMS_INVALID_JSON });
      if (!res.ok) throw new Error(apiError(data, '私人图集读取失败'));
      const privateAlbums = (data.albums || []).filter((album) => (
        album.album_type === 'personal' && album.visibility === 'private' && album.status === 'active'
      ));
      setAlbums(privateAlbums);
      setVisibleAlbumCount(PAGE_SIZE);
      setTargetAlbumId((current) => (
        privateAlbums.some((album) => album.id === current) ? current : privateAlbums[0]?.id || ''
      ));
    } catch (error) {
      setAlbumsError(error instanceof Error ? error.message : '私人图集读取失败');
    } finally {
      setAlbumsLoading(false);
    }
  }, []);

  const resolveAlbumImagePage = useCallback(async (images: AlbumImageSelection[], start: number, sequence: number) => {
    const page = images.slice(start, start + PAGE_SIZE);
    const assetIds = Array.from(new Set(page.map((image) => image.assetId).filter((id): id is string => Boolean(id))));
    const ownedAssets = new Map<string, HistoryAsset>();

    if (assetIds.length > 0) {
      const params = new URLSearchParams({ assetIds: assetIds.join(',') });
      const res = await fetch(`/api/assets/history?${params.toString()}`, { cache: 'no-store' });
      const data = await readJsonResponse<HistoryResponse>(res, { invalidJsonMessage: HISTORY_INVALID_JSON });
      if (!res.ok) throw new Error(apiError(data, '本人图片素材核对失败'));
      if (sequence !== imageLoadSequence.current) return false;

      const requestedIds = new Set(assetIds);
      for (const asset of data.assets || []) {
        if (requestedIds.has(asset.id) && asset.type === 'image' && asset.originalUrl?.trim()) {
          ownedAssets.set(asset.id, asset);
        }
      }
    }

    if (sequence !== imageLoadSequence.current) return false;
    const pageReferenceIds = new Set(page.map((image) => image.referenceId));
    setAlbumImages((current) => current.map((image) => pageReferenceIds.has(image.referenceId)
      ? { ...image, asset: image.assetId ? ownedAssets.get(image.assetId) ?? null : null }
      : image));
    return true;
  }, []);

  const loadAlbumImages = useCallback(async (albumId: string) => {
    const sequence = ++imageLoadSequence.current;
    setSelectedAlbumId(albumId);
    setAlbumImages([]);
    setVisibleImageCount(0);
    setImagePageStart(0);
    setAlbumImagesLoading(true);
    setAlbumImagesError(null);
    setActionError(null);
    setActionMessage(null);

    try {
      const res = await fetch(`/api/reference-albums/${albumId}/images`, { cache: 'no-store' });
      const data = await readJsonResponse<AlbumImagesResponse>(res, { invalidJsonMessage: ALBUMS_INVALID_JSON });
      if (!res.ok) throw new Error(apiError(data, '图集图片读取失败'));
      if (sequence !== imageLoadSequence.current) return;

      const images = (data.images || []).map((image) => ({
        referenceId: image.id,
        assetId: image.asset_id && image.asset?.id === image.asset_id && image.asset.type === 'image' ? image.asset_id : null,
        asset: null,
      }));
      setAlbumImages(images);
      const resolved = await resolveAlbumImagePage(images, 0, sequence);
      if (resolved && sequence === imageLoadSequence.current) setVisibleImageCount(Math.min(PAGE_SIZE, images.length));
    } catch (error) {
      if (sequence !== imageLoadSequence.current) return;
      setAlbumImagesError(error instanceof Error ? error.message : '图集图片读取失败');
    } finally {
      if (sequence === imageLoadSequence.current) setAlbumImagesLoading(false);
    }
  }, [resolveAlbumImagePage]);

  const resolveNextImagePage = useCallback(async (start: number) => {
    if (!selectedAlbumId || albumImagesLoading) return;
    const sequence = ++imageLoadSequence.current;
    setImagePageStart(start);
    setAlbumImagesLoading(true);
    setAlbumImagesError(null);
    try {
      const resolved = await resolveAlbumImagePage(albumImages, start, sequence);
      if (resolved && sequence === imageLoadSequence.current) {
        setVisibleImageCount(Math.min(start + PAGE_SIZE, albumImages.length));
      }
    } catch (error) {
      if (sequence === imageLoadSequence.current) setAlbumImagesError(error instanceof Error ? error.message : '本人图片素材核对失败');
    } finally {
      if (sequence === imageLoadSequence.current) setAlbumImagesLoading(false);
    }
  }, [albumImages, albumImagesLoading, resolveAlbumImagePage, selectedAlbumId]);

  useEffect(() => {
    void loadAlbums();
    return () => { imageLoadSequence.current += 1; };
  }, [loadAlbums]);

  const postAssetsToAlbum = async (albumId: string, assetIds: string[]) => {
    const existingRes = await fetch(`/api/reference-albums/${albumId}/images`, { cache: 'no-store' });
    const existingData = await readJsonResponse<AlbumImagesResponse>(existingRes, { invalidJsonMessage: ALBUMS_INVALID_JSON });
    if (!existingRes.ok) throw new Error(apiError(existingData, '无法读取图集现有图片，请重试'));

    const existingAssetIds = new Set((existingData.images || []).map((image) => image.asset_id).filter(Boolean));
    const pendingAssetIds = Array.from(new Set(assetIds)).filter((id) => !existingAssetIds.has(id));
    if (pendingAssetIds.length === 0) return 0;

    const res = await fetch(`/api/reference-albums/${albumId}/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset_ids: pendingAssetIds }),
    });
    const data = await readJsonResponse<AttachAssetsResponse>(res, { invalidJsonMessage: ALBUMS_INVALID_JSON });
    if (!res.ok) throw new Error(apiError(data, '图片加入图集失败'));
    return data.images?.length ?? pendingAssetIds.length;
  };

  const updateAlbumCount = (albumId: string, addedCount: number) => {
    if (addedCount <= 0) return;
    setAlbums((current) => current.map((album) => (
      album.id === albumId ? { ...album, image_count: (album.image_count || 0) + addedCount } : album
    )));
  };

  const finishAttach = async (albumId: string, addedCount: number) => {
    updateAlbumCount(albumId, addedCount);
    setRetryExistingAlbumId(null);
    setActionMessage(addedCount > 0 ? `已加入 ${addedCount} 张图片。` : '所选图片已在这个图集中。');
    setActionError(null);
    if (selectedAlbumId === albumId) await loadAlbumImages(albumId);
  };

  const handleAttachSelected = async () => {
    if (!targetAlbumId || selectedImageIds.length === 0 || busy) return;
    setBusy('attach');
    setActionError(null);
    setActionMessage(null);
    try {
      const addedCount = await postAssetsToAlbum(targetAlbumId, selectedImageIds);
      await finishAttach(targetAlbumId, addedCount);
    } catch (error) {
      setRetryExistingAlbumId(targetAlbumId);
      setActionError(error instanceof Error ? error.message : '图片加入图集失败');
    } finally {
      setBusy(null);
    }
  };

  const handleRetryCreatedAttach = async () => {
    if (!retryCreatedAlbumId || selectedImageIds.length === 0 || busy) return;
    setBusy('attach');
    setActionError(null);
    setActionMessage(null);
    try {
      const addedCount = await postAssetsToAlbum(retryCreatedAlbumId, selectedImageIds);
      updateAlbumCount(retryCreatedAlbumId, addedCount);
      setRetryCreatedAlbumId(null);
      setNewAlbumName('');
      setActionMessage(addedCount > 0 ? `图集已补入 ${addedCount} 张图片。` : '所选图片已在这个图集中。');
      if (selectedAlbumId === retryCreatedAlbumId) await loadAlbumImages(retryCreatedAlbumId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '图片加入图集失败');
    } finally {
      setBusy(null);
    }
  };

  const handleCreateAlbum = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newAlbumName.trim();
    if (!name || busy) return;
    setBusy('create');
    setCreateFailed(false);
    setActionError(null);
    setActionMessage(null);
    setRetryExistingAlbumId(null);
    let createdAlbumId: string | null = null;

    try {
      const res = await fetch('/api/reference-albums', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, album_type: 'personal' }),
      });
      const data = await readJsonResponse<CreateAlbumResponse>(res, { invalidJsonMessage: ALBUMS_INVALID_JSON });
      if (!res.ok || !data.album) throw new Error(apiError(data, '私人图集创建失败'));
      if (data.album.album_type !== 'personal' || data.album.visibility !== 'private') {
        throw new Error('服务返回的图集不是私人图集，本次没有加入任何图片。');
      }

      createdAlbumId = data.album.id;
      const createdAlbum = { ...data.album, image_count: Number(data.album.image_count || 0) };
      setAlbums((current) => [createdAlbum, ...current.filter((album) => album.id !== createdAlbum.id)]);
      setTargetAlbumId(data.album.id);
      setSelectedAlbumId(data.album.id);

      if (selectedImageIds.length > 0) {
        setBusy('attach');
        try {
          const addedCount = await postAssetsToAlbum(createdAlbum.id, selectedImageIds);
          updateAlbumCount(createdAlbum.id, addedCount);
          setActionMessage(`私人图集已创建${addedCount > 0 ? `并加入 ${addedCount} 张图片` : ''}。`);
        } catch (error) {
          setRetryCreatedAlbumId(createdAlbum.id);
          throw error;
        }
      } else {
        setActionMessage('私人图集已创建。');
      }

      setNewAlbumName('');
      setRetryCreatedAlbumId(null);
      void loadAlbumImages(createdAlbum.id);
    } catch (error) {
      if (!createdAlbumId) setCreateFailed(true);
      setActionError(error instanceof Error ? error.message : '私人图集创建失败');
    } finally {
      setBusy(null);
    }
  };

  const reachedSelectionLimit = maxSelection !== undefined && selectedAssetIds.length >= maxSelection;

  return (
    <div className={styles.root}>
      {retryCreatedAlbumId && selectedImageIds.length > 0 && (
        <div className={styles.retryRow}>
          <span>图集已创建，但图片未全部加入。已选内容仍保留。</span>
          <button type="button" onClick={() => { void handleRetryCreatedAttach(); }} disabled={busy !== null}>
            <RefreshCw size={14} />重试加入图片
          </button>
        </div>
      )}
      {actionError && <p className={styles.errorText} role="alert">{actionError}</p>}
      {actionMessage && <p className={styles.successText} role="status">{actionMessage}</p>}
      {selectedAlbum ? (
        <>
          <header className={styles.detailHeader}>
            <button type="button" className={styles.backButton} onClick={() => {
              imageLoadSequence.current++;
              setAlbumImagesLoading(false);
              setSelectedAlbumId(null);
            }}>
              <ArrowLeft size={16} />
              返回图集
            </button>
            <div className={styles.detailTitle}>
              <FolderOpen size={18} aria-hidden="true" />
              <strong>{selectedAlbum.name}</strong>
              <span>私人图集</span>
            </div>
            <a className={styles.manageLink} href={`/collections/${selectedAlbum.id}`} target="_blank" rel="noreferrer">
              管理图集
            </a>
          </header>

          {albumImagesError && (
            <div className={styles.error} role="alert">
              <span>{albumImagesError} 已保留当前选择。</span>
              <button type="button" onClick={() => {
                if (albumImages.length > 0) void resolveNextImagePage(imagePageStart);
                else void loadAlbumImages(selectedAlbum.id);
              }} disabled={albumImagesLoading}>
                <RefreshCw size={14} />重试读取
              </button>
            </div>
          )}

          {albumImagesLoading && visibleImageCount === 0 ? (
            <div className={styles.status} role="status">正在读取图集并核对本人图片素材…</div>
          ) : albumImagesError && visibleImageCount === 0 ? (
            <div className={styles.status}>图集图片未能读取，当前选择未变。可使用上方按钮重试。</div>
          ) : retryCreatedAlbumId === selectedAlbum.id ? (
            <div className={styles.status}>图片加入尚未完成。重试时会先检查图集现有图片，避免重复加入。</div>
          ) : albumImages.length === 0 ? (
            <div className={styles.empty}>
              <strong>这个图集还没有图片</strong>
              <span>返回素材列表，勾选图片后可加入此图集。</span>
            </div>
          ) : (
            <>
              {albumImagesLoading && <div className={styles.status} role="status">正在核对下一批图片…</div>}
              <div className={styles.imageSummary}>
                <span>当前已核对 {visibleImages.length} 张：{availableCount} 张可选</span>
                {unavailableCount > 0 && <span>{unavailableCount} 张不可选：未关联到可用的本人图片素材</span>}
              </div>
              <div className={styles.imageGrid}>
                {visibleImages.map(({ referenceId, asset }) => {
                  if (!asset) {
                    return (
                      <article key={referenceId} className={`${styles.imageItem} ${styles.unavailableItem}`}>
                        <div className={styles.unavailableMedia}>不可用</div>
                        <span>未关联到可用的本人图片素材</span>
                      </article>
                    );
                  }

                  const selected = selectedAssetIds.includes(asset.id);
                  const alreadyInParent = currentAssetIdSet.has(asset.id);
                  const limitBlocked = !selected && !alreadyInParent && reachedSelectionLimit;
                  return (
                    <article key={referenceId} className={`${styles.imageItem} ${selected ? styles.selected : ''} ${alreadyInParent ? styles.inParent : ''}`}>
                      <button
                        type="button"
                        className={styles.imageToggle}
                        onClick={() => onToggleAsset(asset)}
                        disabled={alreadyInParent || limitBlocked}
                        aria-pressed={selected}
                        title={alreadyInParent ? '已在主控图片中' : limitBlocked ? '已达到可选上限' : selected ? '取消选择' : '选择图片'}
                      >
                        <AlbumImagePreview asset={asset} />
                        <span>{alreadyInParent ? '已在主控中' : selected ? '已选择' : '选择'}</span>
                      </button>
                      <strong title={asset.fileName || undefined}>{asset.fileName || '未命名图片'}</strong>
                    </article>
                  );
                })}
              </div>
              {albumImages.length > visibleImageCount && (
                <button type="button" className={styles.loadMore} onClick={() => { void resolveNextImagePage(visibleImageCount); }} disabled={albumImagesLoading}>
                  {albumImagesLoading ? '核对中…' : '加载更多图片'}
                </button>
              )}
              {reachedSelectionLimit && maxSelection !== undefined && (
                <p className={styles.selectionHint}>已达到本次可选上限：{maxSelection} 张。</p>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <div className={styles.tools}>
            <form className={styles.createForm} onSubmit={(event) => { void handleCreateAlbum(event); }}>
              <h4>新建私人图集</h4>
              <label>
                <span>图集名称</span>
                <input
                  value={newAlbumName}
                  onChange={(event) => { setNewAlbumName(event.target.value); setCreateFailed(false); }}
                  maxLength={80}
                  placeholder="例如：角色参考图"
                  disabled={busy !== null}
                />
              </label>
              <button type="submit" className={styles.primaryButton} disabled={!newAlbumName.trim() || busy !== null}>
                <FolderOpen size={15} />
                {busy === 'create' ? '创建中…' : createFailed ? '重试创建' : selectedImageIds.length ? `创建并加入 ${selectedImageIds.length} 张` : '创建图集'}
              </button>
            </form>

            <div className={styles.addForm}>
              <h4>把已选图片加入图集</h4>
              {selectedImageIds.length === 0 ? (
                <p>先从素材列表勾选图片，再选择目标图集。</p>
              ) : (
                <>
                  <label>
                    <span>目标图集</span>
                    <select value={targetAlbumId} onChange={(event) => setTargetAlbumId(event.target.value)} disabled={busy !== null || albums.length === 0}>
                      <option value="">请选择私人图集</option>
                      {albums.map((album) => <option key={album.id} value={album.id}>{album.name}</option>)}
                    </select>
                  </label>
                  <button type="button" className={styles.primaryButton} onClick={() => { void handleAttachSelected(); }} disabled={!targetAlbumId || busy !== null}>
                    <FolderOpen size={15} />
                    {busy === 'attach' && retryExistingAlbumId === targetAlbumId ? '正在重试…' : retryExistingAlbumId === targetAlbumId ? '重试加入已选图片' : `加入已选 ${selectedImageIds.length} 张`}
                  </button>
                </>
              )}
            </div>
          </div>

          {albumsError && (
            <div className={styles.error} role="alert">
              <span>{albumsError} 已保留当前选择。</span>
              <button type="button" onClick={() => { void loadAlbums(); }} disabled={albumsLoading}>
                <RefreshCw size={14} />重试读取
              </button>
            </div>
          )}
          {albumsLoading && albums.length === 0 ? (
            <div className={styles.status} role="status">正在读取私人图集…</div>
          ) : albumsError && albums.length === 0 ? (
            <div className={styles.status}>图集尚未读取，请使用上方按钮重试。</div>
          ) : albums.length === 0 ? (
            <div className={styles.empty}>
              <strong>还没有私人图集</strong>
              <span>创建图集后，可加入已选图片，也能从图集中选择图片。</span>
            </div>
          ) : (
            <div className={styles.albumList}>
              {visibleAlbums.map((album) => (
                <div className={styles.albumRow} key={album.id}>
                  <button type="button" className={styles.albumOpen} onClick={() => { void loadAlbumImages(album.id); }}>
                    <FolderOpen size={17} aria-hidden="true" />
                    <span className={styles.albumName}>{album.name}</span>
                    <span className={styles.albumCount}>{album.image_count || 0} 张</span>
                  </button>
                  <a href={`/collections/${album.id}`} target="_blank" rel="noreferrer">管理图集</a>
                </div>
              ))}
              {albums.length > visibleAlbumCount && (
                <button type="button" className={styles.loadMore} onClick={() => setVisibleAlbumCount((count) => count + PAGE_SIZE)}>
                  加载更多图集
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
