import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { canManageStudioStyle, getStudioStyleGroup } from '@/lib/image-studio/style-groups';
import { readStudioImage, readStudioThumbnail } from '@/lib/image-studio/media';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: { groupId: string; assetId: string } }) {
  const user = await getSession();
  if (!user) return new Response('Not found', { status: 404 });
  try {
    const group = await getStudioStyleGroup(user, params.groupId);
    if (!canManageStudioStyle(user, group) || !group.references.some(ref => ref.assetId === params.assetId)) return new Response('Not found', { status: 404 });
    const asset = await prisma.asset.findFirst({ where: { id: params.assetId, status: 'active', type: 'image' }, select: { original_url: true } });
    if (!asset) return new Response('Not found', { status: 404 });
    const thumbnail = new URL(request.url).searchParams.get('thumbnail') === '1';
    const bytes = await (thumbnail ? readStudioThumbnail(asset.original_url) : readStudioImage(asset.original_url));
    return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': thumbnail ? 'image/webp' : 'image/png', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch { return new Response('Not found', { status: 404 }); }
}
