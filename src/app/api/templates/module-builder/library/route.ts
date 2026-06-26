import { NextRequest, NextResponse } from 'next/server';
import { AuthError, getSession, requireAdmin } from '@/lib/auth/session';
import { getTemplateModuleLibrary } from '@/lib/templates/module-library';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const user = await getSession();
  try {
    requireAdmin(user);
    const templateId = request.nextUrl.searchParams.get('template_id') || '';
    const library = await getTemplateModuleLibrary();
    const modules = templateId
      ? library.modules.filter((item) => item.scope === 'global' || item.source.template_id === templateId)
      : library.modules;
    return NextResponse.json({ modules, updated_at: library.updated_at });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[ModuleBuilder] Load library failed:', error);
    return NextResponse.json({ error: '读取模块库失败' }, { status: 500 });
  }
}
