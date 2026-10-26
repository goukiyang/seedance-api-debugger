export type AudioKind = 'speech' | 'background_music' | 'sound_effect';
export type AudioInput = { kind: AudioKind; model: string; prompt: string; durationSeconds?: number; voice?: string };
export type AudioPointsQuote = { points: number; pricingRevision: string; inputFingerprint: string; expiresAt: string };
export type AudioAcceptance =
  | { state: 'accepted'; taskId: string }
  | { state: 'unconfirmed'; requestId: string }
  | { state: 'rejected'; message: string };

// Future adapters must expose a real point quote and exact-request lookup before any submit route is enabled.
export interface AudioProviderAdapter {
  quote(input: AudioInput): Promise<AudioPointsQuote | null>;
  submit(input: AudioInput, requestId: string, quote: AudioPointsQuote): Promise<AudioAcceptance>;
  lookup(requestId: string): Promise<AudioAcceptance>;
}

export const AUDIO_CAPABILITY = Object.freeze({
  enabled: false,
  configured: false,
  status: 'deferred_unconfigured',
  plannedKinds: ['speech', 'background_music', 'sound_effect'] as readonly AudioKind[],
  models: [] as readonly string[],
  quote: null,
  materialSupported: true,
  message: '目前只支持添加音频素材，音频生成暂未接通。',
});
