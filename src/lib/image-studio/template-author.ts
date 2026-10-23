import 'server-only';
import type { ImageStudioPreset } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { displayUserName } from '@/lib/users/display';
import { canUseCompanyTemplates, canViewStudioPreset, type ImageStudioIdentity } from './access';
import { assertStudioActor, readStudioTemplateSourceIdentity, type SharedStudioClient } from './shared-contract';
import type { StudioTemplateRead } from './shared-types';

type OwnerRow = { id: string; name: string; username: string; avatar_url: string | null; account_type: string;
  status: string; feishu_open_id: string | null; feishu_tenant_key: string | null };

export type StudioTemplateAuthorResolution = {
  actor: ImageStudioIdentity;
  templateRead: StudioTemplateRead;
  preset: ImageStudioPreset | null;
  owner: OwnerRow | null;
  bindingConfirmed: boolean;
  ordinarilyVisible: boolean;
};

const unknown = (sourceKind: StudioTemplateRead['sourceKind'], sourceId: string, sourceRevision: string | null): StudioTemplateRead => ({
  sourceKind, sourceId, sourceRevision,
  author: { state: 'unknown', displayName: null, avatarUrl: null, isSelf: false },
  canViewTemplateContext: false,
});

export async function resolveStudioTemplateAuthor(user: ImageStudioIdentity,
  target: { presetId?: string; moduleId?: string }, client: SharedStudioClient = prisma): Promise<StudioTemplateAuthorResolution> {
  const actor = await assertStudioActor(user.id, client);
  if (!canUseCompanyTemplates(actor)) throw new Error('无权读取模板作者');
  const hasPreset = typeof target.presetId === 'string' && target.presetId.length > 0 && target.presetId.length <= 160;
  const hasModule = typeof target.moduleId === 'string' && target.moduleId.length > 0 && target.moduleId.length <= 160;
  if (hasPreset === hasModule) throw new Error('模板来源参数无效');
  let presetId = hasPreset ? target.presetId! : null;
  if (hasModule) {
    const module = await client.imageStudioModule.findFirst({ where: { id: target.moduleId!, owner_id: actor.id },
      select: { id: true, owner_id: true, source_preset_id: true, revision: true } });
    if (!module) throw new Error('模板不存在或无权读取');
    if (!module.source_preset_id) {
      const owner = await client.user.findUnique({ where: { id: module.owner_id }, select: { id: true, name: true, username: true,
        avatar_url: true, account_type: true, status: true, feishu_open_id: true, feishu_tenant_key: true } });
      const known = owner?.account_type === 'internal';
      return { actor, preset: null, owner: known ? owner : null, bindingConfirmed: known, ordinarilyVisible: true,
        templateRead: known ? { sourceKind: 'local-module', sourceId: module.id, sourceRevision: String(module.revision),
          author: { state: 'known', displayName: displayUserName(owner), avatarUrl: owner.avatar_url, isSelf: owner.id === actor.id },
          canViewTemplateContext: owner.id === actor.id } : unknown('local-module', module.id, String(module.revision)) };
    }
    presetId = module.source_preset_id;
  }
  const preset = await client.imageStudioPreset.findUnique({ where: { id: presetId! } });
  if (!preset) return { actor, preset: null, owner: null, bindingConfirmed: false, ordinarilyVisible: false,
    templateRead: unknown('unknown', presetId!, null) };
  const ordinarilyVisible = canViewStudioPreset(actor, preset);
  const { owner, bindingConfirmed } = await readStudioTemplateSourceIdentity(preset.owner_id, preset.id, client);
  const known = bindingConfirmed && owner?.account_type === 'internal';
  const sourceRevision = preset.updated_at.toISOString();
  const templateRead = known ? {
    sourceKind: 'preset' as const, sourceId: preset.id, sourceRevision,
    author: { state: 'known' as const, displayName: displayUserName(owner), avatarUrl: owner.avatar_url, isSelf: owner.id === actor.id },
    canViewTemplateContext: owner.id === actor.id || actor.role === 'admin' && actor.account_type === 'internal',
  } : unknown('preset', preset.id, sourceRevision);
  return { actor, preset, owner: known ? owner : null, bindingConfirmed, ordinarilyVisible, templateRead };
}
