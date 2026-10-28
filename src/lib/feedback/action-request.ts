import { FeedbackFlowError } from './flow-state';

export async function feedbackRequestText(request: Request, maximum: number) {
  if (Number(request.headers.get('content-length') || 0) > maximum) throw new FeedbackFlowError('请求内容过大', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new FeedbackFlowError('请求内容无效', 400);
  const chunks: Uint8Array[] = []; let length = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    length += value.byteLength;
    if (length > maximum) { await reader.cancel(); throw new FeedbackFlowError('请求内容过大', 413); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export async function feedbackActionJson(request: Request) {
  try {
    const value: unknown = JSON.parse(await feedbackRequestText(request, 512 * 1024));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FeedbackFlowError('请求内容无效', 400);
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof FeedbackFlowError) throw error;
    throw new FeedbackFlowError('请求内容无效', 400);
  }
}
