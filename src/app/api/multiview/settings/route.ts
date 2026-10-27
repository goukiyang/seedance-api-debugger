import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest } from 'next/server';
import { multiviewSettingsRoute } from '@/lib/video/multiview-settings-api';
import { listMultiviewSettings, saveMultiviewSettings } from '@/lib/video/multiview-settings.server';

export const dynamic = 'force-dynamic';
export const GET = declaredRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest) {
  return multiviewSettingsRoute(request, false, user => listMultiviewSettings(user, request.nextUrl.searchParams.get('kind'), request.nextUrl.searchParams.get('cursor')));
});
export const POST = declaredRoute({ access: 'user', rateLimit: false }, async function POST(request: NextRequest) {
  return multiviewSettingsRoute(request, true, (user, body) => saveMultiviewSettings(user, body, request));
});
