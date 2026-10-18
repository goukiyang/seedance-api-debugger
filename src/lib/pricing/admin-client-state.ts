import type {
  PricingAdminAction, PricingAdminBasis, PricingAdminChanges, PricingAdminFilter,
  PricingAdminPreviewInput, PricingAdminRow, PricingAdminRowChange, PricingAdminSaveInput,
} from './admin-contract';

export type PricingAdminDraft = { revision: string; changes: PricingAdminChanges };
export type PricingAdminView = {
  filter: PricingAdminFilter; page: number; pageSize: number; expanded: string[];
  sort: 'catalog' | 'name' | 'difference'; basis: PricingAdminBasis;
  referenceId: string; simulationRowId: string; quantity: string; exampleAmount: string;
  anchorId: string; anchorOffset: number;
};
export type PricingAdminPending = { actorId: string; submittedAt: string; inputFingerprint: string; payload: PricingAdminSaveInput; submittedDraft: PricingAdminChanges };
export const defaultPricingAdminView: PricingAdminView = {
  filter: { kind: 'all', difference: 'all' }, page: 1, pageSize: 24, expanded: [],
  sort: 'catalog', basis: 'site_base_cny', referenceId: '', simulationRowId: '',
  quantity: '1', exampleAmount: '', anchorId: '', anchorOffset: 0,
};

export function pricingAdminStorageKey(actorId: string, kind: 'workspace' | 'operation') {
  return `sd2:admin-pricing:v1:${encodeURIComponent(actorId)}:${kind}`;
}

export function filterPricingAdminRows(rows: PricingAdminRow[], filter: PricingAdminFilter, sort: PricingAdminView['sort'] = 'catalog') {
  const search = (filter.search || '').trim().toLocaleLowerCase();
  const result = rows.filter(row => (
    (!filter.kind || filter.kind === 'all' || row.identity.kind === filter.kind)
    && (!filter.channelId || row.identity.channelId === filter.channelId)
    && (!filter.defaultsOnly || row.isDefault)
    && (!filter.basisKind || row.basisKind === filter.basisKind)
    && (filter.difference !== 'different' || row.hasDifference)
    && (filter.difference !== 'unconfirmed' || row.confirmation === 'unconfirmed' || row.confirmation === 'needs_review')
    && (filter.difference !== 'custom' || row.mode === 'custom')
    && (!search || [row.label, row.providerLabel, row.identity.modelId, ...Object.values(row.identity.specifications), ...row.appliesTo].join(' ').toLocaleLowerCase().includes(search))
  ));
  if (sort === 'name') result.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN') || a.id.localeCompare(b.id));
  if (sort === 'difference') result.sort((a, b) => Number(b.hasDifference) - Number(a.hasDifference) || a.label.localeCompare(b.label, 'zh-CN'));
  return result;
}

