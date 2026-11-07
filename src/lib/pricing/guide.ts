import type { PricingAdminRow } from './admin-contract';
import { pricingDisplayFixedCredits, pricingDisplayName } from './admin-display';
import { roundDecimal } from './math';

export type PricingGuideKind = 'image' | 'video' | 'enhance';
export type PricingGuideItem = {
  id: string;
  kind: PricingGuideKind;
  name: string;
  specification: string;
  baseCny: string | null;
  credits: string | null;
  quantity: '1' | '5';
  unit: 'image' | 'second';
  free: boolean;
  fpsTier: string | null;
};
export type PricingGuideSnapshot = {
  pointsPerCny: string | null;
  updatedAt: string | null;
  items: PricingGuideItem[];
};

export function pricingGuideMoney(amount: string) {
  const rounded = roundDecimal(amount, 4, 'half_up');
  if (rounded === '0' && amount !== '0') return `¥${amount}`;
  return `${rounded === amount ? '' : '约 '}¥${rounded}`;
}

export function projectPricingGuide(rows: PricingAdminRow[], pointsPerCny: string | null,
  updatedAt: string | null, imagesVisible: boolean): PricingGuideSnapshot {
  const available = rows.filter(row => row.enabled && row.pricingEnabled !== false && row.mode !== 'unset' && row.availability === 'ready');
  const resolutionOrder = ['480p', '720p', '1080p', '2k', '4k'];
  const resolutionRanks = new Map(available.map(row => [row.id,
    resolutionOrder.indexOf(row.identity.specifications.resolution?.toLowerCase() || '')]));
  const items: PricingGuideItem[] = [];
  for (const row of available) {
    const specs = row.identity.specifications;
    const image = row.identity.kind === 'image';
    if (image && (!imagesVisible || !row.isDefault)) continue;
    if (row.identity.kind === 'video') {
      if (specs.referenceVideo && specs.referenceVideo !== 'none' || specs.pricingPurpose && specs.pricingPurpose !== 'standard') continue;
      if (specs.resolution && !specs.referenceVideo && !specs.pricingPurpose && rows.some(other =>
        other.identity.kind === 'video' && other.identity.channelId === row.identity.channelId && other.identity.modelId === row.identity.modelId
        && other.identity.specifications.resolution === specs.resolution && other.identity.specifications.referenceVideo === 'none'
        && other.identity.specifications.pricingPurpose === 'standard')) continue;
      if (!specs.resolution && rows.some(other => other.identity.channelId === row.identity.channelId
        && other.identity.modelId === row.identity.modelId && other.identity.specifications.resolution
        && other.identity.specifications.referenceVideo === 'none' && other.identity.specifications.pricingPurpose === 'standard')) continue;
    }
    const kind = row.identity.kind === 'h3' ? 'video' : row.identity.kind;
    const quantity = image ? '1' : '5';
    const free = row.mode === 'free';
    const known = row.identity.billingMode === 'fixed' && row.baseCny !== null && ['follow', 'custom'].includes(row.mode);
    const specification = image ? [specs.resolution, specs.ratio].filter(Boolean).join(' · ')
      : kind === 'enhance' ? [specs.resolution?.toUpperCase(), specs.toolVersion === 'professional' ? '专业版' : '标准版'].join(' · ')
        : [row.identity.channelId === 'volcengine_ark' ? 'IP生成' : '', specs.resolution?.toUpperCase()].filter(Boolean).join(' · ');
    const label = pricingDisplayName(row);
    const resolutionSuffix = specs.resolution ? ` ${specs.resolution}` : '';
    const name = kind === 'enhance' ? '视频超分' : kind === 'video' && resolutionSuffix && label.endsWith(resolutionSuffix)
      ? label.slice(0, -resolutionSuffix.length) : label;
    items.push({ id: row.id, kind, name, specification,
      baseCny: free ? '0' : known ? row.baseCny : null,
      credits: free ? '0' : known ? pricingDisplayFixedCredits(row, quantity) : null,
      quantity, unit: image ? 'image' : 'second', free, fpsTier: kind === 'enhance' ? specs.fpsTier : null });
  }
  items.sort((a, b) => Number(a.credits === null) - Number(b.credits === null)
    || a.name.localeCompare(b.name, 'zh-CN') || (resolutionRanks.get(a.id) ?? -1) - (resolutionRanks.get(b.id) ?? -1)
    || a.specification.localeCompare(b.specification, 'zh-CN'));
  return { pointsPerCny, updatedAt, items };
}
