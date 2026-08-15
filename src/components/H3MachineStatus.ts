import type { ComposerProviderStatus, ComposerProviderStatusTone, ComposerSelectOption } from '@/components/ComposerActionBar';

const H3_HEALTH_MAX_AGE_MS = 15 * 60 * 1000;

type H3HealthBilling = {
  charged?: boolean | null;
  cost?: number | null;
  currency?: string | null;
  cost_model?: string | null;
} | null;

type H3HealthQueue = {
  paused?: boolean | null;
  pending?: number | null;
  running?: number | null;
  max_pending_jobs?: number | null;
  active?: number | null;
  max_active_jobs?: number | null;
} | null;

export type H3VideoConfig = {
  enabled: boolean;
  ready: boolean;
  configured?: boolean;
  default_preset_id: string;
  preset_options: ComposerSelectOption[];
  api_token_configured?: boolean;
  admin_queue_ready?: boolean;
  health?: {
    api?: string | null;
    version?: string | null;
    worker?: string | null;
    comfyui?: string | null;
    preset_count?: number | null;
    billing?: H3HealthBilling;
    queue?: H3HealthQueue;
    checked_at?: string | null;
  } | null;
};

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeBilling(value: unknown): H3HealthBilling {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return {
    charged: typeof raw.charged === 'boolean' ? raw.charged : null,
    cost: numberOrNull(raw.cost),
    currency: typeof raw.currency === 'string' ? raw.currency : null,
    cost_model: typeof raw.cost_model === 'string' ? raw.cost_model : null,
  };
}

function normalizeQueue(value: unknown): H3HealthQueue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return {
    paused: typeof raw.paused === 'boolean' ? raw.paused : null,
    pending: numberOrNull(raw.pending),
    running: numberOrNull(raw.running),
    max_pending_jobs: numberOrNull(raw.max_pending_jobs),
    active: numberOrNull(raw.active),
    max_active_jobs: numberOrNull(raw.max_active_jobs),
  };
}

function normalizeHealth(value: unknown): H3VideoConfig['health'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return {
    api: typeof raw.api === 'string' ? raw.api : null,
    version: typeof raw.version === 'string' ? raw.version : null,
    worker: typeof raw.worker === 'string' ? raw.worker : null,
    comfyui: typeof raw.comfyui === 'string' ? raw.comfyui : null,
    preset_count: numberOrNull(raw.preset_count),
    billing: normalizeBilling(raw.billing),
    queue: normalizeQueue(raw.queue),
    checked_at: typeof raw.checked_at === 'string' ? raw.checked_at : null,
  };
}

export function normalizeH3VideoConfig(value: unknown): H3VideoConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Partial<H3VideoConfig>;
  const options = Array.isArray(raw.preset_options)
    ? raw.preset_options
        .filter((option): option is ComposerSelectOption => (
          Boolean(option)
          && typeof option === 'object'
          && typeof (option as ComposerSelectOption).id === 'string'
          && typeof (option as ComposerSelectOption).label === 'string'
        ))
        .map((option) => ({
          id: option.id,
          label: option.label,
          detail: typeof option.detail === 'string' ? option.detail : '',
        }))
    : [];

  return {
    enabled: raw.enabled === true,
    ready: raw.ready === true,
    configured: raw.configured === true,
    api_token_configured: raw.api_token_configured === true,
    admin_queue_ready: raw.admin_queue_ready === true,
    default_preset_id: typeof raw.default_preset_id === 'string' ? raw.default_preset_id : '',
    preset_options: options,
    health: normalizeHealth(raw.health),
  };
}

export function h3DisabledReason(config: H3VideoConfig | null) {
  if (!config?.enabled) return 'H3 未启用';
  if (!config.configured || !config.api_token_configured) return 'H3 缺少用户 token 或预设';
  if (!config.health) return 'H3 还没有通过测试连接';
  if (isHealthSnapshotStale(config.health.checked_at)) return 'H3 健康检查已过期';
  return 'H3 健康检查未通过';
}

