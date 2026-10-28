import type { SharedStudioCapability, SharedStudioReasonCode, SharedStudioStateProjection } from './shared-types';
import type { ImageStudioChannel } from './channels';
import { IMAGE_25_QUALITY_MODEL, isImage25Quality } from './quality-routing';
import { isStandardStudioRatio, normalizeStudioRatio } from './ratios';
import { MAX_REFERENCE_IMAGES } from './limits';

export type ImageChannelValues = { legacyReady?: boolean; quality?: string; resolution?: string; ratio?: string; referenceCount?: number; legacyRoute?: boolean };
export function sharedImageStudioChannelIssue(channel: ImageStudioChannel | undefined, model: string, values: ImageChannelValues) {
  if (model === IMAGE_25_QUALITY_MODEL && !isImage25Quality(values.quality)) return '原质量待选择，请选择中等或最高；素材和描述已保留。';
  if (!channel || !channel.configured || !channel.enabled) return channel?.disabledReason || `${channel?.label || '所选生图通道'}未配置或已停用，请联系管理员。`;
  const capability = channel.models?.[model];
  if (channel.id === 'original' && values.legacyRoute !== false && !capability?.pricingBySpecification) return values.legacyReady === false ? '当前模型的原接口尚未就绪，请联系管理员检查接口。' : null;
  const allowsUnconfirmed = ['gemini-3-pro-image-preview', 'gemini-nano-banana-2.1'].includes(model) && capability?.allowsUnconfirmedParameters === true;
  if (capability) {
    const missing = [!allowsUnconfirmed && !capability.qualities?.length ? '图片质量' : null,
      !allowsUnconfirmed && !capability.resolutions?.length ? '分辨率' : null,
      !allowsUnconfirmed && capability.maxReferences == null ? '参考图上限' : null,
      !capability.billingMode ? '计费方式' : null,
      capability.billingMode === 'fixed' && !capability.pricingBySpecification && capability.fixedPoints == null && !['shared', 'banana'].includes(channel.id) ? '固定点数' : null].filter(Boolean);
    if (missing.length) return `${model} 的当前供应商尚未确认${missing.join('、')}。当前选择和素材已保留，请管理员补齐该型号配置。`;
  }
  if (!channel.ready) return channel.disabledReason || `${channel.label}暂未就绪，请联系管理员。`;
  if (!capability || !capability.ready) return capability?.disabledReason || '当前供应商的所选型号尚未就绪；当前选择和素材已保留，请联系管理员检查配置。';
  if (!capability.billingMode) return '当前生图通道的计费方式尚未确认，暂不能生成；请联系管理员检查配置。';
  if (capability.billingMode === 'fixed' && !capability.pricingBySpecification && capability.fixedPoints == null && !['shared', 'banana'].includes(channel.id)) return '当前生图通道的固定点数尚未配置，暂不能生成；请联系管理员检查配置。';
  if (capability.qualities && (!capability.qualities.length || values.quality !== undefined && !capability.qualities.includes(values.quality))) return '当前生图通道不支持所选图片质量，请手动调整后再生成。';
  if (capability.resolutions && (!capability.resolutions.length || values.resolution !== undefined && !capability.resolutions.includes(values.resolution))) return '当前生图通道不支持所选分辨率，请手动调整后再生成。';
  if (values.ratio !== undefined && !isStandardStudioRatio(values.ratio) && !capability.ratios?.some(value => {
    try { return normalizeStudioRatio(value) === normalizeStudioRatio(values.ratio); } catch { return false; }
  })) return '当前生图通道不支持所选比例，请手动调整后再生成。';
  if (!allowsUnconfirmed && (!capability.qualities || !capability.resolutions || capability.maxReferences == null)) return '当前生图通道的图片参数支持范围尚未确认，暂不能生成；请联系管理员补全配置。';
  if (Number.isSafeInteger(capability.maxReferences) && values.referenceCount !== undefined && values.referenceCount > capability.maxReferences!) return `当前生图通道最多使用 ${capability.maxReferences} 张参考图，请减少后再生成。`;
  return values.legacyReady === false && channel.id === 'original' ? '当前模型的原接口尚未就绪，请联系管理员检查接口。' : null;
}
export function canvasImageChannelProjection(channel: ImageStudioChannel, model: string) {
  const capability = channel.models?.[model];
  const allowsUnknownParameters = ['gemini-3-pro-image-preview', 'gemini-nano-banana-2.1'].includes(model) && capability?.allowsUnconfirmedParameters === true;
  const issue = sharedImageStudioChannelIssue(channel, model, { legacyRoute: channel.id === 'original',
    ...(model === IMAGE_25_QUALITY_MODEL ? { quality: 'medium' } : {}) });
  const supplierMax = capability?.maxReferences ?? null;
  const referenceLimit = Number.isSafeInteger(supplierMax) && supplierMax! >= 0 ? Math.min(MAX_REFERENCE_IMAGES, supplierMax!)
    : allowsUnknownParameters || channel.id === 'original' && !issue ? MAX_REFERENCE_IMAGES : null;
  return { issue, supplierMax, platformMax: MAX_REFERENCE_IMAGES, referenceLimit, allowsUnknownParameters };
}

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
  canViewDefinition?: boolean;
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
      viewDefinition: capability(input.actorAllowed && (input.canViewDefinition ?? input.canManageSource), 'access-revoked'),
      editDefinition: capability(manages && trusted), saveDefinition: capability(manages && trusted),
      changeSharing: capability(manages && trusted), deleteSource: capability(manages && trusted),
      generate: capability(input.actorAllowed && input.canViewSource && input.lifecycle === 'active' && input.dependency === 'ready' && reasonCode === null),
    },
  };
}
