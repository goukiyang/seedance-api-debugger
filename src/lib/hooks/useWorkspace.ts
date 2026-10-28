'use client';

/**
 * useWorkspace — Workspace 状态管理 Hook
 * 管理当前 tab 的 workspace、素材列表、拖拽排序
 * P0-1 增强：上传状态追踪、frame 角色设置
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { uploadFileToHistory } from '@/lib/http/file-upload';
import { subscribeUploadSession, uploadSession } from '@/lib/http/upload-session';
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
  tabId?: string;
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
  const releaseReceipt = () => { try { sessionStorage.removeItem(key); } catch { /* A confirmed receipt remains safe to read. */ } };
  // A clear retry must read its first CAS receipt, not clear a later attachment.
  if (!body.recoveryClear) releaseReceipt();
  return releaseReceipt;
}

function getOrCreateTabId(): string {
  if (typeof window === 'undefined') return 'default';
  try {
  let tabId = sessionStorage.getItem(TAB_ID_KEY);
  if (!tabId) {
    tabId = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sessionStorage.setItem(TAB_ID_KEY, tabId);
  }
  return tabId;
  } catch { return ''; }
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
  refresh: () => Promise<WorkspaceReadResult>;
  captureRecovery: () => WorkspaceInputRecovery | null;
  restoreRecovery: (snapshot: WorkspaceInputRecovery) => Promise<void>;
  // P0-1: 替换素材
  replaceAsset: (assetId: string, file: File, onProgress?: UploadProgressHandler) => Promise<void>;
  /** Puts a library asset (picked in the shared picker) in the place of an existing reference. */
  replaceAssetWithLibrary: (assetId: string, nextId: string) => Promise<void>;
  // P0-1: 设置 frame 角色
  setAssetFrameRole: (assetId: string, role: FrameRole) => Promise<void>;
}
export type WorkspaceInputRecovery = { ownerId: string; epoch: number; tabId: string; workspaceId: string;
  items: Array<Pick<WorkspaceAssetItem, 'assetId' | 'referenceImageId' | 'role' | 'sortOrder'>> };
type WorkspaceRecoveryClear = { workspaceId: string;
  expectedWorkspaceAssets: Array<Pick<WorkspaceAssetItem, 'id' | 'assetId' | 'role' | 'sortOrder'>> };
export class WorkspaceInputRecoveryError extends Error {
  constructor(message: string, readonly associationConfirmed: boolean) { super(message); }
}

export type WorkspaceReadResult = { applied: boolean; workspace: Workspace | null; error: string | null };
type WorkspaceScope = { ownerId: string; epoch: number; tabId: string; workspaceId: string | null; mutation: number };

