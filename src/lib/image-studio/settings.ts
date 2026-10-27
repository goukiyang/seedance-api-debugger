import { prisma } from '@/lib/prisma';
import { IMAGE_STUDIO_MODELS } from './model-catalog';
import type { Prisma } from '@prisma/client';
import { defaultStudioTemplateDefaults, parseStudioTemplateDefaults, type StudioTemplateDefaults } from './template-defaults';
import { privateOrigin } from '@/lib/security/private-prompts.server';
import { privateFieldOrigins, readPrivateFields, transferPrivateOrigins, writePrivateFields } from '@/lib/security/private-prompt-fields.server';
import { privatePromptRequestCapabilities, requirePrivatePromptRequest } from '@/lib/security/private-prompt-request.server';
import { getSession } from '@/lib/auth/session';

export { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_COST_USD, IMAGE_STUDIO_MODEL_LABELS } from './model-catalog';

export const IMAGE_STUDIO_SETTING_KEY = 'gpt_image_studio_v1';
export type ImageStudioSettings = {
  context: string;
  model: typeof IMAGE_STUDIO_MODELS[number];
  revision: number;
  prices: Record<typeof IMAGE_STUDIO_MODELS[number], number | null>;
  templateDefaults?: StudioTemplateDefaults;
};

// Newly introduced models require an explicit site price; unknown is never a default charge.
export const DEFAULT_STUDIO_PRICES = Object.fromEntries(IMAGE_STUDIO_MODELS.map(model => [
  model,
  (['gemini-3.1-flash-image-preview', 'gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'] as readonly string[]).includes(model) ? 20 : null,
])) as ImageStudioSettings['prices'];

function decodeSettings(value: ImageStudioSettings): ImageStudioSettings & { templateDefaults: StudioTemplateDefaults } {
  if (!IMAGE_STUDIO_MODELS.includes(value.model) || typeof value.context !== 'string' || !Number.isInteger(value.revision)) {
    throw new Error('图片生成设置暂时无法读取');
  }
  const result = { ...value, prices: { ...DEFAULT_STUDIO_PRICES, ...value.prices },
    templateDefaults: value.templateDefaults === undefined ? defaultStudioTemplateDefaults(value.model) : parseStudioTemplateDefaults(value.templateDefaults) };
  transferPrivateOrigins(value, result, ['context']);
  return result;
}

function readSettings(value: ImageStudioSettings) {
  const origin = privateOrigin('image-global', IMAGE_STUDIO_SETTING_KEY);
  return decodeSettings(readPrivateFields(value, 'image-global', IMAGE_STUDIO_SETTING_KEY,
    [{ field: 'context', origins: origin ? [origin] : [] }]));
}

export async function getImageStudioSettings(client: Pick<Prisma.TransactionClient, 'platformSetting'> = prisma) {
  const row = await client.platformSetting.findUnique({ where: { key: IMAGE_STUDIO_SETTING_KEY } });
  return readSettings(row ? JSON.parse(row.value_json) : { context: '', model: IMAGE_STUDIO_MODELS[0], revision: 0, prices: { ...DEFAULT_STUDIO_PRICES } });
}

export async function imageStudioSettingsPayload(settings: ImageStudioSettings, userId: string, includePrivate = false) {
  const origins = privateFieldOrigins(settings, 'context');
  const capabilities = await privatePromptRequestCapabilities(userId, origins);
  if (includePrivate) await requirePrivatePromptRequest(userId, origins);
  const legacyActor = origins.length ? null : await getSession().catch(() => null);
  return {
    model: settings.model, prices: settings.prices, revision: settings.revision,
    templateDefaults: settings.templateDefaults === undefined ? defaultStudioTemplateDefaults(settings.model) : parseStudioTemplateDefaults(settings.templateDefaults),
    contextConfigured: Boolean(settings.context.trim()),
    privateContext: origins.length > 0,
    billing: { mode: 'per_submission', actualChargeEnabled: false, requiresConfirmedQuote: true,
      pointsPerUsd: 35, multiplier: 1, creditPrecision: 0.01, oldTasksRebilled: false },
    ...capabilities,
    ...(includePrivate || legacyActor?.id === userId && legacyActor.role === 'admin' ? { context: settings.context } : {}),
  };
}

