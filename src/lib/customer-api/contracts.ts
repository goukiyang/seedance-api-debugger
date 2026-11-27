import { SEEDANCE_2_5_IP_MODEL_ID, isSeedanceVideoDuration, seedanceVideoDurationOptions } from '@/lib/provider/seedance-models';
import { volcengineIpModelResolutions } from '@/lib/integrations/volcengine-ip-models';
import { seedanceReferenceMediaCapabilities } from '@/lib/provider/reference-media-policy';
import { exceedsGenerationPromptLimit } from '@/lib/prompt/limits';
import { CustomerApiError, digest, stringList, type ApiContext } from './auth';

export const PUBLIC_IP_MODEL = 'seedance-2.5-ip';
export const INTERNAL_IP_MODEL = SEEDANCE_2_5_IP_MODEL_ID;
export const API_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const MODES = ['all_in_one_reference', 'first_last_frame', 'smart_multi_frame'];

export type ApiVideoInput = {
  model: string; prompt: string; duration: number; resolution: string; ratio: string; generation_mode: string;
  seed: number; generate_audio: boolean; watermark: boolean;
  image_assets: string[]; video_assets: string[]; audio_assets: string[];
  first_frame_asset: string | null; last_frame_asset: string | null; frame_assets: string[];
};

export function normalizeVideoInput(value: unknown): ApiVideoInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CustomerApiError('INVALID_INPUT', '需要 input 对象。');
  const v = value as Record<string, unknown>;
  const allowed = ['model', 'prompt', 'duration', 'resolution', 'ratio', 'generation_mode', 'seed', 'generate_audio', 'watermark',
    'image_assets', 'video_assets', 'audio_assets', 'first_frame_asset', 'last_frame_asset', 'frame_assets'];
  if (Object.keys(v).some(k => !allowed.includes(k))) throw new CustomerApiError('UNKNOWN_FIELD', 'input 包含不支持的字段；请仅使用协议中的参数。');
  if (v.model !== PUBLIC_IP_MODEL || typeof v.prompt !== 'string' || !v.prompt.trim() || Boolean(exceedsGenerationPromptLimit(v.prompt))) throw new CustomerApiError('INVALID_INPUT', '型号或提示词无效。');
  const duration = v.duration, resolution = v.resolution, ratio = v.ratio ?? '16:9', mode = v.generation_mode ?? 'all_in_one_reference';
  if (typeof duration !== 'number' || !isSeedanceVideoDuration(duration, INTERNAL_IP_MODEL)
    || typeof resolution !== 'string' || !volcengineIpModelResolutions(INTERNAL_IP_MODEL).includes(resolution)
    || typeof ratio !== 'string' || !API_RATIOS.includes(ratio) || typeof mode !== 'string' || !MODES.includes(mode)) throw new CustomerApiError('INVALID_SPECIFICATION', '时长、分辨率、比例或模式不受支持。');
  const seed = v.seed ?? -1;
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < -1 || seed > 2147483647) throw new CustomerApiError('INVALID_SEED', 'seed 无效。');
  for (const k of ['generate_audio', 'watermark']) if (v[k] !== undefined && typeof v[k] !== 'boolean') throw new CustomerApiError('INVALID_INPUT', `${k} 必须是布尔值。`);
  const asset = (raw: unknown) => { if (typeof raw !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(raw)) throw new CustomerApiError('INVALID_ASSET', '素材编号无效。'); return raw; };
  const list = (key: string) => { if (v[key] === undefined) return []; if (!Array.isArray(v[key]) || v[key].length > 30) throw new CustomerApiError('INVALID_ASSET', '素材列表无效。'); return (v[key] as unknown[]).map(asset); };
  const input: ApiVideoInput = { model: PUBLIC_IP_MODEL, prompt: v.prompt.trim(), duration, resolution, ratio, generation_mode: mode,
    seed, generate_audio: v.generate_audio !== false, watermark: v.watermark === true,
    image_assets: list('image_assets'), video_assets: list('video_assets'), audio_assets: list('audio_assets'), frame_assets: list('frame_assets'),
    first_frame_asset: v.first_frame_asset == null ? null : asset(v.first_frame_asset), last_frame_asset: v.last_frame_asset == null ? null : asset(v.last_frame_asset) };
  const caps = seedanceReferenceMediaCapabilities(INTERNAL_IP_MODEL);
  const images = [...input.image_assets, ...input.frame_assets, ...[input.first_frame_asset, input.last_frame_asset].filter(Boolean)];
  if (images.length > caps.imageLimit || input.video_assets.length > caps.videoLimit || input.audio_assets.length > caps.audioLimit) throw new CustomerApiError('REFERENCE_LIMIT', '素材数量超过型号限制。');
  if (mode !== 'all_in_one_reference' && (input.video_assets.length || input.audio_assets.length)
    || mode === 'all_in_one_reference' && (input.frame_assets.length || input.first_frame_asset || input.last_frame_asset)
    || mode === 'first_last_frame' && (!input.first_frame_asset || input.image_assets.length || input.frame_assets.length)
    || mode === 'smart_multi_frame' && (input.frame_assets.length < 2 || input.image_assets.length || input.first_frame_asset || input.last_frame_asset)) throw new CustomerApiError('REFERENCE_MODE', '素材槽位与生成模式不匹配。');
  if (input.audio_assets.length && !images.length && !input.video_assets.length && !caps.audioOnly) throw new CustomerApiError('REFERENCE_MODE', '音频参考需要同时提供图片或视频。');
  return input;
}

export function inputHash(input: ApiVideoInput) { return digest(JSON.stringify(input)); }
export function publicModels(context: ApiContext) {
  if (!stringList(context.customer.models_json).includes(PUBLIC_IP_MODEL) || !stringList(context.key.models_json).includes(PUBLIC_IP_MODEL)) return [];
  return [{ id: PUBLIC_IP_MODEL, durations: seedanceVideoDurationOptions(INTERNAL_IP_MODEL), resolutions: volcengineIpModelResolutions(INTERNAL_IP_MODEL),
    ratios: API_RATIOS, generation_modes: MODES, reference_media: seedanceReferenceMediaCapabilities(INTERNAL_IP_MODEL), first_frame_ratio: 'adaptive' }];
}

export function budgetPeriod(timezone: string, now = new Date()) {
  let parts: Intl.DateTimeFormatPart[];
  try { parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now); }
  catch { throw new CustomerApiError('CONFIGURATION_REQUIRED', '客户预算时区无效。', 503); }
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return { day: `${part('year')}-${part('month')}-${part('day')}`, month: `${part('year')}-${part('month')}` };
}