export function patchPricingAdminRow(changes: PricingAdminChanges, id: string, patch: Omit<PricingAdminRowChange, 'id'>): PricingAdminChanges {
  const existing = changes.rows.find(row => row.id === id);
  const next = { ...existing, id, ...patch };
  if (patch.mode && patch.mode !== 'custom') delete next.customPointsPerCny;
  return { ...changes, rows: [...changes.rows.filter(row => row.id !== id), next] };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// A late receipt may only consume fields that still equal the submitted draft.
export function consumePricingAdminDraft(current: PricingAdminChanges, submitted: PricingAdminChanges): PricingAdminChanges {
  const standards = { ...current.standards };
  for (const basis of Object.keys(submitted.standards || {}) as PricingAdminBasis[]) {
    if (same(standards[basis], submitted.standards?.[basis])) delete standards[basis];
  }
  const rows = current.rows.flatMap(row => {
    const saved = submitted.rows.find(item => item.id === row.id);
    if (!saved) return [row];
    const next = { ...row };
    for (const field of Object.keys(saved) as (keyof PricingAdminRowChange)[]) {
      if (field !== 'id' && same(row[field], saved[field])) delete next[field];
    }
    if (next.customPointsPerCny !== undefined && row.mode === 'custom') next.mode = 'custom';
    return Object.keys(next).length > 1 ? [next] : [];
  });
  return { ...(Object.keys(standards).length ? { standards } : {}), rows };
}

export function submittedPricingAdminDraft(changes: PricingAdminChanges, action: PricingAdminAction): PricingAdminChanges {
  if (action.kind === 'save') return JSON.parse(JSON.stringify(action.changes)) as PricingAdminChanges;
  // Unify replaces modes/rates, not a selected row's unrelated source draft.
  if (action.kind === 'unify') return { rows: changes.rows.filter(row => action.ruleIds.includes(row.id)).map(row => ({ id: row.id,
    ...(row.mode !== undefined ? { mode: row.mode } : {}), ...(row.customPointsPerCny !== undefined ? { customPointsPerCny: row.customPointsPerCny } : {}) })) };
  // Historical values are server-owned candidates; leave all local drafts intact.
  return { rows: [] };
}

export function pricingAdminPreviewKey(input: PricingAdminPreviewInput) { return JSON.stringify(input); }

export function validPricingAdminRate(value: string) {
  return value.length <= 32 && /^(?:0|[1-9]\d*)(?:\.\d)?$/.test(value) && Number(value) >= 0.1 && Number(value) <= 10000;
}

export function parsePricingAdminWorkspace(raw: string | null, actorId: string): { draft: PricingAdminDraft; view: PricingAdminView } | null {
  if (!raw || raw.length > 2_097_152) return null;
  try {
    const value = JSON.parse(raw);
    if (value.schema !== 1 || value.actorId !== actorId || typeof value.draft?.revision !== 'string'
      || !Array.isArray(value.draft?.changes?.rows) || value.draft.changes.rows.length > 2000) return null;
    const changes: PricingAdminChanges = { rows: [] };
    const text = (v: unknown, max = 2048) => typeof v === 'string' && v.length <= max;
    const source = (v: any) => v && ['admin_defined', 'document', 'supplier_statement', 'existing_contract'].includes(v.type)
      && text(v.reference) && text(v.note, 4000);
    for (const row of value.draft.changes.rows) {
      if (!row || !text(row.id, 500)) return null;
      const clean: PricingAdminRowChange = { id: row.id };
      if (row.mode !== undefined) {
        if (!['follow', 'custom', 'free', 'legacy_fixed'].includes(row.mode)) return null;
        clean.mode = row.mode;
      }
      if (row.customPointsPerCny !== undefined) { if (!text(row.customPointsPerCny, 32)) return null; clean.customPointsPerCny = row.customPointsPerCny; }
      if (row.basisKind !== undefined) { if (!['site_base_cny', 'supplier_cost_cny'].includes(row.basisKind)) return null; clean.basisKind = row.basisKind; }
      if (row.base !== undefined) {
        if (!text(row.base.amount, 32) || row.base.currency !== 'CNY' || !['image', 'second'].includes(row.base.unit) || !source(row.base.source)) return null;
        clean.base = { amount: row.base.amount, currency: 'CNY', unit: row.base.unit, source: { type: row.base.source.type, reference: row.base.source.reference, note: row.base.source.note } };
      }
      if (row.exchangeRate !== undefined) {
        const exchange = row.exchangeRate;
        if (!['USD', 'CNY'].includes(exchange.sourceCurrency) || exchange.targetCurrency !== 'CNY'
          || exchange.direction !== 'CNY_per_source_unit' || !text(exchange.rate, 32) || !text(exchange.effectiveFrom, 100) || !source(exchange.source)) return null;
        clean.exchangeRate = { sourceCurrency: exchange.sourceCurrency, targetCurrency: 'CNY', direction: 'CNY_per_source_unit', rate: exchange.rate,
          effectiveFrom: exchange.effectiveFrom, source: { type: exchange.source.type, reference: exchange.source.reference, note: exchange.source.note } };
      }
      changes.rows.push(clean);
    }
    for (const basis of ['site_base_cny', 'supplier_cost_cny'] as const) {
      const rate = value.draft.changes.standards?.[basis];
      if (rate !== undefined) { if (!text(rate, 32)) return null; changes.standards = { ...changes.standards, [basis]: rate }; }
    }
    const stored = value.view || {}, filter = stored.filter || {};
    const view: PricingAdminView = { ...defaultPricingAdminView, filter: {} };
    if (['all', 'video', 'image', 'enhance', 'h3'].includes(filter.kind)) view.filter.kind = filter.kind;
    if (text(filter.search, 200)) view.filter.search = filter.search;
    if (text(filter.channelId, 500)) view.filter.channelId = filter.channelId;
    if (typeof filter.defaultsOnly === 'boolean') view.filter.defaultsOnly = filter.defaultsOnly;
    if (['all', 'different', 'unconfirmed', 'custom'].includes(filter.difference)) view.filter.difference = filter.difference;
    if (['site_base_cny', 'supplier_cost_cny'].includes(filter.basisKind)) view.filter.basisKind = filter.basisKind;
    if (['site_base_cny', 'supplier_cost_cny'].includes(stored.basis)) view.basis = stored.basis;
    if (['catalog', 'name', 'difference'].includes(stored.sort)) view.sort = stored.sort;
    if ([12, 24, 48].includes(stored.pageSize)) view.pageSize = stored.pageSize;
    if (Number.isSafeInteger(stored.page) && stored.page > 0 && stored.page <= 100000) view.page = stored.page;
    view.expanded = Array.isArray(stored.expanded) ? stored.expanded.filter((id: unknown) => text(id, 500)).slice(0, 2000) : [];
    for (const field of ['referenceId', 'simulationRowId', 'anchorId', 'quantity', 'exampleAmount'] as const) {
      if (text(stored[field], field === 'quantity' || field === 'exampleAmount' ? 32 : 500)) view[field] = stored[field];
    }
    if (Number.isFinite(stored.anchorOffset) && Math.abs(stored.anchorOffset) <= 10000) view.anchorOffset = stored.anchorOffset;
    return { draft: { revision: value.draft.revision, changes }, view };
  } catch { return null; }
}

export function parsePricingAdminPending(raw: string | null, actorId: string): PricingAdminPending | null {
  if (!raw || raw.length > 2_097_152) return null;
  try {
    const value = JSON.parse(raw);
    const payload = value.payload;
    if (value.actorId !== actorId || typeof value.submittedAt !== 'string' || typeof value.inputFingerprint !== 'string' || !payload
      || typeof payload.operationId !== 'string' || payload.operationId.length > 200
      || typeof payload.expectedRevision !== 'string' || typeof payload.catalogFingerprint !== 'string'
      || typeof payload.previewToken !== 'string' || !['save', 'unify', 'restore'].includes(payload.action?.kind)
      || !Array.isArray(value.submittedDraft?.rows)) return null;
    return value as PricingAdminPending;
  } catch { return null; }
}
