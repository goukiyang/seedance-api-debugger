'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, CheckCircle2, RefreshCcw, Sparkles } from 'lucide-react';
import EnhanceVideoAction from '@/components/EnhanceVideoAction';
import { RelativeTime } from '@/components/RelativeTime';
import { TaskVideoThumbnail } from '@/components/TaskVideoThumbnail';
import { sanitizeOptionalReturnTo, taskDetailHref, taskReturnLabel } from '@/lib/navigation/return-to';
import { useAppSession } from '@/lib/context/AppSessionContext';

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

function canEnhance(task: EnhanceTaskCandidate) {
  return task.local_status === 'succeeded'
    && Boolean(task.local_video_path || task.result_video_url || task.public_video_url)
    && task.provider !== 'volcengine_mediakit'
    && task.generation_mode !== 'enhance_video';
}

function taskSubtitle(task: EnhanceTaskCandidate) {
  const parts = [
    task.project?.name || '未归属项目',
    task.duration ? `${task.duration} 秒` : '时长未知',
    task.resolution || null,
  ].filter(Boolean);
  return parts.join(' · ');
}

export default function EnhanceVideoPageClient() {
  const { user, hasLoadedUser, loadingUser, refreshUser } = useAppSession();
  const [tasks, setTasks] = useState<EnhanceTaskCandidate[]>([]);
  const [config, setConfig] = useState<ConfigState | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [error, setError] = useState('');
  const [requestedSourceTaskId, setRequestedSourceTaskId] = useState<string | null>(null);
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const taskListRequestRef = useRef(0);
  const activeAccountIdRef = useRef<string | null>(user?.id || null);
  activeAccountIdRef.current = user?.id || null;

  const eligibleTasks = useMemo(() => tasks.filter(canEnhance), [tasks]);
  const blockedTasks = useMemo(() => tasks.filter((task) => !canEnhance(task)).slice(0, 6), [tasks]);
  const requestedTask = tasks.find((task) => task.id === requestedSourceTaskId) || null;
  const requestedSourceTask = eligibleTasks.find((task) => task.id === requestedSourceTaskId) || null;
  const canStartRequestedSource = Boolean(
    requestedSourceTask
      && (requestedSourceTask.local_video_path || requestedSourceTask.result_video_url)
      && requestedSourceTask.video_card_id
      && requestedSourceTask.duration,
  );
  const selectedSourceTask = canStartRequestedSource ? requestedSourceTask : null;
  const enhancerReturnTo = useMemo(() => {
    const params = new URLSearchParams();
    if (returnTo) params.set('return_to', returnTo);
    if (requestedSourceTaskId) params.set('source_task_id', requestedSourceTaskId);
    const query = params.toString();
    return query ? `/generate/enhance?${query}` : '/generate/enhance';
  }, [requestedSourceTaskId, returnTo]);

  const load = useCallback(async () => {
    const accountId = user?.id || null;
    if (loadingUser || !accountId) return;
    const requestId = ++taskListRequestRef.current;
    const isCurrentRequest = () => taskListRequestRef.current === requestId
      && activeAccountIdRef.current === accountId;
    setLoadState('loading');
    setError('');
    try {
      const [configResponse, tasksResponse] = await Promise.all([
        fetch('/api/config', { cache: 'no-store' }),
        fetch(`/api/video/list?page=1&limit=${PAGE_SIZE}`, { cache: 'no-store' }),
      ]);

      if (!isCurrentRequest()) return;
      if (configResponse.status === 401 || tasksResponse.status === 401) {
        window.location.href = '/login';
        return;
      }
      if ([403, 404].includes(configResponse.status)) setConfig(null);
      if ([403, 404].includes(tasksResponse.status)) {
        setTasks([]);
        throw new Error('当前账号无法读取这组任务，请重新打开工作台。');
      }
      if (!configResponse.ok) throw new Error('超分配置读取失败，请稍后重试。');

      const configData = await configResponse.json();
      if (!isCurrentRequest()) return;
      setConfig({
        ready: configData.aimediakit_enhance_video?.ready === true,
        enabled: configData.aimediakit_enhance_video?.enabled === true,
        apiKeyConfigured: configData.aimediakit_enhance_video?.api_key_configured === true,
      });

      const tasksData = await tasksResponse.json();
      if (!isCurrentRequest()) return;
      if (!tasksResponse.ok) {
        throw new Error(tasksData.message || tasksData.error || '视频列表加载失败');
      }
      setTasks(Array.isArray(tasksData.tasks) ? tasksData.tasks : []);
      setLoadState('ready');
    } catch (err) {
      if (!isCurrentRequest()) return;
      setError(err instanceof Error ? err.message : '视频超分页加载失败');
      setLoadState('error');
    }
  }, [loadingUser, user?.id]);

  useEffect(() => {
    if (!hasLoadedUser && !loadingUser) void refreshUser();
  }, [hasLoadedUser, loadingUser, refreshUser]);

  useEffect(() => {
    taskListRequestRef.current += 1;
    setTasks([]);
    setConfig(null);
    setLoadState('idle');
    setError('');
  }, [user?.id]);

  useEffect(() => {
    if (loadingUser || !user?.id) return;
    void load();
  }, [load, user?.id, loadingUser]);

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const rawSourceTaskId = searchParams.get('source_task_id')?.trim() || null;
    const sourceTaskId = rawSourceTaskId && rawSourceTaskId.length <= 200 && !/[\u0000-\u001f\u007f]/.test(rawSourceTaskId)
      ? rawSourceTaskId
      : null;
    setRequestedSourceTaskId(sourceTaskId);
    setReturnTo(sanitizeOptionalReturnTo(searchParams.get('return_to')));
  }, []);

  useEffect(() => {
    if (loadState !== 'ready' || !selectedSourceTask) return;
    document.querySelector(`[data-enhance-source-id="${CSS.escape(selectedSourceTask.id)}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [loadState, selectedSourceTask?.id]);

  return (
    <div className="enhance-video-page">
      <section className="enhance-video-hero">
        <div>
          <span className="enhance-video-eyebrow">AI MediaKit</span>
          <h1>视频超分</h1>
          <p>
            {selectedSourceTask
              ? '已定位原来源视频；请确认下方来源后，再手动选择超分参数并提交。'
              : requestedTask && !requestedSourceTask
                ? '原来源任务目前不满足超分条件，请从列表中手动选择可用视频。'
                : requestedSourceTask && !canStartRequestedSource
                  ? '已找到原来源视频，但创建超分所需信息不完整；请重新选择可用视频。'
                  : requestedSourceTaskId && loadState === 'ready'
                    ? '原来源视频未在最近 24 条可用任务中定位，请在列表中手动选择。'
                : '选择一条已成功的视频，创建新的超分任务。'}
          </p>
        </div>
        <div className="enhance-video-hero-actions">
          {returnTo && <Link href={returnTo} className="btn btn-secondary">{taskReturnLabel(returnTo)}</Link>}
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

      {requestedSourceTaskId && loadState === 'ready' && !selectedSourceTask && (
        <div className="alert alert-info" role="status">
          {requestedTask && !requestedSourceTask
            ? '原来源任务当前未成功、没有可用视频或本身属于超分任务；请手动选择普通的已成功视频。'
            : requestedSourceTask
              ? '原来源视频已找到，但缺少创建超分所需的视频卡、时长或可用源文件；请重新选择。'
              : `此工作台只读取最近 ${PAGE_SIZE} 条任务；原来源不在当前可用列表中，请手动选择符合条件的视频。`}
        </div>
      )}

      <section className="enhance-video-list">
        <div className="enhance-video-section-head">
          <div>
            <h2>可超分视频</h2>
            <span>{loadState === 'loading' ? '正在加载' : `${eligibleTasks.length} 条可用`}</span>
          </div>
          <Link href={returnTo || '/tasks'}>{returnTo ? taskReturnLabel(returnTo) : '查看全部任务'}</Link>
        </div>

        {loadState === 'loading' && (
          <div className="enhance-video-empty">正在加载最近视频...</div>
        )}

        {loadState !== 'loading' && eligibleTasks.length === 0 && (
          <div className="enhance-video-empty">
            <strong>没有可直接超分的视频</strong>
            <span>需要成功任务、可播放视频和视频时长。</span>
            <div>
              <Link href="/generate" className="btn btn-primary">去生成视频</Link>
              <Link href="/tasks" className="btn btn-secondary">查看任务</Link>
            </div>
          </div>
        )}

        {eligibleTasks.length > 0 && (
          <div className="enhance-video-grid">
            {eligibleTasks.map((task) => (
              <article
                className="enhance-video-card"
                key={task.id}
                data-enhance-source-id={selectedSourceTask?.id === task.id ? task.id : undefined}
              >
                {selectedSourceTask?.id === task.id && <span className="task-enhance-chip">已定位来源视频</span>}
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
                  href={taskDetailHref(task.id, enhancerReturnTo)}
                  size="card"
                  reactions
                />
                <div className="enhance-video-card-body">
                  <div>
                    <Link href={taskDetailHref(task.id, enhancerReturnTo)} className="enhance-video-card-title">
                      {task.prompt || '未命名视频'}
                    </Link>
                    <span>{taskSubtitle(task)}</span>
                    <small><RelativeTime value={task.completed_at || task.created_at} /></small>
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
              <Link href={taskDetailHref(task.id, enhancerReturnTo)} className="enhance-video-blocked-item" key={task.id}>
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
