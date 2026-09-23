import { IMAGE_STUDIO_MODELS } from './settings';
import { readStudioImage } from './media';
import { MAX_REFERENCE_IMAGES } from './limits';
import { isGeminiImageModel, isValidImageDimension } from '@/lib/image-generation/resolution';

export type StudioImageInput = { bytes: Uint8Array; mimeType: string };

const GEMINI_IMAGE_MODELS = new Set([
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
]);

export class StudioProviderError extends Error {
  constructor(public stage: 'request' | 'response' | 'download', public code: string, public status?: number) {
    super(`图片服务处理失败（${code}）`);
    this.name = 'StudioProviderError';
  }
}

// Keep GPT image requests isolated from the existing Gemini/Seedream adapters.
export async function requestStudioImages(params: {
  baseUrl: string; apiKey: string; model: string; prompt: string;
  provider?: 'musk' | 'ai_media_vip';
  quality?: string;
  count: number; images: StudioImageInput[]; signal: AbortSignal; ratio?: string;
  size?: string;
}, fetcher: typeof fetch = fetch, readImage: typeof readStudioImage = readStudioImage): Promise<{ images: string[]; usage: unknown }> {
  if (!IMAGE_STUDIO_MODELS.includes(params.model as typeof IMAGE_STUDIO_MODELS[number])) throw new Error('不支持的图片模型');
  if (!Number.isInteger(params.count) || params.count < 1 || params.count > 8) throw new Error('生成张数必须为 1 到 8');
  if (params.images.length > MAX_REFERENCE_IMAGES) throw new Error(`最多使用 ${MAX_REFERENCE_IMAGES} 张参考图`);
  if (params.size && (!isGeminiImageModel(params.model) || params.provider === 'ai_media_vip') && !isValidImageDimension(params.size)) {
    throw new Error('生成尺寸无效');
  }
  if (params.provider !== 'ai_media_vip' && GEMINI_IMAGE_MODELS.has(params.model)) {
    return requestGeminiStudioImages(params, fetcher);
  }
  const url = new URL(params.baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '').replace(/\/v1$/, '')}/v1/images/${params.images.length ? 'edits' : 'generations'}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${params.apiKey}` };
  let body: BodyInit;
  if (params.images.length) {
    const form = new FormData();
    form.set('model', params.model);
    form.set('prompt', params.prompt);
    form.set('n', String(params.count));
    form.set('output_format', 'png');
    if (params.quality && params.quality !== 'auto') form.set('quality', params.quality);
    if (params.size) form.set('size', params.size);
    params.images.forEach((image, index) => {
      form.append('image[]', new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }), `reference-${index + 1}.${image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType === 'image/webp' ? 'webp' : 'png'}`);
    });
    body = form;
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({ model: params.model, prompt: params.prompt, n: params.count, output_format: 'png', ...(params.size ? { size: params.size } : {}), ...(params.quality && params.quality !== 'auto' ? { quality: params.quality } : {}) });
  }
  let response: Response;
  try { response = await fetcher(url, { method: 'POST', headers, body, signal: params.signal }); }
  catch { throw new StudioProviderError('request', params.signal.aborted ? 'timeout' : 'network'); }
  if (!response.ok) throw new StudioProviderError('request', 'http_error', response.status);
  const value = await response.json().catch(() => { throw new StudioProviderError('response', 'invalid_json', response.status); });
  if (!Array.isArray(value?.data) || !value.data.length) throw new StudioProviderError('response', 'empty_output', response.status);
  if (value.data.length > params.count) throw new StudioProviderError('response', 'unexpected_count', response.status);
  const images: string[] = [];
  for (const item of value.data) {
    if (typeof item?.b64_json === 'string' && item.b64_json.length) {
      if (item.b64_json.length > 28 * 1024 * 1024) throw new StudioProviderError('response', 'image_too_large', response.status);
      images.push(item.b64_json);
    } else if (typeof item?.url === 'string' && item.url.length) {
      try {
        if (new URL(item.url).protocol !== 'https:') throw new Error('HTTPS required');
        images.push((await readImage(item.url, params.signal)).toString('base64'));
      } catch { throw new StudioProviderError('download', 'image_download_failed', response.status); }
    } else {
      throw new StudioProviderError('response', 'unsupported_output', response.status);
    }
  }
  return { images, usage: value.usage ?? null };
}

async function requestGeminiStudioImages(params: {
  baseUrl: string; apiKey: string; model: string; prompt: string;
  count: number; images: StudioImageInput[]; signal: AbortSignal; ratio?: string; size?: string;
}, fetcher: typeof fetch): Promise<{ images: string[]; usage: unknown }> {
  const url = new URL(params.baseUrl);
  const basePath = url.pathname.replace(/\/$/, '').replace(/\/v1$/, '').replace(/\/v1beta$/, '');
  url.pathname = `${basePath}/v1beta/models/${encodeURIComponent(params.model)}:generateContent`;
  const parts: Array<Record<string, unknown>> = [{ text: params.prompt }];
  for (const image of params.images) {
    parts.push({ inlineData: { mimeType: image.mimeType, data: Buffer.from(image.bytes).toString('base64') } });
  }
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${params.apiKey}` },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: {
            ...(params.ratio ? { aspectRatio: params.ratio } : {}),
            ...(params.size ? { imageSize: params.size } : {}),
          },
        },
      }),
      signal: params.signal,
    });
  } catch {
    throw new StudioProviderError('request', params.signal.aborted ? 'timeout' : 'network');
  }
  const value = await response.json().catch(() => { throw new StudioProviderError('response', 'invalid_json', response.status); });
  if (!response.ok) throw new StudioProviderError('request', 'http_error', response.status);
  const images = (value?.candidates || []).flatMap((candidate: { content?: { parts?: Array<Record<string, unknown>> } }) => candidate.content?.parts || [])
    .map((part: Record<string, unknown>) => {
      const inline = (part.inlineData || part.inline_data) as { data?: unknown } | undefined;
      return typeof inline?.data === 'string' ? inline.data : null;
    })
    .filter((image: unknown): image is string => typeof image === 'string' && image.length > 0);
  if (!images.length) throw new StudioProviderError('response', 'empty_output', response.status);
  return { images: images.slice(0, params.count), usage: value.usageMetadata || value.usage || null };
}
