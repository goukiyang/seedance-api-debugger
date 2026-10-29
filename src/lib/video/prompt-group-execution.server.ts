import 'server-only';
import { sealPrivatePrompt, PrivatePromptError, type PrivateOrigin } from '@/lib/security/private-prompts.server';

export function protectVideoPromptGroupTask<T extends { id: string }>(task: T, origins: PrivateOrigin[]): T {
  if (!origins.length) return task;
  const value = (task as Record<string, unknown>).final_prompt_snapshot;
  if (typeof value !== 'string') throw new PrivatePromptError();
  // New video groups require encryption even while older modules remain compatible-read.
  return { ...task, final_prompt_snapshot: sealPrivatePrompt(value, { kind: 'video-task', id: task.id, field: 'final_prompt_snapshot', origins }) };
}
export function protectVideoPromptGroupSnapshot<T extends { id: string }>(snapshot: T, origins: PrivateOrigin[]): T {
  if (!origins.length) throw new PrivatePromptError();
  const result = { ...snapshot } as Record<string, unknown>;
  for (const field of ['prompt_rendered', 'provider_payload_json']) {
    const text = result[field];
    if (typeof text === 'string') result[field] = sealPrivatePrompt(text, { kind: 'video-generation-snapshot', id: snapshot.id, field, origins });
  }
  return result as T;
}
