const DEFAULT_TIMEOUT_MS = 15_000;
const MINOR_UNITS = 100;

type BalanceLeaf = {
  path: string;
  value: string | number;
};

export type ProviderBalanceSnapshotInput = {
  providerName: string;
  providerAccountId?: string | null;
  balanceKind: 'prepaid' | 'quota' | 'unknown';
  amountDecimal?: string | null;
  amountMinor?: number | null;
  currency?: string | null;
  quotaAmount?: number | null;
  quotaUnit?: string | null;
  rawSnapshot?: unknown;
  note?: string | null;
};

export type ProviderBalancePullResult = ProviderBalanceSnapshotInput & {
  endpoint: string;
  method: string;
};

function seedanceApiKey() {
  return process.env.SEEDANCE_API_KEY || '';
}

function configuredBalanceEndpoint() {
  const endpoint = process.env.SEEDANCE_BALANCE_ENDPOINT?.trim();
  return endpoint || null;
}

function configuredMethod() {
  const method = process.env.SEEDANCE_BALANCE_METHOD?.trim().toUpperCase();
  return method === 'GET' ? 'GET' : 'POST';
}

function configuredAuthStyle() {
  const style = process.env.SEEDANCE_BALANCE_AUTH_STYLE?.trim().toLowerCase();
  if (style === 'bearer' || style === 'x-api-key') return style;
  return 'body_api_key';
}

function configuredAccountId() {
  return process.env.SEEDANCE_ACCOUNT_ID?.trim() || process.env.SEEDANCE_BALANCE_ACCOUNT_ID?.trim() || null;
}

function normalizeCurrency(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ value: String(value) });
  }
}

function decimalString(value: string | number) {
  const normalized = String(value).trim().replace(/[,，]/g, '');
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const cleanFraction = fraction.replace(/0+$/, '');
  return cleanFraction ? `${whole}.${cleanFraction}` : whole;
}

export function decimalToMinor(value: string | number) {
  const normalized = decimalString(value);
  if (!normalized) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const cents = `${fraction}00`.slice(0, 2);
  let minor = Number(whole) * MINOR_UNITS + Number(cents);
  if (fraction.length > 2 && Number(fraction[2]) >= 5) minor += 1;
  if (!Number.isSafeInteger(minor) || minor < 0) return null;
  return minor;
}

function collectLeaves(value: unknown, path: string[] = [], leaves: BalanceLeaf[] = []) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    leaves.push({ path: path.join('.'), value });
    return leaves;
  }
  if (typeof value === 'string' && value.trim()) {
    leaves.push({ path: path.join('.'), value });
    return leaves;
  }
  if (!value || typeof value !== 'object') return leaves;
  if (Array.isArray(value)) {
    value.slice(0, 5).forEach((item, index) => collectLeaves(item, [...path, String(index)], leaves));
    return leaves;
  }
  Object.entries(value as Record<string, unknown>).forEach(([key, item]) => {
    collectLeaves(item, [...path, key], leaves);
  });
  return leaves;
}

