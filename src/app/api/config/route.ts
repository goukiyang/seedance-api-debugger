import { NextResponse } from 'next/server';
import { getProviderConfig, isApiKeyConfigured } from '@/lib/provider/jimeng';
import { getAiMediaKitApiSettings, safeAiMediaKitConfigDto } from '@/lib/integrations/aimediakit';
import { getH3ApiSettings, safeH3ConfigDto } from '@/lib/integrations/h3';

export const dynamic = 'force-dynamic';

export async function GET() {
  const config = getProviderConfig();
  const aiMediaKitConfig = safeAiMediaKitConfigDto(await getAiMediaKitApiSettings());
  const h3Config = safeH3ConfigDto(await getH3ApiSettings());

  return NextResponse.json({
    provider: 'seedance',
    base_url: config.baseUrl,
    model: config.model,
    model_options: config.model_options,
    api_key_configured: isApiKeyConfigured(),
    aimediakit_enhance_video: {
      enabled: aiMediaKitConfig.enabled,
      ready: aiMediaKitConfig.ready,
      base_url: aiMediaKitConfig.base_url,
      api_key_configured: aiMediaKitConfig.api_key_configured,
    },
    h3_video: {
      provider: h3Config.provider,
      enabled: h3Config.enabled,
      ready: h3Config.ready,
      base_url: h3Config.base_url,
      default_preset_id: h3Config.default_preset_id,
      preset_options: h3Config.preset_options,
      api_token_configured: h3Config.api_token_configured,
      admin_queue_ready: h3Config.admin_queue_ready,
    },
  }, {
    headers: {
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
