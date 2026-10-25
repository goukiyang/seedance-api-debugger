import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { multiviewWorkRoute } from '@/lib/video/multiview-work-api';
import { multiviewWorkReadyFileHash, MultiviewWorkError } from '@/lib/video/multiview-works';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: { workId: string; role: string } };
// Read-only: which of the viewer's library assets a saved collage/frame was registered as (multiview-output-assets.server.ts).
export async function GET(request: NextRequest, { params }: Context) {
  return multiviewWorkRoute(request, false, async user => {
    const hash = await multiviewWorkReadyFileHash(user, params.workId, params.role);
    const asset = await prisma.asset.findFirst({ where: { owner_id: user.id, hash, status: 'active', type: 'image' }, select: { id: true } });
    if (!asset) throw new MultiviewWorkError('这张图还没有保存到你的素材库：请先“保存到我的作品”，保存完成后再用作参考图。', 409, 'WORK_OUTPUT_NOT_REGISTERED');
    return { assetId: asset.id };
  });
}
