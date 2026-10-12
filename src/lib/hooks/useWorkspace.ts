'use client';

/**
 * useWorkspace — Workspace 状态管理 Hook
 * 管理当前 tab 的 workspace、素材列表、拖拽排序
 * P0-1 增强：上传状态追踪、frame 角色设置
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { uploadFileToHistory } from '@/lib/http/file-upload';
import { uploadSession } from '@/lib/http/upload-session';
import { readJsonResponse } from '@/lib/http/json-response';
import type { Workspace, WorkspaceAssetItem, UploadStatus, FrameRole } from '@/types';
import type { UploadProgressHandler } from '@/lib/http/file-upload';

const TAB_ID_KEY = 'workspace_tab_id';
const UPLOAD_INVALID_JSON_MESSAGE = '素材上传服务返回了页面内容，请刷新后重试；如果仍出现，请重新登录。';
const WORKSPACE_INVALID_JSON_MESSAGE = '工作台服务返回了页面内容，请刷新后重试；如果仍出现，请重新登录。';
const REFERENCE_ALBUM_INVALID_JSON_MESSAGE = '图集服务返回了页面内容，请刷新后重试；如果仍出现，请重新登录。';

type ApiMessageResponse = {
  error?: string;
  message?: string;
};

type WorkspaceResponse = ApiMessageResponse & {
  workspace?: Workspace;
};

type ReferenceAlbumDetailResponse = ApiMessageResponse & {
  images?: Array<{ id?: string }>;
};

type ReferenceAlbumCreateResponse = ApiMessageResponse & {
  album?: {
    id?: string;
  };
};

type PromptValidationResponse = {
  valid?: boolean;
  missing?: string[];
};

type PendingWorkspaceAttach = {
  assetIds: string[];
  fileNames: string[];
  statusIds: string[];
};

// File upload and placement are separate operations. Keep the same placement
// receipt after an unknown response so retry never resets an existing role/order.
async function postWorkspaceAssociation(tabId: string, body: Record<string, unknown>) {
  const session = uploadSession();
  if (!session.ownerId) throw new Error('当前账号尚未确认，请重新登录后再加入素材');
  const bytes = new TextEncoder().encode(JSON.stringify([session.ownerId, session.epoch, tabId, body]));
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  const key = `sd2:workspace-association:v1:${digest}`;
  let requestId: string;
  try {
    requestId = sessionStorage.getItem(key) || crypto.randomUUID();
    sessionStorage.setItem(key, requestId);
  } catch { throw new Error('当前浏览器无法保留加入记录，素材未关联；请检查存储设置后重试'); }
  const current = () => { const now = uploadSession(); return now.ownerId === session.ownerId && now.epoch === session.epoch; };
  if (!current()) throw new Error('当前账号已变化，素材未关联');
  const response = await fetch('/api/workspace/assets', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tab-id': tabId, 'x-upload-owner-id': session.ownerId },
    body: JSON.stringify({ ...body, ownerId: session.ownerId, requestId }), signal: AbortSignal.timeout(30000),
  });
  const data = await readJsonResponse<ApiMessageResponse & { association?: { requestId?: string; associated?: boolean } }>(response, { invalidJsonMessage: WORKSPACE_INVALID_JSON_MESSAGE });
  if (!current()) throw new Error('当前账号已变化，原账号的加入结果未写入当前页面');
  if (!response.ok) throw new Error(data.error || data.message || '素材加入结果未确认，请重试原操作；不用重新上传文件');
  if (data.association?.requestId !== requestId || data.association.associated !== true) throw new Error('素材加入回执未确认，请重试原操作；不用重新上传文件');
  try { sessionStorage.removeItem(key); } catch { /* A confirmed receipt is safe to replay. */ }
}

function getOrCreateTabId(): string {
  if (typeof window === 'undefined') return 'default';
  let tabId = sessionStorage.getItem(TAB_ID_KEY);
  if (!tabId) {
    tabId = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sessionStorage.setItem(TAB_ID_KEY, tabId);
  }
  return tabId;
}

