import { IMAGE_STUDIO_MODELS } from './settings';

export type StudioImageInput = { bytes: Uint8Array; mimeType: string };

// Keep GPT image requests isolated from the existing Gemini/Seedream adapters.
export async function requestStudioImages(params: {
  baseUrl: string; apiKey: string; model: string; prompt: string;
  count: number; images: StudioImageInput[]; signal: AbortSignal;
}, fetcher: typeof fetch = fetch): Promise<{ images: string[]; usage: unknown }> {
  if (!IMAGE_STUDIO_MODELS.includes(params.model as typeof IMAGE_STUDIO_MODELS[number])) throw new Error('不支持的图片模型');
  if (!Number.isInteger(params.count) || params.count < 1 || params.count > 8) throw new Error('生成张数必须为 1 到 8');
  if (params.images.length > 2) throw new Error('最多使用两张参考图');
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
    params.images.forEach((image, index) => {
      form.append('image[]', new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }), `reference-${index + 1}.${image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType === 'image/webp' ? 'webp' : 'png'}`);
    });
    body = form;
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({ model: params.model, prompt: params.prompt, n: params.count, output_format: 'png' });
  }
  const response = await fetcher(url, { method: 'POST', headers, body, signal: params.signal });
  if (!response.ok) throw new Error(`图片服务暂时未能完成请求（${response.status}），请勿连续重复提交`);
  const value = await response.json();
  const images = Array.isArray(value.data) ? value.data.map((item: { b64_json?: unknown }) => item.b64_json)
    .filter((item: unknown): item is string => typeof item === 'string' && item.length > 0) : [];
  if (!images.length) throw new Error('图片服务未返回可保存的图片');
  if (images.length > params.count) throw new Error('图片服务返回数量异常');
  return { images, usage: value.usage ?? null };
}
