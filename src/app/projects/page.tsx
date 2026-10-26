'use client';

import { forwardRef, Suspense, useEffect, useId, useImperativeHandle, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Download, FolderKanban, MoreHorizontal, Plus, RotateCcw, Search } from 'lucide-react';
import ProjectFilters from '@/components/projects/ProjectFilters';
import PaginationControls from '@/components/PaginationControls';
import ProjectActionConfirmModal from '@/components/ProjectActionConfirmModal';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { useProductDialog } from '@/components/useProductDialog';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { RelativeTime } from '@/components/RelativeTime';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { externalFallbackPath, isExternalUser } from '@/lib/access/external-role';
import { BULK_VIDEO_DOWNLOAD_CLIENT_LIMIT, downloadBulkVideoZip } from '@/lib/video/download-client';
import { sanitizeOptionalReturnTo } from '@/lib/navigation/return-to';
import { projectStatusExpectation, useProjectCreateOperation, type ProjectCreateResult } from '@/lib/projects/client-operations';
import ProjectCreateOperationNotice from '@/components/ProjectCreateOperationNotice';
import { CompactUsageSummary } from '@/components/usage/UsageWorkspace';
import type { UsageReportDTO } from '@/lib/usage/dto';
import styles from './Projects.module.css';

interface ProjectItem {
  id: string;
  name: string;
  description: string | null;
  type: string;
  visibility: string;
  status: string;
  owner_user_id: string;
  updated_at: string;
  my_role: string | null;
  thumbnail_url?: string | null;
  active_task_count?: number;
  downloadable_task_count?: number;
  legacy_can_delete?: boolean;
  can_manage_project?: boolean;
  can_archive?: boolean;
  can_restore?: boolean;
  can_delete?: boolean;
  status_version?: { status: string; updated_at: string };
  owner?: { id?: string; name: string | null; username: string | null; avatar_url?: string | null; account_type?: string | null };
  _count?: { members: number; tasks: number; reference_albums?: number };
}

interface ProjectListResponse {
  projects: ProjectItem[];
  personal_project: ProjectItem | null;
  pagination: { page: number; page_size: number; total: number; total_pages: number };
  capabilities?: { can_create_team_project: boolean; create_operation_version: number };
  usage_summary?: Pick<UsageReportDTO, 'query' | 'summary' | 'restricted'> | null;
  usage_summary_error?: string | null;
}

interface ReviewBudgetSuggestion {
  suggested_credits: number;
  sample_count: number;
  risk_hint: string;
}

type ProjectAction = 'archive' | 'restore' | 'delete';
type PendingProjectAction = { project: ProjectItem; action: ProjectAction };
type ProjectStatusFilter = 'active' | 'archived';
type ProjectSort = 'updated' | 'name';
type ProjectScope = 'all' | 'owned' | 'participating';
type AccountOperation = 'create' | 'action' | 'rename' | 'download';
type AccountOperationSnapshot = { kind: AccountOperation; accountKey: string; epoch: number; token: number };

type ProjectRenamePromptOptions = {
  title?: string;
  confirmLabel?: string;
  maxLength?: number | null;
  onSubmit?: (value: string, checked: boolean) => Promise<void>;
};

type ProjectRenamePromptHandle = {
  prompt: (message: string, value: string, options?: ProjectRenamePromptOptions) => Promise<string | null>;
};

const ProjectRenamePromptHost = forwardRef<ProjectRenamePromptHandle>(function ProjectRenamePromptHost(_props, ref) {
  const dialog = useProductDialog();
  useImperativeHandle(ref, () => ({
    prompt: (message: string, value: string, options?: ProjectRenamePromptOptions) => dialog.prompt(message, value, options),
  }), [dialog.prompt]);
  return dialog.productDialog;
});

interface ListPreferences {
  search: string;
  status: ProjectStatusFilter;
  sort: ProjectSort;
  scope: ProjectScope;
  page: number;
}

const DEFAULT_PREFERENCES: ListPreferences = {
  search: '',
  status: 'active',
  sort: 'updated',
  scope: 'all',
  page: 1,
};
const PROJECT_PREFERENCES_VERSION = 1;
const PROJECT_PREFERENCES_PREFIX = 'sd2:projects:list:v1';

function projectPreferenceKey(userId: string) {
  return `${PROJECT_PREFERENCES_PREFIX}:${encodeURIComponent(userId)}`;
}

function parsePage(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 1;
  return Math.min(1_000_000, Math.max(1, value));
}

function normalizePreferences(value: unknown): ListPreferences {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    search: typeof source.search === 'string' ? source.search.slice(0, 120) : '',
    status: source.status === 'archived' ? 'archived' : 'active',
    sort: source.sort === 'name' ? 'name' : 'updated',
    scope: source.scope === 'owned' || source.scope === 'participating' ? source.scope : 'all',
    page: parsePage(source.page),
  };
}

function readListPreferences(userId: string): { preferences: ListPreferences; storageUnavailable: boolean } {
  let preferences = { ...DEFAULT_PREFERENCES };
  let storageUnavailable = false;
  if (userId) {
    try {
      const stored = window.localStorage.getItem(projectPreferenceKey(userId));
      if (stored) {
        const parsed = JSON.parse(stored) as { version?: unknown; preferences?: unknown };
        if (parsed?.version === PROJECT_PREFERENCES_VERSION) preferences = normalizePreferences(parsed.preferences);
      }
    } catch {
      storageUnavailable = true;
    }
  }

  const explicit = new URLSearchParams(window.location.search);
  if (explicit.has('search')) preferences.search = (explicit.get('search') || '').slice(0, 120);
  if (explicit.get('status') === 'active' || explicit.get('status') === 'archived') {
    preferences.status = explicit.get('status') as ProjectStatusFilter;
  }
  if (explicit.get('sort') === 'updated' || explicit.get('sort') === 'name') {
    preferences.sort = explicit.get('sort') as ProjectSort;
  }
  if (explicit.get('scope') === 'all' || explicit.get('scope') === 'owned' || explicit.get('scope') === 'participating') {
    preferences.scope = explicit.get('scope') as ProjectScope;
  }
  if (explicit.has('page')) {
    const page = Number(explicit.get('page'));
    if (Number.isInteger(page) && page > 0) preferences.page = Math.min(page, 1_000_000);
  }
  return { preferences, storageUnavailable };
}

function saveListPreferences(userId: string, preferences: ListPreferences) {
  if (!userId) return false;
  try {
    window.localStorage.setItem(projectPreferenceKey(userId), JSON.stringify({
      version: PROJECT_PREFERENCES_VERSION,
      preferences,
    }));
    return true;
  } catch {
    return false;
  }
}

