'use client';

/**
 * useWorkspace — Workspace 状态管理 Hook
 * 管理当前 tab 的 workspace、素材列表、拖拽排序
 * P0-1 增强：上传状态追踪、frame 角色设置
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { buildRawFileUploadRequest } from '@/lib/http/file-upload';
import { readJsonResponse } from '@/lib/http/json-response';
import type { Workspace, WorkspaceAssetItem, UploadStatus, FrameRole } from '@/types';

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

type UploadAssetResponse = ApiMessageResponse & {
  asset?: {
    id?: string;
  };
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
  uploadAsset: (file: File) => Promise<void>;
  uploadAssetToHistory: (file: File) => Promise<string>;
  addAssets: (assetIds: string[]) => Promise<void>;
  addReferenceImages: (referenceImageIds: string[]) => Promise<void>;
  loadReferenceAlbum: (albumId: string) => Promise<void>;
  saveCurrentAsReferenceAlbum: (name: string) => Promise<string>;
  createReferenceAlbum: (name: string) => Promise<string>;
  clearAssets: () => Promise<void>;
  removeAsset: (assetId: string) => Promise<void>;
  reorderAssets: (newOrder: Array<{ assetId: string; sortOrder: number }>) => Promise<void>;
  validatePrompt: (prompt: string) => Promise<{ valid: boolean; missing: string[] }>;
  refresh: () => Promise<void>;
  // P0-1: 替换素材
  replaceAsset: (assetId: string, file: File) => Promise<void>;
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

  const uploadAssetToHistory = useCallback(async (file: File) => {
    const res = await fetch('/api/assets/upload', {
      ...buildRawFileUploadRequest(file),
    });
    const data = await readJsonResponse<UploadAssetResponse>(res, {
      invalidJsonMessage: UPLOAD_INVALID_JSON_MESSAGE,
    });
    if (!res.ok) throw new Error(data.error || data.message || '素材上传失败，请重新选择后重试');
    const assetId = data.asset?.id as string | undefined;
    if (!assetId) throw new Error('素材上传成功，但没有返回素材 ID');
    return assetId;
  }, []);

  // P0-1: 上传素材（带状态追踪）
  const uploadAsset = useCallback(async (file: File) => {
    // 生成临时占位 assetId
    const tempId = `uploading_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setLoading(true);
    setUploadStatuses((prev) => ({ ...prev, [tempId]: 'uploading' }));
    try {
      const assetId = await uploadAssetToHistory(file);

      // 添加到 workspace
      const addRes = await fetch('/api/workspace/assets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tab-id': tabIdRef.current,
        },
        body: JSON.stringify({ assetId }),
      });
      const addData = await readJsonResponse<ApiMessageResponse>(addRes, {
        invalidJsonMessage: WORKSPACE_INVALID_JSON_MESSAGE,
      });
      if (!addRes.ok) throw new Error(addData.error || addData.message || '素材加入工作台失败');

      await fetchWorkspace();
      // 成功后移除临时状态
      setUploadStatuses((prev) => {
        const next = { ...prev };
        delete next[tempId];
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '素材上传失败');
      // 标记为失败
      setUploadStatuses((prev) => ({ ...prev, [tempId]: 'failed' }));
      setLoading(false);
    }
  }, [fetchWorkspace, uploadAssetToHistory]);

  // P0-1: 替换素材
  const replaceAsset = useCallback(async (assetId: string, file: File) => {
    setUploadStatuses((prev) => ({ ...prev, [assetId]: 'uploading' }));
    try {
      const currentAssets = workspace?.assets ?? [];
      const targetAsset = currentAssets.find((asset) => asset.assetId === assetId);

      const nextAssetId = await uploadAssetToHistory(file);

      const addRes = await fetch('/api/workspace/assets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tab-id': tabIdRef.current,
        },
        body: JSON.stringify({ assetId: nextAssetId, role: targetAsset?.role || 'reference_image' }),
      });
      const addData = await readJsonResponse<ApiMessageResponse>(addRes, {
        invalidJsonMessage: WORKSPACE_INVALID_JSON_MESSAGE,
      });
      if (!addRes.ok) throw new Error(addData.error || addData.message || '替换素材失败');

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
      const res = await fetch('/api/workspace/assets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tab-id': tabIdRef.current,
        },
        body: JSON.stringify({ assetIds: cleanAssetIds }),
      });
      const data = await readJsonResponse<ApiMessageResponse>(res, {
        invalidJsonMessage: WORKSPACE_INVALID_JSON_MESSAGE,
      });
      if (!res.ok) throw new Error(data.error || data.message || '加入参考素材失败');
      await fetchWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : '加入参考素材失败');
      setLoading(false);
      throw err;
    }
  }, [fetchWorkspace]);

  const addReferenceImages = useCallback(async (referenceImageIds: string[]) => {
    if (referenceImageIds.length === 0) return;
    setLoading(true);
    try {
      const res = await fetch('/api/workspace/assets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tab-id': tabIdRef.current,
        },
        body: JSON.stringify({ referenceImageIds }),
      });
      const data = await readJsonResponse<ApiMessageResponse>(res, {
        invalidJsonMessage: WORKSPACE_INVALID_JSON_MESSAGE,
      });
      if (!res.ok) throw new Error(data.error || data.message || '加入参考素材失败');
      await fetchWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : '加入参考素材失败');
      setLoading(false);
      throw err;
    }
  }, [fetchWorkspace]);

  const loadReferenceAlbum = useCallback(async (albumId: string) => {
    setLoading(true);
    try {
      const detailRes = await fetch(`/api/reference-albums/${albumId}`);
      const detail = await readJsonResponse<ReferenceAlbumDetailResponse>(detailRes, {
        invalidJsonMessage: REFERENCE_ALBUM_INVALID_JSON_MESSAGE,
      });
      if (!detailRes.ok) throw new Error(detail.error || detail.message || '读取图集失败');
      const referenceImageIds = (detail.images || [])
        .map((image) => image.id)
        .filter((id): id is string => Boolean(id))
        .slice(0, 9);
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
    addAssets,
    addReferenceImages,
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
