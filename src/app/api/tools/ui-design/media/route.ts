import { NextRequest, NextResponse } from 'next/server';
import { uiUser, uiJson, uiFailure, privateHeaders } from '@/lib/ui-design/access';
import { registerUiImage, uiImageBytes } from '@/lib/ui-design/media';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  try { return uiJson(await registerUiImage(await uiUser(request), await request.json())); } catch (error) { return uiFailure(error); }
}
export async function GET(request: NextRequest) {
  try { const { asset, bytes } = await uiImageBytes(await uiUser(request), request.nextUrl.searchParams.get('id') || '');
    return new NextResponse(new Uint8Array(bytes), { headers: { ...privateHeaders, 'Content-Type': asset.mime_type, ...(request.nextUrl.searchParams.has('download') ? { 'Content-Disposition': 'attachment; filename="ui-design.png"' } : {}) } });
  } catch (error) { return uiFailure(error); }
}
