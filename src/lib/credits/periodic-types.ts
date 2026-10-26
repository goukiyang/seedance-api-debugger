export type QuotaConfig = {
  name: string;
  amount: number;
  account_type: 'internal' | 'external' | 'all';
  profiles: string[];
  user_ids: string[];
  exclude_ids: string[];
  unit: 'hour' | 'day' | 'week' | 'month';
  every: number;
  anchor: string;
  max_members: number;
};
export type QuotaRevision = { version: number; effective_at: string; config: QuotaConfig };
export type QuotaRule = {
  id: string;
  status: 'draft' | 'active' | 'paused' | 'archived';
  draft: QuotaConfig;
  revisions: QuotaRevision[];
};
export type QuotaCatalog = { version: number; rules: QuotaRule[] };
export type QuotaBinding = {
  rule_id: string;
  revision: number;
  config: QuotaConfig;
  start: string;
  end: string;
};
export type QuotaAssignment = { current?: QuotaBinding; pending?: QuotaBinding; managed_since: string; eligible_rule_id?: string };
export type QuotaPerson = {
  id: string; name: string; username: string; avatar_url: string | null;
  role: string; status: string; account_type: string; user_profile: string;
  expires_at: Date | null;
};

const HOUR = 3600000;
export function quotaBoundary(config: QuotaConfig, index: number): Date {
  const anchor = new Date(config.anchor);
  if (config.unit !== 'month') {
    const hours = config.unit === 'hour' ? 1 : config.unit === 'day' ? 24 : 168;
    return new Date(anchor.getTime() + index * config.every * hours * HOUR);
  }
  // Calendar periods use Shanghai time and the original day, including after February.
  const local = new Date(anchor.getTime() + 8 * HOUR);
  const month = local.getUTCMonth() + index * config.every;
  const lastDay = new Date(Date.UTC(local.getUTCFullYear(), month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(local.getUTCFullYear(), month, Math.min(local.getUTCDate(), lastDay),
    local.getUTCHours(), local.getUTCMinutes()) - 8 * HOUR);
}
export function quotaWindow(config: QuotaConfig, now: Date): { start: Date; end: Date } {
  let index = 0;
  if (now > new Date(config.anchor)) {
    if (config.unit === 'month') {
      const a = new Date(new Date(config.anchor).getTime() + 8 * HOUR);
      const n = new Date(now.getTime() + 8 * HOUR);
      index = Math.max(0, Math.floor(((n.getUTCFullYear() - a.getUTCFullYear()) * 12 + n.getUTCMonth() - a.getUTCMonth()) / config.every));
    } else {
      index = Math.max(0, Math.floor((now.getTime() - new Date(config.anchor).getTime()) /
        (config.every * (config.unit === 'hour' ? 1 : config.unit === 'day' ? 24 : 168) * HOUR)));
    }
    if (quotaBoundary(config, index) > now) index--;
  }
  return { start: quotaBoundary(config, Math.max(0, index)), end: quotaBoundary(config, Math.max(0, index) + 1) };
}
export function nextQuotaStart(config: QuotaConfig, now: Date): Date {
  const window = quotaWindow(config, now);
  return window.start >= now ? window.start : window.end;
}
export function quotaRevision(rule: QuotaRule, now: Date): QuotaRevision | undefined {
  return [...rule.revisions].reverse().find(item => new Date(item.effective_at) <= now) || rule.revisions[0];
}
export function quotaMatches(config: QuotaConfig, user: QuotaPerson, now: Date): boolean {
  return user.role !== 'admin' && user.status === 'active' && (!user.expires_at || user.expires_at > now)
    && (config.account_type === 'all' || user.account_type === config.account_type)
    && !config.exclude_ids.includes(user.id)
    && (config.profiles.includes(user.user_profile) || config.user_ids.includes(user.id));
}
