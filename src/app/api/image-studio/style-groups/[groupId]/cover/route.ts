import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { getStudioStyleGroup } from '@/lib/image-studio/style-groups';
import { readStudioThumbnail } from '@/lib/image-studio/media';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, { params }: { params: { groupId: string } }) {
  const user = await getSession();
  if (!user) return new Response('Not found', { status: 404 });
  try {
    const group = await getStudioStyleGroup(user, params.groupId);
    const asset = await prisma.asset.findFirst({ where: { id: group.coverAssetId, status: 'active', type: 'image' }, select: { original_url: true } });
    if (!asset) return new Response('Not found', { status: 404 });
    const bytes = await readStudioThumbnail(asset.original_url);
    return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch { return new Response('Not found', { status: 404 }); }
}
