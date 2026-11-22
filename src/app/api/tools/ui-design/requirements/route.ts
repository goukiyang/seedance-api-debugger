import { NextRequest } from 'next/server';
import { uiUser, uiJson, uiFailure } from '@/lib/ui-design/access';
import { privateModule } from '@/lib/ui-design/runtime';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  try { await uiUser(request); const parser = await privateModule('requirements-source.cjs'); return uiJson(await parser.readRequirementFile(await request.json())); }
  catch (error) { return uiFailure(Object.assign(error as object, { status: (error as { status?: number }).status || 422 })); }
}
