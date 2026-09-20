import { prisma } from '@/lib/prisma';

export const IMAGE_STUDIO_SETTING_KEY = 'gpt_image_studio_v1';
export const IMAGE_STUDIO_MODELS = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'] as const;
export type ImageStudioSettings = {
  context: string;
  model: typeof IMAGE_STUDIO_MODELS[number];
  revision: number;
};

export async function getImageStudioSettings(): Promise<ImageStudioSettings> {
  const row = await prisma.platformSetting.findUnique({ where: { key: IMAGE_STUDIO_SETTING_KEY } });
  if (!row) return { context: '', model: IMAGE_STUDIO_MODELS[0], revision: 0 };
  const value = JSON.parse(row.value_json) as ImageStudioSettings;
  if (!IMAGE_STUDIO_MODELS.includes(value.model) || typeof value.context !== 'string' || !Number.isInteger(value.revision)) {
    throw new Error('图片生成设置暂时无法读取');
  }
  return value;
}

export async function saveImageStudioSettings(input: ImageStudioSettings, userId: string) {
  return prisma.$transaction(async (tx) => {
    const row = await tx.platformSetting.findUnique({ where: { key: IMAGE_STUDIO_SETTING_KEY } });
    const currentRevision = row ? (JSON.parse(row.value_json) as ImageStudioSettings).revision : 0;
    if (currentRevision !== input.revision) return null;
    const next = { context: input.context, model: input.model, revision: currentRevision + 1 };
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
