export type MultiviewTaskProgressInput = {
  id: string;
  local_status: string;
  submission_unconfirmed?: boolean;
  provider_status?: string | null;
  provider_task_id?: string | null;
  provider_client_request_id?: string | null;
  idempotency_key?: string | null;
  /** Private multiview tasks expose only this, not the upstream id. */
  provider_accepted?: boolean;
  created_at?: string | null;
  delivery_status?: string | null;
};
export type MultiviewGenerationProgressState = {
  step: number | null;
  label: string;
  uncertain: boolean;
  failed: boolean;
  videoReady?: boolean;
  createdAt?: string;
};

// Only explicit upstream states with a distinct accepted identity establish progress.
export function multiviewGenerationProgress(
  phase: string,
  task?: MultiviewTaskProgressInput | null,
  previous?: MultiviewGenerationProgressState | null,
): MultiviewGenerationProgressState | null {
  if (['empty', 'ready'].includes(phase)) return null;
  const createdAt = task?.created_at && Number.isFinite(Date.parse(task.created_at)) ? task.created_at : previous?.createdAt;
  const result = (step: number | null, label: string, uncertain = false, failed = false) => ({ step, label, uncertain, failed, createdAt });
  if (phase === 'submitting') return result(0, '正在提交');
  if (phase === 'failed' || phase === 'closed' || ['failed', 'cancelled'].includes(task?.local_status || '')) return result(previous?.step ?? null, '本次生成未完成', false, true);
  // Step 1 stays lit while the original request is checked; the system never resubmits it.
  if (phase === 'unknown' || task?.submission_unconfirmed) return result(0, '正在确认是否提交成功', true);
  if (phase === 'video_ready') return { ...result(3, '视频已就绪'), videoReady: true };
  if (task?.local_status === 'succeeded') return result(3, '正在准备视频');
  const accepted = task?.provider_accepted === true || Boolean(task?.provider_task_id && task.provider_task_id !== task.id
    && task.provider_task_id !== task.provider_client_request_id && task.provider_task_id !== task.idempotency_key);
  const upstream = task?.provider_status?.toLowerCase();
  if (accepted && ['queued', 'pending', 'created'].includes(upstream || '')) return result(1, '等待生成');
  if (accepted && ['running', 'processing', 'in_progress'].includes(upstream || '')) return result(2, '视频生成中');
  // A server task id proves acceptance by this site, so step 1 is done even before upstream reports.
  return previous ? result(previous.step, '状态暂未确认', true) : result(1, '已提交，等待生成');
}
