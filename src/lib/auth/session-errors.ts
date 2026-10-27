export class SessionUnavailableError extends Error {
  readonly status = 503;
  readonly code = 'AUTH_UNAVAILABLE';
  constructor() {
    super('服务暂时不可用');
    this.name = 'SessionUnavailableError';
  }
}

export function isSessionUnavailable(error: unknown): error is SessionUnavailableError {
  return error instanceof SessionUnavailableError;
}
