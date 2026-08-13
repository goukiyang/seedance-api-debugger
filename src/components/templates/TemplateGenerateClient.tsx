'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Check, ChevronDown, Folder, Plus } from 'lucide-react';
import type { AssetCollection, GenerationMode, VideoDuration, VideoRatio, VideoResolution } from '@/types';
import { GenerationComposer } from '@/components/GenerationComposer';
import type { AccountMenuUser } from '@/components/AccountMenu';
import ComposerTopbar from '@/components/ComposerTopbar';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { formatProviderUsdCharge } from '@/lib/costs/currency';
import { readJsonResponse } from '@/lib/http/json-response';
import { taskDetailHref } from '@/lib/navigation/return-to';

type TemplateGenerateUser = AccountMenuUser & { id: string };

type CreateResponse = {
  id: string;
  provider_task_id: string;
  status: string;
  created_at: string;
  project_id?: string;
  video_card_id?: string;
  template_id?: string | null;
  agent_run_id?: string | null;
  selected_agent_plan_key?: string | null;
  prompt_rendered?: string;
  reference_image_notice?: string | null;
};

type CreateTaskResponse = CreateResponse & {
  error?: string;
  message?: string;
  _debug?: object | null;
};

type CreditSummary = {
  balance: number;
  frozen_credits: number;
  available: number;
  monthly_used: number;
  total_used: number;
};

type ProjectOption = {
  id: string;
  name: string;
  type: string;
  owner_user_id: string;
  my_role: string | null;
  can_generate?: boolean;
  can_manage_project?: boolean;
  owner?: { id?: string; name: string | null; username: string | null; email?: string | null; avatar_url?: string | null; account_type?: string | null };
  _count?: { tasks: number; reference_albums?: number };
};

type VideoCardOption = {
  id: string;
  project_id: string;
  title: string;
  objective: string | null;
  status: string;
  summary?: { task_count: number; charged_credits: number } | null;
};

type TaskItem = {
  id: string;
  prompt: string;
  local_status: string;
  public_video_url: string | null;
  result_video_url: string | null;
  result_last_frame_url: string | null;
  local_video_path: string | null;
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
};

type TaskPreviewModel = {
  kind: 'image' | 'empty';
  src?: string;
};

const PROJECT_STORAGE_KEY = 'template_generate_project_id';
const VIDEO_CARD_STORAGE_KEY = 'template_generate_video_card_by_project_v1';
const RECENT_TASK_PAGE_SIZE = 12;
const MAX_ACTIVE_POLLING_TASKS = 12;
const POLLABLE_TASK_STATUSES = new Set(['submitted', 'running']);

