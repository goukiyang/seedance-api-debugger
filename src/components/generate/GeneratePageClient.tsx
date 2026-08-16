'use client';

import { useState, useEffect, useCallback, useMemo, useRef, type FormEvent } from 'react';
import Link from 'next/link';
import { Archive, Check, ChevronDown, Folder, Plus, Trash2 } from 'lucide-react';
import type { GenerationMode, VideoRatio, VideoDuration, VideoResolution, AssetCollection } from '@/types';
import { DURATION_OPTIONS, RATIO_OPTIONS, RESOLUTION_OPTIONS } from '@/types';
import { GenerationComposer } from '@/components/GenerationComposer';
import type { ComposerSelectOption } from '@/components/ComposerActionBar';
import { TaskVideoThumbnail } from '@/components/TaskVideoThumbnail';
import type { AccountMenuUser } from '@/components/AccountMenu';
import ComposerTopbar from '@/components/ComposerTopbar';
import UserIdentityBadge from '@/components/UserIdentityBadge';
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
import { taskDetailHref } from '@/lib/navigation/return-to';
import {
  normalizeGenerationDefaults,
  type GenerationDefaults,
} from '@/lib/preferences/generation';
import { VOLCENGINE_IP_MODEL_OPTIONS } from '@/lib/integrations/volcengine-ip-models';
import { SEEDANCE_VIDEO_MODEL_OPTIONS } from '@/lib/provider/seedance-models';
import { orderRecentTaskCards, recentTaskHasVisualPreview } from '@/lib/video/recent-task-card-order';

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
  agent_run_id?: string | null;
  selected_agent_plan_key?: string | null;
  prompt_rendered?: string;
  estimated_cost?: number;
  frozen_cost?: number;
  deduplicated?: boolean;
  reference_image_notice?: string | null;
}

type CreateTaskResponse = CreateResponse & {
  error?: string;
  message?: string;
  _debug?: object | null;
};

