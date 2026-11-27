import { NextResponse } from 'next/server';
import { apiError, readJson } from '@/lib/customer-api/auth';
import { recoverApiProviderCallback } from '@/lib/customer-api/recovery';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const signature = new URL(request.url).searchParams.get('signature') || '';
    const body = await readJson(request);
    await recoverApiProviderCallback(params.id, signature, body.id);
    return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return apiError(error);
  }
}
