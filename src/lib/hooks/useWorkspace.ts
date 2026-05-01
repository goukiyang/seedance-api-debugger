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

  // P0-1: 上传素材（带状态追踪）
  const uploadAsset = useCallback(async (file: File) => {
    // 生成临时占位 assetId
    const tempId = `uploading_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setLoading(true);
    setUploadStatuses((prev) => ({ ...prev, [tempId]: 'uploading' }));
    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/assets/upload', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');

      // 添加到 workspace
      await fetch('/api/workspace/assets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tab-id': tabIdRef.current,
        },
        body: JSON.stringify({ assetId: data.asset.id }),
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
  }, [fetchWorkspace]);

  // P0-1: 替换素材
  const replaceAsset = useCallback(async (assetId: string, file: File) => {
    setUploadStatuses((prev) => ({ ...prev, [assetId]: 'uploading' }));
    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/assets/upload', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');

      // 更新 workspace 中的 assetId
      await fetch('/api/workspace/assets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tab-id': tabIdRef.current,
        },
        body: JSON.stringify({ assetId: data.asset.id }),
      });

      // 移除旧的 asset
      await fetch(`/api/workspace/assets/${assetId}`, {
        method: 'DELETE',
        headers: { 'x-tab-id': tabIdRef.current },
      });

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
  }, [fetchWorkspace]);

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
    removeAsset,
    reorderAssets,
    validatePrompt,
    refresh: fetchWorkspace,
    replaceAsset,
    setAssetFrameRole,
  };
}
