const MAX_PROVIDER_ERROR_MESSAGE_LENGTH = 4000;

function stringFromScalar(value: unknown) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return '';
}

function truncateMessage(message: string) {
  if (message.length <= MAX_PROVIDER_ERROR_MESSAGE_LENGTH) return message;
  return `${message.slice(0, MAX_PROVIDER_ERROR_MESSAGE_LENGTH)}...`;
}

export function normalizeProviderErrorMessage(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;

  const scalar = stringFromScalar(value);
  if (scalar) return truncateMessage(scalar);

  if (value instanceof Error) {
    const errorText = value.message || value.name;
    return errorText ? truncateMessage(errorText) : undefined;
  }

  if (Array.isArray(value)) {
    const combined = value
      .map((item) => normalizeProviderErrorMessage(item))
      .filter((item): item is string => Boolean(item))
      .join('；');
    return combined ? truncateMessage(combined) : undefined;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const code = stringFromScalar(record.code ?? record.error_code ?? record.errorCode ?? record.name ?? record.type);
    const message = stringFromScalar(
      record.message ??
      record.error_message ??
      record.errorMessage ??
      record.msg ??
      record.detail ??
      record.reason,
    );

    if (code && message) return truncateMessage(`[${code}] ${message}`);
    if (message) return truncateMessage(message);
    if (code) return truncateMessage(code);

    try {
      const json = JSON.stringify(value);
      return json ? truncateMessage(json) : undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}
