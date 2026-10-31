import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { readImageFeishuStatus, changeImageFeishuNotification, readOriginalImageFeishuStatus, requestOriginalImageFeishu, changeOriginalImageFeishu } from '@/lib/image-studio/feishu-notification';
import { VideoFeishuError } from '@/lib/video/feishu-contract';
import { videoFeishuResponse, videoFeishuHttpError, videoFeishuJson } from '@/lib/video/feishu-http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Context = { params: { taskId: string } };
export async function GET(request: Request, { params }: Context) {
  try {
    const user = await getSession(); if (!user) return videoFeishuResponse({ error: 'not_authenticated' }, 401);
    const expected = request.headers.get('x-app-session-user');
    if (expected !== null && expected !== user.id) throw new VideoFeishuError('account_changed', 409);
    return videoFeishuResponse(await prisma.$transaction<Awaited<ReturnType<typeof readOriginalImageFeishuStatus>> | Awaited<ReturnType<typeof readImageFeishuStatus>>>(tx => new URL(request.url).searchParams.get('intent') === 'original'
      ? readOriginalImageFeishuStatus(tx, user.id, params.taskId) : readImageFeishuStatus(tx, user.id, params.taskId)));
  } catch (error) { return videoFeishuHttpError(error); }
}
export async function POST(request: Request, { params }: Context) {
  try {
    const user = await getSession(); if (!user) return videoFeishuResponse({ error: 'not_authenticated' }, 401);
    const expected = request.headers.get('x-app-session-user');
    if (expected !== null && expected !== user.id) throw new VideoFeishuError('account_changed', 409);
    const body = await videoFeishuJson(request);
    if (body.version === 2 && body.intent === 'original' && ['send','cancel','retry'].includes(String(body.action)) && Object.keys(body).every(key => ['version','intent','action'].includes(key))) {
      return videoFeishuResponse(await prisma.$transaction(tx => body.action === 'send' ? requestOriginalImageFeishu(tx, user.id, params.taskId) : changeOriginalImageFeishu(tx, user.id, params.taskId, body.action as 'cancel' | 'retry')));
    }
    if (body.version !== 1 || !['cancel', 'retry'].includes(String(body.action)) || Object.keys(body).some(key => !['version', 'action'].includes(key))) throw new VideoFeishuError('invalid_notification_action', 400);
    return videoFeishuResponse(await prisma.$transaction(tx => changeImageFeishuNotification(tx, user.id, params.taskId, body.action as 'cancel' | 'retry')));
  } catch (error) { return videoFeishuHttpError(error); }
}
