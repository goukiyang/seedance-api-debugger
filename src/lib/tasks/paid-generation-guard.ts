import type { NextRequest } from 'next/server';
import type { GenerationRequestSource } from '@/lib/integrations/codex';

export const PAID_GENERATION_INTENT_HEADER = 'x-paid-generation-intent';
export const PAID_GENERATION_REASON_HEADER = 'x-paid-generation-reason';
export const PAID_GENERATION_INTENT_USER_AUTHORIZED = 'user_authorized_real_provider';

type PaidGenerationBody = Record<string, unknown>;

export type PaidGenerationGuardDecision = {
  allowed: boolean;
  requiresAuthorization: boolean;
  authorized: boolean;
  intent: string | null;
  reason: string | null;
  indicators: string[];
  metadata: Record<string, unknown>;
};

const SCRIPT_USER_AGENT_PATTERNS = [
  /\bundici\b/i,
  /\bnode\b/i,
  /\bnode-fetch\b/i,
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bpython\b/i,
  /\bhttpie\b/i,
  /\baxios\b/i,
  /\bokhttp\b/i,
  /\bgo-http-client\b/i,
  /\bjava\b/i,
];

const AGENT_TEXT_PATTERNS = [
  /\bcodex\b/i,
  /\bagent\b/i,
  /\bautomation\b/i,
  /\bscript\b/i,
  /\bsmoke\b/i,
  /\bclosure\b/i,
  /\bself[-_\s]?test\b/i,
  /自测/,
  /冒烟/,
];

function cleanHeader(value: string | null) {
  return value?.trim() || '';
}

function textField(body: PaidGenerationBody, key: string) {
  const value = body[key];
  return typeof value === 'string' ? value.trim() : '';
}

function hasAgentText(value: string) {
  return value ? AGENT_TEXT_PATTERNS.some((pattern) => pattern.test(value)) : false;
}

function scriptUserAgentIndicator(userAgent: string) {
  if (!userAgent.trim()) return 'missing_user_agent';
  return SCRIPT_USER_AGENT_PATTERNS.some((pattern) => pattern.test(userAgent))
    ? 'script_user_agent'
    : null;
}

function collectIndicators(
  request: NextRequest,
  body: PaidGenerationBody,
  requestSource: GenerationRequestSource,
) {
  const indicators: string[] = [];
  const userAgent = request.headers.get('user-agent') || '';
  const scriptUserAgent = scriptUserAgentIndicator(userAgent);
  const path = request.nextUrl.pathname;

  if (requestSource.source_type === 'codex_api') indicators.push('codex_api_source');
  if (path.startsWith('/api/codex/')) indicators.push('codex_api_path');
  if (scriptUserAgent) indicators.push(scriptUserAgent);
  if (request.headers.get('x-codex-request-id')) indicators.push('codex_request_header');

  const clientName = textField(body, 'client_name');
  if (hasAgentText(clientName)) indicators.push('agent_client_name');

  for (const key of ['source_request_id', 'codex_request_id', 'idempotency_key']) {
    if (hasAgentText(textField(body, key))) indicators.push(`agent_${key}`);
  }

  const prompt = textField(body, 'prompt');
  if (/\b(closure smoke|codex smoke|self[-_\s]?test|smoke prompt)\b/i.test(prompt)) {
    indicators.push('self_test_prompt');
  }

  return Array.from(new Set(indicators));
}

export function evaluatePaidGenerationGuard({
  request,
  body,
  requestSource,
}: {
  request: NextRequest;
  body: PaidGenerationBody;
  requestSource: GenerationRequestSource;
}): PaidGenerationGuardDecision {
  const intent = cleanHeader(request.headers.get(PAID_GENERATION_INTENT_HEADER));
  const reason = cleanHeader(request.headers.get(PAID_GENERATION_REASON_HEADER));
  const indicators = collectIndicators(request, body, requestSource);
  const requiresAuthorization = indicators.length > 0;
  const authorized = intent === PAID_GENERATION_INTENT_USER_AUTHORIZED && reason.length >= 8;

  return {
    allowed: !requiresAuthorization || authorized,
    requiresAuthorization,
    authorized,
    intent: intent || null,
    reason: reason || null,
    indicators,
    metadata: {
      requires_authorization: requiresAuthorization,
      authorized,
      intent: intent || null,
      reason: reason || null,
      indicators,
      policy: 'codex_or_script_paid_generation_requires_explicit_user_authorization',
    },
  };
}

export function paidGenerationGuardError(decision: PaidGenerationGuardDecision) {
  return {
    error: 'PAID_GENERATION_AUTH_REQUIRED',
    message: 'Codex、脚本或自测来源创建真实视频任务前，必须显式声明这是用户授权的真实扣费生成。',
    details: {
      indicators: decision.indicators,
      required_headers: {
        [PAID_GENERATION_INTENT_HEADER]: PAID_GENERATION_INTENT_USER_AUTHORIZED,
        [PAID_GENERATION_REASON_HEADER]: '说明当前用户明确要求真实生成的原因',
      },
    },
  };
}
