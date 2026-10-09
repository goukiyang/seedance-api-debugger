import { prisma } from '@/lib/prisma';
import { IMAGE_STUDIO_MODELS } from './model-catalog';
import type { Prisma } from '@prisma/client';
import { defaultStudioTemplateDefaults, parseStudioTemplateDefaults, type StudioTemplateDefaults } from './template-defaults';

export { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_COST_USD, IMAGE_STUDIO_MODEL_LABELS } from './model-catalog';

export const IMAGE_STUDIO_SETTING_KEY = 'gpt_image_studio_v1';
export type ImageStudioSettings = {
  context: string;
  model: typeof IMAGE_STUDIO_MODELS[number];
  revision: number;
  prices: Record<typeof IMAGE_STUDIO_MODELS[number], number | null>;
  templateDefaults?: StudioTemplateDefaults;
};

// Pro keeps an explicit opt-in price because its upstream cost is higher.
export const DEFAULT_STUDIO_PRICES = Object.fromEntries(IMAGE_STUDIO_MODELS.map(model => [
  model,
  model === 'gemini-3-pro-image-preview' ? null : 20,
])) as ImageStudioSettings['prices'];

function decodeSettings(value: ImageStudioSettings): ImageStudioSettings & { templateDefaults: StudioTemplateDefaults } {
  if (!IMAGE_STUDIO_MODELS.includes(value.model) || typeof value.context !== 'string' || !Number.isInteger(value.revision)) {
    throw new Error('图片生成设置暂时无法读取');
  }
  return { ...value, prices: { ...DEFAULT_STUDIO_PRICES, ...value.prices },
    templateDefaults: value.templateDefaults === undefined ? defaultStudioTemplateDefaults(value.model) : parseStudioTemplateDefaults(value.templateDefaults) };
}

export async function getImageStudioSettings(client: Pick<Prisma.TransactionClient, 'platformSetting'> = prisma) {
  const row = await client.platformSetting.findUnique({ where: { key: IMAGE_STUDIO_SETTING_KEY } });
  return decodeSettings(row ? JSON.parse(row.value_json) : { context: '', model: IMAGE_STUDIO_MODELS[0], revision: 0, prices: { ...DEFAULT_STUDIO_PRICES } });
}

export function imageStudioSettingsPayload(settings: ImageStudioSettings, isAdmin: boolean) {
  return {
    model: settings.model, prices: settings.prices, revision: settings.revision,
    templateDefaults: settings.templateDefaults === undefined ? defaultStudioTemplateDefaults(settings.model) : parseStudioTemplateDefaults(settings.templateDefaults),
    contextConfigured: Boolean(settings.context.trim()),
    billing: { mode: 'per_submission', actualChargeEnabled: false, requiresConfirmedQuote: true,
      pointsPerUsd: 35, multiplier: 1, creditPrecision: 0.01, oldTasksRebilled: false },
    ...(isAdmin ? { context: settings.context } : {}),
  };
}

export class StudioSettingsClearConfirmationError extends Error {
  constructor() { super('清空通用上下文需要明确确认，请刷新页面后重试'); }
}

export async function saveImageStudioSettings(input: ImageStudioSettings, userId: string, options: { confirmContextClear?: boolean } = {}) {
  return prisma.$transaction(async (tx) => {
    const row = await tx.platformSetting.findUnique({ where: { key: IMAGE_STUDIO_SETTING_KEY } });
    const current = row ? JSON.parse(row.value_json) as ImageStudioSettings : null;
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== input.revision) return null;
    if (current?.context.trim() && !input.context.trim() && options.confirmContextClear !== true) {
      throw new StudioSettingsClearConfirmationError();
    }
    // Omitted defaults from an older client must preserve the current JSON extension.
    const next = { ...current, context: input.context, model: input.model, prices: input.prices, revision: currentRevision + 1,
      ...(input.templateDefaults === undefined ? {} : { templateDefaults: parseStudioTemplateDefaults(input.templateDefaults) }) };
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
    return decodeSettings(next);
  });
}
