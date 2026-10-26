import { createHash } from 'node:crypto';
import type { ImageGenerationApiSettings } from '@/lib/integrations/image-generation';

export function imageBillingScope(settings: Pick<ImageGenerationApiSettings, 'provider' | 'base_url' | 'api_key'>) {
  const url = new URL(settings.base_url);
  if (url.protocol !== 'https:' || url.username || url.password || !settings.api_key) throw new Error('Billing scope unavailable');
  return createHash('sha256').update(`${settings.provider}\0${url.origin}\0${settings.api_key}`).digest('hex');
}