interface TaskItem {
  id: string;
  prompt: string;
  provider: string;
  generation_mode: string;
  local_status: string;
  public_video_url: string | null;
  result_video_url: string | null;
  result_last_frame_url: string | null;
  local_video_path: string | null;
  delivery_stage?: { key?: string | null } | null;
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
  delivery_stage?: { key?: string | null } | null;
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

type GeneratePageUser = AccountMenuUser & { id: string };
type ProjectRemovalAction = 'delete' | 'archive';

type PendingProjectRemoval = {
  project: ProjectOption;
  action: ProjectRemovalAction;
};

interface AuthMeResponse {
  user: GeneratePageUser | null;
}

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
  heroLinks: Array<{ href: string; label: string; adminOnly?: boolean }>;
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
    ],
    modelLabel: 'Seedance 2.0',
  },
  ip: {
    routePath: '/generate/ip',
    titleLead: '(IP) 生成',
    titleAccent: '页',
    subtitle: '保留普通生成页完整工作流，提交时走火山官方授权 IP 动画接口',
    heroLinks: [
      { href: '/generate', label: '普通生成' },
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
  if (isIpSurface || task.local_status !== 'succeeded') return false;
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

function generationPreferenceStorageKey(userId: string) {
  return `${GENERATION_PREFERENCE_STORAGE_PREFIX}${userId}`;
}

function readLocalGenerationDefaults(userId: string): GenerationDefaults | null {
  try {
    const raw = window.localStorage.getItem(generationPreferenceStorageKey(userId));
    return raw ? normalizeGenerationDefaults(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeLocalGenerationDefaults(userId: string, settings: GenerationDefaults) {
  try {
    window.localStorage.setItem(generationPreferenceStorageKey(userId), JSON.stringify(settings));
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
  return DURATION_OPTIONS.includes(value as VideoDuration) ? value as VideoDuration : null;
}

function asVideoResolution(value?: string | null): VideoResolution | null {
  return RESOLUTION_OPTIONS.includes(value as VideoResolution) ? value as VideoResolution : null;
}

// ============================================================================
// Component
// ============================================================================

export function GeneratePageClient({ surface = 'standard' }: GeneratePageClientProps) {
  const surfaceConfig = GENERATE_SURFACE_CONFIG[surface];
  const isIpSurface = surface === 'ip';
  const projectPickerRef = useRef<HTMLDivElement | null>(null);
  const appliedPreferenceProjectRef = useRef(false);

  // ---- Collections ----
  const [collections, setCollections] = useState<AssetCollection[]>([]);

  // ---- Submit State ----
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorDebug, setErrorDebug] = useState<object | null>(null);
  const [generationDefaults, setGenerationDefaults] = useState<GenerationDefaults | null>(null);

  // ---- Recent Tasks ----
  const [recentTasks, setRecentTasks] = useState<TaskItem[]>([]);
  const [recentTasksPage, setRecentTasksPage] = useState(0);
  const [recentTasksHasMore, setRecentTasksHasMore] = useState(false);
  const [recentTasksLoadingInitial, setRecentTasksLoadingInitial] = useState(true);
  const [recentTasksLoadingMore, setRecentTasksLoadingMore] = useState(false);
  const [recentTasksError, setRecentTasksError] = useState('');
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
  const [currentUser, setCurrentUser] = useState<GeneratePageUser | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);
  const [h3VideoConfig, setH3VideoConfig] = useState<H3VideoConfig | null>(null);
  const [h3StatusChecking, setH3StatusChecking] = useState(false);
  const [selectedH3LoraId, setSelectedH3LoraId] = useState('');
  const [selectedProvider, setSelectedProvider] = useState<GenerationProvider>('seedance');

  // ---- Current Project ----
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [projectCreateOpen, setProjectCreateOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectMessage, setProjectMessage] = useState<{ type: 'info' | 'error' | 'success'; text: string } | null>(null);
  const [pendingProjectRemoval, setPendingProjectRemoval] = useState<PendingProjectRemoval | null>(null);
	  const [videoCards, setVideoCards] = useState<VideoCardOption[]>([]);
	  const [selectedVideoCardId, setSelectedVideoCardId] = useState('');
	  const [videoBranches, setVideoBranches] = useState<VideoBranchOption[]>([]);
	  const [selectedVideoBranchId, setSelectedVideoBranchId] = useState('');
	  const [loadingVideoBranches, setLoadingVideoBranches] = useState(false);
	  const [loadingVideoCards, setLoadingVideoCards] = useState(false);
  const [videoCardTitle, setVideoCardTitle] = useState('');
  const [videoCardObjective, setVideoCardObjective] = useState('');
  const [videoCardBusy, setVideoCardBusy] = useState(false);
  const [videoCardMessage, setVideoCardMessage] = useState<{ type: 'info' | 'error' | 'success'; text: string } | null>(null);
  const [videoCardPanelOpen, setVideoCardPanelOpen] = useState(false);
  const [reuseDraft, setReuseDraft] = useState<ReuseDraft | null>(null);
  const [reuseMessage, setReuseMessage] = useState('');
  const [reuseLoading, setReuseLoading] = useState(false);
  const [reusingTaskId, setReusingTaskId] = useState<string | null>(null);

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
    if (isIpSurface) return VOLCENGINE_IP_MODEL_OPTIONS;
    const options = [...SEEDANCE_VIDEO_MODEL_OPTIONS];
    const canSeeH3 = h3Ready || currentUser?.role === 'admin';
    if (canSeeH3) {
      options.push({
        id: H3_INLINE_MODEL_ID,
        label: h3Ready ? 'H3 本地模型' : 'H3 待检查',
        detail: h3Ready
          ? `本地免费 · ${selectedH3Preset?.label || h3VideoConfig?.default_preset_id || '默认预设'} · ${selectedH3Lora?.label || h3VideoConfig?.default_lora_id || '默认 LoRA'}`
          : `${h3DisabledReason(h3VideoConfig)} · 选择后点检查状态`,
      });
    }
    return options;
  }, [currentUser?.role, h3Ready, h3VideoConfig, isIpSurface, selectedH3Lora?.label, selectedH3Preset?.label]);
  const activeModelLabel = surfaceConfig.modelLabel;
  const activeProviderLabel = 'Seedance 视频';
  const refreshH3VideoConfig = useCallback(async () => {
    if (isIpSurface) return null;
    try {
      const response = await fetch('/api/config', { cache: 'no-store' });
      const data = response.ok ? await response.json() : null;
      const nextConfig = normalizeH3VideoConfig(data?.h3_video);
      setH3VideoConfig(nextConfig);
      return nextConfig;
    } catch {
      setH3VideoConfig(null);
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
    } catch (error) {
      if (!options?.silent) {
        setError(error instanceof Error ? error.message : 'H3 状态检查失败');
      }
    } finally {
      setH3StatusChecking(false);
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
    let cancelled = false;

    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data: AuthMeResponse) => {
        if (!cancelled) {
          setCurrentUser(data.user || null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCurrentUser(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingUser(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!currentUser?.id) return;
    let cancelled = false;
    const localFallback = readLocalGenerationDefaults(currentUser.id);

    const applySettings = (settings: GenerationDefaults | null) => {
      if (!settings || cancelled) return;
      setGenerationDefaults(settings);
      if (settings.projectId) {
        window.localStorage.setItem(PROJECT_STORAGE_KEY, settings.projectId);
      }
      writeLocalGenerationDefaults(currentUser.id, settings);
    };

    fetch('/api/me/preferences/generation', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        const settings = data?.settings ? normalizeGenerationDefaults(data.settings) : localFallback;
        applySettings(settings);
      })
      .catch(() => {
        applySettings(localFallback);
      });

    return () => {
      cancelled = true;
    };
  }, [currentUser?.id]);

  useEffect(() => {
    if (isIpSurface) return;
    let cancelled = false;
    fetch('/api/config', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (cancelled) return;
        setH3VideoConfig(normalizeH3VideoConfig(data?.h3_video));
      })
      .catch(() => {
        if (!cancelled) setH3VideoConfig(null);
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
    fetch('/api/collections')
      .then((r) => r.json())
      .then((d) => setCollections(d.collections || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/me/credits')
      .then((r) => {
        if (r.status === 401) {
          window.location.href = '/login';
          return null;
        }
        return r.json();
      })
      .then((d) => {
        if (d) setCredits(d);
      })
      .catch(() => {});
  }, []);

  const loadProjects = useCallback(async (options: {
    preferredProjectId?: string | null;
    keepSelected?: boolean;
  } = {}) => {
    setLoadingProjects(true);
    try {
      const res = await fetch('/api/projects', { cache: 'no-store' });
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      const data = await readJsonResponse<{ projects?: ProjectOption[] }>(res);
      const list: ProjectOption[] = (data.projects || []).filter((project: ProjectOption) => project.can_generate !== false);
      setProjects(list);

      const requestedProjectId = new URLSearchParams(window.location.search).get('project_id');
      const rememberedProjectId = window.localStorage.getItem(PROJECT_STORAGE_KEY);
      const preferredId = options.preferredProjectId || requestedProjectId || rememberedProjectId || '';

      setSelectedProjectId((current) => {
        const preferred = preferredId ? list.find((project) => project.id === preferredId) : null;
        if (preferred) return preferred.id;

        const currentProject = options.keepSelected !== false && current
          ? list.find((project) => project.id === current)
          : null;
        if (currentProject) return currentProject.id;

        const personal = list.find((project) => project.type === 'personal');
        return (personal || list[0])?.id || '';
      });
    } catch {
      setProjectMessage({ type: 'error', text: '项目列表加载失败，请刷新后重试' });
    } finally {
      setLoadingProjects(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects({ keepSelected: false });
  }, [loadProjects]);

  useEffect(() => {
    if (!selectedProjectId) return;
    window.localStorage.setItem(PROJECT_STORAGE_KEY, selectedProjectId);
  }, [selectedProjectId]);

  const loadVideoCards = useCallback(async (
    projectId: string,
    options: { preferredVideoCardId?: string | null; keepSelected?: boolean } = {},
  ) => {
    if (!projectId) {
      setVideoCards([]);
      setSelectedVideoCardId('');
      return;
    }
    setLoadingVideoCards(true);
    setVideoCardMessage(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/video-cards`, { cache: 'no-store' });
      const data = await readJsonResponse<{ video_cards?: VideoCardOption[]; error?: string; message?: string }>(res);
      if (!res.ok) throw new Error(data.message || data.error || '视频卡列表加载失败');
      const list: VideoCardOption[] = data.video_cards || [];
      setVideoCards(list);
      const requestedVideoCardId = new URLSearchParams(window.location.search).get('video_card_id');
      const preferredId = options.preferredVideoCardId || requestedVideoCardId || '';
      setSelectedVideoCardId((current) => {
        const preferred = preferredId ? list.find((card) => card.id === preferredId) : null;
        if (preferred) return preferred.id;
        const currentCard = options.keepSelected !== false && current
          ? list.find((card) => card.id === current)
          : null;
        if (currentCard) return currentCard.id;
        const active = list.find((card) => card.status !== 'sealed' && card.status !== 'archived');
        return (active || list[0])?.id || '';
      });
    } catch (err) {
      setVideoCards([]);
      setSelectedVideoCardId('');
      setVideoCardMessage({ type: 'error', text: err instanceof Error ? err.message : '视频卡列表加载失败' });
    } finally {
      setLoadingVideoCards(false);
    }
  }, []);

	  useEffect(() => {
	    void loadVideoCards(selectedProjectId, {
	      preferredVideoCardId: reuseDraft?.videoCardId || null,
	      keepSelected: true,
	    });
	  }, [loadVideoCards, selectedProjectId, reuseDraft?.videoCardId]);

	  useEffect(() => {
	    if (!selectedVideoCardId) {
	      setVideoBranches([]);
	      setSelectedVideoBranchId('');
	      return;
	    }
	    let cancelled = false;
	    setLoadingVideoBranches(true);
	    fetch(`/api/video-cards/${selectedVideoCardId}/branches`, { cache: 'no-store' })
	      .then((res) => res.ok ? res.json() : { branches: [] })
	      .then((data) => {
	        if (cancelled) return;
	        const list: VideoBranchOption[] = Array.isArray(data.branches) ? data.branches : [];
	        const active = list.filter((branch) => ['exploring', 'candidate', 'primary'].includes(branch.status));
	        setVideoBranches(active);
	        const requestedBranchId = new URLSearchParams(window.location.search).get('video_branch_id');
	        setSelectedVideoBranchId((current) => {
	          if (requestedBranchId && active.some((branch) => branch.id === requestedBranchId)) return requestedBranchId;
	          if (current && active.some((branch) => branch.id === current)) return current;
	          return active.find((branch) => branch.is_primary)?.id || '';
	        });
	      })
	      .catch(() => {
	        if (!cancelled) {
	          setVideoBranches([]);
	          setSelectedVideoBranchId('');
	        }
	      })
	      .finally(() => {
	        if (!cancelled) setLoadingVideoBranches(false);
	      });
	    return () => {
	      cancelled = true;
	    };
	  }, [selectedVideoCardId]);

  useEffect(() => {
    if (appliedPreferenceProjectRef.current) return;
    if (!generationDefaults?.projectId || projects.length === 0) return;
    const requestedProjectId = new URLSearchParams(window.location.search).get('project_id');
    if (requestedProjectId || reuseDraft?.projectId) return;

    const preferred = projects.find((project) => project.id === generationDefaults.projectId);
    if (!preferred) return;
    appliedPreferenceProjectRef.current = true;
    setSelectedProjectId(preferred.id);
  }, [generationDefaults?.projectId, projects, reuseDraft?.projectId]);

  useEffect(() => {
    if (!projectPickerOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!projectPickerRef.current?.contains(event.target as Node)) {
        setProjectPickerOpen(false);
        setProjectCreateOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setProjectPickerOpen(false);
        setProjectCreateOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [projectPickerOpen]);

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
      setSelectedVideoCardId(data.video_card.id);
      setVideoCardMessage({ type: 'success', text: `已创建视频卡「${data.video_card.title}」` });
      await loadVideoCards(selectedProjectId, {
        preferredVideoCardId: data.video_card.id,
        keepSelected: false,
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
    if (projects.some((project) => project.id === reuseDraft.projectId)) {
      setSelectedProjectId(reuseDraft.projectId);
    }
  }, [projects, reuseDraft?.projectId]);

  const loadReusableTask = useCallback(async (
    taskId: string,
    options: { clearUrl?: boolean; scrollToComposer?: boolean } = {},
  ) => {
    setReuseLoading(true);
    setReusingTaskId(taskId);
    setReuseMessage('正在载入旧任务...');
    setResult(null);
    setError(null);
    setErrorDebug(null);
    setPolledResult(null);

    try {
      const res = await fetch(`/api/tasks/${taskId}/reuse`, {
        method: 'POST',
        headers: {
          'x-tab-id': sessionStorage.getItem('workspace_tab_id') || 'default',
        },
      });
      const data = await readJsonResponse<{
        draft: {
          task_id: string;
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
        };
        skipped_references?: number;
        restored_references?: number;
        error?: string;
        message?: string;
      }>(res);
      if (!res.ok) {
        throw new Error(data.message || data.error || '复用任务失败');
      }
      setReuseDraft({
        taskId: data.draft.task_id,
        reuseKey: Date.now(),
        prompt: data.draft.prompt || '',
        generationMode: data.draft.generation_mode || 'all_in_one_reference',
        ratio: data.draft.ratio || '16:9',
        duration: data.draft.duration || 5,
        resolution: data.draft.resolution || '480p',
        seed: data.draft.seed ?? -1,
        generateAudio: Boolean(data.draft.generate_audio),
        returnLastFrame: Boolean(data.draft.return_last_frame),
        watermark: Boolean(data.draft.watermark),
        resolutionApprovalConfirmed: asBoolean(data.draft.resolution_approval_confirmed, false),
        projectId: data.draft.project_id || null,
        videoCardId: data.draft.video_card_id || null,
      });
      const skipped = data.skipped_references || 0;
      const restored = data.restored_references || 0;
      setReuseMessage(
        skipped > 0
          ? `已回填旧任务，恢复 ${restored} 张参考图，${skipped} 张未能恢复`
          : `已回填旧任务，恢复 ${restored} 张参考图`,
      );
      if (options.clearUrl) {
        window.history.replaceState(null, '', '/generate');
      }
      if (options.scrollToComposer !== false) {
        requestAnimationFrame(() => {
          document.querySelector('.generation-composer')?.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
          });
        });
      }
    } catch (err) {
      setReuseMessage(err instanceof Error ? err.message : '复用任务失败');
    } finally {
      setReuseLoading(false);
      setReusingTaskId(null);
    }
  }, []);

  useEffect(() => {
    const reuseTaskId = new URLSearchParams(window.location.search).get('reuse_task_id');
    if (!reuseTaskId) return;
    void loadReusableTask(reuseTaskId, { clearUrl: true });
  }, [loadReusableTask]);

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
    generationMode: GenerationMode;
    ratio: VideoRatio;
    duration: VideoDuration;
    resolution: VideoResolution;
    generateAudio: boolean;
    returnLastFrame: boolean;
    watermark: boolean;
  }) => {
    const settings: GenerationDefaults = {
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
      writeLocalGenerationDefaults(currentUser.id, settings);
    }

    fetch('/api/me/preferences/generation', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
    }).catch(() => {
      // 偏好保存失败不影响生成任务。
    });
  }, [currentUser?.id, selectedProjectId]);

  const handleSubmit = useCallback(async (params: {
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
  }) => {
    setSubmitting(true);
    setError(null);
    setErrorDebug(null);
    setResult(null);

    const selectedVideoCard = videoCards.find((card) => card.id === selectedVideoCardId) || null;
    if (!selectedProjectId || !selectedVideoCard) {
      setError('请先选择项目和视频卡');
      setSubmitting(false);
      return;
    }
    if (selectedVideoCard.status === 'sealed' || selectedVideoCard.status === 'archived') {
      setError('当前视频卡已封板或归档，不能继续生成');
      setSubmitting(false);
      return;
    }
    const idempotencyKey = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const selectedH3Model = !isIpSurface && params.model === H3_INLINE_MODEL_ID;
    const requestedProvider: GenerationProvider = selectedH3Model ? 'h3' : 'seedance';
    const requestedModel = selectedH3Model
      ? selectedH3Preset?.id || h3VideoConfig?.default_preset_id || ''
      : params.model || '';
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
      const createEndpoint = isIpSurface ? '/api/ip/tasks/create' : '/api/tasks/create';
      const res = await fetch(createEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tab-id': sessionStorage.getItem('workspace_tab_id') || 'default',
        },
        body: JSON.stringify({
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
          idempotency_key: idempotencyKey,
          project_id: selectedProjectId,
          video_card_id: selectedVideoCard.id,
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
          lora_id: selectedH3Model ? requestedH3LoraId : undefined,
        }),
      });

      const data = await readJsonResponse<CreateTaskResponse>(res);

      if (!res.ok) {
        setErrorDebug(data._debug || null);
        throw new Error(data.message || data.error || `创建失败 (HTTP ${res.status})`);
      }

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
          local_status: data.status || 'submitted',
          public_video_url: null,
          result_video_url: null,
          result_last_frame_url: null,
          local_video_path: null,
          provider_cost_currency: null,
          provider_official_amount_minor: null,
          provider_final_amount_minor: null,
          provider_official_amount_micros: null,
          provider_final_amount_micros: null,
          project_id: data.project_id || selectedProjectId,
          video_card_id: data.video_card_id || selectedVideoCard.id,
          template_id: data.template_id || null,
          agent_run_id: data.agent_run_id || null,
          selected_agent_plan_key: data.selected_agent_plan_key || null,
          prompt_user_edited: params.promptUserEdited === true,
          generation_template: null,
          video_card: {
            id: selectedVideoCard.id,
            title: selectedVideoCard.title,
            objective: selectedVideoCard.objective,
            status: selectedVideoCard.status,
            project_id: selectedVideoCard.project_id,
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
    videoCards,
  ]);

  // ============================================================================
  // Collection handlers
  // ============================================================================

  const handleCollectionLoad = useCallback(async (collectionId: string) => {
    await fetch(`/api/collections/${collectionId}/load`, {
      method: 'POST',
      headers: { 'x-tab-id': sessionStorage.getItem('workspace_tab_id') || 'default' },
    });
  }, []);

  const handleCollectionSave = useCallback(async (name: string) => {
    const res = await fetch('/api/collections', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tab-id': sessionStorage.getItem('workspace_tab_id') || 'default',
      },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    setCollections([data.collection, ...collections]);
  }, [collections]);

  const handleCollectionNew = useCallback(async (name: string) => {
    const res = await fetch('/api/collections', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tab-id': sessionStorage.getItem('workspace_tab_id') || 'default',
      },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    setCollections([data.collection, ...collections]);
  }, [collections]);

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
	  const selectedVideoCardLockedSettings = selectedVideoCard
	    ? {
	        sourceLabel: selectedVideoCard.title,
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
      {/* ===== 顶部导航栏 ===== */}
      <ComposerTopbar user={currentUser} loadingUser={loadingUser} credits={credits} />

      {/* ===== 页面主体 ===== */}
      <main className="composer-main">

        {/* Hero 空状态 */}
        <div className="composer-hero">
          <h1 className="composer-hero-title">
            {surfaceConfig.titleLead}<span>{surfaceConfig.titleAccent}</span>
          </h1>
          <p className="composer-hero-sub">
            {surfaceConfig.subtitle}
          </p>
          <div className="composer-hero-actions">
            {surfaceConfig.heroLinks
              .filter((link) => !link.adminOnly || currentUser?.role === 'admin')
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
        </div>

        <div className="composer-project-panel">
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
                  disabled={loadingProjects || projectBusy}
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
                  <div className="composer-project-menu" role="dialog" aria-label="项目列表">
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
                        disabled={projectBusy}
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
                        <button type="submit" className="composer-project-btn composer-project-btn-primary" disabled={projectBusy}>
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
                          disabled={projectBusy}
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
                            if (projectBusy) return;
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
                                    className="composer-project-option-danger"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void handleProjectRemoval(project);
                                    }}
                                    disabled={projectBusy}
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
          <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={`${projectRemovalLabel(pendingProjectRemoval.project)}项目确认`}>
            <div className="modal-panel project-removal-modal">
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
                  disabled={projectBusy}
                  aria-label="关闭"
                >
                  ×
                </button>
              </div>
              <div className="project-removal-summary">
                <strong>{projectDisplayName(pendingProjectRemoval.project)}</strong>
                <span>{projectMetaLabel(pendingProjectRemoval.project)}</span>
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setPendingProjectRemoval(null)}
                  disabled={projectBusy}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => void confirmProjectRemoval()}
                  disabled={projectBusy}
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

      <div className={`composer-video-card-panel ${videoCardPanelOpen ? 'is-open' : ''}`}>
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
                  onChange={(event) => setSelectedVideoCardId(event.target.value)}
                  disabled={!selectedProjectId || loadingVideoCards || videoCardBusy}
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
                {selectedVideoCard && (
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
	                  onChange={(event) => setSelectedVideoBranchId(event.target.value)}
	                  disabled={loadingVideoBranches || videoCardBusy}
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
                disabled={!selectedProjectId || videoCardBusy}
              />
              <input
                className="composer-project-input"
                value={videoCardObjective}
                onChange={(event) => setVideoCardObjective(event.target.value)}
                placeholder="视频目标，可选"
                maxLength={160}
                disabled={!selectedProjectId || videoCardBusy}
              />
              <button
                className="composer-project-btn composer-project-btn-primary"
                type="submit"
                disabled={!selectedProjectId || videoCardBusy || !videoCardTitle.trim()}
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

        {surfaceConfig.notice && (
          <div className="composer-prefill-notice">
            {surfaceConfig.notice}
          </div>
        )}

        {reuseMessage && (
          <div className={`composer-prefill-notice ${reuseLoading ? 'is-loading' : ''}`}>
            {reuseMessage}
          </div>
        )}

        <GenerationComposer
          collections={collections}
          initialSettings={generationDefaults}
          lockedSettings={selectedVideoCardLockedSettings}
          reuseDraft={reuseDraft}
          selectedVideoCardId={selectedVideoCardId}
          canManageTemplates={currentUser?.role === 'admin'}
          require1080pApproval={Boolean(selectedProject && selectedProject.type !== 'personal')}
          onCollectionLoad={handleCollectionLoad}
          onCollectionSave={handleCollectionSave}
          onCollectionNew={handleCollectionNew}
          onSubmit={handleSubmit}
          submitError={error}
          submitErrorDebug={errorDebug}
          isSubmitting={submitting}
          result={result}
          polledResult={polledResult}
          isPolling={isPolling}
          onReset={handleReset}
          resultReturnTo={surfaceConfig.routePath}
          submitDisabledReason={surfaceConfig.submitDisabledReason}
          providerLabel={activeProviderLabel}
          providerOptions={[]}
          selectedProvider={selectedProvider}
          providerStatus={h3MachineStatus}
          modelLabel={activeModelLabel}
          modelOptions={activeModelOptions}
          onModelChange={handleGenerationModelChange}
          auxiliaryLabel="LoRA"
          auxiliaryOptions={activeH3LoraOptions}
          selectedAuxiliary={selectedH3LoraId}
          onAuxiliaryChange={setSelectedH3LoraId}
        />

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

                  return (
                    <article
                      key={task.id}
                      className="composer-task-card"
                    >
                      <Link href={taskDetailHref(task.id, surfaceConfig.routePath)} className="composer-task-card-link">
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
	                        />
                        <div className="composer-task-card-body">
                          <div className="composer-task-card-prompt" title={`${formatAbsoluteTime(task.created_at)} · ${task.prompt}`}>
                            <time className="composer-task-card-prompt-time" dateTime={task.created_at}>
                              {formatRecentTaskTime(task.created_at)}
                            </time>
                            <span className="composer-task-card-prompt-text">
                              {truncatePrompt(task.prompt)}
                            </span>
                          </div>
                          <div className="composer-task-card-video-card">
                            {task.video_card ? task.video_card.title : '历史未归档视频卡'}
                          </div>
                          {(task.generation_template || task.selected_agent_plan_key) && (
                            <div className="composer-task-card-template">
                              {task.generation_template ? `${task.generation_template.name} ${task.generation_template.version}` : '模板生成'}
                              {task.selected_agent_plan_key ? ` · 方案 ${task.selected_agent_plan_key}` : ''}
                              {task.prompt_user_edited ? ' · 已编辑' : ''}
                            </div>
                          )}
                          <div className="composer-task-card-meta">
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
                              {task.local_status === 'submitted' ? '排队中' :
                                task.local_status === 'running' ? '生成中' :
                                task.local_status === 'succeeded' ? '已完成' :
                                task.local_status === 'failed' ? '失败' : task.local_status}
                            </span>
                          </div>
                        </div>
                      </Link>
                      {enhanceTask ? (
                        <Link
                          href={taskDetailHref(task.id, surfaceConfig.routePath)}
                          className="composer-task-card-reuse composer-task-card-reuse-link"
                        >
                          查看超分结果
                        </Link>
                      ) : (
                        <button
                          type="button"
                          className="composer-task-card-reuse"
                          disabled={reuseLoading}
                          onClick={() => loadReusableTask(task.id)}
                        >
                          {reusingTaskId === task.id ? '回填中...' : '重新生成'}
                        </button>
                      )}
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
