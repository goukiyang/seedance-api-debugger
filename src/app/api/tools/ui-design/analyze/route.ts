import { NextRequest } from 'next/server';
import { uiUser, uiJson, uiFailure } from '@/lib/ui-design/access';
import { readUiDocument } from '@/lib/ui-design/store';
import { analyzeUiDesign } from '@/lib/ui-design/analysis';
export const dynamic = 'force-dynamic';
export const maxDuration = 360;
export async function POST(request: NextRequest) {
  try { return uiJson(await analyzeUiDesign(await uiUser(request), await request.json(), request.signal)); } catch (error) { return uiFailure(error); }
}

export async function GET(request: NextRequest) {
  try { const user = await uiUser(request); return uiJson(await readUiDocument(user.id, 'analysis', request.nextUrl.searchParams.get('id') || '')); } catch (error) { return uiFailure(error); }
}
