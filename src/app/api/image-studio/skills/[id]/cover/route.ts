import { getSession } from '@/lib/auth/session';
import { getSkill } from '@/lib/image-studio/skills';
import { prisma } from '@/lib/prisma';
import { studioVisibleAssetWhere } from '@/lib/image-studio/protected-assets';
import { authorizedImageResponse, privateImageHeaders } from '@/lib/media/authorized-image-response';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await getSession();
    if (!user) return new Response(null, { status: 401, headers: privateImageHeaders });
    const skill = await getSkill(user, params.id);
    const asset = skill.coverAssetId && await prisma.asset.findFirst({ where: { id: skill.coverAssetId, owner_id: skill.ownerId,
      status: 'active', type: 'image', AND: [await studioVisibleAssetWhere(user)] }, select: { original_url: true } });
    if (!asset) return new Response(null, { status: 404, headers: privateImageHeaders });
    return authorizedImageResponse(request, asset.original_url, 'thumbnail', 'image/webp');
  } catch { return new Response(null, { status: 404, headers: privateImageHeaders }); }
}
export const HEAD = GET;
