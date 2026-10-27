import { creationHttp, creationBody } from '@/lib/creation/http';
import { requestVideoCreationApproval } from '@/lib/creation/approval';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return creationHttp(async user => ({ approval: await requestVideoCreationApproval(user, params.id, await creationBody(request)) }));
}
