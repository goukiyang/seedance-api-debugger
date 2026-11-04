import { NextRequest } from 'next/server';
import { requireLabUser, labFailure, labPrivateHeaders } from '@/lib/character-lab/http';
import { labId, readLabWorkspace } from '@/lib/character-lab/store';
import { composeLabSheet, readLabComposition } from '@/lib/character-lab/composition';
import { StudioError } from '@/lib/image-studio/tasks';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const user = await requireLabUser(), query = request.nextUrl.searchParams;
    const id = labId(query.get('workspace'), '角色项目');
    const composition = query.get('composition');
    const headers: Record<string, string> = { ...labPrivateHeaders, 'Content-Type': 'image/png' };
    if (query.get('download') === '1') headers['Content-Disposition'] = 'attachment; filename="character-reference.png"';
    if (composition) {
      const { png } = await readLabComposition(user, id, labId(composition, '合成图'));
      return new Response(new Uint8Array(png), { headers });
    }
    const workspace = await readLabWorkspace(user.id, id);
    if (String(workspace.revision) !== query.get('revision')) throw new StudioError('工作现场已更新，请核对选用图片后再合成', 409);
    return new Response(new Uint8Array(await composeLabSheet(user, workspace)), { headers });
  } catch (error) {
    return labFailure(error);
  }
}
