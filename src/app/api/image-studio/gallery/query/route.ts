import { queryGalleryDirectory } from '@/lib/image-studio/gallery-page';
import { StudioSharingError } from '@/lib/image-studio/shared-contract';
import { reactionUser, reactionJson, reactionError } from '@/lib/content-reactions/http';
import { traceHttpRequest, tracePhase } from '@/lib/performance/request-trace';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  return traceHttpRequest('studio.gallery', request.headers, async () => {
  try {
    const user = await tracePhase('auth', () => reactionUser(request));
    const expectedActor = request.headers.get('x-app-session-user');
    if (expectedActor && expectedActor !== user.id) return await tracePhase('serialize', async () => reactionJson({ error: '账号已变化，请重新打开封面目录', code: 'account-changed' }, 409));
    const parsed = await tracePhase('parse', async (): Promise<{ input: unknown } | { error: string; status: number }> => {
      if (Number(request.headers.get('content-length')) > 512 * 1024) return { error: '封面查询内容超限', status: 413 };
      const reader = request.body?.getReader();
      if (!reader) return { error: '封面查询格式无效', status: 400 };
      const chunks: Uint8Array[] = []; let bytes = 0;
      for (;;) {
        const result = await reader.read(); if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > 512 * 1024) { await reader.cancel(); return { error: '封面查询内容超限', status: 413 }; }
        chunks.push(result.value);
      }
      return { input: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    });
    if ('error' in parsed) return await tracePhase('serialize', async () => reactionJson({ error: parsed.error }, parsed.status));
    const result = await tracePhase('data', () => queryGalleryDirectory(user, parsed.input));
    return await tracePhase('serialize', async () => reactionJson(result));
  } catch (error) {
    return tracePhase('serialize', async () => {
      if (error instanceof StudioSharingError) return reactionJson({ error: error.message, code: error.reasonCode }, error.status);
      return reactionError(error);
    });
  }
  });
}
