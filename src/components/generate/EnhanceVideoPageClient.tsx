'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, CheckCircle2, RefreshCcw, Sparkles } from 'lucide-react';
import EnhanceVideoAction from '@/components/EnhanceVideoAction';
import { TaskVideoThumbnail } from '@/components/TaskVideoThumbnail';
import { taskDetailHref } from '@/lib/navigation/return-to';

type EnhanceTaskCandidate = {
  id: string;
  provider: string | null;
  prompt: string | null;
  generation_mode: string | null;
  local_status: string | null;
  result_video_url: string | null;
  result_last_frame_url: string | null;
  local_video_path: string | null;
  public_video_url?: string | null;
  delivery_stage?: { key?: string | null; label?: string | null } | null;
  stable_download_ready?: boolean | null;
  preview_available?: boolean | null;
  thumbnail_url?: string | null;
  retry_after_ms?: number | null;
  duration: number | null;
  resolution: string | null;
  created_at: string;
  completed_at: string | null;
  project?: { id: string; name: string; type?: string | null } | null;
  video_card_id: string | null;
  video_card?: { id: string; title: string; project_id?: string | null } | null;
};

type ConfigState = {
  ready: boolean;
  enabled: boolean;
  apiKeyConfigured: boolean;
};

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

const PAGE_SIZE = 24;

function formatTime(value: string | null) {
  if (!value) return '未完成';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function canEnhance(task: EnhanceTaskCandidate) {
  return task.local_status === 'succeeded'
    && Boolean(task.local_video_path || task.result_video_url || task.public_video_url)
    && task.provider !== 'volcengine_mediakit'
    && task.generation_mode !== 'enhance_video';
}

function taskSubtitle(task: EnhanceTaskCandidate) {
  const parts = [
    task.project?.name || '未归属项目',
    task.video_card?.title || '没有视频卡',
    task.duration ? `${task.duration} 秒` : '时长未知',
    task.resolution || null,
  ].filter(Boolean);
  return parts.join(' · ');
}

export default function EnhanceVideoPageClient() {
  const [tasks, setTasks] = useState<EnhanceTaskCandidate[]>([]);
  const [config, setConfig] = useState<ConfigState | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [error, setError] = useState('');

  const eligibleTasks = useMemo(() => tasks.filter(canEnhance), [tasks]);
  const blockedTasks = useMemo(() => tasks.filter((task) => !canEnhance(task)).slice(0, 6), [tasks]);

  const load = async () => {
    setLoadState('loading');
    setError('');
    try {
      const [configResponse, tasksResponse] = await Promise.all([
        fetch('/api/config', { cache: 'no-store' }),
        fetch(`/api/video/list?page=1&limit=${PAGE_SIZE}`, { cache: 'no-store' }),
      ]);

      const configData = await configResponse.json();
      setConfig({
        ready: configData.aimediakit_enhance_video?.ready === true,
        enabled: configData.aimediakit_enhance_video?.enabled === true,
        apiKeyConfigured: configData.aimediakit_enhance_video?.api_key_configured === true,
      });

      const tasksData = await tasksResponse.json();
      if (!tasksResponse.ok) {
        throw new Error(tasksData.message || tasksData.error || '视频列表加载失败');
      }
      setTasks(Array.isArray(tasksData.tasks) ? tasksData.tasks : []);
      setLoadState('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : '视频超分页加载失败');
      setLoadState('error');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="enhance-video-page">
      <section className="enhance-video-hero">
        <div>
          <span className="enhance-video-eyebrow">AI MediaKit</span>
          <h1>视频超分</h1>
          <p>选择一条已成功的视频，创建新的超分任务。</p>
        </div>
        <div className="enhance-video-hero-actions">
          <button type="button" className="btn btn-secondary" onClick={() => void load()} disabled={loadState === 'loading'}>
            <RefreshCcw size={16} aria-hidden="true" />
            {loadState === 'loading' ? '刷新中' : '刷新'}
          </button>
          <Link href="/admin/integrations/aimediakit" className="btn btn-primary">
            <Sparkles size={16} aria-hidden="true" />
            API 设置
          </Link>
        </div>
      </section>

      <section className={`enhance-video-config ${config?.ready ? 'is-ready' : 'is-blocked'}`}>
        {config?.ready ? (
          <CheckCircle2 size={18} aria-hidden="true" />
        ) : (
          <AlertCircle size={18} aria-hidden="true" />
        )}
        <div>
          <strong>{config?.ready ? 'AI MediaKit 已就绪' : 'AI MediaKit 还不能提交任务'}</strong>
          <span>
            {config?.ready
              ? '可以创建真实超分任务。'
              : config?.apiKeyConfigured
                ? 'API Key 已保存，但配置还未变为可用。'
                : '后台还没有录入 API Key。'}
          </span>
        </div>
      </section>

      {error && <div className="enhance-video-error">{error}</div>}

      <section className="enhance-video-list">
        <div className="enhance-video-section-head">
          <div>
            <h2>可超分视频</h2>
            <span>{loadState === 'loading' ? '正在加载' : `${eligibleTasks.length} 条可用`}</span>
          </div>
          <Link href="/tasks">查看全部任务</Link>
        </div>

        {loadState === 'loading' && (
          <div className="enhance-video-empty">正在加载最近视频...</div>
        )}

        {loadState !== 'loading' && eligibleTasks.length === 0 && (
          <div className="enhance-video-empty">
            <strong>没有可直接超分的视频</strong>
            <span>需要成功任务、可播放视频、视频卡和视频时长。</span>
            <div>
              <Link href="/generate" className="btn btn-primary">去生成视频</Link>
              <Link href="/tasks" className="btn btn-secondary">查看任务</Link>
            </div>
          </div>
        )}

        {eligibleTasks.length > 0 && (
          <div className="enhance-video-grid">
            {eligibleTasks.map((task) => (
              <article className="enhance-video-card" key={task.id}>
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
                  href={taskDetailHref(task.id, '/generate/enhance')}
                  size="card"
                />
                <div className="enhance-video-card-body">
                  <div>
                    <Link href={taskDetailHref(task.id, '/generate/enhance')} className="enhance-video-card-title">
                      {task.prompt || '未命名视频'}
                    </Link>
                    <span>{taskSubtitle(task)}</span>
                    <small>{formatTime(task.completed_at || task.created_at)}</small>
                  </div>
                  <EnhanceVideoAction
                    task={{
                      id: task.id,
                      provider: task.provider || '',
                      generation_mode: task.generation_mode || '',
                      local_status: task.local_status || '',
                      result_video_url: task.result_video_url,
                      local_video_path: task.local_video_path,
                      duration: task.duration,
                      video_card_id: task.video_card_id,
                    }}
                  />
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {blockedTasks.length > 0 && (
        <section className="enhance-video-list">
          <div className="enhance-video-section-head">
            <div>
              <h2>最近不可用</h2>
              <span>失败、处理中、已超分或缺少视频信息的任务不会直接提交。</span>
            </div>
          </div>
          <div className="enhance-video-blocked-list">
            {blockedTasks.map((task) => (
              <Link href={taskDetailHref(task.id, '/generate/enhance')} className="enhance-video-blocked-item" key={task.id}>
                <span>{task.prompt || task.id}</span>
                <strong>{task.local_status || '状态未知'}</strong>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
