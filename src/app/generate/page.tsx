'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { GenerationMode, VideoRatio, VideoDuration, VideoResolution, AssetCollection } from '@/types';
import { GenerationComposer } from '@/components/GenerationComposer';
import { useComposerHeight } from '@/lib/context/ComposerHeightContext';

// ============================================================================
// Types
// ============================================================================

interface CreateResponse {
  id: string;
  provider_task_id: string;
  status: string;
  created_at: string;
  prompt_rendered?: string;
}

interface TaskItem {
  id: string;
  prompt: string;
  local_status: string;
  created_at: string;
}

// ============================================================================
// Component
// ============================================================================

export default function GeneratePage() {
  const { composerHeight } = useComposerHeight();
  // ---- Collections ----
  const [collections, setCollections] = useState<AssetCollection[]>([]);

  // ---- Submit State ----
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorDebug, setErrorDebug] = useState<object | null>(null);

  // ---- Recent Tasks ----
  const [recentTasks, setRecentTasks] = useState<TaskItem[]>([]);
  const [showDebug, setShowDebug] = useState(false);

  // ============================================================================
  // Load collections
  // ============================================================================

  useEffect(() => {
    fetch('/api/collections')
      .then((r) => r.json())
      .then((d) => setCollections(d.collections || []))
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
  }) => {
    setSubmitting(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch('/api/video/create', {
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
          // workspace assets 完全由 route.ts 自动注入
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setErrorDebug(data._debug || null);
        throw new Error(data.message || data.error || `创建失败 (HTTP ${res.status})`);
      }

      setResult(data);
      setErrorDebug(null);
    } catch (err) {
      // errorDebug 已在上面的 !res.ok 分支设置好了
    } finally {
      setSubmitting(false);
    }
  }, []);

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

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <div className="composer-page">
      {/* ===== 顶部导航栏 ===== */}
      <header className="composer-topbar">
        <div className="composer-topbar-left">
          <span className="composer-topbar-logo">Seedance 2.0</span>
          <nav className="composer-topbar-nav">
            <button className="composer-topbar-nav-btn active">创建视频</button>
            <button className="composer-topbar-nav-btn">素材库</button>
            <Link href="/tasks" className="composer-topbar-nav-btn">历史任务</Link>
            <Link href="/config" className="composer-topbar-nav-btn">设置</Link>
          </nav>
        </div>
        <div className="composer-topbar-right">
          <button
            className="composer-topbar-icon-btn"
            onClick={() => setShowDebug(!showDebug)}
            title="调试"
          >
            🐛
          </button>
        </div>
      </header>

      {/* ===== 页面主体 ===== */}
      <main className="composer-main" style={{ paddingBottom: composerHeight + 56 }}>

        {/* Hero 空状态 */}
        <div className="composer-hero">
          <h1 className="composer-hero-title">
            用 AI 生成你的<span>视频</span>
          </h1>
          <p className="composer-hero-sub">
            上传参考图，描述你想生成的画面，Seedance 2.0 帮你实现
          </p>
        </div>

        {/* 调试区 */}
        {showDebug && (
          <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: 16, marginBottom: 40, fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
            <div style={{ fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: 8 }}>调试信息</div>
            <div>最近任务数：{recentTasks.length}</div>
            <div>图集数：{collections.length}</div>
          </div>
        )}

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

      {/* ===== 固定底部 Composer ===== */}
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
        onReset={handleReset}
      />
    </div>
  );
}
