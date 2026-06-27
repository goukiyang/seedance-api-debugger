import { NextResponse } from 'next/server';
import { getProviderConfig, isApiKeyConfigured } from '@/lib/provider/jimeng';
import { getAiMediaKitApiSettings, safeAiMediaKitConfigDto } from '@/lib/integrations/aimediakit';

export async function GET() {
  const config = getProviderConfig();
  const aiMediaKitConfig = safeAiMediaKitConfigDto(await getAiMediaKitApiSettings());

  return NextResponse.json({
    provider: 'seedance',
    base_url: config.baseUrl,
    model: config.model,
    api_key_configured: isApiKeyConfigured(),
    aimediakit_enhance_video: {
      enabled: aiMediaKitConfig.enabled,
      ready: aiMediaKitConfig.ready,
      base_url: aiMediaKitConfig.base_url,
      api_key_configured: aiMediaKitConfig.api_key_configured,
    },
  });
}
