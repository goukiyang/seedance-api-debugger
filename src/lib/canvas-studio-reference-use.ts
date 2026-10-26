import { AuthError, type SessionUser } from './auth/session';
import { assertCanUseReferenceImage } from './reference-albums/permissions';

// A use grant is not an import/copy/download grant. Keep the original Asset and owner.
export async function resolveCanvasStudioReferenceUse(user: SessionUser, ids: string[]) {
  if (ids.length > 9 || ids.some(id => typeof id !== 'string' || !id || id.length > 160)) throw new AuthError('参考图编号或数量无效', 400);
  const owners = new Map<string, string>();
  for (const id of ids) {
    const image = await assertCanUseReferenceImage(user, id);
    if (!image.asset_id || !image.asset || image.asset.id !== image.asset_id
      || image.asset.status !== 'active' || image.asset.type !== 'image') {
      throw new AuthError('此旧参考图没有可用的持久原件记录，无法安全恢复生成；未提交，请选择已有原件记录的参考图', 409);
    }
    owners.set(image.asset_id, image.asset.owner_id);
  }
  return owners;
}
