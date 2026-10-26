export type PendingFinalizeCandidate = {
  id: string;
  provider_task_id?: string | null;
  error_code?: string | null;
  provider?: string | null;
  public_video_url?: string | null;
  delivery_attempts?: number | null;
  local_status: string;
  local_video_path: string | null;
  result_video_url: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
};

const REFRESH_STATUSES = new Set(['submitted', 'running']);

function timeValue(value: Date | null | undefined, fallback = 0) {
  return value ? value.getTime() : fallback;
}

export function taskFinalizeReason(task: PendingFinalizeCandidate) {
  if (isStaleSubmittedWithoutProvider(task, new Date(), 30)) {
    return 'stale_submitted_missing_provider_task_id';
  }
  if (task.local_status === 'succeeded' && !task.local_video_path) {
    return 'succeeded_missing_local_video';
  }
  return 'needs_provider_status_refresh';
}

export function isStaleSubmittedWithoutProvider(
  task: PendingFinalizeCandidate,
  now: Date,
  minAgeMinutes: number,
) {
  if (task.local_status !== 'submitted') return false;
  if (task.error_code === 'IP_SUBMISSION_UNCONFIRMED') return false;
  if (task.provider_task_id) return false;
  const minAgeMs = Math.max(1, minAgeMinutes) * 60 * 1000;
  return now.getTime() - timeValue(task.created_at) >= minAgeMs;
}

export function isFinalizeCandidate(task: PendingFinalizeCandidate) {
  if (!task.provider_task_id && task.error_code === 'IP_SUBMISSION_UNCONFIRMED') return false;
  if (REFRESH_STATUSES.has(task.local_status)) return true;
  if (task.provider === 'volcengine_ark' && (task.delivery_attempts || 0) >= 6) return false;
  return task.local_status === 'succeeded'
    && (!task.local_video_path || (task.provider === 'volcengine_ark' && !task.public_video_url))
    && Boolean(task.result_video_url || task.local_video_path);
}

export function compareFinalizeCandidates(
  a: PendingFinalizeCandidate,
  b: PendingFinalizeCandidate,
) {
  const aNeedsStatus = REFRESH_STATUSES.has(a.local_status);
  const bNeedsStatus = REFRESH_STATUSES.has(b.local_status);
  if (aNeedsStatus !== bNeedsStatus) return aNeedsStatus ? -1 : 1;

  if (aNeedsStatus && bNeedsStatus) {
    const updatedDiff = timeValue(a.updated_at) - timeValue(b.updated_at);
    if (updatedDiff !== 0) return updatedDiff;
    return timeValue(a.created_at) - timeValue(b.created_at);
  }

  const completedDiff = timeValue(b.completed_at, timeValue(b.created_at))
    - timeValue(a.completed_at, timeValue(a.created_at));
  if (completedDiff !== 0) return completedDiff;
  return timeValue(b.created_at) - timeValue(a.created_at);
}

export function selectFinalizeCandidates<T extends PendingFinalizeCandidate>(
  tasks: T[],
  limit: number,
) {
  return tasks
    .filter(isFinalizeCandidate)
    .sort(compareFinalizeCandidates)
    .slice(0, Math.max(0, limit));
}
