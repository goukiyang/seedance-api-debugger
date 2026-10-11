import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { IMAGE_STUDIO_MODELS, type ImageStudioModel } from '@/lib/image-studio/model-catalog';
import type { ImageGenerationChannelId } from '@/lib/integrations/image-generation-channel';

export const IMAGE_GENERATION_MODEL_DEFAULTS_SETTING_KEY = 'image_generation_model_defaults_v1';

export type ImageGenerationDefaultRoutesDto = {
  revision: number;
  models: Partial<Record<ImageStudioModel, string>>;
};

export class ImageGenerationDefaultRoutesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageGenerationDefaultRoutesError';
  }
}

type DefaultRoutesClient = Prisma.TransactionClient | typeof prisma;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isConcreteDefaultChannelId(value: unknown): value is string {
  return value === 'shared' || value === 'banana' || value === 'fluxport'
    || (typeof value === 'string'
      && /^image-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

/** A missing row means the historical default route; a present malformed row must never be treated as empty. */
export function parseImageGenerationDefaultRoutes(rawJson: string | null | undefined): ImageGenerationDefaultRoutesDto {
  if (rawJson === null || rawJson === undefined) return { revision: 0, models: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new ImageGenerationDefaultRoutesError('图片型号默认供应商设置内容无法读取；未按空设置处理');
  }
  if (!isRecord(parsed)
    || Object.keys(parsed).some(key => !['version', 'revision', 'models'].includes(key))
    || parsed.version !== 1
    || !Number.isSafeInteger(parsed.revision)
    || (parsed.revision as number) < 0
    || !isRecord(parsed.models)) {
    throw new ImageGenerationDefaultRoutesError('图片型号默认供应商设置格式无效；未按空设置处理');
  }

  const models: ImageGenerationDefaultRoutesDto['models'] = {};
  for (const [model, channelId] of Object.entries(parsed.models)) {
    if (!IMAGE_STUDIO_MODELS.includes(model as ImageStudioModel) || !isConcreteDefaultChannelId(channelId)) {
      throw new ImageGenerationDefaultRoutesError('图片型号默认供应商设置包含无效型号或通道编号；未按空设置处理');
    }
    models[model as ImageStudioModel] = channelId;
  }

  return { revision: parsed.revision as number, models };
}

export async function getImageGenerationDefaultRoutes(
  client: DefaultRoutesClient = prisma,
): Promise<ImageGenerationDefaultRoutesDto> {
  const row = await client.platformSetting.findUnique({
    where: { key: IMAGE_GENERATION_MODEL_DEFAULTS_SETTING_KEY },
    select: { value_json: true },
  });
  return parseImageGenerationDefaultRoutes(row?.value_json);
}

/** Resolves a new request's explicit channel or model default; null means the legacy Gemini/Banana or shared route. */
export async function resolveImageGenerationRequestChannel(
  model: ImageStudioModel,
  requestedChannelId?: string | null,
  client: DefaultRoutesClient = prisma,
): Promise<ImageGenerationChannelId | null> {
  if (!IMAGE_STUDIO_MODELS.includes(model)) {
    throw new ImageGenerationDefaultRoutesError('所选图片型号不在允许列表中');
  }
  if (requestedChannelId !== undefined && requestedChannelId !== null && requestedChannelId !== 'original') {
    return requestedChannelId;
  }
  const defaults = await getImageGenerationDefaultRoutes(client);
  return defaults.models[model] || null;
}
