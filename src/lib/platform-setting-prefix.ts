/** Canonical setting namespaces are ASCII and case sensitive, as in the existing GLOB queries. */
export function platformSettingPrefix(prefix: string) {
  if (!prefix || !/^[\x20-\x7e]+$/.test(prefix)) throw new Error('invalid_platform_setting_prefix');
  const end = prefix.length - 1;
  return { gte: prefix, lt: prefix.slice(0, end) + String.fromCharCode(prefix.charCodeAt(end) + 1) };
}
