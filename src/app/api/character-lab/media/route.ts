import { NextRequest } from 'next/server';
import { requireLabUser, labFailure, labPrivateHeaders } from '@/lib/character-lab/http';
import { labId, readLabPlan } from '@/lib/character-lab/store';
import { labOutput, labPng, labCellRect } from '@/lib/character-lab/media';
import { StudioError } from '@/lib/image-studio/tasks';

export const dynamic = 'force-dynamic';
async function media(request: NextRequest, head: boolean) {
  try {
    const user = await requireLabUser(), plan = await readLabPlan(user.id, labId(request.nextUrl.searchParams.get('plan')));
    const value = request.nextUrl.searchParams.get('cell');
    if (value !== null && !/^\d$/.test(value)) throw new StudioError('格子选择无效');
    const cell = value === null ? undefined : Number(value);
    if (cell !== undefined) labCellRect(1200, 1800, plan, cell);
    await labOutput(user, plan);
    const headers = { ...labPrivateHeaders, 'Content-Type': 'image/png',
      ...(request.nextUrl.searchParams.get('download') === '1' ? { 'Content-Disposition': `attachment; filename="character-${cell === undefined ? 'sheet' : cell + 1}.png"` } : {}) };
    if (head) return new Response(null, { headers });
    return new Response(new Uint8Array(await labPng(user, plan, cell)), { headers });
  } catch (error) { return labFailure(error); }
}
export const GET = (request: NextRequest) => media(request, false);
export const HEAD = (request: NextRequest) => media(request, true);
