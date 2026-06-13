import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { syncFeishuRequirementDraft } from '@/lib/feishu/requirements';

export const dynamic = 'force-dynamic';

function requiredString(value: unknown, label: string) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error(`${label} 不能为空`);
}

export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const status = request.nextUrl.searchParams.get('status')?.trim();
    const requirements = await prisma.feishuRequirement.findMany({
      where: {
        ...(status ? { sync_status: status } : {}),
        ...(user.role === 'admin' ? {} : { created_project: { owner_user_id: user.id } }),
      },
      orderBy: { updated_at: 'desc' },
      take: 100,
      include: {
        created_project: { select: { id: true, name: true, status: true, type: true, owner_user_id: true } },
      },
    });

    return NextResponse.json({ requirements });
  } catch (error) {
    console.error('[FeishuRequirements] List error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const body = await request.json();
    const fields = body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields)
      ? body.fields as Record<string, unknown>
      : null;
    if (!fields) return NextResponse.json({ error: 'fields 必须是飞书记录字段对象' }, { status: 400 });

    const result = await prisma.$transaction((tx) => syncFeishuRequirementDraft(tx, {
      appToken: requiredString(body.app_token ?? body.appToken, 'app_token'),
      tableId: requiredString(body.table_id ?? body.tableId, 'table_id'),
      recordId: requiredString(body.record_id ?? body.recordId, 'record_id'),
      fields,
      actorUserId: user.id,
    }));

    return NextResponse.json(result, { status: result.deduplicated ? 200 : 201 });
  } catch (error) {
    if (error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('[FeishuRequirements] Sync error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
