import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { currentMultiviewActor, MultiviewWorkError } from '@/lib/video/multiview-works';
import { multiviewWorkRoute } from '@/lib/video/multiview-work-api';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: NextRequest) {
  return multiviewWorkRoute(request, false, async user => {
    await currentMultiviewActor(user);
    const q = request.nextUrl.searchParams.get('q') || '', after = request.nextUrl.searchParams.get('after');
    if (q.length > 80 || after && !/^[a-zA-Z0-9_-]{1,100}$/.test(after)) throw new MultiviewWorkError('同事筛选无效。');
    const items = await prisma.user.findMany({ where: { id: { not: user.id, ...(after ? { gt: after } : {}) }, status: 'active', account_type: 'internal', role: { in: ['admin', 'user'] },
      AND: [{ OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }] }, ...(q ? [{ OR: [{ name: { contains: q } }, { username: { contains: q } }] }] : [])] },
      select: { id: true, name: true, username: true }, orderBy: { id: 'asc' }, take: 25 });
    return { items: items.slice(0, 24).map(item => ({ id: item.id, name: item.name || item.username || '同事' })), next: items.length > 24 ? items[23].id : null };
  });
}
