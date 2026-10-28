import { NextResponse } from 'next/server';
import { AuthError } from '@/lib/auth/session';
import { VideoFeishuError } from './feishu-contract';

const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie' };
export const videoFeishuResponse = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });
export function videoFeishuHttpError(error: unknown) {
  if (error instanceof VideoFeishuError) return videoFeishuResponse({ error: error.code }, error.status);
  if (error instanceof AuthError) return videoFeishuResponse({ error: 'account_unavailable' }, error.status);
  return videoFeishuResponse({ error: 'video_notification_unavailable' }, 503);
}
export async function videoFeishuJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json') || !request.body) throw new VideoFeishuError('invalid_json', 400);
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 1024) throw new VideoFeishuError('invalid_json', 400);
      chunks.push(next.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new VideoFeishuError('invalid_json', 400);
    return value as Record<string, unknown>;
  } catch { throw new VideoFeishuError('invalid_json', 400); }
  finally { await reader.cancel().catch(() => undefined); }
}
