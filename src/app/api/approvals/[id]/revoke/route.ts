import { route as declaredRoute } from '@/lib/http/route';
import { prisma } from '@/lib/prisma';
import { getProjectAccess } from '@/lib/projects/permissions';
import { CreationError, creationIdentity } from '@/lib/creation/contract';
import { assertVideoCreationReady } from '@/lib/creation/context';
import { creationHttp, creationBody } from '@/lib/creation/http';
import { readCreationOperation, writeCreationOperation } from '@/lib/creation/receipts';
export const dynamic = 'force-dynamic';
export const POST = declaredRoute({ access: 'user', rateLimit: false }, async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return creationHttp(async user => {
    await assertVideoCreationReady();
    const body = await creationBody(request), requestId = creationIdentity(body.request_id, 'request_id')!;
    return prisma.$transaction(async tx => {
      const approval = await tx.approvalRecord.findUnique({ where: { id: params.id } });
      if (!approval || !['video_creation_1080p', 'video_delivery_reopen'].includes(approval.type)) throw new CreationError('审批记录不存在', 404);
      const access = approval.project_id ? await getProjectAccess(user, approval.project_id, tx) : null;
      if (user.role !== 'admin' && !access?.canManageProject) throw new CreationError('无权撤销此审批', 403);
      const target = `approval:${approval.id}`, input = { action: 'revoke', expected_revision: body.expected_revision, expected_status: body.expected_status };
      const original = await readCreationOperation(tx, user.id, target, requestId, input);
      if (original) return { operation: original };
      if (body.expected_status !== approval.status) throw new CreationError('审批状态已变化，请重新读取');
      if (!['pending', 'approved'].includes(approval.status) || approval.revision !== body.expected_revision) throw new CreationError('审批已变化，请重新读取');
      const changed = await tx.approvalRecord.updateMany({ where: { id: approval.id, revision: approval.revision, status: approval.status },
        data: { status: 'cancelled', revision: { increment: 1 } } });
      if (changed.count !== 1) throw new CreationError('审批已被另一操作处理，请重新读取');
      return { operation: await writeCreationOperation(tx, user.id, target, requestId, input, 'accepted',
        { approval_id: approval.id, status: 'cancelled', used_count: approval.used_count, used_cost_cents: approval.used_cost_cents }) };
    });
  });
});

export const GET = declaredRoute({ access: 'user', rateLimit: false }, async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return creationHttp(async user => {
    const requestId = creationIdentity(new URL(request.url).searchParams.get('request_id'), 'request_id')!;
    const original = await readCreationOperation(prisma, user.id, `approval:${params.id}`, requestId);
    return { operation: original ? { state: original.state, requestId: original.requestId, observedAt: original.observedAt } : null };
  });
});
