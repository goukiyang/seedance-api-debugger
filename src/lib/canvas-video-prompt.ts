import { AuthError, type SessionUser } from './auth/session';
import { assertCanUseReferenceImage } from './reference-albums/permissions';
import { compileCanvasPromptReferences, CanvasPromptReferenceError } from './canvas-prompt-references';

export async function compileCanvasVideoPrompt(user: SessionUser, prompt: string, mentions: unknown,
  selectedIds: string[], prepared: Array<{ order: number; originalUrl: string }>, sentUrls: string[]) {
  try {
    if (new Set(selectedIds).size !== selectedIds.length) throw new AuthError('绑定参考图重复，请重新选择', 400);
    const sentIds = sentUrls.map(url => {
      const matches = prepared.filter(image => image.originalUrl === url);
      const id = matches.length === 1 ? selectedIds[matches[0].order] : undefined;
      if (!id) throw new AuthError('实际发送原图与绑定清单无法唯一对应，请重新选择参考图', 400);
      return id;
    });
    const assets = new Map<string, string>();
    for (const id of sentIds) {
      const image = await assertCanUseReferenceImage(user, id);
      assets.set(id, image.asset_id || id);
    }
    const compiled = compileCanvasPromptReferences({ prompt, promptMentions: mentions, referenceImageIds: sentIds });
    return { promptRendered: compiled.prompt,
      canvasPromptFingerprint: compiled.fingerprint,
      assetMapping: Object.fromEntries(Object.entries(compiled.mapping).map(([key, id]) => [key, assets.get(id)!])) };
  } catch (error) {
    if (error instanceof CanvasPromptReferenceError) throw new AuthError(error.message, 400);
    throw error;
  }
}