function projectListReturnTo(projectId: string, preferences: ListPreferences) {
  const params = new URLSearchParams({
    search: preferences.search,
    status: preferences.status,
    sort: preferences.sort,
    scope: preferences.scope,
    page: String(preferences.page),
  });
  const candidate = `/projects?${params.toString()}#project-card-${encodeURIComponent(projectId)}`;
  return sanitizeOptionalReturnTo(candidate) || '/projects';
}

function projectDetailHref(projectId: string, preferences: ListPreferences, section?: 'members') {
  const params = new URLSearchParams();
  if (section) params.set('view', section);
  params.set('return_to', projectListReturnTo(projectId, preferences));
  return `/projects/${encodeURIComponent(projectId)}?${params.toString()}`;
}

function updateListUrl(preferences: ListPreferences) {
  const url = new URL(window.location.href);
  const values: Array<[keyof ListPreferences, string, string]> = [
    ['search', 'search', preferences.search],
    ['status', 'status', preferences.status],
    ['sort', 'sort', preferences.sort],
    ['scope', 'scope', preferences.scope],
    ['page', 'page', String(preferences.page)],
  ];
  for (const [key, param, value] of values) {
    const isDefault = key === 'search' ? !value
      : key === 'status' ? value === 'active'
        : key === 'sort' ? value === 'updated'
          : key === 'scope' ? value === 'all'
            : value === '1';
    if (isDefault) url.searchParams.delete(param);
    else url.searchParams.set(param, value);
  }
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

function canManageProject(project: ProjectItem): boolean {
  return project.can_manage_project === true;
}

function canShowDeleteProjectAction(project: ProjectItem): boolean {
  return project.type === 'team';
}

function projectDisplayName(project: ProjectItem): string {
  if (project.type === 'personal') return '个人空间';
  return project.name;
}

function projectOwnerUser(project: ProjectItem) {
  return project.owner || { id: project.owner_user_id, name: null, username: null };
}

function projectRoleLabel(role: string | null): string {
  if (role === 'admin') return '管理员';
  if (role === 'project_owner') return '负责人';
  if (role === 'editor') return '可编辑';
  if (role === 'member') return '可生成';
  if (role === 'viewer') return '仅查看';
  return '项目成员';
}

function projectStatusLabel(status: string): string {
  if (status === 'active') return '使用中';
  if (status === 'locked') return '已锁定 · 只读';
  if (status === 'archived') return '已归档';
  return status;
}

function projectActionMeta(project: ProjectItem): string {
  return [
    projectStatusLabel(project.status),
    `任务 ${project._count?.tasks ?? 0}`,
    `图集 ${project._count?.reference_albums ?? 0}`,
  ].join(' · ');
}

function ProjectCover({ project }: { project: ProjectItem }) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [project.thumbnail_url]);

  return (
    <div style={{
      alignItems: 'center',
      aspectRatio: '16 / 9',
      background: 'var(--bg-input)',
      borderRadius: 7,
      color: 'var(--text-secondary)',
      display: 'flex',
      justifyContent: 'center',
      overflow: 'hidden',
      position: 'relative',
      width: '100%',
    }}>
      {project.thumbnail_url && !imageFailed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={project.thumbnail_url}
          alt=""
          loading="lazy"
          onError={() => setImageFailed(true)}
          style={{ height: '100%', inset: 0, objectFit: 'cover', position: 'absolute', width: '100%' }}
        />
      ) : (
        <span aria-hidden="true" style={{ alignItems: 'center', display: 'flex', flexDirection: 'column', gap: 7 }}>
          <FolderKanban size={25} strokeWidth={1.7} />
          <span style={{ fontSize: 12 }}>暂无封面</span>
        </span>
      )}
      {project.status === 'locked' && (
        <span style={{
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-color)',
          borderRadius: 999,
          fontSize: 12,
          padding: '4px 9px',
          position: 'absolute',
          right: 8,
          top: 8,
        }}>已锁定</span>
      )}
    </div>
  );
}

function ProjectsPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const routeQuery = searchParams?.toString() || '';
  const { user: currentUser, hasLoadedUser, loadingUser, refreshUser } = useAppSession();
  const currentUserId = currentUser?.id || '';
  const accountKey = currentUserId ? `${currentUserId}:${currentUser?.role || ''}` : 'anonymous';
  const activeAccountRef = useRef(accountKey);
  const accountEpochRef = useRef(0);
  if (activeAccountRef.current !== accountKey) {
    activeAccountRef.current = accountKey;
    accountEpochRef.current += 1;
  }

  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [personalProject, setPersonalProject] = useState<ProjectItem | null>(null);
  const [projectsAccountKey, setProjectsAccountKey] = useState('');
  const [loadedQueryKey, setLoadedQueryKey] = useState('');
  const [failedQueryKey, setFailedQueryKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [pagination, setPagination] = useState({ page: 1, page_size: 12, total: 0, total_pages: 1 });
  const [reloadVersion, setReloadVersion] = useState(0);
  const [canCreate, setCanCreate] = useState(false);
  const [usageSummary, setUsageSummary] = useState<ProjectListResponse['usage_summary']>(null);
  const [usageError, setUsageError] = useState('');
  const createOperation = useProjectCreateOperation(currentUserId, 'projects-list');

  const [search, setSearch] = useState(DEFAULT_PREFERENCES.search);
  const [appliedSearch, setAppliedSearch] = useState(DEFAULT_PREFERENCES.search);
  const [activeTab, setActiveTab] = useState<ProjectStatusFilter>(DEFAULT_PREFERENCES.status);
  const [sort, setSort] = useState<ProjectSort>(DEFAULT_PREFERENCES.sort);
  const [scope, setScope] = useState<ProjectScope>(DEFAULT_PREFERENCES.scope);
  const [page, setPage] = useState(DEFAULT_PREFERENCES.page);
  const pageSize = 12;
  const [preferencesReadyFor, setPreferencesReadyFor] = useState('');
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [locationRevision, setLocationRevision] = useState(0);
  const [returnAnchorId, setReturnAnchorId] = useState('');
  const [highlightProjectId, setHighlightProjectId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const createNameRef = useRef<HTMLInputElement>(null);
  const [description, setDescription] = useState('');
  const [draftReadyFor, setDraftReadyFor] = useState('');
  const [billingMode, setBillingMode] = useState<'default' | 'budget'>('default');
  const [initialBudgetCredits, setInitialBudgetCredits] = useState('');
  const [reviewBudgetSuggestion, setReviewBudgetSuggestion] = useState<ReviewBudgetSuggestion | null>(null);
  const [createError, setCreateError] = useState('');
  const createUnknown = Boolean(createOperation.pending);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const createBusyRef = useRef(false);
  const createBackdropRef = useRef<HTMLDivElement>(null);
  const createDialogRef = useRef<HTMLDivElement>(null);
  const createTitleId = useId();
  const createDescriptionId = useId();
  const currentPreferences: ListPreferences = { search, status: activeTab, sort, scope, page };
  const gridRef = useRef<HTMLDivElement>(null);
  const requestSequence = useRef(0);
  const initializedAccountRef = useRef('');
  const operationTokensRef = useRef<Record<AccountOperation, number>>({ create: 0, action: 0, rename: 0, download: 0 });
  const renamePromptRef = useRef<ProjectRenamePromptHandle>(null);
  const downloadAbortRef = useRef<AbortController | null>(null);
  const ownLocationWriteRef = useRef('');
  const pageRef = useRef(page);
  const currentPreferencesRef = useRef(currentPreferences);
  pageRef.current = page;
  currentPreferencesRef.current = currentPreferences;

  const [downloadProject, setDownloadProject] = useState<ProjectItem | null>(null);
  const [downloadingProjectId, setDownloadingProjectId] = useState<string | null>(null);
  const [pendingProjectAction, setPendingProjectAction] = useState<PendingProjectAction | null>(null);
  const [projectActionBusy, setProjectActionBusy] = useState(false);
  const downloadBackdropRef = useRef<HTMLDivElement>(null);
  const downloadDialogRef = useRef<HTMLDivElement>(null);
  const queryKey = JSON.stringify({ accountKey, ...currentPreferences, search: appliedSearch, pageSize });
  const preferencesReady = preferencesReadyFor === accountKey;
  const hasCurrentList = preferencesReady && appliedSearch === search && projectsAccountKey === accountKey && loadedQueryKey === queryKey;
  const showListError = search === appliedSearch && Boolean(listError && failedQueryKey === queryKey);

  function beginAccountOperation(kind: AccountOperation): AccountOperationSnapshot {
    const token = operationTokensRef.current[kind] + 1;
    operationTokensRef.current[kind] = token;
    return { kind, accountKey, epoch: accountEpochRef.current, token };
  }

  function isCurrentAccountOperation(snapshot: AccountOperationSnapshot) {
    return activeAccountRef.current === snapshot.accountKey
      && accountEpochRef.current === snapshot.epoch
      && operationTokensRef.current[snapshot.kind] === snapshot.token;
  }

  function writeListUrl(preferences: ListPreferences) {
    const beforeQuery = new URLSearchParams(window.location.search).toString();
    const before = beforeQuery ? `${window.location.pathname}?${beforeQuery}` : window.location.pathname;
    updateListUrl(preferences);
    const afterQuery = new URLSearchParams(window.location.search).toString();
    const after = afterQuery ? `${window.location.pathname}?${afterQuery}` : window.location.pathname;
    if (after !== before) ownLocationWriteRef.current = after;
  }

  function closeCreateDialog() {
    if (createBusyRef.current) return;
    setCreateOpen(false);
    if (window.location.hash === '#create-project') {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
    }
  }

  useDialogDismiss({
    open: createOpen,
    dialogRef: createDialogRef,
    dismissSurfaceRef: createBackdropRef,
    initialFocusRef: createNameRef,
    onDismiss: closeCreateDialog,
    dismissOnOutside: !createSubmitting,
    dismissOnEscape: !createSubmitting,
  });

  useDialogDismiss({
    open: Boolean(downloadProject),
    dialogRef: downloadDialogRef,
    dismissSurfaceRef: downloadBackdropRef,
    onDismiss: () => setDownloadProject(null),
    dismissOnOutside: !downloadProject || downloadingProjectId !== downloadProject.id,
    dismissOnEscape: !downloadProject || downloadingProjectId !== downloadProject.id,
  });

  useEffect(() => {
    if (!hasLoadedUser && !loadingUser) void refreshUser();
  }, [hasLoadedUser, loadingUser, refreshUser]);

  useEffect(() => {
    if (hasLoadedUser && isExternalUser(currentUser)) router.replace(externalFallbackPath());
  }, [currentUser, hasLoadedUser, router]);

  useEffect(() => {
    if (!hasLoadedUser) return;
    const identity = accountKey;
    const previousIdentity = initializedAccountRef.current;
    activeAccountRef.current = identity;
    initializedAccountRef.current = identity;
    setProjects([]);
    setPersonalProject(null);
    setProjectsAccountKey('');
    setLoadedQueryKey('');
    setFailedQueryKey('');
    setListError('');
    setLoading(true);
    setPreferencesReadyFor('');
    setNotice('');
    setActionError('');
    setCreateError('');
    setCanCreate(false);
    setUsageSummary(null);
    setUsageError('');
    setCreateSubmitting(false);
    createBusyRef.current = false;
    if (previousIdentity && previousIdentity !== identity) {
      downloadAbortRef.current?.abort();
      downloadAbortRef.current = null;
      setCreateOpen(window.location.hash === '#create-project');
      setName('');
      setDescription('');
      setBillingMode('default');
      setInitialBudgetCredits('');
      setReviewBudgetSuggestion(null);
      setDownloadProject(null);
      setDownloadingProjectId(null);
      setPendingProjectAction(null);
      setProjectActionBusy(false);
    }

    const restored = readListPreferences(currentUserId);
    try {
      const raw = currentUserId ? localStorage.getItem(`sd2:project-create-draft:v1:${currentUserId}`) : null;
      const draft = raw ? JSON.parse(raw) : null;
      setName(typeof draft?.name === 'string' ? draft.name : '');
      setDescription(typeof draft?.description === 'string' ? draft.description : '');
      setBillingMode(draft?.billingMode === 'budget' ? 'budget' : 'default');
      setInitialBudgetCredits(typeof draft?.initialBudgetCredits === 'string' ? draft.initialBudgetCredits : '');
    } catch { setStorageUnavailable(true); }
    setDraftReadyFor(identity);
    setStorageUnavailable(restored.storageUnavailable);
    setSearch(restored.preferences.search);
    setAppliedSearch(restored.preferences.search);
    setActiveTab(restored.preferences.status);
    setSort(restored.preferences.sort);
    setScope(restored.preferences.scope);
    setPage(restored.preferences.page);
    pageRef.current = restored.preferences.page;
    setPreferencesReadyFor(identity);
  }, [accountKey, currentUserId, hasLoadedUser]);

  useEffect(() => {
    if (!currentUserId || draftReadyFor !== accountKey) return;
    try { localStorage.setItem(`sd2:project-create-draft:v1:${currentUserId}`, JSON.stringify({ name, description, billingMode, initialBudgetCredits })); }
    catch { setStorageUnavailable(true); }
  }, [accountKey, billingMode, currentUserId, description, draftReadyFor, initialBudgetCredits, name]);

  useEffect(() => {
    if (!hasLoadedUser || preferencesReadyFor !== accountKey) return;
    const routeQueryKey = routeQuery ? `${pathname}?${routeQuery}` : pathname;
    const currentQuery = new URLSearchParams(window.location.search).toString();
    const liveLocationKey = currentQuery ? `${window.location.pathname}?${currentQuery}` : window.location.pathname;
    if (ownLocationWriteRef.current && ownLocationWriteRef.current === liveLocationKey) {
      if (ownLocationWriteRef.current === routeQueryKey) ownLocationWriteRef.current = '';
      return;
    }
    ownLocationWriteRef.current = '';
    const restored = readListPreferences(currentUserId);
    const next = restored.preferences;
    const current = currentPreferencesRef.current;
    const unchanged = next.search === current.search
      && next.status === current.status
      && next.sort === current.sort
      && next.scope === current.scope
      && next.page === current.page;
    if (unchanged) return;
    setStorageUnavailable(restored.storageUnavailable);
    setSearch(next.search);
    setAppliedSearch(next.search);
    setActiveTab(next.status);
    setSort(next.sort);
    setScope(next.scope);
    setPage(next.page);
    pageRef.current = next.page;
  }, [accountKey, currentUserId, hasLoadedUser, locationRevision, pathname, preferencesReadyFor, routeQuery]);

  useEffect(() => {
    const onPopState = () => setLocationRevision((revision) => revision + 1);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const syncHash = () => {
      let hash = window.location.hash.slice(1);
      try { hash = decodeURIComponent(hash); } catch { /* Keep the literal hash if malformed. */ }
      setReturnAnchorId(hash.startsWith('project-card-') ? hash : '');
    };
    syncHash();
    window.addEventListener('hashchange', syncHash);
    window.addEventListener('popstate', syncHash);
    return () => {
      window.removeEventListener('hashchange', syncHash);
      window.removeEventListener('popstate', syncHash);
    };
  }, [pathname, routeQuery]);

  useEffect(() => {
    if (!preferencesReady || appliedSearch === search) return;
    const timer = window.setTimeout(() => setAppliedSearch(search), 250);
    return () => window.clearTimeout(timer);
  }, [appliedSearch, preferencesReady, search]);

  useEffect(() => {
    if (!hasLoadedUser || preferencesReadyFor !== accountKey || appliedSearch !== search) return;
    const params = new URLSearchParams({
      view: 'list',
      include_archived: 'true',
      status: activeTab,
      sort,
      scope,
      page: String(page),
      page_size: String(pageSize),
      time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    });
    if (appliedSearch.trim()) params.set('search', appliedSearch.trim().slice(0, 120));

    const controller = new AbortController();
    const requestId = ++requestSequence.current;
    const requestEpoch = accountEpochRef.current;
    const isCurrentListRequest = () => activeAccountRef.current === accountKey
      && accountEpochRef.current === requestEpoch
      && requestSequence.current === requestId;
    setLoading(true);
    setListError('');
    setFailedQueryKey('');

    const load = async () => {
      try {
        const res = await fetch(`/api/projects?${params.toString()}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!isCurrentListRequest() || controller.signal.aborted) return;
        if (res.status === 401) {
          window.location.href = '/login';
          return;
        }
        const data = await res.json().catch(() => null) as ProjectListResponse | { error?: string; message?: string } | null;
        if (!isCurrentListRequest() || controller.signal.aborted) return;
        if (!res.ok) {
          const message = data && 'error' in data ? data.error || data.message : '';
          throw new Error(message || `项目列表读取失败（${res.status}）`);
        }
        if (!data || !('projects' in data) || !Array.isArray(data.projects)
          || !data.pagination || !Number.isInteger(data.pagination.page)
          || !Number.isInteger(data.pagination.page_size) || !Number.isInteger(data.pagination.total)
          || !Number.isInteger(data.pagination.total_pages)) {
          throw new Error('项目列表返回内容不完整，请重试');
        }
        if (controller.signal.aborted || !isCurrentListRequest()) return;
        setProjects(data.projects);
        setPersonalProject(data.personal_project || null);
        setCanCreate(data.capabilities?.can_create_team_project === true && data.capabilities.create_operation_version === 1);
        setUsageSummary(data.usage_summary || null);
        setUsageError(data.usage_summary_error || '');
        setPagination(data.pagination);
        setProjectsAccountKey(accountKey);
        setLoadedQueryKey(queryKey);
        if (data.pagination.page !== page) {
          pageRef.current = data.pagination.page;
          setPage(data.pagination.page);
          writeListUrl({ ...currentPreferences, page: data.pagination.page });
        }
      } catch (error) {
        if (controller.signal.aborted || !isCurrentListRequest()) return;
        setListError(error instanceof Error ? error.message : '项目列表读取失败，请重试');
        setFailedQueryKey(queryKey);
      } finally {
        if (!controller.signal.aborted && isCurrentListRequest()) {
          setLoading(false);
        }
      }
    };

    void load();
    return () => controller.abort();
  }, [accountKey, activeTab, appliedSearch, hasLoadedUser, page, pageSize, preferencesReadyFor, queryKey, reloadVersion, scope, search, sort]);

  useEffect(() => {
    if (!hasLoadedUser || preferencesReadyFor !== accountKey) return;
    if (!saveListPreferences(currentUserId, currentPreferences)) setStorageUnavailable(true);
    else setStorageUnavailable(false);
  }, [accountKey, activeTab, currentUserId, hasLoadedUser, page, preferencesReadyFor, scope, search, sort]);

  useEffect(() => {
    if (billingMode !== 'budget' || !createOpen) return;
    let cancelled = false;
    fetch('/api/review-cards?project_type=public&limit=5', { cache: 'no-store' })
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (cancelled || !data?.review_cards?.length) return;
        const cards = data.review_cards
          .map((card: { budget_suggestion_credits?: number | null; failure_rate?: number | null }) => ({
            budget: Number(card.budget_suggestion_credits || 0),
            failureRate: Number(card.failure_rate || 0),
          }))
          .filter((item: { budget: number }) => item.budget > 0);
        if (cards.length === 0) return;
        const averageBudget = cards.reduce((sum: number, item: { budget: number }) => sum + item.budget, 0) / cards.length;
        const averageFailureRate = cards.reduce((sum: number, item: { failureRate: number }) => sum + item.failureRate, 0) / cards.length;
        setReviewBudgetSuggestion({
          suggested_credits: Math.ceil(averageBudget),
          sample_count: cards.length,
          risk_hint: averageFailureRate >= 0.25 ? '历史失败率偏高，建议预留更多试错预算。' : '历史失败率正常，可按建议预算作为起点。',
        });
      })
      .catch(() => {
        if (!cancelled) setReviewBudgetSuggestion(null);
      });
    return () => { cancelled = true; };
  }, [billingMode, createOpen]);

  useEffect(() => {
    const openFromLink = () => {
      if (window.location.hash === '#create-project') setCreateOpen(true);
    };
    openFromLink();
    window.addEventListener('hashchange', openFromLink);
    return () => window.removeEventListener('hashchange', openFromLink);
  }, []);

  useEffect(() => {
    if (!hasCurrentList) return;
    const targetId = highlightProjectId ? `project-card-${highlightProjectId}` : returnAnchorId;
    if (!targetId) return;
    const target = document.getElementById(targetId);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (!highlightProjectId) return;
    const timer = window.setTimeout(() => setHighlightProjectId(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [hasCurrentList, highlightProjectId, projects, returnAnchorId]);

  function applyPreferences(update: Partial<ListPreferences>) {
    const next = normalizePreferences({ ...currentPreferences, ...update });
    setSearch(next.search);
    setActiveTab(next.status);
    setSort(next.sort);
    setScope(next.scope);
    pageRef.current = next.page;
    setPage(next.page);
    writeListUrl(next);
  }

  function resetPreferences() {
    if (currentUserId) {
      try { window.localStorage.removeItem(projectPreferenceKey(currentUserId)); }
      catch { setStorageUnavailable(true); }
    }
    applyPreferences(DEFAULT_PREFERENCES);
    setAppliedSearch(DEFAULT_PREFERENCES.search);
    setStorageUnavailable(false);
  }

  function closeProjectMenu(event: React.MouseEvent<HTMLElement>) {
    event.currentTarget.closest('details')?.removeAttribute('open');
  }

  function openCreateDialog() {
    setCreateError('');
    setCreateOpen(true);
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createBusyRef.current || createUnknown || !canCreate || !createOperation.ready) return;
    setCreateError('');
    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    if (!trimmedName) {
      setCreateError('请填写项目名称。');
      createNameRef.current?.focus();
      return;
    }
    if (billingMode === 'budget') {
      const params = new URLSearchParams({
        type: 'project_create',
        reason: `申请公共项目预算记账立项：${trimmedName}${trimmedDescription ? `。项目说明：${trimmedDescription}` : ''}`,
        project_name: trimmedName,
      });
      if (trimmedDescription) params.set('project_description', trimmedDescription);
      if (initialBudgetCredits.trim()) params.set('initial_budget_credits', initialBudgetCredits.trim());
      createBusyRef.current = true;
      setCreateSubmitting(true);
      window.location.href = `/approvals?${params.toString()}`;
      return;
    }

    const operation = beginAccountOperation('create');
    createBusyRef.current = true;
    setCreateSubmitting(true);
    try {
      const result = await createOperation.create({ name: trimmedName, description: trimmedDescription });
      if (!isCurrentAccountOperation(operation)) return;
      resolveCreatedProject(result);
    } catch (cause) {
      if (isCurrentAccountOperation(operation)) setCreateError(cause instanceof Error ? cause.message : '创建结果待确认，请查询原创建。');
    } finally {
      if (isCurrentAccountOperation(operation)) {
        createBusyRef.current = false;
        setCreateSubmitting(false);
      }
    }
  }

  function resolveCreatedProject(result: ProjectCreateResult) {
    if (result.operation.state !== 'accepted') return;
    setCreateOpen(false);
    if (window.location.hash === '#create-project') window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
    if (!result.project) {
      setNotice('原创建已受理，但该项目当前不可访问；没有重新创建。');
      return;
    }
    setHighlightProjectId(result.project.id);
    setName(''); setDescription(''); setBillingMode('default'); setInitialBudgetCredits('');
    setReviewBudgetSuggestion(null); setCreateError('');
    applyPreferences({ search: '', status: 'active', sort: 'updated', scope: 'all', page: 1 });
    setAppliedSearch(''); setNotice('项目已创建。'); setActionError('');
    setReloadVersion((version) => version + 1);
  }

  function requestProjectAction(project: ProjectItem, action: ProjectAction) {
    setActionError('');
    setNotice('');
    setPendingProjectAction({ project, action });
  }

  async function confirmProjectAction() {
    if (!pendingProjectAction || projectActionBusy) return;
    const { project, action } = pendingProjectAction;
    const operation = beginAccountOperation('action');
    const label = action === 'archive' ? '归档' : action === 'restore' ? '恢复' : '删除';
    setProjectActionBusy(true);
    try {
      const res = await fetch(`/api/projects/${project.id}`, action === 'delete'
        ? { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(projectStatusExpectation(project)) }
        : {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, ...projectStatusExpectation(project) }),
          });
      if (!isCurrentAccountOperation(operation)) return;
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      const data = await res.json().catch(() => null) as { error?: string; message?: string } | null;
      if (!isCurrentAccountOperation(operation)) return;
      if (!res.ok) { if (res.status === 409) setReloadVersion((v) => v + 1); throw new Error(data?.error || data?.message || `${label}项目失败`); }
      setPendingProjectAction(null);
      setNotice(action === 'delete' ? '项目已删除' : `项目已${label}`);
      setReloadVersion((version) => version + 1);
    } catch (error) {
      if (isCurrentAccountOperation(operation)) {
        setActionError(error instanceof Error ? error.message : `${label}项目失败`);
        setPendingProjectAction(null);
      }
    } finally {
      if (isCurrentAccountOperation(operation)) setProjectActionBusy(false);
    }
  }

  async function handleRenameProject(project: ProjectItem) {
    const operation = beginAccountOperation('rename');
    const value = await renamePromptRef.current?.prompt('项目名称', project.name, {
      title: '重命名项目',
      confirmLabel: '保存名称',
      maxLength: null,
      onSubmit: async (nextName) => {
        if (!isCurrentAccountOperation(operation)) throw new Error('账号已切换，本次重命名未提交。请关闭此对话框后在当前账号重新打开。');
        const res = await fetch(`/api/projects/${project.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: nextName, ...projectStatusExpectation(project) }),
        });
        if (!isCurrentAccountOperation(operation)) throw new Error('账号已切换，本次重命名结果未应用。');
        if (res.status === 401) {
          window.location.href = '/login';
          throw new Error('登录状态已失效，请重新登录后重试。');
        }
        const data = await res.json().catch(() => null) as { project?: { id?: string; name?: string }; error?: string; message?: string } | null;
        if (!isCurrentAccountOperation(operation)) throw new Error('账号已切换，本次重命名结果未应用。');
        if (!res.ok) { if (res.status === 409) setReloadVersion((v) => v + 1); throw new Error(data?.error || data?.message || '项目名称保存失败，请重试。'); }
        if (data?.project?.id !== project.id || data.project.name !== nextName.trim()) {
          throw new Error('服务器没有返回已保存的项目名称，暂未确认保存成功。请核对项目后再重试。');
        }
        setNotice('项目名称已保存');
        setActionError('');
        setReloadVersion((version) => version + 1);
      },
    });
    if (isCurrentAccountOperation(operation) && value != null) setActionError('');
  }

  async function handleProjectDownload() {
    if (!downloadProject || downloadingProjectId === downloadProject.id) return;
    const count = downloadProject.downloadable_task_count || 0;
    if (count <= 0 || count > BULK_VIDEO_DOWNLOAD_CLIENT_LIMIT) return;
    const operation = beginAccountOperation('download');
    setActionError('');
    setNotice('');
    setDownloadingProjectId(downloadProject.id);
    const controller = new AbortController();
    downloadAbortRef.current = controller;
    try {
      const result = await downloadBulkVideoZip(
        { projectId: downloadProject.id },
        undefined,
        { signal: controller.signal, canDownload: () => isCurrentAccountOperation(operation) },
      );
      if (!isCurrentAccountOperation(operation)) return;
      setNotice(`已开始下载项目视频包：${result.success} 个视频${result.failed ? `，${result.failed} 个失败，详情见 manifest` : ''}`);
      setDownloadProject(null);
    } catch (error) {
      if (isCurrentAccountOperation(operation)) {
        if (error instanceof Error && error.name === 'AbortError') {
          return;
        } else if (error instanceof Error && error.message === '未登录') {
          window.location.href = '/login';
        } else {
          setActionError(error instanceof Error ? error.message : '项目视频包下载失败');
        }
      }
    } finally {
      if (isCurrentAccountOperation(operation)) {
        if (downloadAbortRef.current === controller) downloadAbortRef.current = null;
        setDownloadingProjectId(null);
      }
    }
  }

  const visibleProjects = hasCurrentList ? projects : [];
  const visiblePersonalProject = hasCurrentList ? personalProject : null;
  const downloadLimit = BULK_VIDEO_DOWNLOAD_CLIENT_LIMIT;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>我的项目</h1>
          <div className={styles.actions}>
            {visiblePersonalProject && <Link id={`project-card-${visiblePersonalProject.id}`} className="link" href={projectDetailHref(visiblePersonalProject.id, currentPreferences)}>个人空间{visiblePersonalProject.status === 'locked' ? '（只读）' : ''} →</Link>}
            <Link className="link" href="/usage">我的用量</Link>
            {canCreate && <button id="create-project" className="btn btn-primary" type="button" title="新建项目" aria-label="新建项目" onClick={openCreateDialog}>
              <Plus size={16} aria-hidden="true" />新建项目
            </button>}
          </div>
      </header>
      {projectsAccountKey === accountKey && <CompactUsageSummary report={usageSummary || null} error={usageError} />}
      {!createOpen && <ProjectCreateOperationNotice operation={createOperation} onResolved={resolveCreatedProject} />}

      {(notice || actionError) && (
        <div className="card" role={actionError ? 'alert' : 'status'} style={{ borderColor: actionError ? 'var(--border-color)' : 'var(--tone-success-border, var(--border-color))' }}>
          <p className={actionError ? 'text-gray' : 'text-green'}>{actionError || notice}</p>
        </div>
      )}

      <section className={styles.filters} aria-label="项目筛选" style={{ display: 'grid', gap: 14, marginBottom: 18 }}>
        <div style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <label style={{ flex: '1 1 260px', minWidth: 220, position: 'relative' }}>
            <Search size={16} aria-hidden="true" style={{ color: 'var(--text-secondary)', left: 12, position: 'absolute', top: '50%', transform: 'translateY(-50%)' }} />
            <input
              className="input"
              type="search"
              value={search}
              onChange={(event) => applyPreferences({ search: event.target.value.slice(0, 120), page: 1 })}
              placeholder="搜索项目名称或说明"
              aria-label="搜索项目名称或说明"
              maxLength={120}
              style={{ paddingLeft: 38, width: '100%' }}
            />
          </label>
          <div aria-label="项目状态" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button className={`btn ${activeTab === 'active' ? 'btn-primary' : 'btn-secondary'}`} type="button" aria-pressed={activeTab === 'active'} onClick={() => applyPreferences({ status: 'active', page: 1 })}>使用中</button>
            <button className={`btn ${activeTab === 'archived' ? 'btn-primary' : 'btn-secondary'}`} type="button" aria-pressed={activeTab === 'archived'} onClick={() => applyPreferences({ status: 'archived', page: 1 })}>已归档</button>
          </div>
          <ProjectFilters active={sort !== 'updated' || scope !== 'all'}>
          <label style={{ display: 'grid', flex: '0 1 180px', gap: 4, minWidth: 150 }}>
            <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>排序</span>
            <select className="input" value={sort} onChange={(event) => applyPreferences({ sort: event.target.value === 'name' ? 'name' : 'updated', page: 1 })} aria-label="项目排序">
              <option value="updated">最近修改</option>
              <option value="name">项目名称</option>
            </select>
          </label>
          <label style={{ display: 'grid', flex: '0 1 180px', gap: 4, minWidth: 160 }}>
            <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>项目范围</span>
            <select className="input" value={scope} onChange={(event) => applyPreferences({ scope: event.target.value as ProjectScope, page: 1 })} aria-label="项目范围">
              <option value="all">全部可见项目</option>
              <option value="owned">我创建或负责</option>
              <option value="participating">我参与</option>
            </select>
          </label>
          <button className="btn btn-secondary" type="button" onClick={resetPreferences} title="清除搜索、排序、范围和上次页码">
            <RotateCcw size={15} aria-hidden="true" />重置筛选
          </button>
          </ProjectFilters>
        </div>
        <div style={{ alignItems: 'center', color: 'var(--text-secondary)', display: 'flex', flexWrap: 'wrap', fontSize: 13, gap: 10, justifyContent: 'space-between' }}>
          <span>{hasCurrentList ? `共 ${pagination.total} 个项目` : '正在读取项目'}</span>
        </div>
        {storageUnavailable && <p role="status" className="text-gray" style={{ margin: 0 }}>浏览器未能保存列表偏好，本次仍可正常使用。</p>}
      </section>

      {showListError && (
        <div className="card" role="alert" style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'space-between' }}>
          <div>
            <strong>项目列表读取失败</strong>
            <p style={{ color: 'var(--text-secondary)', margin: '4px 0 0' }}>{listError}{hasCurrentList ? '，下面保留上次成功读取的结果。' : '，没有把读取失败当成空列表。'}</p>
          </div>
          <button className="btn btn-secondary" type="button" onClick={() => setReloadVersion((version) => version + 1)} disabled={loading}>重试读取</button>
        </div>
      )}

      {search !== appliedSearch && (
        <div className="card" role="status" style={{ color: 'var(--text-secondary)' }}>正在应用搜索…</div>
      )}
      {loading && !hasCurrentList && !showListError && search === appliedSearch && (
        <div className="card" role="status" style={{ color: 'var(--text-secondary)' }}>正在读取项目…</div>
      )}
      {loading && hasCurrentList && <p className="text-gray" role="status">正在更新项目列表…</p>}

      {!loading && !showListError && hasCurrentList && pagination.total === 0 && (
        <div className="card" style={{ textAlign: 'center' }}>
          <h2 style={{ marginTop: 0 }}>{search.trim() ? '没有找到匹配的项目' : activeTab === 'active' ? '还没有使用中的项目' : '还没有归档项目'}</h2>
          <p className="text-gray">{search.trim() ? '试试缩短关键词，或重置筛选后再找。' : activeTab === 'active' ? '创建协作项目后，可以在这里继续生成和查看结果。' : '归档的项目会保留在这里，方便之后恢复查看。'}</p>
          {search.trim() ? (
            <button className="btn btn-secondary" type="button" onClick={resetPreferences}>重置筛选</button>
          ) : activeTab === 'active' && canCreate && (
            <button className="btn btn-primary" type="button" onClick={openCreateDialog}><Plus size={16} aria-hidden="true" />新建项目</button>
          )}
        </div>
      )}

      <div ref={gridRef} className={styles.grid} aria-busy={loading}>
        {visibleProjects.map((project) => {
          const displayName = projectDisplayName(project);
          const downloadableCount = project.downloadable_task_count || 0;
          const downloadTooLarge = downloadableCount > downloadLimit;
          const isManager = canManageProject(project);
          const isMutable = project.status !== 'locked';
          const canArchive = project.can_archive === true;
          const canRestore = project.can_restore === true;
          const deleteAllowed = project.can_delete === true;
          const highlighted = project.id === highlightProjectId;
          return (
            <article
              id={`project-card-${project.id}`}
              key={project.id}
              data-project-id={project.id}
              className={styles.projectCard}
              style={{
                background: 'var(--bg-panel)',
                border: `1px solid ${highlighted ? 'var(--tone-info-border)' : 'var(--border-color)'}`,
                borderRadius: 8,
                boxShadow: highlighted ? '0 0 0 2px var(--tone-info-bg)' : undefined,
                color: 'var(--text-primary)',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                minWidth: 0,
                padding: 12,
              }}
            >
              <Link href={projectDetailHref(project.id, currentPreferences)} aria-label={`进入项目：${displayName}`} style={{ color: 'inherit', display: 'grid', gap: 10, textDecoration: 'none' }}>
                <ProjectCover project={project} />
                <span style={{ display: 'grid', gap: 5 }}>
                  <span style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: 7, justifyContent: 'space-between' }}>
                    <strong style={{ fontSize: 16, overflowWrap: 'anywhere' }}>{displayName}</strong>
                    <span style={{
                      background: 'var(--bg-input)',
                      border: '1px solid var(--border-color)',
                      borderRadius: 999,
                      color: 'var(--text-secondary)',
                      fontSize: 11,
                      padding: '3px 8px',
                      whiteSpace: 'nowrap',
                    }}>{projectStatusLabel(project.status)}</span>
                  </span>
                  <span style={{ color: 'var(--text-secondary)', display: '-webkit-box', fontSize: 13, lineHeight: 1.45, minHeight: '2.9em', overflow: 'hidden', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2 }}>
                    {project.description?.trim() || '暂无项目说明'}
                  </span>
                </span>
              </Link>

              <div className={styles.cardMeta}>
                <span>{project._count?.tasks ?? 0} 个记录</span>
                {(project.active_task_count ?? 0) > 0 && <span>{project.active_task_count} 个生成中</span>}
                <RelativeTime value={project.updated_at} />
                <details><summary title="项目信息">信息</summary><div>
                  <UserIdentityBadge user={projectOwnerUser(project)} size="sm" />
                  <p>我的权限：{projectRoleLabel(project.my_role)}</p>
                  <p>可下载视频 {downloadableCount}</p>
                </div></details>
              </div>

              <div style={{ alignItems: 'center', display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 'auto', paddingTop: 2 }}>
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => setDownloadProject(project)}
                  disabled={downloadableCount <= 0}
                  title={downloadableCount <= 0 ? '该项目暂无可下载视频' : downloadTooLarge ? `超过单次${downloadLimit}个视频的即时打包上限` : '下载该项目内你有权限下载的视频'}
                >
                  <Download size={15} aria-hidden="true" />
                  {downloadableCount <= 0 ? '暂无可下载视频' : '下载视频包'}
                </button>
                {isManager && isMutable && (
                  <details style={{ position: 'relative' }}>
                    <summary
                      aria-label={`更多项目操作：${displayName}`}
                      title="项目操作"
                      style={{ alignItems: 'center', background: 'var(--bg-input)', border: '1px solid var(--border-color)', borderRadius: 7, color: 'var(--text-secondary)', cursor: 'pointer', display: 'inline-flex', height: 36, justifyContent: 'center', listStyle: 'none', width: 40 }}
                    ><MoreHorizontal size={18} aria-hidden="true" /></summary>
                    <div style={{
                      background: 'var(--bg-panel)',
                      border: '1px solid var(--border-color)',
                      borderRadius: 8,
                      boxShadow: '0 10px 26px rgba(15, 23, 42, 0.16)',
                      display: 'grid',
                      gap: 4,
                      minWidth: 190,
                      padding: 6,
                      position: 'absolute',
                      right: 0,
                      top: 'calc(100% + 6px)',
                      zIndex: 3,
                    }}>
                      <Link href={projectDetailHref(project.id, currentPreferences, 'members')} className="btn btn-secondary" style={{ justifyContent: 'flex-start', textDecoration: 'none' }} onClick={closeProjectMenu}>成员与设置</Link>
                      {project.status !== 'archived' && (
                        <button className="btn btn-secondary" type="button" style={{ justifyContent: 'flex-start' }} onClick={(event) => { closeProjectMenu(event); void handleRenameProject(project); }}>重命名</button>
                      )}
                      {canArchive && (
                        <button className="btn btn-secondary" type="button" style={{ justifyContent: 'flex-start' }} onClick={(event) => { closeProjectMenu(event); requestProjectAction(project, 'archive'); }}>归档为只读</button>
                      )}
                      {canRestore && (
                        <button className="btn btn-secondary" type="button" style={{ justifyContent: 'flex-start' }} onClick={(event) => { closeProjectMenu(event); requestProjectAction(project, 'restore'); }}>恢复项目</button>
                      )}
                      {canShowDeleteProjectAction(project) && (
                        <button
                          className="btn btn-danger"
                          type="button"
                          style={{ justifyContent: 'flex-start' }}
                          onClick={(event) => { closeProjectMenu(event); requestProjectAction(project, 'delete'); }}
                          disabled={!deleteAllowed}
                          title={deleteAllowed ? '删除已核对为空的协作项目' : '存在内容、账务或历史记录，请使用归档'}
                        >删除空项目</button>
                      )}
                    </div>
                  </details>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {hasCurrentList && pagination.total > 0 && (
        <PaginationControls
          page={pagination.page}
          totalPages={pagination.total_pages}
          total={pagination.total}
          pageSize={pagination.page_size}
          label="个项目"
          onPageChange={(nextPage) => applyPreferences({ page: nextPage })}
          busy={loading}
        />
      )}

      {createOpen && (
        <div ref={createBackdropRef} className="modal-overlay" role="presentation">
          <div ref={createDialogRef} className="modal-panel" role="dialog" aria-modal="true" aria-labelledby={createTitleId} aria-describedby={createDescriptionId} aria-busy={createSubmitting}>
            <div className="modal-header">
              <div>
                <h2 id={createTitleId}>新建项目</h2>
                <p id={createDescriptionId}>填写基本信息，之后可在项目中继续生成和协作。</p>
              </div>
              <button className="modal-close" type="button" onClick={closeCreateDialog} disabled={createSubmitting} aria-label="关闭">×</button>
            </div>
            <form onSubmit={(event) => void createProject(event)} style={{ display: 'grid', gap: 14 }}>
              <label style={{ display: 'grid', gap: 6 }}>
                <span>项目名称 <span aria-hidden="true" style={{ color: 'var(--text-secondary)' }}>*</span></span>
                <input ref={createNameRef} className="input" value={createOperation.pending?.input.name ?? name} onChange={(event) => setName(event.target.value)} placeholder="例如：夏季广告短片" required disabled={createSubmitting || createUnknown} />
              </label>
              <label style={{ display: 'grid', gap: 6 }}>
                <span>项目说明 <span style={{ color: 'var(--text-secondary)' }}>（可选）</span></span>
                <textarea className="input" value={createOperation.pending ? createOperation.pending.input.description || '' : description} onChange={(event) => setDescription(event.target.value)} placeholder="写下项目用途，方便成员辨认" rows={2} disabled={createSubmitting || createUnknown} />
              </label>
              <fieldset disabled={createSubmitting || createUnknown} style={{ border: 0, display: 'grid', gap: 8, margin: 0, padding: 0 }}>
                <legend style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>项目记账方式</legend>
                <label className={`project-billing-choice ${billingMode === 'default' ? 'is-selected' : ''}`}>
                  <input type="radio" name="projectBillingMode" value="default" checked={billingMode === 'default'} onChange={() => setBillingMode('default')} />
                  <span><strong>默认记账</strong><small>普通协作项目，生成消耗扣发起人的个人积分。</small></span>
                </label>
                <label className={`project-billing-choice ${billingMode === 'budget' ? 'is-selected' : ''}`}>
                  <input type="radio" name="projectBillingMode" value="budget" checked={billingMode === 'budget'} onChange={() => setBillingMode('budget')} />
                  <span><strong>申请项目预算</strong><small>打开原有公共项目立项审批；审批通过后才可能创建预算项目。</small></span>
                </label>
              </fieldset>
              {billingMode === 'budget' && (
                <>
                  <label style={{ display: 'grid', gap: 6 }}>
                    <span>申请预算点数 <span style={{ color: 'var(--text-secondary)' }}>（可选）</span></span>
                    <input className="input" value={initialBudgetCredits} onChange={(event) => setInitialBudgetCredits(event.target.value)} placeholder="填写初始预算点数" inputMode="decimal" disabled={createSubmitting} />
                  </label>
                  {reviewBudgetSuggestion && (
                    <div className="project-budget-suggestion">
                      <div>
                        <strong>历史复盘建议预算：{reviewBudgetSuggestion.suggested_credits} 点</strong>
                        <span>{reviewBudgetSuggestion.sample_count} 个公共项目样本 · {reviewBudgetSuggestion.risk_hint}</span>
                      </div>
                      <button className="btn btn-secondary" type="button" onClick={() => setInitialBudgetCredits(String(reviewBudgetSuggestion.suggested_credits))} disabled={createSubmitting}>使用建议</button>
                    </div>
                  )}
                </>
              )}
              {createError && <p role="alert" className="text-gray" style={{ margin: 0 }}>{createError}</p>}
              <ProjectCreateOperationNotice operation={createOperation} onResolved={resolveCreatedProject} />
              {!canCreate && <p className="text-gray">当前账号没有新建协作项目权限，原创建仍可核对。</p>}
              <div className="modal-actions">
                <button className="btn btn-secondary" type="button" onClick={closeCreateDialog} disabled={createSubmitting}>取消</button>
                <button className="btn btn-primary" type="submit" disabled={createSubmitting || !name.trim() || createUnknown || !createOperation.ready || !canCreate}>
                  {createSubmitting ? '正在提交…' : billingMode === 'budget' ? '去申请预算' : '创建项目'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {downloadProject && (
        <div ref={downloadBackdropRef} className="modal-overlay" role="presentation">
          <div ref={downloadDialogRef} className="modal-panel bulk-download-modal" role="dialog" aria-modal="true" aria-label="下载项目视频包">
            <div className="modal-header">
              <div>
                <h2>下载项目视频包</h2>
                <p>{projectDisplayName(downloadProject)}</p>
              </div>
              <button className="modal-close" type="button" onClick={() => setDownloadProject(null)} disabled={downloadingProjectId === downloadProject.id} aria-label="关闭">×</button>
            </div>
            <div className="bulk-download-summary">
              <div><span>项目内可下载视频</span><strong>{downloadProject.downloadable_task_count || 0}</strong></div>
              <div><span>单次打包上限</span><strong>{downloadLimit}</strong></div>
            </div>
            {(downloadProject.downloadable_task_count || 0) > downloadLimit ? (
              <p className="text-gray">项目内可下载视频超过单次 {downloadLimit} 个的上限，当前不能一次打包。此列表不会只打包当前页；请进入项目后逐项下载。</p>
            ) : (
              <p className="text-gray">将项目内你有权限下载的已完成视频打包为 ZIP，并附带 manifest.csv。</p>
            )}
            <div className="modal-actions">
              <button className="btn btn-secondary" type="button" onClick={() => setDownloadProject(null)} disabled={downloadingProjectId === downloadProject.id}>取消</button>
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => void handleProjectDownload()}
                disabled={downloadingProjectId === downloadProject.id || (downloadProject.downloadable_task_count || 0) <= 0 || (downloadProject.downloadable_task_count || 0) > downloadLimit}
              >
                <Download size={16} aria-hidden="true" />
                {downloadingProjectId === downloadProject.id ? '正在打包…' : '确认下载'}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingProjectAction && (
        <ProjectActionConfirmModal
          action={pendingProjectAction.action}
          projectName={projectDisplayName(pendingProjectAction.project)}
          meta={projectActionMeta(pendingProjectAction.project)}
          busy={projectActionBusy}
          onCancel={() => setPendingProjectAction(null)}
          onConfirm={() => void confirmProjectAction()}
        />
      )}

      <ProjectRenamePromptHost key={accountKey} ref={renamePromptRef} />
    </div>
  );
}

export default function ProjectsPage() {
  return (
    <Suspense fallback={<div className="card" role="status" aria-busy="true">正在加载项目列表…</div>}>
      <ProjectsPageContent />
    </Suspense>
  );
}
