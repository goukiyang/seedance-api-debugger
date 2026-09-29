import { createHash } from 'node:crypto';
import { stableGenerationPayloadJson } from '@/lib/template-studio-video-handoff';

export function generationRequestFingerprint(value: unknown): string {
  return createHash('sha256').update(stableGenerationPayloadJson(value)).digest('hex');
}
