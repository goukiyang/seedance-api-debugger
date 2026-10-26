import { NextRequest, NextResponse } from 'next/server';
import { withStudioRoute } from '@/lib/template-studio/common';
import { getStudioCapabilities } from '@/lib/template-studio/capabilities';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest) {
  return withStudioRoute(async (user) => NextResponse.json(await getStudioCapabilities(user)));
}
