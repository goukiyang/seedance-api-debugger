import { route as apiRoute } from '@/lib/http/route';
import { getSession } from '@/lib/auth/session';
import { getSkill } from '@/lib/image-studio/skills';
import { prisma } from '@/lib/prisma';
import { studioVisibleAssetWhere } from '@/lib/image-studio/protected-assets';
import { authorizedImageResponse, privateImageHeaders } from '@/lib/media/authorized-image-response';
import { redirectMedia } from '@/lib/media/outlet';
export const dynamic = 'force-dynamic';
export const GET = apiRoute({ access: 'user', rateLimit: false }, async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const user = await getSession();
    if (!user) return new Response(null, { status: 401, headers: privateImageHeaders });
    const skill = await getSkill(user, params.id);
    const asset = skill.coverAssetId && (await prisma.asset.findFirst({ where: { id: skill.coverAssetId, owner_id: skill.ownerId,
      status: 'active', type: 'image', AND: [await studioVisibleAssetWhere(user)] }, select: { original_url: true } }));
    if (!asset) return new Response(null, { status: 404, headers: privateImageHeaders });
    return redirectMedia(request, user, { type: 'asset', id: skill.coverAssetId! }, 'thumbnail');
  } catch { return new Response(null, { status: 404, headers: privateImageHeaders }); }
});
export const HEAD = GET;
