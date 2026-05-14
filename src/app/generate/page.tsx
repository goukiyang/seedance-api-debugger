'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { GenerationMode, VideoRatio, VideoDuration, VideoResolution, AssetCollection } from '@/types';
import { GenerationComposer } from '@/components/GenerationComposer';
import AccountMenu, { type AccountMenuUser } from '@/components/AccountMenu';

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
  owner_user_id: string;
  my_role: string | null;
  can_generate?: boolean;
  owner?: { name: string | null; username: string | null };
  _count?: { tasks: number; reference_albums?: number };
}

interface AuthMeResponse {
  user: AccountMenuUser | null;
}

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

// ============================================================================
// Component
// ============================================================================

export default function GeneratePage() {
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

  useEffect(() => {
    fetch('/api/projects')
      .then((r) => {
        if (r.status === 401) {
          window.location.href = '/login';
          return null;
        }
        return r.json();
      })
      .then((d) => {
        if (!d) return;
        const list: ProjectOption[] = (d.projects || []).filter((project: ProjectOption) => project.can_generate !== false);
        setProjects(list);
        const requestedProjectId = new URLSearchParams(window.location.search).get('project_id');
        const requested = requestedProjectId ? list.find((project) => project.id === requestedProjectId) : null;
        const personal = list.find((project) => project.type === 'personal');
        setSelectedProjectId((requested || personal || list[0])?.id || '');
      })
      .catch(() => {});
  }, []);

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

  function formatCredit(value: number | undefined): string {
    return Math.max(0, Math.floor(value || 0)).toString();
  }

  const projectNameCounts = projects.reduce<Record<string, number>>((counts, project) => {
    const name = projectDisplayName(project);
    counts[name] = (counts[name] || 0) + 1;
    return counts;
  }, {});

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <div className="composer-page">
      {/* ===== 顶部导航栏 ===== */}
      <header className="composer-topbar">
        <div className="composer-topbar-left">
            <Link href="/" className="composer-topbar-logo">Seedance 2.0</Link>
          <nav className="composer-topbar-nav">
            <Link href="/generate" className="composer-topbar-nav-btn active">生成视频</Link>
            <Link href="/projects" className="composer-topbar-nav-btn">我的项目</Link>
            <Link href="/collections" className="composer-topbar-nav-btn">参考图集</Link>
            <Link href="/tasks" className="composer-topbar-nav-btn">我的任务</Link>
          </nav>
        </div>
        <div className="composer-topbar-right">
          {credits && (
            <div
              className="composer-topbar-nav-btn"
              title="当前点数"
            >
              可用 {formatCredit(credits.available)} 点 ｜ 冻结 {formatCredit(credits.frozen_credits)} 点 ｜ 本月已用 {formatCredit(credits.monthly_used)} 点
            </div>
          )}
          <AccountMenu user={currentUser} loading={loadingUser} variant="composer" />
        </div>
      </header>

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
        </div>

        <div style={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: 10,
          marginBottom: 16,
          color: 'rgba(255,255,255,0.62)',
          fontSize: 14,
        }}>
          <span>保存到：</span>
          {projects.length > 0 ? (
            <select
              className="input"
              style={{ width: 260, maxWidth: '100%', padding: '8px 12px' }}
              value={selectedProjectId}
              onChange={(event) => setSelectedProjectId(event.target.value)}
              title="本次生成的任务和结果会写入所选空间"
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {projectDisplayLabel(project, projectNameCounts[projectDisplayName(project)] > 1)}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-red">暂无可生成项目</span>
          )}
        </div>

        <GenerationComposer
          collections={collections}
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
                <Link
                  key={task.id}
                  href={`/tasks/${task.id}`}
                  className="composer-task-card"
                >
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
                </Link>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
