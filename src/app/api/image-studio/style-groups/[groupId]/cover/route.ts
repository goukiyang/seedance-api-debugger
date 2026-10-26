import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { getStudioStyleGroup } from '@/lib/image-studio/style-groups';
import { readStudioThumbnail } from '@/lib/image-studio/media';
import { privateImageHeaders } from '@/lib/media/authorized-image-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, { params }: { params: { groupId: string } }) {
  const user = await getSession();
  if (!user) return new Response('Not found', { status: 404, headers: privateImageHeaders });
  try {
    const group = await getStudioStyleGroup(user, params.groupId);
    const asset = await prisma.asset.findFirst({ where: { id: group.coverAssetId, status: 'active', type: 'image' }, select: { original_url: true } });
    if (!asset) return new Response('Not found', { status: 404, headers: privateImageHeaders });
    const bytes = await readStudioThumbnail(asset.original_url);
    return new Response(_request.method === 'HEAD' ? null : new Uint8Array(bytes), { headers: { ...privateImageHeaders, 'Content-Type': 'image/webp', 'Content-Length': String(bytes.length) } });
  } catch { return new Response('Not found', { status: 404, headers: privateImageHeaders }); }
}
export const HEAD = GET;
