'use client';

import { useState, useEffect, useCallback, useRef, type FormEvent } from 'react';
import Link from 'next/link';
import { Archive, Check, ChevronDown, Folder, Plus, Trash2 } from 'lucide-react';
import type { GenerationMode, VideoRatio, VideoDuration, VideoResolution, AssetCollection } from '@/types';
import { GenerationComposer } from '@/components/GenerationComposer';
import type { AccountMenuUser } from '@/components/AccountMenu';
import ComposerTopbar from '@/components/ComposerTopbar';

// ============================================================================
// Types
// ============================================================================

interface CreateResponse {
  id: string;
  provider_task_id: string;
  status: string;
  created_at: string;
  prompt_rendered?: string;
  estimated_cost?: number;
  frozen_cost?: number;
  deduplicated?: boolean;
}

interface TaskItem {
  id: string;
  prompt: string;
  local_status: string;
  result_video_url: string | null;
  result_last_frame_url: string | null;
  local_video_path: string | null;
  created_at: string;
}

interface PolledTask {
  id: string;
  local_status: string;
  provider_status: string | null;
  result_video_url: string | null;
  error_message: string | null;
}

interface CreditSummary {
  balance: number;
  frozen_credits: number;
  available: number;
  monthly_used: number;
  total_used: number;
}

interface ProjectOption {
  id: string;
  name: string;
  type: string;
  status?: string;
  owner_user_id: string;
  my_role: string | null;
  can_generate?: boolean;
  can_manage_project?: boolean;
  owner?: { name: string | null; username: string | null };
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
  projectId: string | null;
}

interface AuthMeResponse {
  user: AccountMenuUser | null;
}

const PROJECT_STORAGE_KEY = 'generate_project_id';

function projectOwnerName(project: ProjectOption): string {
  const name = project.owner?.name?.trim();
  const username = project.owner?.username?.trim();
  if (name && username && name !== username) return `${name}（${username}）`;
  return name || username || project.owner_user_id;
}

function projectDisplayName(project: ProjectOption): string {
  if (project.type === 'personal') return '个人空间';
  return project.name;
}

function projectDisplayLabel(project: ProjectOption, hasDuplicateName: boolean): string {
  const name = projectDisplayName(project);
  return hasDuplicateName ? `${name} · ${projectOwnerName(project)}` : name;
}

function projectMetaLabel(project: ProjectOption): string {
  const kind = project.type === 'personal' ? '个人默认' : project.type === 'system' ? '系统项目' : '团队项目';
  const taskCount = project._count?.tasks || 0;
  const albumCount = project._count?.reference_albums || 0;
  return `${kind} · ${taskCount} 任务 · ${albumCount} 图集`;
}

type TaskPreviewModel = {
  kind: 'image' | 'empty';
  src?: string;
  label: string;
};

function getRecentTaskPreview(task: TaskItem, failedSrcs: string[] = []): TaskPreviewModel {
  const thumbnailSrc = `/api/video/thumbnail/${task.id}`;
  const hasThumbnailSource = !!(task.local_video_path || task.result_video_url || task.result_last_frame_url);

  if (hasThumbnailSource && !failedSrcs.includes(thumbnailSrc)) {
    return { kind: 'image', src: thumbnailSrc, label: '视频帧' };
  }

  return { kind: 'empty', label: ['submitted', 'running'].includes(task.local_status) ? '等待视频帧' : '暂无视频帧' };
}

function RecentTaskPreview({ task }: { task: TaskItem }) {
  const [failedSrcs, setFailedSrcs] = useState<string[]>([]);
  const preview = getRecentTaskPreview(task, failedSrcs);
  const markFailed = (src?: string) => {
    if (!src) return;
    setFailedSrcs((current) => current.includes(src) ? current : [...current, src]);
  };

  return (
    <div className={`composer-task-card-preview composer-task-card-preview-${preview.kind}`}>
      {preview.kind === 'image' && preview.src && (
        <img src={preview.src} alt="任务截图" loading="lazy" onError={() => markFailed(preview.src)} />
      )}
      {preview.kind === 'empty' && <span>{preview.label}</span>}
      <small>{preview.label}</small>
    </div>
  );
}

// ============================================================================
// Component
// ============================================================================

