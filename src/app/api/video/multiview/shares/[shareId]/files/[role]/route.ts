import { NextRequest, NextResponse } from 'next/server';
import { multiviewWorkRoute, multiviewWorkHeaders } from '@/lib/video/multiview-work-api';
import { readMultiviewShareFile } from '@/lib/video/multiview-share.server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: NextRequest, { params }: { params: { shareId: string; role: string } }) {
  return multiviewWorkRoute(request, false, async user => {
    const file = await readMultiviewShareFile(user, params.shareId, params.role);
    return new NextResponse(request.method === 'HEAD' ? null : new Uint8Array(file.bytes), { headers: { ...multiviewWorkHeaders, 'Content-Type': file.mime, 'Content-Length': String(file.bytes.length) } });
  });
}
export const HEAD = GET;
