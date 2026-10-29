import { getSession } from '@/lib/auth/session';
import { readVideoPromptGroup } from '@/lib/video/prompt-groups.server';
import { prisma } from '@/lib/prisma';
import { authorizedImageResponse, privateImageHeaders } from '@/lib/media/authorized-image-response';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await getSession();
    if (!user) return new Response(null, { status: 401, headers: privateImageHeaders });
    const { head, version } = await readVideoPromptGroup(user, { groupId: params.id, versionId: new URL(request.url).searchParams.get('version') || '' });
    const asset = version.coverAssetId && await prisma.asset.findFirst({ where: { id: version.coverAssetId, owner_id: head.ownerId,
      status: 'active', type: 'image' }, select: { original_url: true } });
    if (!asset) return new Response(null, { status: 404, headers: privateImageHeaders });
    // The group grants a thumbnail only, never the original file or its URL.
    return authorizedImageResponse(request, asset.original_url, 'thumbnail', 'image/webp');
  } catch { return new Response(null, { status: 404, headers: privateImageHeaders }); }
}
export const HEAD = GET;
