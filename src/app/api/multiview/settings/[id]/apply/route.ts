import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest } from 'next/server';
import { multiviewSettingsRoute } from '@/lib/video/multiview-settings-api';
import { applyMultiviewSettings } from '@/lib/video/multiview-settings.server';

export const dynamic = 'force-dynamic';
export const POST = declaredRoute({ access: 'user', rateLimit: false }, async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return multiviewSettingsRoute(request, true, (user, body) => applyMultiviewSettings(user, params.id, body, request));
});
