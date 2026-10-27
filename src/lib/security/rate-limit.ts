import { createHmac } from 'node:crypto';
import { requireSecret } from './secrets';

export type RateRecord = { count: number; expires_at_ms: number | bigint; updated_at_ms: number | bigint };
export type RateLimitStore = {
  increment(key: string, windowMs: number, now: number): Promise<RateRecord>;
  read(key: string, now: number): Promise<RateRecord | null>;
  delete(key: string): Promise<void>;
};
export type RateDecision = { allowed: boolean; retryAfterMs: number; delayMs: number };
const allowed = (delayMs = 0): RateDecision => ({ allowed: true, retryAfterMs: 0, delayMs });
const denied = (retryAfterMs: number): RateDecision => ({ allowed: false, retryAfterMs: Math.max(1, retryAfterMs), delayMs: 0 });

export class RateLimiter {
  private memory = new Map<string, { tokens: number; at: number; blockedUntil: number }>();
  constructor(private store: RateLimitStore, private clock = Date.now) {}

  private key(scope: string, values: string[]) {
    return createHmac('sha256', requireSecret('rateLimit')).update(JSON.stringify([scope, ...values])).digest('hex');
  }

  private async consume(scope: string, values: string[], limit: number, windowMs: number) {
    const key = this.key(scope, values), now = this.clock();
    let memory = this.memory.get(key);
    if (!memory) {
      if (this.memory.size >= 8192) this.memory.delete(this.memory.keys().next().value!);
      memory = { tokens: limit, at: now, blockedUntil: 0 };
      this.memory.set(key, memory);
    }
    if (memory.blockedUntil > now) return denied(memory.blockedUntil - now);
    memory.tokens = Math.min(limit, memory.tokens + Math.max(0, now - memory.at) * limit / windowMs);
    memory.at = Math.max(now, memory.at);
    if (memory.tokens < 1) return denied(Math.ceil((1 - memory.tokens) * windowMs / limit));
    memory.tokens -= 1;
    // Durable counts are authoritative across restarts/processes. Storage errors fail closed.
    const record = await this.store.increment(key, windowMs, now);
    if (record.count > limit) {
      memory.blockedUntil = Number(record.expires_at_ms);
      return denied(memory.blockedUntil - now);
    }
    return allowed();
  }

  auth(ip: string) { return this.consume('auth-ip', [ip], 20, 60000); }
  feedback(ip: string) { return this.consume('feedback-ip', [ip], 5, 3600000); }

  async registrationCode(email: string, ip: string) {
    const source = await this.consume('registration-ip', [ip], 10, 3600000);
    return source.allowed ? this.consume('registration-email', [email.trim().toLowerCase()], 3, 3600000) : source;
  }

  async beforeLogin(identifier: string, ip: string, sourceAlreadyCounted = false) {
    if (!sourceAlreadyCounted) {
      const source = await this.auth(ip);
      if (!source.allowed) return source;
    }
    const account = identifier.trim().toLowerCase(), now = this.clock();
    const pair = await this.store.read(this.key('login-failure-pair', [account, ip]), now);
    if (pair && pair.count >= 5) {
      const delay = Math.min(15 * 60000, 1000 * 2 ** Math.min(10, pair.count - 5));
      const retry = Number(pair.updated_at_ms) + delay - now;
      if (retry > 0) return denied(retry);
    }
    const allSources = await this.store.read(this.key('login-failure-account', [account]), now);
    return allowed(allSources ? Math.min(500, Math.max(0, allSources.count - 5) * 25) : 0);
  }

  async afterLogin(identifier: string, ip: string, result: { invalidCredentials: boolean; succeeded: boolean }) {
    const account = identifier.trim().toLowerCase();
    const pair = this.key('login-failure-pair', [account, ip]);
    if (result.invalidCredentials) {
      await this.store.increment(pair, 15 * 60000, this.clock());
      await this.store.increment(this.key('login-failure-account', [account]), 15 * 60000, this.clock());
    } else if (result.succeeded) await this.store.delete(pair);
  }
}
