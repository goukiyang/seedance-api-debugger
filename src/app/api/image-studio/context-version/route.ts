import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { defaultStudioModuleId, validStudioModuleId } from '@/lib/image-studio/modules';
import { ContextVersionError, resolveModuleContextVersion, snapshotModuleContextVersion } from '@/lib/image-studio/context-version';

export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (!canUseCompanyTemplates(user)) return NextResponse.json({ error: '无权使用图片模板' }, { status: 403 });
  try {
    const body = await request.json();
    if (!validStudioModuleId(body.moduleId, user.id)) return NextResponse.json({ error: '模块不存在' }, { status: 404 });
    const workspace = await prisma.imageStudioModule.findFirst({ where: { id: body.moduleId, owner_id: user.id } });
    if (!workspace && body.moduleId !== defaultStudioModuleId(user.id)) return NextResponse.json({ error: '模块不存在' }, { status: 404 });
    if (body.taskId !== undefined) {
      if (typeof body.taskId !== 'string' || body.taskId.length > 120) return NextResponse.json({ error: '历史记录无效' }, { status: 400 });
      const task = await prisma.imageStudioTask.findFirst({ where: { id: body.taskId, owner_id: user.id, deleted_at: null,
        ...(body.moduleId === defaultStudioModuleId(user.id) ? { OR: [{ module_id: null }, { module_id: body.moduleId }] } : { module_id: body.moduleId }) }, select: { snapshot_json: true } });
      if (!task) return NextResponse.json({ error: '历史记录不存在' }, { status: 404 });
      return NextResponse.json(await snapshotModuleContextVersion(task.snapshot_json), { headers: { 'Cache-Control': 'no-store' } });
    }
    let raw = workspace?.context ?? '';
    if (body.context !== undefined) {
      const source = workspace?.source_preset_id ? await prisma.imageStudioPreset.findUnique({ where: { id: workspace.source_preset_id }, select: { owner_id: true } }) : null;
      if (user.role !== 'admin' && workspace?.source_preset_id && source?.owner_id !== user.id) return NextResponse.json({ error: '共享模板上下文不可编辑' }, { status: 403 });
      if (typeof body.context !== 'string' || body.context.length > 20000) return NextResponse.json({ error: '模块上下文最多 20000 字' }, { status: 400 });
      raw = body.context;
    }
    return NextResponse.json({ code: await resolveModuleContextVersion(raw), state: 'ready' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof ContextVersionError ? error.message : '模块上下文版本读取失败，请重试' }, { status: 503 });
  }
}
