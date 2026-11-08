import { workApiUser, workJson, workJsonBody, assertWorkViewer } from '@/lib/works/operations';
import { assertWorkId } from '@/lib/works/interactions';
import { workRouteError } from '@/lib/works/http';
import { recordOriginalAssetTake } from '@/lib/works/recommendation-events';
import { prisma } from '@/lib/prisma';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    const user = await workApiUser(request), input = await workJsonBody(request);
    assertWorkViewer(user, input.viewerId);
    if (typeof input.referenceImageId === 'string') {
      assertWorkId(input.referenceImageId, '素材编号');
      const reference = await prisma.referenceImage.findFirst({ where: { id: input.referenceImageId, status: 'active' }, select: { asset_id: true } });
      if (reference?.asset_id) await recordOriginalAssetTake(user, reference.asset_id);
    } else {
      assertWorkId(input.assetId, '图片编号');
      await recordOriginalAssetTake(user, input.assetId);
    }
    return workJson({ viewerId: user.id, recorded: true });
  } catch (error) { return workRouteError(error); }
}
