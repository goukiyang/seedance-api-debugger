import ipaddr from 'ipaddr.js';

const extraDenied = ['168.63.129.16/32', '192.0.0.0/24', '2001::/23', '3fff::/20'].map(value => ipaddr.parseCIDR(value));
const globalV6 = ipaddr.parseCIDR('2000::/3');

export function isPublicAddress(value: string): boolean {
  try {
    const address = ipaddr.process(value.replace(/^\[(.*)\]$/, '$1'));
    if (address.range() !== 'unicast') return false;
    if (extraDenied.some(([network, prefix]) => address.kind() === network.kind() && address.match(network, prefix))) return false;
    return address.kind() !== 'ipv6' || address.match(globalV6);
  } catch { return false; }
}

// A synchronous hint only. The transport resolves and validates ALL DNS answers again.
export function isDisallowedHost(value: string): boolean {
  const host = value.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  if (!host || host.includes('%') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  return ipaddr.isValid(host) ? !isPublicAddress(host) : host.includes(':');
}

export function publicHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || (url.port && !['80', '443'].includes(url.port)) || isDisallowedHost(url.hostname)) return null;
    return url;
  } catch { return null; }
}
