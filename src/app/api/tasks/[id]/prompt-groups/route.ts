import { getSession, AuthError } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { videoPromptGroupTaskRefs } from '@/lib/video/prompt-groups';
import { videoPromptGroupSelections } from '@/lib/video/prompt-groups.server';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await getSession();
    if (!user) return Response.json({ error: '请先登录' }, { status: 401, headers });
    const task = await prisma.videoTask.findUnique({ where: { id: params.id } });
    if (!task) return Response.json({ error: '来源任务不可用' }, { status: 404, headers });
    await assertCanViewTask(user, task);
    const refs = videoPromptGroupTaskRefs(task);
    return Response.json({ taskId: task.id, refs, groups: await videoPromptGroupSelections(user, refs) }, { headers });
  } catch (error) {
    return Response.json({ error: '来源任务或提示词组暂不可读，成品访问不受影响' }, { status: error instanceof AuthError ? error.status : 503, headers });
  }
}
