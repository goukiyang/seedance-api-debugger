import { isDisallowedHost, publicHttpUrl } from '@/lib/net/public-address';

export const isPrivateNetworkHost = isDisallowedHost;

export function isPublicHttpUrl(value: string | null | undefined) {
  return Boolean(value?.trim() && publicHttpUrl(value.trim()));
}
