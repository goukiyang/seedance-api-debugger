import 'server-only';
import { privatePromptIndex, privatePromptPolicy, privateOrigin, PrivatePromptError, type PrivateOrigin, assertPrivateOrigins } from './private-prompts.server';

export type PrivateSendIdentity = { endpoint: string; provider: string; credential: string; model: string };
export function privateCredentialSendOrigins(origins: PrivateOrigin[] = []) {
  if (origins.length) return origins;
  const credential = privateOrigin('provider-credential', 'outbound-provider');
  return credential ? [credential] : [];
}
export function privateCredentialVersion(provider: string, credential: string) {
  return privatePromptIndex('provider-credential', JSON.stringify([provider, credential]));
}

export async function privateCredentialFetch(identity: PrivateSendIdentity, init: RequestInit,
  transport: typeof fetch = fetch): Promise<Response> {
  const origins = privateCredentialSendOrigins();
  return origins.length ? privatePromptFetch(identity, origins, init, transport) : transport(identity.endpoint, init);
}
export function assertPrivateSend(identity: PrivateSendIdentity, origins: PrivateOrigin[]) {
  assertPrivateOrigins(origins);
  let url: URL;
  try { url = new URL(identity.endpoint); } catch { throw new PrivatePromptError(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !identity.credential) throw new PrivatePromptError();
  const version = privateCredentialVersion(identity.provider, identity.credential);
  const approved = privatePromptPolicy()?.destinations.some(destination => destination.endpoint === url.href
    && destination.provider === identity.provider && destination.credentialVersion === version
    && destination.models.includes(identity.model));
  if (!approved) throw new PrivatePromptError();
}

// Keep the check adjacent to the actual transport; a UI selection is not approval.
export async function privatePromptFetch(identity: PrivateSendIdentity, origins: PrivateOrigin[], init: RequestInit,
  transport: typeof fetch = fetch): Promise<Response> {
  assertPrivateSend(identity, origins);
  const response = await transport(identity.endpoint, { ...init, redirect: 'error' });
  if (response.redirected || response.status >= 300 && response.status < 400
    || response.url && new URL(response.url).href !== new URL(identity.endpoint).href) {
    const error = new PrivatePromptError();
    error.deliveryAttempted = true;
    throw error;
  }
  return response;
}
