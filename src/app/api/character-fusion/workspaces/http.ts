import { NextRequest, NextResponse } from 'next/server';
import { AuthError } from '@/lib/auth/session';
import { FusionError } from '@/lib/character-fusion/actions';
export const fusionJson = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
export function fusionFailure(error: unknown) {
  if (error instanceof FusionError) return fusionJson({ error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) }, error.status);
  if (error instanceof AuthError) return fusionJson({ error: error.message, code: 'FUSION_AUTH' }, error.status);
  if (error instanceof SyntaxError) return fusionJson({ error: '请求内容不是有效JSON，请保留草稿。', code: 'FUSION_INVALID' }, 400);
  if (error instanceof Error && 'status' in error && 'code' in error && error.code === 'FUSION_WRITES_DISABLED') return fusionJson({ error: error.message, code: error.code }, 503);
  return fusionJson({ error: '本次操作尚未确认，请按原操作编号查询；输入和结果仍保留。', code: 'FUSION_UNCONFIRMED' }, 503);
}
export async function readFusionBody(request: NextRequest): Promise<unknown> {
  const raw = await request.text();
  if (raw.length > 3000000) throw new FusionError('一次操作内容过大，请分批处理。', 413, 'FUSION_TOO_LARGE');
  return JSON.parse(raw);
}
export function fusionLimit(value: string | null, fallback: number) { return value === null ? fallback : Number(value); }