export function useWorkspace(): UseWorkspaceResult {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploadStatuses, setUploadStatuses] = useState<Record<string, UploadStatus>>({});
  const [pendingWorkspaceAttach, setPendingWorkspaceAttach] = useState<PendingWorkspaceAttach | null>(null);
  const pendingWorkspaceAttachRef = useRef(pendingWorkspaceAttach); pendingWorkspaceAttachRef.current = pendingWorkspaceAttach;
  const activeHistoryUpload = useRef<object | null>(null);
  const tabIdRef = useRef<string>(getOrCreateTabId());
  const workspaceRef = useRef(workspace); workspaceRef.current = workspace;
  const mounted = useRef(true), readSequence = useRef(0), mutationRevision = useRef(0);
  const pendingMutations = useRef(0);
  const readAbort = useRef<AbortController | null>(null);
  const recoveryClearSnapshots = useRef(new WeakMap<WorkspaceInputRecovery, WorkspaceRecoveryClear>());
  const currentScope = useCallback((): WorkspaceScope | null => {
    const session = uploadSession();
    if (!session.ownerId || !tabIdRef.current) return null;
    const current = workspaceRef.current;
    return { ...session, ownerId: session.ownerId, tabId: tabIdRef.current,
      workspaceId: current?.owner_id === session.ownerId ? current.id : null, mutation: mutationRevision.current };
  }, []);
  const isCurrent = useCallback((scope: WorkspaceScope) => {
    const session = uploadSession(), current = workspaceRef.current;
    return mounted.current && session.ownerId === scope.ownerId && session.epoch === scope.epoch
      && tabIdRef.current === scope.tabId
      && (!scope.workspaceId || !current || current.id === scope.workspaceId && current.owner_id === scope.ownerId);
  }, []);
  const assertCurrent = useCallback((scope: WorkspaceScope) => {
    if (!isCurrent(scope)) throw new Error('当前账号或输入已变化，原操作结果未覆盖新现场。');
  }, [isCurrent]);
  const fetchWorkspace = useCallback(async (): Promise<WorkspaceReadResult> => {
    const scope = currentScope(), read = ++readSequence.current;
    readAbort.current?.abort();
    if (!scope) {
      const message = !tabIdRef.current ? '浏览器无法保留工作区标识，当前输入未改变；请检查存储设置' : '当前账号尚未确认';
      if (mounted.current) { setWorkspace(null); workspaceRef.current = null; setLoading(false); if (!tabIdRef.current) setError(message); }
      return { applied: false, workspace: null, error: message };
    }
    const controller = new AbortController(); readAbort.current = controller;
    const active = () => read === readSequence.current && mutationRevision.current === scope.mutation && isCurrent(scope);
    try {
      const response = await fetch('/api/workspace', { headers: { 'x-tab-id': scope.tabId, 'x-upload-owner-id': scope.ownerId },
        cache: 'no-store', signal: controller.signal });
      const data = await readJsonResponse<WorkspaceResponse>(response, { invalidJsonMessage: WORKSPACE_INVALID_JSON_MESSAGE });
      if (!active()) return { applied: false, workspace: null, error: null };
      if (!response.ok || data.tabId !== scope.tabId || !data.workspace || data.workspace.owner_id !== scope.ownerId
        || scope.workspaceId && data.workspace.id !== scope.workspaceId) throw new Error(data.error || data.message || '工作台读取结果尚未确认');
      workspaceRef.current = data.workspace; setWorkspace(data.workspace); setError(null);
      return { applied: true, workspace: data.workspace, error: null };
    } catch (cause) {
      if (!active()) return { applied: false, workspace: null, error: null };
      const message = cause instanceof Error ? cause.message : '工作台读取失败'; setError(message);
      return { applied: false, workspace: null, error: message };
    } finally { if (active() && pendingMutations.current === 0) setLoading(false); }
  }, [currentScope, isCurrent]);
  useEffect(() => {
    mounted.current = true;
    const reset = () => {
      readSequence.current++; mutationRevision.current++; pendingMutations.current = 0; readAbort.current?.abort();
      workspaceRef.current = null; setWorkspace(null); setError(null); setPendingWorkspaceAttach(null); pendingWorkspaceAttachRef.current = null;
      activeHistoryUpload.current = null; setUploadStatuses({}); setLoading(true);
      void fetchWorkspace();
    };
    const unsubscribe = subscribeUploadSession(reset); void fetchWorkspace();
    return () => { mounted.current = false; unsubscribe(); readSequence.current++; mutationRevision.current++; readAbort.current?.abort(); };
  }, [fetchWorkspace]);
  const mutate = useCallback(async <T,>(operation: (scope: WorkspaceScope) => Promise<T>): Promise<T> => {
    const scope = currentScope(); if (!scope) throw new Error('当前账号尚未确认，请重新登录后继续');
    scope.mutation = ++mutationRevision.current; readSequence.current++; readAbort.current?.abort();
    pendingMutations.current++;
    setLoading(true); setError(null);
    try {
      const result = await operation(scope); assertCurrent(scope);
      const read = await fetchWorkspace(); assertCurrent(scope);
      if (!read.applied && read.error) throw new Error(read.error);
      return result;
    } catch (cause) {
      if (isCurrent(scope) && scope.mutation === mutationRevision.current) setError(cause instanceof Error ? cause.message : '工作区操作未确认');
      throw cause;
    } finally { if (isCurrent(scope)) { pendingMutations.current = Math.max(0, pendingMutations.current - 1); if (!pendingMutations.current) setLoading(false); } }
  }, [assertCurrent, currentScope, fetchWorkspace, isCurrent]);
  const request = useCallback(async <T extends ApiMessageResponse,>(scope: WorkspaceScope, url: string, method: string, body?: unknown): Promise<T> => {
    assertCurrent(scope);
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'x-tab-id': scope.tabId, 'x-upload-owner-id': scope.ownerId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store', signal: AbortSignal.timeout(30000) });
    const data = await readJsonResponse<T>(response, { invalidJsonMessage: WORKSPACE_INVALID_JSON_MESSAGE }); assertCurrent(scope);
    if (!response.ok) throw new Error(data.error || data.message || '工作区操作未确认');
    return data;
  }, [assertCurrent]);
  const associate = useCallback(async (scope: WorkspaceScope, body: Record<string, unknown>) => {
    assertCurrent(scope); const release = await postWorkspaceAssociation(scope.tabId, body); assertCurrent(scope); return release;
  }, [assertCurrent]);
  const captureRecovery = useCallback((): WorkspaceInputRecovery | null => {
    const session = uploadSession();
    if (!workspace || workspace.owner_id !== session.ownerId || loading || error || pendingWorkspaceAttach
      || Object.values(uploadStatuses).some(status => status === 'uploading' || status === 'failed') || workspace.assets.length > 80) return null;
    return { ownerId: session.ownerId!, epoch: session.epoch, tabId: tabIdRef.current, workspaceId: workspace.id,
      items: workspace.assets.map(({ assetId, referenceImageId, role, sortOrder }) => ({ assetId, referenceImageId, role, sortOrder })).sort((a, b) => a.sortOrder - b.sortOrder) };
  }, [workspace, loading, error, pendingWorkspaceAttach, uploadStatuses]);
  const restoreRecovery = useCallback(async (snapshot: WorkspaceInputRecovery) => {
    const scope = currentScope();
    if (!scope || scope.ownerId !== snapshot.ownerId || scope.epoch !== snapshot.epoch || scope.tabId !== snapshot.tabId || scope.workspaceId !== snapshot.workspaceId)
      throw new Error('账号或工作区已变化，原输入未套用到新位置。');
    let associationConfirmed = false;
    try { await mutate(async active => {
      let recoveryClear = recoveryClearSnapshots.current.get(snapshot);
      if (!snapshot.items.length && !recoveryClear) {
        recoveryClear = { workspaceId: snapshot.workspaceId, expectedWorkspaceAssets: [...(workspaceRef.current?.assets || [])]
          .sort((a, b) => a.sortOrder - b.sortOrder).map(({ id, assetId, role, sortOrder }) => ({ id, assetId, role, sortOrder })) };
        recoveryClearSnapshots.current.set(snapshot, recoveryClear);
      }
      const release = await associate(active, { replace: true, selection: snapshot.items.map(item => item.referenceImageId
        ? { referenceImageId: item.referenceImageId } : { assetId: item.assetId }), ...(recoveryClear ? { recoveryClear } : {}) });
      associationConfirmed = true;
      for (const item of snapshot.items) await request(active, `/api/workspace/assets/${encodeURIComponent(item.assetId)}`, 'PATCH', { role: item.role });
      const result = await request<WorkspaceResponse>(active, '/api/workspace', 'GET');
      const assets = result.workspace?.assets;
      if (result.workspace?.id !== snapshot.workspaceId || result.workspace.owner_id !== snapshot.ownerId || !assets || assets.length !== snapshot.items.length
        || assets.some((item, index) => item.assetId !== snapshot.items[index].assetId || item.role !== snapshot.items[index].role))
        throw new Error('素材顺序或角色尚未完整确认，原快照保留，请重试恢复。');
      if (recoveryClear) { release(); recoveryClearSnapshots.current.delete(snapshot); }
    }); } catch (cause) { throw new WorkspaceInputRecoveryError(cause instanceof Error ? cause.message : '原输入恢复未确认', associationConfirmed); }
  }, [associate, currentScope, mutate, request]);
  const uploadAssetToHistory = useCallback(async (file: File, onProgress?: UploadProgressHandler) => {
    const asset = await uploadFileToHistory(file, { invalidJsonMessage: UPLOAD_INVALID_JSON_MESSAGE, onProgress });
    if (!asset.id) throw new Error('素材上传成功，但没有返回素材 ID'); return asset.id;
  }, []);
  const uploadAsset = useCallback(async (file: File, onProgress?: UploadProgressHandler) => {
    if (activeHistoryUpload.current || pendingWorkspaceAttachRef.current) {
      setError(pendingWorkspaceAttachRef.current ? '已有素材加入结果待确认，请先重试加入参考区；不用重新上传文件。' : '当前文件仍在上传，请等待本次上传结束。');
      return;
    }
    const operation = {}; activeHistoryUpload.current = operation;
    const tempId = `uploading_${crypto.randomUUID()}`;
    try { await mutate(async scope => {
      setUploadStatuses(previous => ({ ...previous, [tempId]: 'uploading' }));
      let uploaded = false;
      try {
        const assetId = await uploadAssetToHistory(file, p => { if (isCurrent(scope)) onProgress?.(p); }); assertCurrent(scope);
        uploaded = true;
        try { await associate(scope, { assetIds: [assetId] }); }
        catch (cause) { if (isCurrent(scope)) {
          const pending = { assetIds: [assetId], fileNames: [file.name || 'upload.bin'], statusIds: [tempId] };
          pendingWorkspaceAttachRef.current = pending; setPendingWorkspaceAttach(pending);
        }
          throw new Error(`素材已上传成功，但加入参考区尚未确认：${cause instanceof Error ? cause.message : '请重试加入，不用重新上传'}`); }
        setUploadStatuses(previous => { const next = { ...previous }; delete next[tempId]; return next; }); setPendingWorkspaceAttach(null);
      } catch (cause) {
        if (isCurrent(scope)) setUploadStatuses(previous => {
          const next = { ...previous };
          // No reference exists for a failed history upload. Keep its error and
          // original upload marker, not an invisible permanent reference blocker.
          if (uploaded) next[tempId] = 'failed'; else delete next[tempId];
          return next;
        });
        throw cause;
      }
    }).catch(() => { /* The current operation owns the visible error; stale operations stay silent. */ }); }
    finally { if (activeHistoryUpload.current === operation) activeHistoryUpload.current = null; }
  }, [assertCurrent, associate, isCurrent, mutate, uploadAssetToHistory]);
  const retryPendingAttach = useCallback(async () => {
    if (!pendingWorkspaceAttach) return;
    await mutate(async scope => {
      await associate(scope, { assetIds: pendingWorkspaceAttach.assetIds });
      setUploadStatuses(previous => { const next = { ...previous }; pendingWorkspaceAttach.statusIds.forEach(id => delete next[id]); return next; });
      pendingWorkspaceAttachRef.current = null; setPendingWorkspaceAttach(null);
    }).catch(() => {});
  }, [associate, mutate, pendingWorkspaceAttach]);
  const replaceAsset = useCallback(async (assetId: string, file: File, onProgress?: UploadProgressHandler) => {
    await mutate(async scope => {
      const assets = workspaceRef.current?.assets || [], target = assets.find(item => item.assetId === assetId);
      setUploadStatuses(previous => ({ ...previous, [assetId]: 'uploading' }));
      try {
        const nextId = await uploadAssetToHistory(file, p => { if (isCurrent(scope)) onProgress?.(p); }); assertCurrent(scope);
        if (nextId !== assetId) {
          await associate(scope, { assetId: nextId, role: target?.role || 'reference_image' });
          await request(scope, `/api/workspace/assets/${encodeURIComponent(assetId)}`, 'DELETE');
          if (target) await request(scope, '/api/workspace/assets/reorder', 'PATCH', { order: assets.map(item => item.assetId === assetId ? nextId : item.assetId)
            .filter((id, index, all) => all.indexOf(id) === index).map((id, index) => ({ assetId: id, sortOrder: index })) });
        }
        setUploadStatuses(previous => { const next = { ...previous }; delete next[assetId]; return next; });
      } catch (cause) { if (isCurrent(scope)) setUploadStatuses(previous => ({ ...previous, [assetId]: 'failed' })); throw cause; }
    }).catch(() => {});
  }, [assertCurrent, associate, isCurrent, mutate, request, uploadAssetToHistory]);
  const replaceAssetWithLibrary = useCallback(async (assetId: string, nextId: string) => {
    if (!nextId || nextId === assetId) return;
    await mutate(async scope => {
      const assets = workspaceRef.current?.assets || [], target = assets.find(item => item.assetId === assetId);
      await associate(scope, { assetId: nextId, role: target?.role || 'reference_image' });
      await request(scope, `/api/workspace/assets/${encodeURIComponent(assetId)}`, 'DELETE');
      if (target) await request(scope, '/api/workspace/assets/reorder', 'PATCH', { order: assets.map(item => item.assetId === assetId ? nextId : item.assetId)
        .filter((id, index, all) => all.indexOf(id) === index).map((id, index) => ({ assetId: id, sortOrder: index })) });
    });
  }, [associate, mutate, request]);
  const addAssets = useCallback(async (ids: string[]) => { const assetIds = ids.map(id => id.trim()).filter(Boolean); if (assetIds.length) await mutate(scope => associate(scope, { assetIds })); }, [associate, mutate]);
  const addReferenceImages = useCallback(async (referenceImageIds: string[]) => { if (referenceImageIds.length) await mutate(scope => associate(scope, { referenceImageIds })); }, [associate, mutate]);
  const addLibrarySelection = useCallback(async (selection: Array<{ assetId?: string; referenceImageId?: string }>) => { if (selection.length) await mutate(scope => associate(scope, { selection })); }, [associate, mutate]);
  const loadReferenceAlbum = useCallback(async (albumId: string, maxImages = 9) => {
    await mutate(async scope => {
      const detail = await request<ReferenceAlbumDetailResponse>(scope, `/api/reference-albums/${encodeURIComponent(albumId)}`, 'GET');
      const referenceImageIds = (detail.images || []).map(image => image.id).filter((id): id is string => Boolean(id));
      if (referenceImageIds.length > maxImages) throw new Error(`当前模型最多使用 ${maxImages} 张参考图。图集有 ${referenceImageIds.length} 项，请从素材选择器按需选择，现有素材未被替换。`);
      await associate(scope, { referenceImageIds, replace: true });
    });
  }, [associate, mutate, request]);
  const createReferenceAlbum = useCallback(async (name: string) => {
    const scope = currentScope(); if (!scope) throw new Error('当前账号尚未确认');
    const data = await request<ReferenceAlbumCreateResponse>(scope, '/api/reference-albums', 'POST', { name, album_type: 'personal' });
    if (!data.album?.id) throw new Error('图集创建成功，但没有返回图集 ID'); return data.album.id;
  }, [currentScope, request]);
  const clearAssets = useCallback(async () => { await mutate(scope => associate(scope, { replace: true, referenceImageIds: [] })); }, [associate, mutate]);
  const saveCurrentAsReferenceAlbum = useCallback(async (name: string) => mutate(async scope => {
    const assets = [...(workspaceRef.current?.assets || [])];
    const data = await request<ReferenceAlbumCreateResponse>(scope, '/api/reference-albums', 'POST', { name, album_type: 'personal' });
    const albumId = data.album?.id; if (!albumId) throw new Error('图集创建成功，但没有返回图集 ID');
    const assetIds = assets.filter(asset => !asset.referenceImageId).map(asset => asset.assetId), referenceImageIds = assets.map(asset => asset.referenceImageId).filter((id): id is string => Boolean(id));
    if (assetIds.length || referenceImageIds.length) {
      const saved = await request<ReferenceAlbumDetailResponse>(scope, `/api/reference-albums/${encodeURIComponent(albumId)}/images`, 'POST', { asset_ids: assetIds, reference_image_ids: referenceImageIds });
      const savedIds = (saved.images || []).map(image => image.id).filter((id): id is string => Boolean(id));
      if (savedIds.length) await associate(scope, { referenceImageIds: savedIds, replace: true });
    }
    return albumId;
  }), [associate, mutate, request]);
  const setAssetFrameRole = useCallback(async (assetId: string, role: FrameRole) => { await mutate(scope => request(scope, `/api/workspace/assets/${encodeURIComponent(assetId)}`, 'PATCH', { role })).catch(() => {}); }, [mutate, request]);
  const removeAsset = useCallback(async (assetId: string) => { await mutate(async scope => {
    await request(scope, `/api/workspace/assets/${encodeURIComponent(assetId)}`, 'DELETE'); assertCurrent(scope);
    setUploadStatuses(previous => { const next = { ...previous }; delete next[assetId]; return next; });
  }).catch(() => {}); }, [assertCurrent, mutate, request]);
  const reorderAssets = useCallback(async (order: Array<{ assetId: string; sortOrder: number }>) => { await mutate(scope => request(scope, '/api/workspace/assets/reorder', 'PATCH', { order })).catch(() => {}); }, [mutate, request]);
  const validatePrompt = useCallback(async (prompt: string) => {
    const scope = currentScope(); if (!scope) return { valid: false, missing: [] };
    try {
      const data = await request<PromptValidationResponse & ApiMessageResponse>(scope, '/api/workspace/validate', 'POST', { prompt });
      return { valid: Boolean(data.valid), missing: data.missing || [] };
    } catch { return { valid: false, missing: [] }; }
  }, [currentScope, request]);
  return { workspace, loading, error, assets: workspace?.assets ?? [], uploadStatuses, uploadAsset, uploadAssetToHistory,
    pendingWorkspaceAttach, retryPendingAttach, addAssets, addReferenceImages, addLibrarySelection, loadReferenceAlbum,
    saveCurrentAsReferenceAlbum, createReferenceAlbum, clearAssets, removeAsset, reorderAssets, validatePrompt,
    refresh: fetchWorkspace, captureRecovery, restoreRecovery, replaceAsset, replaceAssetWithLibrary, setAssetFrameRole };
}
