export type MultiviewVideoStatus = 'waiting' | 'running' | 'success' | 'failed' | 'unconfirmed';
export type MultiviewVideoResult = {
  id: string; title?: string; status: MultiviewVideoStatus;
  model: string | null; duration: number | null; resolution: string | null;
  createdAt: string | null; actualCost: number | null; frozenCost: number | null;
  thumbnailUrl: string | null; playUrl: string | null; downloadUrl: string | null;
  deliveryStage: { key: string; label: string } | null;
  error: { code: string; message: string } | null;
};

export const multiviewVideoStatusLabels: Record<MultiviewVideoStatus, string> = {
  waiting: '等待生成', running: '生成中', success: '已完成', failed: '未完成', unconfirmed: '状态待确认',
};

export function multiviewSettledPoints(item: Pick<MultiviewVideoResult, 'actualCost' | 'frozenCost'>): number | null {
  return typeof item.actualCost === 'number' && Number.isFinite(item.actualCost) && item.actualCost >= 0
    && item.frozenCost === 0 ? item.actualCost : null;
}

export function multiviewVideoNeedsRefresh(item: MultiviewVideoResult): boolean {
  return ['waiting', 'running', 'unconfirmed'].includes(item.status)
    || item.status === 'success' && (!item.playUrl || multiviewSettledPoints(item) === null);
}

export function mergeMultiviewVideoResults(previous: MultiviewVideoResult[], incoming: MultiviewVideoResult[]): MultiviewVideoResult[] {
  const byId = new Map(previous.map(item => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return Array.from(byId.values()).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || b.id.localeCompare(a.id));
}

export function multiviewVideoResultLabel(item: MultiviewVideoResult): string {
  return item.status === 'success' && !item.playUrl ? '已生成，视频准备中' : multiviewVideoStatusLabels[item.status];
}
