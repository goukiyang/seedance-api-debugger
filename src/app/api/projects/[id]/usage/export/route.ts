import { handleUsageRequest } from '@/lib/usage/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return handleUsageRequest(request, params.id, true);
}
