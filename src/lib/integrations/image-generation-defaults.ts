import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { IMAGE_STUDIO_MODELS, type ImageStudioModel } from '@/lib/image-studio/model-catalog';
import type { ImageGenerationChannelId } from '@/lib/integrations/image-generation-channel';
import { IMAGE_25_QUALITY_MODEL, isImage25Quality, type ImageQualityRoutes, type ImageQualityRouteSnapshot } from '@/lib/image-studio/quality-routing';

export const IMAGE_GENERATION_MODEL_DEFAULTS_SETTING_KEY = 'image_generation_model_defaults_v1';

export type ImageGenerationDefaultRoutesDto = {
  revision: number;
  models: Partial<Record<ImageStudioModel, string>>;
  qualityRoutes?: ImageQualityRoutes;
};

export class ImageGenerationDefaultRoutesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageGenerationDefaultRoutesError';
  }
}

export class ImageGenerationQualityRouteError extends ImageGenerationDefaultRoutesError {
  readonly status = 409;
  readonly code = 'image_quality_route_unavailable';
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
    || Object.keys(parsed).some(key => !['version', 'revision', 'models', 'qualityRoutes'].includes(key))
    || parsed.version !== 1 && parsed.version !== 2
    || parsed.version === 1 && parsed.qualityRoutes !== undefined
    || parsed.version === 2 && !isRecord(parsed.qualityRoutes)
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

  const qualityRoutes: ImageQualityRoutes = {};
  if (isRecord(parsed.qualityRoutes)) for (const [model, routes] of Object.entries(parsed.qualityRoutes)) {
    if (model !== IMAGE_25_QUALITY_MODEL || !isRecord(routes)) throw new ImageGenerationDefaultRoutesError('图片质量路由格式无效');
    const choices: Partial<Record<'medium' | 'max', string>> = {};
    for (const [quality, id] of Object.entries(routes)) {
      if (!isImage25Quality(quality) || !isConcreteDefaultChannelId(id)) throw new ImageGenerationDefaultRoutesError('图片质量路由包含无效档位或通道');
      choices[quality] = id;
    }
    qualityRoutes[model] = choices;
  }
  return { revision: parsed.revision as number, models, ...(parsed.version === 2 ? { qualityRoutes } : {}) };
}

export function serializeImageGenerationDefaultRoutes(routes: ImageGenerationDefaultRoutesDto) {
  return JSON.stringify({ version: routes.qualityRoutes ? 2 : 1, ...routes });
}

/** New requests must resolve quality before considering any client channel or snapshot. */
export async function resolveImageGenerationRequestRoute(model: string, quality: unknown,
  requestedChannelId?: string | null, client: DefaultRoutesClient = prisma): Promise<{
    channelId: ImageGenerationChannelId | null; qualityRoute?: ImageQualityRouteSnapshot;
  }> {
  if (model !== IMAGE_25_QUALITY_MODEL) return { channelId: await resolveImageGenerationRequestChannel(model, requestedChannelId, client) };
  if (!isImage25Quality(quality)) throw new ImageGenerationQualityRouteError('原质量待选择，请明确选择中等或最高；输入和原请求已保留');
  const defaults = await getImageGenerationDefaultRoutes(client);
  const channelId = defaults.qualityRoutes?.[IMAGE_25_QUALITY_MODEL]?.[quality];
  if (!channelId) throw new ImageGenerationQualityRouteError(`${quality === 'medium' ? '中等' : '最高'}图片 API 尚未配置，未切换到其他档位`);
  if (requestedChannelId && requestedChannelId !== 'original' && requestedChannelId !== channelId) {
    throw new ImageGenerationQualityRouteError('所选图片通道与质量档位不符，请重新报价；未切换 API');
  }
  return { channelId, qualityRoute: { model: IMAGE_25_QUALITY_MODEL, quality, revision: defaults.revision } };
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
  model: string,
  requestedChannelId?: string | null,
  client: DefaultRoutesClient = prisma,
  quality?: unknown,
): Promise<ImageGenerationChannelId | null> {
  if (model === IMAGE_25_QUALITY_MODEL && quality !== undefined) return (await resolveImageGenerationRequestRoute(model, quality, requestedChannelId, client)).channelId;
  const validatedModel = IMAGE_STUDIO_MODELS.find(allowedModel => allowedModel === model);
  if (!validatedModel) {
    throw new ImageGenerationDefaultRoutesError('所选图片型号不在允许列表中');
  }
  if (requestedChannelId !== undefined && requestedChannelId !== null && requestedChannelId !== 'original') {
    return requestedChannelId;
  }
  const defaults = await getImageGenerationDefaultRoutes(client);
  if (defaults.models[validatedModel]) return defaults.models[validatedModel]!;
  const legacyChannel = validatedModel.startsWith('gemini-') ? 'banana' : 'shared';
  const { hasLegacyImageGenerationModelOverride } = await import('@/lib/integrations/image-generation');
  return await hasLegacyImageGenerationModelOverride(validatedModel, legacyChannel, client) ? legacyChannel : null;
}
