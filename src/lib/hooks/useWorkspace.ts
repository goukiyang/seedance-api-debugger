'use client';

/**
 * useWorkspace — Workspace 状态管理 Hook
 * 管理当前 tab 的 workspace、素材列表、拖拽排序
 * P0-1 增强：上传状态追踪、frame 角色设置
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Workspace, WorkspaceAssetItem, UploadStatus, FrameRole } from '@/types';

const TAB_ID_KEY = 'workspace_tab_id';

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
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load workspace');
      setWorkspace(data.workspace);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWorkspace();
  }, [fetchWorkspace]);

  const uploadAssetToHistory = useCallback(async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch('/api/assets/upload', {
      method: 'POST',
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    const assetId = data.asset?.id as string | undefined;
    if (!assetId) throw new Error('Upload response missing asset id');
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
      await fetch('/api/workspace/assets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tab-id': tabIdRef.current,
        },
        body: JSON.stringify({ assetId }),
      });

      await fetchWorkspace();
      // 成功后移除临时状态
      setUploadStatuses((prev) => {
        const next = { ...prev };
        delete next[tempId];
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
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
      const addData = await addRes.json();
      if (!addRes.ok) throw new Error(addData.error || addData.message || 'Replace failed');

      const removeRes = await fetch(`/api/workspace/assets/${assetId}`, {
        method: 'DELETE',
        headers: { 'x-tab-id': tabIdRef.current },
      });
      const removeData = await removeRes.json();
      if (!removeRes.ok) throw new Error(removeData.error || removeData.message || 'Replace failed');

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
        const reorderData = await reorderRes.json();
        if (!reorderRes.ok) throw new Error(reorderData.error || reorderData.message || 'Replace failed');
      }

      await fetchWorkspace();
      setUploadStatuses((prev) => {
        const next = { ...prev };
        delete next[assetId];
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Replace failed');
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
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || 'Add assets failed');
      await fetchWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Add assets failed');
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
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || 'Add reference images failed');
      await fetchWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Add reference images failed');
      setLoading(false);
      throw err;
    }
  }, [fetchWorkspace]);

  const loadReferenceAlbum = useCallback(async (albumId: string) => {
    setLoading(true);
    try {
      const detailRes = await fetch(`/api/reference-albums/${albumId}`);
      const detail = await detailRes.json();
      if (!detailRes.ok) throw new Error(detail.error || detail.message || 'Load reference album failed');
      const referenceImageIds = (detail.images || []).map((image: { id: string }) => image.id).slice(0, 9);
      const res = await fetch('/api/workspace/assets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tab-id': tabIdRef.current,
        },
        body: JSON.stringify({ referenceImageIds, replace: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || 'Load reference album failed');
      await fetchWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load reference album failed');
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
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || data.message || 'Create reference album failed');
    return data.album.id as string;
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
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || 'Clear workspace failed');
      await fetchWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Clear workspace failed');
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
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || 'Save current references failed');

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
        const workspaceData = await workspaceRes.json();
        if (!workspaceRes.ok) {
          throw new Error(workspaceData.error || workspaceData.message || 'Load saved reference album failed');
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
      const data = await res.json();
      return { valid: data.valid, missing: data.missing || [] };
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
