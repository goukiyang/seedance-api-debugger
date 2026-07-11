export type VideoCardRemovalAction = 'archive' | 'discard' | null;

export type VideoCardDisplayInput = {
  status: string;
  platform?: string | null;
  ratio?: string | null;
  duration?: number | null;
  target_resolution?: string | null;
  is_fallback?: boolean;
  current_best_task_id?: string | null;
  final_task_id?: string | null;
  branch_count?: number;
  summary?: { task_count?: number } | null;
};

export function videoCardStatusLabel(status: string) {
  const labels: Record<string, string> = {
    draft: '草稿',
    active: '进行中',
    reviewing: '评审中',
    finalized: '已有最终版',
    sealed: '已封板',
    merged: '已合并',
    archived: '已归档',
    discarded: '已废弃',
  };
  return labels[status] || status || '未知状态';
}

export function videoCardSpecLabel(card: VideoCardDisplayInput) {
  const specs = [
    card.platform,
    card.ratio,
    card.duration ? `${card.duration}s` : null,
    card.target_resolution,
  ].filter(Boolean);
  return specs.length ? specs.join(' · ') : '未设置生成规格';
}

export function videoCardRemovalAction(
  card: VideoCardDisplayInput,
  canManage: boolean,
): VideoCardRemovalAction {
  if (!canManage || card.is_fallback) return null;
  if (['sealed', 'merged', 'archived', 'discarded'].includes(card.status)) return null;
  const hasHistory = (card.summary?.task_count || 0) > 0
    || (card.branch_count || 0) > 0
    || Boolean(card.current_best_task_id)
    || Boolean(card.final_task_id);
  return hasHistory ? 'archive' : 'discard';
}

export function videoCardRemovalReason(card: VideoCardDisplayInput, canManage: boolean) {
  if (!canManage) return '你没有权限管理这张视频卡';
  if (card.is_fallback) return '系统兜底视频卡不能归档或废弃';
  if (card.status === 'archived') return '视频卡已归档';
  if (card.status === 'discarded') return '视频卡已废弃';
  if (card.status === 'sealed') return '视频卡已封板，不能直接变更状态';
  if (card.status === 'merged') return '视频卡已合并，不能直接变更状态';
  return videoCardRemovalAction(card, canManage) === 'archive'
    ? '视频卡已有生成记录，只能归档'
    : '空视频卡可以废弃';
}
