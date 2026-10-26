export type RecentTaskCardOrderItem = {
  id: string;
  created_at: string;
  local_status?: string | null;
  thumbnail_url?: string | null;
  public_video_url?: string | null;
  local_video_path?: string | null;
  result_video_url?: string | null;
  result_last_frame_url?: string | null;
  preview_available?: boolean | null;
  stable_download_ready?: boolean | null;
};

export function recentTaskHasVisualPreview(task: RecentTaskCardOrderItem): boolean {
  return Boolean(
    task.thumbnail_url
    || task.public_video_url
    || task.local_video_path
    || task.result_video_url
    || task.result_last_frame_url,
  );
}

export function recentTaskVisualRank(task: RecentTaskCardOrderItem): number {
  const status = task.local_status || '';
  if (recentTaskHasVisualPreview(task)) return 0;
  if (status === 'succeeded' || task.preview_available || task.stable_download_ready) return 1;
  if (status === 'submitted' || status === 'running' || status === 'queued') return 2;
  if (status === 'failed' || status === 'cancelled') return 3;
  return 4;
}

function createdAtMs(task: RecentTaskCardOrderItem): number {
  const value = Date.parse(task.created_at);
  return Number.isFinite(value) ? value : 0;
}

export function orderRecentTaskCards<T extends RecentTaskCardOrderItem>(tasks: T[]): T[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => {
      const rankDiff = recentTaskVisualRank(left.task) - recentTaskVisualRank(right.task);
      if (rankDiff !== 0) return rankDiff;
      const timeDiff = createdAtMs(right.task) - createdAtMs(left.task);
      if (timeDiff !== 0) return timeDiff;
      return left.index - right.index;
    })
    .map(({ task }) => task);
}
