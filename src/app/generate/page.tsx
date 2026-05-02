'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { GenerationMode, VideoRatio, VideoDuration, VideoResolution, AssetCollection } from '@/types';
import type { SelectedReferenceAsset } from '@/components/SeedanceAssetSelector';
import { GenerationComposer } from '@/components/GenerationComposer';
import { SeedanceAssetPanel } from '@/components/SeedanceAssetPanel';
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
  const [submitErrorDebug, setSubmitErrorDebug] = useState<{
    requestIdLocal?: string;
    snapshot_id?: string;
    providerContext?: {
      httpStatus: number;
      source: string;
      code: string;
      providerMessage?: string;
      requestId?: string;
      payloadSummary?: {
        endpoint: string;
        model: string;
        generationMode: string;
        promptLength: number;
        contentItemCount: number;
        referenceImageCount: number;
        referenceImageHosts: string[];
        totalPayloadSizeKb: number;
      };
    };
  } | undefined>(undefined);

  // ---- Recent Tasks ----
  const [recentTasks, setRecentTasks] = useState<TaskItem[]>([]);
  const [showDebug, setShowDebug] = useState(false);
  const [showAssetPanel, setShowAssetPanel] = useState(false);

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
    referenceAssets?: SelectedReferenceAsset[];
  }) => {
    setSubmitting(true);
    setError(null);
    setResult(null);

    // 从 referenceAssets 提取 originalUrl 作为参考图
    const referenceImageUrls = (params.referenceAssets || [])
      .filter((a) => a.originalUrl)
      .sort((a, b) => a.order - b.order)
      .map((a) => a.originalUrl);

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
          reference_image_urls: referenceImageUrls,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        // 提取后端调试信息（脱敏的 ProviderContext）
        const debugInfo = data._debug ?? null;
        const err = new Error(data.message || data.error || '创建任务失败') as Error & { _debug?: unknown };
        err._debug = debugInfo;
        throw err;
      }

      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setSubmitErrorDebug((err as Error & { _debug?: unknown })._debug as typeof submitErrorDebug ?? undefined);
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
    setSubmitErrorDebug(undefined);
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
            <button
              className="composer-topbar-nav-btn"
              onClick={() => setShowAssetPanel(true)}
              style={{ background: showAssetPanel ? 'rgba(37,99,235,0.2)' : undefined }}
            >
              资产管理
            </button>
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
        submitErrorDebug={submitErrorDebug}
        isSubmitting={submitting}
        result={result}
        onReset={handleReset}
      />

      {/* Seedance 资产管理测试入口 */}
      <SeedanceAssetPanel
        visible={showAssetPanel}
        onClose={() => setShowAssetPanel(false)}
      />
    </div>
  );
}
