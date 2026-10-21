import type { PricingAdminFilter, PricingAdminRow } from './admin-contract';
import { imageStudioQualityLabel } from '@/lib/image-studio/model-catalog';
import type { ImageQualityRoutes } from '@/lib/image-studio/quality-routing';

export function projectPricingDisplay(row: PricingAdminRow, qualityRoutes?: ImageQualityRoutes): PricingAdminRow {
  if (row.identity.kind !== 'image') return row;
  const routes = Object.entries(qualityRoutes || {}).find(([model]) => model === row.identity.modelId)?.[1];
  const defaultQualities = Object.entries(routes || {}).filter(([quality, channelId]) => channelId === row.identity.channelId
    && (!row.identity.specifications.quality || row.identity.specifications.quality === quality)).map(([quality]) => quality);
  return { ...row, defaultQualities, isDefault: routes && Object.keys(routes).length ? defaultQualities.length > 0 : row.isDefault };
}

export function pricingDisplayName(row: PricingAdminRow) {
  const qualities = row.identity.specifications.quality
    ? [row.identity.specifications.quality] : row.defaultQualities || [];
  return qualities.length ? `${row.label} · ${qualities.map(quality => imageStudioQualityLabel(row.identity.modelId, quality)).join(' / ')}` : row.label;
}

export function pricingDisplayScope(row: PricingAdminRow, specifications = row.identity.specifications) {
  const parts = Object.entries(specifications).map(([key, value]) => {
    if (key === 'quality') return imageStudioQualityLabel(row.identity.modelId, value);
    if (key === 'referenceVideo') return ({ none: '无参考视频', present: '有参考视频', unknown: '参考视频待确认' } as Record<string, string>)[value] || value;
    if (key === 'pricingPurpose') return ({ standard: '普通生成', draft: '草稿', draft_upgrade: '草稿升级', unknown: '用途待确认' } as Record<string, string>)[value] || value;
    return value;
  });
  if (parts.length) return parts.join(' / ');
  return row.identity.kind === 'image' ? '该通道全部合法规格，专属规则优先'
    : row.identity.kind === 'video' ? '通用价格，专属规格规则优先' : row.appliesTo.join(' / ');
}

export function pricingDisplayRounding(row: PricingAdminRow) {
  if (row.mode === 'free') return '明确免费';
  if (row.mode === 'legacy_actual') return '原费用合同：保留两位小数';
  if (row.mode === 'legacy_fixed') return row.legacyRounding === 'ceil_task' ? '原规则：整任务向上取整' : '原固定单价';
  if (row.mode === 'unset') return '计价尚未设置';
  return '每个任务最终四舍五入到 0.1 点';
}

export const allPricingFilters: PricingAdminFilter = { kind: 'all', difference: 'all', defaultsOnly: false, search: '', channelId: '', basisKind: undefined };

export function pricingActiveFilters(filter: PricingAdminFilter, rows: PricingAdminRow[]) {
  const active: Array<{ key: keyof PricingAdminFilter; label: string; clear: PricingAdminFilter }> = [];
  if (filter.kind && filter.kind !== 'all') active.push({ key: 'kind', label: ({ image: '图片', video: '视频', enhance: '视频增强', h3: 'H3 免费项' })[filter.kind], clear: { kind: 'all' } });
  if (filter.search?.trim()) active.push({ key: 'search', label: `搜索：${filter.search}`, clear: { search: '' } });
  if (filter.channelId) active.push({ key: 'channelId', label: rows.find(row => row.identity.channelId === filter.channelId)?.providerLabel || '已选供应商', clear: { channelId: '' } });
  if (filter.defaultsOnly) active.push({ key: 'defaultsOnly', label: '仅默认（含画质默认）', clear: { defaultsOnly: false } });
  if (filter.difference && filter.difference !== 'all') active.push({ key: 'difference', label: ({ different: '有差异', unconfirmed: '待核实', custom: '单独设置' })[filter.difference], clear: { difference: 'all' } });
  if (filter.basisKind) active.push({ key: 'basisKind', label: filter.basisKind === 'site_base_cny' ? '站内人民币基价' : '供应商实际成本', clear: { basisKind: undefined } });
  return active;
}
