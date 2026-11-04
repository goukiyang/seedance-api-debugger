import { readWorkDetail } from '@/lib/works/query';
import { WorkError } from '@/lib/works/types';
import { workApiUser, workJson, workJsonBody } from '@/lib/works/operations';
import { workRouteError } from '@/lib/works/http';
import { recordWorkView } from '@/lib/works/activity';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await workApiUser(request), work = await readWorkDetail(user, params.id);
    if (!work) throw new WorkError('作品已不可用或当前无权查看', 404);
    return workJson({ viewerId: user.id, work });
  } catch (error) { return workRouteError(error); }
}
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await workApiUser(request), body = await workJsonBody(request);
    return workJson({ viewerId: user.id, activity: await recordWorkView(user, params.id, body) });
  } catch (error) { return workRouteError(error); }
}
