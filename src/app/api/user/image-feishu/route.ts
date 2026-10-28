import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { readImageFeishuPreference, saveImageFeishuPreference } from '@/lib/image-studio/feishu-notification';
import { videoFeishuResponse, videoFeishuHttpError, videoFeishuJson } from '@/lib/video/feishu-http';
import { VideoFeishuError } from '@/lib/video/feishu-contract';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const user = await getSession(); if (!user) return videoFeishuResponse({ error: 'not_authenticated' }, 401);
    const expected = request.headers.get('x-app-session-user');
    if (expected !== null && expected !== user.id) throw new VideoFeishuError('account_changed', 409);
    return videoFeishuResponse(await prisma.$transaction(tx => readImageFeishuPreference(tx, user.id)));
  } catch (error) { return videoFeishuHttpError(error); }
}
export async function PUT(request: Request) {
  try {
    const user = await getSession(); if (!user) return videoFeishuResponse({ error: 'not_authenticated' }, 401);
    const expected = request.headers.get('x-app-session-user');
    if (expected !== null && expected !== user.id) throw new VideoFeishuError('account_changed', 409);
    const body = await videoFeishuJson(request);
    return videoFeishuResponse(await prisma.$transaction(tx => saveImageFeishuPreference(tx, user.id,
      body as { version: unknown; enabled: unknown; revision: unknown })));
  } catch (error) { return videoFeishuHttpError(error); }
}
