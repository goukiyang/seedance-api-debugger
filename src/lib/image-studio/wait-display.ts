export const IMAGE_GENERATION_WAIT_GRACE_MS = 300_000;

export type ImageGenerationWait = {
  taskKey?: string;
  status: string;
  phase?: string;
  waitingStatus?: string;
  label: string;
  acceptedAt?: number | string | null;
  createdAt?: number | string | null;
  connectionIssue?: boolean;
  connectionDetail?: string;
  detail?: string | null;
  recoveryAvailable?: boolean;
  resultReady?: boolean;
  progress?: number;
};

export type ImageGenerationWaitDisplay = {
  label: string;
  showTrack: boolean;
  busy: boolean;
  showIssue: boolean;
  showRecovery: boolean;
  detail?: string;
  nextCheckAt?: number;
  timeSource?: 'acceptedAt' | 'createdAt';
  progress?: number;
  pending?: boolean;
  ready?: boolean;
  finishing?: boolean;
  nextAnimationAt?: number;
};

function originalTime(value: ImageGenerationWait['acceptedAt'], now: number): number | undefined {
  const time = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 && time <= now ? time : undefined;
}

/** Stable from the original task time, including after refresh/reconnect. */
export function imageGenerationDisplayProgress(wait: ImageGenerationWait, now: number): number {
  if (typeof wait.progress === 'number' && Number.isFinite(wait.progress)) return Math.max(0, Math.min(99.9, wait.progress));
  const start = originalTime(wait.acceptedAt, now) ?? originalTime(wait.createdAt, now);
  if (start === undefined) return 8;
  return Math.min(99.9, 8 + 91.9 * (1 - Math.exp(-Math.max(0, now - start) / 150_000)));
}

/** Display only. No task state, receipt, timer origin or retry is written here. */
export function imageGenerationWaitDisplay(wait: ImageGenerationWait, now: number, online = true): ImageGenerationWaitDisplay {
  const base: ImageGenerationWaitDisplay = {
    label: wait.label, showTrack: false, busy: false,
    showIssue: Boolean(wait.detail), showRecovery: Boolean(wait.recoveryAvailable), detail: wait.detail || undefined,
  };
  // An unknown terminal result can already be refunded/stopped; it is not an
  // accepted task still being polled. Delivery and image decoding have own stages.
  if (['succeeded', 'success', 'failed', 'failure', 'cancelled', 'canceled', 'uncertain'].includes(wait.status)
    || ['ready', 'failed', 'stopped'].includes(wait.phase || '')) {
    // Only an actual available output can clear old polling errors or reach 100.
    return ['succeeded', 'success'].includes(wait.status) && wait.resultReady
      ? { ...base, showIssue: false, showRecovery: false, detail: undefined, progress: 100, ready: true }
      : base;
  }
  if (['download', 'recover', 'validate', 'save', 'settle'].includes(wait.phase || '')) return {
    ...base, busy: true, pending: true, showTrack: true, progress: imageGenerationDisplayProgress(wait, now),
    timeSource: originalTime(wait.acceptedAt, now) !== undefined ? 'acceptedAt' : originalTime(wait.createdAt, now) !== undefined ? 'createdAt' : undefined,
  };
  if (['queued', 'channel_queued', 'needs-confirmation'].includes(wait.status) || wait.phase === 'queued') return { ...base, pending: true };
  const generation = ['provider', 'unknown'].includes(wait.phase || '')
    || !wait.phase && ['running', 'channel_running', 'retrying', 'unconfirmed'].includes(wait.status);
  if (!generation) return base;

  const acceptedAt = originalTime(wait.acceptedAt, now);
  const createdAt = originalTime(wait.createdAt, now);
  const start = acceptedAt ?? createdAt;
  const timeSource = acceptedAt !== undefined ? 'acceptedAt' : createdAt !== undefined ? 'createdAt' : undefined;
  if (start === undefined || !Number.isFinite(now)) return {
    ...base, label: '状态待确认', showIssue: true, showRecovery: true, pending: true, progress: 8,
    detail: '原任务时间暂不可用，请刷新查询原任务。',
  };

  const boundary = start + IMAGE_GENERATION_WAIT_GRACE_MS;
  const connectionIssue = !online || Boolean(wait.connectionIssue);
  const abnormal = connectionIssue || ['retrying', 'unconfirmed'].includes(wait.waitingStatus || '')
    || ['retrying', 'unconfirmed'].includes(wait.status) || wait.phase === 'unknown'
    || wait.waitingStatus !== 'pending' && Boolean(wait.detail);
  if (now < boundary || !abnormal) return {
    label: acceptedAt !== undefined ? '正在生成' : wait.label,
    showTrack: true, busy: true, pending: true, showIssue: false, showRecovery: false, progress: imageGenerationDisplayProgress(wait, now),
    nextCheckAt: now < boundary ? boundary : undefined, timeSource,
  };
  return {
    ...base, label: '状态暂未更新', showIssue: true, showRecovery: true, pending: true, timeSource,
    progress: imageGenerationDisplayProgress(wait, now),
    detail: !online ? '网络连接已中断，请恢复网络后查询原任务。'
      : wait.connectionIssue ? wait.connectionDetail || '原任务状态暂未读取，请刷新查询原任务。'
        : wait.detail || (wait.waitingStatus === 'unconfirmed' || wait.phase === 'unknown'
          ? '原任务状态尚未确认，请刷新查询，不会重新生成。'
          : '正在重新连接原任务，请刷新查询，不会重新生成。'),
  };
}

export type ImageGenerationWaitMemory = { key: string; observedPending: boolean; completed: boolean; progress: number;
  finishStartedAt?: number; finishFrom?: number; fullAt?: number };

/** Local presentation memory only; first-seen ready/history never replays. */
export function advanceImageGenerationWaitDisplay(display: ImageGenerationWaitDisplay, previous: ImageGenerationWaitMemory | undefined,
  key: string, now: number, visible = true, reducedMotion = false) {
  const memory: ImageGenerationWaitMemory = previous?.key === key ? { ...previous } : {
    key, observedPending: false, completed: Boolean(display.ready), progress: display.progress ?? 8,
  };
  if (display.pending) {
    if (visible) memory.observedPending = true;
    memory.progress = Math.max(Math.min(99.9, memory.progress), display.progress ?? memory.progress);
  }
  if (display.ready && !memory.completed) {
    memory.completed = true;
    if (memory.observedPending && visible && !reducedMotion) {
      memory.finishStartedAt = now; memory.finishFrom = Math.min(99.9, memory.progress);
    }
  }
  if (!display.ready || !visible || reducedMotion) {
    memory.finishStartedAt = undefined; memory.fullAt = undefined;
  }
  if (memory.finishStartedAt !== undefined) {
    const elapsed = Math.max(0, now - memory.finishStartedAt);
    const ratio = Math.min(1, elapsed / 300);
    const progress = (memory.finishFrom ?? 8) + (100 - (memory.finishFrom ?? 8)) * (1 - Math.pow(1 - ratio, 3));
    if (ratio === 1 && memory.fullAt === undefined) memory.fullAt = now;
    if (memory.fullAt === undefined || now - memory.fullAt < 80) return {
      memory, display: { ...display, label: '正在完成', finishing: true, showTrack: true, progress,
        nextAnimationAt: memory.fullAt === undefined ? Math.min(now + 50, memory.finishStartedAt + 300) : memory.fullAt + 80 },
    };
    memory.finishStartedAt = undefined; memory.fullAt = undefined;
  }
  return { memory, display: { ...display, progress: display.ready ? 100 : display.progress !== undefined ? memory.progress : undefined } };
}
