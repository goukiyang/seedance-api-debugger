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
  const available = rows.filter(row => row.enabled && row.availability === 'ready');
  const items: PricingGuideItem[] = [];
  for (const row of available) {
    const specs = row.identity.specifications;
    const image = row.identity.kind === 'image';
    if (image && (!imagesVisible || !row.isDefault)) continue;
    if (row.identity.kind === 'video') {
      if (specs.referenceVideo && specs.referenceVideo !== 'none' || specs.pricingPurpose && specs.pricingPurpose !== 'standard') continue;
      if (!specs.resolution && available.some(other => other.identity.channelId === row.identity.channelId
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
    items.push({ id: row.id, kind, name: kind === 'enhance' ? '视频超分' : pricingDisplayName(row), specification,
      baseCny: free ? '0' : known ? row.baseCny : null,
      credits: free ? '0' : known ? pricingDisplayFixedCredits(row, quantity) : null,
      quantity, unit: image ? 'image' : 'second', free, fpsTier: kind === 'enhance' ? specs.fpsTier : null });
  }
  items.sort((a, b) => Number(a.credits === null) - Number(b.credits === null)
    || a.name.localeCompare(b.name, 'zh-CN') || a.specification.localeCompare(b.specification, 'zh-CN'));
  return { pointsPerCny, updatedAt, items };
}