function normalizedPath(path: string) {
  return path.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function scoreAmountLeaf(leaf: BalanceLeaf) {
  const path = normalizedPath(leaf.path);
  if (!decimalString(leaf.value)) return -1;
  if (/(time|date|timestamp|status|code|http|id|count|totalrequests|page|limit)/.test(path)) return -1;

  let score = 0;
  if (path.includes('availablebalance')) score += 80;
  if (path.includes('remainingbalance')) score += 78;
  if (path.includes('walletbalance')) score += 76;
  if (path.includes('prepaidbalance')) score += 74;
  if (path.endsWith('balance')) score += 70;
  if (path.includes('balance')) score += 58;
  if (path.includes('availableamount')) score += 56;
  if (path.includes('remainingamount')) score += 54;
  if (path.endsWith('amount')) score += 48;
  if (path.includes('amount')) score += 36;
  if (path.includes('credit')) score += 28;
  if (path.includes('quota')) score += 24;
  if (path.includes('money')) score += 20;
  return score;
}

function findAmountLeaf(payload: unknown) {
  return collectLeaves(payload)
    .map((leaf) => ({ leaf, score: scoreAmountLeaf(leaf) }))
    .filter((item) => item.score >= 20)
    .sort((a, b) => b.score - a.score)[0]?.leaf || null;
}

function findCurrency(payload: unknown) {
  const currencyLeaf = collectLeaves(payload)
    .find((leaf) => {
      const path = normalizedPath(leaf.path);
      return /(currency|currencycode|coin|unit)$/.test(path) && normalizeCurrency(leaf.value);
    });
  return normalizeCurrency(currencyLeaf?.value) || normalizeCurrency(process.env.SEEDANCE_BALANCE_CURRENCY);
}

function findQuotaUnit(payload: unknown) {
  const unitLeaf = collectLeaves(payload)
    .find((leaf) => /(quotaunit|creditunit|unit)$/.test(normalizedPath(leaf.path)) && typeof leaf.value === 'string');
  return typeof unitLeaf?.value === 'string' ? unitLeaf.value.trim() : null;
}

export function parseProviderBalancePayload(payload: unknown, providerName = 'seedance'): ProviderBalanceSnapshotInput {
  const amountLeaf = findAmountLeaf(payload);
  const amountDecimal = amountLeaf ? decimalString(amountLeaf.value) : null;
  const currency = findCurrency(payload);
  const quotaAmount = amountDecimal && !currency ? Number(amountDecimal) : null;

  return {
    providerName,
    providerAccountId: configuredAccountId(),
    balanceKind: currency ? 'prepaid' : (quotaAmount !== null ? 'quota' : 'unknown'),
    amountDecimal: currency ? amountDecimal : null,
    amountMinor: currency && amountDecimal ? decimalToMinor(amountDecimal) : null,
    currency,
    quotaAmount,
    quotaUnit: quotaAmount === null ? null : findQuotaUnit(payload) || 'quota',
    rawSnapshot: payload,
    note: amountLeaf ? `余额字段：${amountLeaf.path}` : '供应商响应中未识别到余额字段',
  };
}

async function parseResponse(response: Response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw_text: text.slice(0, 2000) };
  }
}

export async function pullSeedanceProviderBalance(): Promise<ProviderBalancePullResult> {
  const apiKey = seedanceApiKey();
  if (!apiKey) {
    throw new Error('请先配置 SEEDANCE_API_KEY，才能拉取供应商账户额度');
  }

  const endpoint = configuredBalanceEndpoint();
  if (!endpoint) {
    throw new Error('请配置 SEEDANCE_BALANCE_ENDPOINT，当前 Seedance 默认接口没有可用的账户余额路径');
  }

  const method = configuredMethod();
  const authStyle = configuredAuthStyle();
  const headers: Record<string, string> = { Accept: 'application/json' };
  const body: Record<string, string> = {};

  if (authStyle === 'bearer') {
    headers.Authorization = `Bearer ${apiKey}`;
  } else if (authStyle === 'x-api-key') {
    headers['X-Api-Key'] = apiKey;
  } else {
    headers['Content-Type'] = 'application/json';
    body.apiKey = apiKey;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    });
    const payload = await parseResponse(response);

    if (!response.ok) {
      throw new Error(`供应商余额接口返回 HTTP ${response.status}：${safeJson(payload).slice(0, 240)}`);
    }

    const parsed = parseProviderBalancePayload(payload);
    if (!parsed.amountDecimal && parsed.quotaAmount === null) {
      throw new Error('供应商余额接口已返回，但未识别到余额字段；请配置 SEEDANCE_BALANCE_CURRENCY 或检查响应字段');
    }

    return {
      ...parsed,
      endpoint,
      method,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function rawSnapshotJson(value: unknown) {
  return value === undefined ? null : safeJson(value);
}