export interface UseWorkspaceResult {
  workspace: Workspace | null;
  loading: boolean;
  error: string | null;
  assets: WorkspaceAssetItem[];
  // P0-1: 上传状态映射（assetId -> UploadStatus）
  uploadStatuses: Record<string, UploadStatus>;
  // P0-1: 上传素材（带状态追踪）
  uploadAsset: (file: File, onProgress?: UploadProgressHandler) => Promise<void>;
  uploadAssetToHistory: (file: File, onProgress?: UploadProgressHandler) => Promise<string>;
  pendingWorkspaceAttach: PendingWorkspaceAttach | null;
  retryPendingAttach: () => Promise<void>;
  addAssets: (assetIds: string[]) => Promise<void>;
  addReferenceImages: (referenceImageIds: string[]) => Promise<void>;
  addLibrarySelection: (selection: Array<{ assetId?: string; referenceImageId?: string }>) => Promise<void>;
  loadReferenceAlbum: (albumId: string, maxImages?: number) => Promise<void>;
  saveCurrentAsReferenceAlbum: (name: string) => Promise<string>;
  createReferenceAlbum: (name: string) => Promise<string>;
  clearAssets: () => Promise<void>;
  removeAsset: (assetId: string) => Promise<void>;
  reorderAssets: (newOrder: Array<{ assetId: string; sortOrder: number }>) => Promise<void>;
  validatePrompt: (prompt: string) => Promise<{ valid: boolean; missing: string[] }>;
  refresh: () => Promise<void>;
  // P0-1: 替换素材
  replaceAsset: (assetId: string, file: File, onProgress?: UploadProgressHandler) => Promise<void>;
  // P0-1: 设置 frame 角色
  setAssetFrameRole: (assetId: string, role: FrameRole) => Promise<void>;
}

