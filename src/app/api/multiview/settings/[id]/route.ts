import { NextRequest } from 'next/server';
import { multiviewSettingsRoute } from '@/lib/video/multiview-settings-api';
import { readMultiviewSettings, saveMultiviewSettings } from '@/lib/video/multiview-settings.server';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  return multiviewSettingsRoute(request, false, async user => ({ settings: await readMultiviewSettings(user, params.id) }));
}
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  return multiviewSettingsRoute(request, true, (user, body) => saveMultiviewSettings(user, body, request, params.id));
}
