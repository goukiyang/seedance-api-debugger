export function usageRecordHref(kind: string, id: string) {
  return `/admin/usage-records/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
}

export function usageCashLedgerHref(id: string) {
  return /^(user-points:|project-points:|role-bill:)/.test(id) ? null : `/admin/costs?keyword=${encodeURIComponent(id)}`;
}