export function useWorkspace(): UseWorkspaceResult {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const tabIdRef = useRef<string>(getOrCreateTabId());
  // P0-1: 上传状态映射
  const [uploadStatuses, setUploadStatuses] = useState<Record<string, UploadStatus>>({});
  const [pendingWorkspaceAttach, setPendingWorkspaceAttach] = useState<PendingWorkspaceAttach | null>(null);

  const fetchWorkspace = useCallback(async () => {
    try {
      const res = await fetch('/api/workspace', {
        headers: { 'x-tab-id': tabIdRef.current },
      });
      const data = await readJsonResponse<WorkspaceResponse>(res, {
        invalidJsonMessage: WORKSPACE_INVALID_JSON_MESSAGE,
      });
      if (!res.ok) throw new Error(data.error || data.message || '工作台读取失败');
      setWorkspace(data.workspace || null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '工作台读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWorkspace();
  }, [fetchWorkspace]);

  const uploadAssetToHistory = useCallback(async (file: File, onProgress?: UploadProgressHandler) => {
    const asset = await uploadFileToHistory(file, {
      invalidJsonMessage: UPLOAD_INVALID_JSON_MESSAGE,
      onProgress,
    });
    const assetId = asset.id as string | undefined;
    if (!assetId) throw new Error('素材上传成功，但没有返回素材 ID');
    return assetId;
  }, []);

  const attachUploadedAssetsToWorkspace = useCallback(async (assetIds: string[], role?: FrameRole) => {
    await postWorkspaceAssociation(tabIdRef.current, { assetIds, ...(role ? { role } : {}) });
    await fetchWorkspace();
  }, [fetchWorkspace]);

  // P0-1: 上传素材（带状态追踪）
  const uploadAsset = useCallback(async (file: File, onProgress?: UploadProgressHandler) => {
    // 生成临时占位 assetId
    const tempId = `uploading_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setLoading(true);
    setUploadStatuses((prev) => ({ ...prev, [tempId]: 'uploading' }));
    setPendingWorkspaceAttach(null);
    try {
      const assetId = await uploadAssetToHistory(file, onProgress);

      try {
        await attachUploadedAssetsToWorkspace([assetId]);
      } catch (attachError) {
        setPendingWorkspaceAttach({ assetIds: [assetId], fileNames: [file.name || 'upload.bin'], statusIds: [tempId] });
        throw new Error(`素材已上传成功，但加入参考区失败：${attachError instanceof Error ? attachError.message : '加入参考区失败'}`);
      }
      // 成功后移除临时状态
      setUploadStatuses((prev) => {
        const next = { ...prev };
        delete next[tempId];
        return next;
      });
      setPendingWorkspaceAttach(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '素材上传失败');
      // 标记为失败
      setUploadStatuses((prev) => ({ ...prev, [tempId]: 'failed' }));
      setLoading(false);
    }
  }, [attachUploadedAssetsToWorkspace, uploadAssetToHistory]);

  const retryPendingAttach = useCallback(async () => {
    if (!pendingWorkspaceAttach) return;
    setLoading(true);
    setError(null);
    try {
      await attachUploadedAssetsToWorkspace(pendingWorkspaceAttach.assetIds);
      setUploadStatuses((prev) => {
        const next = { ...prev };
        pendingWorkspaceAttach.statusIds.forEach((id) => delete next[id]);
        return next;
      });
      setPendingWorkspaceAttach(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加入参考区失败');
    } finally {
      setLoading(false);
    }
  }, [attachUploadedAssetsToWorkspace, pendingWorkspaceAttach]);

  // P0-1: 替换素材
  const replaceAsset = useCallback(async (assetId: string, file: File, onProgress?: UploadProgressHandler) => {
    setUploadStatuses((prev) => ({ ...prev, [assetId]: 'uploading' }));
    try {
      const currentAssets = workspace?.assets ?? [];
      const targetAsset = currentAssets.find((asset) => asset.assetId === assetId);

      const nextAssetId = await uploadAssetToHistory(file, onProgress);
      if (nextAssetId === assetId) {
        await fetchWorkspace();
        setUploadStatuses(previous => { const next = { ...previous }; delete next[assetId]; return next; });
        return;
      }
      await postWorkspaceAssociation(tabIdRef.current, { assetId: nextAssetId, role: targetAsset?.role || 'reference_image' });

      const removeRes = await fetch(`/api/workspace/assets/${assetId}`, {
        method: 'DELETE',
        headers: { 'x-tab-id': tabIdRef.current },
      });
      const removeData = await readJsonResponse<ApiMessageResponse>(removeRes, {
        invalidJsonMessage: WORKSPACE_INVALID_JSON_MESSAGE,
      });
      if (!removeRes.ok) throw new Error(removeData.error || removeData.message || '替换素材失败');

      if (targetAsset) {
        const nextOrder = currentAssets
          .map((asset) => asset.assetId === assetId ? nextAssetId : asset.assetId)
          .filter((id, index, ids) => ids.indexOf(id) === index)
          .map((id, index) => ({ assetId: id, sortOrder: index }));

        const reorderRes = await fetch('/api/workspace/assets/reorder', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'x-tab-id': tabIdRef.current,
          },
          body: JSON.stringify({ order: nextOrder }),
        });
        const reorderData = await readJsonResponse<ApiMessageResponse>(reorderRes, {
          invalidJsonMessage: WORKSPACE_INVALID_JSON_MESSAGE,
        });
        if (!reorderRes.ok) throw new Error(reorderData.error || reorderData.message || '替换素材失败');
      }

      await fetchWorkspace();
      setUploadStatuses((prev) => {
        const next = { ...prev };
        delete next[assetId];
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '替换素材失败');
      setUploadStatuses((prev) => ({ ...prev, [assetId]: 'failed' }));
    }
  }, [fetchWorkspace, uploadAssetToHistory, workspace?.assets]);

  const addAssets = useCallback(async (assetIds: string[]) => {
    const cleanAssetIds = assetIds.map((id) => id.trim()).filter(Boolean);
    if (cleanAssetIds.length === 0) return;
    setLoading(true);
    try {
      await postWorkspaceAssociation(tabIdRef.current, { assetIds: cleanAssetIds });
      await fetchWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : '加入参考素材失败');
      setLoading(false);
      throw err;
    }
  }, [fetchWorkspace]);

  const addLibrarySelection = useCallback(async (selection: Array<{ assetId?: string; referenceImageId?: string }>) => {
    if (!selection.length) return;
    setLoading(true);
    try {
      await postWorkspaceAssociation(tabIdRef.current, { selection });
      await fetchWorkspace();
    } catch (err) { setError(err instanceof Error ? err.message : '加入参考素材失败'); setLoading(false); throw err; }
  }, [fetchWorkspace]);

  const addReferenceImages = useCallback(async (referenceImageIds: string[]) => {
    if (referenceImageIds.length === 0) return;
    setLoading(true);
    try {
      await postWorkspaceAssociation(tabIdRef.current, { referenceImageIds });
      await fetchWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : '加入参考素材失败');
      setLoading(false);
      throw err;
    }
  }, [fetchWorkspace]);

  const loadReferenceAlbum = useCallback(async (albumId: string, maxImages = 9) => {
    setLoading(true);
    try {
      const detailRes = await fetch(`/api/reference-albums/${albumId}`);
      const detail = await readJsonResponse<ReferenceAlbumDetailResponse>(detailRes, {
        invalidJsonMessage: REFERENCE_ALBUM_INVALID_JSON_MESSAGE,
      });
      if (!detailRes.ok) throw new Error(detail.error || detail.message || '读取图集失败');
      const referenceImageIds = (detail.images || [])
        .map((image) => image.id)
        .filter((id): id is string => Boolean(id));
      if (referenceImageIds.length > maxImages) {
        throw new Error(`当前模型最多使用 ${maxImages} 张参考图。图集有 ${referenceImageIds.length} 项，请从素材选择器按需选择，现有素材未被替换。`);
      }
      const res = await fetch('/api/workspace/assets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tab-id': tabIdRef.current,
        },
        body: JSON.stringify({ referenceImageIds, replace: true }),
      });
      const data = await readJsonResponse<ApiMessageResponse>(res, {
        invalidJsonMessage: WORKSPACE_INVALID_JSON_MESSAGE,
      });
      if (!res.ok) throw new Error(data.error || data.message || '读取图集失败');
      await fetchWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取图集失败');
      setLoading(false);
      throw err;
    }
  }, [fetchWorkspace]);

  const createReferenceAlbum = useCallback(async (name: string) => {
    const res = await fetch('/api/reference-albums', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, album_type: 'personal' }),
    });
    const data = await readJsonResponse<ReferenceAlbumCreateResponse>(res, {
      invalidJsonMessage: REFERENCE_ALBUM_INVALID_JSON_MESSAGE,
    });
    if (!res.ok) throw new Error(data.error || data.message || '创建图集失败');
    const albumId = data.album?.id;
    if (!albumId) throw new Error('图集创建成功，但没有返回图集 ID');
    return albumId;
  }, []);

  const clearAssets = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/workspace/assets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tab-id': tabIdRef.current,
        },
        body: JSON.stringify({ replace: true, referenceImageIds: [] }),
      });
      const data = await readJsonResponse<ApiMessageResponse>(res, {
        invalidJsonMessage: WORKSPACE_INVALID_JSON_MESSAGE,
      });
      if (!res.ok) throw new Error(data.error || data.message || '清空参考素材失败');
      await fetchWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : '清空参考素材失败');
      setLoading(false);
      throw err;
    }
  }, [fetchWorkspace]);

  const saveCurrentAsReferenceAlbum = useCallback(async (name: string) => {
    const albumId = await createReferenceAlbum(name);
    const assetIds = (workspace?.assets || [])
      .filter((asset) => !asset.referenceImageId)
      .map((asset) => asset.assetId);
    const referenceImageIds = (workspace?.assets || [])
      .map((asset) => asset.referenceImageId)
      .filter((id): id is string => Boolean(id));
    if (assetIds.length > 0 || referenceImageIds.length > 0) {
      const res = await fetch(`/api/reference-albums/${albumId}/images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset_ids: assetIds, reference_image_ids: referenceImageIds }),
      });
      const data = await readJsonResponse<ReferenceAlbumDetailResponse>(res, {
        invalidJsonMessage: REFERENCE_ALBUM_INVALID_JSON_MESSAGE,
      });
      if (!res.ok) throw new Error(data.error || data.message || '保存图集失败');

      const savedReferenceImageIds = Array.isArray(data.images)
        ? data.images.map((image: { id?: string }) => image.id).filter((id: string | undefined): id is string => Boolean(id))
        : [];

      if (savedReferenceImageIds.length > 0) {
        const workspaceRes = await fetch('/api/workspace/assets', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-tab-id': tabIdRef.current,
          },
          body: JSON.stringify({ referenceImageIds: savedReferenceImageIds, replace: true }),
        });
        const workspaceData = await readJsonResponse<ApiMessageResponse>(workspaceRes, {
          invalidJsonMessage: WORKSPACE_INVALID_JSON_MESSAGE,
        });
        if (!workspaceRes.ok) {
          throw new Error(workspaceData.error || workspaceData.message || '载入已保存图集失败');
        }
        await fetchWorkspace();
      }
    }
    return albumId;
  }, [createReferenceAlbum, fetchWorkspace, workspace?.assets]);

  // P0-1: 设置 frame 角色
  const setAssetFrameRole = useCallback(async (assetId: string, role: FrameRole) => {
    try {
      // 更新 role 字段
      await fetch(`/api/workspace/assets/${assetId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-tab-id': tabIdRef.current,
        },
        body: JSON.stringify({ role }),
      });
      await fetchWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Set role failed');
    }
  }, [fetchWorkspace]);

  // 移除素材
  const removeAsset = useCallback(async (assetId: string) => {
    try {
      await fetch(`/api/workspace/assets/${assetId}`, {
        method: 'DELETE',
        headers: { 'x-tab-id': tabIdRef.current },
      });
      await fetchWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Remove failed');
    }
  }, [fetchWorkspace]);

  // 拖拽排序
  const reorderAssets = useCallback(async (
    newOrder: Array<{ assetId: string; sortOrder: number }>
  ) => {
    try {
      await fetch('/api/workspace/assets/reorder', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-tab-id': tabIdRef.current,
        },
        body: JSON.stringify({ order: newOrder }),
      });
      await fetchWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reorder failed');
    }
  }, [fetchWorkspace]);

  // Prompt 验证
  const validatePrompt = useCallback(async (prompt: string) => {
    try {
      const res = await fetch('/api/workspace/validate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tab-id': tabIdRef.current,
        },
        body: JSON.stringify({ prompt }),
      });
      const data = await readJsonResponse<PromptValidationResponse>(res, {
        invalidJsonMessage: WORKSPACE_INVALID_JSON_MESSAGE,
      });
      return { valid: Boolean(data.valid), missing: data.missing || [] };
    } catch {
      return { valid: false, missing: [] };
    }
  }, []);

  return {
    workspace,
    loading,
    error,
    assets: workspace?.assets ?? [],
    uploadStatuses,
    uploadAsset,
    uploadAssetToHistory,
    pendingWorkspaceAttach,
    retryPendingAttach,
    addAssets,
    addReferenceImages,
    addLibrarySelection,
    loadReferenceAlbum,
    saveCurrentAsReferenceAlbum,
    createReferenceAlbum,
    clearAssets,
    removeAsset,
    reorderAssets,
    validatePrompt,
    refresh: fetchWorkspace,
    replaceAsset,
    setAssetFrameRole,
  };
}
