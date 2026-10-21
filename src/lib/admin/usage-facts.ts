import 'server-only';

// The original administrator API keeps its DTO and caller authorization. Public
// reports inject source permission predicates into the same fact reader.
export { readUsageFacts } from '@/lib/usage/facts';
export type { UsageCashEvent, UsageFactSnapshot, UsageFactReadOptions } from '@/lib/usage/facts';
