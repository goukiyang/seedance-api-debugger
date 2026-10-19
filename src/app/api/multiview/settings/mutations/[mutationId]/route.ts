import { NextRequest } from 'next/server';
import { multiviewSettingsRoute } from '@/lib/video/multiview-settings-api';
import { readMultiviewSettingsMutation } from '@/lib/video/multiview-settings.server';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, { params }: { params: { mutationId: string } }) {
  return multiviewSettingsRoute(request, false, user => readMultiviewSettingsMutation(user, params.mutationId));
}
