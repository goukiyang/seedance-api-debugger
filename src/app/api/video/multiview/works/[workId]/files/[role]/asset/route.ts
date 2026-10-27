import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { multiviewWorkRoute } from '@/lib/video/multiview-work-api';
import { multiviewWorkReadyFileHash, MultiviewWorkError } from '@/lib/video/multiview-works';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ workId: string; role: string }> };
// Read-only: which of the viewer's library assets a saved collage/frame was registered as (multiview-output-assets.server.ts).
export async function GET(request: NextRequest, props: Context) {
  const params = await props.params;
  return multiviewWorkRoute(request, false, async user => {
    const hash = await multiviewWorkReadyFileHash(user, params.workId, params.role);
    const asset = await prisma.asset.findFirst({ where: { owner_id: user.id, hash, status: 'active', type: 'image' }, select: { id: true } });
    if (!asset) throw new MultiviewWorkError('这件作品的成品还没有登记到你的素材库（较早保存的作品不会自动登记），暂不能直接用作参考图；可以先“下载PNG”，再在编辑页用“更换图片”上传。', 409, 'WORK_OUTPUT_NOT_REGISTERED');
    return { assetId: asset.id };
  });
}
