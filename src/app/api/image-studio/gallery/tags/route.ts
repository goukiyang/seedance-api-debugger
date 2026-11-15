import { reactionUser, reactionJson, reactionError } from '@/lib/content-reactions/http';
import { StudioSharingError } from '@/lib/image-studio/shared-contract';
import { saveTemplateTags } from '@/lib/image-studio/template-tags.server';

export const dynamic = 'force-dynamic';
export async function PUT(request: Request) {
  try {
    const user = await reactionUser(request);
    if (Number(request.headers.get('content-length')) > 8000) return reactionJson({ error: '标签内容过长' }, 413);
    return reactionJson(await saveTemplateTags(user, await request.json()));
  } catch (error) {
    if (error instanceof SyntaxError) return reactionJson({ error: '模板标签保存内容无效' }, 400);
    if (error instanceof StudioSharingError) return reactionJson({ error: error.message }, error.status);
    return reactionError(error);
  }
}
