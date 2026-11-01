import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { tracePhase } from '@/lib/performance/request-trace';
import type { CapturedImageBillingInputs } from '@/lib/image-studio/billing-readiness';
import type { ImageGenerationChannels } from '@/lib/integrations/image-generation';
import type { ImageGenerationChannelsDto } from '@/lib/integrations/image-generation-channel';
import type { ImageGenerationRouteInputs } from '@/lib/integrations/image-generation-defaults';

export type CapturedPricingImageInputs = CapturedImageBillingInputs & Readonly<{
  shared: string | null; banana: string | null; registry: string | null;
  sharedModels: string | null; bananaModels: string | null; studio: string | null;
  defaults: string | null; versions: ReadonlyMap<string, string>;
}>;
export type CapturedPricingMenuInputs = Readonly<{
  image: CapturedPricingImageInputs;
  policy: string | null; policyRevision: string | null; authoring: string | null;
  ip: string | null; enhance: string | null; h3: string | null; imageConsumer: string | null;
}>;
export type PricingMenuSources = {
  inputs: CapturedPricingMenuInputs; channels: ImageGenerationChannels;
  options: ImageGenerationChannelsDto; routes: ImageGenerationRouteInputs;
  sourceValidation: Map<string, Promise<Map<string, string>>>;
};

const FIXED_KEYS = [
  'image_generation_api_v1', 'banana_image_api_v1', 'image_generation_channels_v1',
  'image_generation_legacy_model_api_v1:shared', 'image_generation_legacy_model_api_v1:banana',
  'gpt_image_studio_v1', 'image_generation_model_defaults_v1', 'image_actual_billing_intent_v1',
  'pricing_policy_v1', 'pricing_authoring_v1', 'pricing_worker_capability_v1:image',
  'volcengine_ip_api_v1', 'aimediakit_enhance_video_api_v1', 'h3_video_api_v1',
] as const;

/** One statement snapshot, with only current references and explicitly discovered proof keys. */
export async function capturePricingMenuInputs(proofKeys: readonly string[] = []): Promise<CapturedPricingMenuInputs> {
  const rows = await tracePhase('capture', () => prisma.$queryRaw<Array<{ key: string; value_json: string }>>(Prisma.sql`
    WITH fixed_keys AS (SELECT value AS key FROM json_each(${JSON.stringify(FIXED_KEYS)})),
    fixed_rows AS (SELECT p.key, p.value_json FROM fixed_keys k JOIN PlatformSetting p ON p.key = k.key),
    safe_registry AS (
      SELECT CASE WHEN json_valid(value_json) THEN value_json ELSE '{}' END AS value
      FROM fixed_rows WHERE key = 'image_generation_channels_v1'
    ),
    managed AS (
      SELECT CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END AS value
      FROM safe_registry r, json_each(CASE WHEN json_type(r.value, '$.channels') = 'array'
        THEN json_extract(r.value, '$.channels') ELSE '[]' END) j
    ),
    safe_policy AS (
      SELECT CASE WHEN json_valid(value_json) THEN value_json ELSE '{}' END AS value
      FROM fixed_rows WHERE key = 'pricing_policy_v1'
    ),
    wanted_keys AS (
      SELECT key FROM fixed_keys
      UNION SELECT 'image_generation_channel_version_v1:' || json_extract(value, '$.id') || ':' || json_extract(value, '$.configRevision')
        FROM managed WHERE json_type(value, '$.id') = 'text' AND json_type(value, '$.configRevision') = 'text'
      UNION SELECT 'pricing_policy_revision_v1:' || json_extract(value, '$.revision')
        FROM safe_policy WHERE json_type(value, '$.revision') = 'text'
      UNION SELECT value FROM json_each(${JSON.stringify(proofKeys)})
    )
    SELECT p.key, p.value_json FROM wanted_keys k JOIN PlatformSetting p ON p.key = k.key
  `));
  const values = new Map(rows.map(row => [row.key, row.value_json]));
  const raw = (key: typeof FIXED_KEYS[number]) => values.get(key) ?? null;
  const versions = new Map(rows.filter(row => row.key.startsWith('image_generation_channel_version_v1:')).map(row => [row.key, row.value_json]));
  const proofs = new Map(proofKeys.flatMap(key => values.has(key) ? [[key, values.get(key)!] as const] : []));
  // There is at most one current policy revision reference in this statement.
  const policyRevision = rows.find(row => row.key.startsWith('pricing_policy_revision_v1:'))?.value_json ?? null;
  return { image: { shared: raw('image_generation_api_v1'), banana: raw('banana_image_api_v1'),
    registry: raw('image_generation_channels_v1'), sharedModels: raw('image_generation_legacy_model_api_v1:shared'),
    bananaModels: raw('image_generation_legacy_model_api_v1:banana'), studio: raw('gpt_image_studio_v1'),
    defaults: raw('image_generation_model_defaults_v1'), intent: raw('image_actual_billing_intent_v1'), versions, proofs },
    policy: raw('pricing_policy_v1'), policyRevision, authoring: raw('pricing_authoring_v1'),
    ip: raw('volcengine_ip_api_v1'), enhance: raw('aimediakit_enhance_video_api_v1'), h3: raw('h3_video_api_v1'),
    imageConsumer: raw('pricing_worker_capability_v1:image') };
}
