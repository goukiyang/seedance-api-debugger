'use client';
import { useProductDialog } from '@/components/useProductDialog';

import { useState, useEffect, useCallback, useMemo, useRef, type FormEvent } from 'react';
import Link from 'next/link';
import { Archive, Check, ChevronDown, Folder, Plus, Trash2, RefreshCw } from 'lucide-react';
import type { GenerationMode, VideoRatio, VideoDuration, VideoResolution, AssetCollection } from '@/types';
import { RATIO_OPTIONS, RESOLUTION_OPTIONS } from '@/types';
import { GenerationComposer } from '@/components/GenerationComposer';
import { notifyVideoPricingChanged, validVideoPricingAmount } from '@/lib/pricing-client';
import type { ComposerSelectOption } from '@/components/ComposerActionBar';
import ContentReactions from '@/components/content-reactions/ContentReactions';
import { TaskVideoThumbnail } from '@/components/TaskVideoThumbnail';
import ComposerTopbar from '@/components/ComposerTopbar';
import { useAppSession } from '@/lib/context/AppSessionContext';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import {
  H3_AUTO_CHECK_MIN_GAP_MS,
  buildH3MachineStatus,
  h3DisabledReason,
  isH3HealthCheckDue,
  normalizeH3VideoConfig,
  type H3VideoConfig,
} from '@/components/H3MachineStatus';
import { formatProviderUsdCharge } from '@/lib/costs/currency';
import { readJsonResponse } from '@/lib/http/json-response';
import { externalFallbackPath, isExternalUser } from '@/lib/access/external-role';
import { isNavItemVisible, showVideoCardManagementUi } from '@/lib/navigation';
import { sanitizeOptionalReturnTo, taskDetailHref, taskReturnLabel } from '@/lib/navigation/return-to';
import {
  normalizeGenerationDefaults,
  type GenerationDefaults,
} from '@/lib/preferences/generation';
import { VOLCENGINE_IP_MODEL_OPTIONS, volcengineIpModelLabel, volcengineIpModelResolutions } from '@/lib/integrations/volcengine-ip-models';
import { SEEDANCE_2_5_MODEL_ID, SEEDANCE_VIDEO_MODEL_OPTIONS, isSeedanceVideoDuration, seedanceVideoMaxDuration } from '@/lib/provider/seedance-models';
import { orderRecentTaskCards, recentTaskHasVisualPreview } from '@/lib/video/recent-task-card-order';
import type { StudioGenerationHandoff } from '@/lib/template-studio/types';
import { stableGenerationPayloadJson } from '@/lib/template-studio-video-handoff';
import { readImageResultHandoff, resumeImageResultVideoImport } from '@/lib/image-result-next/client';
import type { ImageResultVideoHandoff } from '@/lib/image-result-next/video-draft';
import {
  taskReuseAutoAction,
  taskReuseContextMatches,
  shouldConsumeTaskReuseQuery,
  taskReuseReceiptKey,
  readTaskReuseTabId,
  transitionTaskReuseQuery,
  type ComposerReuseState,
  type TaskReuseContext,
  type TaskReuseIntent,
} from '@/lib/navigation/task-reuse-intent';

// ============================================================================
// Types
// ============================================================================

interface CreateResponse {
  id: string;
  provider?: string;
  provider_task_id: string;
  model?: string;
  status: string;
  created_at: string;
  project_id?: string;
  video_card_id?: string;
  template_id?: string | null;
  template_studio_run_id?: string | null;
  agent_run_id?: string | null;
  selected_agent_plan_key?: string | null;
  prompt_rendered?: string;
  estimated_cost?: number;
  frozen_cost?: number;
  deduplicated?: boolean;
  reference_image_notice?: string | null;
  is_draft?: boolean;
}

interface SeedanceDraftCapability {
  create_enabled: boolean;
  upgrade_enabled: boolean;
  message: string;
}

type CreateTaskResponse = CreateResponse & {
  error?: string;
  message?: string;
  code?: string;
  error_code?: string;
  submission_unconfirmed?: boolean;
  existing_task_id?: string;
  _debug?: object | null;
};

type WorkspaceBusyReason = 'read-error' | 'pending-attach' | 'uploading' | 'upload-failed' | 'saving' | 'picker-open' | 'loading' | null;

type GenerationSubmitParams = {
  pricingRevision?: string | null;
  quotedEstimatedCost?: number;
  prompt: string;
  generationMode: GenerationMode;
  ratio: VideoRatio;
  duration: VideoDuration;
  resolution: VideoResolution;
  seed: number;
  generateAudio: boolean;
  returnLastFrame: boolean;
  watermark: boolean;
  resolutionApprovalConfirmed: boolean;
  referenceImageIds?: string[];
  referenceVideoUrls?: string[];
  referenceAudioUrls?: string[];
  templateId?: string | null;
  agentRunId?: string | null;
  selectedAgentPlanKey?: string | null;
  agentPromptSnapshot?: string | null;
  finalPromptSnapshot?: string | null;
  promptUserEdited?: boolean;
  provider?: string | null;
  model?: string | null;
  h3LoraId?: string | null;
  draft?: boolean;
  templateStudioRunId: string | null;
  imageResultReceiptId?: string | null;
  templateStudioAssets: Array<{
    assetId: string;
    role: 'reference' | 'first' | 'last';
    type: 'image' | 'video' | 'audio';
    slotKey?: string;
  }>;
  templateStudioParameters: Record<string, unknown>;
};

