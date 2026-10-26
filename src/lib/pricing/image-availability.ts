import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_QUALITY_OPTIONS, type ImageStudioModel } from '@/lib/image-studio/model-catalog';
import { imageResolutionOptions } from '@/lib/image-generation/resolution';
import { validateImageGenerationChannel, type ImageGenerationResolvedSettings } from '@/lib/integrations/image-generation';
import type { PricingAdminIdentity } from './admin-contract';
import { PricingItemUnavailableError, type PricingItemUnavailableReason } from './item-unavailable';

/** Called only after the pricing readers have successfully validated current configuration. */
export function assertPricingImageAvailability(settings: ImageGenerationResolvedSettings, identity: PricingAdminIdentity,
  specifications: { quality?: string; resolution?: string; ratio?: string } = identity.specifications) {
  const model = identity.modelId as ImageStudioModel;
  if (!IMAGE_STUDIO_MODELS.includes(model)) throw new Error('图片收费型号身份无效');
  const fail = (reason: PricingItemUnavailableReason, message: string): never => { throw new PricingItemUnavailableError(identity, reason, message); };
  if (settings.deleted) fail('configuration_missing', '该供应商已归档，未切换供应商');
  if (!settings.enabled) fail('disabled', '该供应商已停用');
  if (!settings.api_key || !settings.base_url) fail('configuration_missing', '该供应商尚未配置完整');
  if (specifications.quality !== undefined && !(IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[model] as readonly string[]).includes(specifications.quality)) {
    fail('specification_unsupported', '该型号不支持当前图片质量，当前选择未被替换');
  }
  if (specifications.resolution !== undefined && !imageResolutionOptions(model, settings.provider).includes(specifications.resolution as never)) {
    fail('specification_unsupported', '该型号不支持当前分辨率，当前选择未被替换');
  }
  const validation = validateImageGenerationChannel(settings, { model, quality: specifications.quality,
    resolution: specifications.resolution, ratio: specifications.ratio });
  if (validation.ok) return validation.capability;
  const reasons: Record<string, PricingItemUnavailableReason> = {
    image_channel_model_not_enabled: 'model_not_enabled', image_channel_capability_unknown: 'evidence_unconfirmed',
    image_channel_actual_billing_unavailable: 'evidence_unconfirmed', image_channel_actual_billing_not_ready: 'evidence_unconfirmed',
    image_channel_fixed_price_missing: 'price_unconfigured', image_channel_capability_mismatch: 'specification_unsupported',
    image_channel_reference_limit_unknown: 'specification_unsupported',
  };
  const reason = reasons[validation.code];
  if (!reason) throw new Error(`Unexpected image capability failure: ${validation.code}`);
  return fail(reason, validation.error);
}