function projectDisplayName(project: ProjectOption): string {
  return project.type === 'personal' ? '个人空间' : project.name;
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

function formatRecentTaskChargeText(chargeText: string): string {
  return chargeText.replace(/\s*USD(?=（|$)/g, '');
}

function collectPollableTaskIds(tasks: Pick<TaskItem, 'id' | 'local_status'>[]): string[] {
  return tasks
    .filter((task) => task.id && POLLABLE_TASK_STATUSES.has(task.local_status))
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

function formatRecentTaskTime(dateStr: string): string {
  const date = new Date(dateStr);
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return date.toLocaleDateString('zh-CN');
}

function formatAbsoluteTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function truncatePrompt(prompt: string, maxLen = 64): string {
  const clean = prompt.replace(/\s+/g, ' ').trim();
  return clean.length > maxLen ? `${clean.slice(0, maxLen)}...` : clean;
}

function getRecentTaskPreview(task: TaskItem, failedSrcs: string[] = []): TaskPreviewModel {
  const thumbnailSrc = `/api/video/thumbnail/${task.id}`;
  const hasThumbnailSource = Boolean(task.local_video_path || task.public_video_url || task.result_video_url || task.result_last_frame_url);
  if (hasThumbnailSource && !failedSrcs.includes(thumbnailSrc)) return { kind: 'image', src: thumbnailSrc };
  return { kind: 'empty' };
}

function readRememberedVideoCards(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(VIDEO_CARD_STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

function rememberVideoCard(projectId: string, videoCardId: string) {
  if (typeof window === 'undefined' || !projectId || !videoCardId) return;
  window.localStorage.setItem(VIDEO_CARD_STORAGE_KEY, JSON.stringify({
    ...readRememberedVideoCards(),
    [projectId]: videoCardId,
  }));
}

function TemplateTaskPreview({ task }: { task: TaskItem }) {
  const [failedSrcs, setFailedSrcs] = useState<string[]>([]);
  const preview = getRecentTaskPreview(task, failedSrcs);
  return (
    <div className={`composer-task-card-preview composer-task-card-preview-${preview.kind}`}>
      {preview.kind === 'image' && preview.src ? (
        <img
          src={preview.src}
          alt="任务截图"
          loading="lazy"
          onError={() => setFailedSrcs((current) => preview.src && !current.includes(preview.src) ? [...current, preview.src] : current)}
        />
      ) : (
        <span>暂无截图</span>
      )}
    </div>
  );
}

export function TemplateGenerateClient() {
  const searchParams = useSearchParams();
  const projectPickerRef = useRef<HTMLDivElement | null>(null);
  const recentTasksSentinelRef = useRef<HTMLDivElement | null>(null);
  const recentTasksLoadingRef = useRef(false);
  const recentTasksPageRef = useRef(0);
  const recentTasksHasMoreRef = useRef(false);

  const [currentUser, setCurrentUser] = useState<TemplateGenerateUser | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);
  const [credits, setCredits] = useState<CreditSummary | null>(null);
  const [collections, setCollections] = useState<AssetCollection[]>([]);

  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectCreateOpen, setProjectCreateOpen] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectMessage, setProjectMessage] = useState<{ type: 'info' | 'error' | 'success'; text: string } | null>(null);

  const [videoCards, setVideoCards] = useState<VideoCardOption[]>([]);
  const [selectedVideoCardId, setSelectedVideoCardId] = useState('');
  const [loadingVideoCards, setLoadingVideoCards] = useState(false);
  const [videoCardTitle, setVideoCardTitle] = useState('');
  const [videoCardObjective, setVideoCardObjective] = useState('');
  const [videoCardBusy, setVideoCardBusy] = useState(false);
  const [videoCardMessage, setVideoCardMessage] = useState<{ type: 'info' | 'error' | 'success'; text: string } | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorDebug, setErrorDebug] = useState<object | null>(null);
  const [polledResult, setPolledResult] = useState<{
    id: string;
    local_status: string;
    provider_status: string | null;
    result_video_url: string | null;
    error_message: string | null;
    provider_cost_currency: string | null;
    provider_official_amount_minor: number | null;
    provider_final_amount_minor: number | null;
    provider_official_amount_micros: number | null;
    provider_final_amount_micros: number | null;
  } | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [activePollingTaskIds, setActivePollingTaskIds] = useState<string[]>([]);

  const [recentTasks, setRecentTasks] = useState<TaskItem[]>([]);
  const [recentTasksPage, setRecentTasksPage] = useState(0);
  const [recentTasksHasMore, setRecentTasksHasMore] = useState(false);
  const [recentTasksLoadingInitial, setRecentTasksLoadingInitial] = useState(true);
  const [recentTasksLoadingMore, setRecentTasksLoadingMore] = useState(false);
  const [recentTasksError, setRecentTasksError] = useState('');

  const projectNameCounts = useMemo(() => {
    return projects.reduce<Record<string, number>>((acc, project) => {
      const name = projectDisplayName(project);
      acc[name] = (acc[name] || 0) + 1;
      return acc;
    }, {});
  }, [projects]);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) || null;
  const selectedVideoCard = videoCards.find((card) => card.id === selectedVideoCardId) || null;
  const selectedProjectLabel = selectedProject
    ? projectDisplayName(selectedProject)
    : loadingProjects ? '正在加载项目...' : '暂无可生成项目';
  const selectedProjectMeta = selectedProject
    ? projectMetaLabel(selectedProject)
    : '新建项目后才能保存模板生成任务。';
  const initialTemplateId = searchParams.get('templateId') || searchParams.get('template_id') || null;
  const templateReturnTo = initialTemplateId ? `/template-generate?templateId=${encodeURIComponent(initialTemplateId)}` : '/template-generate';
  const scopeSummaryText = selectedVideoCard
    ? `保存到 ${selectedProjectLabel} / ${selectedVideoCard.title}`
    : selectedProject
      ? `保存到 ${selectedProjectLabel}，提交时自动创建视频卡`
      : selectedProjectLabel;

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data: { user: TemplateGenerateUser | null }) => {
        if (!cancelled) setCurrentUser(data.user || null);
      })
      .catch(() => {
        if (!cancelled) setCurrentUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingUser(false);
      });

    fetch('/api/me/credits')
      .then((response) => {
        if (response.status === 401) {
          window.location.href = '/login?next=/template-generate';
          return null;
        }
        return response.json();
      })
      .then((data) => {
        if (!cancelled && data) setCredits(data);
      })
      .catch(() => {});

    fetch('/api/collections')
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) setCollections(data.collections || []);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  const loadProjects = useCallback(async (preferredProjectId?: string | null) => {
    setLoadingProjects(true);
    try {
      const response = await fetch('/api/projects', { cache: 'no-store' });
      if (response.status === 401) {
        window.location.href = '/login?next=/template-generate';
        return;
      }
      const data = await readJsonResponse<{ projects?: ProjectOption[] }>(response);
      const list: ProjectOption[] = (data.projects || []).filter((project: ProjectOption) => project.can_generate !== false);
      setProjects(list);
      const requestedProjectId = new URLSearchParams(window.location.search).get('project_id');
      const rememberedProjectId = window.localStorage.getItem(PROJECT_STORAGE_KEY);
      const preferredId = preferredProjectId || requestedProjectId || rememberedProjectId || '';
      const nextProject = (preferredId ? list.find((project) => project.id === preferredId) : null)
        || list.find((project) => project.type === 'personal')
        || list[0]
        || null;
      setSelectedProjectId(nextProject?.id || '');
    } catch {
      setProjectMessage({ type: 'error', text: '项目列表加载失败，请刷新后重试' });
    } finally {
      setLoadingProjects(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (!selectedProjectId) return;
    window.localStorage.setItem(PROJECT_STORAGE_KEY, selectedProjectId);
  }, [selectedProjectId]);

  const loadVideoCards = useCallback(async (projectId: string, preferredVideoCardId?: string | null) => {
    if (!projectId) {
      setVideoCards([]);
      setSelectedVideoCardId('');
      return;
    }
    setLoadingVideoCards(true);
    setVideoCardMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/video-cards`, { cache: 'no-store' });
      const data = await readJsonResponse<{ video_cards?: VideoCardOption[]; error?: string; message?: string }>(response);
      if (!response.ok) throw new Error(data.message || data.error || '视频卡列表加载失败');
      const list: VideoCardOption[] = data.video_cards || [];
      setVideoCards(list);
      const requestedVideoCardId = new URLSearchParams(window.location.search).get('video_card_id');
      const rememberedVideoCardId = readRememberedVideoCards()[projectId] || '';
      const preferredId = preferredVideoCardId || requestedVideoCardId || rememberedVideoCardId || '';
      const nextCard = (preferredId ? list.find((card) => card.id === preferredId) : null)
        || list.find((card) => card.status !== 'sealed' && card.status !== 'archived')
        || list[0]
        || null;
      setSelectedVideoCardId(nextCard?.id || '');
    } catch (error) {
      setVideoCards([]);
      setSelectedVideoCardId('');
      setVideoCardMessage({ type: 'error', text: error instanceof Error ? error.message : '视频卡列表加载失败' });
    } finally {
      setLoadingVideoCards(false);
    }
  }, []);

  useEffect(() => {
    void loadVideoCards(selectedProjectId);
  }, [loadVideoCards, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId || !selectedVideoCardId) return;
    rememberVideoCard(selectedProjectId, selectedVideoCardId);
  }, [selectedProjectId, selectedVideoCardId]);

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

  const loadRecentTasksPage = useCallback(async (page: number, mode: 'replace' | 'append') => {
    if (recentTasksLoadingRef.current) return;
    recentTasksLoadingRef.current = true;
    if (mode === 'replace') setRecentTasksLoadingInitial(true);
    if (mode === 'append') setRecentTasksLoadingMore(true);
    setRecentTasksError('');
    try {
      const response = await fetch(`/api/video/list?page=${page}&limit=${RECENT_TASK_PAGE_SIZE}`, { cache: 'no-store' });
      if (response.status === 401) {
        window.location.href = '/login?next=/template-generate';
        return;
      }
      const data = await readJsonResponse<{
        tasks?: TaskItem[];
        pagination?: { page?: number; total_pages?: number };
        error?: string;
        message?: string;
      }>(response);
      if (!response.ok) throw new Error(data.message || data.error || '最近任务加载失败');
      const tasks = Array.isArray(data.tasks) ? data.tasks as TaskItem[] : [];
      const pagination = data.pagination || {};
      const currentPage = Number(pagination.page || page);
      const totalPages = Number(pagination.total_pages || currentPage);
      const hasMore = currentPage < totalPages;
      const pollableTaskIds = collectPollableTaskIds(tasks);
      setRecentTasks((current) => mode === 'append' ? [...current, ...tasks.filter((task) => !current.some((item) => item.id === task.id))] : tasks);
      setRecentTasksPage(currentPage);
      setRecentTasksHasMore(hasMore);
      recentTasksPageRef.current = currentPage;
      recentTasksHasMoreRef.current = hasMore;
      if (pollableTaskIds.length > 0) {
        setActivePollingTaskIds((current) => mergePollingTaskIds(pollableTaskIds, current));
      }
    } catch (error) {
      setRecentTasksError(error instanceof Error ? error.message : '最近任务加载失败');
    } finally {
      recentTasksLoadingRef.current = false;
      setRecentTasksLoadingInitial(false);
      setRecentTasksLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    void loadRecentTasksPage(1, 'replace');
  }, [loadRecentTasksPage]);

  const loadMoreRecentTasks = useCallback(() => {
    if (recentTasksLoadingRef.current || !recentTasksHasMoreRef.current) return;
    void loadRecentTasksPage(recentTasksPageRef.current + 1, 'append');
  }, [loadRecentTasksPage]);

  useEffect(() => {
    const sentinel = recentTasksSentinelRef.current;
    if (!sentinel || !recentTasksHasMore || recentTasksLoadingInitial || recentTasksLoadingMore) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMoreRecentTasks();
    }, { rootMargin: '280px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMoreRecentTasks, recentTasksHasMore, recentTasksLoadingInitial, recentTasksLoadingMore]);

  useEffect(() => {
    if (activePollingTaskIds.length === 0) return;
    let cancelled = false;
    setIsPolling(true);
    const tick = async () => {
      try {
        const settled: string[] = [];
        for (const taskId of activePollingTaskIds) {
          const response = await fetch(`/api/video/status/${taskId}?refresh=true`);
          if (!response.ok) continue;
          const data = await response.json();
          if (cancelled) return;
          const task = data.task || data;
          setPolledResult(task);
          setRecentTasks((current) => current.map((item) => item.id === taskId ? { ...item, ...task } : item));
          if (['succeeded', 'failed', 'cancelled'].includes(task.local_status)) settled.push(taskId);
        }
        if (settled.length > 0) {
          setActivePollingTaskIds((current) => current.filter((id) => !settled.includes(id)));
          void loadRecentTasksPage(1, 'replace');
        }
      } finally {
        if (!cancelled) setIsPolling(false);
      }
    };
    void tick();
    const timer = window.setInterval(tick, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activePollingTaskIds, loadRecentTasksPage]);

  const handleCreateProject = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!projectName.trim()) return;
    setProjectBusy(true);
    setProjectMessage(null);
    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: projectName.trim() }),
      });
      const data = await readJsonResponse<{ project?: ProjectOption; error?: string; message?: string }>(response);
      if (!response.ok) throw new Error(data.message || data.error || '项目创建失败');
      setProjectName('');
      setProjectCreateOpen(false);
      setProjectPickerOpen(false);
      setProjectMessage({ type: 'success', text: '项目已创建' });
      await loadProjects(data.project?.id || null);
    } catch (error) {
      setProjectMessage({ type: 'error', text: error instanceof Error ? error.message : '项目创建失败' });
    } finally {
      setProjectBusy(false);
    }
  }, [loadProjects, projectName]);

  const handleCreateVideoCard = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedProjectId || !videoCardTitle.trim()) return;
    setVideoCardBusy(true);
    setVideoCardMessage(null);
    try {
      const response = await fetch(`/api/projects/${selectedProjectId}/video-cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: videoCardTitle.trim(), objective: videoCardObjective.trim() || null }),
      });
      const data = await readJsonResponse<{ video_card?: VideoCardOption; error?: string; message?: string }>(response);
      if (!response.ok) throw new Error(data.message || data.error || '视频卡创建失败');
      setVideoCardTitle('');
      setVideoCardObjective('');
      setVideoCardMessage({ type: 'success', text: '视频卡已创建' });
      await loadVideoCards(selectedProjectId, data.video_card?.id || null);
    } catch (error) {
      setVideoCardMessage({ type: 'error', text: error instanceof Error ? error.message : '视频卡创建失败' });
    } finally {
      setVideoCardBusy(false);
    }
  }, [loadVideoCards, selectedProjectId, videoCardObjective, videoCardTitle]);

  const ensureVideoCardForSubmit = useCallback(async () => {
    const selectedCard = videoCards.find((card) => card.id === selectedVideoCardId) || null;
    if (selectedCard) return selectedCard;
    if (!selectedProjectId) throw new Error('请先选择项目');

    setVideoCardBusy(true);
    setVideoCardMessage(null);
    try {
      const dateLabel = new Date().toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
      const response = await fetch(`/api/projects/${selectedProjectId}/video-cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: videoCardTitle.trim() || `模板生成 ${dateLabel}`,
          objective: videoCardObjective.trim() || '模板生成自动创建的视频卡',
        }),
      });
      const data = await readJsonResponse<{ video_card?: VideoCardOption; error?: string; message?: string }>(response);
      if (!response.ok) throw new Error(data.message || data.error || '视频卡创建失败');
      const createdCard = data.video_card as VideoCardOption | undefined;
      if (!createdCard?.id) throw new Error('视频卡创建成功但没有返回 ID');
      setVideoCards((current) => [createdCard, ...current.filter((card) => card.id !== createdCard.id)]);
      setSelectedVideoCardId(createdCard.id);
      rememberVideoCard(selectedProjectId, createdCard.id);
      setVideoCardTitle('');
      setVideoCardObjective('');
      setVideoCardMessage({ type: 'success', text: '已自动创建视频卡并保存本次生成' });
      return createdCard;
    } finally {
      setVideoCardBusy(false);
    }
  }, [selectedProjectId, selectedVideoCardId, videoCardObjective, videoCardTitle, videoCards]);

  const handleCollectionLoad = useCallback(async (collectionId: string) => {
    await fetch(`/api/collections/${collectionId}/load`, {
      method: 'POST',
      headers: { 'x-tab-id': sessionStorage.getItem('workspace_tab_id') || 'default' },
    });
  }, []);

  const handleCollectionSave = useCallback(async (name: string) => {
    const response = await fetch('/api/collections', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tab-id': sessionStorage.getItem('workspace_tab_id') || 'default',
      },
      body: JSON.stringify({ name }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '图集保存失败');
    setCollections((current) => [data.collection, ...current]);
  }, []);

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
  }) => {
    setSubmitting(true);
    setError(null);
    setResult(null);
    let selectedCard: VideoCardOption | null = null;
    try {
      selectedCard = await ensureVideoCardForSubmit();
    } catch (ensureError) {
      setError(ensureError instanceof Error ? ensureError.message : '请先选择项目和视频卡');
      setSubmitting(false);
      return;
    }
    if (!selectedCard) {
      setError('请先选择项目和视频卡');
      setSubmitting(false);
      return;
    }
    if (selectedCard.status === 'sealed' || selectedCard.status === 'archived') {
      setError('当前视频卡已封板或归档，不能继续生成');
      setSubmitting(false);
      return;
    }

    try {
      const response = await fetch('/api/tasks/create', {
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
          idempotency_key: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          project_id: selectedProjectId,
          video_card_id: selectedCard.id,
          reference_image_ids: params.referenceImageIds || [],
          reference_video_urls: params.referenceVideoUrls || [],
          reference_audio_urls: params.referenceAudioUrls || [],
          template_id: params.templateId || null,
          agent_run_id: params.agentRunId || null,
          selected_agent_plan_key: params.selectedAgentPlanKey || null,
          agent_prompt_snapshot: params.agentPromptSnapshot || null,
          final_prompt_snapshot: params.finalPromptSnapshot || params.prompt,
          prompt_user_edited: params.promptUserEdited === true,
        }),
      });
      const data = await readJsonResponse<CreateTaskResponse>(response);
      if (!response.ok) {
        setErrorDebug(data._debug || null);
        throw new Error(data.message || data.error || `创建失败 (HTTP ${response.status})`);
      }
      setResult(data);
      setErrorDebug(null);
      setPolledResult(null);
      setActivePollingTaskIds((current) => [data.id, ...current.filter((id) => id !== data.id)].slice(0, MAX_ACTIVE_POLLING_TASKS));
      setRecentTasks((current) => [
        {
          id: data.id,
          prompt: params.prompt,
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
          video_card_id: data.video_card_id || selectedCard.id,
          template_id: data.template_id || params.templateId || null,
          agent_run_id: data.agent_run_id || params.agentRunId || null,
          selected_agent_plan_key: data.selected_agent_plan_key || params.selectedAgentPlanKey || null,
          prompt_user_edited: params.promptUserEdited === true,
          generation_template: null,
          video_card: {
            id: selectedCard.id,
            title: selectedCard.title,
            objective: selectedCard.objective,
            status: selectedCard.status,
            project_id: selectedCard.project_id,
          },
          created_at: data.created_at,
        },
        ...current.filter((task) => task.id !== data.id),
      ]);
      fetch('/api/me/credits')
        .then((response) => response.ok ? response.json() : null)
        .then((data) => { if (data) setCredits(data); })
        .catch(() => {});
    } catch (error) {
      if (error instanceof Error) setError(error.message);
    } finally {
      setSubmitting(false);
    }
  }, [ensureVideoCardForSubmit, selectedProjectId]);

  const showRecentTaskSurface = recentTasksLoadingInitial || recentTasks.length > 0 || Boolean(recentTasksError);

  return (
    <div className="composer-page template-generate-page">
      <ComposerTopbar user={currentUser} loadingUser={loadingUser} credits={credits} />
      <main className="composer-main template-generate-main">
        <section className="template-generate-hero" aria-label="模板生成工作台">
          <div>
            <span className="template-generate-kicker">模板生成</span>
            <h1>模板生成工作台</h1>
            <p>模板固定角色、标志、素材和规则，你只输入本次需求并选择方案。</p>
          </div>
          <div className="template-generate-hero-actions">
            <Link href="/templates">返回模板库</Link>
            <Link href="/projects">查看我的项目</Link>
            {currentUser?.role === 'admin' && <Link href="/admin/agent-runs">执行链路</Link>}
          </div>
        </section>

        <details className="template-generate-advanced-scope">
          <summary>
            <div>
              <span>保存位置</span>
              <strong>{scopeSummaryText}</strong>
              <small>系统会默认选择项目和视频卡；需要调整时再展开。</small>
            </div>
          </summary>
          <section className="template-generate-scope" aria-label="保存范围">
          <div className="composer-project-picker" ref={projectPickerRef}>
            <button
              type="button"
              className="composer-project-trigger"
              onClick={() => setProjectPickerOpen((open) => !open)}
              disabled={loadingProjects || projectBusy}
              aria-expanded={projectPickerOpen}
              aria-haspopup="dialog"
            >
              <span className="composer-project-trigger-icon" aria-hidden="true"><Folder size={16} /></span>
              <span className="composer-project-trigger-copy">
                <span className="composer-project-trigger-label">保存到 / 当前项目</span>
                <span className="composer-project-trigger-name">{selectedProjectLabel}</span>
                <span className="composer-project-trigger-meta">{selectedProjectMeta}</span>
                {selectedProject && (
                  <span className="composer-project-trigger-owner">
                    <UserIdentityBadge user={projectOwnerUser(selectedProject)} size="sm" />
                  </span>
                )}
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
                    onClick={() => setProjectCreateOpen((open) => !open)}
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
                      onChange={(event) => setProjectName(event.currentTarget.value)}
                      placeholder="输入项目名称"
                      maxLength={40}
                      autoFocus
                    />
                    <button type="submit" className="composer-project-btn composer-project-btn-primary" disabled={projectBusy}>
                      {projectBusy ? '创建中...' : '创建'}
                    </button>
                  </form>
                )}
                <div className="composer-project-list" role="listbox" aria-label="选择保存项目">
                  {loadingProjects ? (
                    <div className="composer-project-list-empty">正在加载项目...</div>
                  ) : projects.length === 0 ? (
                    <div className="composer-project-list-empty">暂无可生成项目，先新建一个项目。</div>
                  ) : projects.map((project) => {
                    const duplicateName = projectNameCounts[projectDisplayName(project)] > 1;
                    const isSelected = project.id === selectedProjectId;
                    return (
                      <button
                        key={project.id}
                        type="button"
                        className={['composer-project-option', isSelected ? 'active' : ''].filter(Boolean).join(' ')}
                        onClick={() => {
                          setSelectedProjectId(project.id);
                          setProjectPickerOpen(false);
                          setProjectCreateOpen(false);
                          setProjectMessage(null);
                        }}
                      >
                        <span className="composer-project-option-mark" aria-hidden="true">
                          {isSelected ? <Check size={16} /> : <Folder size={16} />}
                        </span>
                        <span className="composer-project-option-copy">
                          <span className="composer-project-option-name">{projectDisplayName(project)}</span>
                          <span className="composer-project-option-meta">{projectMetaLabel(project)}</span>
                          {duplicateName && (
                            <span className="composer-project-option-owner">
                              <UserIdentityBadge user={projectOwnerUser(project)} size="sm" />
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="template-generate-video-card">
            <div className="template-generate-video-card-picker">
              <span>视频卡</span>
              <div className="template-video-card-list" role="listbox" aria-label="选择视频卡">
                {loadingVideoCards ? (
                  <span className="template-video-card-empty">正在加载视频卡...</span>
                ) : videoCards.length === 0 ? (
                  <span className="template-video-card-empty">当前项目暂无视频卡</span>
                ) : videoCards.map((card) => {
                  const disabled = card.status === 'sealed' || card.status === 'archived' || videoCardBusy;
                  const selected = card.id === selectedVideoCardId;
                  return (
                    <button
                      key={card.id}
                      type="button"
                      className={selected ? 'is-active' : ''}
                      onClick={() => {
                        if (disabled) return;
                        setSelectedVideoCardId(card.id);
                      }}
                      disabled={disabled}
                      aria-selected={selected}
                      role="option"
                    >
                      <strong>{card.title}</strong>
                      <span>
                        {card.summary ? `${card.summary.task_count} 次生成` : '暂无生成'}
                        {disabled ? ' · 不可继续生成' : ''}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            {selectedVideoCard && (
              <Link href={`/projects/${selectedVideoCard.project_id || selectedProjectId}/video-cards/${selectedVideoCard.id}`}>查看视频卡</Link>
            )}
            <form onSubmit={handleCreateVideoCard}>
              <input
                value={videoCardTitle}
                onChange={(event) => setVideoCardTitle(event.currentTarget.value)}
                placeholder="新视频卡标题"
                maxLength={80}
                disabled={!selectedProjectId || videoCardBusy}
              />
              <input
                value={videoCardObjective}
                onChange={(event) => setVideoCardObjective(event.currentTarget.value)}
                placeholder="视频目标，可选"
                maxLength={160}
                disabled={!selectedProjectId || videoCardBusy}
              />
              <button type="submit" disabled={!selectedProjectId || videoCardBusy || !videoCardTitle.trim()}>
                {videoCardBusy ? '创建中...' : '创建视频卡'}
              </button>
            </form>
          </div>
          </section>

        {(projectMessage || videoCardMessage) && (
          <div className={`composer-project-message ${(projectMessage || videoCardMessage)?.type || 'info'}`}>
            {(projectMessage || videoCardMessage)?.text}
          </div>
        )}
        </details>

        <GenerationComposer
          collections={collections}
          selectedVideoCardId={selectedVideoCardId}
          canManageTemplates={currentUser?.role === 'admin'}
          templateMode="workbench"
          initialTemplateId={initialTemplateId}
          resultReturnTo={templateReturnTo}
          require1080pApproval={Boolean(selectedProject && selectedProject.type !== 'personal')}
          onCollectionLoad={handleCollectionLoad}
          onCollectionSave={handleCollectionSave}
          onCollectionNew={handleCollectionSave}
          onSubmit={handleSubmit}
          submitError={error}
          submitErrorDebug={errorDebug}
          isSubmitting={submitting}
          result={result}
          polledResult={polledResult}
          isPolling={isPolling}
          onReset={() => {
            setResult(null);
            setError(null);
            setErrorDebug(null);
          }}
        />

        {showRecentTaskSurface && (
          <section className="composer-recent template-generate-recent" aria-label="最近任务">
            <div className="composer-recent-title">最近任务</div>
            {recentTasks.length > 0 && (
              <div className="composer-recent-grid">
                {recentTasks.map((task) => {
                  const chargeText = formatProviderUsdCharge(task);
                  const recentTaskChargeText = chargeText ? formatRecentTaskChargeText(chargeText) : null;
                  return (
                    <article key={task.id} className="composer-task-card">
                      <Link href={taskDetailHref(task.id, '/template-generate')} className="composer-task-card-link">
                        <TemplateTaskPreview task={task} />
                        <div className="composer-task-card-body">
                          <div className="composer-task-card-prompt" title={`${formatAbsoluteTime(task.created_at)} · ${task.prompt}`}>
                            <time className="composer-task-card-prompt-time" dateTime={task.created_at}>
                              {formatRecentTaskTime(task.created_at)}
                            </time>
                            <span className="composer-task-card-prompt-text">{truncatePrompt(task.prompt)}</span>
                          </div>
                          <div className="composer-task-card-video-card">
                            {task.video_card ? task.video_card.title : '未归档视频卡'}
                          </div>
                          <div className="composer-task-card-template">
                            {task.generation_template ? `${task.generation_template.name} ${task.generation_template.version}` : '模板生成'}
                            {task.selected_agent_plan_key ? ` · 方案 ${task.selected_agent_plan_key}` : ''}
                            {task.prompt_user_edited ? ' · 已编辑' : ''}
                          </div>
                          <div className="composer-task-card-meta">
                            {recentTaskChargeText && <span className="composer-task-card-charge">{recentTaskChargeText}</span>}
                            <span className={`composer-task-card-status ${task.local_status}`}>
                              {task.local_status === 'submitted' ? '排队中'
                                : task.local_status === 'running' ? '生成中'
                                  : task.local_status === 'succeeded' ? '已完成'
                                    : task.local_status === 'failed' ? '失败'
                                      : task.local_status}
                            </span>
                          </div>
                        </div>
                      </Link>
                      {currentUser?.role === 'admin' && task.agent_run_id && (
                        <Link className="composer-task-card-trace" href={`/admin/agent-runs/${task.agent_run_id}`}>
                          查看链路
                        </Link>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
            <div ref={recentTasksSentinelRef} className="composer-recent-sentinel" aria-hidden="true" />
            <div className="composer-recent-footer">
              {recentTasks.length > 0 && <span className="composer-recent-count">已显示 {recentTasks.length} 条{recentTasksPage > 0 ? ` · 第 ${recentTasksPage} 页` : ''}</span>}
              {recentTasksLoadingInitial && <span className="composer-recent-loading">正在加载最近任务...</span>}
              {!recentTasksLoadingInitial && recentTasksError && (
                <span className="composer-recent-error">
                  <span>{recentTasksError}</span>
                  <button type="button" onClick={() => loadRecentTasksPage(1, 'replace')}>重试</button>
                </span>
              )}
              {!recentTasksLoadingInitial && !recentTasksError && recentTasksLoadingMore && <span className="composer-recent-loading">正在加载更多任务...</span>}
              {!recentTasksLoadingInitial && !recentTasksError && !recentTasksLoadingMore && recentTasksHasMore && (
                <button type="button" className="composer-recent-load-more" onClick={loadMoreRecentTasks}>加载更多</button>
              )}
              {!recentTasksLoadingInitial && !recentTasksError && !recentTasksLoadingMore && !recentTasksHasMore && recentTasks.length > 0 && (
                <span className="composer-recent-done">已加载全部最近任务</span>
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
