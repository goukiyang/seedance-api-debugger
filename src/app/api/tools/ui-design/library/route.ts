import { NextRequest, NextResponse } from 'next/server';
import { uiUser, uiJson, uiFailure, privateHeaders } from '@/lib/ui-design/access';
import { sourceLibrary, packageFile } from '@/lib/ui-design/runtime';
import { saveUiDocument, readUiDocument } from '@/lib/ui-design/store';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  try { const user = await uiUser(request), asset = request.nextUrl.searchParams.get('asset');
    if (asset) {
      if (!/^[a-f0-9]{64}\.(?:png|jpe?g|webp)$/.test(asset)) return uiJson({ error: '文件不存在' }, 404);
      return new NextResponse(new Uint8Array(await packageFile(`library/figma-cache/assets/${asset}`)), { headers: { ...privateHeaders, 'Content-Type': /\.jpe?g$/.test(asset) ? 'image/jpeg' : asset.endsWith('.webp') ? 'image/webp' : 'image/png' } });
    }
    const id = request.nextUrl.searchParams.get('id');
    if (id) return uiJson(await readUiDocument(user.id, 'library', id));
    const library = await sourceLibrary();
    const rewrite = JSON.stringify(library).replaceAll('/api/figma-assets/', '/api/tools/ui-design/library?asset=');
    return uiJson({ library: JSON.parse(rewrite) });
  } catch (error) { return uiFailure(error); }
}
export async function POST(request: NextRequest) {
  try { const user = await uiUser(request), body = await request.json();
    return uiJson(await saveUiDocument(user.id, 'library', body.id, body.revision, body.data));
  } catch (error) { return uiFailure(error); }
}
