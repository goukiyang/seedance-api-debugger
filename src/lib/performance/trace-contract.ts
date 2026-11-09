/** Edge-safe labels only. Dynamic route segments never become log values. */
export const TRACE_ID_HEADER = 'x-sd2-request-id';
export const TRACE_START_HEADER = 'x-sd2-request-start';
export const TRACE_OPERATIONS = ['admin.page', 'admin.usage-costs', 'admin.usage-record-page', 'admin.usage-analytics',
  'admin.usage-records', 'admin.usage-export', 'studio.settings', 'studio.modules', 'studio.presets', 'studio.shared', 'studio.gallery',
  'studio.cover-editor', 'studio.cover-media', 'studio.quote', 'feedback.read', 'feedback.submit', 'feedback.review', 'feedback.bridge-read', 'feedback.bridge-submit', 'feedback.admin-read', 'feedback.admin-update', 'feedback.admin-archive', 'feedback.ack', 'credits.summary', 'avatar.read', 'release.read', 'admin.cost-ledger-export'] as const;
export type TraceOperation = typeof TRACE_OPERATIONS[number];
export const TRACE_PHASES = ['auth', 'parse', 'data', 'serialize', 'snapshot', 'resolve', 'file', 'render',
  'settings', 'channels', 'model-readiness', 'pricing-readiness', 'billing-readiness', 'module-dto', 'gallery-cover', 'gallery-navigation',
  'file-stat', 'file-read', 'file-metadata', 'records', 'tasks', 'assets', 'credits-user', 'credits-summary',
  'dashboard', 'capture', 'fold', 'quote.prepare', 'quote.confirm', 'quote.store', 'quote.supplier-bills'] as const;
export type TracePhase = typeof TRACE_PHASES[number];

export function traceOperationForPath(pathname: string): TraceOperation | null {
  const path = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  switch (path) {
    case '/admin': return 'admin.page';
    case '/admin/usage-costs': return 'admin.usage-costs';
    case '/api/admin/usage-analytics': return 'admin.usage-analytics';
    case '/api/admin/usage-analytics/records': return 'admin.usage-records';
    case '/api/admin/usage-analytics/export': return 'admin.usage-export';
    case '/api/image-studio/quote': return 'studio.quote';
    case '/api/admin/feedback': return 'feedback.admin-read';
    case '/api/admin/feedback/archive': return 'feedback.admin-archive';
    case '/api/feishu/feedback-actions': return 'feedback.ack';
    case '/api/feedback': return 'feedback.submit';
    case '/api/bridge/feedback': return 'feedback.bridge-submit';
    case '/api/image-studio/settings': return 'studio.settings';
    case '/api/image-studio/modules': return 'studio.modules';
    case '/api/image-studio/presets': return 'studio.presets';
    case '/api/image-studio/shared': return 'studio.shared';
    case '/api/image-studio/gallery/query': return 'studio.gallery';
    case '/api/me/credits': return 'credits.summary';
    case '/api/avatar-studio': return 'avatar.read';
    case '/api/release': return 'release.read';
    case '/api/admin/costs/export': return 'admin.cost-ledger-export';
  }
  if (/^\/api\/admin\/feedback\/[^/]+$/.test(path)) return 'feedback.admin-update';
  if (/^\/api\/feedback\/[^/]+$/.test(path)) return 'feedback.review';
  if (/^\/admin\/usage-records\/[^/]+(?:\/[^/]+)*$/.test(path)) return 'admin.usage-record-page';
  if (/^\/api\/image-studio\/modules\/[^/]+\/cover$/.test(path)) return 'studio.cover-editor';
  if (/^\/api\/image-studio\/module-covers\/(module|preset)\/[^/]+$/.test(path)) return 'studio.cover-media';
  return null;
}
