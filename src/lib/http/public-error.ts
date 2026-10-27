// Safe for shared browser contracts; diagnostics and server dependencies stay in api-error.
export class PublicApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    if (!Number.isInteger(status) || status < 400 || status > 599) throw new RangeError('Invalid API error status');
    this.name = 'PublicApiError';
  }
}
