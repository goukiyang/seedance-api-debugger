'use client';
import { useProductDialog } from '@/components/useProductDialog';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Plus, RotateCcw, X } from 'lucide-react';
import PageBanner from '@/components/PageBanner';
import PaginationControls from '@/components/PaginationControls';
import { RelativeTime } from '@/components/RelativeTime';
import ShareAlbumDialog from '@/components/ShareAlbumDialog';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { sanitizeOptionalReturnTo } from '@/lib/navigation/return-to';
import styles from './ReferenceAlbumsClient.module.css';

type Scope = 'mine' | 'project' | 'other_project' | 'shared' | 'public' | 'all';

interface ProjectOption {
  id: string;
  name: string;
  type: string;
  status?: string;
  my_role: string | null;
  can_manage_assets?: boolean;
}

interface PublicFolder {
  id: string;
  name: string;
  description: string | null;
  sort_order: number;
  album_count: number;
}

interface AlbumItem {
  id: string;
  name: string;
  description: string | null;
  album_type: string;
  project_id: string | null;
  visibility: string;
  public_folder_id?: string | null;
  public_folder?: { id: string; name: string } | null;
  cover_image_id: string | null;
  cover_image_url: string | null;
  image_count: number;
  active_share_count: number;
  updated_at: string;
  owner?: { id?: string; name: string | null; username: string | null; email?: string | null; avatar_url?: string | null; account_type?: string | null };
  project?: { name: string } | null;
  permissions: {
    view: boolean;
    use: boolean;
    copy: boolean;
    edit: boolean;
  };
  can_share?: boolean;
}

interface PublicSubmission {
  id: string;
  source_album_id: string;
  public_folder_id: string | null;
  name: string;
  description: string | null;
  submit_note: string | null;
  status: string;
  created_at: string;
  submitted_by?: { id: string; name: string | null; username?: string | null; email?: string | null; avatar_url?: string | null; account_type?: string | null } | null;
  public_folder?: { id: string; name: string } | null;
  source_album?: {
    id: string;
    name: string;
    description: string | null;
    image_count: number;
    cover_image_url: string | null;
  } | null;
}

const TABS: Array<{ value: Scope; label: string }> = [
  { value: 'mine', label: '我的图集' },
  { value: 'project', label: '项目图集' },
  { value: 'other_project', label: '其他人的项目图集' },
  { value: 'shared', label: '共享给我的' },
  { value: 'public', label: '公共图集' },
  { value: 'all', label: '全部图集' },
];

const ALBUMS_PAGE_SIZE = 12;
const PREFERENCES_PREFIX = 'sd2:collections:list:v1';
const CREATE_RECOVERY_PREFIX = 'sd2:collections:create:v1';
const CREATE_DRAFT_PREFIX = 'sd2:collections:draft:v1';

interface ListPosition {
  key: string;
  page: number;
  folderId: string;
  anchorId: string;
}

interface CreateInput {
  name: string;
  description: string;
  album_type: 'personal' | 'project';
  project_id?: string;
}

function createIdentity(input: CreateInput) {
  return JSON.stringify([input.album_type, input.project_id || null, input.name.trim()]);
}

function validCreateInput(input: CreateInput | null | undefined, projectContextId: string): input is CreateInput {
  return Boolean(input && typeof input.name === 'string' && typeof input.description === 'string'
    && (input.album_type === 'personal' || input.album_type === 'project')
    && (input.album_type === 'personal' || safeId(input.project_id))
    && (!projectContextId || input.album_type === 'project' && input.project_id === projectContextId));
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function listPage(value: unknown) {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, 100_000) : 1;
}

function projectReturnTo(projectId: string, value: string | null) {
  const fallback = `/projects/${encodeURIComponent(projectId)}?view=albums`;
  const safe = sanitizeOptionalReturnTo(value);
  if (!safe) return fallback;
  try {
    const url = new URL(safe, 'https://collections.invalid');
    return url.origin === 'https://collections.invalid'
      && url.pathname === `/projects/${encodeURIComponent(projectId)}` ? safe : fallback;
  } catch {
    return fallback;
  }
}

