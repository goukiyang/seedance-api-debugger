import { NextRequest } from 'next/server';
import { creationHttp, creationBody } from '@/lib/creation/http';
import { getVideoDelivery, changeVideoDelivery } from '@/lib/creation/delivery';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return creationHttp(user => getVideoDelivery(user, params.id, request.nextUrl.searchParams.get('request_id')));
}
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return creationHttp(async user => ({ operation: await changeVideoDelivery(user, params.id, await creationBody(request)) }));
}
