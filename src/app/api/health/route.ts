import { NextResponse } from 'next/server';
import { isApiKeyConfigured } from '@/lib/provider/jimeng';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: 'video-api-debugger',
    providerConfigured: Boolean(isApiKeyConfigured()),
    ts: new Date().toISOString(),
  });
}
