import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { errorJson, getAdminUser } from '@/lib/auth/api-helpers';

type RouteContext = {
  params: {
    id: string;
  };
};

export async function POST(request: NextRequest, context: RouteContext) {
  let admin;
  try {
    admin = await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  const existing = await prisma.sharedResource.findUnique({ where: { id: context.params.id } });
  if (!existing) return errorJson('资源不存在', 404);

  const resource = await prisma.$transaction(async (tx) => {
    const updated = await tx.sharedResource.update({
      where: { id: context.params.id },
      data: {
        status: 'disabled',
        disabled_at: new Date(),
      },
    });

    await tx.operationLog.create({
      data: {
        operator_id: admin.id,
        action: 'disable_shared_resource',
        target_type: 'SharedResource',
        target_id: updated.id,
        detail: JSON.stringify({ previous_status: existing.status }),
      },
    });

    return updated;
  });

  return NextResponse.json({ resource });
}
