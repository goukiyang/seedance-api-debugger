import type { SharedStudioCapability, SharedStudioReasonCode, SharedStudioStateProjection } from './shared-types';

export const studioStateReason: Record<SharedStudioReasonCode, string> = {
  'login-required': '请重新登录，本人历史仍保留',
  'access-revoked': '当前账号无权使用此模板，本人历史仍保留',
  'source-withdrawn': '作者已停止共享，本人输入和历史仍保留',
  'source-archived': '模板已删除，本人历史仍保留',
  'source-missing': '模板已不可用，本人历史仍保留',
  'dependency-invalid': '模板需要作者修复，暂时不能开始新生成',
  'state-conflict': '模板已更新，请重新读取；当前草稿仍保留',
  'read-unavailable': '暂时无法同步，请稍后重试',
};
type Input = Omit<SharedStudioStateProjection, 'capabilities' | 'reasonCode'> & {
  actorAllowed: boolean; ownsWorkspace: boolean; canViewSource: boolean; canManageSource: boolean;
  reasonCode?: SharedStudioReasonCode | null;
};
export function projectSharedStudioCapabilities(input: Input): SharedStudioStateProjection {
  const reasonCode = input.reasonCode !== undefined ? input.reasonCode : (!input.actorAllowed ? 'access-revoked'
    : input.lifecycle === 'missing' ? 'source-missing' : input.lifecycle === 'archived' ? 'source-archived'
    : !input.canViewSource ? input.sharing === 'private' ? 'source-withdrawn' : 'access-revoked'
    : input.dependency === 'invalid' ? 'dependency-invalid' : input.dependency === 'unknown' ? 'read-unavailable' : null);
  const capability = (allowed: boolean, denied: SharedStudioReasonCode | null = reasonCode): SharedStudioCapability => ({
    allowed, reasonCode: allowed ? null : denied ?? 'access-revoked', reason: allowed ? null : studioStateReason[denied ?? 'access-revoked'],
  });
  const personal = input.actorAllowed && input.ownsWorkspace;
  const manages = input.actorAllowed && input.canManageSource && input.lifecycle === 'active';
  const trusted = reasonCode !== 'read-unavailable' && reasonCode !== 'state-conflict';
  return {
    objectKind: input.objectKind, lifecycle: input.lifecycle, sharing: input.sharing, dependency: input.dependency, reasonCode,
    sourceRevision: input.sourceRevision, moduleRevision: input.moduleRevision, definitionToken: input.definitionToken,
    capabilities: {
      viewOwnHistory: capability(personal, 'access-revoked'), editPersonalDraft: capability(personal, 'access-revoked'),
      editDefinition: capability(manages && trusted), saveDefinition: capability(manages && trusted),
      changeSharing: capability(manages && trusted), deleteSource: capability(manages && trusted),
      generate: capability(input.actorAllowed && input.canViewSource && input.lifecycle === 'active' && input.dependency === 'ready' && reasonCode === null),
    },
  };
}
