import type { Prisma } from '@prisma/client';
import { publicPricingTaskState, studioTaskStates } from './pricing-state';

type DimensionMismatchTask = {
  status: string;
  asset_id?: string | null;
  usage_json?: string | null;
};

export type StudioDimensionMismatch = {
  code: 'generated_dimensions_mismatch' | 'generated_format_mismatch';
  originalSha256: string;
  originalBytes: number;
  validation: {
    originalFormat: string;
    storedFormat: string;
    width: number;
    height: number;
    requestedSize: string;
  };
};

export type StudioOutputIssue = {
  kind: 'dimensions_mismatch' | 'format_mismatch' | 'specification_mismatch';
  actual: { format: string | null; width: number | null; height: number | null };
  requested: { format: string | null; width: number | null; height: number | null };
  originalRetained: boolean;
};

export function studioOutputMismatch(task: DimensionMismatchTask): StudioDimensionMismatch | null {
  if (!['failed', 'uncertain'].includes(publicPricingTaskState(task.status))) return null;
  try {
    const delivery = JSON.parse(task.usage_json || '{}')?.studioDelivery as Record<string, unknown> | undefined;
    const validation = delivery?.validation as Record<string, unknown> | undefined;
    if (!delivery || !validation || !['generated_dimensions_mismatch', 'generated_format_mismatch'].includes(String(delivery.code))
      || typeof delivery.originalSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(delivery.originalSha256)
      || !Number.isSafeInteger(delivery.originalBytes) || Number(delivery.originalBytes) <= 0
      || !studioOutputFormat(String(validation?.originalFormat)) || typeof validation?.storedFormat !== 'string'
      || !Number.isSafeInteger(validation.width) || Number(validation.width) <= 0
      || !Number.isSafeInteger(validation.height) || Number(validation.height) <= 0
      || typeof validation.requestedSize !== 'string' || !/^\d+x\d+$/.test(validation.requestedSize)
      || delivery?.code === 'generated_dimensions_mismatch' && (validation.originalFormat !== 'png'
        || validation.requestedSize === `${validation.width}x${validation.height}`)
      || delivery?.code === 'generated_format_mismatch' && (validation.originalFormat === 'png'
        || validation.storedFormat !== validation.originalFormat)) return null;
    return delivery as unknown as StudioDimensionMismatch;
  } catch { return null; }
}

export function studioDimensionMismatch(task: DimensionMismatchTask) {
  const mismatch = studioOutputMismatch(task);
  return mismatch?.code === 'generated_dimensions_mismatch' ? mismatch : null;
}

export function studioOutputIssue(task: DimensionMismatchTask): StudioOutputIssue | null {
  const mismatch = studioOutputMismatch(task);
  if (!mismatch || !task.asset_id) return null;
  const requested = mismatch.validation.requestedSize.split('x').map(Number);
  const dimensionsMismatch = requested.length === 2
    && (requested[0] !== mismatch.validation.width || requested[1] !== mismatch.validation.height);
  const formatMismatch = mismatch.validation.originalFormat !== 'png';
  return {
    kind: dimensionsMismatch && formatMismatch ? 'specification_mismatch'
      : formatMismatch ? 'format_mismatch' : 'dimensions_mismatch',
    actual: { format: mismatch.validation.originalFormat || null, width: mismatch.validation.width, height: mismatch.validation.height },
    requested: { format: 'png', width: Number.isSafeInteger(requested[0]) ? requested[0] : null,
      height: Number.isSafeInteger(requested[1]) ? requested[1] : null },
    originalRetained: true,
  };
}

export function studioOutputFormat(format: string) {
  if (!['png', 'jpeg', 'webp', 'avif', 'tiff'].includes(format)) return null;
  return ({ png: { extension: 'png', mimeType: 'image/png' }, jpeg: { extension: 'jpg', mimeType: 'image/jpeg' },
    webp: { extension: 'webp', mimeType: 'image/webp' }, avif: { extension: 'avif', mimeType: 'image/avif' },
    tiff: { extension: 'tiff', mimeType: 'image/tiff' } } as Record<string, { extension: string; mimeType: string }>)[format] || null;
}

export function studioOutputMismatchDisposition(value: string | null | undefined) {
  return value === 'dimensions_mismatch' || value === 'format_mismatch';
}

export function studioOutputFormatForMime(mimeType: string | null | undefined) {
  return ['png', 'jpeg', 'webp', 'avif', 'tiff'].map(studioOutputFormat).find(value => value?.mimeType === mimeType) || null;
}

export function studioTaskHasViewableDimensionMismatch(task: DimensionMismatchTask) {
  return Boolean(task.asset_id && studioDimensionMismatch(task));
}

export function studioTaskHasViewableOutput(task: DimensionMismatchTask) {
  return Boolean(task.asset_id) && (task.status === 'succeeded' || Boolean(studioOutputMismatch(task)));
}

// Only use this database candidate filter together with the parsed predicate
// above at media/action boundaries. A generic failed asset is never an output.
export const studioOutputTaskWhere: Prisma.ImageStudioTaskWhereInput = { OR: [
  { status: 'succeeded' },
  { status: { in: studioTaskStates(['failed', 'uncertain']) }, asset_id: { not: null }, OR: [
    { usage_json: { contains: '"generated_dimensions_mismatch"' } }, { usage_json: { contains: '"generated_format_mismatch"' } },
  ] },
] };

export function studioDimensionMismatchNotice(validation: { width: number; height: number; requestedSize: string; originalFormat?: string }) {
  const actualFormat = validation.originalFormat?.toUpperCase() || 'PNG';
  return `图片已返回，实际为 ${actualFormat} ${validation.width}×${validation.height}，请求为 PNG ${validation.requestedSize.replace('x', '×')}。原文件已保留，可继续使用。`;
}
