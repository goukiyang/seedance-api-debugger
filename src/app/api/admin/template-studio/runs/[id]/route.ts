import { route as declaredRoute } from '@/lib/http/route';
import { NextResponse } from 'next/server';
import { getAdminStudioRun, withAdminStudioRoute } from '@/lib/template-studio/admin-runs';

export const dynamic = 'force-dynamic';

export const GET = declaredRoute({ access: 'admin', rateLimit: false }, async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return withAdminStudioRoute(async (user) => {
    const result = await getAdminStudioRun(user, params.id);
    return NextResponse.json(result);
  });
});
