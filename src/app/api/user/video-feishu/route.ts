import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { readVideoFeishuPreference, saveVideoFeishuPreference } from '@/lib/video/feishu-notification';
import { videoFeishuResponse, videoFeishuHttpError, videoFeishuJson } from '@/lib/video/feishu-http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET() {
  try {
    const user = await getSession();
    if (!user) return videoFeishuResponse({ error: 'not_authenticated' }, 401);
    return videoFeishuResponse(await prisma.$transaction(tx => readVideoFeishuPreference(tx, user.id)));
  } catch (error) { return videoFeishuHttpError(error); }
}
export async function PUT(request: Request) {
  try {
    const user = await getSession();
    if (!user) return videoFeishuResponse({ error: 'not_authenticated' }, 401);
    const body = await videoFeishuJson(request);
    return videoFeishuResponse(await prisma.$transaction(tx => saveVideoFeishuPreference(tx, user.id,
      body as { version: unknown; enabled: unknown; revision: unknown })));
  } catch (error) { return videoFeishuHttpError(error); }
}
