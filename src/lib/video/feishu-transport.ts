import { VIDEO_FEISHU_MAX_BYTES, VideoFeishuError, videoFeishuId } from './feishu-contract';

async function request(endpoint: 'files' | 'images' | 'messages?receive_id_type=open_id', token: string, body: FormData | string) {
  try {
    const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/${endpoint}`, { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(typeof body === 'string' ? 10_000 : 45_000), headers: {
        Authorization: `Bearer ${token}`, ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      }, body });
    if (!response.ok) throw new VideoFeishuError('feishu_rejected', 503, response.status >= 500 || response.status === 408,
      response.status === 429 || response.status >= 500 || response.status === 408);
    const reader = response.body?.getReader();
    if (!reader) throw new VideoFeishuError('feishu_receipt_unknown', 503, true, true);
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 64 * 1024) throw new VideoFeishuError('feishu_receipt_unknown', 503, true, true);
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { code?: unknown; data?: Record<string, unknown> };
    if (typeof value.code !== 'number') throw new VideoFeishuError('feishu_receipt_unknown', 503, true, true);
    if (value.code !== 0) throw new VideoFeishuError('feishu_rejected', 503, false, value.code === 99991400);
    if (!value.data) throw new VideoFeishuError('feishu_receipt_unknown', 503, true, true);
    return value.data;
  } catch (error) {
    if (error instanceof VideoFeishuError) throw error;
    // Never retain provider bodies, credentials, request content or raw exception messages.
    throw new VideoFeishuError('feishu_receipt_unknown', 503, true, true);
  }
}
export async function uploadVideoFeishuFile(token: string, taskId: string, file: Blob, durationMs: number, frozenFileName?: string) {
  if (!videoFeishuId(taskId) || file.type !== 'video/mp4' || file.size < 1 || file.size > VIDEO_FEISHU_MAX_BYTES
    || !Number.isSafeInteger(durationMs) || durationMs <= 0) throw new VideoFeishuError('video_file_invalid', 409);
  const fileName = frozenFileName ?? `video-${taskId}.mp4`;
  if (frozenFileName !== undefined && (!fileName.endsWith(`-${taskId}.mp4`) || new TextEncoder().encode(fileName).byteLength > 240 || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(fileName))) throw new VideoFeishuError('video_file_invalid', 409);
  const form = new FormData();
  form.set('file_type', 'mp4'); form.set('file_name', fileName); form.set('duration', String(durationMs));
  form.set('file', file, fileName);
  const data = await request('files', token, form);
  if (typeof data.file_key !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(data.file_key)) throw new VideoFeishuError('file_upload_unknown', 503, true);
  return data.file_key;
}
export async function uploadVideoFeishuCover(token: string, file: Blob) {
  if (file.type !== 'image/jpeg' || file.size < 1 || file.size > 1024 * 1024) throw new VideoFeishuError('cover_invalid', 409);
  const form = new FormData(); form.set('image_type', 'message'); form.set('image', file, 'cover.jpg');
  const data = await request('images', token, form);
  if (typeof data.image_key !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(data.image_key)) throw new VideoFeishuError('cover_upload_unknown', 503, true);
  return data.image_key;
}
export async function uploadImageFeishuOriginal(token: string, file: Blob, extension: string) {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/x-icon'].includes(file.type)
    || file.size < 1 || file.size > 10_000_000 || !/^[a-z]{2,5}$/.test(extension)) throw new VideoFeishuError('image_original_invalid', 409);
  const form = new FormData(); form.set('image_type', 'message'); form.set('image', file, `image.${extension}`);
  const data = await request('images', token, form);
  if (typeof data.image_key !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(data.image_key)) throw new VideoFeishuError('image_upload_unknown', 503, true);
  return data.image_key;
}
export async function uploadImageFeishuFile(token: string, file: Blob) {
  if (file.size < 1 || file.size > 30_000_000) throw new VideoFeishuError('image_original_invalid', 409);
  const form = new FormData(); form.set('file_type', 'stream'); form.set('file_name', '原图'); form.set('file', file, '原图');
  const data = await request('files', token, form);
  if (typeof data.file_key !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(data.file_key)) throw new VideoFeishuError('file_upload_unknown', 503, true);
  return data.file_key;
}
export async function sendVideoFeishuMessage(token: string, openId: string, uuid: string, type: 'media' | 'text' | 'image' | 'interactive' | 'file', content: Record<string, unknown>, deadline: number, leaseUntil: number) {
  if (!/^ou_[A-Za-z0-9_-]{1,180}$/.test(openId) || !/^[a-f0-9-]{36}$/.test(uuid)) throw new VideoFeishuError('binding_unavailable', 409);
  if (!Number.isSafeInteger(deadline) || !Number.isSafeInteger(leaseUntil) || Date.now() >= deadline || Date.now() >= leaseUntil) throw new VideoFeishuError('message_window_ended', 409);
  const data = await request('messages?receive_id_type=open_id', token, JSON.stringify({ receive_id: openId, uuid, msg_type: type, content: JSON.stringify(content) }));
  if (!videoFeishuId(data.message_id)) throw new VideoFeishuError('message_receipt_unknown', 503, true, true);
  return data.message_id;
}
