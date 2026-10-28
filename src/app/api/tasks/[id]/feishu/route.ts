import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { readVideoFeishuStatus, cancelVideoFeishuNotification } from '@/lib/video/feishu-notification';
import { VideoFeishuError } from '@/lib/video/feishu-contract';
import { videoFeishuResponse, videoFeishuHttpError, videoFeishuJson } from '@/lib/video/feishu-http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Context = { params: { id: string } };
export async function GET(_request: Request, { params }: Context) {
  try {
    const user = await getSession();
    if (!user) return videoFeishuResponse({ error: 'not_authenticated' }, 401);
    return videoFeishuResponse(await prisma.$transaction(tx => readVideoFeishuStatus(tx, user.id, params.id)));
  } catch (error) { return videoFeishuHttpError(error); }
}
export async function POST(request: Request, { params }: Context) {
  try {
    const user = await getSession();
    if (!user) return videoFeishuResponse({ error: 'not_authenticated' }, 401);
    const body = await videoFeishuJson(request);
    if (body.version !== 1 || body.action !== 'cancel' || Object.keys(body).some(key => !['version', 'action'].includes(key))) throw new VideoFeishuError('invalid_cancel', 400);
    return videoFeishuResponse(await prisma.$transaction(tx => cancelVideoFeishuNotification(tx, user.id, params.id)));
  } catch (error) { return videoFeishuHttpError(error); }
}