export default function ReferenceAlbumsClient() {
  const { confirm, prompt, productDialog } = useProductDialog();
  const { user: currentUser, hasLoadedUser, userLoadError, sessionChanged, refreshUser } = useAppSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const requestedScope = searchParams.get('scope');
  const isAdmin = currentUser?.role === 'admin';
  const parsedScope = TABS.find((tab) => tab.value === requestedScope)?.value || 'mine';
  const scope: Scope = parsedScope === 'other_project' && currentUser && !isAdmin ? 'project' : parsedScope;
  const rawProjectId = searchParams.get('project_id') || '';
  const projectFilterId = (scope === 'project' || scope === 'other_project') && rawProjectId && rawProjectId !== 'all'
    ? rawProjectId : 'all';
  const projectContextId = scope === 'project' && projectFilterId !== 'all' ? projectFilterId : '';
  const accountId = !userLoadError && !sessionChanged ? currentUser?.id || '' : '';
  const boundaryKey = `${accountId}:${scope}:${projectFilterId}`;
  const boundaryRef = useRef({ key: boundaryKey, epoch: 0 });
  if (boundaryRef.current.key !== boundaryKey) {
    boundaryRef.current = { key: boundaryKey, epoch: boundaryRef.current.epoch + 1 };
  }
  const isCurrent = useCallback((epoch: number) => boundaryRef.current.epoch === epoch, []);
  const [position, setPosition] = useState<ListPosition>({ key: '', page: 1, folderId: 'all', anchorId: '' });
  const positionReady = Boolean(accountId && position.key === boundaryKey);
  const page = searchParams.has('page') ? listPage(searchParams.get('page')) : position.page;
  const requestedFolder = searchParams.get('public_folder_id');
  const selectedFolderId = searchParams.has('public_folder_id')
    ? (safeId(requestedFolder) ? requestedFolder : 'all') : position.folderId;
  const requestedAnchor = searchParams.get('anchor');
  const anchorId = searchParams.has('anchor') ? (safeId(requestedAnchor) ? requestedAnchor : '') : position.anchorId;
  const [reloadVersion, setReloadVersion] = useState(0);
  const [albums, setAlbums] = useState<AlbumItem[]>([]);
  const [loadedListKey, setLoadedListKey] = useState('');
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectDirectoryError, setProjectDirectoryError] = useState('');
  const [verifiedProject, setVerifiedProject] = useState<{
    key: string;
    project: ProjectOption | null;
    error: string;
  }>({ key: '', project: null, error: '' });
  const [folders, setFolders] = useState<PublicFolder[]>([]);
  const [pendingSubmissions, setPendingSubmissions] = useState<PublicSubmission[]>([]);
  const [canManagePublicFolders, setCanManagePublicFolders] = useState(false);
  const [loading, setLoading] = useState(false);
  const [folderLoading, setFolderLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [albumType, setAlbumType] = useState<'personal' | 'project'>('personal');
  const [projectId, setProjectId] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [pendingCreate, setPendingCreate] = useState<CreateInput | null>(null);
  const [pendingCreates, setPendingCreates] = useState<CreateInput[]>([]);
  const [matchingAlbums, setMatchingAlbums] = useState<AlbumItem[]>([]);
  const createBusyRef = useRef(false);
  const createDialogRef = useRef<HTMLDivElement>(null);
  const createSurfaceRef = useRef<HTMLDivElement>(null);
  const createNameRef = useRef<HTMLInputElement>(null);
  const albumRequestRef = useRef<AbortController | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderDescription, setNewFolderDescription] = useState('');
  const [submitAlbum, setSubmitAlbum] = useState<AlbumItem | null>(null);
  const submitTargetRef = useRef<string | null>(null);
  const [submitFolderId, setSubmitFolderId] = useState('');
  const [submitName, setSubmitName] = useState('');
  const [submitDescription, setSubmitDescription] = useState('');
  const [submitNote, setSubmitNote] = useState('');
  const [submitPendingSubmission, setSubmitPendingSubmission] = useState<PublicSubmission | null>(null);
  const [shareAlbum, setShareAlbum] = useState<AlbumItem | null>(null);
  const [actionAlbumId, setActionAlbumId] = useState<string | null>(null);
  const [actionFolderId, setActionFolderId] = useState<string | null>(null);
  const [actionSubmissionId, setActionSubmissionId] = useState<string | null>(null);
  const [failedCoverIds, setFailedCoverIds] = useState<Set<string>>(() => new Set());

  const projectChoices = useMemo(
    () => projects.filter((project) => project.can_manage_assets),
    [projects],
  );
  const visibleTabs = useMemo(
    () => (isAdmin ? TABS : TABS.filter((tab) => tab.value !== 'other_project')),
    [isAdmin],
  );
  const projectFilterChoices = useMemo(
    () => projects.filter((project) => project.type !== 'system'),
    [projects],
  );
  const totalPages = Math.max(1, Math.ceil(albums.length / ALBUMS_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pagedAlbums = albums.slice(
    (currentPage - 1) * ALBUMS_PAGE_SIZE,
    currentPage * ALBUMS_PAGE_SIZE,
  );
  const listKey = `${boundaryKey}:${scope === 'public' ? selectedFolderId : ''}`;
  const projectToVerify = projectContextId || (createOpen && albumType === 'project' ? projectId : '');
  const verificationKey = `${accountId}:${projectToVerify}`;
  const currentProject = verifiedProject.key === verificationKey ? verifiedProject.project : null;
  const projectError = verifiedProject.key === verificationKey ? verifiedProject.error : '';
  const checkingProject = Boolean(projectToVerify && verifiedProject.key !== verificationKey);
  const projectCanCreate = Boolean(currentProject?.can_manage_assets && currentProject.status === 'active');
  const projectContextBlocked = Boolean(projectContextId && (!currentProject || checkingProject));
  const safeReturnTo = projectContextId && safeId(projectContextId)
    ? projectReturnTo(projectContextId, searchParams.get('return_to'))
    : sanitizeOptionalReturnTo(searchParams.get('return_to'));

  const updateLocation = useCallback((changes: Record<string, string | null>) => {
    const params = new URLSearchParams(queryString);
    Object.entries(changes).forEach(([key, value]) => {
      if (value === null) params.delete(key);
      else params.set(key, value);
    });
    const query = params.toString();
    router.replace(`/collections${query ? `?${query}` : ''}`, { scroll: false });
  }, [queryString, router]);
  const setScope = (next: Scope) => {
    if (next !== scope) updateLocation({ scope: next, project_id: null, page: '1', anchor: '' });
  };
  const setProjectFilterId = (next: string) => updateLocation({ project_id: next === 'all' ? null : next, page: '1', anchor: '' });
  const setSelectedFolderId = (next: string) => updateLocation({ public_folder_id: next, page: '1', anchor: '' });
  const setPage = (next: number) => updateLocation({ page: String(next), anchor: '' });

  const collectionListHref = (albumId: string) => {
    const params = new URLSearchParams({ scope, page: String(currentPage), anchor: albumId });
    if (projectFilterId !== 'all') params.set('project_id', projectFilterId);
    if (scope === 'public') params.set('public_folder_id', selectedFolderId);
    if (safeReturnTo) params.set('return_to', safeReturnTo);
    return `/collections?${params.toString()}`;
  };

  const closeCreate = useCallback(() => {
    if (!createBusyRef.current) setCreateOpen(false);
  }, []);
  useDialogDismiss({
    open: createOpen,
    dialogRef: createDialogRef,
    dismissSurfaceRef: createSurfaceRef,
    initialFocusRef: createNameRef,
    onDismiss: closeCreate,
  });

  useEffect(() => {
    if (!hasLoadedUser) void refreshUser();
  }, [hasLoadedUser, refreshUser]);

  useEffect(() => {
    const empty = { key: boundaryKey, page: 1, folderId: 'all', anchorId: '' };
    let next = empty;
    if (accountId) {
      try {
        const stored = JSON.parse(window.localStorage.getItem(`${PREFERENCES_PREFIX}:${boundaryKey}`) || 'null');
        if (stored?.schema === 1) next = {
          key: boundaryKey,
          page: listPage(stored.page),
          folderId: safeId(stored.folderId) ? stored.folderId : 'all',
          anchorId: safeId(stored.anchorId) ? stored.anchorId : '',
        };
      } catch { /* Storage is optional for browsing. */ }
    }
    setPosition(next);
    setAlbums([]);
    setProjects([]);
    setFolders([]);
    setPendingSubmissions([]);
    setCanManagePublicFolders(false);
    setLoadedListKey('');
    setFailedCoverIds(new Set());
    setError(null);
    setCreateOpen(false);
    setCreating(false);
    createBusyRef.current = false;
    setName('');
    setDescription('');
    setAlbumType(projectContextId ? 'project' : 'personal');
    setProjectId(projectContextId);
    setCreateError('');
    setPendingCreate(null);
    setPendingCreates([]); setMatchingAlbums([]);
    setShareAlbum(null);
    setSubmitAlbum(null);
    submitTargetRef.current = null;
    setSubmitPendingSubmission(null);
    setNewFolderName('');
    setNewFolderDescription('');
    setSubmitName('');
    setSubmitDescription('');
    setSubmitNote('');
    setSubmitFolderId('');
    setActionAlbumId(null);
    setActionFolderId(null);
    setActionSubmissionId(null);
    if (accountId) {
      try {
        const draft = JSON.parse(window.localStorage.getItem(`${CREATE_DRAFT_PREFIX}:${boundaryKey}`) || 'null');
        if (draft?.schema === 1 && typeof draft.input?.name === 'string'
          && typeof draft.input?.description === 'string'
          && (draft.input.album_type === 'personal' || draft.input.album_type === 'project')
          && (draft.input.album_type === 'personal' || safeId(draft.input.project_id))
          && (!projectContextId || (draft.input.album_type === 'project' && draft.input.project_id === projectContextId))) {
          setName(draft.input.name);
          setDescription(draft.input.description);
          setAlbumType(draft.input.album_type);
          setProjectId(draft.input.project_id || '');
        }
      } catch { /* Invalid drafts do not alter the explicit project. */ }
      try {
        const recovery = JSON.parse(window.localStorage.getItem(`${CREATE_RECOVERY_PREFIX}:${boundaryKey}`) || 'null');
        const records = recovery?.schema === 2 && Array.isArray(recovery.inputs) ? recovery.inputs
          : recovery?.schema === 1 ? [recovery.input] : [];
        const validRecords = records.filter((input: CreateInput) => validCreateInput(input, projectContextId));
        setPendingCreates(validRecords);
        if (validRecords.length) {
          const input: CreateInput = validRecords[0];
          setPendingCreate(input);
          setName(input.name);
          setDescription(input.description);
          setAlbumType(input.album_type);
          setProjectId(input.project_id || '');
          setCreateError('上次创建结果待确认，请先核对原图集，不会自动再次创建。');
        }
      } catch { /* Do not replay a damaged recovery record. */ }
    }
  }, [accountId, boundaryKey, projectContextId]);

  useEffect(() => {
    if (!positionReady || creating || pendingCreate) return;
    try {
      const key = `${CREATE_DRAFT_PREFIX}:${boundaryKey}`;
      if (!name && !description) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, JSON.stringify({
        schema: 1, input: {
          name, description, album_type: projectContextId ? 'project' : albumType,
          project_id: projectContextId || (albumType === 'project' ? projectId : undefined),
        },
      }));
    } catch { /* Closing the dialog still keeps its input in this page. */ }
  }, [albumType, boundaryKey, creating, description, name, pendingCreate, positionReady, projectContextId, projectId]);

  useEffect(() => {
    if (!positionReady) return;
    try {
      window.localStorage.setItem(`${PREFERENCES_PREFIX}:${boundaryKey}`, JSON.stringify({
        schema: 1, page, folderId: selectedFolderId, anchorId,
      }));
    } catch { /* The explicit list URL still preserves its position. */ }
  }, [anchorId, boundaryKey, page, positionReady, selectedFolderId]);

  useEffect(() => {
    if (!accountId) return;
    const epoch = boundaryRef.current.epoch;
    const controller = new AbortController();
    setProjectDirectoryError('');
    fetch('/api/projects?lite=true&include_archived=true', { cache: 'no-store', signal: controller.signal })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '项目列表读取失败');
        if (!controller.signal.aborted && isCurrent(epoch)) setProjects(data.projects || []);
      })
      .catch(() => {
        if (!controller.signal.aborted && isCurrent(epoch)) setProjectDirectoryError('项目列表读取失败，可刷新重试；当前项目不会改成个人图集。');
      });
    return () => controller.abort();
  }, [accountId, boundaryKey, isCurrent, reloadVersion]);

  useEffect(() => {
    if (!accountId || !projectToVerify) return;
    const epoch = boundaryRef.current.epoch;
    const controller = new AbortController();
    setVerifiedProject({ key: '', project: null, error: '' });
    if (!safeId(projectToVerify)) {
      setVerifiedProject({ key: verificationKey, project: null, error: '项目链接无效，请回到原项目重新打开。' });
      return;
    }
    fetch(`/api/projects/${encodeURIComponent(projectToVerify)}?section=albums`, { cache: 'no-store', signal: controller.signal })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(res.status === 403 || res.status === 404
          ? '项目不存在或你已无权访问，不能在这里创建图集。' : '项目读取失败，请重试，未改为个人图集。');
        if (data.viewer_id !== accountId || data.project?.id !== projectToVerify) throw new Error('项目身份未能确认，请重新读取。');
        if (!controller.signal.aborted && isCurrent(epoch)) setVerifiedProject({
          key: verificationKey,
          project: { ...data.project, my_role: data.permissions?.role || null, can_manage_assets: data.permissions?.can_manage_assets === true },
          error: '',
        });
      })
      .catch((err) => {
        if (!controller.signal.aborted && isCurrent(epoch)) setVerifiedProject({
          key: verificationKey, project: null,
          error: err instanceof Error ? err.message : '项目读取失败，请重试。',
        });
      });
    return () => controller.abort();
  }, [accountId, boundaryKey, isCurrent, projectToVerify, reloadVersion, verificationKey]);

  useEffect(() => () => {
    boundaryRef.current.epoch += 1;
    albumRequestRef.current?.abort();
  }, []);

  function projectDisplayName(project: ProjectOption) {
    return project.type === 'personal' ? '个人空间' : project.name;
  }

  function canSubmitAlbumToPublic(album: AlbumItem) {
    return album.permissions.edit && !['public', 'system'].includes(album.album_type);
  }

  function canManageAlbumSharing(album: AlbumItem) {
    return Boolean(album.can_share) && !['public', 'system'].includes(album.album_type);
  }

  const loadFolders = useCallback(() => {
    if (!accountId) return;
    const epoch = boundaryRef.current.epoch;
    setFolderLoading(true);
    fetch('/api/reference-album-folders', { cache: 'no-store' })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!isCurrent(epoch)) return;
        if (!ok) throw new Error(data.error || data.message || '公共文件夹读取失败');
        const list: PublicFolder[] = data.folders || [];
        setFolders(list);
        setCanManagePublicFolders(Boolean(data.can_manage));
        setSubmitFolderId((current) => current || list[0]?.id || '');
      })
      .catch((err) => { if (isCurrent(epoch)) setError(err instanceof Error ? err.message : '公共文件夹读取失败'); })
      .finally(() => { if (isCurrent(epoch)) setFolderLoading(false); });
  }, [accountId, boundaryKey, isCurrent]);

  const loadAlbums = useCallback(async () => {
    if (!positionReady || projectContextBlocked || (projectFilterId !== 'all' && !safeId(projectFilterId))) return null;
    const epoch = boundaryRef.current.epoch;
    albumRequestRef.current?.abort();
    const controller = new AbortController();
    albumRequestRef.current = controller;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ scope });
    if ((scope === 'project' || scope === 'other_project') && projectFilterId !== 'all') {
      params.set('project_id', projectFilterId);
    }
    if (scope === 'public' && selectedFolderId !== 'all') params.set('public_folder_id', selectedFolderId);
    try {
      const res = await fetch(`/api/reference-albums?${params.toString()}`, { cache: 'no-store', signal: controller.signal });
      const data = await res.json();
      if (controller.signal.aborted || !isCurrent(epoch)) return null;
      if (!res.ok) {
        if ([401, 403, 404].includes(res.status)) { setAlbums([]); setLoadedListKey(''); }
        throw new Error(data.error || data.message || '图集读取失败');
      }
      const list: AlbumItem[] = data.albums || [];
      setAlbums(list);
      setLoadedListKey(listKey);
      return list;
    } catch (err) {
      if (!controller.signal.aborted && isCurrent(epoch)) setError(err instanceof Error ? err.message : '图集读取失败');
      return null;
    } finally {
      if (!controller.signal.aborted && isCurrent(epoch)) setLoading(false);
    }
  }, [isCurrent, listKey, positionReady, projectContextBlocked, projectFilterId, scope, selectedFolderId]);

  const loadPendingSubmissions = useCallback(() => {
    if (!accountId || !isAdmin) return;
    const epoch = boundaryRef.current.epoch;
    fetch('/api/admin/reference-album-submissions?status=pending', { cache: 'no-store' })
      .then((res) => res.ok ? res.json() : null)
      .then((data) => { if (isCurrent(epoch)) setPendingSubmissions(data?.submissions || []); })
      .catch(() => {});
  }, [accountId, boundaryKey, isAdmin, isCurrent]);

  useEffect(() => {
    loadFolders();
  }, [loadFolders]);

  useEffect(() => {
    void loadAlbums();
    return () => albumRequestRef.current?.abort();
  }, [loadAlbums, reloadVersion]);

  useEffect(() => {
    loadPendingSubmissions();
  }, [loadPendingSubmissions]);

  const restoredAnchorRef = useRef('');
  useEffect(() => {
    if (!positionReady || loadedListKey !== listKey || loading || !anchorId) return;
    const key = `${boundaryKey}:${currentPage}:${anchorId}`;
    if (restoredAnchorRef.current === key) return;
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(`collection-${anchorId}`);
      if (element) element.scrollIntoView({ block: 'center' });
      restoredAnchorRef.current = key;
    });
    return () => cancelAnimationFrame(frame);
  }, [anchorId, boundaryKey, currentPage, listKey, loadedListKey, loading, positionReady]);

  const finishCreate = (input: CreateInput, albumId: string) => {
    const remaining = pendingCreates.filter((record) => createIdentity(record) !== createIdentity(input));
    try {
      if (remaining.length) window.localStorage.setItem(`${CREATE_RECOVERY_PREFIX}:${boundaryKey}`, JSON.stringify({ schema: 2, inputs: remaining }));
      else window.localStorage.removeItem(`${CREATE_RECOVERY_PREFIX}:${boundaryKey}`);
      window.localStorage.removeItem(`${CREATE_DRAFT_PREFIX}:${boundaryKey}`);
    } catch { /* Keep browsing usable. */ }
    setPendingCreate(null);
    setPendingCreates(remaining); setMatchingAlbums([]);
    setName('');
    setDescription('');
    setCreateError('');
    setCreateOpen(false);
    updateLocation({
      scope: input.album_type === 'project' ? 'project' : 'mine',
      project_id: input.project_id || null,
      page: '1', anchor: albumId,
    });
    setReloadVersion((value) => value + 1);
  };

  const handleCheckCreate = async () => {
    if (!pendingCreate || createBusyRef.current || !accountId) return;
    const epoch = boundaryRef.current.epoch;
    createBusyRef.current = true;
    setCreating(true);
    setCreateError('');
    setMatchingAlbums([]);
    try {
      const params = new URLSearchParams({ scope: pendingCreate.album_type === 'project' ? 'project' : 'mine' });
      if (pendingCreate.project_id) params.set('project_id', pendingCreate.project_id);
      const res = await fetch(`/api/reference-albums?${params.toString()}`, { cache: 'no-store' });
      const data = await res.json();
      if (!isCurrent(epoch)) return;
      if (!res.ok) throw new Error(data.error || '原图集读取失败，请稍后核对。');
      const found = (data.albums as AlbumItem[] || []).filter((album) => album.owner?.id === accountId
        && album.name === pendingCreate.name.trim() && album.album_type === pendingCreate.album_type
        && (album.project_id || null) === (pendingCreate.project_id || null));
      if (found.length) {
        setMatchingAlbums(found);
        setCreateError(found.length === 1
          ? '已有一个同名图集，可直接查看；这不能确认上次提交是否成功，原待核记录仍保留。'
          : '存在多个同名图集，不能确定原创建结果。可分别查看，原待核记录仍保留。');
      }
      else setCreateError('暂未找到可确认的原图集，创建结果仍待确认。可以关闭后继续其他工作，稍后再核对。');
    } catch (err) {
      if (isCurrent(epoch)) setCreateError(err instanceof Error ? err.message : '核对未完成，创建结果仍待确认。');
    } finally {
      if (isCurrent(epoch)) { createBusyRef.current = false; setCreating(false); }
    }
  };

  const handleCreate = async () => {
    if (!name.trim() || !accountId || createBusyRef.current || pendingCreate) return;
    const input: CreateInput = {
      name: name.trim(), description: description.trim(),
      album_type: projectContextId ? 'project' : albumType,
      ...((projectContextId || albumType === 'project') ? { project_id: projectContextId || projectId } : {}),
    };
    const unresolved = pendingCreates.find((record) => createIdentity(record) === createIdentity(input));
    if (unresolved) {
      setPendingCreate(unresolved); setName(unresolved.name); setDescription(unresolved.description);
      setCreateError('这个目标和名称已有一次创建待确认，只能查询，不会再次发送。');
      return;
    }
    if (input.album_type === 'project' && (!input.project_id || !projectCanCreate || currentProject?.id !== input.project_id)) {
      setCreateError(projectError || '请先确认有权管理的项目，未改为个人图集。');
      return;
    }
    const epoch = boundaryRef.current.epoch;
    createBusyRef.current = true;
    setCreating(true);
    setCreateError('');
    let responseReceived = false;
    let responseAccepted = false;
    const retained = [...pendingCreates, input];
    try {
      // This is a recovery marker, never a command to replay on restore.
      window.localStorage.setItem(`${CREATE_RECOVERY_PREFIX}:${boundaryKey}`, JSON.stringify({ schema: 2, inputs: retained }));
    } catch { /* The current dialog still retains the original input. */ }
    try {
      const res = await fetch('/api/reference-albums', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      responseReceived = res.status < 500;
      responseAccepted = res.ok;
      const data = await res.json();
      if (!isCurrent(epoch)) return;
      if (!res.ok) throw new Error(data.error || data.message || '创建图集失败');
      if (!safeId(data.album?.id) || data.album.album_type !== input.album_type
        || (data.album.project_id || null) !== (input.project_id || null)) {
        responseReceived = false;
        throw new Error('创建结果待确认');
      }
      finishCreate(input, data.album.id);
    } catch (err) {
      if (!isCurrent(epoch)) return;
      if (!responseReceived || responseAccepted) {
        setPendingCreates(retained);
        setPendingCreate(input);
        setCreateError('创建结果待确认，输入已保留。请核对原图集，不要再次创建。');
      } else {
        try {
          if (pendingCreates.length) window.localStorage.setItem(`${CREATE_RECOVERY_PREFIX}:${boundaryKey}`, JSON.stringify({ schema: 2, inputs: pendingCreates }));
          else window.localStorage.removeItem(`${CREATE_RECOVERY_PREFIX}:${boundaryKey}`);
        } catch { /* No automatic replay. */ }
        setCreateError(err instanceof Error ? err.message : '创建图集未完成，输入已保留。');
      }
    } finally {
      if (isCurrent(epoch)) { createBusyRef.current = false; setCreating(false); }
    }
  };

  const handleCreateFolder = async () => {
    const folderName = newFolderName.trim();
    if (!folderName) return;
    const epoch = boundaryRef.current.epoch;
    setFolderLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/reference-album-folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: folderName, description: newFolderDescription }),
      });
      const data = await res.json();
      if (!isCurrent(epoch)) return;
      if (!res.ok) throw new Error(data.error || data.message || '创建公共文件夹失败');
      setNewFolderName('');
      setNewFolderDescription('');
      setSelectedFolderId(data.folder.id);
      loadFolders();
    } catch (err) {
      if (isCurrent(epoch)) setError(err instanceof Error ? err.message : '创建公共文件夹失败');
    } finally {
      if (isCurrent(epoch)) setFolderLoading(false);
    }
  };

  const handleRenameFolder = async (folder: PublicFolder) => {
    const epoch = boundaryRef.current.epoch;
    const nextName = (await prompt('输入新的公共文件夹名称', folder.name, { title: '文件夹名称', maxLength: null }))?.trim();
    if (!isCurrent(epoch) || !nextName || nextName === folder.name) return;
    setActionFolderId(folder.id);
    setError(null);
    try {
      const res = await fetch(`/api/reference-album-folders/${folder.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nextName }),
      });
      const data = await res.json();
      if (!isCurrent(epoch)) return;
      if (!res.ok) throw new Error(data.error || data.message || '重命名公共文件夹失败');
      loadFolders();
    } catch (err) {
      if (isCurrent(epoch)) setError(err instanceof Error ? err.message : '重命名公共文件夹失败');
    } finally {
      if (isCurrent(epoch)) setActionFolderId(null);
    }
  };

  const handleDeleteFolder = async (folder: PublicFolder) => {
    const epoch = boundaryRef.current.epoch;
    const confirmed = await confirm(`删除公共文件夹「${folder.name}」？只有空文件夹可以删除。`, { title: '删除文件夹', confirmLabel: '删除文件夹', danger: true });
    if (!isCurrent(epoch) || !confirmed) return;
    setActionFolderId(folder.id);
    setError(null);
    try {
      const res = await fetch(`/api/reference-album-folders/${folder.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!isCurrent(epoch)) return;
      if (!res.ok) throw new Error(data.error || data.message || '删除公共文件夹失败');
      setSelectedFolderId('all');
      loadFolders();
      loadAlbums();
    } catch (err) {
      if (isCurrent(epoch)) setError(err instanceof Error ? err.message : '删除公共文件夹失败');
    } finally {
      if (isCurrent(epoch)) setActionFolderId(null);
    }
  };

  const handleRenameAlbum = async (album: AlbumItem) => {
    const epoch = boundaryRef.current.epoch;
    const nextName = (await prompt('输入新的图集名称', album.name, { title: '图集名称', maxLength: null }))?.trim();
    if (!isCurrent(epoch) || !nextName || nextName === album.name) return;

    setActionAlbumId(album.id);
    setError(null);
    try {
      const res = await fetch(`/api/reference-albums/${album.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nextName }),
      });
      const data = await res.json();
      if (!isCurrent(epoch)) return;
      if (!res.ok) throw new Error(data.error || data.message || '重命名失败');
      setAlbums((current) => current.map((item) => (
        item.id === album.id
          ? { ...item, name: data.album?.name || nextName, updated_at: data.album?.updated_at || item.updated_at }
          : item
      )));
    } catch (err) {
      if (isCurrent(epoch)) setError(err instanceof Error ? err.message : '重命名失败');
    } finally {
      if (isCurrent(epoch)) setActionAlbumId(null);
    }
  };

  const handleDeleteAlbum = async (album: AlbumItem) => {
    const epoch = boundaryRef.current.epoch;
    const confirmed = await confirm(`删除图集「${album.name}」？图集会从列表隐藏，历史任务引用的参考图仍会保留。`, { title: '删除图集', confirmLabel: '删除图集', danger: true });
    if (!isCurrent(epoch) || !confirmed) return;

    setActionAlbumId(album.id);
    setError(null);
    try {
      const res = await fetch(`/api/reference-albums/${album.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!isCurrent(epoch)) return;
      if (!res.ok) throw new Error(data.error || data.message || '删除图集失败');
      setAlbums((current) => current.filter((item) => item.id !== album.id));
      loadFolders();
    } catch (err) {
      if (isCurrent(epoch)) setError(err instanceof Error ? err.message : '删除图集失败');
    } finally {
      if (isCurrent(epoch)) setActionAlbumId(null);
    }
  };

  const openSubmitPanel = async (album: AlbumItem) => {
    const epoch = boundaryRef.current.epoch;
    submitTargetRef.current = album.id;
    setSubmitAlbum(album);
    setError(null);
    setSubmitPendingSubmission(null);
    setSubmitName(album.name);
    setSubmitDescription(album.description || '');
    setSubmitNote('');
    setSubmitFolderId(folders[0]?.id || '');

    try {
      const res = await fetch(`/api/reference-albums/${album.id}/public-submissions`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (!isCurrent(epoch) || submitTargetRef.current !== album.id) return;
      const pending: PublicSubmission | null = data?.submission || null;
      if (!pending || pending.status !== 'pending') return;
      setSubmitPendingSubmission(pending);
      setSubmitName(pending.name || album.name);
      setSubmitDescription(pending.description || album.description || '');
      setSubmitNote(pending.submit_note || '');
      if (pending.public_folder_id) setSubmitFolderId(pending.public_folder_id);
    } catch {
      // ignore
    }
  };

  const handleSubmitToPublic = async (replace = false) => {
    if (!submitAlbum) return;
    const epoch = boundaryRef.current.epoch;
    if (!submitFolderId) {
      setError('请先选择公共文件夹');
      return;
    }
    setActionAlbumId(submitAlbum.id);
    setError(null);
    try {
      const res = await fetch(`/api/reference-albums/${submitAlbum.id}/public-submissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          public_folder_id: submitFolderId,
          name: submitName,
          description: submitDescription,
          submit_note: submitNote,
          replace,
        }),
      });
      const data = await res.json();
      if (!isCurrent(epoch)) return;
      if (!res.ok) throw new Error(data.error || data.message || '提交公共图集失败');
      if (data.deduplicated) {
        setSubmitPendingSubmission(data.submission || null);
        setError('该图集已有待审核提交，请先确认覆盖重提，避免重复等待。');
        return;
      }

      setSubmitAlbum(null);
      submitTargetRef.current = null;
      setSubmitPendingSubmission(null);
      setScope(isAdmin ? 'public' : scope);
      setError(isAdmin
        ? data.replaced ? '已更新并同步到公共图集' : '已复制到公共图集'
        : (replace ? '已覆盖重提，等待管理员审核' : '已提交审核，管理员通过后会进入公共图集'));
      loadAlbums();
      loadFolders();
      loadPendingSubmissions();
    } catch (err) {
      if (isCurrent(epoch)) setError(err instanceof Error ? err.message : '提交公共图集失败');
    } finally {
      if (isCurrent(epoch)) setActionAlbumId(null);
    }
  };

  const handleReviewSubmission = async (submission: PublicSubmission, action: 'approve' | 'reject') => {
    const epoch = boundaryRef.current.epoch;
    const reviewNoteInput = action === 'reject'
      ? await prompt('填写拒绝原因，可留空', '', { title: '拒绝原因', confirmLabel: '确认拒绝', allowEmpty: true, multiline: true, maxLength: null })
      : '';
    if (!isCurrent(epoch) || reviewNoteInput === null) return;
    const reviewNote = reviewNoteInput.trim();
    setActionSubmissionId(submission.id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/reference-album-submissions/${submission.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, review_note: reviewNote }),
      });
      const data = await res.json();
      if (!isCurrent(epoch)) return;
      if (!res.ok) throw new Error(data.error || data.message || '审核失败');
      loadPendingSubmissions();
      loadAlbums();
      loadFolders();
    } catch (err) {
      if (isCurrent(epoch)) setError(err instanceof Error ? err.message : '审核失败');
    } finally {
      if (isCurrent(epoch)) setActionSubmissionId(null);
    }
  };

  if (!accountId) return (
    <div className={styles.notice} role="status">
      {userLoadError || (sessionChanged ? '登录账号已变化，请重新确认后查看图集。' : hasLoadedUser ? '请先登录后查看图集。' : '正在确认登录状态...')}
      {userLoadError && <button type="button" onClick={() => void refreshUser({ force: true })}>重新读取</button>}
    </div>
  );

  if (!positionReady) return <div className={styles.notice} role="status">正在恢复图集位置...</div>;

  return (
    <div className={styles.root}>
      {productDialog}
      <PageBanner
        backHref={safeReturnTo && (!projectContextId || currentProject) ? safeReturnTo : projectContextId ? '/projects' : undefined}
        backLabel={projectContextId && currentProject ? '返回原项目' : '返回我的项目'}
        eyebrow="参考资产"
        title={projectContextId && currentProject ? `${projectDisplayName(currentProject)} · 参考图集` : '参考图集'}
        description={projectContextId ? undefined : '管理个人、项目、共享与公共参考图集。'}
      />

      <div className="album-tabs">
        {visibleTabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            className={scope === tab.value ? 'active' : ''}
            onClick={() => setScope(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {(scope === 'project' || scope === 'other_project') && (
        <section className="album-project-filter">
          <div>
            <strong>{scope === 'other_project' ? '其他人的项目图集' : '项目图集'}</strong>
            <span>
              {scope === 'other_project'
                ? '管理员可按项目筛选其他人创建的项目图集。'
                : projectContextId ? '当前项目的参考图集' : '所有可访问的项目图集'}
            </span>
          </div>
          <select aria-label="筛选项目图集" value={projectFilterId} onChange={(event) => setProjectFilterId(event.target.value)}>
            <option value="all">{scope === 'other_project' ? '全部他人项目' : '全部项目'}</option>
            {projectFilterId !== 'all' && !projectFilterChoices.some((project) => project.id === projectFilterId) && (
              <option value={projectFilterId}>{currentProject ? projectDisplayName(currentProject) : '链接指定的项目'}</option>
            )}
            {projectFilterChoices.map((project) => (
              <option key={project.id} value={project.id}>{projectDisplayName(project)}</option>
            ))}
          </select>
        </section>
      )}

      {(projectDirectoryError || projectError || (projectContextId && checkingProject)) && (
        <div className={styles.notice} role="status">
          {projectError || projectDirectoryError || '正在确认项目及图集权限...'}
          {(projectError || projectDirectoryError) && <button type="button" onClick={() => setReloadVersion((value) => value + 1)}>重新读取</button>}
          {projectContextId && <Link href="/projects"><ArrowLeft size={15} aria-hidden="true" />我的项目</Link>}
        </div>
      )}

      {scope === 'public' && (
        <section className="album-public-folders">
          <div className="album-public-folder-head">
            <div>
              <h2>公共文件夹</h2>
              <p>公共图集按文件夹组织；删除文件夹前必须先移走或归档里面的图集。</p>
            </div>
            {folderLoading && <span>同步中...</span>}
          </div>
          <div className="album-folder-strip" role="tablist" aria-label="公共图集文件夹">
            <button
              type="button"
              className={selectedFolderId === 'all' ? 'active' : ''}
              onClick={() => setSelectedFolderId('all')}
            >
              全部
              <span>{folders.reduce((sum, folder) => sum + folder.album_count, 0)}</span>
            </button>
            {folders.map((folder) => (
              <div key={folder.id} className={`album-folder-chip ${selectedFolderId === folder.id ? 'active' : ''}`}>
                <button type="button" onClick={() => setSelectedFolderId(folder.id)}>
                  {folder.name}
                  <span>{folder.album_count}</span>
                </button>
                {canManagePublicFolders && (
                  <div className="album-folder-actions">
                    <button type="button" onClick={() => handleRenameFolder(folder)} disabled={actionFolderId === folder.id}>改名</button>
                    <button type="button" onClick={() => handleDeleteFolder(folder)} disabled={actionFolderId === folder.id}>删除</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {canManagePublicFolders && (
            <div className="album-folder-create">
              <input value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} placeholder="新公共文件夹" />
              <input value={newFolderDescription} onChange={(event) => setNewFolderDescription(event.target.value)} placeholder="说明，可选" />
              <button type="button" onClick={handleCreateFolder} disabled={!newFolderName.trim() || folderLoading}>新建文件夹</button>
            </div>
          )}
        </section>
      )}

      {scope === 'public' && isAdmin && pendingSubmissions.length > 0 && (
        <section className="album-review-panel">
          <div className="album-review-head">
            <h2>待审核提交</h2>
            <span>{pendingSubmissions.length} 个</span>
          </div>
          <div className="album-review-list">
            {pendingSubmissions.map((submission) => (
              <article key={submission.id} className="album-review-item">
                <div className="album-review-cover">
                  {submission.source_album?.cover_image_url ? (
                    <img src={submission.source_album.cover_image_url} alt={submission.name} />
                  ) : (
                    <span>{submission.source_album?.image_count || 0} 张</span>
                  )}
                </div>
                <div className="album-review-copy">
                  <strong>{submission.name}</strong>
                  <span className="album-review-submitter">
                    <UserIdentityBadge user={submission.submitted_by} size="sm" />
                    <span>提交到 {submission.public_folder?.name || '未指定文件夹'}</span>
                  </span>
                  {submission.submit_note && <p>{submission.submit_note}</p>}
                </div>
                <div className="album-review-actions">
                  <button
                    type="button"
                    onClick={() => handleReviewSubmission(submission, 'reject')}
                    disabled={actionSubmissionId === submission.id}
                  >
                    拒绝
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => handleReviewSubmission(submission, 'approve')}
                    disabled={actionSubmissionId === submission.id}
                  >
                    通过并复制
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      <div className={styles.toolbar}>
        <div>
          {projectContextId && currentProject && !projectCanCreate && <span>当前项目只可查看，不能新建图集。</span>}
          {pendingCreates.length > 0 && <span>有图集创建结果待确认</span>}
        </div>
        <div className={styles.toolbarActions}>
          <button type="button" className={styles.quietButton} title="清除上次位置" aria-label="清除上次位置" onClick={() => {
            try { window.localStorage.removeItem(`${PREFERENCES_PREFIX}:${boundaryKey}`); } catch { /* Explicit URL remains usable. */ }
            setPosition({ key: boundaryKey, page: 1, folderId: 'all', anchorId: '' });
            updateLocation({ page: '1', public_folder_id: 'all', anchor: '' });
          }}><RotateCcw size={17} aria-hidden="true" /></button>
          <button type="button" className={styles.primaryButton}
            disabled={!pendingCreate && Boolean(projectContextId && (!projectCanCreate || projectContextBlocked))}
            onClick={() => setCreateOpen(true)}>
            <Plus size={17} aria-hidden="true" />
            {pendingCreate ? '核对创建结果' : projectContextId ? '新建项目图集' : '新建图集'}
          </button>
        </div>
      </div>

      {pendingCreates.length > 0 && <div className={styles.recoveryList} aria-label="待核对的图集创建">
        {pendingCreates.map((input) => <button key={createIdentity(input)} type="button" className={styles.recoveryButton} disabled={creating} onClick={() => {
          setPendingCreate(input); setName(input.name); setDescription(input.description);
          setAlbumType(input.album_type); setProjectId(input.project_id || ''); setMatchingAlbums([]); setCreateError(''); setCreateOpen(true);
        }}>核对“{input.name}”</button>)}
      </div>}

      {createOpen && createPortal(
        <div className={styles.backdrop} ref={createSurfaceRef}>
          <div ref={createDialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="collection-create-title">
            <header className={styles.dialogHeader}>
              <h2 id="collection-create-title">{projectContextId ? '新建项目图集' : '新建图集'}</h2>
              <button type="button" className={styles.quietButton} title="关闭" aria-label="关闭新建图集" onClick={closeCreate} disabled={creating}><X size={19} aria-hidden="true" /></button>
            </header>
            <form className={styles.createForm} onSubmit={(event) => { event.preventDefault(); void (pendingCreate ? handleCheckCreate() : handleCreate()); }}>
              <label>图集名称
                <input ref={createNameRef} value={name} onChange={(event) => setName(event.target.value)} disabled={creating || Boolean(pendingCreate)} autoComplete="off" />
              </label>
              {projectContextId ? (
                <label>归属
                  <span className={styles.projectTarget}>{currentProject ? `${projectDisplayName(currentProject)}（当前项目）` : '原项目待确认'}</span>
                </label>
              ) : (
                <>
                  <label>归属
                    <select value={albumType} onChange={(event) => setAlbumType(event.target.value as 'personal' | 'project')} disabled={creating || Boolean(pendingCreate)}>
                      <option value="personal">个人图集</option>
                      <option value="project">项目图集</option>
                    </select>
                  </label>
                  {albumType === 'project' && <label>项目
                    <select value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={creating || Boolean(pendingCreate)}>
                      <option value="">选择项目</option>
                      {projectId && !projectChoices.some((project) => project.id === projectId) && <option value={projectId}>{currentProject ? projectDisplayName(currentProject) : '原项目待确认'}</option>}
                      {projectChoices.map((project) => <option key={project.id} value={project.id}>{projectDisplayName(project)}</option>)}
                    </select>
                  </label>}
                </>
              )}
              <label>可见范围
                <span className={styles.projectTarget}>{projectContextId || albumType === 'project' ? '项目成员可见' : '仅本人可见'}</span>
              </label>
              <label>说明（可选）
                <textarea value={description} onChange={(event) => setDescription(event.target.value)} disabled={creating || Boolean(pendingCreate)} rows={4} />
              </label>
              {(createError || projectError || checkingProject || (projectToVerify && currentProject && !projectCanCreate)) && (
                <p className={styles.formNotice} role="status">{createError || projectError || (checkingProject ? '正在确认项目权限...' : '当前项目不可新建图集，原项目未改变。')}</p>
              )}
              {matchingAlbums.map((album) => <Link key={album.id} href={`/collections/${encodeURIComponent(album.id)}?return_to=${encodeURIComponent(collectionListHref(album.id))}`}>查看已有图集“{album.name}”</Link>)}
              <footer className={styles.dialogActions}>
                <button type="button" onClick={closeCreate} disabled={creating}>取消</button>
                {pendingCreate && <button type="button" disabled={creating} onClick={() => {
                  setPendingCreate(null); setMatchingAlbums([]); setName(''); setDescription('');
                  setCreateError('原待核记录保留，可使用不同名称主动新建其它图集。');
                }}>新建其它图集</button>}
                <button type="submit" className={styles.primaryButton} disabled={creating || (!pendingCreate && (!name.trim() || Boolean((projectContextId || albumType === 'project') && !projectCanCreate)))}>
                  {creating ? pendingCreate ? '正在核对...' : '正在创建...' : pendingCreate ? '核对原图集' : '创建图集'}
                </button>
              </footer>
            </form>
          </div>
        </div>, document.body,
      )}

      {submitAlbum && (
        <section className="album-public-submit-panel">
          <div>
            <h2>提交到公共图集</h2>
            <p>系统会复制一份公共版本，原图集仍保持私有或项目权限。</p>
          </div>
          <div className="album-public-submit-form">
            <select value={submitFolderId} onChange={(event) => setSubmitFolderId(event.target.value)}>
              <option value="">选择公共文件夹</option>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>{folder.name}</option>
              ))}
            </select>
            <input value={submitName} onChange={(event) => setSubmitName(event.target.value)} placeholder="公共图集名称" />
            <input value={submitDescription} onChange={(event) => setSubmitDescription(event.target.value)} placeholder="公共说明，可选" />
            <textarea value={submitNote} onChange={(event) => setSubmitNote(event.target.value)} placeholder="给管理员的说明，可选" />
            {submitPendingSubmission && (
              <div className="album-public-submit-pending">
                当前已有待审核提交：<RelativeTime value={submitPendingSubmission.created_at} />，
                提交到 {submitPendingSubmission.public_folder?.name || '原文件夹'}
              </div>
            )}
          </div>
          <div className="album-public-submit-actions">
            <button
              type="button"
              onClick={() => {
                submitTargetRef.current = null;
                setSubmitAlbum(null);
                setSubmitPendingSubmission(null);
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => handleSubmitToPublic()}
              disabled={!submitFolderId || !submitName.trim() || actionAlbumId === submitAlbum.id}
            >
              {isAdmin ? '直接复制到公共库' : '提交审核'}
            </button>
            {submitPendingSubmission && !isAdmin && (
              <button type="button" onClick={() => handleSubmitToPublic(true)} disabled={!submitFolderId || !submitName.trim() || actionAlbumId === submitAlbum.id}>
                覆盖重提
              </button>
            )}
          </div>
        </section>
      )}

      <ShareAlbumDialog
        open={Boolean(shareAlbum)}
        album={shareAlbum}
        onClose={() => setShareAlbum(null)}
        onChanged={loadAlbums}
      />

      {error && <div className={styles.notice} role="status">{error}<button type="button" onClick={() => void loadAlbums()}>重新读取图集</button></div>}

      <div className="album-grid" aria-busy={loading}>
        {projectContextBlocked ? (
          <div className="album-empty">{projectError ? '项目图集暂不可读取，请使用上方入口核对权限或返回。' : '正在确认项目...'}</div>
        ) : !safeId(projectFilterId) && projectFilterId !== 'all' ? (
          <div className="album-empty">项目链接无效，未改为全部项目。</div>
        ) : loadedListKey !== listKey ? (
          <div className="album-empty">{error ? '图集读取未完成，可保留条件重新读取。' : '读取中...'}</div>
        ) : loading && albums.length === 0 ? (
          <div className="album-empty">读取中...</div>
        ) : albums.length === 0 ? (
          <div className="album-empty">暂无图集</div>
        ) : (
          pagedAlbums.map((album) => {
            const coverFailed = failedCoverIds.has(album.id);
            const canSubmitPublic = canSubmitAlbumToPublic(album);
            const canShareAlbum = canManageAlbumSharing(album);
            return (
              <article key={album.id} id={`collection-${album.id}`} className="album-card">
                <Link href={`/collections/${encodeURIComponent(album.id)}?return_to=${encodeURIComponent(collectionListHref(album.id))}`} className="album-card-main" onClick={() => {
                  try { window.localStorage.setItem(`${PREFERENCES_PREFIX}:${boundaryKey}`, JSON.stringify({ schema: 1, page: currentPage, folderId: selectedFolderId, anchorId: album.id })); } catch { /* The detail URL also carries the list position. */ }
                }}>
                  <div className="album-card-cover">
                    {album.cover_image_url && !coverFailed ? (
                      <img
                        src={album.cover_image_url}
                        alt={`${album.name} 封面`}
                        onError={() => setFailedCoverIds((current) => new Set(current).add(album.id))}
                      />
                    ) : (
                      <span>{album.image_count > 0 ? `${album.image_count} 张` : '空图集'}</span>
                    )}
                  </div>
                  <div className="album-card-body">
                    <div className="album-card-title-row">
                      <UserIdentityBadge user={album.owner} size="sm" avatarOnly />
                      <div className="album-card-title">{album.name}</div>
                    </div>
                    <div className="album-card-meta">
                      <span>
                        {album.public_folder?.name
                          || album.project?.name
                          || (album.album_type === 'public' ? '公共图集' : album.album_type === 'project' ? '项目图集' : '个人图集')}
                      </span>
                    </div>
                    <div className="album-card-perms">
                      {album.permissions.view && <span>可查看</span>}
                      {album.permissions.use && <span>可生成</span>}
                      {album.permissions.copy && <span>可复制</span>}
                      {album.permissions.edit && <span>可编辑</span>}
                      {album.active_share_count > 0 && (
                        <span className="album-card-share-count">已共享 {album.active_share_count}</span>
                      )}
                    </div>
                  </div>
                </Link>
                <div className={`album-card-footer ${styles.cardFooter}`}>
                  <span>{album.visibility === 'private' ? '仅本人' : album.visibility === 'project' ? '项目成员' : album.visibility === 'public' ? '公共图集' : '按共享权限可见'}</span>
                  <RelativeTime value={album.updated_at} />
                </div>
                <div className="album-card-actions" aria-label={`${album.name} 管理动作`}>
                  {canShareAlbum && (
                    <button type="button" onClick={() => setShareAlbum(album)} disabled={actionAlbumId === album.id}>
                      {album.active_share_count > 0 ? '共享设置' : '转为共享'}
                    </button>
                  )}
                  {canSubmitPublic && (
                    <button type="button" onClick={() => openSubmitPanel(album)} disabled={actionAlbumId === album.id || folders.length === 0}>
                      提交公共
                    </button>
                  )}
                  {album.permissions.edit && (
                    <>
                      <button type="button" onClick={() => handleRenameAlbum(album)} disabled={actionAlbumId === album.id}>
                        重命名
                      </button>
                      <button type="button" className="danger" onClick={() => handleDeleteAlbum(album)} disabled={actionAlbumId === album.id}>
                        删除
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })
        )}
      </div>
      {loadedListKey === listKey && !projectContextBlocked && <PaginationControls
        page={currentPage}
        totalPages={totalPages}
        total={albums.length}
        pageSize={ALBUMS_PAGE_SIZE}
        label="图集"
        onPageChange={setPage}
      />}
    </div>
  );
}
