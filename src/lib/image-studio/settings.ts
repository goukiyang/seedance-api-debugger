import { prisma } from '@/lib/prisma';
import { IMAGE_STUDIO_MODELS } from './model-catalog';

export { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_COST_USD, IMAGE_STUDIO_MODEL_LABELS } from './model-catalog';

export const IMAGE_STUDIO_SETTING_KEY = 'gpt_image_studio_v1';
export type ImageStudioSettings = {
  context: string;
  model: typeof IMAGE_STUDIO_MODELS[number];
  revision: number;
  prices: Record<typeof IMAGE_STUDIO_MODELS[number], number | null>;
};

// Pro keeps an explicit opt-in price because its upstream cost is higher.
export const DEFAULT_STUDIO_PRICES = Object.fromEntries(IMAGE_STUDIO_MODELS.map(model => [
  model,
  model === 'gemini-3-pro-image-preview' ? null : 20,
])) as ImageStudioSettings['prices'];

export async function getImageStudioSettings(): Promise<ImageStudioSettings> {
  const row = await prisma.platformSetting.findUnique({ where: { key: IMAGE_STUDIO_SETTING_KEY } });
  if (!row) return { context: '', model: IMAGE_STUDIO_MODELS[0], revision: 0, prices: { ...DEFAULT_STUDIO_PRICES } };
  const value = JSON.parse(row.value_json) as ImageStudioSettings;
  if (!IMAGE_STUDIO_MODELS.includes(value.model) || typeof value.context !== 'string' || !Number.isInteger(value.revision)) {
    throw new Error('图片生成设置暂时无法读取');
  }
  return { ...value, prices: { ...DEFAULT_STUDIO_PRICES, ...value.prices } };
}

export async function saveImageStudioSettings(input: ImageStudioSettings, userId: string) {
  return prisma.$transaction(async (tx) => {
    const row = await tx.platformSetting.findUnique({ where: { key: IMAGE_STUDIO_SETTING_KEY } });
    const currentRevision = row ? (JSON.parse(row.value_json) as ImageStudioSettings).revision : 0;
    if (currentRevision !== input.revision) return null;
    const next = { context: input.context, model: input.model, prices: input.prices, revision: currentRevision + 1 };
    if (row) {
      const updated = await tx.platformSetting.updateMany({
        where: { id: row.id, value_json: row.value_json },
        data: { value_json: JSON.stringify(next), updated_by: userId },
      });
      if (!updated.count) return null;
    } else {
      await tx.platformSetting.create({ data: {
        key: IMAGE_STUDIO_SETTING_KEY, value_json: JSON.stringify(next), updated_by: userId,
      } });
    }
    return next;
  });
}