function isHealthy(config: H3VideoConfig | null) {
  return config?.ready === true
    && config.health?.api === 'ok'
    && config.health.worker === 'ok'
    && config.health.comfyui === 'ok';
}

function hasHealthySnapshot(config: H3VideoConfig | null) {
  return config?.health?.api === 'ok'
    && config.health.worker === 'ok'
    && config.health.comfyui === 'ok';
}

function isHealthSnapshotStale(value: string | null | undefined) {
  if (!value) return true;
  const time = new Date(value).getTime();
  return !Number.isFinite(time) || Date.now() - time > H3_HEALTH_MAX_AGE_MS;
}

function isFreeBilling(billing: H3HealthBilling) {
  return billing?.charged === false
    && (billing.cost ?? 0) === 0
    && billing.cost_model === 'free_local';
}

function formatCheckedAt(value: string | null | undefined) {
  if (!value) return '暂无最近检查时间';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return '最近检查时间不可读';
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (minutes < 1) return '刚刚检查';
  if (minutes < 60) return `${minutes} 分钟前检查`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前检查`;
  return `${Math.floor(hours / 24)} 天前检查`;
}

function dot(label: string, tone: ComposerProviderStatusTone, title: string) {
  return { label, tone, title };
}

function buildBaseTitle(parts: string[]) {
  return parts.filter(Boolean).join('；');
}

export function buildH3MachineStatus({
  config,
  selectedProvider,
  isAdmin = false,
}: {
  config: H3VideoConfig | null;
  selectedProvider?: string | null;
  isAdmin?: boolean;
}): ComposerProviderStatus | null {
  const shouldShow = selectedProvider === 'h3' || (isAdmin && config?.ready !== true);
  if (!shouldShow) return null;

  const adminHref = isAdmin ? '/admin/integrations' : undefined;
  if (!config) {
    return {
      label: isAdmin ? 'H3 未配置' : 'H3 暂不可用',
      tone: 'muted',
      title: isAdmin ? '没有读取到 H3 配置。管理员可到 API 设置补齐地址和 token。' : 'H3 暂不可用，请改用 Seedance。',
      href: adminHref,
      hrefLabel: 'API 设置',
      dots: [
        dot('API', 'muted', 'H3 配置未读取'),
        dot('队列', 'muted', '暂无队列状态'),
        dot('计费', 'muted', '暂无计费状态'),
      ],
    };
  }

  if (!config.enabled) {
    return {
      label: isAdmin ? 'H3 未启用' : 'H3 暂不可用',
      tone: 'muted',
      title: isAdmin ? 'H3 本地工作站已关闭。管理员可在 API 设置中启用。' : 'H3 暂不可用，请改用 Seedance。',
      href: adminHref,
      hrefLabel: 'API 设置',
      dots: [
        dot('API', 'muted', 'H3 未启用'),
        dot('队列', 'muted', '未启用时不读取队列'),
        dot('计费', 'muted', '未启用时不读取计费'),
      ],
    };
  }

  if (!config.configured || !config.api_token_configured) {
    return {
      label: isAdmin ? 'H3 未配置' : 'H3 暂不可用',
      tone: 'error',
      title: isAdmin ? 'H3 缺少用户 token 或有效预设，暂时不能提交生成。' : 'H3 暂不可用，请改用 Seedance。',
      href: adminHref,
      hrefLabel: 'API 设置',
      dots: [
        dot('API', 'error', '缺少生成 token 或预设'),
        dot('队列', 'muted', '配置未完成，队列不可用'),
        dot('计费', 'muted', '配置未完成，计费状态未知'),
      ],
    };
  }

  const health = config.health;
  if (!health) {
    return {
      label: 'H3 待检查',
      tone: 'warning',
      title: 'H3 已配置，但还没有通过测试连接。提交前需要管理员先检查机器状态。',
      href: adminHref,
      hrefLabel: 'API 设置',
      dots: [
        dot('API', 'warning', '还没有健康检查快照'),
        dot('队列', 'muted', '还没有队列状态'),
        dot('计费', 'muted', '还没有计费状态'),
      ],
    };
  }

  if (hasHealthySnapshot(config) && isHealthSnapshotStale(health.checked_at)) {
    return {
      label: 'H3 待检查',
      tone: 'warning',
      title: 'H3 上次健康检查已过期。管理员需要重新测试连接后再开放使用。',
      href: adminHref,
      hrefLabel: 'API 设置',
      dots: [
        dot('API', 'warning', '健康快照已过期'),
        dot('队列', 'muted', '快照过期，队列状态需要复查'),
        dot('计费', 'muted', '快照过期，计费状态需要复查'),
      ],
    };
  }

  if (!isHealthy(config)) {
    const title = buildBaseTitle([
      `API: ${health.api || '未知'}`,
      `Worker: ${health.worker || '未知'}`,
      `ComfyUI: ${health.comfyui || '未知'}`,
      formatCheckedAt(health.checked_at),
    ]);
    return {
      label: 'H3 暂不可用',
      tone: 'error',
      title,
      href: adminHref,
      hrefLabel: 'API 设置',
      dots: [
        dot('API', health.api === 'ok' ? 'ready' : 'error', `API: ${health.api || '未知'}`),
        dot('队列', 'muted', '机器未健康时不建议提交队列'),
        dot('计费', 'muted', '机器未健康时不判断计费'),
      ],
    };
  }

  const queue = health.queue;
  const pending = queue?.pending ?? 0;
  const running = queue?.running ?? 0;
  const totalQueue = pending + running;
  const maxPending = queue?.max_pending_jobs ?? null;
  const queueFull = typeof maxPending === 'number' && maxPending > 0 && pending >= maxPending;
  const queueNearFull = typeof maxPending === 'number' && maxPending > 0 && pending >= Math.max(1, Math.floor(maxPending * 0.8));
  const queuePaused = queue?.paused === true;
  const billingFree = isFreeBilling(health.billing ?? null);
  const billingKnown = Boolean(health.billing);

  let tone: ComposerProviderStatusTone = 'ready';
  let label = billingFree ? 'H3 可用 · 免费 · 队列空闲' : 'H3 可用 · 计费未知';
  if (queuePaused) {
    tone = 'warning';
    label = 'H3 队列暂停';
  } else if (queueFull) {
    tone = 'warning';
    label = 'H3 队列已满';
  } else if (queueNearFull || totalQueue > 0) {
    tone = 'busy';
    label = `H3 可用 · 队列中 ${totalQueue} 个任务`;
  } else if (!billingFree) {
    tone = 'warning';
  }

  const queueTitle = queue
    ? `队列: 待处理 ${pending}，运行中 ${running}${maxPending ? `，上限 ${maxPending}` : ''}`
    : '队列状态未知';
  const billingTitle = billingFree
    ? '计费: 本地免费，不扣点'
    : billingKnown ? '计费: 状态不是免费本地模型，请管理员确认' : '计费: 未知';

  return {
    label,
    tone,
    title: buildBaseTitle([
      `API: ${health.api}`,
      `Worker: ${health.worker}`,
      `ComfyUI: ${health.comfyui}`,
      queueTitle,
      billingTitle,
      formatCheckedAt(health.checked_at),
    ]),
    href: adminHref && tone !== 'ready' ? adminHref : undefined,
    hrefLabel: 'API 设置',
    dots: [
      dot('API', 'ready', 'API、Worker、ComfyUI 正常'),
      dot('队列', queuePaused || queueFull || queueNearFull ? 'warning' : totalQueue > 0 ? 'busy' : 'ready', queueTitle),
      dot('计费', billingFree ? 'ready' : 'warning', billingTitle),
    ],
  };
}
