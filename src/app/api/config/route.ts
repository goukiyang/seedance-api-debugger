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
      configured: h3Config.configured,
      base_url_configured: Boolean(h3Config.base_url),
      default_preset_id: h3Config.default_preset_id,
      default_lora_id: h3Config.default_lora_id,
      preset_options: h3Config.preset_options,
      lora_options: h3Config.lora_options,
      api_token_configured: h3Config.api_token_configured,
      admin_queue_ready: h3Config.admin_queue_ready,
      health: h3Config.health
        ? {
            api: h3Config.health.api,
            version: h3Config.health.version,
            worker: h3Config.health.worker,
            comfyui: h3Config.health.comfyui,
            preset_count: h3Config.health.preset_count,
            billing: h3Config.health.billing
              ? {
                  charged: h3Config.health.billing.charged,
                  cost: h3Config.health.billing.cost,
                  currency: h3Config.health.billing.currency,
                  cost_model: h3Config.health.billing.cost_model,
                }
              : null,
            queue: h3Config.health.queue
              ? {
                  paused: h3Config.health.queue.paused,
                  pending: h3Config.health.queue.pending,
                  running: h3Config.health.queue.running,
                  max_pending_jobs: h3Config.health.queue.max_pending_jobs,
                  active: h3Config.health.queue.active,
                  max_active_jobs: h3Config.health.queue.max_active_jobs,
                }
              : null,
            checked_at: h3Config.health.checked_at,
          }
        : null,
    },
  }, {
    headers: {
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
