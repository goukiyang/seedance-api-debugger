'use client';
import { useProductDialog } from '@/components/useProductDialog';
import ContentReactions from '@/components/content-reactions/ContentReactions';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye } from 'lucide-react';
import PageBanner from '@/components/PageBanner';
import MediaPreview from '@/components/MediaPreview';
import ShareAlbumDialog, { type ShareAlbumDialogAlbum } from '@/components/ShareAlbumDialog';
import { UploadProgressIndicator } from '@/components/UploadProgressIndicator';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { uploadFileAsAsset } from '@/lib/http/file-upload';
import { UploadedImagePicker } from '@/components/UploadedImagePicker';
import type { PickerItem } from '@/lib/assets/picker-types';
import styles from '../ReferenceAlbumsClient.module.css';

interface AlbumDetail {
  id: string;
  name: string;
  description: string | null;
  album_type: string;
  project_id: string | null;
  visibility: string;
  cover_image_id: string | null;
  cover_image_url: string | null;
  status: string;
  image_count: number;
  owner?: { id?: string; name: string | null; username: string | null; email?: string | null; avatar_url?: string | null; account_type?: string | null };
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
  asset?: {
    file_name: string;
    type?: string | null;
    mime_type?: string | null;
    file_size?: number | null;
    width: number | null;
    height: number | null;
  } | null;
}

type AlbumUploadFeedback = {
  type: 'info' | 'success';
  message: string;
};

type AlbumUploadProgress = {
  label: string;
  detail: string;
  percent?: number;
};

type AlbumUploadResponse = {
  images?: ReferenceImageItem[];
  error?: string;
  message?: string;
};

type PendingAlbumAttach = {
  assetIds: string[];
  fileNames: string[];
};

const GENERATION_ALBUM_SELECTION_LIMIT = 9;
const RETURN_SCOPES = new Set(['mine', 'project', 'other_project', 'shared', 'public', 'all']);

function isReturnId(value: string | null): value is string {
  return Boolean(value && /^[a-zA-Z0-9_-]{1,128}$/.test(value));
}

function localReturnUrl(value: string | null | undefined) {
  if (!value || value.length > 8192 || !value.startsWith('/') || value.startsWith('//')
    || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value, 'https://collections.invalid');
    return url.origin === 'https://collections.invalid' ? url : null;
  } catch { return null; }
}

