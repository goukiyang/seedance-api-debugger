'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { calculateEnhanceVideoEstimatedCostClient } from '@/lib/pricing-client';
import { taskDetailHref } from '@/lib/navigation/return-to';

type EnhanceVideoActionTask = {
  id: string;
  provider: string;
  generation_mode: string;
  local_status: string;
  result_video_url: string | null;
  local_video_path: string | null;
  duration: number | null;
  video_card_id: string | null;
};

type EnhanceVideoActionProps = {
  task: EnhanceVideoActionTask;
};

type ConfigResponse = {
  aimediakit_enhance_video?: {
    api_key_configured?: boolean;
  };
};

const RESOLUTION_OPTIONS = ['720p', '1080p', '2k'] as const;

export default function EnhanceVideoAction({ task }: EnhanceVideoActionProps) {
  const router = useRouter();
  const [toolVersion, setToolVersion] = useState<'standard' | 'professional'>('standard');
  const [resolution, setResolution] = useState<typeof RESOLUTION_OPTIONS[number]>('1080p');
  const [fps, setFps] = useState<'none' | '30' | '60'>('none');
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const shouldRender = task.local_status === 'succeeded'
    && Boolean(task.local_video_path || task.result_video_url)
    && task.provider !== 'volcengine_mediakit'
    && task.generation_mode !== 'enhance_video';

  useEffect(() => {
    if (!shouldRender) return;

    let cancelled = false;
    fetch('/api/config', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data: ConfigResponse) => {
        if (!cancelled) setConfigured(data.aimediakit_enhance_video?.api_key_configured === true);
      })
      .catch(() => {
        if (!cancelled) setConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, [shouldRender]);

  const estimatedCost = useMemo(() => {
    if (!task.duration) return null;
    return calculateEnhanceVideoEstimatedCostClient({
      duration: task.duration,
      resolution,
      toolVersion,
      fps: fps === 'none' ? null : Number(fps),
    });
  }, [fps, resolution, task.duration, toolVersion]);

  if (!shouldRender) return null;

  const disabledReason = (() => {
    if (configured === null) return '正在检查 AI MediaKit 配置';
    if (!configured) return '未配置 AI_MEDIAKIT_API_KEY';
    if (!task.video_card_id) return '当前任务没有视频卡，不能写入成本闭环';
    if (!task.duration) return '当前任务缺少视频时长，不能估算冻结点数';
    return '';
  })();

  const handleSubmit = async () => {
    if (disabledReason || submitting) return;
    setSubmitting(true);
    setMessage('');
    setError('');
    try {
      const selectedFps = fps === 'none' ? null : Number(fps);
      const res = await fetch('/api/tasks/enhance-video/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_task_id: task.id,
          video_card_id: task.video_card_id,
          tool_version: toolVersion,
          scene: toolVersion === 'standard' ? 'aigc' : undefined,
          resolution,
          fps: selectedFps || undefined,
          duration: task.duration,
          idempotency_key: [
            'enhance',
            task.id,
            toolVersion,
            resolution,
            selectedFps || 'source_fps',
          ].join(':'),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || '创建超分任务失败');
      }
      setMessage('已创建超分任务');
      router.push(taskDetailHref(data.id, `/tasks/${task.id}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建超分任务失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <details className="enhance-video-action">
      <summary>
        <span>
          <Sparkles size={16} aria-hidden="true" />
          超分/增强
        </span>
        <strong>{estimatedCost !== null ? `预估冻结 ${estimatedCost} 点` : '待估算'}</strong>
      </summary>

      <div className="enhance-video-action-body">
        <label>
          <span>版本</span>
          <select value={toolVersion} onChange={(event) => setToolVersion(event.target.value as 'standard' | 'professional')}>
            <option value="standard">标准版</option>
            <option value="professional">专业版</option>
          </select>
        </label>

        <label>
          <span>目标分辨率</span>
          <select value={resolution} onChange={(event) => setResolution(event.target.value as typeof RESOLUTION_OPTIONS[number])}>
            {RESOLUTION_OPTIONS.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
        </label>

        <label>
          <span>帧率</span>
          <select value={fps} onChange={(event) => setFps(event.target.value as 'none' | '30' | '60')}>
            <option value="none">不插帧</option>
            <option value="30">30 fps</option>
            <option value="60">60 fps</option>
          </select>
        </label>

        <div className="enhance-video-action-meta">
          <span>源视频</span>
          <strong>{task.duration ? `${task.duration} 秒` : '未知时长'}</strong>
        </div>
      </div>

      {disabledReason && (
        <div className="enhance-video-action-warning">{disabledReason}</div>
      )}
      {error && <div className="enhance-video-action-error">{error}</div>}
      {message && <div className="enhance-video-action-success">{message}</div>}

      <div className="enhance-video-action-footer">
        <span>提交后会创建新的任务记录，沿用当前项目和视频卡。</span>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleSubmit}
          disabled={Boolean(disabledReason) || submitting}
        >
          <Sparkles size={16} aria-hidden="true" />
          {submitting ? '创建中...' : '创建超分任务'}
        </button>
      </div>
    </details>
  );
}
