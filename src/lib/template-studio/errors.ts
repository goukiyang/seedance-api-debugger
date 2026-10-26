import { NextResponse } from 'next/server';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import type { StudioApiError } from './types';

export class StudioError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: NonNullable<StudioApiError['code']>,
    public readonly details?: StudioApiError['details'],
  ) {
    super(message);
    this.name = 'StudioError';
  }
}

export function requireInternalStudioUser(user: SessionUser) {
  assertInternalOnly(user, '外部账号无权访问视频模板工作台。');
}

export function studioErrorResponse(error: unknown) {
  if (error instanceof AuthError) {
    return NextResponse.json({ error: error.message, code: error.status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN' }, { status: error.status });
  }
  if (error instanceof StudioError) {
    return NextResponse.json({ error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) }, { status: error.status });
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: '请求内容不是有效 JSON', code: 'INVALID' }, { status: 400 });
  }
  console.error('[template-studio] request failed:', error instanceof Error ? error.name : 'unknown');
  return NextResponse.json({ error: '模板工作台暂时无法处理请求', code: 'UNAVAILABLE' }, { status: 500 });
}

export function toStudioValidationError(error: unknown): never {
  if (error instanceof StudioError) throw error;
  if (error instanceof Error && error.name === 'StudioValidationError') {
    throw new StudioError(error.message, 400, 'INVALID');
  }
  throw error;
}
