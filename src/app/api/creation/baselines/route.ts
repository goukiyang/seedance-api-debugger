import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getTaskWhereForUser } from '@/lib/projects/permissions';
import { creationHttp } from '@/lib/creation/http';
import { readCreationContext } from '@/lib/creation/context';
import { readCreationSource } from '@/lib/creation/lineage';
import { videoDeliveryStageForTask } from '@/lib/video/delivery-status';
export const dynamic = 'force-dynamic';
export const GET = declaredRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest) {
  return creationHttp(async user => {
    const projectId = request.nextUrl.searchParams.get('project_id');
    await readCreationContext(user, projectId);
    const visible = await getTaskWhereForUser(user, projectId, { includeAdminAll: false });
    const rows = await prisma.videoTask.findMany({ where: { AND: [visible, { local_status: 'succeeded' }] }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 100 });
    const items = [];
    for (const row of rows) {
      if (!videoDeliveryStageForTask(row).stableDownloadReady) continue;
      try { await readCreationSource(prisma, user, row.id); }
      catch { continue; }
      items.push({ id: row.id, model: row.model, resolution: row.resolution, created_at: row.created_at,
        preview_url: row.local_video_path ? `/api/video/play/${row.id}` : row.public_video_url || null });
      if (items.length === 24) break;
    }
    return { items };
  });
});
