import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { getProjectAccess } from '@/lib/projects/permissions';
import { WorkError } from '@/lib/works/types';
import { worksSchemaReady } from '@/lib/works/source-policy';
import { canUseWorksPreview } from '@/lib/works/rollout.server';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function failed(error: unknown) {
  return NextResponse.json({ error: error instanceof WorkError ? error.message : '作品范围暂时无法保存，请核对原操作编号',
    code: error instanceof WorkError ? error.code : 'WORKS_PROJECT_AUDIENCE_UNAVAILABLE' }, { status: error instanceof WorkError ? error.status : 503, headers });
}
function operation(requestId: string, resultJson: string) { return { requestId, state: 'committed', result: JSON.parse(resultJson) }; }

export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) throw new WorkError('请先登录', 401, 'WORKS_UNAUTHENTICATED');
    if (!canUseWorksPreview(user)) throw new WorkError('页面暂不可用', 404, 'WORK_PREVIEW_UNAVAILABLE');
    if (!await worksSchemaReady()) throw new WorkError('作品功能正在准备', 503, 'WORKS_SCHEMA_UNAVAILABLE');
    const requestId = request.nextUrl.searchParams.get('requestId');
    if (requestId) {
      if (!uuid(requestId)) throw new WorkError('操作编号无效');
      const receipt = await prisma.workOperation.findUnique({ where: { owner_id_request_id: { owner_id: user.id, request_id: requestId.toLowerCase() } } });
      const result = receipt ? JSON.parse(receipt.result_json) : null;
      if (result && result.action !== 'project-audience') throw new WorkError('原操作编号用于其他内容', 409, 'WORKS_OPERATION_CONFLICT');
      return NextResponse.json({ viewerId: user.id, operation: receipt ? operation(requestId.toLowerCase(), receipt.result_json) : null }, { headers });
    }
    const projectId = request.nextUrl.searchParams.get('projectId');
    if (!id(projectId)) throw new WorkError('项目编号无效');
    const access = await getProjectAccess(user, projectId);
    if (!access?.canView) throw new WorkError('无权查看此项目', 403, 'WORKS_PROJECT_FORBIDDEN');
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.status === 'deleted') throw new WorkError('项目不存在', 404);
    return NextResponse.json({ viewerId: user.id, projectId, projectType: project.type, audience: project.work_audience,
      expectedUpdatedAt: project.updated_at.toISOString(), canManage: project.owner_user_id === user.id && project.status === 'active' && ['team', 'personal'].includes(project.type) }, { headers });
  } catch (error) { return failed(error); }
}
export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) throw new WorkError('请先登录', 401, 'WORKS_UNAUTHENTICATED');
    if (!canUseWorksPreview(user)) throw new WorkError('页面暂不可用', 404, 'WORK_PREVIEW_UNAVAILABLE');
    const body = await request.json();
    if (body.viewerId !== user.id || request.headers.get('x-app-session-user') && request.headers.get('x-app-session-user') !== user.id) throw new WorkError('账号已变化，请回原账号核对原操作', 409, 'WORKS_ACTOR_CHANGED');
    if (!id(body.projectId) || !uuid(body.requestId) || ![null, 'team', 'project', 'private'].includes(body.audience)
      || typeof body.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(body.expectedUpdatedAt))) throw new WorkError('项目范围设置无效');
    if (!await worksSchemaReady()) throw new WorkError('作品功能正在准备', 503, 'WORKS_SCHEMA_UNAVAILABLE');
    const requestId = body.requestId.toLowerCase();
    const fingerprint = createHash('sha256').update(JSON.stringify(['project-audience', body.projectId, body.audience, body.expectedUpdatedAt])).digest('hex');
    const result = await prisma.$transaction(async db => {
      const actor = await db.user.findUnique({ where: { id: user.id }, select: { status: true, account_type: true, expires_at: true } });
      if (!actor || actor.status !== 'active' || actor.account_type !== 'internal' || actor.expires_at && actor.expires_at <= new Date()) throw new WorkError('当前账号不能修改项目范围', 403, 'WORKS_PROJECT_FORBIDDEN');
      const receipt = await db.workOperation.findUnique({ where: { owner_id_request_id: { owner_id: user.id, request_id: requestId } } });
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new WorkError('原操作编号已用于不同内容，请核对原回执', 409, 'WORKS_OPERATION_CONFLICT');
        return { ...JSON.parse(receipt.result_json), operation: operation(requestId, receipt.result_json) };
      }
      const project = await db.project.findUnique({ where: { id: body.projectId } });
      if (!project || project.owner_user_id !== user.id || project.status !== 'active' || !['team', 'personal'].includes(project.type)) throw new WorkError('仅项目所有者可修改本项目的作品范围', 403, 'WORKS_PROJECT_FORBIDDEN');
      if (project.type === 'personal' && body.audience !== 'private') throw new WorkError('个人项目仅本人可见');
      const changed = await db.project.updateMany({ where: { id: project.id, owner_user_id: user.id, status: 'active', updated_at: new Date(body.expectedUpdatedAt) }, data: { work_audience: body.audience } });
      if (changed.count !== 1) throw new WorkError('项目已更新，请重新读取后保存；本次未覆盖', 409, 'WORKS_PROJECT_CONFLICT');
      const fresh = await db.project.findUniqueOrThrow({ where: { id: project.id }, select: { updated_at: true } });
      const committed = { action: 'project-audience', viewerId: user.id, projectId: project.id, projectType: project.type, audience: body.audience,
        expectedUpdatedAt: fresh.updated_at.toISOString(), canManage: true };
      const row = await db.workOperation.create({ data: { owner_id: user.id, request_id: requestId, fingerprint, result_json: JSON.stringify(committed) } });
      return { ...committed, operation: operation(requestId, row.result_json) };
    });
    return NextResponse.json(result, { headers });
  } catch (error) { return failed(error); }
}
