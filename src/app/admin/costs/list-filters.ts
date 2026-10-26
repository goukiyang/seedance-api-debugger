import type { Prisma } from '@prisma/client';
import { CANVAS_SOURCE_LABELS, canvasSourceJsonMarkers } from '@/lib/canvas-source';

export type CostListFilters = {
  source: 'all' | 'ultimate_canvas' | 'web' | 'codex_api';
  cost_status: '' | 'pending' | 'conflict' | 'confirmed';
  owner_user_id: string; project_id: string; date_from: string; date_to: string;
  resolution: string; keyword: string;
  page: number; page_size: number; task_page: number;
};
export function parseCostListFilters(params: URLSearchParams): CostListFilters {
  const value = (name: string, max = 120) => {
    const text = (params.get(name) || '').trim();
    if (text.length > max) throw new Error(`筛选内容过长：${name}`);
    return text;
  };
  const source = value('source') || 'all', status = value('cost_status'), resolution = value('resolution');
  if (!['all', 'ultimate_canvas', 'web', 'codex_api'].includes(source)
    || !['', 'pending', 'conflict', 'confirmed'].includes(status)
    || !['', '480p', '720p', '1080p', 'unknown'].includes(resolution)) throw new Error('成本筛选条件无效');
  const dateFrom = value('date_from'), dateTo = value('date_to');
  const page = Number(value('page') || 1), taskPage = Number(value('task_page') || 1), pageSize = Number(value('page_size') || 30);
  if (![page, taskPage].every(number => Number.isSafeInteger(number) && number > 0 && number <= 10000)
    || ![20, 30, 50, 100].includes(pageSize)) throw new Error('分页条件无效');
  if ([dateFrom, dateTo].some(date => date && !Number.isFinite(Date.parse(date)))
    || dateFrom && dateTo && Date.parse(dateFrom) > Date.parse(dateTo)) throw new Error('日期范围无效');
  return { source: source as CostListFilters['source'], cost_status: status as CostListFilters['cost_status'],
    owner_user_id: value('owner_user_id'), project_id: value('project_id'), date_from: dateFrom, date_to: dateTo,
    resolution, keyword: value('keyword', 200), page, page_size: pageSize, task_page: taskPage };
}
export function costListSearch(filters: CostListFilters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value && !(key === 'source' && value === 'all')) params.set(key, String(value));
  return params;
}
function dateRange(filters: CostListFilters) {
  const end = filters.date_to ? new Date(filters.date_to) : null;
  if (end && /^\d{4}-\d{2}-\d{2}$/.test(filters.date_to)) end.setUTCHours(23, 59, 59, 999);
  return { ...(filters.date_from ? { gte: new Date(filters.date_from) } : {}), ...(end ? { lte: end } : {}) };
}
export function costTaskListWhere(filters: CostListFilters): Prisma.VideoTaskWhereInput {
  const and: Prisma.VideoTaskWhereInput[] = [];
  const canvas: Prisma.VideoTaskWhereInput = { OR: [
    { source_label: { in: [...CANVAS_SOURCE_LABELS] } },
    ...canvasSourceJsonMarkers().map(contains => ({ source_metadata_json: { contains } })),
  ] };
  if (filters.source === 'ultimate_canvas') and.push(canvas);
  if (filters.source === 'web') and.push({ source_type: 'web', NOT: canvas });
  if (filters.source === 'codex_api') and.push({ source_type: 'codex_api' });
  if (filters.owner_user_id) and.push({ OR: [{ owner_user_id: filters.owner_user_id }, { owner_user_id: null, user_id: filters.owner_user_id }] });
  if (filters.project_id) and.push({ project_id: filters.project_id === 'unassigned' ? null : filters.project_id });
  if (filters.date_from || filters.date_to) and.push({ created_at: dateRange(filters) });
  if (filters.resolution) and.push(filters.resolution === 'unknown'
    ? { OR: [{ resolution: null }, { resolution: { notIn: ['480p', '720p', '1080p'] } }] } : { resolution: filters.resolution });
  if (filters.keyword) and.push({ OR: [{ id: { contains: filters.keyword } }, { provider_task_id: { contains: filters.keyword } }, { source_request_id: { contains: filters.keyword } }] });
  if (filters.cost_status === 'pending') and.push({ OR: [{ provider_cost_status: 'unknown' }, {
    local_status: { in: ['succeeded', 'failed', 'cancelled'] }, provider_cost_status: { notIn: ['official_confirmed', 'reconciled', 'failed_no_charge', 'disputed'] },
  }] });
  if (filters.cost_status === 'conflict') and.push({ provider_cost_status: 'disputed' });
  if (filters.cost_status === 'confirmed') and.push({ provider_cost_status: { in: ['official_confirmed', 'reconciled', 'failed_no_charge'] } });
  return and.length ? { AND: and } : {};
}
export function costLedgerListWhere(filters: CostListFilters): Prisma.CostLedgerWhereInput {
  const and: Prisma.CostLedgerWhereInput[] = [];
  if (filters.source !== 'all') and.push({ task: costTaskListWhere({ ...filters, cost_status: '', owner_user_id: '', project_id: '', date_from: '', date_to: '', keyword: '', resolution: '' }) });
  if (filters.owner_user_id) and.push({ user_id: filters.owner_user_id });
  if (filters.project_id) and.push({ project_id: filters.project_id === 'unassigned' ? null : filters.project_id });
  if (filters.date_from || filters.date_to) and.push({ occurred_at: dateRange(filters) });
  if (filters.resolution) and.push({ task: costTaskListWhere({ ...filters, source: 'all', cost_status: '', owner_user_id: '', project_id: '', date_from: '', date_to: '', keyword: '' }) });
  if (filters.keyword) and.push({ OR: [{ id: { contains: filters.keyword } }, { task_id: { contains: filters.keyword } }, { provider_task_id: { contains: filters.keyword } }, { source_id: { contains: filters.keyword } }] });
  if (filters.cost_status === 'pending') and.push({ confidence: { notIn: ['confirmed', 'reconciled', 'disputed'] } });
  if (filters.cost_status === 'conflict') and.push({ confidence: 'disputed' });
  if (filters.cost_status === 'confirmed') and.push({ confidence: { in: ['confirmed', 'reconciled'] } });
  return and.length ? { AND: and } : {};
}
