import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { getSessionUser } from '@/lib/auth/api-helpers';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { authenticateCodexVideoApi, CodexApiAuthError, hasCodexApiAuthSignal } from '@/lib/integrations/codex';
import { CharacterAssetError } from '@/lib/character-assets/errors';

export async function withCharacterAssetUser(request: NextRequest, run: (user: SessionUser) => Promise<unknown>, status = 200) {
  try {
    const user = hasCodexApiAuthSignal(request) ? (await authenticateCodexVideoApi(request)).user : await getSessionUser(request);
    if (user.status !== 'active') throw new AuthError('账号已被禁用', 403);
    const data = await run(user);
    return NextResponse.json(data, { status, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2010'
      && String(error.meta?.message || '').includes('no such table: CharacterAsset')) {
      return NextResponse.json({ error: '角色目录升级尚未完成，请稍后重试；本次未保存', code: 'CHARACTER_ASSET_SCHEMA_REQUIRED' }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
    }
    if (error instanceof CharacterAssetError || error instanceof AuthError || error instanceof CodexApiAuthError) {
      return NextResponse.json({ error: error.message, code: 'code' in error ? error.code : 'UNAUTHORIZED' }, { status: error.status, headers: { 'Cache-Control': 'private, no-store' } });
    }
    console.error('[CharacterAssets]', error);
    return NextResponse.json({ error: '角色资料暂时无法保存或读取，请保留输入后重试', code: 'CHARACTER_ASSET_UNAVAILABLE' }, { status: 500, headers: { 'Cache-Control': 'private, no-store' } });
  }
}

export async function readCharacterAssetBody(request: NextRequest) {
  try { return await request.json(); }
  catch { throw new CharacterAssetError('JSON 格式无效，请保留输入后重试', 400, 'CHARACTER_ASSET_INVALID_BODY'); }
}
