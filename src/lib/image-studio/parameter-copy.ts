import type { Prisma } from '@prisma/client';
import { IMAGE_STUDIO_MODELS, imageStudioNewQualityOptions, IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS, type ImageStudioModel } from './model-catalog';
import { normalizeStudioRatio } from './ratios';
import { validStudioPresetId } from './preset-id';
import type { SharedStudioPersonalOverrides } from './shared-types';

export const parameterCopyKey = (id: string) => `studio_parameter_copy_v1:${id}`;
export const isParameterCopyId = (id: string) => /^parameter-copy-[0-9a-f-]{36}$/.test(id);
export type StudioParameterCopy = {
  version: 1; ownerId: string; presetId: string; rootPresetId: string;
  styleGroupIds: string[];
  parameters: Required<Omit<SharedStudioPersonalOverrides, 'prompt'>>;
};

// Missing linkage never falls through to the intentionally empty text columns.
export async function readStudioParameterCopy(client: Pick<Prisma.TransactionClient, 'platformSetting'>,
  source: { id: string; owner_id: string }): Promise<StudioParameterCopy | null> {
  if (!isParameterCopyId(source.id)) return null;
  const row = await client.platformSetting.findUnique({ where: { key: parameterCopyKey(source.id) }, select: { value_json: true } });
  const value = JSON.parse(row?.value_json || 'null');
  const p = value?.parameters;
  if (value?.version !== 1 || value.ownerId !== source.owner_id || value.presetId !== source.id
    || !validStudioPresetId(value.rootPresetId) || isParameterCopyId(value.rootPresetId)
    || !Array.isArray(value.styleGroupIds) || value.styleGroupIds.length > 32 || value.styleGroupIds.some((id: unknown) => typeof id !== 'string' || !id || id.length > 160)
    || !p || Object.keys(p).sort().join(',') !== 'aspectRatio,count,model,quality,resolution'
    || !IMAGE_STUDIO_MODELS.includes(p.model) || !imageStudioNewQualityOptions(p.model).includes(p.quality)
    || !IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS[p.model as ImageStudioModel]?.includes(p.resolution)
    || !Number.isSafeInteger(p.count) || p.count < 1 || p.count > 8 || normalizeStudioRatio(p.aspectRatio) !== p.aspectRatio) {
    throw new Error('个人参数模板来源无法确认，请保留当前输入重新读取');
  }
  return value as StudioParameterCopy;
}