export default function GeneratePage() {
  const projectPickerRef = useRef<HTMLDivElement | null>(null);

  // ---- Collections ----
  const [collections, setCollections] = useState<AssetCollection[]>([]);

  // ---- Submit State ----
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorDebug, setErrorDebug] = useState<object | null>(null);

  // ---- Recent Tasks ----
  const [recentTasks, setRecentTasks] = useState<TaskItem[]>([]);

  // ---- Result Polling ----
  const [polledResult, setPolledResult] = useState<PolledTask | null>(null);
  const [isPolling, setIsPolling] = useState(false);

  // ---- Credit Summary ----
  const [credits, setCredits] = useState<CreditSummary | null>(null);
  const [currentUser, setCurrentUser] = useState<AccountMenuUser | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);

  // ---- Current Project ----
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [projectCreateOpen, setProjectCreateOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectMessage, setProjectMessage] = useState<{ type: 'info' | 'error' | 'success'; text: string } | null>(null);
  const [projectConfirmAction, setProjectConfirmAction] = useState<'delete' | 'archive' | null>(null);
  const [reuseDraft, setReuseDraft] = useState<ReuseDraft | null>(null);
  const [reuseMessage, setReuseMessage] = useState('');
  const [reuseLoading, setReuseLoading] = useState(false);
  const [reusingTaskId, setReusingTaskId] = useState<string | null>(null);

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
      const data = await res.json();
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
    setProjectConfirmAction(null);
  }, [selectedProjectId]);

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
        setProjectConfirmAction(null);
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
      const data = await res.json();
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

  const handleProjectRemoval = useCallback(async () => {
    const project = projects.find((item) => item.id === selectedProjectId);
    if (!project) return;

    const hasContent = (project._count?.tasks || 0) > 0 || (project._count?.reference_albums || 0) > 0;
    const action = hasContent ? 'archive' : 'delete';

    if (project.type === 'personal' || project.type === 'system') {
      setProjectMessage({ type: 'error', text: '默认项目不能删除' });
      return;
    }
    if (!project.can_manage_project) {
      setProjectMessage({ type: 'error', text: '你没有权限管理这个项目' });
      return;
    }
    if (projectConfirmAction !== action) {
      setProjectConfirmAction(action);
      setProjectMessage({
        type: 'info',
        text: action === 'archive'
          ? `项目「${projectDisplayName(project)}」已有任务或图集，再点一次归档。归档后历史记录仍保留。`
          : `再点一次删除空项目「${projectDisplayName(project)}」。`,
      });
      return;
    }

    setProjectBusy(true);
    setProjectMessage(null);
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: action === 'archive' ? 'PATCH' : 'DELETE',
        headers: action === 'archive' ? { 'Content-Type': 'application/json' } : undefined,
        body: action === 'archive' ? JSON.stringify({ action: 'archive' }) : undefined,
      });
      const data = await res.json();
      if (!res.ok) {
        if (action === 'delete' && typeof data.error === 'string' && data.error.includes('归档')) {
          setProjectConfirmAction('archive');
          setProjectMessage({
            type: 'info',
            text: '项目已有历史内容，删除会断链；请再次点击归档项目。',
          });
          return;
        }
        throw new Error(data.message || data.error || '项目操作失败');
      }

      setProjectConfirmAction(null);
      setProjectMessage({
        type: 'success',
        text: action === 'archive' ? `已归档项目「${projectDisplayName(project)}」` : `已删除项目「${projectDisplayName(project)}」`,
      });
      await loadProjects({ keepSelected: false });
    } catch (err) {
      setProjectMessage({ type: 'error', text: err instanceof Error ? err.message : '项目操作失败' });
    } finally {
      setProjectBusy(false);
    }
  }, [loadProjects, projectConfirmAction, projects, selectedProjectId]);

  useEffect(() => {
    if (!projectMessage) return;
    if (projectMessage.type === 'error') return;
    const timeoutId = window.setTimeout(() => {
      setProjectMessage(null);
      if (projectMessage.type === 'info') setProjectConfirmAction(null);
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
    setIsPolling(false);

    try {
      const res = await fetch(`/api/tasks/${taskId}/reuse`, {
        method: 'POST',
        headers: {
          'x-tab-id': sessionStorage.getItem('workspace_tab_id') || 'default',
        },
      });
      const data = await res.json();
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
        projectId: data.draft.project_id || null,
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

  useEffect(() => {
    fetch('/api/video/list')
      .then((r) => r.json())
      .then((d) => {
        const tasks: TaskItem[] = (d.tasks || []).slice(0, 6);
        setRecentTasks(tasks);
      })
      .catch(() => {});
  }, []);

  // ============================================================================
  // Result Polling — poll result task until terminal state
  // ============================================================================

  useEffect(() => {
    if (!result?.id) return;

    setIsPolling(true);
    setPolledResult(null);

    let intervalId: ReturnType<typeof setInterval>;
    let pollCount = 0;
    const MAX_POLLS = 120; // ~10 minutes at 5s interval

    const poll = async () => {
      try {
        const res = await fetch(`/api/video/status/${result.id}`);
        if (!res.ok) return;
        const data: PolledTask = await res.json();
        setPolledResult(data);
        pollCount++;

        if (['succeeded', 'failed', 'cancelled'].includes(data.local_status)) {
          clearInterval(intervalId);
          setIsPolling(false);
          // refresh task list so the card shows updated status
          fetch('/api/video/list')
            .then((r) => r.json())
            .then((d) => setRecentTasks((d.tasks || []).slice(0, 6)))
            .catch(() => {});
          // refresh credit display after settlement
          fetch('/api/me/credits')
            .then((r) => r.ok ? r.json() : null)
            .then((d) => { if (d) setCredits(d); })
            .catch(() => {});
        } else if (pollCount >= MAX_POLLS) {
          clearInterval(intervalId);
          setIsPolling(false);
        }
      } catch {
        // non-critical polling error, keep polling
      }
    };

    poll();
    intervalId = setInterval(poll, 5000);

    return () => {
      clearInterval(intervalId);
      setIsPolling(false);
    };
  }, [result?.id]);

  // ============================================================================
  // Submit
  // ============================================================================

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
    referenceImageIds?: string[];
  }) => {
    setSubmitting(true);
    setError(null);
    setResult(null);

    const idempotencyKey = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    try {
      const res = await fetch('/api/tasks/create', {
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
          idempotency_key: idempotencyKey,
          project_id: selectedProjectId || undefined,
          reference_image_ids: params.referenceImageIds || [],
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setErrorDebug(data._debug || null);
        throw new Error(data.message || data.error || `创建失败 (HTTP ${res.status})`);
      }

      setResult(data);
      setErrorDebug(null);

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
  }, [selectedProjectId]);

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
    setPolledResult(null);
    setIsPolling(false);
  }, []);

  // ============================================================================
  // Helpers
  // ============================================================================

  function formatTime(dateStr: string): string {
    try {
      const d = new Date(dateStr);
      const now = new Date();
      const diff = Math.floor((now.getTime() - d.getTime()) / 1000);
      if (diff < 60) return '刚刚';
      if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
      if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
      return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
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
    ? projectDisplayLabel(selectedProject, projectNameCounts[projectDisplayName(selectedProject)] > 1)
    : loadingProjects
      ? '正在加载项目...'
      : '暂无可生成项目';
  const selectedProjectMeta = selectedProject
    ? projectMetaLabel(selectedProject)
    : '新建一个项目后即可保存任务、成本和结果。';
  const selectedProjectHasContent = Boolean(
    (selectedProject?._count?.tasks || 0) > 0 || (selectedProject?._count?.reference_albums || 0) > 0,
  );
  const selectedProjectCanRemove = Boolean(
    selectedProject
    && selectedProject.can_manage_project
    && selectedProject.type !== 'personal'
    && selectedProject.type !== 'system',
  );
  const projectRemovalLabel = selectedProjectHasContent ? '归档项目' : '删除项目';
  const projectRemovalTitle = !selectedProject
    ? '先选择项目'
    : selectedProject.type === 'personal'
      ? '默认项目不能删除'
      : !selectedProject.can_manage_project
        ? '你没有权限管理这个项目'
        : selectedProjectHasContent
          ? '项目已有历史内容，只能归档'
          : '删除空项目';

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <div className="composer-page">
      {/* ===== 顶部导航栏 ===== */}
      <ComposerTopbar user={currentUser} loadingUser={loadingUser} credits={credits} />

      {/* ===== 页面主体 ===== */}
      <main className="composer-main">

        {/* Hero 空状态 */}
        <div className="composer-hero">
          <h1 className="composer-hero-title">
            用 AI 生成你的<span>视频</span>
          </h1>
          <p className="composer-hero-sub">
            上传参考图，描述你想生成的画面，Seedance 2.0 帮你实现
          </p>
          <div className="composer-hero-actions">
            <Link href="/generate/canvas" className="composer-hero-action composer-hero-action-primary">
              进入画布模式
            </Link>
            <Link href="/projects" className="composer-hero-action composer-hero-action-secondary">
              查看我的项目
            </Link>
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
                  <span className="composer-project-trigger-icon" aria-hidden="true">
                    <Folder size={16} />
                  </span>
                  <span className="composer-project-trigger-copy">
                    <span className="composer-project-trigger-label">当前项目</span>
                    <span className="composer-project-trigger-name">{selectedProjectLabel}</span>
                    <span className="composer-project-trigger-meta">{selectedProjectMeta}</span>
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
                          setProjectConfirmAction(null);
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
                          return (
                            <button
                              key={project.id}
                              type="button"
                              role="option"
                              aria-selected={isSelected}
                              className={`composer-project-option${isSelected ? ' active' : ''}`}
                              onClick={() => {
                                setSelectedProjectId(project.id);
                                setProjectPickerOpen(false);
                                setProjectCreateOpen(false);
                                setProjectConfirmAction(null);
                                setProjectMessage(null);
                              }}
                            >
                              <span className="composer-project-option-mark" aria-hidden="true">
                                {isSelected ? <Check size={16} /> : <Folder size={16} />}
                              </span>
                              <span className="composer-project-option-copy">
                                <span className="composer-project-option-name">
                                  {projectDisplayLabel(project, duplicateName)}
                                </span>
                                <span className="composer-project-option-meta">
                                  {projectMetaLabel(project)}
                                </span>
                              </span>
                            </button>
                          );
                        })
                      )}
                    </div>

                    <div className="composer-project-menu-footer">
                      <button
                        type="button"
                        className={`composer-project-menu-danger${projectConfirmAction ? ' confirming' : ''}`}
                        onClick={() => void handleProjectRemoval()}
                        disabled={!selectedProjectCanRemove || projectBusy}
                        title={projectRemovalTitle}
                      >
                        {selectedProjectHasContent ? <Archive size={15} aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}
                        {projectBusy && projectConfirmAction
                          ? '处理中...'
                          : projectConfirmAction === 'archive'
                            ? '确认归档'
                            : projectConfirmAction === 'delete'
                              ? '确认删除'
                              : projectRemovalLabel}
                      </button>
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
        </div>

        {reuseMessage && (
          <div className={`composer-prefill-notice ${reuseLoading ? 'is-loading' : ''}`}>
            {reuseMessage}
          </div>
        )}

        <GenerationComposer
          collections={collections}
          reuseDraft={reuseDraft}
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
        />

        {/* 最近任务 */}
        {recentTasks.length > 0 && (
          <div className="composer-recent">
            <div className="composer-recent-title">最近任务</div>
            <div className="composer-recent-grid">
              {recentTasks.map((task) => (
                <article
                  key={task.id}
                  className="composer-task-card"
                >
                  <Link href={`/tasks/${task.id}`} className="composer-task-card-link">
                    <RecentTaskPreview task={task} />
                    <div className="composer-task-card-body">
                      <div className="composer-task-card-prompt">
                        {truncatePrompt(task.prompt)}
                      </div>
                      <div className="composer-task-card-meta">
                        <span className="composer-task-card-time">{formatTime(task.created_at)}</span>
                        <span className={`composer-task-card-status ${task.local_status}`}>
                          {task.local_status === 'submitted' ? '排队中' :
                           task.local_status === 'running' ? '生成中' :
                           task.local_status === 'succeeded' ? '已完成' :
                           task.local_status === 'failed' ? '失败' : task.local_status}
                        </span>
                      </div>
                    </div>
                  </Link>
                  <button
                    type="button"
                    className="composer-task-card-reuse"
                    disabled={reuseLoading}
                    onClick={() => loadReusableTask(task.id)}
                  >
                    {reusingTaskId === task.id ? '回填中...' : '重新生成'}
                  </button>
                </article>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
