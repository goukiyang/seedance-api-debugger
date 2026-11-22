import { NextRequest } from 'next/server';
import { uiUser, uiJson, uiFailure } from '@/lib/ui-design/access';
import { privateModule } from '@/lib/ui-design/runtime';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  try {
    await uiUser(request); const parser = await privateModule('visual-reference-source.cjs'), body = await request.json();
    try { return uiJson(await parser.loadVisualReference({ url: body.url })); }
    catch (error) { return uiJson({ error: error instanceof Error ? error.message : '尚未读到参考画面，请粘贴截图', ...parser.referenceErrorDetails(error) }, 422); }
  } catch (error) { return uiFailure(error); }
}
