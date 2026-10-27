import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { requireSecret } from '../security/secrets';

/** Only deliberately public business messages may use this class. */
export class PublicApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    if (!Number.isInteger(status) || status < 400 || status > 599) throw new RangeError('Invalid API error status');
    this.name = 'PublicApiError';
  }
}

function recordUnexpectedError(errorId: string, error: unknown) {
  try {
    // Exception text can contain SQL parameters, prompts or tokens. Never log it in plaintext.
    const diagnostic = error instanceof Error
      ? { name: error.name.slice(0, 128), message: error.message.slice(0, 32768), stack: error.stack?.slice(0, 32768) }
      : { name: 'NonError', message: typeof error === 'string' ? error.slice(0, 32768) : 'Non-error exception' };
    const iv = randomBytes(12);
    const key = createHash('sha256').update(requireSecret('errorLog')).digest();
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(errorId));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(diagnostic), 'utf8'), cipher.final()]);
    console.error('[api-error]', { errorId, format: 'api-error.v1', iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') });
  } catch {
    // A broken key or logger must not leak the original exception or change the HTTP result.
    try { console.error('[api-error]', { errorId, diagnosticUnavailable: true }); } catch { /* response remains safe */ }
  }
}

export function apiErrorResponse(error: unknown): Response {
  const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
  if (error instanceof PublicApiError) {
    return Response.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status, headers });
  }
  const errorId = randomUUID();
  recordUnexpectedError(errorId, error);
  return Response.json({ error: '服务暂时不可用', code: 'UNAVAILABLE', errorId }, { status: 503, headers });
}

export function withApiErrors<Args extends unknown[]>(handler: (...args: Args) => Response | Promise<Response>) {
  return async (...args: Args): Promise<Response> => {
    try { return await handler(...args); } catch (error) { return apiErrorResponse(error); }
  };
}
