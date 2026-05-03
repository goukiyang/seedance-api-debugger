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

  const existing = await prisma.pricingRule.findUnique({ where: { id: context.params.id } });
  if (!existing) return errorJson('计费规则不存在', 404);

  const rule = await prisma.$transaction(async (tx) => {
    const updated = await tx.pricingRule.update({
      where: { id: context.params.id },
      data: { status: 'disabled' },
    });

    await tx.operationLog.create({
      data: {
        operator_id: admin.id,
        action: 'disable_pricing_rule',
        target_type: 'PricingRule',
        target_id: updated.id,
        detail: JSON.stringify({
          previous_status: existing.status,
          version: existing.version,
        }),
      },
    });

    return updated;
  });

  return NextResponse.json({ rule });
}
