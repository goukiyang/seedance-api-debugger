import type { PricingAdminChanges, PricingAdminRow, PricingAdminRowChange } from './admin-contract';
import { patchPricingAdminRow } from './admin-client-state';

export const RECOMMENDED_POINTS_PER_CNY = '10.0';
const videoBases: Record<string, string> = { '480p': '0.48229127', '720p': '1.06270945', '1080p': '2.63337604' };

// Explicit adoption only. Existing settings and manual draft fields always win.
export function stageVideoPricingReferences(changes: PricingAdminChanges, rows: PricingAdminRow[], existingGlobal: string | null = null) {
  let result: PricingAdminChanges = changes;
  const parents = rows.filter(row => row.identity.channelId === 'seedance' && row.identity.modelId === 'dreamina-seedance-2-0-260128'
    && row.identity.specifications.referenceVideo === 'none' && row.identity.specifications.pricingPurpose === 'standard');
  for (const row of rows) {
    const specs = row.identity.specifications, amount = videoBases[specs.resolution];
    if (!row.enabled || row.availability !== 'ready' || row.identity.kind !== 'video' || row.identity.billingMode !== 'fixed' || row.identity.unit !== 'second'
      || row.baseCny !== null || changes.rows.some(item => item.id === row.id)
      || row.identity.channelId !== 'seedance' || !amount || specs.referenceVideo !== 'none' || specs.pricingPurpose !== 'standard') continue;
    const parent = parents.find(item => item.identity.specifications.resolution === specs.resolution);
    const derived = row.identity.modelId === 'dreamina-seedance-2-5-260628';
    if (derived && (!parent || !parent.enabled || parent.availability !== 'ready' || parent.baseCny !== null || changes.rows.some(item => item.id === parent.id))) continue;
    if (!derived && row.identity.modelId !== 'dreamina-seedance-2-0-260128') continue;
    const patch: Omit<PricingAdminRowChange, 'id'> = {
      authoringRateMode: 'follow_global',
      ...(derived ? { baseRelation: { parentId: parent!.id, factor: '1.5' as const } } : {
        base: { amount, currency: 'CNY', unit: 'second', source: { type: 'document', reference: '2026-10-18 无参考视频历史账单聚合',
          note: specs.resolution === '1080p' ? '仅9单旧样本；固定折算7 CNY/USD，不是供应商实时固定价' : '最近30单历史参考；固定折算7 CNY/USD，不是逐单实际结算' } },
        evidence: { kind: 'historical_statement', amount, currency: 'CNY', unit: 'second', specifications: specs,
          sampledAt: null, exchangeAssumption: '7 CNY/USD', reference: '2026-10-18 采样，video-cost-summary-20261018', version: '1' },
      }),
    };
    result = patchPricingAdminRow(result, row.id, patch);
  }
  if (result !== changes && changes.authoring?.globalPointsPerCny === undefined && existingGlobal === null) result = { ...result, authoring: { ...result.authoring, globalPointsPerCny: RECOMMENDED_POINTS_PER_CNY } };
  return result;
}

export function stageGptImageReference(changes: PricingAdminChanges, row: PricingAdminRow, specifications: Record<string, string>, existingGlobal: string | null = null) {
  if (!row.enabled || row.availability !== 'ready' || row.identity.kind !== 'image' || row.identity.billingMode !== 'fixed'
    || !/^gpt-image-2$/i.test(row.identity.modelId) || !Object.keys(specifications).length
    || changes.rows.some(item => item.id === row.id && Object.keys(item).some(key => key !== 'id' && key !== 'specifications'))) return changes;
  const result = patchPricingAdminRow(changes, row.id, {
    specifications, authoringRateMode: 'follow_global',
    base: { amount: '0.10', currency: 'CNY', unit: 'image', source: { type: 'document', reference: '2026-10-18 用户提供 GPT Image 2 单张0.10元', note: '仅管理员明确绑定的本供应商、型号和规格；不是独立核实的供应商账单' } },
    evidence: { kind: 'user_provided', amount: '0.10', currency: 'CNY', unit: 'image', specifications, sampledAt: null,
      exchangeAssumption: null, reference: '2026-10-18 用户提供', version: '1' },
  });
  return changes.authoring?.globalPointsPerCny === undefined && existingGlobal === null ? { ...result, authoring: { ...result.authoring, globalPointsPerCny: RECOMMENDED_POINTS_PER_CNY } } : result;
}
