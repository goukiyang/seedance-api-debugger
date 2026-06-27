import { NextResponse } from 'next/server';
import { getProviderConfig, isApiKeyConfigured } from '@/lib/provider/jimeng';
import { isAiMediaKitConfigured } from '@/lib/provider/aimediakit-enhance-video';

export async function GET() {
  const config = getProviderConfig();

  return NextResponse.json({
    provider: 'seedance',
    base_url: config.baseUrl,
    model: config.model,
    api_key_configured: isApiKeyConfigured(),
    aimediakit_enhance_video: {
      api_key_configured: isAiMediaKitConfigured(),
    },
  });
}
