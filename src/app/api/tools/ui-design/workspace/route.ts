import { NextRequest } from 'next/server';
import { uiUser, uiJson, uiFailure } from '@/lib/ui-design/access';
import { readUiDocument, saveUiDocument, listUiDocuments } from '@/lib/ui-design/store';
import { assertCanGenerateInProject } from '@/lib/projects/permissions';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  try { const user = await uiUser(request), id = request.nextUrl.searchParams.get('id');
    return uiJson(id ? await readUiDocument(user.id, 'workspace', id) : await listUiDocuments(user.id, 'workspace', request.nextUrl.searchParams.get('cursor') || undefined));
  } catch (error) { return uiFailure(error); }
}
export async function POST(request: NextRequest) {
  try { const user = await uiUser(request), body = await request.json();
    if (body.data.projectId) await assertCanGenerateInProject(user, body.data.projectId);
    return uiJson(await saveUiDocument(user.id, 'workspace', body.id, body.revision, body.data, body.archived === true));
  } catch (error) { return uiFailure(error); }
}
