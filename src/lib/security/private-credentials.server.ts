import 'server-only';
import { privateOrigin, readPrivatePrompt, writePrivatePrompt } from './private-prompts.server';
import { privateFieldBinding } from './private-prompt-fields.server';

// Current settings and immutable configurations retain distinct authenticated identities.
export function readPrivateCredential(value: string | null, storageId: string, field: string) {
  if (value === null) return null;
  const origin = privateOrigin('provider-credential', storageId);
  return readPrivatePrompt(value, privateFieldBinding(value, 'provider-credential', storageId, field, origin ? [origin] : []));
}
export function writePrivateCredential(value: string | null, storageId: string, field: string) {
  if (value === null) return null;
  const origin = privateOrigin('provider-credential', storageId);
  return writePrivatePrompt(value, origin ? { kind: 'provider-credential', id: storageId, field, origins: [origin] } : null);
}

// This codec is used only by the named provider configuration stores, not arbitrary JSON.
export function transformPrivateCredentials<T>(key: string, value: T, write: boolean): T {
  const visit = (node: unknown, path: string[], credentialMap = false): unknown => {
    if (Array.isArray(node)) return node.map((item, index) => visit(item, [...path, String(index)]));
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(Object.entries(node).map(([field, child]) => {
      const location = [...path, field];
      if (typeof child === 'string' && child && (credentialMap || ['api_key', 'apiKey', 'inherited_api_key'].includes(field))) {
        const operation = write ? writePrivateCredential : readPrivateCredential;
        return [field, operation(child, key, location.join('/'))];
      }
      return [field, visit(child, location, field === 'modelApiKeys')];
    }));
  };
  return visit(value, []) as T;
}

export function parsePrivateCredentials(key: string, text: string) {
  return transformPrivateCredentials(key, JSON.parse(text), false);
}
export function stringifyPrivateCredentials(key: string, value: unknown) {
  return JSON.stringify(transformPrivateCredentials(key, value, true));
}
