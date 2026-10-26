export function isPrivateNetworkHost(hostname: string) {
  const host = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  const isIpv6Literal = host.includes(':');
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '0.0.0.0'
    || host === '::1'
    || host === '0:0:0:0:0:0:0:1'
    || host.startsWith('127.')
    || host.startsWith('10.')
    || host.startsWith('169.254.')
    || host.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    || (isIpv6Literal && host.startsWith('fe80:'))
    || (isIpv6Literal && host.startsWith('fc'))
    || (isIpv6Literal && host.startsWith('fd'))
    || host.endsWith('.local');
}

export function isPublicHttpUrl(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && Boolean(url.hostname)
      && !isPrivateNetworkHost(url.hostname);
  } catch {
    return false;
  }
}
