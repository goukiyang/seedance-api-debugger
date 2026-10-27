// One SQLite statement owns the increment, expiration reset and returned count.
export const RATE_INCREMENT_SQL = `
INSERT INTO ApiRateLimit (key, count, expires_at_ms, updated_at_ms) VALUES (?, 1, ?, ?)
ON CONFLICT(key) DO UPDATE SET
  count = CASE WHEN expires_at_ms <= excluded.updated_at_ms THEN 1 ELSE MIN(count + 1, 1000000000) END,
  expires_at_ms = CASE WHEN expires_at_ms <= excluded.updated_at_ms THEN excluded.expires_at_ms ELSE expires_at_ms END,
  updated_at_ms = MAX(updated_at_ms, excluded.updated_at_ms)
RETURNING count, expires_at_ms, updated_at_ms`;
export const RATE_READ_SQL = 'SELECT count, expires_at_ms, updated_at_ms FROM ApiRateLimit WHERE key = ? AND expires_at_ms > ?';
