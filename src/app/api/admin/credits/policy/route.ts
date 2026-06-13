import { NextRequest, NextResponse } from 'next/server';
import { errorJson, getAdminUser } from '@/lib/auth/api-helpers';
import { getCreditPolicy, saveCreditPolicy } from '@/lib/credits/policy';

export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  const policy = await getCreditPolicy();
  return NextResponse.json({ policy });
}

export async function PUT(request: NextRequest) {
  let admin: { id: string };
  try {
    admin = await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  try {
    const body = await request.json();
    const policy = body.policy || body;
    const saved = await saveCreditPolicy(policy, admin.id);
    return NextResponse.json({ ok: true, policy: saved });
  } catch (error) {
    console.error('[Admin/Credits/Policy]', error);
    return errorJson('保存点数策略失败', 400);
  }
}
