import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest } from 'next/server';
import { multiviewSettingsRoute } from '@/lib/video/multiview-settings-api';
import { manageMultiviewSettings, readMultiviewSettings, saveMultiviewSettings } from '@/lib/video/multiview-settings.server';

export const dynamic = 'force-dynamic';
export const GET = declaredRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return multiviewSettingsRoute(request, false, async user => ({ settings: await readMultiviewSettings(user, params.id) }));
});
export const PATCH = declaredRoute({ access: 'user', rateLimit: false }, async function PATCH(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return multiviewSettingsRoute(request, true, (user, body) => body && typeof body === 'object' && 'action' in body && body.action === 'rename'
    ? manageMultiviewSettings(user, params.id, body, 'rename') : saveMultiviewSettings(user, body, request, params.id));
});
export const DELETE = declaredRoute({ access: 'user', rateLimit: false }, async function DELETE(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return multiviewSettingsRoute(request, true, (user, body) => manageMultiviewSettings(user, params.id, body, 'delete'));
});