function safeProjectReturn(value: string | null, expectedProjectId?: string | null) {
  const url = localReturnUrl(value);
  if (!url) return null;
  if (url.pathname === '/projects' && !expectedProjectId) return `${url.pathname}${url.search}${url.hash}`;
  const match = /^\/projects\/([a-zA-Z0-9_-]{1,128})$/.exec(url.pathname);
  if (!match || (expectedProjectId && match[1] !== expectedProjectId)) return null;
  const nested = url.searchParams.get('return_to');
  if (nested) {
    const parent = localReturnUrl(nested);
    if (!parent || parent.pathname !== '/projects') url.searchParams.delete('return_to');
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function albumReturnContext(value: string | null | undefined) {
  const fallback = { href: '/collections', label: '返回参考图集', projectHref: null as string | null };
  const url = localReturnUrl(value);
  if (!url) return fallback;
  if (url.pathname !== '/collections') {
    const projectHref = safeProjectReturn(value || null);
    return projectHref && /^\/projects\//.test(projectHref)
      ? { href: projectHref, label: '返回原项目', projectHref: null } : fallback;
  }
  const params = new URLSearchParams();
  const scope = url.searchParams.get('scope');
  if (scope && !RETURN_SCOPES.has(scope)) return fallback;
  if (scope) params.set('scope', scope);
  const projectId = url.searchParams.get('project_id');
  if (projectId && projectId !== 'all') {
    if (!isReturnId(projectId) || (scope !== 'project' && scope !== 'other_project')) return fallback;
    params.set('project_id', projectId);
  }
  const folderId = url.searchParams.get('public_folder_id');
  if (folderId && (folderId === 'all' || isReturnId(folderId))) params.set('public_folder_id', folderId);
  const page = url.searchParams.get('page');
  if (page && /^\d+$/.test(page) && Number.isSafeInteger(Number(page)) && Number(page) >= 1 && Number(page) <= 100_000) params.set('page', page);
  const anchor = url.searchParams.get('anchor');
  if (isReturnId(anchor)) params.set('anchor', anchor);
  const projectHref = safeProjectReturn(url.searchParams.get('return_to'), isReturnId(projectId) ? projectId : undefined);
  if (projectHref) params.set('return_to', projectHref);
  const query = params.toString();
  return { href: `/collections${query ? `?${query}` : ''}`, label: '返回原图集列表', projectHref };
}

function mediaTypeLabel(type: string | null | undefined) {
  if (type === 'video') return '视频';
  if (type === 'audio') return '音频';
  return '图片';
}

function isImageItem(image: ReferenceImageItem) {
  return !image.asset?.type || image.asset.type === 'image';
}

function AlbumDetailThumbnail({ image, alt }: { image: ReferenceImageItem; alt: string }) {
  const [failed, setFailed] = useState(false);
  const src = isImageItem(image) ? `/api/reference-images/${encodeURIComponent(image.id)}/content?variant=thumbnail` : image.thumbnail_url;
  useEffect(() => setFailed(false), [src]);
  if (failed || !src) return <div className="album-image-media-placeholder">暂无封面</div>;
  return <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
}

export default function ReferenceAlbumDetailClient({ albumId, returnTo }: { albumId: string; returnTo?: string | null }) {
  const { confirm, prompt, productDialog } = useProductDialog();
  const { user, hasLoadedUser, userLoadError, sessionChanged, refreshUser } = useAppSession();
  const accountId = !userLoadError && !sessionChanged ? user?.id || '' : '';
  const contextKey = `${accountId}:${albumId}`;
  const contextRef = useRef({ key: contextKey, epoch: 0 });
  if (contextRef.current.key !== contextKey) contextRef.current = { key: contextKey, epoch: contextRef.current.epoch + 1 };
  const isCurrent = useCallback((epoch: number) => contextRef.current.epoch === epoch, []);
  const aliveRef = useRef(true);
  const returnContext = albumReturnContext(returnTo);
  const [album, setAlbum] = useState<AlbumDetail | null>(null);
  const [loadedContextKey, setLoadedContextKey] = useState('');
  const [images, setImages] = useState<ReferenceImageItem[]>([]);
  const [selectedImageIds, setSelectedImageIds] = useState<string[]>([]);
  const [previewImage, setPreviewImage] = useState<ReferenceImageItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadFeedback, setUploadFeedback] = useState<AlbumUploadFeedback | null>(null);
  const [uploadProgress, setUploadProgress] = useState<AlbumUploadProgress | null>(null);
  const [pendingAlbumAttach, setPendingAlbumAttach] = useState<PendingAlbumAttach | null>(null);
  const [loading, setLoading] = useState(false);
  const [shareDialogAlbum, setShareDialogAlbum] = useState<ShareAlbumDialogAlbum | null>(null);
  const [sharingImageId, setSharingImageId] = useState<string | null>(null);

  useEffect(() => {
    if (!hasLoadedUser) void refreshUser();
  }, [hasLoadedUser, refreshUser]);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; contextRef.current.epoch += 1; };
  }, []);

  useEffect(() => {
    setAlbum(null);
    setImages([]);
    setLoadedContextKey('');
    setSelectedImageIds([]);
    setPreviewImage(null);
    setPendingAlbumAttach(null);
    setShareDialogAlbum(null);
    setSharingImageId(null);
    setUploadFeedback(null);
    setUploadProgress(null);
    setError(null);
    setLoading(false);
  }, [contextKey]);

  const loadAlbum = useCallback(async () => {
    if (!accountId || contextRef.current.key !== contextKey || !aliveRef.current) return null;
    const epoch = contextRef.current.epoch;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/reference-albums/${encodeURIComponent(albumId)}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!aliveRef.current || !isCurrent(epoch)) return null;
      if (!res.ok) {
        if ([401, 403, 404].includes(res.status)) {
          setAlbum(null);
          setImages([]);
          setSelectedImageIds([]);
          setPreviewImage(null);
          setShareDialogAlbum(null);
          setLoadedContextKey('');
        }
        throw new Error(data.error || data.message || '图集读取失败');
      }
      if (data.album?.id !== albumId) throw new Error('图集读取未能确认，请重试。');
      setAlbum(data.album);
      setLoadedContextKey(contextKey);
      setImages(data.images || []);
      return data;
    } catch (err) {
      if (aliveRef.current && isCurrent(epoch)) setError(err instanceof Error ? err.message : '图集读取失败');
      throw err;
    } finally {
      if (aliveRef.current && isCurrent(epoch)) setLoading(false);
    }
  }, [accountId, albumId, contextKey, isCurrent]);

  useEffect(() => {
    void loadAlbum().catch(() => {});
  }, [loadAlbum]);

  const attachAssetsToAlbum = useCallback(async (assetIds: string[], fileNames: string[]) => {
    if (!accountId || contextRef.current.key !== contextKey || !aliveRef.current) throw new Error('图集或账号已切换，未向新目标加入素材。');
    const res = await fetch(`/api/reference-albums/${albumId}/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assetIds,
        source_type: 'upload',
        metadata_json: {
          source: 'album_asset_upload',
          original_file_names: fileNames,
        },
      }),
    });
    const data = await res.json().catch(() => ({})) as AlbumUploadResponse;
    if (!res.ok) throw new Error(data.error || data.message || '保存到图集失败');
    return data;
  }, [accountId, albumId, contextKey]);

  const finishAlbumAttach = useCallback(async (assetIds: string[], fileNames: string[], expectedCount: number) => {
    if (contextRef.current.key !== contextKey || !aliveRef.current) return;
    const epoch = contextRef.current.epoch;
    setUploadProgress({ label: '正在加入图集', detail: `${assetIds.length} 个素材` });
    let addData: AlbumUploadResponse;
    try {
      addData = await attachAssetsToAlbum(assetIds, fileNames);
    } catch (err) {
      if (!aliveRef.current || !isCurrent(epoch)) return;
      setPendingAlbumAttach({ assetIds, fileNames });
      const reason = err instanceof Error ? err.message : '保存到图集失败';
      throw new Error(`素材已上传成功，但加入图集失败：${reason}`);
    }
    if (!aliveRef.current || !isCurrent(epoch)) return;
    const uploadedCount = Array.isArray(addData.images) ? addData.images.length : expectedCount;
    setUploadProgress(null);
    setUploadFeedback({ type: 'info', message: '上传成功，正在刷新图集列表...' });
    await loadAlbum();
    if (!aliveRef.current || !isCurrent(epoch)) return;
    setPendingAlbumAttach(null);
    setUploadFeedback({ type: 'success', message: `已上传 ${uploadedCount} 个素材到图集。` });
  }, [attachAssetsToAlbum, contextKey, isCurrent, loadAlbum]);

  // Files are found or uploaded in the shared picker (project rule, 2026-10-25); picked assets join this album.
  const [pickerOpen, setPickerOpen] = useState(false);
  const addFromPicker = async (items: PickerItem[]) => {
    const picked = items.filter(item => item.assetId);
    if (!picked.length) return { success: false, message: '请选择要加入图集的素材' };
    const epoch = contextRef.current.epoch;
    setLoading(true); setError(null); setPendingAlbumAttach(null);
    try {
      await finishAlbumAttach(picked.map(item => item.assetId!), picked.map(item => item.fileName || 'upload.bin'), picked.length);
      if (aliveRef.current && isCurrent(epoch)) setPickerOpen(false);
      return { success: true };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : '加入图集失败' };
    } finally {
      if (aliveRef.current && isCurrent(epoch)) { setUploadProgress(null); setLoading(false); }
    }
  };

  const handleRetryAlbumAttach = async () => {
    if (!pendingAlbumAttach) return;
    const epoch = contextRef.current.epoch;
    setLoading(true);
    setError(null);
    setUploadFeedback({ type: 'info', message: '正在把已上传素材重新加入图集...' });
    try {
      await finishAlbumAttach(
        pendingAlbumAttach.assetIds,
        pendingAlbumAttach.fileNames,
        pendingAlbumAttach.assetIds.length,
      );
    } catch (err) {
      if (aliveRef.current && isCurrent(epoch)) {
        setError(err instanceof Error ? err.message : '加入图集失败');
        setUploadFeedback(null);
      }
    } finally {
      if (aliveRef.current && isCurrent(epoch)) { setUploadProgress(null); setLoading(false); }
    }
  };

  const handleUseForGeneration = async () => {
    if (selectedImageIds.length === 0) return;
    const epoch = contextRef.current.epoch;
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
      if (!aliveRef.current || !isCurrent(epoch)) return;
      if (!res.ok) throw new Error(data.error || data.message || '加入生成工作台失败');
      window.location.href = '/generate';
    } catch (err) {
      if (aliveRef.current && isCurrent(epoch)) setError(err instanceof Error ? err.message : '加入生成工作台失败');
    } finally {
      if (aliveRef.current && isCurrent(epoch)) setLoading(false);
    }
  };

  const toggleGenerationSelection = (imageId: string) => {
    if (selectedImageIds.includes(imageId)) {
      setSelectedImageIds(selectedImageIds.filter((id) => id !== imageId));
      setError(null);
      return;
    }
    if (selectedImageIds.length >= GENERATION_ALBUM_SELECTION_LIMIT) {
      setError(`一次最多选择 ${GENERATION_ALBUM_SELECTION_LIMIT} 个素材。请先取消一项再继续。`);
      return;
    }
    setSelectedImageIds([...selectedImageIds, imageId]);
    setError(null);
  };

  const handleDeleteImage = async (imageId: string) => {
    const epoch = contextRef.current.epoch;
    if (!await confirm('删除后历史任务仍会保留引用，新生成不能再使用。确定删除？', { title: '删除参考图', confirmLabel: '删除', danger: true })) return;
    if (!aliveRef.current || !isCurrent(epoch)) return;
    const res = await fetch(`/api/reference-images/${imageId}`, { method: 'DELETE' });
    if (!aliveRef.current || !isCurrent(epoch)) return;
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || data.message || '删除失败');
      return;
    }
    setSelectedImageIds((prev) => prev.filter((id) => id !== imageId));
    void loadAlbum().catch(() => {});
  };

  const handleShareSingleImage = async (image: ReferenceImageItem) => {
    const epoch = contextRef.current.epoch;
    setSharingImageId(image.id);
    setError(null);
    try {
      const res = await fetch(`/api/reference-images/${image.id}/share-album`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: image.asset?.file_name ? `单素材共享 - ${image.asset.file_name}` : `单素材共享 - ${mediaTypeLabel(image.asset?.type)} ${image.sort_order + 1}`,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!aliveRef.current || !isCurrent(epoch)) return;
      if (!res.ok) throw new Error(data.error || data.message || '单素材共享创建失败');
      setShareDialogAlbum(data.album);
    } catch (err) {
      if (aliveRef.current && isCurrent(epoch)) setError(err instanceof Error ? err.message : '单素材共享创建失败');
    } finally {
      if (aliveRef.current && isCurrent(epoch)) setSharingImageId(null);
    }
  };

  const handleRenameAlbum = async () => {
    if (!album) return;
    const epoch = contextRef.current.epoch;
    const nextName = (await prompt('输入新的图集名称', album.name, { title: '图集名称', maxLength: null }))?.trim();
    if (!aliveRef.current || !isCurrent(epoch) || !nextName || nextName === album.name) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/reference-albums/${album.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nextName }),
      });
      const data = await res.json();
      if (!aliveRef.current || !isCurrent(epoch)) return;
      if (!res.ok) throw new Error(data.error || data.message || '重命名失败');
      setAlbum((current) => current ? { ...current, name: data.album?.name || nextName } : current);
    } catch (err) {
      if (aliveRef.current && isCurrent(epoch)) setError(err instanceof Error ? err.message : '重命名失败');
    } finally {
      if (aliveRef.current && isCurrent(epoch)) setLoading(false);
    }
  };

  const handleDeleteAlbum = async () => {
    if (!album) return;
    const epoch = contextRef.current.epoch;
    const backHref = returnContext.href;
    const confirmed = await confirm(`删除图集「${album.name}」？图集会从列表隐藏，历史任务引用的参考图仍会保留。`, { title: '删除图集', confirmLabel: '删除图集', danger: true });
    if (!aliveRef.current || !isCurrent(epoch) || !confirmed) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/reference-albums/${album.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!aliveRef.current || !isCurrent(epoch)) return;
      if (!res.ok) throw new Error(data.error || data.message || '删除图集失败');
      window.location.assign(backHref);
    } catch (err) {
      if (aliveRef.current && isCurrent(epoch)) {
        setError(err instanceof Error ? err.message : '删除图集失败');
        setLoading(false);
      }
    }
  };

  if (!accountId) return <div className={styles.notice} role="status">
    {userLoadError || (sessionChanged ? '登录账号已变化，请重新确认后查看图集。' : hasLoadedUser ? '请先登录后查看图集。' : '正在确认登录状态...')}
    {userLoadError && <button type="button" onClick={() => void refreshUser({ force: true })}>重新读取</button>}
  </div>;

  if (album && loadedContextKey !== contextKey) return <div className={styles.notice} role="status">正在读取当前图集...</div>;
  const albumProjectId = album?.project_id || null;
  const projectHref = returnContext.projectHref || (!returnTo && isReturnId(albumProjectId)
    ? `/projects/${encodeURIComponent(albumProjectId)}?view=albums` : null);

  return (
    <div>
      {productDialog}
      <PageBanner
        backHref={returnContext.href}
        backLabel={returnContext.label}
        eyebrow="图集详情"
        title={album?.name || '参考图集'}
        description={album?.description || '图集素材会继承图集权限；取消共享后，被授权用户不能继续访问或使用。'}
        actions={projectHref && projectHref !== returnContext.href ? <Link className="btn btn-secondary" href={projectHref}>返回原项目</Link> : undefined}
      />

      {loading && !album && <div className={styles.notice} role="status">读取中...</div>}
      {error && <div className={styles.notice} role="status">{error}</div>}
      {uploadFeedback && !error && (
        <div className={`album-error ${uploadFeedback.type}`}>{uploadFeedback.message}</div>
      )}
      {uploadProgress && !error && (
        <UploadProgressIndicator
          label={uploadProgress.label}
          detail={uploadProgress.detail}
          percent={uploadProgress.percent}
          variant="light"
          className="album-upload-progress"
        />
      )}
      {pendingAlbumAttach && (
        <div className="album-upload-retry">
          <button type="button" onClick={handleRetryAlbumAttach} disabled={loading}>
            {loading ? '正在重试...' : `重试加入图集（${pendingAlbumAttach.assetIds.length} 个）`}
          </button>
        </div>
      )}

      {album && (
        <>
          <div className="album-detail-summary">
            <span>{album.image_count} 个素材</span>
            <span className="album-detail-owner">
              <span>创建者：</span>
              <UserIdentityBadge user={album.owner} size="sm" avatarOnly />
            </span>
            <span>项目：{album.project?.name || '-'}</span>
            <span>范围：{album.visibility}</span>
            {album.can_share && <span>共享：{album.active_share_count || 0} 个对象</span>}
            <span>权限：{album.permissions.view ? '可查看' : ''} {album.permissions.use ? '可生成' : ''} {album.permissions.edit ? '可编辑' : ''}</span>
            {album.permissions.use && <span>已选用于生成：{selectedImageIds.length}/{GENERATION_ALBUM_SELECTION_LIMIT}，还可选 {Math.max(0, GENERATION_ALBUM_SELECTION_LIMIT - selectedImageIds.length)} 个</span>}
          </div>

          <div className="album-detail-actions">
            {album.permissions.edit && (
              <>
                <button type="button" onClick={() => setPickerOpen(true)} disabled={loading}>
                  {loading && uploadFeedback?.type === 'info' ? '加入处理中...' : '添加素材到图集'}
                </button>
                <button type="button" onClick={handleRenameAlbum} disabled={loading}>重命名图集</button>
                <button type="button" className="danger" onClick={handleDeleteAlbum} disabled={loading}>删除图集</button>
              </>
            )}
            {album.permissions.use && (
              <button type="button" onClick={handleUseForGeneration} disabled={selectedImageIds.length === 0 || loading}>
                作为参考素材生成（{selectedImageIds.length}/{GENERATION_ALBUM_SELECTION_LIMIT}）
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
              <div className="album-empty">暂无素材</div>
            ) : (
              images.map((image) => {
                const selected = selectedImageIds.includes(image.id);
                const typeLabel = mediaTypeLabel(image.asset?.type);
                const canPreviewOriginalMedia = album.permissions.use || album.permissions.download;
                return (
                  <div key={image.id} className={`album-image-card ${selected ? 'selected' : ''}`}>
                    <div className="media-reaction-cover" data-reaction-surface>
                    <button
                      type="button"
                      className="album-image-select"
                      onClick={() => toggleGenerationSelection(image.id)}
                    >
                      {isImageItem(image) || canPreviewOriginalMedia ? (
                        <AlbumDetailThumbnail image={image} alt={image.asset?.file_name || `${typeLabel}封面`} />
                      ) : (
                        <div className="album-image-media-placeholder">{typeLabel}</div>
                      )}
                    </button>
                    <ContentReactions contentKey={`reference_image:${image.id}`} overlay />
                    </div>
                    <div className="album-image-meta">
                      {(isImageItem(image) || canPreviewOriginalMedia) && <button type="button" title={`预览${typeLabel}`} aria-label={`预览${image.asset?.file_name || `${typeLabel} ${image.sort_order + 1}`}`} onClick={() => setPreviewImage(image)}><Eye size={15} /></button>}
                      <span>{typeLabel} {image.sort_order + 1}</span>
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
          {previewImage && <MediaPreview
            src={`/api/reference-images/${encodeURIComponent(previewImage.id)}/content?variant=preview`}
            type={isImageItem(previewImage) ? 'image' : previewImage.asset?.type === 'video' ? 'video' : 'audio'}
            title={previewImage.asset?.file_name || `${mediaTypeLabel(previewImage.asset?.type)} ${previewImage.sort_order + 1}`}
            poster={previewImage.thumbnail_url || undefined}
            contentKey={`reference_image:${previewImage.id}`}
            previewKey={previewImage.id}
            details={<div><span>{mediaTypeLabel(previewImage.asset?.type)}</span>{previewImage.asset?.file_size != null && <span>{previewImage.asset.file_size} 字节</span>}</div>}
            onClose={() => setPreviewImage(null)}
          />}
          <ShareAlbumDialog
            open={Boolean(shareDialogAlbum)}
            album={shareDialogAlbum}
            onClose={() => setShareDialogAlbum(null)}
            onChanged={() => {
              if (shareDialogAlbum?.id === album.id) void loadAlbum().catch(() => {});
            }}
          />

          {pickerOpen && <UploadedImagePicker open target="assets" purpose="album" title="添加素材到图集" confirmLabel="加入图集"
            acceptedTypes={['image', 'video', 'audio']} contextKey={`album:${album.id}`} currentCount={0} currentAssetIds={[]} currentReferenceImageIds={[]}
            onClose={() => setPickerOpen(false)} onUploadFile={(file, onProgress) => uploadFileAsAsset(file, { onProgress })}
            onConfirm={async () => ({ success: false, message: '请选择素材' })} onConfirmSelection={addFromPicker} />}
        </>
      )}
    </div>
  );
}
