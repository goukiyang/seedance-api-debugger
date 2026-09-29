import { NextRequest, NextResponse } from 'next/server';
import { withStudioRoute } from '@/lib/template-studio/common';
import { getStudioRunHandoff } from '@/lib/template-studio/handoff';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  return withStudioRoute(async (user) => NextResponse.json(await getStudioRunHandoff(user, params.id)));
}
