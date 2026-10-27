import 'server-only';
import { getSession } from '@/lib/auth/session';
import { privatePromptCapabilities, PrivatePromptAccessError } from './private-prompt-identity.server';
import { type PrivateOrigin } from './private-prompts.server';

// Reload the signed session, not an identity freshly projected from database columns.
export async function privatePromptRequestCapabilities(userId: string, origins: PrivateOrigin[]) {
  // Background workers have no HTTP cookie scope and never receive raw-text UI capabilities.
  const user = await getSession().catch(() => null);
  if (!user || user.id !== userId) return { canReadPrivatePrompt: false, canEditPrivatePrompt: false, requiresIdentityVerification: false };
  return privatePromptCapabilities(user, origins);
}
export async function requirePrivatePromptRequest(userId: string, origins: PrivateOrigin[]) {
  if (!origins.length) {
    const user = await getSession().catch(() => null);
    if (user?.id === userId && user.role === 'admin') return;
    throw new PrivatePromptAccessError();
  }
  if (!(await privatePromptRequestCapabilities(userId, origins)).canEditPrivatePrompt) throw new PrivatePromptAccessError();
}