export class StudioSettingsClearConfirmationError extends Error {
  constructor() { super('清空通用上下文需要明确确认，请刷新页面后重试'); }
}

export async function saveImageStudioSettings(input: ImageStudioSettings, userId: string, options: { confirmContextClear?: boolean; privatePromptEdit?: boolean } = {}) {
  return prisma.$transaction(tx => saveImageStudioSettingsInTx(tx, input, userId, options));
}

export async function saveImageStudioSettingsInTx(tx: Prisma.TransactionClient, input: ImageStudioSettings, userId: string,
  options: { confirmContextClear?: boolean; skipUnchanged?: boolean; privatePromptEdit?: boolean } = {}) {
    const row = await tx.platformSetting.findUnique({ where: { key: IMAGE_STUDIO_SETTING_KEY } });
    const storedCurrent = row ? JSON.parse(row.value_json) as ImageStudioSettings : null;
    const current = storedCurrent ? readSettings(storedCurrent) : null;
    const origin = privateOrigin('image-global', IMAGE_STUDIO_SETTING_KEY);
    const origins = current ? privateFieldOrigins(current, 'context') : origin ? [origin] : [];
    if (origins.length && !options.privatePromptEdit) input = { ...input, context: current?.context ?? '' };
    const contextChanged = input.context !== (current?.context ?? '');
    if (contextChanged && origins.length) await requirePrivatePromptRequest(userId, origins);
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== input.revision) return null;
    const oldPrices = current ? decodeSettings(current).prices : DEFAULT_STUDIO_PRICES;
    if (IMAGE_STUDIO_MODELS.some(model => input.prices[model] !== oldPrices[model])) {
      throw new Error('收费点数已统一到点数定价页面；此旧入口未修改价格，请刷新后台');
    }
    if (current?.context.trim() && !input.context.trim() && options.confirmContextClear !== true) {
      throw new StudioSettingsClearConfirmationError();
    }
    if (options.skipUnchanged) {
      const decoded = current ? decodeSettings(current) : await getImageStudioSettings(tx);
      if (decoded.context === input.context && decoded.model === input.model
        && IMAGE_STUDIO_MODELS.every(model => decoded.prices[model] === input.prices[model])
        && (input.templateDefaults === undefined || JSON.stringify(decoded.templateDefaults) === JSON.stringify(parseStudioTemplateDefaults(input.templateDefaults)))) {
        // The resolution receipt is locked by its caller; an unchanged default is read-only.
        return decoded;
      }
    }
    // Omitted defaults from an older client must preserve the current JSON extension.
    const next = { ...current, context: input.context, model: input.model, prices: input.prices, revision: currentRevision + 1,
      ...(input.templateDefaults === undefined ? {} : { templateDefaults: parseStudioTemplateDefaults(input.templateDefaults) }) };
    const storedNext = contextChanged
      ? writePrivateFields(next, 'image-global', IMAGE_STUDIO_SETTING_KEY, [{ field: 'context', origins }])
      : { ...next, context: storedCurrent?.context ?? '' };
    if (row) {
      const updated = await tx.platformSetting.updateMany({
        where: { id: row.id, value_json: row.value_json },
        data: { value_json: JSON.stringify(storedNext), updated_by: userId },
      });
      if (!updated.count) return null;
    } else {
      await tx.platformSetting.create({ data: {
        key: IMAGE_STUDIO_SETTING_KEY, value_json: JSON.stringify(storedNext), updated_by: userId,
      } });
    }
    return readSettings(storedNext);
}
