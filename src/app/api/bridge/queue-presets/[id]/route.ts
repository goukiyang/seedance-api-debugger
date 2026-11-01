import { NextRequest } from 'next/server';
import { deletePreset, updatePreset } from '@/lib/bridge/queue-presets';
import { readBody, withUser } from '../_shared';

export const dynamic = 'force-dynamic';
type Ctx = { params: { id: string } };

/** PATCH { name?, items?, shared? }：创建者或管理员 */
export async function PATCH(request: NextRequest, { params }: Ctx) {
  return withUser(request, true, async (user) => ({ preset: await updatePreset(user, params.id, await readBody(request)) }));
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  return withUser(request, true, (user) => deletePreset(user, params.id));
}
