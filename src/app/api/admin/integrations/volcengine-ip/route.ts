import { NextRequest, NextResponse } from 'next/server';
import { AuthError } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { getVolcengineIpPublicConfigStatus } from '@/lib/provider/volcengine-ip';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
    return NextResponse.json({
      ok: true,
      config: getVolcengineIpPublicConfigStatus(),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Admin/VolcengineIpIntegration] GET failed:', error);
    return NextResponse.json({ error: '读取火山 IP 生成配置失败' }, { status: 500 });
  }
}