function safeTemplateStudioReturnTo(value: string | null, runId: string | null, origin: string) {
  const fallback = runId
    ? `/template-studio?type=video&view=run&runId=${encodeURIComponent(runId)}`
    : null;
  if (!value) return fallback;
  if (value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return fallback;
  try {
    const target = new URL(value, origin);
    if (target.origin !== origin || target.pathname !== '/template-studio' || target.username || target.password) {
      return fallback;
    }
    return `${target.pathname}${target.search}`;
  } catch {
    return fallback;
  }
}

interface TaskItem {
  id: string;
  prompt: string;
  provider: string;
  generation_mode: string;
  model?: string | null;
  is_draft?: boolean;
  provider_draft_task_id?: string | null;
  draft_upgrade_mode?: string | null;
  source_draft_task_id?: string | null;
  draft_contract_version?: string | null;
  local_status: string;
  public_video_url: string | null;
  result_video_url: string | null;
  result_last_frame_url: string | null;
  local_video_path: string | null;
  error_message?: string | null;
  error_code?: string | null;
  delivery_error?: string | null;
  delivery_stage?: { key?: string | null; label?: string } | null;
  stable_download_ready?: boolean | null;
  preview_available?: boolean | null;
  retry_after_ms?: number | null;
  play_url?: string | null;
  download_url?: string | null;
  thumbnail_url?: string | null;
  provider_cost_currency: string | null;
  provider_official_amount_minor: number | null;
  provider_final_amount_minor: number | null;
  provider_official_amount_micros: number | null;
  provider_final_amount_micros: number | null;
  project_id?: string | null;
  video_card_id?: string | null;
  video_card?: { id: string; title: string; objective: string | null; status: string; project_id?: string } | null;
  template_id?: string | null;
  agent_run_id?: string | null;
  selected_agent_plan_key?: string | null;
  prompt_user_edited?: boolean;
  generation_template?: { id: string; name: string; template_key: string; version: string } | null;
  can_delete?: boolean;
  created_at: string;
}

interface TaskListPagination {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}

interface TaskListResponse {
  tasks?: TaskItem[];
  pagination?: Partial<TaskListPagination>;
  error?: string;
  message?: string;
}

interface PolledTask {
  id: string;
  local_status: string;
  provider_status: string | null;
  public_video_url?: string | null;
  result_video_url: string | null;
  result_last_frame_url?: string | null;
  local_video_path?: string | null;
  error_message: string | null;
  error_code?: string | null;
  delivery_error?: string | null;
  model?: string | null;
  delivery_stage?: { key?: string | null; label?: string } | null;
  stable_download_ready?: boolean | null;
  preview_available?: boolean | null;
  retry_after_ms?: number | null;
  play_url?: string | null;
  download_url?: string | null;
  thumbnail_url?: string | null;
  provider_cost_currency: string | null;
  provider_official_amount_minor: number | null;
  provider_final_amount_minor: number | null;
  provider_official_amount_micros: number | null;
  provider_final_amount_micros: number | null;
  video_card_id?: string | null;
  video_card?: { id: string; title: string; objective: string | null; status: string; project_id?: string } | null;
}

interface CreditSummary {
  balance: number;
  frozen_credits: number;
  available: number;
  monthly_used: number;
  total_used: number;
}

type GenerationProvider = 'seedance' | 'h3';
const H3_INLINE_MODEL_ID = 'h3';

interface ProjectOption {
  id: string;
  name: string;
  type: string;
  status?: string;
  owner_user_id: string;
  my_role: string | null;
  can_generate?: boolean;
  can_manage_project?: boolean;
  owner?: { id?: string; name: string | null; username: string | null; email?: string | null; avatar_url?: string | null; account_type?: string | null };
  _count?: { tasks: number; reference_albums?: number };
}

interface ReuseDraft {
  model?: string | null;
  taskId: string;
  reuseKey: number;
  prompt: string;
  generationMode: GenerationMode;
  ratio: VideoRatio;
  duration: VideoDuration;
  resolution: VideoResolution;
  seed: number;
  generateAudio: boolean;
  returnLastFrame: boolean;
  watermark: boolean;
  resolutionApprovalConfirmed?: boolean;
  projectId: string | null;
  videoCardId: string | null;
  videoBranchId?: string | null;
}

interface VideoCardOption {
  id: string;
  project_id: string;
  title: string;
  objective: string | null;
  status: string;
  platform?: string | null;
  ratio?: string | null;
  duration?: number | null;
  target_resolution?: string | null;
  ratio_locked?: boolean;
  is_fallback?: boolean;
  summary?: { task_count: number; charged_credits: number } | null;
}

interface VideoBranchOption {
  id: string;
  title: string;
  status: string;
  is_primary: boolean;
  summary?: { task_count: number; charged_credits: number } | null;
}

type ProjectRemovalAction = 'delete' | 'archive';

type PendingProjectRemoval = {
  project: ProjectOption;
  action: ProjectRemovalAction;
};

const PROJECT_STORAGE_KEY = 'generate_project_id';
const GENERATION_PREFERENCE_STORAGE_PREFIX = 'generation_defaults_v1:';
const RECENT_TASK_PAGE_SIZE = 12;
const RECENT_TASK_INITIAL_PREFETCH_MAX_PAGES = 4;
const RECENT_TASK_INITIAL_MIN_VISUALS = 6;
const MAX_ACTIVE_POLLING_TASKS = 12;
const POLLABLE_TASK_STATUSES = new Set(['submitted', 'running']);

type GenerateSurface = 'standard' | 'ip';

interface GenerateSurfaceConfig {
  routePath: string;
  titleLead: string;
  titleAccent: string;
  subtitle: string;
  heroLinks: Array<{ href: string; label: string; adminOnly?: boolean; externalHidden?: boolean; imageStudioOnly?: boolean }>;
  notice?: string;
  submitDisabledReason?: string;
  modelLabel: string;
}

interface GeneratePageClientProps {
  surface?: GenerateSurface;
}

const GENERATE_SURFACE_CONFIG: Record<GenerateSurface, GenerateSurfaceConfig> = {
  standard: {
    routePath: '/generate',
    titleLead: '用 AI 生成你的',
    titleAccent: '视频',
    subtitle: '上传参考图，描述你想生成的画面，Seedance 2.0 帮你实现',
    heroLinks: [
      { href: '/generate/enhance', label: '视频超分', adminOnly: true },
      { href: '/projects', label: '查看我的项目' },
      { href: '/generate/ip', label: 'IP生成' },
      { href: '/tools/avatar-studio', label: '人物生成', imageStudioOnly: true },
    ],
    modelLabel: 'Seedance 2.0',
  },
  ip: {
    routePath: '/generate/ip',
    titleLead: '(IP) 生成',
    titleAccent: '页',
    subtitle: '可以生成IP授权视频',
    heroLinks: [
      { href: '/generate', label: '普通生成', externalHidden: true },
      { href: '/tools/avatar-studio', label: '人物生成', imageStudioOnly: true },
      { href: '/generate/enhance', label: '视频超分', adminOnly: true },
      { href: '/projects', label: '查看我的项目' },
    ],
    modelLabel: '火山 IP 动画',
  },
};

function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeRecentTaskListResponse(data: TaskListResponse) {
  const page = toPositiveInt(data.pagination?.page, 1);
  const limit = toPositiveInt(data.pagination?.limit, RECENT_TASK_PAGE_SIZE);
  const total = Math.max(0, toPositiveInt(data.pagination?.total, data.tasks?.length ?? 0));
  const totalPagesFallback = Math.max(1, Math.ceil(total / limit));
  return {
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    pagination: {
      page,
      limit,
      total,
      total_pages: toPositiveInt(data.pagination?.total_pages, totalPagesFallback),
    },
  };
}

function mergeTasksById(primary: TaskItem[], secondary: TaskItem[]): TaskItem[] {
  const seen = new Set<string>();
  return [...primary, ...secondary].filter((task) => {
    if (!task.id || seen.has(task.id)) return false;
    seen.add(task.id);
    return true;
  });
}

function collectPollableTaskIds(
  tasks: Pick<TaskItem, 'id' | 'local_status' | 'delivery_stage' | 'stable_download_ready' | 'retry_after_ms'>[],
  isIpSurface: boolean,
): string[] {
  return tasks
    .filter((task) => task.id && (
      POLLABLE_TASK_STATUSES.has(task.local_status)
      || shouldContinuePollingStableDelivery(task, isIpSurface)
    ))
    .map((task) => task.id);
}

function mergePollingTaskIds(incomingIds: string[], currentIds: string[]): string[] {
  const seen = new Set<string>();
  return [...incomingIds, ...currentIds]
    .filter((taskId) => {
      if (!taskId || seen.has(taskId)) return false;
      seen.add(taskId);
      return true;
    })
    .slice(0, MAX_ACTIVE_POLLING_TASKS);
}

function shouldContinuePollingStableDelivery(task: Pick<PolledTask, 'local_status' | 'delivery_stage' | 'stable_download_ready' | 'retry_after_ms'>, isIpSurface: boolean) {
  if (task.local_status !== 'succeeded') return false;
  if (task.delivery_stage?.key === 'ready' || task.delivery_stage?.key === 'failed') return false;
  return task.delivery_stage?.key === 'preparing'
    || (task.stable_download_ready === false && Boolean(task.retry_after_ms));
}

function formatRecentTaskChargeText(chargeText: string): string {
  return chargeText.replace(/\s*USD(?=（|$)/g, '');
}

function isRecentEnhanceTask(task: Pick<TaskItem, 'provider' | 'generation_mode'>) {
  return task.generation_mode === 'enhance_video' || task.provider === 'volcengine_mediakit';
}

function generationPreferenceStorageKey(userId: string, surface: 'normal' | 'ip') {
  return `${GENERATION_PREFERENCE_STORAGE_PREFIX}${userId}${surface === 'ip' ? ':ip' : ''}`;
}

function readLocalGenerationDefaults(userId: string, surface: 'normal' | 'ip'): GenerationDefaults | null {
  try {
    const raw = window.localStorage.getItem(generationPreferenceStorageKey(userId, surface));
    return raw ? normalizeGenerationDefaults(JSON.parse(raw), surface) : null;
  } catch {
    return null;
  }
}

function writeLocalGenerationDefaults(userId: string, settings: GenerationDefaults, surface: 'normal' | 'ip') {
  try {
    window.localStorage.setItem(generationPreferenceStorageKey(userId, surface), JSON.stringify(settings));
  } catch {
    // 偏好缓存失败不影响生成。
  }
}

function projectDisplayName(project: ProjectOption): string {
  if (project.type === 'personal') return '个人空间';
  return project.name;
}

function projectOwnerUser(project: ProjectOption) {
  return project.owner || { id: project.owner_user_id, name: null, username: null };
}

function projectMetaLabel(project: ProjectOption): string {
  const kind = project.type === 'personal' ? '个人默认' : project.type === 'system' ? '系统项目' : '团队项目';
  const taskCount = project._count?.tasks || 0;
  const albumCount = project._count?.reference_albums || 0;
  return `${kind} · ${taskCount} 任务 · ${albumCount} 图集`;
}

function projectHasContent(project: ProjectOption): boolean {
  return (project._count?.tasks || 0) > 0 || (project._count?.reference_albums || 0) > 0;
}

function projectCanRemove(project: ProjectOption): boolean {
  return Boolean(
    project.can_manage_project
    && project.type !== 'personal'
    && project.type !== 'system',
  );
}

function projectRemovalAction(project: ProjectOption): ProjectRemovalAction {
  return projectHasContent(project) ? 'archive' : 'delete';
}

function projectRemovalLabel(project: ProjectOption): string {
  return projectHasContent(project) ? '归档' : '删除';
}

function projectRemovalTitle(project: ProjectOption): string {
  if (project.type === 'personal') return '默认项目不能删除';
  if (project.type === 'system') return '系统项目不能删除';
  if (!project.can_manage_project) return '你没有权限管理这个项目';
  return projectHasContent(project) ? '项目已有历史内容，只能归档' : '删除空项目';
}

function asVideoRatio(value?: string | null): VideoRatio | null {
  return RATIO_OPTIONS.includes(value as VideoRatio) ? value as VideoRatio : null;
}

function asVideoDuration(value?: number | null): VideoDuration | null {
  // Preserve the card's delivery duration; the composer validates it against the selected model.
  return isSeedanceVideoDuration(value, SEEDANCE_2_5_MODEL_ID) ? value : null;
}

function asVideoResolution(value?: string | null): VideoResolution | null {
  return RESOLUTION_OPTIONS.includes(value as VideoResolution) ? value as VideoResolution : null;
}

// ============================================================================
// Component
// ============================================================================

export function GeneratePageClient({ surface = 'standard' }: GeneratePageClientProps) {
  const { confirm, productDialog } = useProductDialog();
  const {
    user: currentUser,
    loadingUser: loadingSessionUser,
    hasLoadedUser,
    userLoadError,
    refreshUser,
  } = useAppSession();
  const loadingUser = !hasLoadedUser || loadingSessionUser;
  const activeAccountIdRef = useRef<string | null>(currentUser?.id || null);
  activeAccountIdRef.current = currentUser?.id || null;
  const previousAccountIdRef = useRef<string | null>(currentUser?.id || null);
  const surfaceConfig = GENERATE_SURFACE_CONFIG[surface];
  const isIpSurface = surface === 'ip';
  const projectPickerRef = useRef<HTMLDivElement | null>(null);
  const projectPickerMenuRef = useRef<HTMLDivElement>(null);
  const projectRemovalBackdropRef = useRef<HTMLDivElement>(null);
  const projectRemovalDialogRef = useRef<HTMLDivElement>(null);
  const appliedPreferenceProjectRef = useRef(false);
  const userChangedProjectRef = useRef(false);
  const userChangedVideoCardRef = useRef(false);
  const userChangedVideoBranchRef = useRef(false);
  const projectsRequestIdRef = useRef(0);
  const videoCardsRequestIdRef = useRef(0);
  const videoBranchesRequestIdRef = useRef(0);
  const collectionsRequestIdRef = useRef(0);
  const creditsRequestIdRef = useRef(0);
  const reuseRequestIdRef = useRef(0);
  const reuseInFlightRef = useRef(false);
  const selectedProjectIdRef = useRef('');
  const selectedVideoCardIdRef = useRef('');
  const selectedVideoBranchIdRef = useRef('');
  const workspaceBridgeKeyRef = useRef('');
  const workspaceRefreshRef = useRef<{ key: string; refresh: () => Promise<void> } | null>(null);
  const inputRecoveryRef = useRef<{ key: string; capture: () => boolean } | null>(null);
  const [inputRecoveryTarget, setInputRecoveryTarget] = useState<{ projectId: string; videoCardId: string; videoBranchId: string } | null>(null);
  const composerMainRef = useRef<HTMLElement | null>(null);
  const projectPanelRef = useRef<HTMLDivElement | null>(null);
  const videoCardPanelRef = useRef<HTMLDivElement | null>(null);

  // ---- Collections ----
  const [collections, setCollections] = useState<AssetCollection[]>([]);

  // ---- Submit State ----
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorDebug, setErrorDebug] = useState<object | null>(null);
  const [generationDefaults, setGenerationDefaults] = useState<GenerationDefaults | null>(null);
  const [generationDefaultsReady, setGenerationDefaultsReady] = useState(false);
  const preferenceWriteQueue = useRef<Promise<unknown>>(Promise.resolve());

  // ---- Recent Tasks ----
  const [recentTasks, setRecentTasks] = useState<TaskItem[]>([]);
  const [recentTasksPage, setRecentTasksPage] = useState(0);
  const [recentTasksHasMore, setRecentTasksHasMore] = useState(false);
  const [recentTasksLoadingInitial, setRecentTasksLoadingInitial] = useState(true);
  const [recentTasksLoadingMore, setRecentTasksLoadingMore] = useState(false);
  const [recentTasksError, setRecentTasksError] = useState('');
  const [deletingRecentTaskId, setDeletingRecentTaskId] = useState<string | null>(null);
  const [retryingDeliveryId, setRetryingDeliveryId] = useState<string | null>(null);
  const recentTasksSentinelRef = useRef<HTMLDivElement | null>(null);
  const recentTasksLoadingRef = useRef(false);
  const recentTasksPageRef = useRef(0);
  const recentTasksHasMoreRef = useRef(false);
  const lastH3AutoCheckAtRef = useRef(0);

  // ---- Result Polling ----
  const [polledResult, setPolledResult] = useState<PolledTask | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [activePollingTaskIds, setActivePollingTaskIds] = useState<string[]>([]);

  // ---- Credit Summary ----
  const [credits, setCredits] = useState<CreditSummary | null>(null);
  const [h3VideoConfig, setH3VideoConfig] = useState<H3VideoConfig | null>(null);
  const [h3CapabilitiesReady, setH3CapabilitiesReady] = useState(isIpSurface);
  const [seedanceDraftCapability, setSeedanceDraftCapability] = useState<SeedanceDraftCapability>({
    create_enabled: false,
    upgrade_enabled: false,
    message: '供应商 Draft 能力尚未完成核验，暂不可用。',
  });
  const [draftUpgradeTaskId, setDraftUpgradeTaskId] = useState<string | null>(null);
  const [h3StatusChecking, setH3StatusChecking] = useState(false);
  const [selectedH3LoraId, setSelectedH3LoraId] = useState('');
  const [selectedProvider, setSelectedProvider] = useState<GenerationProvider>('seedance');
  const [studioHandoff, setStudioHandoff] = useState<StudioGenerationHandoff | null>(null);
  const [studioRunId, setStudioRunId] = useState<string | null>(null);
  const [studioReturnTo, setStudioReturnTo] = useState<string | null>(null);
  const [projectReturnTo, setProjectReturnTo] = useState<string | null>(null);
  const [studioWorkspaceTabId, setStudioWorkspaceTabId] = useState<string | null>(null);
  const [studioHandoffLoading, setStudioHandoffLoading] = useState(false);
  const [studioHandoffError, setStudioHandoffError] = useState<string | null>(null);
  const [imageResultHandoff, setImageResultHandoff] = useState<ImageResultVideoHandoff | null>(null);
  const [imageResultLoading, setImageResultLoading] = useState(false);
  const [imageResultError, setImageResultError] = useState('');
  const [imageResultRequested, setImageResultRequested] = useState<boolean | null>(null);
  const [imageResultPendingReceipt, setImageResultPendingReceipt] = useState('');
  const [unconfirmedGenerationRequest, setUnconfirmedGenerationRequest] = useState(false);
  const studioHandoffRequestRef = useRef<string | null>(null);
  const forceNewGenerationRef = useRef(false);
  const unconfirmedGenerationParamsRef = useRef<GenerationSubmitParams | null>(null);

  useEffect(() => {
    if (loadingUser) return;
    const query = new URLSearchParams(window.location.search), id = query.get('image_result_handoff');
    setImageResultRequested(Boolean(id)); setImageResultHandoff(null); setImageResultError(''); setImageResultPendingReceipt('');
    if (!id) { setImageResultLoading(false); return; }
    if (!currentUser || isIpSurface || query.has('template_studio_run_id') || query.has('reuse_task_id')) {
      setImageResultLoading(false); setImageResultError('请用当前内部账户重新打开图片接续入口，不能与旧任务恢复混用。'); return;
    }
    const ownerId = currentUser.id, controller = new AbortController();
    setImageResultLoading(true);
    readImageResultHandoff(id, controller.signal).then(value => {
      if (controller.signal.aborted || activeAccountIdRef.current !== ownerId) return;
      if (value.intent !== 'video' || !value.workspaceTabId) throw new Error('这次原图尚未准备为视频首帧，请返回原结果');
      if (!value.ready) { setImageResultPendingReceipt(value.receiptId); throw new Error('原导入已经记录，首帧准备尚未完成。可继续准备同一次导入，不会生成视频。'); }
      sessionStorage.setItem('workspace_tab_id', value.workspaceTabId);
      setStudioWorkspaceTabId(value.workspaceTabId);
      setImageResultHandoff({ ...value, ownerId });
    }).catch(cause => {
      if (!controller.signal.aborted) setImageResultError(cause instanceof Error ? cause.message : '原图尚未读到，请返回原结果');
    }).finally(() => { if (!controller.signal.aborted) setImageResultLoading(false); });
    return () => controller.abort();
  }, [currentUser?.id, loadingUser, isIpSurface]);

  useEffect(() => {
    if (loadingUser) return;
    const accountId = currentUser?.id || null;
    const searchParams = new URLSearchParams(window.location.search);
    const runId = searchParams.get('template_studio_run_id')?.trim() || null;
    setStudioReturnTo(safeTemplateStudioReturnTo(
      searchParams.get('template_studio_return_to'),
      runId,
      window.location.origin,
    ));
    setProjectReturnTo(sanitizeOptionalReturnTo(searchParams.get('return_to')));
    if (!runId) {
      setStudioRunId(null);
      setStudioHandoff(null);
      setStudioHandoffLoading(false);
      return;
    }
    if (!accountId) {
      setStudioRunId(runId);
      setStudioHandoff(null);
      setStudioHandoffLoading(false);
      setStudioHandoffError('请登录后恢复模板运行记录。');
      return;
    }
    setStudioRunId(runId);
    const requestKey = `${accountId}:${runId}`;
    if (studioHandoffRequestRef.current === requestKey) return;
    studioHandoffRequestRef.current = requestKey;
    let cancelled = false;
    const isCurrentRequest = () => !cancelled && activeAccountIdRef.current === accountId;
    setStudioHandoffLoading(true);
    setStudioHandoffError(null);

    fetch('/api/template-studio-video-handoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId }),
    }).then(async (response) => {
      const data = await readJsonResponse<{
        handoff?: StudioGenerationHandoff;
        workspaceTabId?: string;
        error?: string;
        message?: string;
      }>(response);
      if (!response.ok || !data.handoff || !data.workspaceTabId) {
        throw new Error(data.message || data.error || '模板运行记录暂时无法接入普通生成');
      }
      if (!isCurrentRequest()) return;
      sessionStorage.setItem('workspace_tab_id', data.workspaceTabId);
      setStudioWorkspaceTabId(data.workspaceTabId);
      setStudioHandoff(data.handoff);
    }).catch((loadError) => {
      if (isCurrentRequest()) setStudioHandoffError(loadError instanceof Error ? loadError.message : '模板运行记录读取失败');
    }).finally(() => {
      if (isCurrentRequest()) setStudioHandoffLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [currentUser?.id, loadingUser]);

  // ---- Current Project ----
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const projectsRef = useRef(projects); projectsRef.current = projects;
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [projectCreateOpen, setProjectCreateOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectMessage, setProjectMessage] = useState<{ type: 'info' | 'error' | 'success'; text: string } | null>(null);
  const [pendingProjectRemoval, setPendingProjectRemoval] = useState<PendingProjectRemoval | null>(null);

  useDialogDismiss({
    open: projectPickerOpen,
    dialogRef: projectPickerMenuRef,
    branchRefs: [projectPickerRef],
    modal: false,
    onDismiss: () => {
      setProjectPickerOpen(false);
      setProjectCreateOpen(false);
    },
  });
  useDialogDismiss({
    open: Boolean(pendingProjectRemoval),
    dialogRef: projectRemovalDialogRef,
    dismissSurfaceRef: projectRemovalBackdropRef,
    onDismiss: () => setPendingProjectRemoval(null),
    dismissOnOutside: !projectBusy,
    dismissOnEscape: !projectBusy,
  });
	  const [videoCards, setVideoCards] = useState<VideoCardOption[]>([]);
	  const [selectedVideoCardId, setSelectedVideoCardId] = useState('');
	  const [videoBranches, setVideoBranches] = useState<VideoBranchOption[]>([]);
	  const [selectedVideoBranchId, setSelectedVideoBranchId] = useState('');
	  const [loadingVideoBranches, setLoadingVideoBranches] = useState(false);
	  const [loadingVideoCards, setLoadingVideoCards] = useState(false);
  const [videoCardsLoadedProjectId, setVideoCardsLoadedProjectId] = useState('');
  const [videoBranchesLoadedCardId, setVideoBranchesLoadedCardId] = useState('');
  const [videoCardTitle, setVideoCardTitle] = useState('');
  const [videoCardObjective, setVideoCardObjective] = useState('');
  const [videoCardBusy, setVideoCardBusy] = useState(false);
  const [videoCardMessage, setVideoCardMessage] = useState<{ type: 'info' | 'error' | 'success'; text: string } | null>(null);
  const [videoCardPanelOpen, setVideoCardPanelOpen] = useState(false);
  const [reuseDraft, setReuseDraft] = useState<ReuseDraft | null>(null);
  const [reuseMessage, setReuseMessage] = useState('');
  const [reuseLoading, setReuseLoading] = useState(false);
  const [reusingTaskId, setReusingTaskId] = useState<string | null>(null);
  const [reusePreflightPending, setReusePreflightPending] = useState(false);
  const [reuseOutcomeUnknown, setReuseOutcomeUnknown] = useState(false);
  const [reuseRefreshRequested, setReuseRefreshRequested] = useState(false);
  const [reuseRefreshInProgress, setReuseRefreshInProgress] = useState(false);
  const [reuseIntent, setReuseIntent] = useState<TaskReuseIntent | null>(null);
  const [reuseParameterOnlyAvailable, setReuseParameterOnlyAvailable] = useState(false);
  const parameterOnlyReuseRef = useRef<(() => Promise<void>) | null>(null);
  const reuseIntentRef = useRef<TaskReuseIntent | null>(null);
  const reuseEditEpochRef = useRef(0);
  const reuseApplicationKeyRef = useRef(0);
  const [reuseApplicationTick, setReuseApplicationTick] = useState(0);
  const pendingReuseApplicationRef = useRef<{
    taskId: string; reuseKey: number; accountId: string; bridgeKey: string; tabId: string;
    editEpoch: number; formApplied: boolean; message: string;
    projectId: string; videoCardId: string; videoBranchId: string;
  } | null>(null);
  const [composerReuseState, setComposerReuseState] = useState<ComposerReuseState & { key: string }>({
    key: '', initializing: true, conflict: false, editRevision: 0,
  });
  const composerReuseStateRef = useRef(composerReuseState);
  const [workspaceBusySnapshot, setWorkspaceBusySnapshot] = useState<{
    key: string;
    busy: boolean;
    reason: WorkspaceBusyReason;
  }>({ key: '', busy: true, reason: 'loading' });
  const workspaceBusySnapshotRef = useRef(workspaceBusySnapshot);
  const [workspaceRefreshReadyKey, setWorkspaceRefreshReadyKey] = useState('');

  selectedProjectIdRef.current = selectedProjectId;
  selectedVideoCardIdRef.current = selectedVideoCardId;
  selectedVideoBranchIdRef.current = selectedVideoBranchId;
  const workspaceBridgeKey = `${currentUser?.id || 'anonymous'}:${studioWorkspaceTabId || 'standard'}:${surface}`;
  workspaceBridgeKeyRef.current = workspaceBridgeKey;
  const workspaceBusy = workspaceBusySnapshot.key !== workspaceBridgeKey || workspaceBusySnapshot.busy;
  const reuseUiLocked = reusePreflightPending || reuseLoading || reuseOutcomeUnknown || reuseIntent?.phase === 'applying';
  const reuseContextBusy = workspaceBusy
    || loadingUser
    || loadingProjects
    || loadingVideoCards
    || loadingVideoBranches
    || projectBusy
    || videoCardBusy
    || projectPickerOpen
    || projectCreateOpen
    || videoCardPanelOpen
    || submitting
    || studioHandoffLoading
    || Boolean(studioRunId && !studioHandoff)
    || !generationDefaultsReady
    || Boolean(pendingProjectRemoval);
  const parentReuseInitializing = loadingUser || loadingProjects || loadingVideoCards || loadingVideoBranches
    || Boolean(selectedProjectId && videoCardsLoadedProjectId !== selectedProjectId)
    || Boolean(selectedVideoCardId && videoBranchesLoadedCardId !== selectedVideoCardId)
    || !generationDefaultsReady || studioHandoffLoading || imageResultLoading || imageResultRequested === null;
  const parentReuseConflict = studioRunId || studioHandoff || imageResultRequested
    ? '当前页面正在恢复模板或图片首帧，请从任务列表单独打开旧任务复用入口。'
    : submitting
      ? '当前生成正在提交，请等待结果后再继续复用。'
      : projectBusy || videoCardBusy || pendingProjectRemoval
        ? '项目或视频卡正在变更，请完成后再继续复用。'
        : projectPickerOpen || projectCreateOpen || videoCardPanelOpen
          ? '项目或视频卡选择仍打开，请完成或关闭后再继续复用。'
          : null;
  const reuseContextRef = useRef<TaskReuseContext>({
    accountId: currentUser?.id || null,
    workspaceBridgeKey,
    tabId: '',
    projectId: selectedProjectId,
    videoCardId: selectedVideoCardId,
    videoBranchId: selectedVideoBranchId,
    busy: reuseContextBusy,
    editEpoch: 0,
    initializing: true,
    conflict: null,
  });
  reuseContextRef.current = {
    accountId: currentUser?.id || null,
    workspaceBridgeKey,
    tabId: typeof window === 'undefined' ? '' : readTaskReuseTabId(() => sessionStorage.getItem('workspace_tab_id')) || '',
    projectId: selectedProjectId,
    videoCardId: selectedVideoCardId,
    videoBranchId: selectedVideoBranchId,
    busy: reuseContextBusy,
    editEpoch: reuseEditEpochRef.current,
    initializing: parentReuseInitializing || composerReuseState.key !== workspaceBridgeKey || composerReuseState.initializing,
    conflict: parentReuseConflict || (composerReuseState.key === workspaceBridgeKey && composerReuseState.conflict
      ? '参考素材仍有正在进行或未确认的操作，请处理后再继续复用。' : null),
  };

  const updateReuseIntent = useCallback((next: TaskReuseIntent | null) => {
    reuseIntentRef.current = next;
    setReuseIntent(next);
  }, []);

  const transitionReuseSourceUrl = useCallback((taskId: string, target: 'unconfirmed' | 'retryable' | 'consumed') => {
    const url = new URL(window.location.href);
    if (!transitionTaskReuseQuery(url, taskId, target)) return false;
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    return true;
  }, []);

  const readReuseContext = useCallback((): TaskReuseContext => {
    const current = reuseContextRef.current;
    const workspace = workspaceBusySnapshotRef.current;
    const composer = composerReuseStateRef.current;
    const workspaceBusyNow = workspace.key !== current.workspaceBridgeKey || workspace.busy;
    const composerConflict = composer.key === current.workspaceBridgeKey && composer.conflict;
    return {
      ...current,
      tabId: readTaskReuseTabId(() => sessionStorage.getItem('workspace_tab_id')) || '',
      editEpoch: reuseEditEpochRef.current,
      busy: current.busy || workspaceBusyNow || composerConflict,
      initializing: current.initializing || composer.key !== current.workspaceBridgeKey || composer.initializing,
      conflict: current.conflict || (composerConflict ? '参考素材仍有正在进行或未确认的操作，请处理后再继续复用。' : null),
    };
  }, []);

  const reportComposerReuseState = useCallback((next: ComposerReuseState) => {
    if (workspaceBridgeKeyRef.current !== workspaceBridgeKey) return;
    const previous = composerReuseStateRef.current;
    if (previous.key === workspaceBridgeKey && next.editRevision !== previous.editRevision) reuseEditEpochRef.current += 1;
    const value = { ...next, key: workspaceBridgeKey };
    composerReuseStateRef.current = value;
    setComposerReuseState((old) => old.key === value.key && old.initializing === value.initializing
      && old.conflict === value.conflict && old.editRevision === value.editRevision ? old : value);
  }, [workspaceBridgeKey]);

  const markReuseSelectionChanged = useCallback(() => {
    reuseEditEpochRef.current += 1;
  }, []);

  const reportWorkspaceBusy = useCallback((
    busy: boolean,
    reason: WorkspaceBusyReason = null,
  ) => {
    if (workspaceBridgeKeyRef.current !== workspaceBridgeKey) return;
    const value = { key: workspaceBridgeKey, busy, reason: busy ? reason : null };
    workspaceBusySnapshotRef.current = value;
    setWorkspaceBusySnapshot((old) => old.key === value.key && old.busy === value.busy && old.reason === value.reason ? old : value);
  }, [workspaceBridgeKey]);

  const reportWorkspaceRefreshReady = useCallback((refresh: (() => Promise<void>) | null) => {
    if (workspaceBridgeKeyRef.current !== workspaceBridgeKey) return;
    workspaceRefreshRef.current = refresh ? { key: workspaceBridgeKey, refresh } : null;
    setWorkspaceRefreshReadyKey(refresh ? workspaceBridgeKey : '');
  }, [workspaceBridgeKey]);

  const reportInputRecoveryReady = useCallback((capture: (() => boolean) | null) => {
    if (workspaceBridgeKeyRef.current !== workspaceBridgeKey) return;
    inputRecoveryRef.current = capture ? { key: workspaceBridgeKey, capture } : null;
  }, [workspaceBridgeKey]);

  const captureInputRecoveryTarget = useCallback(() => {
    const context = readReuseContext();
    return () => {
      if (activeAccountIdRef.current !== context.accountId || workspaceBridgeKeyRef.current !== context.workspaceBridgeKey
        || readReuseContext().tabId !== context.tabId) return;
      userChangedProjectRef.current = true;
      userChangedVideoCardRef.current = true;
      userChangedVideoBranchRef.current = true;
      setReuseDraft(null);
      const available = !context.projectId || projectsRef.current.some(project => project.id === context.projectId && project.can_generate !== false);
      const target = available
        ? { projectId: context.projectId, videoCardId: context.videoCardId, videoBranchId: context.videoBranchId }
        : { projectId: '', videoCardId: '', videoBranchId: '' };
      setInputRecoveryTarget(target);
      setSelectedProjectId(target.projectId);
      setSelectedVideoCardId(target.videoCardId);
      setSelectedVideoBranchId(target.videoBranchId);
      if (!available) setProjectMessage({ type: 'info', text: '原项目当前不可用，输入已恢复，请重新选择保存位置。' });
    };
  }, [readReuseContext]);

  const requestWorkspaceReadAfterUnknownReuse = useCallback(async () => {
    const entry = workspaceRefreshRef.current;
    if (!entry || entry.key !== workspaceBridgeKey) return;
    const owner = activeAccountIdRef.current;
    const requestId = reuseRequestIdRef.current;
    const stillCurrent = () => activeAccountIdRef.current === owner && workspaceBridgeKeyRef.current === entry.key
      && reuseRequestIdRef.current === requestId;
    setReuseRefreshRequested(false);
    setReuseRefreshInProgress(true);
    try {
      await entry.refresh();
      if (stillCurrent()) setReuseRefreshRequested(true);
    } catch {
      // The existing workspace refresh swallows errors; keep the result unresolved either way.
      if (stillCurrent()) setReuseRefreshRequested(true);
    } finally {
      if (stillCurrent()) setReuseRefreshInProgress(false);
    }
  }, [workspaceBridgeKey]);

  const requestWorkspaceReadAfterBusyError = useCallback(async () => {
    const entry = workspaceRefreshRef.current;
    if (!entry || entry.key !== workspaceBridgeKey) return;
    const owner = activeAccountIdRef.current;
    setReuseRefreshInProgress(true);
    try {
      await entry.refresh();
    } catch {
      // The existing workspace refresh catches errors internally; busy state remains authoritative.
    } finally {
      if (activeAccountIdRef.current === owner && workspaceBridgeKeyRef.current === entry.key) setReuseRefreshInProgress(false);
    }
  }, [workspaceBridgeKey]);

  useEffect(() => {
    const nextAccountId = currentUser?.id || null;
    const previousAccountId = previousAccountIdRef.current;
    const previousReuseIntent = reuseIntentRef.current;
    if (previousAccountId === nextAccountId) return;
    previousAccountIdRef.current = nextAccountId;
    projectsRequestIdRef.current += 1;
    videoCardsRequestIdRef.current += 1;
    videoBranchesRequestIdRef.current += 1;
    collectionsRequestIdRef.current += 1;
    creditsRequestIdRef.current += 1;
    reuseRequestIdRef.current += 1;
    reuseInFlightRef.current = false;
    userChangedProjectRef.current = false;
    userChangedVideoCardRef.current = false;
    userChangedVideoBranchRef.current = false;
    setProjects([]);
    setLoadingProjects(Boolean(nextAccountId));
    setSelectedProjectId('');
    setVideoCards([]);
    setLoadingVideoCards(false);
    setSelectedVideoCardId('');
    setVideoBranches([]);
    setLoadingVideoBranches(false);
    setSelectedVideoBranchId('');
    setVideoCardsLoadedProjectId('');
    setVideoBranchesLoadedCardId('');
    setCollections([]);
    setCredits(null);
    setStudioHandoff(null);
    setStudioWorkspaceTabId(null);
    setReuseDraft(null);
    setInputRecoveryTarget(null);
    setReuseLoading(false);
    setReusingTaskId(null);
    setReusePreflightPending(false);
    setReuseOutcomeUnknown(false);
    setReuseRefreshRequested(false);
    setReuseRefreshInProgress(false);
    updateReuseIntent(null);
    setReuseParameterOnlyAvailable(false);
    parameterOnlyReuseRef.current = null;
    pendingReuseApplicationRef.current = null;
    reuseEditEpochRef.current = 0;
    // A newly mounted child's effects can report before this account reset.
    // Do not erase a readiness report already belonging to the new account.
    if (composerReuseStateRef.current.key !== workspaceBridgeKey) {
      composerReuseStateRef.current = { key: '', initializing: true, conflict: false, editRevision: 0 };
      setComposerReuseState(composerReuseStateRef.current);
    }
    if (workspaceBusySnapshotRef.current.key !== workspaceBridgeKey) {
      workspaceBusySnapshotRef.current = { key: '', busy: true, reason: 'loading' };
      setWorkspaceBusySnapshot(workspaceBusySnapshotRef.current);
    }
    if (workspaceRefreshRef.current?.key !== workspaceBridgeKey) {
      workspaceRefreshRef.current = null;
      setWorkspaceRefreshReadyKey('');
    }
    if (previousAccountId && previousAccountId !== nextAccountId) {
      const currentUrl = new URL(window.location.href);
      const previousTaskId = previousReuseIntent?.taskId || currentUrl.searchParams.get('reuse_task_id')
        || currentUrl.searchParams.get('reuse_unconfirmed_task_id');
      if (previousTaskId && transitionTaskReuseQuery(currentUrl, previousTaskId, 'consumed')) {
        window.history.replaceState(null, '', `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
      }
      setReuseMessage('登录账号已变化，未继续恢复旧账号的输入；如果此前已发送请求，结果须回到原账号核对。请从当前账号的任务重新打开。');
    } else {
      setReuseMessage('');
    }
  }, [currentUser?.id, updateReuseIntent, workspaceBridgeKey]);
  const isExternalIpUser = isIpSurface && isExternalUser(currentUser);
  const hideExternalIpInternalControls = isIpSurface && (loadingUser || isExternalUser(currentUser));

  useEffect(() => {
    [composerMainRef.current, projectPanelRef.current, videoCardPanelRef.current].forEach((element) => {
      if (!element) return;
      if (reuseUiLocked) element.setAttribute('inert', '');
      else element.removeAttribute('inert');
    });
  }, [hideExternalIpInternalControls, reuseUiLocked]);

  const h3Ready = !isIpSurface
    && h3VideoConfig?.ready === true
    && h3VideoConfig.preset_options.length > 0;
  const selectedH3Preset = h3VideoConfig?.preset_options.find((option) => option.id === h3VideoConfig.default_preset_id)
    || h3VideoConfig?.preset_options[0]
    || null;
  const selectedH3Lora = h3VideoConfig?.lora_options.find((option) => option.id === selectedH3LoraId)
    || h3VideoConfig?.lora_options.find((option) => option.id === h3VideoConfig.default_lora_id)
    || h3VideoConfig?.lora_options[0]
    || null;
  const activeH3LoraOptions = selectedProvider === 'h3' && h3Ready
    ? h3VideoConfig?.lora_options || []
    : [];
  const activeModelOptions = useMemo<ComposerSelectOption[]>(() => {
    if (isIpSurface) return VOLCENGINE_IP_MODEL_OPTIONS.map(option => ({ ...option,
      detail: `4–${seedanceVideoMaxDuration(option.id)} 秒 · ${volcengineIpModelResolutions(option.id).join(' / ')}` }));
    const options = SEEDANCE_VIDEO_MODEL_OPTIONS.map((option) => option.id === SEEDANCE_2_5_MODEL_ID
      ? {
          ...option,
          detail: `${option.detail} · ${seedanceDraftCapability.create_enabled ? '支持样片 Draft' : '样片 Draft 待供应商确认'}`,
        }
      : option);
    const canSeeH3 = h3Ready || currentUser?.role === 'admin';
    if (canSeeH3) {
      options.push({
        id: H3_INLINE_MODEL_ID,
        label: h3Ready ? 'H3 本地模型' : 'H3 待检查',
        detail: h3Ready
          ? `本地处理 · ${selectedH3Preset?.label || h3VideoConfig?.default_preset_id || '默认预设'} · ${selectedH3Lora?.label || h3VideoConfig?.default_lora_id || '默认 LoRA'}`
          : `${h3DisabledReason(h3VideoConfig)} · 选择后点检查状态`,
      });
    }
    return options;
  }, [currentUser?.role, h3Ready, h3VideoConfig, isIpSurface, seedanceDraftCapability.create_enabled, selectedH3Lora?.label, selectedH3Preset?.label]);
  const activeModelLabel = surfaceConfig.modelLabel;
  const generationReturnTo = useMemo(() => {
    const params = new URLSearchParams();
    if (studioRunId) params.set('template_studio_run_id', studioRunId);
    if (studioReturnTo) params.set('template_studio_return_to', studioReturnTo);
    if (projectReturnTo) params.set('return_to', projectReturnTo);
    const query = params.toString();
    return query ? `${surfaceConfig.routePath}?${query}` : surfaceConfig.routePath;
  }, [projectReturnTo, studioReturnTo, studioRunId, surfaceConfig.routePath]);
  const activeProviderLabel = 'Seedance 视频';
  const refreshH3VideoConfig = useCallback(async () => {
    if (isIpSurface) return null;
    try {
      const response = await fetch('/api/config', { cache: 'no-store' });
      const data = response.ok ? await response.json() : null;
      const nextConfig = normalizeH3VideoConfig(data?.h3_video);
      setH3VideoConfig(nextConfig);
      setH3CapabilitiesReady(true);
      if (data?.seedance_draft) setSeedanceDraftCapability(data.seedance_draft);
      return nextConfig;
    } catch {
      setH3VideoConfig(null);
      setH3CapabilitiesReady(true);
      return null;
    }
  }, [isIpSurface]);
  const checkH3MachineStatus = useCallback(async (options?: { silent?: boolean }) => {
    if (isIpSurface || h3StatusChecking) return;
    setH3StatusChecking(true);
    if (!options?.silent) setError(null);
    try {
      const response = currentUser?.role === 'admin'
        ? await fetch('/api/admin/integrations/h3', { method: 'POST', cache: 'no-store' })
        : await fetch('/api/config', { cache: 'no-store' });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || data?.message || `H3 状态检查失败 (HTTP ${response.status})`);
      }
      setH3VideoConfig(normalizeH3VideoConfig(currentUser?.role === 'admin' ? data?.config : data?.h3_video));
      setH3CapabilitiesReady(true);
      if (data?.seedance_draft) setSeedanceDraftCapability(data.seedance_draft);
    } catch (error) {
      if (!options?.silent) {
        setError(error instanceof Error ? error.message : 'H3 状态检查失败');
      }
    } finally {
      setH3StatusChecking(false);
      setH3CapabilitiesReady(true);
    }
  }, [currentUser?.role, h3StatusChecking, isIpSurface]);
  const h3MachineStatus = useMemo(() => {
    const status = buildH3MachineStatus({
      config: h3VideoConfig,
      selectedProvider,
    });
    if (!status) return null;
    if (currentUser?.role !== 'admin') return status;
    return {
      ...status,
      actionLabel: '刷新',
      actionTitle: '状态会自动刷新；这里用于手动立即刷新 H3 API、Worker、队列和免费计费状态',
      actionBusy: h3StatusChecking,
      onAction: checkH3MachineStatus,
    };
  }, [checkH3MachineStatus, currentUser?.role, h3StatusChecking, h3VideoConfig, selectedProvider]);
  const displayRecentTasks = useMemo(() => orderRecentTaskCards(recentTasks), [recentTasks]);
  const handleGenerationModelChange = useCallback((model: string) => {
    if (model === H3_INLINE_MODEL_ID) {
      setSelectedProvider('h3');
      void refreshH3VideoConfig();
      return;
    }
    setSelectedProvider('seedance');
  }, [refreshH3VideoConfig]);

  useEffect(() => {
    const options = h3VideoConfig?.lora_options || [];
    if (options.length === 0) {
      if (selectedH3LoraId) setSelectedH3LoraId('');
      return;
    }
    if (!options.some((option) => option.id === selectedH3LoraId)) {
      setSelectedH3LoraId(h3VideoConfig?.default_lora_id || options[0]?.id || '');
    }
  }, [h3VideoConfig, selectedH3LoraId]);

  // ============================================================================
  // Load collections
  // ============================================================================

  useEffect(() => {
    if (!hasLoadedUser && !loadingSessionUser) void refreshUser();
  }, [hasLoadedUser, loadingSessionUser, refreshUser]);

  useEffect(() => {
    if (!loadingUser && !isIpSurface && isExternalUser(currentUser)) {
      const currentUrl = new URL(window.location.href);
      const fallbackUrl = new URL(externalFallbackPath(), window.location.origin);
      const returnTo = sanitizeOptionalReturnTo(currentUrl.searchParams.get('return_to'));
      if (returnTo) fallbackUrl.searchParams.set('return_to', returnTo);

      ['reuse_task_id', 'reuse_unconfirmed_task_id', 'project_id', 'video_card_id', 'video_branch_id'].forEach((key) => {
        const value = currentUrl.searchParams.get(key)?.trim();
        if (value && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)) {
          fallbackUrl.searchParams.set(key, value);
        }
      });
      const templateStudioRunId = currentUrl.searchParams.get('template_studio_run_id')?.trim() || null;
      if (templateStudioRunId && templateStudioRunId.length <= 200 && !/[\u0000-\u001f\u007f]/.test(templateStudioRunId)) {
        fallbackUrl.searchParams.set('template_studio_run_id', templateStudioRunId);
      }
      const templateStudioReturnTo = safeTemplateStudioReturnTo(
        currentUrl.searchParams.get('template_studio_return_to'),
        templateStudioRunId,
        window.location.origin,
      );
      if (templateStudioReturnTo) fallbackUrl.searchParams.set('template_studio_return_to', templateStudioReturnTo);

      window.location.replace(`${fallbackUrl.pathname}${fallbackUrl.search}${fallbackUrl.hash}`);
    }
  }, [currentUser, isIpSurface, loadingUser]);

  useEffect(() => {
    if (!currentUser?.id) return;
    let cancelled = false;
    setGenerationDefaultsReady(false);
    const preferenceSurface = isIpSurface ? 'ip' : 'normal';
    const localFallback = readLocalGenerationDefaults(currentUser.id, preferenceSurface);

    const applySettings = (settings: GenerationDefaults | null) => {
      if (!settings || cancelled) return;
      setGenerationDefaults(settings);
      if (settings.projectId) {
        window.localStorage.setItem(PROJECT_STORAGE_KEY, settings.projectId);
      }
      writeLocalGenerationDefaults(currentUser.id, settings, preferenceSurface);
    };

    fetch(`/api/me/preferences/generation?surface=${preferenceSurface}`, { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        const settings = data?.settings ? normalizeGenerationDefaults(data.settings, preferenceSurface) : localFallback;
        applySettings(settings);
      })
      .catch(() => {
        applySettings(localFallback);
      })
      .finally(() => {
        if (!cancelled) setGenerationDefaultsReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [currentUser?.id, isIpSurface]);

  useEffect(() => {
    if (isIpSurface) return;
    let cancelled = false;
    fetch('/api/config', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (cancelled) return;
        setH3VideoConfig(normalizeH3VideoConfig(data?.h3_video));
        setH3CapabilitiesReady(true);
        if (data?.seedance_draft) setSeedanceDraftCapability(data.seedance_draft);
      })
      .catch(() => {
        if (!cancelled) {
          setH3VideoConfig(null);
          setH3CapabilitiesReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isIpSurface]);

  useEffect(() => {
    if (isIpSurface && selectedProvider !== 'seedance') {
      setSelectedProvider('seedance');
    }
  }, [isIpSurface, selectedProvider]);

  const triggerH3AutoCheck = useCallback(() => {
    if (isIpSurface || selectedProvider !== 'h3' || currentUser?.role !== 'admin') return;
    if (h3StatusChecking || !isH3HealthCheckDue(h3VideoConfig)) return;
    const now = Date.now();
    if (now - lastH3AutoCheckAtRef.current < H3_AUTO_CHECK_MIN_GAP_MS) return;
    lastH3AutoCheckAtRef.current = now;
    void checkH3MachineStatus({ silent: true });
  }, [
    checkH3MachineStatus,
    currentUser?.role,
    h3StatusChecking,
    h3VideoConfig,
    isIpSurface,
    selectedProvider,
  ]);

  useEffect(() => {
    triggerH3AutoCheck();
  }, [triggerH3AutoCheck]);

  useEffect(() => {
    if (isIpSurface || selectedProvider !== 'h3' || currentUser?.role !== 'admin') return;
    const timer = window.setInterval(triggerH3AutoCheck, H3_AUTO_CHECK_MIN_GAP_MS);
    window.addEventListener('focus', triggerH3AutoCheck);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', triggerH3AutoCheck);
    };
  }, [currentUser?.role, isIpSurface, selectedProvider, triggerH3AutoCheck]);

  useEffect(() => {
    const accountId = currentUser?.id || null;
    if (loadingUser || !accountId) return;
    const requestId = ++collectionsRequestIdRef.current;
    const isCurrentRequest = () => collectionsRequestIdRef.current === requestId
      && activeAccountIdRef.current === accountId;
    void fetch('/api/collections', { cache: 'no-store' })
      .then(async (response) => {
        if (!isCurrentRequest()) return null;
        if (response.status === 401) {
          window.location.href = '/login';
          return null;
        }
        if ([403, 404].includes(response.status)) {
          setCollections([]);
          return null;
        }
        const data = await readJsonResponse<{ collections?: AssetCollection[] }>(response);
        if (!isCurrentRequest() || !response.ok) return null;
        setCollections(data.collections || []);
        return data;
      })
      .catch(() => {});
    return () => {
      if (collectionsRequestIdRef.current === requestId) collectionsRequestIdRef.current += 1;
    };
  }, [currentUser?.id, loadingUser]);

  useEffect(() => {
    const accountId = currentUser?.id || null;
    if (loadingUser || !accountId) return;
    const requestId = ++creditsRequestIdRef.current;
    const isCurrentRequest = () => creditsRequestIdRef.current === requestId
      && activeAccountIdRef.current === accountId;
    void fetch('/api/me/credits', { cache: 'no-store' })
      .then(async (response) => {
        if (!isCurrentRequest()) return null;
        if (response.status === 401) {
          window.location.href = '/login';
          return null;
        }
        if ([403, 404].includes(response.status)) {
          setCredits(null);
          return null;
        }
        const data = await response.json();
        if (!isCurrentRequest() || !response.ok) return null;
        setCredits(data);
        return data;
      })
      .catch(() => {});
    return () => {
      if (creditsRequestIdRef.current === requestId) creditsRequestIdRef.current += 1;
    };
  }, [currentUser?.id, loadingUser]);

  const loadProjects = useCallback(async (options: {
    preferredProjectId?: string | null;
    keepSelected?: boolean;
  } = {}) => {
    const accountId = currentUser?.id || null;
    if (loadingUser || !accountId) return;
    const requestId = ++projectsRequestIdRef.current;
    const isCurrentRequest = () => projectsRequestIdRef.current === requestId
      && activeAccountIdRef.current === accountId;
    setLoadingProjects(true);
    try {
      const res = await fetch('/api/projects', { cache: 'no-store' });
      if (!isCurrentRequest()) return;
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      if ([403, 404].includes(res.status)) {
        setProjects([]);
        setSelectedProjectId('');
        throw new Error('当前账号无法读取项目列表，请重新检查登录状态。');
      }
      const data = await readJsonResponse<{ projects?: ProjectOption[] }>(res);
      if (!isCurrentRequest()) return;
      if (!res.ok) throw new Error('项目列表加载失败');
      const list: ProjectOption[] = (data.projects || []).filter((project: ProjectOption) => project.can_generate !== false);
      setProjects(list);

      const requestedProjectId = new URLSearchParams(window.location.search).get('project_id');
      const rememberedProjectId = window.localStorage.getItem(PROJECT_STORAGE_KEY);
      const preferredId = options.preferredProjectId
        || (userChangedProjectRef.current ? '' : requestedProjectId || rememberedProjectId || '');

      setSelectedProjectId((current) => {
        const currentProject = options.keepSelected !== false && current
          ? list.find((project) => project.id === current)
          : null;
        if (userChangedProjectRef.current && !options.preferredProjectId && currentProject) return currentProject.id;

        const preferred = preferredId ? list.find((project) => project.id === preferredId) : null;
        if (preferred) return preferred.id;

        if (currentProject) return currentProject.id;

        const personal = list.find((project) => project.type === 'personal');
        return (personal || list[0])?.id || '';
      });
    } catch (error) {
      if (isCurrentRequest()) {
        setProjectMessage({
          type: 'error',
          text: error instanceof Error ? error.message : '项目列表加载失败，请刷新后重试',
        });
      }
    } finally {
      if (isCurrentRequest()) setLoadingProjects(false);
    }
  }, [currentUser?.id, loadingUser]);

  useEffect(() => {
    if (!loadingUser && currentUser?.id) void loadProjects({ keepSelected: false });
  }, [currentUser?.id, loadProjects, loadingUser]);

  useEffect(() => {
    if (!selectedProjectId) return;
    window.localStorage.setItem(PROJECT_STORAGE_KEY, selectedProjectId);
  }, [selectedProjectId]);

  const loadVideoCards = useCallback(async (
    projectId: string,
    options: { preferredVideoCardId?: string | null; keepSelected?: boolean; forcePreferred?: boolean; strictPreferred?: boolean } = {},
  ) => {
    const accountId = currentUser?.id || null;
    const requestId = ++videoCardsRequestIdRef.current;
    setVideoCardsLoadedProjectId('');
    if (!projectId) {
      setVideoCards([]);
      setSelectedVideoCardId('');
      setLoadingVideoCards(false);
      return;
    }
    if (loadingUser || !accountId) return;
    const isCurrentRequest = () => videoCardsRequestIdRef.current === requestId
      && activeAccountIdRef.current === accountId
      && selectedProjectIdRef.current === projectId;
    setLoadingVideoCards(true);
    setVideoCardMessage(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/video-cards`, { cache: 'no-store' });
      if (!isCurrentRequest()) return;
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      if ([403, 404].includes(res.status)) {
        setVideoCards([]);
        setSelectedVideoCardId('');
        setVideoBranches([]);
        setSelectedVideoBranchId('');
        throw new Error('当前账号无法读取该项目的视频卡，已清除旧选择。');
      }
      const data = await readJsonResponse<{ video_cards?: VideoCardOption[]; error?: string; message?: string }>(res);
      if (!isCurrentRequest()) return;
      if (!res.ok) throw new Error(data.message || data.error || '视频卡列表加载失败');
      const list: VideoCardOption[] = data.video_cards || [];
      setVideoCards(list);
      if (options.strictPreferred && options.preferredVideoCardId
        && !list.some(card => card.id === options.preferredVideoCardId && ['draft', 'active', 'reviewing'].includes(card.status))) {
        setVideoCardMessage({ type: 'info', text: '原视频卡当前不可用，未另选视频卡，请重新选择。' });
      }
      const requestedVideoCardId = new URLSearchParams(window.location.search).get('video_card_id');
      const preferredId = options.forcePreferred
        ? options.preferredVideoCardId || ''
        : userChangedVideoCardRef.current
          ? ''
          : requestedVideoCardId || options.preferredVideoCardId || '';
      setSelectedVideoCardId((current) => {
        if (options.forcePreferred && !options.preferredVideoCardId) return '';
        const currentCard = options.keepSelected !== false && current
          ? list.find((card) => card.id === current)
          : null;
        if (!options.forcePreferred && userChangedVideoCardRef.current && currentCard) return currentCard.id;

        const preferred = preferredId ? list.find((card) => card.id === preferredId
          && (!options.strictPreferred || ['draft', 'active', 'reviewing'].includes(card.status))) : null;
        if (preferred) return preferred.id;
        if (options.strictPreferred) return '';
        if (currentCard) return currentCard.id;
        const active = list.find((card) => card.status !== 'sealed' && card.status !== 'archived');
        return (active || list[0])?.id || '';
      });
    } catch (err) {
      if (isCurrentRequest()) {
        setVideoCards([]);
        setSelectedVideoCardId('');
        setVideoCardMessage({ type: 'error', text: err instanceof Error ? err.message : '视频卡列表加载失败' });
      }
    } finally {
      if (isCurrentRequest()) {
        setLoadingVideoCards(false);
        setVideoCardsLoadedProjectId(projectId);
      }
    }
  }, [currentUser?.id, loadingUser]);


  useEffect(() => {
    const recovery = inputRecoveryTarget?.projectId === selectedProjectId ? inputRecoveryTarget : null;
    void loadVideoCards(selectedProjectId, {
      preferredVideoCardId: recovery ? recovery.videoCardId : reuseDraft?.videoCardId || null,
      keepSelected: true,
      forcePreferred: Boolean(recovery || reuseDraft && reuseDraft.projectId === selectedProjectId),
      strictPreferred: Boolean(recovery),
    });
  }, [loadVideoCards, selectedProjectId, reuseDraft?.videoCardId, inputRecoveryTarget]);

	  useEffect(() => {
	    const requestId = ++videoBranchesRequestIdRef.current;
    setVideoBranchesLoadedCardId('');
	    const accountId = currentUser?.id || null;
	    let cancelled = false;
	    const isCurrentRequest = () => !cancelled
	      && videoBranchesRequestIdRef.current === requestId
	      && Boolean(accountId)
	      && activeAccountIdRef.current === accountId
	      && selectedVideoCardIdRef.current === selectedVideoCardId;

	    if (!selectedVideoCardId || loadingUser || !accountId) {
	      setVideoBranches([]);
	      setSelectedVideoBranchId('');
	      setLoadingVideoBranches(false);
	      return () => { cancelled = true; };
	    }

	    setVideoBranches([]);
	    setSelectedVideoBranchId('');
	    setLoadingVideoBranches(true);
	    void fetch(`/api/video-cards/${selectedVideoCardId}/branches`, { cache: 'no-store' })
	      .then(async (res) => {
	        if (!isCurrentRequest()) return null;
	        if (res.status === 401) {
	          window.location.href = '/login';
	          return null;
	        }
	        if ([403, 404].includes(res.status)) {
	          setVideoBranches([]);
	          setSelectedVideoBranchId('');
	          return null;
	        }
	        const data = await res.json();
	        if (!isCurrentRequest()) return null;
	        if (!res.ok) throw new Error(data.message || data.error || '方向分支加载失败');
	        return data;
	      })
	      .then((data) => {
	        if (!data || !isCurrentRequest()) return;
	        const list: VideoBranchOption[] = Array.isArray(data.branches) ? data.branches : [];
	        const active = list.filter((branch) => ['exploring', 'candidate', 'primary'].includes(branch.status));
	        setVideoBranches(active);
	        if (inputRecoveryTarget?.videoCardId === selectedVideoCardId) {
            setSelectedVideoBranchId(active.some(branch => branch.id === inputRecoveryTarget.videoBranchId) ? inputRecoveryTarget.videoBranchId : '');
            return;
          }
	        const requestedBranchId = userChangedVideoBranchRef.current
	          ? null
	          : reuseDraft?.videoCardId === selectedVideoCardId
            ? reuseDraft.videoBranchId || null
            : new URLSearchParams(window.location.search).get('video_branch_id');
	        setSelectedVideoBranchId((current) => {
	          if (requestedBranchId && active.some((branch) => branch.id === requestedBranchId)) return requestedBranchId;
          if (reuseDraft?.videoCardId === selectedVideoCardId) return '';
	          if (current && active.some((branch) => branch.id === current)) return current;
	          return active.find((branch) => branch.is_primary)?.id || '';
	        });
	      })
	      .catch(() => {
	        if (isCurrentRequest()) {
	          setVideoBranches([]);
	          setSelectedVideoBranchId('');
	        }
	      })
	      .finally(() => {
	        if (isCurrentRequest()) {
          setLoadingVideoBranches(false);
          setVideoBranchesLoadedCardId(selectedVideoCardId);
        }
	      });
	    return () => {
	      cancelled = true;
	    };
	  }, [currentUser?.id, loadingUser, selectedVideoCardId, reuseDraft?.videoCardId, reuseDraft?.videoBranchId, inputRecoveryTarget]);

  useEffect(() => {
    if (appliedPreferenceProjectRef.current) return;
    if (!generationDefaults?.projectId || projects.length === 0 || userChangedProjectRef.current) return;
    const requestedProjectId = new URLSearchParams(window.location.search).get('project_id');
    if (requestedProjectId || reuseDraft?.projectId) return;

    const preferred = projects.find((project) => project.id === generationDefaults.projectId);
    if (!preferred) return;
    appliedPreferenceProjectRef.current = true;
    setSelectedProjectId(preferred.id);
  }, [generationDefaults?.projectId, projects, reuseDraft?.projectId]);

  const handleCreateProject = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = projectName.trim();
    if (!name) {
      setProjectMessage({ type: 'error', text: '项目名称不能为空' });
      return;
    }

    setProjectBusy(true);
    setProjectMessage(null);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type: 'team' }),
      });
      const data = await readJsonResponse<{ project: ProjectOption; error?: string; message?: string }>(res);
      if (!res.ok) throw new Error(data.message || data.error || '新建项目失败');

      userChangedProjectRef.current = true;
      setProjectName('');
      setProjectCreateOpen(false);
      setProjectPickerOpen(false);
      setProjectMessage({ type: 'success', text: `已新建项目「${data.project.name}」` });
      await loadProjects({ preferredProjectId: data.project.id, keepSelected: false });
    } catch (err) {
      setProjectMessage({ type: 'error', text: err instanceof Error ? err.message : '新建项目失败' });
    } finally {
      setProjectBusy(false);
    }
  }, [loadProjects, projectName]);

  const handleCreateVideoCard = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = videoCardTitle.trim();
    if (!selectedProjectId) {
      setVideoCardMessage({ type: 'error', text: '请先选择项目' });
      return;
    }
    if (!title) {
      setVideoCardMessage({ type: 'error', text: '视频卡标题不能为空' });
      return;
    }

    setVideoCardBusy(true);
    setVideoCardMessage(null);
    try {
      const res = await fetch(`/api/projects/${selectedProjectId}/video-cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          objective: videoCardObjective.trim() || null,
        }),
      });
      const data = await readJsonResponse<{ video_card: VideoCardOption; error?: string; message?: string }>(res);
      if (!res.ok) throw new Error(data.message || data.error || '创建视频卡失败');
      setVideoCardTitle('');
      setVideoCardObjective('');
      userChangedVideoCardRef.current = true;
      setSelectedVideoCardId(data.video_card.id);
      setVideoCardMessage({ type: 'success', text: `已创建视频卡「${data.video_card.title}」` });
      await loadVideoCards(selectedProjectId, {
        preferredVideoCardId: data.video_card.id,
        keepSelected: false,
        forcePreferred: true,
      });
    } catch (err) {
      setVideoCardMessage({ type: 'error', text: err instanceof Error ? err.message : '创建视频卡失败' });
    } finally {
      setVideoCardBusy(false);
    }
  }, [loadVideoCards, selectedProjectId, videoCardObjective, videoCardTitle]);

  const handleProjectRemoval = useCallback((project: ProjectOption) => {
    const action = projectRemovalAction(project);

    if (project.type === 'personal' || project.type === 'system') {
      setProjectMessage({ type: 'error', text: '默认项目不能删除' });
      return;
    }
    if (!project.can_manage_project) {
      setProjectMessage({ type: 'error', text: '你没有权限管理这个项目' });
      return;
    }

    setPendingProjectRemoval({ project, action });
    setProjectPickerOpen(false);
    setProjectCreateOpen(false);
    setProjectMessage(null);
  }, []);

  const confirmProjectRemoval = useCallback(async () => {
    if (!pendingProjectRemoval) return;

    const { project, action } = pendingProjectRemoval;

    setProjectBusy(true);
    setProjectMessage(null);
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: action === 'archive' ? 'PATCH' : 'DELETE',
        headers: action === 'archive' ? { 'Content-Type': 'application/json' } : undefined,
        body: action === 'archive' ? JSON.stringify({ action: 'archive' }) : undefined,
      });
      const data = await readJsonResponse<{ error?: string; message?: string }>(res);
      if (!res.ok) {
        if (action === 'delete' && typeof data.error === 'string' && data.error.includes('归档')) {
          setProjectMessage({
            type: 'info',
            text: '项目已有历史内容，不能删除；请改为归档项目。',
          });
          setPendingProjectRemoval(null);
          return;
        }
        throw new Error(data.message || data.error || '项目操作失败');
      }

      setProjectMessage({
        type: 'success',
        text: action === 'archive' ? `已归档项目「${projectDisplayName(project)}」` : `已删除项目「${projectDisplayName(project)}」`,
      });
      setPendingProjectRemoval(null);
      await loadProjects({
        preferredProjectId: project.id === selectedProjectId ? null : selectedProjectId,
        keepSelected: project.id !== selectedProjectId,
      });
    } catch (err) {
      setProjectMessage({ type: 'error', text: err instanceof Error ? err.message : '项目操作失败' });
      setPendingProjectRemoval(null);
    } finally {
      setProjectBusy(false);
    }
  }, [loadProjects, pendingProjectRemoval, selectedProjectId]);

  useEffect(() => {
    if (!projectMessage) return;
    if (projectMessage.type === 'error') return;
    const timeoutId = window.setTimeout(() => {
      setProjectMessage(null);
    }, 3600);
    return () => window.clearTimeout(timeoutId);
  }, [projectMessage]);

  useEffect(() => {
    if (!reuseDraft?.projectId) return;
    const requestedProjectId = new URLSearchParams(window.location.search).get('project_id');
    if (requestedProjectId || userChangedProjectRef.current) return;
    if (projects.some((project) => project.id === reuseDraft.projectId)) {
      setSelectedProjectId(reuseDraft.projectId);
    }
  }, [projects, reuseDraft?.projectId]);

  const loadReusableTask = useCallback(async (
    taskId: string,
    options: { clearUrl?: boolean; scrollToComposer?: boolean } = {},
  ) => {
    if (reuseInFlightRef.current || reuseIntentRef.current?.phase === 'unknown' || reuseIntentRef.current?.phase === 'applying') return;
    const accountId = currentUser?.id || null;
    if (loadingUser || !accountId) {
      setReuseMessage('登录状态尚未确认，未发送复用请求。');
      return;
    }
    const previousIntent = reuseIntentRef.current;
    if (previousIntent && previousIntent.phase !== 'done' && previousIntent.taskId !== taskId) {
      setReuseMessage('请先继续或取消当前旧任务复用，再选择其他任务。');
      return;
    }
    const capturedContext = readReuseContext();
    let intent: TaskReuseIntent = {
      taskId, accountId, fromUrl: Boolean(options.clearUrl || previousIntent?.fromUrl && previousIntent.taskId === taskId),
      phase: 'confirming', editEpoch: capturedContext.editEpoch,
    };
    updateReuseIntent(intent);
    parameterOnlyReuseRef.current = null;
    setReuseParameterOnlyAvailable(false);
    if (!capturedContext.tabId) {
      updateReuseIntent({ ...intent, phase: 'failed' });
      setReuseMessage('当前浏览器无法读取工作台标签，未发送复用请求；来源已保留，请检查浏览器存储设置后重试。');
      return;
    }
    const receiptKey = taskReuseReceiptKey(accountId, capturedContext.tabId, taskId);
    try {
      if (new URL(window.location.href).searchParams.get('reuse_unconfirmed_task_id') === taskId || sessionStorage.getItem(receiptKey)) {
        transitionReuseSourceUrl(taskId, 'unconfirmed');
        intent = { ...intent, fromUrl: true };
        updateReuseIntent({ ...intent, phase: 'unknown' });
        setReuseOutcomeUnknown(true);
        setReuseRefreshRequested(false);
        setReuseMessage('上次复用请求结果尚未确认，来源已保留；请重新读取并核对参考区，不会再次发送请求。');
        return;
      }
    } catch {
      updateReuseIntent({ ...intent, phase: 'failed' });
      setReuseMessage('当前浏览器无法保留复用记录，未发送请求；请检查浏览器存储设置后重试。');
      return;
    }
    const requestId = ++reuseRequestIdRef.current;
    const capturedTabId = capturedContext.tabId;
    const isCurrentAccountRequest = () => reuseRequestIdRef.current === requestId
      && activeAccountIdRef.current === accountId;
    const contextStillMatches = () => {
      const source = new URL(window.location.href).searchParams;
      const executable = source.get('reuse_task_id');
      const unconfirmed = source.get('reuse_unconfirmed_task_id');
      return isCurrentAccountRequest() && taskReuseContextMatches(capturedContext, readReuseContext())
        && (!executable || executable === taskId) && (!unconfirmed || unconfirmed === taskId);
    };
    const explainBusyContext = () => {
      const current = readReuseContext();
      if (!current.tabId) return '当前浏览器无法读取工作台标签，未发送复用请求；来源已保留，请检查浏览器存储设置后重试。';
      if (current.workspaceBridgeKey !== workspaceBridgeKeyRef.current || current.accountId !== accountId) return '登录账号或工作台上下文已变化，未发送复用请求。';
      if (current.editEpoch !== capturedContext.editEpoch || current.projectId !== capturedContext.projectId
        || current.videoCardId !== capturedContext.videoCardId || current.videoBranchId !== capturedContext.videoBranchId
        || current.tabId !== capturedTabId) return '当前输入或保存位置已变化，已保留旧任务来源；准备好后点“继续复用”，重新确认替换。';
      const snapshot = workspaceBusySnapshotRef.current;
      if (snapshot.key !== current.workspaceBridgeKey || snapshot.busy) {
        const messages = {
          'read-error': '参考素材区读取或更新失败，当前状态未确认。请先重新读取，再重新点击复用。',
          'pending-attach': '已上传的素材仍未加入参考区，请点“重试加入参考区”完成后，再重新点击复用。',
          uploading: '参考素材仍在上传，请等待完成，再重新点击复用。',
          'upload-failed': '有参考素材上传失败，请先处理失败项，再重新点击复用。',
          saving: '参考素材、图集或模板仍在保存，请等待完成，再重新点击复用。',
          'picker-open': '素材选择或模板编辑窗口仍打开，请先完成或关闭，再重新点击复用。',
          loading: '参考素材或生成设置仍在加载/处理中，请等待完成，再重新点击复用。',
        } as const;
        return messages[snapshot.reason || 'loading'];
      }
      if (current.conflict) return current.conflict;
      if (current.initializing) return '正在准备项目、视频卡与生成设置；旧任务来源已保留，准备好后继续确认。';
      return '当前工作现场已变化，旧任务来源已保留；请点“继续复用”重新确认。';
    };
    const retainIntent = (phase: TaskReuseIntent['phase'], message: string) => {
      if (!isCurrentAccountRequest()) return;
      updateReuseIntent({ ...intent, phase });
      setReuseMessage(message);
    };
    const consumeQuery = (outcome: 'applied' | 'cancelled' | 'unrecoverable') => {
      if (shouldConsumeTaskReuseQuery(outcome)) transitionReuseSourceUrl(taskId, 'consumed');
    };
    const markOutcomeUnknown = (message: string) => {
      if (!isCurrentAccountRequest()) return;
      retainIntent('unknown', message);
      setReuseOutcomeUnknown(true);
      setReuseRefreshRequested(false);
      setReuseMessage(message);
    };

    if (capturedContext.busy || capturedContext.initializing || capturedContext.conflict) {
      retainIntent(capturedContext.initializing && !capturedContext.conflict ? 'waiting' : 'blocked', explainBusyContext());
      return;
    }

    reuseInFlightRef.current = true;
    let postMayHaveWritten = false;
    setReusePreflightPending(true);
    setReuseMessage('正在保留替换前输入...');
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      if (!contextStillMatches()) {
        const current = readReuseContext();
        retainIntent(current.initializing && !current.conflict && current.editEpoch === capturedContext.editEpoch
          ? 'waiting' : 'blocked', explainBusyContext());
        return;
      }
      const recovery = inputRecoveryRef.current;
      if (recovery?.key !== capturedContext.workspaceBridgeKey || !recovery.capture()) {
        retainIntent('blocked', '当前输入尚未能保留，未发送复用请求；请完成素材准备后点“继续复用”。');
        return;
      }
      if (!contextStillMatches()) {
        retainIntent('blocked', explainBusyContext());
        return;
      }

      setReuseLoading(true);
      updateReuseIntent({ ...intent, phase: 'sending' });
      setReusingTaskId(taskId);
      setReuseMessage('正在读取旧任务并恢复参考素材...');
      let res: Response;
      try {
        try { sessionStorage.setItem(receiptKey, 'unconfirmed'); }
        catch {
          retainIntent('failed', '当前浏览器无法保留复用记录，未发送请求；请检查浏览器存储设置后重试。');
          return;
        }
        let sourceRecorded = false;
        try { sourceRecorded = transitionReuseSourceUrl(taskId, 'unconfirmed'); } catch { /* Refuse the POST if its source cannot survive refresh. */ }
        if (!sourceRecorded) {
          try { sessionStorage.removeItem(receiptKey); } catch { /* A leftover fence fails safe. */ }
          retainIntent('failed', '当前页面无法保留本次复用来源，未发送请求；原来源保留，请重新打开旧任务入口。');
          return;
        }
        intent = { ...intent, fromUrl: true };
        updateReuseIntent({ ...intent, phase: 'sending' });
        postMayHaveWritten = true;
        res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/reuse`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-tab-id': capturedTabId,
          },
          body: JSON.stringify({ surface: isIpSurface ? 'ip' : 'normal' }),
        });
      } catch {
        markOutcomeUnknown('复用请求未收到服务器确认。当前参数未替换，但参考区可能已变化；请重新读取并核对，不会自动重试。');
        return;
      }
      if (!isCurrentAccountRequest()) return;
      if (res.status === 401) {
        try { sessionStorage.removeItem(receiptKey); } catch { /* Keep an unresolved fence if storage cannot be updated. */ }
        retainIntent('failed', '登录状态已失效，旧任务来源已保留；登录后可继续复用。');
        transitionReuseSourceUrl(taskId, 'retryable');
        const returnUrl = new URL(window.location.href);
        window.location.href = `/login?next=${encodeURIComponent(`${returnUrl.pathname}${returnUrl.search}${returnUrl.hash}`)}`;
        return;
      }

      let data: {
        draft?: {
          provider?: string | null;
          model?: string | null;
          task_id?: string;
          prompt?: string;
          generation_mode?: GenerationMode;
          ratio?: VideoRatio;
          duration?: VideoDuration;
          resolution?: VideoResolution;
          seed?: number;
          generate_audio?: boolean;
          return_last_frame?: boolean;
          watermark?: boolean;
          resolution_approval_confirmed?: boolean;
          project_id?: string | null;
          video_card_id?: string | null;
          video_branch_id?: string | null;
          video_card?: { id?: string; project_id?: string } | null;
        };
        skipped_references?: number;
        restored_references?: number;
        inputWarnings?: string[];
        error?: string;
        message?: string;
        code?: string;
      };
      try {
        data = await readJsonResponse<typeof data>(res);
      } catch {
        markOutcomeUnknown('服务器返回内容无法确认。当前参数未替换，但参考区可能已变化；请重新读取并核对，不会自动重试。');
        return;
      }
      const parameterOnly = res.status === 409 && data.code === 'REUSE_ASSETS_UNAVAILABLE';
      if (!res.ok && res.status < 500) {
        postMayHaveWritten = false;
        try { sessionStorage.removeItem(receiptKey); } catch { /* A retained fence fails safe on refresh. */ }
        if (res.status !== 403 && res.status !== 404) transitionReuseSourceUrl(taskId, 'retryable');
      }
      if (!res.ok && !parameterOnly) {
        if (res.status >= 500) {
          markOutcomeUnknown('服务器处理结果未确认。当前参数未替换，但参考区可能已变化；请重新读取并核对，不会自动重试。');
          return;
        }
        const unrecoverable = res.status === 403 || res.status === 404;
        retainIntent(unrecoverable ? 'done' : 'failed', data.message || data.error || '复用请求未完成；旧任务来源已保留，可安全重试。');
        if (unrecoverable) consumeQuery('unrecoverable');
        return;
      }
      if (data.draft?.task_id !== taskId || typeof data.draft.prompt !== 'string') {
        markOutcomeUnknown('服务器已返回响应，但缺少可核对的任务数据。当前参数未替换，参考区可能已变化；请重新读取并核对。');
        return;
      }
      if ((data.draft.provider === 'volcengine_ark') !== isIpSurface) {
        markOutcomeUnknown('服务器返回的任务入口与当前页面不一致。当前参数未替换，参考区可能已变化；请重新读取并核对。');
        return;
      }
      if (data.draft.video_card && (data.draft.video_card.id !== data.draft.video_card_id
        || data.draft.video_card.project_id !== data.draft.project_id)) {
        markOutcomeUnknown('旧任务的视频卡与项目无法核对，复用结果未应用；请重新读取当前参考区并核对。');
        return;
      }
      if (!contextStillMatches()) {
        if (parameterOnly) retainIntent('failed', '旧任务素材无法恢复；读取期间当前输入或保存位置已变化，参数未替换，来源已保留。');
        else markOutcomeUnknown('请求期间账号、工作台标签或项目选择发生变化。复用结果未应用；请重新读取当前参考区并核对。');
        return;
      }

      const applyResponse = () => {
      if (!contextStillMatches() || !data.draft || data.draft.task_id !== taskId || typeof data.draft.prompt !== 'string') return false;
      const reuseKey = ++reuseApplicationKeyRef.current;
      const sourceProjectId = data.draft.project_id || '';
      const projectAvailable = !sourceProjectId || projects.some((project) => project.id === sourceProjectId);
      const targetProjectId = projectAvailable && sourceProjectId ? sourceProjectId : capturedContext.projectId;
      const targetCardId = projectAvailable ? data.draft.video_card_id || '' : capturedContext.videoCardId;
      const targetBranchId = projectAvailable ? data.draft.video_branch_id || '' : capturedContext.videoBranchId;
      const skipped = data.skipped_references || 0;
      const restored = data.restored_references || 0;
      const message = `${parameterOnly ? '仅恢复旧任务文字与参数，当前素材保留；原参考素材未恢复。' : `已载入旧任务，恢复 ${restored} 项素材${skipped ? `，${skipped} 项未能恢复` : ''}。`}${data.inputWarnings?.join(' ') || ''}${projectAvailable ? '' : '原项目当前不可用，已保留当前保存位置，请生成前重新选择。'}`;
      pendingReuseApplicationRef.current = {
        taskId, reuseKey, accountId, bridgeKey: capturedContext.workspaceBridgeKey, tabId: capturedTabId,
        editEpoch: capturedContext.editEpoch, formApplied: false, message,
        projectId: targetProjectId, videoCardId: targetCardId, videoBranchId: targetBranchId,
      };
      updateReuseIntent({ ...intent, phase: 'applying' });
      userChangedProjectRef.current = true;
      userChangedVideoCardRef.current = false;
      userChangedVideoBranchRef.current = false;
      setInputRecoveryTarget(null);
      setSelectedProjectId(targetProjectId);
      setSelectedVideoCardId(targetCardId);
      setSelectedVideoBranchId(targetBranchId);
      setResult(null);
      setError(null);
      setErrorDebug(null);
      setPolledResult(null);
      setReuseDraft({
        model: data.draft.model || null,
        taskId: data.draft.task_id,
        reuseKey,
        prompt: data.draft.prompt,
        generationMode: data.draft.generation_mode || 'all_in_one_reference',
        ratio: data.draft.ratio || '16:9',
        duration: data.draft.duration || 5,
        resolution: data.draft.resolution || '480p',
        seed: data.draft.seed ?? -1,
        generateAudio: Boolean(data.draft.generate_audio),
        returnLastFrame: Boolean(data.draft.return_last_frame),
        watermark: Boolean(data.draft.watermark),
        resolutionApprovalConfirmed: asBoolean(data.draft.resolution_approval_confirmed, false),
        projectId: targetProjectId || null,
        videoCardId: targetCardId || null,
        videoBranchId: targetBranchId || null,
      });
      setReuseMessage('正在把旧任务参数填入输入框并核对参考素材...');
      if (options.scrollToComposer !== false) {
        requestAnimationFrame(() => {
          if (activeAccountIdRef.current !== accountId || workspaceBridgeKeyRef.current !== capturedContext.workspaceBridgeKey) return;
          document.querySelector('.generation-composer')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      }
      return true;
      };
      if (parameterOnly) {
        retainIntent('blocked', `${data.message || data.error || '原参考素材无法恢复。'} 仅参数可恢复，当前素材保留；可选择下方“仅恢复参数”。${data.inputWarnings?.join(' ') || ''}`);
        parameterOnlyReuseRef.current = async () => {
          if (!contextStillMatches()) {
            parameterOnlyReuseRef.current = null;
            setReuseParameterOnlyAvailable(false);
            retainIntent('failed', '当前输入或保存位置已变化，参数未替换；请点“继续复用”重新读取旧任务。');
            return;
          }
          setReusePreflightPending(true);
          try {
            if (!isCurrentAccountRequest()) return;
            if (!applyResponse()) retainIntent('failed', explainBusyContext());
            parameterOnlyReuseRef.current = null;
            setReuseParameterOnlyAvailable(false);
          } catch {
            retainIntent('failed', '参数恢复尚未完成，当前素材保留；旧任务来源已保留，可重新确认。');
          } finally {
            if (isCurrentAccountRequest()) setReusePreflightPending(false);
          }
        };
        setReuseParameterOnlyAvailable(true);
        return;
      }
      applyResponse();
    } catch (err) {
      if (isCurrentAccountRequest()) {
        if (postMayHaveWritten) markOutcomeUnknown('复用请求已发送，但当前输入未完成恢复；请重新读取并核对参考区，不会自动重试。');
        else retainIntent('failed', err instanceof Error ? err.message : '复用任务未完成；旧任务来源已保留，可安全重试。');
      }
    } finally {
      if (isCurrentAccountRequest()) {
        reuseInFlightRef.current = false;
        setReuseLoading(false);
        setReusingTaskId(null);
        setReusePreflightPending(false);
      }
    }
  }, [currentUser?.id, isIpSurface, loadingUser, projects, readReuseContext, updateReuseIntent, transitionReuseSourceUrl]);

  const cancelReuseIntent = useCallback(() => {
    const intent = reuseIntentRef.current;
    if (!intent || reuseInFlightRef.current || intent.phase === 'applying') return;
    if (intent.phase === 'unknown' && (!reuseRefreshRequested || workspaceBusy)) return;
    try {
      const tabId = readReuseContext().tabId;
      if (tabId) sessionStorage.removeItem(taskReuseReceiptKey(intent.accountId, tabId, intent.taskId));
    }
    catch { /* Keeping the fence prevents an unsafe replay later. */ }
    if (shouldConsumeTaskReuseQuery('cancelled')) transitionReuseSourceUrl(intent.taskId, 'consumed');
    updateReuseIntent({ ...intent, phase: 'done' });
    setReuseParameterOnlyAvailable(false);
    parameterOnlyReuseRef.current = null;
    setReuseMessage('已结束本次复用，当前输入与参考素材保留。');
  }, [updateReuseIntent, readReuseContext, reuseRefreshRequested, workspaceBusy, transitionReuseSourceUrl]);

  const completeReuseDraftApplication = useCallback((taskId: string, reuseKey: number) => {
    const pending = pendingReuseApplicationRef.current;
    if (!pending || pending.taskId !== taskId || pending.reuseKey !== reuseKey) return;
    pending.formApplied = true;
    setReuseApplicationTick((value) => value + 1);
  }, []);

  useEffect(() => {
    const pending = pendingReuseApplicationRef.current;
    const activeIntent = reuseIntentRef.current;
    if (!pending || !pending.formApplied || !activeIntent || activeIntent.phase !== 'applying') return;
    const current = readReuseContext();
    if (current.accountId !== pending.accountId || current.workspaceBridgeKey !== pending.bridgeKey
      || current.tabId !== pending.tabId || current.editEpoch !== pending.editEpoch) {
      pendingReuseApplicationRef.current = null;
      updateReuseIntent({ ...activeIntent, phase: 'unknown' });
      setReuseOutcomeUnknown(true);
      setReuseRefreshRequested(false);
      setReuseMessage('恢复期间账号或工作现场已变化，结果未继续写入；请重新读取并核对当前参考区。');
      return;
    }
    if (loadingProjects || loadingVideoCards || loadingVideoBranches
      || (selectedProjectId && videoCardsLoadedProjectId !== selectedProjectId)
      || (selectedVideoCardId && videoBranchesLoadedCardId !== selectedVideoCardId)) return;
    if (selectedProjectId !== pending.projectId) return;
    let message = pending.message;
    if (pending.videoCardId && !videoCards.some((card) => card.id === pending.videoCardId && card.project_id === pending.projectId
      && card.status !== 'sealed' && card.status !== 'archived')) {
      setSelectedVideoCardId('');
      setSelectedVideoBranchId('');
      message += '原视频卡当前不可用，未另选视频卡，请生成前重新选择。';
    } else if (pending.videoBranchId && !videoBranches.some((branch) => branch.id === pending.videoBranchId)) {
      setSelectedVideoBranchId('');
      message += '原方向当前不可用，未另选方向，请生成前重新确认。';
    }
    const intent = reuseIntentRef.current;
    try { sessionStorage.removeItem(taskReuseReceiptKey(pending.accountId, pending.tabId, pending.taskId)); }
    catch { /* The applied form still completes, but a retained fence fails safe later. */ }
    if (shouldConsumeTaskReuseQuery('applied')) transitionReuseSourceUrl(pending.taskId, 'consumed');
    pendingReuseApplicationRef.current = null;
    if (intent) updateReuseIntent({ ...intent, phase: 'done' });
    setReuseMessage(message);
  }, [reuseApplicationTick, reuseDraft, loadingProjects, loadingVideoCards, loadingVideoBranches,
    selectedProjectId, selectedVideoCardId, videoCardsLoadedProjectId, videoBranchesLoadedCardId,
    videoCards, videoBranches, readReuseContext, updateReuseIntent, transitionReuseSourceUrl]);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const executableTaskId = query.get('reuse_task_id');
    const unconfirmedTaskId = query.get('reuse_unconfirmed_task_id');
    const reuseTaskId = executableTaskId || unconfirmedTaskId;
    if (loadingUser || !currentUser?.id || reuseLoading || reusePreflightPending || reuseOutcomeUnknown) return;
    if (!reuseIntentRef.current && reuseTaskId) {
      const intent: TaskReuseIntent = { taskId: reuseTaskId, accountId: currentUser.id, fromUrl: true, phase: 'waiting', editEpoch: 0 };
      if (unconfirmedTaskId === reuseTaskId) {
        transitionReuseSourceUrl(reuseTaskId, 'unconfirmed');
        updateReuseIntent({ ...intent, phase: 'unknown' });
        setReuseOutcomeUnknown(true);
        setReuseRefreshRequested(false);
        setReuseMessage('上次复用请求结果尚未确认，来源已保留；请重新读取并核对参考区，不会再次发送请求。');
        return;
      }
      const tabId = readReuseContext().tabId;
      if (!tabId) {
        updateReuseIntent({ ...intent, phase: 'failed' });
        setReuseMessage('当前浏览器无法读取工作台标签，未发送复用请求；来源已保留，请检查浏览器存储设置后重试。');
        return;
      }
      try {
        if (sessionStorage.getItem(taskReuseReceiptKey(currentUser.id, tabId, reuseTaskId))) {
          transitionReuseSourceUrl(reuseTaskId, 'unconfirmed');
          updateReuseIntent({ ...intent, phase: 'unknown' });
          setReuseOutcomeUnknown(true);
          setReuseRefreshRequested(false);
          setReuseMessage('上次复用请求结果尚未确认，来源已保留；请重新读取并核对参考区，不会再次发送请求。');
          return;
        }
      } catch {
        updateReuseIntent({ ...intent, phase: 'failed' });
        setReuseMessage('当前浏览器无法保留复用记录，未发送请求；请检查浏览器存储设置后重试。');
        return;
      }
      updateReuseIntent(intent);
      return;
    }
    const intent = reuseIntentRef.current;
    if (!intent) return;
    const context = readReuseContext();
    if (!context.tabId) {
      if (intent.phase !== 'failed') updateReuseIntent({ ...intent, phase: 'failed' });
      setReuseMessage('当前浏览器无法读取工作台标签，未发送复用请求；来源已保留，请检查浏览器存储设置后重试。');
      return;
    }
    const action = taskReuseAutoAction(intent, context);
    if (action === 'wait') setReuseMessage('正在准备旧任务复用，来源已保留；准备好后可点“继续复用”。');
    if (action === 'block') {
      updateReuseIntent({ ...intent, phase: 'blocked' });
      setReuseMessage(context.conflict || '你已修改当前输入或保存位置，当前现场保留；准备好后可点“继续复用”。');
    }
    if (action === 'confirm') {
      updateReuseIntent({ ...intent, phase: 'blocked' });
      setReuseMessage('旧任务来源已保留；点击“继续复用”后替换本页输入。');
    }
  }, [currentUser?.id, loadReusableTask, loadingUser, reuseContextBusy, parentReuseInitializing, parentReuseConflict,
    composerReuseState, reuseIntent, reuseLoading, reuseOutcomeUnknown, reusePreflightPending, readReuseContext, updateReuseIntent, transitionReuseSourceUrl]);

  // ============================================================================
  // Load recent tasks
  // ============================================================================

  const loadRecentTasksPage = useCallback(async (
    page: number,
    mode: 'replace' | 'append' | 'merge-head' = 'append',
  ) => {
    if (recentTasksLoadingRef.current) return;
    recentTasksLoadingRef.current = true;
    setRecentTasksError('');
    if (mode === 'replace') {
      setRecentTasksLoadingInitial(true);
    } else {
      setRecentTasksLoadingMore(true);
    }

    try {
      const listEndpoint = isIpSurface ? '/api/ip/video/list' : '/api/video/list';
      const fetchPage = async (targetPage: number) => {
        const res = await fetch(`${listEndpoint}?page=${targetPage}&limit=${RECENT_TASK_PAGE_SIZE}`, {
          cache: 'no-store',
        });
        const data = await res.json() as TaskListResponse;
        if (!res.ok) {
          throw new Error(data.message || data.error || '最近任务加载失败');
        }
        return normalizeRecentTaskListResponse(data);
      };

      let { tasks, pagination } = await fetchPage(page);
      if (mode === 'replace') {
        let visualCount = tasks.filter(recentTaskHasVisualPreview).length;
        let fetchedPages = 1;
        while (
          visualCount < RECENT_TASK_INITIAL_MIN_VISUALS
          && fetchedPages < RECENT_TASK_INITIAL_PREFETCH_MAX_PAGES
          && pagination.page < pagination.total_pages
        ) {
          const nextPage = pagination.page + 1;
          const next = await fetchPage(nextPage);
          tasks = mergeTasksById(tasks, next.tasks);
          pagination = next.pagination;
          visualCount = tasks.filter(recentTaskHasVisualPreview).length;
          fetchedPages += 1;
        }
      }
      const pollableTaskIds = collectPollableTaskIds(tasks, isIpSurface);
      if (mode === 'replace') {
        setRecentTasks(tasks);
        recentTasksPageRef.current = pagination.page;
        setRecentTasksPage(pagination.page);
      } else if (mode === 'merge-head') {
        setRecentTasks((current) => mergeTasksById(tasks, current));
      } else {
        setRecentTasks((current) => mergeTasksById(current, tasks));
        recentTasksPageRef.current = pagination.page;
        setRecentTasksPage(pagination.page);
      }

      const currentPage = mode === 'merge-head'
        ? Math.max(1, recentTasksPageRef.current)
        : pagination.page;
      const hasMore = currentPage < pagination.total_pages;
      recentTasksHasMoreRef.current = hasMore;
      setRecentTasksHasMore(hasMore);
      if (pollableTaskIds.length > 0) {
        setActivePollingTaskIds((current) => mergePollingTaskIds(pollableTaskIds, current));
      }
    } catch (err) {
      setRecentTasksError(err instanceof Error ? err.message : '最近任务加载失败');
    } finally {
      recentTasksLoadingRef.current = false;
      setRecentTasksLoadingInitial(false);
      setRecentTasksLoadingMore(false);
    }
  }, [isIpSurface]);

  const loadMoreRecentTasks = useCallback(() => {
    if (recentTasksLoadingRef.current || !recentTasksHasMoreRef.current) return;
    void loadRecentTasksPage(recentTasksPageRef.current + 1, 'append');
  }, [loadRecentTasksPage]);

  const retryRecentTasks = useCallback(() => {
    const mode = recentTasks.length === 0 ? 'replace' : 'append';
    const page = mode === 'replace' ? 1 : recentTasksPageRef.current + 1;
    void loadRecentTasksPage(page, mode);
  }, [loadRecentTasksPage, recentTasks.length]);

  const deleteRecentTask = useCallback(async (task: TaskItem) => {
    if (isIpSurface || task.can_delete === false || deletingRecentTaskId) return;
    const confirmed = await confirm('从最近生成移除此记录？视频文件不会物理删除，管理员仍可在留存区审计和恢复。', { title: '移除记录', confirmLabel: '移除记录', danger: true });
    if (!confirmed) return;

    setDeletingRecentTaskId(task.id);
    setRecentTasksError('');
    try {
      const response = await fetch(`/api/tasks/${task.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: '用户从最近生成移除' }),
      });
      const data = await readJsonResponse<{ error?: string; message?: string }>(response);
      if (!response.ok) throw new Error(data.message || data.error || '最近生成删除失败');
      setRecentTasks((current) => current.filter((item) => item.id !== task.id));
      setActivePollingTaskIds((current) => current.filter((taskId) => taskId !== task.id));
      setPolledResult((current) => current?.id === task.id ? null : current);
    } catch (err) {
      setRecentTasksError(err instanceof Error ? err.message : '最近生成删除失败');
    } finally {
      setDeletingRecentTaskId(null);
    }
  }, [deletingRecentTaskId, isIpSurface, confirm]);

  const upgradeDraftTask = useCallback(async (task: TaskItem) => {
    if (isIpSurface || !task.is_draft || task.local_status !== 'succeeded' || !seedanceDraftCapability.upgrade_enabled || draftUpgradeTaskId) return;
    setDraftUpgradeTaskId(task.id);
    setRecentTasksError('');
    try {
      const quoteResponse = await fetch(`/api/tasks/${task.id}/draft-upgrade`, { cache: 'no-store' });
      const quote = await readJsonResponse<{ accepted?: { id: string }; estimatedCost?: number; pricing_revision?: string | null; message?: string; error?: string }>(quoteResponse);
      if (!quoteResponse.ok) throw new Error(quote.message || quote.error || '升级报价暂不可用，原样片保留');
      if (quote.accepted?.id) {
        setActivePollingTaskIds(current => [quote.accepted!.id, ...current.filter(id => id !== quote.accepted!.id)].slice(0, MAX_ACTIVE_POLLING_TASKS));
        await loadRecentTasksPage(1, 'merge-head'); return;
      }
      if (!validVideoPricingAmount(quote.estimatedCost) || quote.pricing_revision !== null && typeof quote.pricing_revision !== 'string') throw new Error('升级报价暂不可用，未提交');
      if (quote.estimatedCost > 0 && !await confirm(`生成 1080p 预计冻结 ${quote.estimatedCost} 点，原样片保留。`, { title: '生成1080p', confirmLabel: `生成 ${quote.estimatedCost} 点` })) return;
      const response = await fetch(`/api/tasks/${task.id}/draft-upgrade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resolution_approval_confirmed: true,
          idempotency_key: `draft-upgrade:${task.id}`,
          ...(quote.pricing_revision ? { pricing_revision: quote.pricing_revision } : {}),
        }),
      });
      const data = await readJsonResponse<{ task_id?: string; id?: string; provider_task_id?: string | null; error?: string; message?: string }>(response);
      if (!response.ok) throw new Error(data.message || data.error || 'Draft 升级失败');
      const formalTaskId = data.task_id || data.id;
      if (formalTaskId) {
        setActivePollingTaskIds((current) => [formalTaskId, ...current.filter((id) => id !== formalTaskId)].slice(0, MAX_ACTIVE_POLLING_TASKS));
      }
      await loadRecentTasksPage(1, 'merge-head');
    } catch (error) {
      setRecentTasksError(error instanceof Error ? error.message : 'Draft 升级失败');
    } finally {
      setDraftUpgradeTaskId(null);
    }
  }, [draftUpgradeTaskId, isIpSurface, loadRecentTasksPage, seedanceDraftCapability.upgrade_enabled, confirm]);

  useEffect(() => {
    void loadRecentTasksPage(1, 'replace');
  }, [loadRecentTasksPage]);

  useEffect(() => {
    const sentinel = recentTasksSentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === 'undefined') return;
    if (!recentTasksHasMore || recentTasksLoadingInitial || recentTasksLoadingMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadMoreRecentTasks();
        }
      },
      { rootMargin: '360px 0px' },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMoreRecentTasks, recentTasksHasMore, recentTasksLoadingInitial, recentTasksLoadingMore, recentTasks.length]);

  // ============================================================================
  // Result Polling — poll queued tasks without blocking the composer
  // ============================================================================

  useEffect(() => {
    if (activePollingTaskIds.length === 0) {
      setIsPolling(false);
      return;
    }

    setIsPolling(true);
    let cancelled = false;

    const refreshRecentTasks = () => {
      void loadRecentTasksPage(1, 'merge-head');
    };

    const refreshCredits = () => {
      fetch('/api/me/credits')
        .then((r) => r.ok ? r.json() : null)
        .then((d) => { if (d) setCredits(d); })
        .catch(() => {});
    };

    const poll = async () => {
      const terminalIds: string[] = [];

      await Promise.all(activePollingTaskIds.map(async (taskId) => {
        try {
          const statusEndpoint = isIpSurface ? `/api/ip/video/status/${taskId}` : `/api/video/status/${taskId}?refresh=true`;
          const res = await fetch(statusEndpoint);
          if (!res.ok) return;
          const data: PolledTask = await res.json();
          if (cancelled) return;

          setPolledResult(data);
          setRecentTasks((current) => current.map((task) => (
            task.id === data.id
              ? {
                  ...task,
                  local_status: data.local_status,
                  error_message: data.error_message ?? task.error_message ?? null,
                  error_code: data.error_code,
                  delivery_error: data.delivery_error,
                  model: data.model ?? task.model,
                  public_video_url: data.public_video_url ?? task.public_video_url,
                  result_video_url: data.result_video_url,
                  result_last_frame_url: data.result_last_frame_url ?? task.result_last_frame_url,
                  local_video_path: data.local_video_path ?? task.local_video_path,
                  delivery_stage: data.delivery_stage ?? task.delivery_stage,
                  stable_download_ready: data.stable_download_ready ?? task.stable_download_ready,
                  preview_available: data.preview_available ?? task.preview_available,
                  retry_after_ms: data.retry_after_ms ?? task.retry_after_ms,
                  play_url: data.play_url ?? task.play_url,
                  download_url: data.download_url ?? task.download_url,
                  thumbnail_url: data.thumbnail_url ?? task.thumbnail_url,
                  provider_cost_currency: data.provider_cost_currency,
                  provider_official_amount_minor: data.provider_official_amount_minor,
                  provider_final_amount_minor: data.provider_final_amount_minor,
                  provider_official_amount_micros: data.provider_official_amount_micros,
                  provider_final_amount_micros: data.provider_final_amount_micros,
                }
              : task
          )));

          if (
            ['failed', 'cancelled'].includes(data.local_status)
            || (data.local_status === 'succeeded' && !shouldContinuePollingStableDelivery(data, isIpSurface))
          ) {
            terminalIds.push(taskId);
          }
        } catch {
          // non-critical polling error, keep polling
        }
      }));

      if (cancelled) return;

      if (terminalIds.length > 0) {
        setActivePollingTaskIds((current) => current.filter((id) => !terminalIds.includes(id)));
        refreshRecentTasks();
        refreshCredits();
      }
    };

    poll();
    const intervalId = setInterval(poll, 5000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [activePollingTaskIds, isIpSurface, loadRecentTasksPage]);

  useEffect(() => {
    if (!result?.id) return;
    const timeout = setTimeout(() => {
      setResult((current) => current?.id === result.id ? null : current);
    }, 6000);
    return () => clearTimeout(timeout);
  }, [result?.id]);

  // ============================================================================
  // Submit
  // ============================================================================

  const saveGenerationDefaults = useCallback((params: {
    model?: string | null;
    generationMode: GenerationMode;
    ratio: VideoRatio;
    duration: VideoDuration;
    resolution: VideoResolution;
    generateAudio: boolean;
    returnLastFrame: boolean;
    watermark: boolean;
  }) => {
    const settings: GenerationDefaults = {
      model: params.model || null,
      generationMode: params.generationMode,
      ratio: params.ratio,
      duration: params.duration,
      resolution: params.resolution,
      generateAudio: params.generateAudio,
      returnLastFrame: params.returnLastFrame,
      watermark: params.watermark,
      seedMode: 'random',
      projectId: selectedProjectId || null,
    };

    setGenerationDefaults(settings);
    if (currentUser?.id) {
      writeLocalGenerationDefaults(currentUser.id, settings, isIpSurface ? 'ip' : 'normal');
    }

    preferenceWriteQueue.current = preferenceWriteQueue.current.catch(() => undefined).then(() => fetch('/api/me/preferences/generation', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings, surface: isIpSurface ? 'ip' : 'normal' }),
    })).catch(() => {
      // 偏好保存失败不影响生成任务。
    });
  }, [currentUser?.id, selectedProjectId, isIpSurface]);

  const handleSubmit = useCallback(async (params: GenerationSubmitParams) => {
    const explicitlyStartingNew = forceNewGenerationRef.current;
    forceNewGenerationRef.current = false;
    unconfirmedGenerationParamsRef.current = params;
    setSubmitting(true);
    setError(null);
    setErrorDebug(null);
    setResult(null);

    let selectedVideoCard = videoCards.find((card) => card.id === selectedVideoCardId) || null;
    if (!selectedProjectId) {
      setError('请先选择项目');
      setSubmitting(false);
      return;
    }
    if (!selectedVideoCard && !isExternalIpUser) {
      setError('请先选择项目和视频卡');
      setSubmitting(false);
      return;
    }
    const selectedH3Model = !isIpSurface && params.model === H3_INLINE_MODEL_ID;
    const requestedProvider: GenerationProvider = selectedH3Model ? 'h3' : 'seedance';
    const requestedModel = selectedH3Model
      ? selectedH3Preset?.id || h3VideoConfig?.default_preset_id || ''
      : params.model || '';
    const durationModel = selectedH3Model ? null : requestedModel;
    if (!isSeedanceVideoDuration(params.duration, durationModel)) {
      setError(`当前模型仅支持 4–${seedanceVideoMaxDuration(durationModel)} 秒，请重新选择时长后提交。当前时长未自动修改，也未扣点。`);
      setSubmitting(false);
      return;
    }
    const requestedH3LoraId = selectedH3Model
      ? h3VideoConfig?.lora_options.find((option) => option.id === params.h3LoraId)?.id
        || selectedH3Lora?.id
        || h3VideoConfig?.default_lora_id
        || ''
      : '';
    if (selectedH3Model && (!h3Ready || !requestedModel)) {
      setError(`${h3DisabledReason(h3VideoConfig)}，请先点击「检查状态」刷新机器状态。`);
      setSubmitting(false);
      return;
    }
    if (selectedH3Model && !requestedH3LoraId) {
      setError('H3 LoRA 配置缺失，请刷新页面后重试。');
      setSubmitting(false);
      return;
    }

    try {
      if (!selectedVideoCard && isExternalIpUser) {
        const cardResponse = await fetch(`/api/projects/${selectedProjectId}/video-cards`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'IP生成默认视频卡',
            objective: '外部用户 IP 生成默认归档',
            platform: 'ip',
            ratio: params.ratio,
            duration: params.duration,
            target_resolution: params.resolution,
            confirm_duplicate: true,
          }),
        });
        const cardData = await readJsonResponse<{ video_card?: VideoCardOption; error?: string; message?: string }>(cardResponse);
        if (!cardResponse.ok || !cardData.video_card) {
          throw new Error(cardData.message || cardData.error || '默认视频卡创建失败，请刷新后重试');
        }
        selectedVideoCard = cardData.video_card;
        setVideoCards((current) => (
          current.some((card) => card.id === cardData.video_card?.id)
            ? current
            : [cardData.video_card as VideoCardOption, ...current]
        ));
        userChangedVideoCardRef.current = true;
        setSelectedVideoCardId(cardData.video_card.id);
      }

      if (!selectedVideoCard) {
        throw new Error('请先选择项目和视频卡');
      }
      if (selectedVideoCard.status === 'sealed' || selectedVideoCard.status === 'archived') {
        throw new Error('当前视频卡已封板或归档，不能继续生成');
      }
      const readyVideoCard = selectedVideoCard;

      const createEndpoint = isIpSurface ? '/api/ip/tasks/create' : '/api/tasks/create';
      const requestBody = {
        ...(params.pricingRevision ? { pricing_revision: params.pricingRevision } : {}),
        ...(typeof params.quotedEstimatedCost === 'number' ? { max_estimated_cost: params.quotedEstimatedCost } : {}),
        prompt: params.prompt,
        generation_mode: params.generationMode,
        ratio: params.ratio,
        duration: params.duration,
        resolution: params.resolution,
        seed: params.seed,
        generate_audio: params.generateAudio,
        return_last_frame: params.returnLastFrame,
        watermark: params.watermark,
        resolution_approval_confirmed: params.resolutionApprovalConfirmed,
        project_id: selectedProjectId,
        video_card_id: readyVideoCard.id,
        video_branch_id: selectedVideoBranchId || undefined,
        reference_image_ids: params.referenceImageIds || [],
        reference_video_urls: params.referenceVideoUrls || [],
        reference_audio_urls: params.referenceAudioUrls || [],
        template_id: params.templateId || null,
        agent_run_id: params.agentRunId || null,
        selected_agent_plan_key: params.selectedAgentPlanKey || null,
        agent_prompt_snapshot: params.agentPromptSnapshot || null,
        final_prompt_snapshot: params.finalPromptSnapshot || params.prompt,
        prompt_user_edited: params.promptUserEdited === true,
        provider: isIpSurface ? undefined : requestedProvider,
        model: requestedModel || undefined,
        draft: !isIpSurface && requestedProvider === 'seedance' && requestedModel === SEEDANCE_2_5_MODEL_ID && params.draft === true,
        lora_id: selectedH3Model ? requestedH3LoraId : undefined,
        template_studio_run_id: params.templateStudioRunId || undefined,
        template_studio_assets: params.templateStudioRunId ? params.templateStudioAssets : undefined,
        template_studio_parameters: params.templateStudioRunId ? params.templateStudioParameters : undefined,
        first_frame_asset_id: params.templateStudioAssets.find((asset) => asset.role === 'first')?.assetId,
        last_frame_asset_id: params.templateStudioAssets.find((asset) => asset.role === 'last')?.assetId,
      };
      const requestFingerprint = stableGenerationPayloadJson(requestBody);
      const requestStorageKey = `sd2-generation-request-v1:${currentUser?.id || 'session'}:${surface}:${params.imageResultReceiptId || params.templateStudioRunId || 'standard'}`;
      const readPendingRequest = () => {
        try {
          const raw = sessionStorage.getItem(requestStorageKey);
          if (!raw) return null;
          const parsed = JSON.parse(raw) as { key?: unknown; fingerprint?: unknown };
          return typeof parsed.key === 'string' && typeof parsed.fingerprint === 'string'
            ? { key: parsed.key, fingerprint: parsed.fingerprint }
            : null;
        } catch {
          return null;
        }
      };
      const recoverAcceptedRequest = async (key: string) => {
        if (!params.templateStudioRunId && !isIpSurface) return null;
        const query = new URLSearchParams({ idempotency_key: key });
        if (params.templateStudioRunId) query.set('template_studio_run_id', params.templateStudioRunId);
        const endpoint = isIpSurface ? '/api/ip/tasks/request-status' : '/api/template-studio-video-handoff';
        const response = await fetch(`${endpoint}?${query.toString()}`, { cache: 'no-store' });
        const payload = await readJsonResponse<{ task?: CreateTaskResponse | null; error?: string; message?: string }>(response);
        if (!response.ok) throw new Error(payload.message || payload.error || '无法确认上次请求是否已受理');
        return payload.task || null;
      };
      const acceptRecoveredTask = (task: CreateTaskResponse, currentPayloadChanged = false) => {
        const unconfirmed = task.error_code === 'IP_SUBMISSION_UNCONFIRMED' || task.submission_unconfirmed === true;
        if (!unconfirmed) sessionStorage.removeItem(requestStorageKey);
        setUnconfirmedGenerationRequest(currentPayloadChanged || unconfirmed);
        unconfirmedGenerationParamsRef.current = currentPayloadChanged || unconfirmed ? params : null;
        setResult(unconfirmed ? null : task);
        setError(unconfirmed ? (task.message || '上游受理结果待确认，请勿重复生成，联系管理员核对。') : currentPayloadChanged
          ? `上次请求已受理为任务 ${task.id}，但当前内容与原请求不同。请先核对该任务；如仍要生成当前内容，再明确新建任务。`
          : null);
        setPolledResult(null);
        setActivePollingTaskIds((current) => [task.id, ...current.filter((id) => id !== task.id)].slice(0, MAX_ACTIVE_POLLING_TASKS));
        void loadRecentTasksPage(0, 'replace');
      };

      let pendingRequest = readPendingRequest();
      if (pendingRequest && explicitlyStartingNew) {
        sessionStorage.removeItem(requestStorageKey);
        pendingRequest = null;
      }
      if (pendingRequest) {
        const currentPayloadChanged = pendingRequest.fingerprint !== requestFingerprint;
        const accepted = await recoverAcceptedRequest(pendingRequest.key);
        if (accepted) {
          acceptRecoveredTask(accepted, currentPayloadChanged);
          return;
        }
        if (currentPayloadChanged) {
          setUnconfirmedGenerationRequest(true);
          throw new Error('上次请求尚未确认，当前内容已变化。先查询任务状态；如要按当前内容另建任务，请使用“按当前内容新建任务”。');
        }
      }
      const idempotencyKey = pendingRequest?.key || window.crypto.randomUUID();
      if (!pendingRequest) {
        pendingRequest = { key: idempotencyKey, fingerprint: requestFingerprint };
        sessionStorage.setItem(requestStorageKey, JSON.stringify(pendingRequest));
      }

      let res: Response;
      try {
        res = await fetch(createEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-tab-id': sessionStorage.getItem('workspace_tab_id') || 'default',
          },
          body: JSON.stringify({ ...requestBody, idempotency_key: idempotencyKey }),
        });
      } catch {
        try {
          const accepted = await recoverAcceptedRequest(idempotencyKey);
          if (accepted) {
            acceptRecoveredTask(accepted);
            return;
          }
        } catch {
          // Keep the same request key when its acceptance state cannot be read.
        }
        setUnconfirmedGenerationRequest(true);
        throw new Error('网络中断，尚不能确认任务是否已受理。请求号已保留；再次提交会先查询原任务。');
      }

      const data = await readJsonResponse<CreateTaskResponse>(res);

      if (res.ok && (data.error_code === 'IP_SUBMISSION_UNCONFIRMED' || data.submission_unconfirmed === true)) {
        acceptRecoveredTask(data);
        return;
      }

      if (!res.ok) {
        if (typeof data.code === 'string' && data.code.startsWith('pricing_')) notifyVideoPricingChanged();
        setErrorDebug(data._debug || null);
        if (res.status >= 500) {
          try {
            const accepted = await recoverAcceptedRequest(idempotencyKey);
            if (accepted) {
              acceptRecoveredTask(accepted);
              return;
            }
          } catch {
            // Keep the original request key while the task state is uncertain.
          }
          setUnconfirmedGenerationRequest(true);
          throw new Error(data.message || data.error || `服务暂未确认请求结果 (HTTP ${res.status})；请求号已保留`);
        }
        if (res.status === 409 && typeof data.code === 'string' && data.code.startsWith('IDEMPOTENCY_')) {
          setUnconfirmedGenerationRequest(true);
          unconfirmedGenerationParamsRef.current = params;
          const taskHint = typeof data.existing_task_id === 'string' ? `（任务 ${data.existing_task_id}）` : '';
          throw new Error(`${data.error || data.message || '请求号已关联已有任务'}${taskHint}。请先核对原任务；系统保留当前请求号，只有确认需要另行生成时再明确新建。`);
        }
        sessionStorage.removeItem(requestStorageKey);
        setUnconfirmedGenerationRequest(false);
        unconfirmedGenerationParamsRef.current = null;
        const message = data.message || data.error || `创建失败 (HTTP ${res.status})`;
        throw new Error(data.error && data.message ? `[${data.error}] ${message}` : message);
      }

      sessionStorage.removeItem(requestStorageKey);
      setUnconfirmedGenerationRequest(false);
      unconfirmedGenerationParamsRef.current = null;
      setResult(data);
      setErrorDebug(null);
      setPolledResult(null);
      setActivePollingTaskIds((current) => [
        data.id,
        ...current.filter((id) => id !== data.id),
      ].slice(0, MAX_ACTIVE_POLLING_TASKS));
      setRecentTasks((current) => [
        {
          id: data.id,
          prompt: params.prompt,
          provider: data.provider || (isIpSurface ? 'volcengine_ark' : requestedProvider),
          generation_mode: params.generationMode,
          model: data.model || requestedModel || null,
          is_draft: data.is_draft === true,
          provider_draft_task_id: null,
          draft_upgrade_mode: data.is_draft === true ? 'draft' : null,
          source_draft_task_id: null,
          draft_contract_version: null,
          local_status: data.status || 'submitted',
          public_video_url: null,
          result_video_url: null,
          result_last_frame_url: null,
          local_video_path: null,
          error_message: null,
          delivery_stage: null,
          stable_download_ready: false,
          preview_available: false,
          retry_after_ms: null,
          play_url: null,
          download_url: null,
          thumbnail_url: null,
          provider_cost_currency: null,
          provider_official_amount_minor: null,
          provider_final_amount_minor: null,
          provider_official_amount_micros: null,
          provider_final_amount_micros: null,
          project_id: data.project_id || selectedProjectId,
          video_card_id: data.video_card_id || readyVideoCard.id,
          template_id: data.template_id || null,
          agent_run_id: data.agent_run_id || null,
          selected_agent_plan_key: data.selected_agent_plan_key || null,
          prompt_user_edited: params.promptUserEdited === true,
          generation_template: null,
          can_delete: !isIpSurface,
          video_card: {
            id: readyVideoCard.id,
            title: readyVideoCard.title,
            objective: readyVideoCard.objective,
            status: readyVideoCard.status,
            project_id: readyVideoCard.project_id,
          },
          created_at: data.created_at,
        },
        ...current.filter((task) => task.id !== data.id),
      ]);
      saveGenerationDefaults(params);

      // Refresh credit display after freeze
      fetch('/api/me/credits')
        .then((r) => r.ok ? r.json() : null)
        .then((d) => { if (d) setCredits(d); })
        .catch(() => {});
    } catch (err) {
      if (err instanceof Error) setError(err.message);
    } finally {
      setSubmitting(false);
    }
	  }, [
    h3Ready,
    h3VideoConfig,
    isIpSurface,
    saveGenerationDefaults,
    selectedH3Preset?.id,
    selectedH3Lora?.id,
    selectedProjectId,
    selectedVideoBranchId,
    selectedVideoCardId,
    isExternalIpUser,
    videoCards,
    currentUser?.id,
    loadRecentTasksPage,
    surface,
  ]);

  // ============================================================================
  // Collection handlers
  // ============================================================================

  const handleCollectionLoad = useCallback(async (collectionId: string) => {
    const accountId = currentUser?.id || null;
    if (!accountId || activeAccountIdRef.current !== accountId) throw new Error('登录账号尚未确认，未读取图集。');
    const tabId = sessionStorage.getItem('workspace_tab_id') || 'default';
    const response = await fetch(`/api/collections/${encodeURIComponent(collectionId)}/load`, {
      method: 'POST',
      headers: { 'x-tab-id': tabId },
    });
    if (activeAccountIdRef.current !== accountId) return;
    if (response.status === 401) {
      window.location.href = '/login';
      throw new Error('登录状态已失效，请重新登录后重试。');
    }
    const data = await readJsonResponse<{ error?: string; message?: string }>(response);
    if (!response.ok) throw new Error(data.message || data.error || '加载图集失败');
  }, [currentUser?.id]);

  const handleCollectionSave = useCallback(async (name: string) => {
    const accountId = currentUser?.id || null;
    if (!accountId || activeAccountIdRef.current !== accountId) throw new Error('登录账号尚未确认，未保存图集。');
    const tabId = sessionStorage.getItem('workspace_tab_id') || 'default';
    const res = await fetch('/api/collections', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tab-id': tabId,
      },
      body: JSON.stringify({ name }),
    });
    const data = await readJsonResponse<{ collection?: AssetCollection; error?: string; message?: string }>(res);
    if (activeAccountIdRef.current !== accountId) return;
    if (res.status === 401) {
      window.location.href = '/login';
      throw new Error('登录状态已失效，请重新登录后重试。');
    }
    if (!res.ok) throw new Error(data.error);
    if (data.collection) setCollections((current) => [data.collection!, ...current]);
  }, [currentUser?.id]);

  const handleCollectionNew = useCallback(async (name: string) => {
    const accountId = currentUser?.id || null;
    if (!accountId || activeAccountIdRef.current !== accountId) throw new Error('登录账号尚未确认，未创建图集。');
    const tabId = sessionStorage.getItem('workspace_tab_id') || 'default';
    const res = await fetch('/api/collections', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tab-id': tabId,
      },
      body: JSON.stringify({ name }),
    });
    const data = await readJsonResponse<{ collection?: AssetCollection; error?: string; message?: string }>(res);
    if (activeAccountIdRef.current !== accountId) return;
    if (res.status === 401) {
      window.location.href = '/login';
      throw new Error('登录状态已失效，请重新登录后重试。');
    }
    if (!res.ok) throw new Error(data.error);
    if (data.collection) setCollections((current) => [data.collection!, ...current]);
  }, [currentUser?.id]);

  const handleReset = useCallback(() => {
    setResult(null);
    setError(null);
    setErrorDebug(null);
  }, []);

  // ============================================================================
  // Helpers
  // ============================================================================

  function formatRecentTaskTime(dateStr: string): string {
    try {
      const d = new Date(dateStr);
      const now = new Date();
      const diff = Math.floor((now.getTime() - d.getTime()) / 1000);
      if (diff < 60) return '刚刚';
      if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
      if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
      const days = Math.floor(diff / 86400);
      if (days < 7) return `${days} 天前`;
      if (days < 30) return `${Math.floor(days / 7)} 周前`;
      return `${Math.floor(days / 30)} 个月前`;
    } catch {
      return '';
    }
  }

  function formatAbsoluteTime(dateStr: string): string {
    try {
      return new Date(dateStr).toLocaleString('zh-CN');
    } catch {
      return '';
    }
  }

  function truncatePrompt(prompt: string, maxLen = 60): string {
    if (prompt.length <= maxLen) return prompt;
    return prompt.slice(0, maxLen) + '...';
  }

  const projectNameCounts = projects.reduce<Record<string, number>>((counts, project) => {
    const name = projectDisplayName(project);
    counts[name] = (counts[name] || 0) + 1;
    return counts;
  }, {});
  const selectedProject = projects.find((project) => project.id === selectedProjectId) || null;
  const selectedProjectLabel = selectedProject
    ? projectDisplayName(selectedProject)
    : loadingProjects
      ? '正在加载项目...'
      : '暂无可生成项目';
	  const selectedProjectMeta = selectedProject
	    ? projectMetaLabel(selectedProject)
	    : '新建一个项目后即可保存任务、成本和结果。';
	  const selectedVideoCard = videoCards.find((card) => card.id === selectedVideoCardId) || null;
	  const selectedVideoCardDefaults = selectedVideoCard
	    ? {
	        id: selectedVideoCard.id,
	        ratio: asVideoRatio(selectedVideoCard.ratio),
	        duration: asVideoDuration(selectedVideoCard.duration),
	        resolution: asVideoResolution(selectedVideoCard.target_resolution),
	      }
	    : null;
	  const selectedVideoCardSpecText = selectedVideoCard
	    ? [
	        selectedVideoCard.ratio || '比例未定',
	        selectedVideoCard.duration ? `${selectedVideoCard.duration}s` : '时长未定',
	        selectedVideoCard.target_resolution || '分辨率未定',
	      ].join(' · ')
	    : '';
	  const videoCardSummaryLabel = loadingVideoCards
    ? '正在加载视频卡...'
    : selectedVideoCard
      ? selectedVideoCard.title
      : selectedProjectId
        ? '未选择视频卡'
        : '先选择项目';
  const videoCardSummaryHelp = selectedVideoCard
    ? selectedVideoCard.objective || '已绑定本次生成归属'
    : selectedProjectId && videoCards.length === 0 && !loadingVideoCards
      ? '当前项目还没有视频卡，展开后创建'
      : '展开后可切换或创建视频卡';
  const showRecentTaskSurface = recentTasksLoadingInitial || recentTasks.length > 0 || Boolean(recentTasksError);

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <div className={`composer-page${isIpSurface ? ' composer-page-ip' : ''}`}>
      {productDialog}
      {/* ===== 顶部导航栏 ===== */}
      <ComposerTopbar user={currentUser} loadingUser={loadingUser} credits={credits} />

      {reuseOutcomeUnknown && (
        <section className="composer-prefill-notice" role="alert" aria-live="polite">
          <p>旧任务复用结果没有确认。当前生成参数未替换，但参考区可能已变化；不会自动重试。</p>
          <p>
            {reuseRefreshInProgress
              ? '正在重新读取参考区...'
              : reuseRefreshRequested && workspaceBusy
                ? '读取后仍有未确认状态，请重试读取；此复用结果仍待确认。'
                : reuseRefreshRequested
                  ? '已请求重新读取，请核对下方当前参考素材；这不代表刚才的复用请求未生效。'
                  : '请先重新读取参考区，再核对当前素材。'}
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={reuseRefreshInProgress || workspaceRefreshReadyKey !== workspaceBridgeKey || !workspaceRefreshRef.current || workspaceRefreshRef.current.key !== workspaceBridgeKey}
            onClick={() => void requestWorkspaceReadAfterUnknownReuse()}
          >
            {reuseRefreshInProgress ? '正在读取...' : '重新读取参考区'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!reuseRefreshRequested || workspaceBusy}
            onClick={() => {
              cancelReuseIntent();
              setReuseOutcomeUnknown(false);
              setReuseRefreshRequested(false);
              setReuseMessage('已核对并结束本次复用，当前输入与参考素材保留；没有再次发送复用请求。');
            }}
          >
            保留当前输入并结束复用
          </button>
          {reuseIntent && <Link href={taskDetailHref(reuseIntent.taskId, projectReturnTo)}>查看原任务</Link>}
        </section>
      )}

      {!reuseOutcomeUnknown && workspaceBusy && workspaceBusySnapshot.key === workspaceBridgeKey && workspaceBusySnapshot.reason === 'read-error' && (
        <section className="composer-prefill-notice" role="alert" aria-live="polite">
          <p>参考素材区读取或更新失败，当前状态未确认；暂不发送复用请求。</p>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={reuseRefreshInProgress || workspaceRefreshReadyKey !== workspaceBridgeKey || !workspaceRefreshRef.current || workspaceRefreshRef.current.key !== workspaceBridgeKey}
            onClick={() => void requestWorkspaceReadAfterBusyError()}
          >
            {reuseRefreshInProgress ? '正在读取...' : '重新读取参考区'}
          </button>
        </section>
      )}

      {/* ===== 页面主体 ===== */}
      <main ref={composerMainRef} className="composer-main" aria-busy={reuseUiLocked}>
        {projectReturnTo && (
          <div className="composer-prefill-notice">
            <Link href={projectReturnTo}>{taskReturnLabel(projectReturnTo)}</Link>
            <span>返回来源页面不会清除本次已选内容。</span>
          </div>
        )}

        {/* Hero 空状态 */}
        <div className="composer-hero">
          <h1 className="composer-hero-title">
            {surfaceConfig.titleLead}<span>{surfaceConfig.titleAccent}</span>
          </h1>
          <p className="composer-hero-sub">
            {surfaceConfig.subtitle}
          </p>
          {!hideExternalIpInternalControls && (
            <div className="composer-hero-actions">
              {surfaceConfig.heroLinks
                .filter((link) => !link.adminOnly || currentUser?.role === 'admin')
                .filter((link) => !link.externalHidden || !isExternalUser(currentUser))
                .filter((link) => isNavItemVisible(link,currentUser))
                .map((link) => (
                <Link href={link.href} className="composer-hero-action composer-hero-action-secondary" key={link.href}>
                  {link.label}
                </Link>
              ))}
              {isIpSurface && (
                <span className="composer-hero-action composer-hero-action-muted">
                  火山官方 API
                </span>
              )}
            </div>
          )}
        </div>

        <div ref={projectPanelRef} className="composer-project-panel" aria-busy={reuseUiLocked}>
          <div className="composer-project-row">
            <div className="composer-project-copy">
              <span className="composer-project-label">保存到</span>
              <span className="composer-project-help">本次生成的任务、成本和结果会写入所选项目。</span>
            </div>

            <div className="composer-project-controls">
              <div className="composer-project-picker" ref={projectPickerRef}>
                <button
                  type="button"
                  className="composer-project-trigger"
                  onClick={() => setProjectPickerOpen((open) => !open)}
                  disabled={loadingProjects || projectBusy || reuseUiLocked}
                  aria-expanded={projectPickerOpen}
                  aria-haspopup="dialog"
                  title="本次生成的任务和结果会写入所选项目"
                >
                  <span
                    className={`composer-project-trigger-icon${selectedProject ? ' is-avatar' : ''}`}
                    aria-hidden="true"
                  >
                    {selectedProject ? (
                      <UserIdentityBadge
                        user={projectOwnerUser(selectedProject)}
                        size="md"
                        className="composer-project-trigger-avatar"
                      />
                    ) : (
                      <Folder size={16} />
                    )}
                  </span>
                  <span className="composer-project-trigger-copy">
                    <span className="composer-project-trigger-name">{selectedProjectLabel}</span>
                    <span className="composer-project-trigger-meta-row">
                      <span className="composer-project-trigger-meta">{selectedProjectMeta}</span>
                    </span>
                  </span>
                  <ChevronDown className="composer-project-trigger-chevron" size={16} aria-hidden="true" />
                </button>

                {projectPickerOpen && (
                  <div ref={projectPickerMenuRef} className="composer-project-menu" role="dialog" aria-label="项目列表">
                    <div className="composer-project-menu-head">
                      <div>
                        <span className="composer-project-menu-title">项目列表</span>
                        <span className="composer-project-menu-subtitle">{projects.length} 个可生成项目</span>
                      </div>
                      <button
                        type="button"
                        className="composer-project-menu-action"
                        onClick={() => {
                          setProjectCreateOpen((open) => !open);
                          setProjectMessage(null);
                        }}
                        disabled={projectBusy || reuseUiLocked}
                      >
                        <Plus size={15} aria-hidden="true" />
                        新建项目
                      </button>
                    </div>

                    {projectCreateOpen && (
                      <form className="composer-project-create composer-project-create-inline" onSubmit={handleCreateProject}>
                        <input
                          className="composer-project-input"
                          value={projectName}
                          onChange={(event) => setProjectName(event.target.value)}
                          placeholder="输入项目名称"
                          maxLength={40}
                          autoFocus
                        />
                        <button type="submit" className="composer-project-btn composer-project-btn-primary" disabled={projectBusy || reuseUiLocked}>
                          {projectBusy ? '创建中...' : '创建'}
                        </button>
                        <button
                          type="button"
                          className="composer-project-btn"
                          onClick={() => {
                            setProjectCreateOpen(false);
                            setProjectName('');
                            setProjectMessage(null);
                          }}
                          disabled={projectBusy || reuseUiLocked}
                        >
                          取消
                        </button>
                      </form>
                    )}

                    <div className="composer-project-list" role="listbox" aria-label="选择保存项目">
                      {loadingProjects ? (
                        <div className="composer-project-list-empty">正在加载项目...</div>
                      ) : projects.length === 0 ? (
                        <div className="composer-project-list-empty">暂无可生成项目，先新建一个项目。</div>
                      ) : (
                        projects.map((project) => {
                          const duplicateName = projectNameCounts[projectDisplayName(project)] > 1;
                          const isSelected = project.id === selectedProjectId;
                          const canRemoveProject = projectCanRemove(project);
                          const removalAction = projectRemovalAction(project);
                          const selectProject = () => {
                            if (projectBusy || reuseUiLocked) return;
                            markReuseSelectionChanged();
                            setInputRecoveryTarget(null);
                            userChangedProjectRef.current = true;
                            userChangedVideoCardRef.current = false;
                            userChangedVideoBranchRef.current = false;
                            setSelectedProjectId(project.id);
                            setProjectPickerOpen(false);
                            setProjectCreateOpen(false);
                            setProjectMessage(null);
                          };
                          return (
                            <div
                              key={project.id}
                              role="option"
                              tabIndex={0}
                              aria-selected={isSelected}
                              aria-disabled={reuseUiLocked}
                              className={[
                                'composer-project-option',
                                isSelected ? 'active' : '',
                              ].filter(Boolean).join(' ')}
                              onClick={selectProject}
                              onKeyDown={(event) => {
                                if (event.key !== 'Enter' && event.key !== ' ') return;
                                event.preventDefault();
                                selectProject();
                              }}
                            >
                              <span className="composer-project-option-mark" aria-hidden="true">
                                {isSelected ? <Check size={16} /> : <Folder size={16} />}
                              </span>
                              <span className="composer-project-option-copy">
                                <span className="composer-project-option-name">
                                  {projectDisplayName(project)}
                                </span>
                                <span className="composer-project-option-meta">
                                  {projectMetaLabel(project)}
                                </span>
                                {duplicateName && (
                                  <span className="composer-project-option-owner">
                                    <UserIdentityBadge user={projectOwnerUser(project)} size="sm" />
                                  </span>
                                )}
                              </span>
                              {canRemoveProject && (
                                <span
                                  className="composer-project-option-actions"
                                  onClick={(event) => event.stopPropagation()}
                                >
                                  <button
                                    type="button"
                                    className={removalAction === 'delete' ? 'composer-project-option-danger' : 'composer-project-option-action'}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void handleProjectRemoval(project);
                                    }}
                                    disabled={projectBusy || reuseUiLocked}
                                    title={projectRemovalTitle(project)}
                                    aria-label={`${projectRemovalLabel(project)}项目 ${projectDisplayName(project)}`}
                                  >
                                    {removalAction === 'archive'
                                      ? <Archive size={14} aria-hidden="true" />
                                      : <Trash2 size={14} aria-hidden="true" />}
                                    <span>{projectRemovalLabel(project)}</span>
                                  </button>
                                </span>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>

                    <div className="composer-project-menu-footer">
                      <Link href="/projects" className="composer-project-menu-link">
                        项目管理
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

        {projectMessage && (
          <div className={`composer-project-message ${projectMessage.type}`}>
            {projectMessage.text}
          </div>
        )}

        {pendingProjectRemoval && (
          <div ref={projectRemovalBackdropRef} className="modal-overlay" role="presentation">
            <div ref={projectRemovalDialogRef} className="modal-panel project-removal-modal" role="dialog" aria-modal="true" aria-label={`${projectRemovalLabel(pendingProjectRemoval.project)}项目确认`}>
              <div className="modal-header">
                <div>
                  <h2>
                    {pendingProjectRemoval.action === 'archive' ? '归档项目' : '删除空项目'}
                  </h2>
                  <p>
                    {pendingProjectRemoval.action === 'archive'
                      ? '项目已有任务或图集，归档后历史记录仍会保留。'
                      : '空项目删除后不会再出现在项目列表。'}
                  </p>
                </div>
                <button
                  type="button"
                  className="modal-close"
                  onClick={() => setPendingProjectRemoval(null)}
                  disabled={projectBusy || reuseUiLocked}
                  aria-label="关闭"
                >
                  ×
                </button>
              </div>
              <div className="project-removal-summary" data-action={pendingProjectRemoval.action}>
                <strong>{projectDisplayName(pendingProjectRemoval.project)}</strong>
                <span>{projectMetaLabel(pendingProjectRemoval.project)}</span>
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setPendingProjectRemoval(null)}
                  disabled={projectBusy || reuseUiLocked}
                >
                  取消
                </button>
                <button
                  type="button"
                  className={pendingProjectRemoval.action === 'delete' ? 'btn btn-danger' : 'btn btn-primary'}
                  onClick={() => void confirmProjectRemoval()}
                  disabled={projectBusy || reuseUiLocked}
                >
                  {projectBusy
                    ? '处理中...'
                    : pendingProjectRemoval.action === 'archive'
                      ? '确认归档'
                      : '确认删除'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {!hideExternalIpInternalControls && (
      <div ref={videoCardPanelRef} className={`composer-video-card-panel ${videoCardPanelOpen ? 'is-open' : ''}`} aria-busy={reuseUiLocked}>
        <button
          type="button"
          className="composer-video-card-summary"
          onClick={() => setVideoCardPanelOpen((open) => !open)}
          aria-expanded={videoCardPanelOpen}
        >
          <span className="composer-video-card-summary-copy">
            <span className="composer-project-label">视频卡</span>
            <span className="composer-video-card-summary-main">{videoCardSummaryLabel}</span>
            <span className="composer-project-help">{videoCardSummaryHelp}</span>
          </span>
          <span className="composer-video-card-summary-action">
            {videoCardPanelOpen ? '收起' : '展开'}
            <ChevronDown className="composer-video-card-summary-icon" size={16} aria-hidden="true" />
          </span>
        </button>

        {videoCardPanelOpen && (
          <div className="composer-video-card-body">
            <div className="composer-project-row">
              <div className="composer-project-copy">
                <span className="composer-project-label">视频卡归属</span>
                <span className="composer-project-help">本次生成必须归入一张视频卡，后续成本、最佳版和最终版都按卡追踪。</span>
              </div>
              <div className="composer-video-card-controls">
                <select
                  className="composer-project-input"
                  value={selectedVideoCardId}
                  onChange={(event) => {
                    markReuseSelectionChanged();
                    setInputRecoveryTarget(null);
                    userChangedVideoCardRef.current = true;
                    userChangedVideoBranchRef.current = false;
                    setSelectedVideoCardId(event.target.value);
                  }}
                  disabled={!selectedProjectId || loadingVideoCards || videoCardBusy || reuseUiLocked}
                >
                  <option value="">
                    {loadingVideoCards ? '正在加载视频卡...' : '选择视频卡'}
                  </option>
                  {videoCards.map((card) => (
                    <option key={card.id} value={card.id} disabled={card.status === 'sealed' || card.status === 'archived'}>
                      {card.title}{card.summary ? ` · ${card.summary.task_count} 次` : ''}
                    </option>
                  ))}
                </select>
                {showVideoCardManagementUi && selectedVideoCard && (
                  <Link
                    className="composer-video-card-link"
                    href={`/projects/${selectedVideoCard.project_id || selectedProjectId}/video-cards/${selectedVideoCard.id}`}
                  >
                    查看视频卡
                  </Link>
                )}
              </div>
            </div>

	            {selectedVideoCard && (
	              <div className="composer-video-card-current">
	                <strong>{selectedVideoCard.title}</strong>
	                <span>{selectedVideoCard.objective || '未填写视频目标'}</span>
	                <small>{selectedVideoCardSpecText} · 生成参数将按视频卡规格继承</small>
	              </div>
	            )}

	            {selectedVideoCard && (loadingVideoBranches || videoBranches.length > 0) && (
	              <div className="composer-video-branch-row">
	                <span>方向分支</span>
	                <select
	                  className="composer-project-input"
	                  value={selectedVideoBranchId}
	                  onChange={(event) => {
                      markReuseSelectionChanged();
	                    userChangedVideoBranchRef.current = true;
	                    setSelectedVideoBranchId(event.target.value);
	                  }}
                  disabled={loadingVideoBranches || videoCardBusy || reuseUiLocked}
	                >
	                  <option value="">不指定方向</option>
	                  {videoBranches.map((branch) => (
	                    <option key={branch.id} value={branch.id}>
	                      {branch.is_primary ? '主方向 · ' : ''}{branch.title}{branch.summary ? ` · ${branch.summary.task_count} 次` : ''}
	                    </option>
	                  ))}
	                </select>
	              </div>
	            )}

	            {selectedProjectId && videoCards.length === 0 && !loadingVideoCards && (
              <div className="composer-video-card-empty">当前项目还没有视频卡。创建后才能提交生成。</div>
            )}

            <form className="composer-video-card-create" onSubmit={handleCreateVideoCard}>
              <input
                className="composer-project-input"
                value={videoCardTitle}
                onChange={(event) => setVideoCardTitle(event.target.value)}
                placeholder="新视频卡标题"
                maxLength={80}
                disabled={!selectedProjectId || videoCardBusy || reuseUiLocked}
              />
              <input
                className="composer-project-input"
                value={videoCardObjective}
                onChange={(event) => setVideoCardObjective(event.target.value)}
                placeholder="视频目标，可选"
                maxLength={160}
                disabled={!selectedProjectId || videoCardBusy || reuseUiLocked}
              />
              <button
                className="composer-project-btn composer-project-btn-primary"
                type="submit"
                disabled={!selectedProjectId || videoCardBusy || reuseUiLocked || !videoCardTitle.trim()}
              >
                {videoCardBusy ? '创建中...' : '创建视频卡'}
              </button>
            </form>

            {videoCardMessage && (
              <div className={`composer-project-message ${videoCardMessage.type}`}>
                {videoCardMessage.text}
              </div>
            )}
          </div>
        )}
      </div>
      )}

        {surfaceConfig.notice && (
          <div className="composer-prefill-notice">
            {surfaceConfig.notice}
          </div>
        )}

        {reuseMessage && (
          <div className={`composer-prefill-notice ${reuseLoading || reuseIntent?.phase === 'waiting' || reuseIntent?.phase === 'applying' ? 'is-loading' : ''}`} role="status" aria-live="polite">
            <span>{reuseMessage}</span>
            {reuseIntent && ['waiting', 'blocked', 'failed'].includes(reuseIntent.phase) && (
              <>
                {reuseIntent.phase !== 'waiting' && <button type="button" className="btn btn-primary"
                  disabled={reuseUiLocked || reuseContextBusy || parentReuseInitializing}
                  onClick={() => {
                    if (reuseParameterOnlyAvailable && parameterOnlyReuseRef.current) void parameterOnlyReuseRef.current();
                    else void loadReusableTask(reuseIntent.taskId, { clearUrl: reuseIntent.fromUrl });
                  }}
                >{reuseParameterOnlyAvailable ? '仅恢复参数' : '继续复用'}</button>}
                <button type="button" className="btn btn-secondary" disabled={reuseUiLocked} onClick={cancelReuseIntent}>取消复用</button>
                <Link href={taskDetailHref(reuseIntent.taskId, projectReturnTo)}>查看原任务</Link>
              </>
            )}
          </div>
        )}

        {studioRunId && (
          <div className="composer-prefill-notice">
            {studioHandoffLoading
              ? '正在安全恢复模板运行记录与素材...'
              : studioHandoffError || '模板运行记录已接入普通视频生成；编辑内容只写入新任务快照。'}
            {' '}
            <Link href={studioReturnTo || `/template-studio?type=video&view=run&runId=${encodeURIComponent(studioRunId)}`}>返回模板工作台</Link>
          </div>
        )}

        {unconfirmedGenerationRequest && unconfirmedGenerationParamsRef.current && (
          <button
            type="button"
            className="composer-prefill-notice"
            onClick={() => {
              const params = unconfirmedGenerationParamsRef.current;
              if (!params) return;
              forceNewGenerationRef.current = true;
              void handleSubmit(params);
            }}
          >
            按当前内容新建任务
          </button>
        )}

        {loadingUser && (
          <p className="composer-prefill-notice is-loading" role="status">正在确认登录状态</p>
        )}
        {userLoadError && (
          <div className="composer-prefill-notice" role="alert">
            <p>{userLoadError}</p>
            <button type="button" className="btn btn-secondary" disabled={loadingSessionUser} onClick={() => void refreshUser({ force: true })}>
              <RefreshCw size={16} />重新检查
            </button>
          </div>
        )}
        {hasLoadedUser && !loadingSessionUser && !currentUser && !userLoadError && (
          <p className="composer-prefill-notice">请登录后选择参考素材。<Link href="/login">重新登录</Link></p>
        )}

        {imageResultRequested && <p className="composer-prefill-notice" role={imageResultError ? 'alert' : 'status'}>
          {imageResultLoading ? '正在重新核对原图与独立视频草稿…' : imageResultError || imageResultHandoff?.message}
          {imageResultHandoff && <Link href={imageResultHandoff.returnPath}>返回原结果</Link>}
          {imageResultPendingReceipt && <button type="button" className="btn btn-secondary" disabled={imageResultLoading} onClick={() => {
            const ownerId = currentUser?.id, receipt = imageResultPendingReceipt;
            if (!ownerId) return;
            setImageResultLoading(true); setImageResultError('');
            void resumeImageResultVideoImport(receipt).then(value => {
              if (activeAccountIdRef.current !== ownerId || !value.workspaceTabId) return;
              sessionStorage.setItem('workspace_tab_id', value.workspaceTabId); setStudioWorkspaceTabId(value.workspaceTabId);
              setImageResultHandoff({ ...value, ownerId }); setImageResultPendingReceipt('');
            }).catch(cause => { if (activeAccountIdRef.current === ownerId) setImageResultError(cause instanceof Error ? cause.message : '原导入尚未确认'); })
              .finally(() => { if (activeAccountIdRef.current === ownerId) setImageResultLoading(false); });
          }}>继续准备原首帧</button>}
        </p>}
        {(imageResultRequested === false || Boolean(imageResultHandoff)) && <GenerationComposer
          key={`${currentUser?.id || 'anonymous'}:${studioHandoff?.runId || 'standard'}:${studioWorkspaceTabId || 'workspace'}`}
          collections={collections}
          initialSettings={generationDefaults}
          preferencesReady={generationDefaultsReady}
          onSettingsChange={saveGenerationDefaults}
          videoCardDefaults={selectedVideoCardDefaults}
          reuseDraft={reuseDraft}
          studioHandoff={studioHandoff}
          imageResultHandoff={imageResultHandoff}
          selectedVideoCardId={selectedVideoCardId}
          canManageTemplates={currentUser?.role === 'admin'}
          require1080pApproval={Boolean(selectedProject && selectedProject.type !== 'personal')}
          onCollectionLoad={handleCollectionLoad}
          onCollectionSave={handleCollectionSave}
          onCollectionNew={handleCollectionNew}
          interactionLocked={reuseUiLocked}
          onWorkspaceBusyChange={reportWorkspaceBusy}
          onWorkspaceRefreshReady={reportWorkspaceRefreshReady}
          onInputRecoveryReady={reportInputRecoveryReady}
          onCaptureInputRecoveryTarget={captureInputRecoveryTarget}
          inputRecoveryScope={() => { const context = readReuseContext(); return JSON.stringify([context.projectId, context.videoCardId, context.videoBranchId, context.editEpoch]); }}
          onReuseStateChange={reportComposerReuseState}
          onReuseDraftApplied={completeReuseDraftApplication}
          onSubmit={handleSubmit}
          submitError={error}
          submitErrorDebug={errorDebug}
          isSubmitting={submitting}
          result={result}
          polledResult={polledResult}
          isPolling={isPolling}
          onReset={handleReset}
          resultReturnTo={generationReturnTo}
          studioReturnTo={studioReturnTo}
          submitDisabledReason={studioRunId && (studioHandoffLoading || !studioHandoff)
            ? studioHandoffLoading ? '模板运行记录加载中，请稍候' : studioHandoffError || '模板运行记录尚未通过授权校验'
            : surfaceConfig.submitDisabledReason}
          providerLabel={activeProviderLabel}
          providerOptions={[]}
          selectedProvider={selectedProvider}
          pricingProvider={isIpSurface ? 'volcengine_ip' : selectedProvider}
          pricingModelId={selectedProvider === 'h3' ? selectedH3Preset?.id || h3VideoConfig?.default_preset_id : undefined}
          h3CapabilitiesReady={h3CapabilitiesReady}
          providerStatus={h3MachineStatus}
          modelLabel={activeModelLabel}
          modelOptions={activeModelOptions}
          allowExtendedSeedanceDuration
          onModelChange={handleGenerationModelChange}
          auxiliaryLabel="LoRA"
          auxiliaryOptions={activeH3LoraOptions}
          selectedAuxiliary={selectedH3LoraId}
          onAuxiliaryChange={setSelectedH3LoraId}
          seedanceDraft={{
            createEnabled: seedanceDraftCapability.create_enabled,
            message: seedanceDraftCapability.message,
          }}
        />}

        {/* 最近任务 */}
        {showRecentTaskSurface && (
          <div className="composer-recent">
            <div className="composer-recent-title">最近任务</div>
            {recentTasks.length > 0 && (
              <div className="composer-recent-grid">
                {displayRecentTasks.map((task) => {
                  const chargeText = formatProviderUsdCharge(task);
                  const recentTaskChargeText = chargeText ? formatRecentTaskChargeText(chargeText) : null;
                  const enhanceTask = isRecentEnhanceTask(task);
                  const taskErrorMessage = task.error_message?.trim();

                  return (
                    <article
                      key={task.id}
                      className="composer-task-card"
                    >
                      {!isIpSurface && task.can_delete !== false && (
                        <button
                          type="button"
                          className="composer-task-card-delete"
                          disabled={deletingRecentTaskId === task.id}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void deleteRecentTask(task);
                          }}
                          aria-label="从最近生成移除"
                          title="从最近生成移除"
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      )}
                      <div className="composer-task-card-link">
	                        <TaskVideoThumbnail
	                          taskId={task.id}
	                          thumbnailUrl={task.thumbnail_url}
	                          publicVideoUrl={task.public_video_url}
	                          localVideoPath={task.local_video_path}
	                          resultVideoUrl={task.result_video_url}
	                          resultLastFrameUrl={task.result_last_frame_url}
	                          status={task.local_status}
	                          deliveryStage={task.delivery_stage}
	                          previewAvailable={task.preview_available}
	                          stableDownloadReady={task.stable_download_ready}
	                          retryAfterMs={task.retry_after_ms}
	                          provider={task.provider}
	                          generationMode={task.generation_mode}
	                          size="card"
	                          className="composer-task-card-preview"
                              href={taskDetailHref(task.id, generationReturnTo)}
                              reactions={task.local_status === 'succeeded'}
	                        />
                        <Link href={taskDetailHref(task.id, generationReturnTo)} className="composer-task-card-body">
                          <div className="composer-task-card-prompt" title={`${formatAbsoluteTime(task.created_at)} · ${task.prompt}`}>
                            <time className="composer-task-card-prompt-time" dateTime={task.created_at}>
                              {formatRecentTaskTime(task.created_at)}
                            </time>
                            <span className="composer-task-card-prompt-text">
                              {truncatePrompt(task.prompt)}
                            </span>
                          </div>
                          {(task.generation_template || task.selected_agent_plan_key) && (
                            <div className="composer-task-card-template">
                              {task.generation_template ? `${task.generation_template.name} ${task.generation_template.version}` : '模板生成'}
                              {task.selected_agent_plan_key ? ` · 方案 ${task.selected_agent_plan_key}` : ''}
                              {task.prompt_user_edited ? ' · 已编辑' : ''}
                            </div>
                          )}
                          <div className="composer-task-card-meta">
                            {isIpSurface && task.model && <span>{volcengineIpModelLabel(task.model)}</span>}
                            {task.is_draft && (
                              <span className="composer-task-card-enhance-chip">
                                样片 Draft
                              </span>
                            )}
                            {enhanceTask && (
                              <span className="composer-task-card-enhance-chip">
                                视频超分
                              </span>
                            )}
                            {recentTaskChargeText && (
                              <span className="composer-task-card-charge" title={`实际扣除 ${recentTaskChargeText}`}>
                                {recentTaskChargeText}
                              </span>
                            )}
                            <span className={`composer-task-card-status ${task.local_status}`}>
                              {task.error_code === 'IP_SUBMISSION_UNCONFIRMED' ? '提交待确认' :
                                task.error_code === 'IP_CANCEL_UNCONFIRMED' ? '取消待确认' :
                                task.local_status === 'submitted' ? '排队中' :
                                task.local_status === 'running' ? '生成中' :
                                task.local_status === 'succeeded' ? (task.delivery_stage?.label || '已生成') :
                                task.local_status === 'failed' ? '失败' : task.local_status}
                            </span>
                          </div>
                          {(task.local_status === 'failed' || task.error_code?.startsWith('IP_')) && taskErrorMessage && (
                            <div className="composer-task-card-error" title={taskErrorMessage}>
                              {taskErrorMessage}
                            </div>
                          )}
                        </Link>
                      </div>
                      {isIpSurface && task.local_status === 'succeeded' && task.delivery_stage?.key === 'failed' && (
                        <button
                          type="button"
                          className="composer-task-card-reuse"
                          title="重新保存已有视频，不重新生成、不扣点"
                          disabled={retryingDeliveryId === task.id}
                          onClick={async () => {
                            setRetryingDeliveryId(task.id);
                            try {
                              const response = await fetch(`/api/video/download/${task.id}`, { method: 'POST' });
                              const data = await response.json();
                              if (!response.ok) throw new Error(data.message || data.error || '重试保存失败');
                              setActivePollingTaskIds((current) => [task.id, ...current.filter((id) => id !== task.id)].slice(0, MAX_ACTIVE_POLLING_TASKS));
                              setRecentTasks((current) => current.map((item) => item.id === task.id
                                ? { ...item, delivery_stage: { key: 'preparing', label: '正在重新保存' } } : item));
                            } catch (error) {
                              setRecentTasksError(error instanceof Error ? error.message : '重试保存失败');
                            } finally {
                              setRetryingDeliveryId(null);
                            }
                          }}
                        ><RefreshCw size={14} aria-hidden="true" /> {retryingDeliveryId === task.id ? '正在提交' : '重试保存'}</button>
                      )}
                      {task.is_draft ? (
                        <button
                          type="button"
                          className="composer-task-card-reuse"
                          disabled={task.local_status !== 'succeeded' || !seedanceDraftCapability.upgrade_enabled || draftUpgradeTaskId !== null}
                          onClick={() => void upgradeDraftTask(task)}
                          title={seedanceDraftCapability.upgrade_enabled ? '沿用样片内容生成 1080p' : seedanceDraftCapability.message}
                        >
                          {draftUpgradeTaskId === task.id
                            ? '提交中...'
                            : task.local_status !== 'succeeded'
                              ? '等待样片完成'
                              : seedanceDraftCapability.upgrade_enabled
                                ? '沿用样片内容生成 1080p'
                                : '1080p 升级待确认'}
                        </button>
                      ) : enhanceTask ? (
                        <Link
                          href={taskDetailHref(task.id, generationReturnTo)}
                          className="composer-task-card-reuse composer-task-card-reuse-link"
                        >
                          查看超分结果
                        </Link>
                      ) : !isExternalIpUser ? (
                        <button
                          type="button"
                          className="composer-task-card-reuse"
                          disabled={reuseUiLocked || task.error_code === 'IP_SUBMISSION_UNCONFIRMED' || task.error_code === 'IP_CANCEL_UNCONFIRMED'}
                          onClick={() => loadReusableTask(task.id)}
                          title={reuseContextBusy ? '先保留旧任务来源，准备好后可继续复用；不会直接生成。' : '复用会替换本页参数与参考素材，并先要求确认。'}
                        >
                          {reusingTaskId === task.id ? '回填中...' : '重新生成'}
                        </button>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            )}
            <div ref={recentTasksSentinelRef} className="composer-recent-sentinel" aria-hidden="true" />
            <div className="composer-recent-footer">
              {recentTasks.length > 0 && (
                <span className="composer-recent-count">
                  已显示 {recentTasks.length} 条{recentTasksPage > 0 ? ` · 第 ${recentTasksPage} 页` : ''}
                </span>
              )}
              {recentTasksLoadingInitial && (
                <span className="composer-recent-loading">正在加载最近任务...</span>
              )}
              {!recentTasksLoadingInitial && recentTasksError && (
                <span className="composer-recent-error">
                  <span>{recentTasksError}</span>
                  <button type="button" onClick={retryRecentTasks}>重试</button>
                </span>
              )}
              {!recentTasksLoadingInitial && !recentTasksError && recentTasksLoadingMore && (
                <span className="composer-recent-loading">正在加载更多任务...</span>
              )}
              {!recentTasksLoadingInitial && !recentTasksError && !recentTasksLoadingMore && recentTasksHasMore && (
                <button
                  type="button"
                  className="composer-recent-load-more"
                  onClick={loadMoreRecentTasks}
                >
                  加载更多
                </button>
              )}
              {!recentTasksLoadingInitial && !recentTasksError && !recentTasksLoadingMore && !recentTasksHasMore && recentTasks.length > 0 && (
                <span className="composer-recent-done">已加载全部最近任务</span>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
