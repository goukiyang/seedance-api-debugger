import { NextResponse } from 'next/server';
import { getAdminStudioRun, withAdminStudioRoute } from '@/lib/template-studio/admin-runs';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  return withAdminStudioRoute(async (user) => {
    const result = await getAdminStudioRun(user, params.id);
    return NextResponse.json(result);
  });
}
