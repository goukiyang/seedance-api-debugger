import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import { multiviewWorkRoute, multiviewWorkHeaders } from '@/lib/video/multiview-work-api';
import { multiviewInfo, multiviewFrame } from '@/lib/video/multiview';
import { openUntrustedImage } from '@/lib/media/decode-image';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = declaredRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest, props: { params: Promise<{ taskId: string }> }) {
  const params = await props.params;
  return multiviewWorkRoute(request, false, async user => {
    const info = await multiviewInfo(user, params.taskId, request);
    const frame = await multiviewFrame(user, params.taskId, request, info.sourceVersion, 0);
    const bytes = await (await openUntrustedImage(frame, 'video-frame')).resize(480, 480, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    await multiviewInfo(user, params.taskId, request);
    return new NextResponse(new Uint8Array(bytes), { headers: { ...multiviewWorkHeaders, 'Content-Type': 'image/webp', 'Content-Length': String(bytes.length), 'X-Multiview-Source-Version': info.sourceVersion } });
  });
});
