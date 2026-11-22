import { NextRequest } from 'next/server';
import { uiUser, uiJson, uiFailure } from '@/lib/ui-design/access';
import { privateManifest } from '@/lib/ui-design/runtime';
import { listUiDocuments } from '@/lib/ui-design/store';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  try { const user = await uiUser(request), manifest = await privateManifest();
    return uiJson({ user: { id: user.id, name: user.name }, sourceVersion: manifest.sourceSha256, counts: manifest.counts,
      capabilities: manifest.dependencies, history: await listUiDocuments(user.id, 'workspace') });
  } catch (error) { return uiFailure(error); }
}
