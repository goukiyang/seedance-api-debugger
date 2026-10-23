'use client';
import { useCreationContext } from '@/lib/hooks/use-creation-context';
import CreationAvailability from '@/components/creation/CreationAvailability';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, RefreshCcw } from 'lucide-react';
import { useVideoPricing } from '@/lib/pricing/use-video-pricing';
import { taskDetailHref } from '@/lib/navigation/return-to';

type EnhanceVideoActionTask = {
  id: string;
  project_id?: string | null;
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
    ready?: boolean;
    enabled?: boolean;
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
        if (!cancelled) setConfigured(data.aimediakit_enhance_video?.ready === true);
      })
      .catch(() => {
        if (!cancelled) setConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, [shouldRender]);

  const pricing = useVideoPricing({ provider: 'volcengine_mediakit', model: 'enhance-video', duration: task.duration || 0,
    resolution, toolVersion, fps: fps === 'none' ? null : Number(fps) }, shouldRender && configured === true);
  const estimatedCost = pricing.quote?.estimatedCost ?? null;
  const [destination, setDestination] = useState(task.project_id || '');
  const [destinationConfirmed, setDestinationConfirmed] = useState(Boolean(task.project_id));
  const creation = useCreationContext({ ownerId: pricing.actorId, entry: 'enhance', draftId: task.id, projectId: destination, legacyCardId: task.video_card_id, onProjectChange: setDestination, enabled: shouldRender });
  const [destinations, setDestinations] = useState<Array<{id:string;name:string}>>([]);
  useEffect(() => { let active = true; if (!shouldRender || task.project_id) return; void fetch('/api/projects?lite=true', { cache: 'no-store' }).then(response => response.json()).then(data => { if (active) setDestinations(data.projects || []); }).catch(() => undefined); return () => { active = false; }; }, [shouldRender, task.project_id]);

  if (!shouldRender) return null;

  const disabledReason = (() => {
    if (configured === null) return '正在检查 AI MediaKit 配置';
    if (!configured) return 'AI MediaKit 未启用或缺少 API Key';
    if (!creation.context || creation.loading || creation.error) return creation.error || '正在确认保存位置';
    if (!destinationConfirmed) return '请明确选择本次超分结果保存到的项目';
    if (!task.duration) return '当前任务缺少视频时长，不能估算冻结点数';
    if (!pricing.quote) return pricing.error || '正在读取报价';
    return '';
  })();

  const handleSubmit = async () => {
    if (disabledReason || submitting) return;
    setSubmitting(true);
    setMessage('');
    setError('');
    try {
      const selectedFps = fps === 'none' ? null : Number(fps);
      const key = ['enhance', task.id, toolVersion, resolution, selectedFps || 'source_fps'].join(':');
      const pendingKey = `sd2-enhance-acceptance:${pricing.actorId}:${key}`;
      if (sessionStorage.getItem(pendingKey)) {
        const response = await fetch(`/api/tasks/request-status?idempotency_key=${encodeURIComponent(key)}`, { cache: 'no-store' });
        const original = await response.json();
        if (response.ok && original.task?.id) { sessionStorage.removeItem(pendingKey); router.push(taskDetailHref(original.task.id, `/tasks/${task.id}`)); return; }
        throw new Error('原超分提交待确认，请查询原任务；不会再次发送');
      }
      const body = { provider: 'volcengine_mediakit', model: 'enhance-video', action: 'enhance', entry: 'enhance',
        ...(pricing.quote?.pricing_revision ? { pricing_revision: pricing.quote.pricing_revision } : {}),
        source_task_id: task.id, project_id: destination, video_card_id: task.video_card_id, video_branch_id: null,
        continuation: { mode: 'continue', parent_task_id: task.id }, tool_version: toolVersion,
        scene: toolVersion === 'standard' ? 'aigc' : undefined, resolution, fps: selectedFps, duration: task.duration,
        creation_contract_version: 2, idempotency_key: key };
      const prepared = await creation.prepare(body, key);
      if (!prepared.availability?.canSubmit) throw new Error('原创作链当前不可继续，请查看下方原因');
      sessionStorage.setItem(pendingKey, key);
      const res = await fetch('/api/tasks/enhance-video/create', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, intent_id: prepared.id, intent_revision: prepared.revision }) });
      const data = await res.json();
      if (!res.ok) {
        if (typeof data.code === 'string' && data.code.startsWith('pricing_') || typeof data.error === 'string' && data.error.startsWith('pricing_')) pricing.refresh();
        throw new Error(data.message || data.error || '创建超分任务失败');
      }
      sessionStorage.removeItem(pendingKey);
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
      {!task.project_id && <label>本次保存到<select className="input" value={destinationConfirmed ? destination : ''} onChange={event => { setDestination(event.target.value); setDestinationConfirmed(Boolean(event.target.value)); }}><option value="">选择项目</option>{destinations.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}
      <CreationAvailability controller={creation} />

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
      {pricing.error && <button type="button" className="btn-icon" title="重新报价" aria-label="重新报价" onClick={pricing.refresh}><RefreshCcw size={16} aria-hidden="true" /></button>}
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
