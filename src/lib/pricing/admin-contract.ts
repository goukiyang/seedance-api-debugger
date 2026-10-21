import type { PricingAuthoring, PricingAuthoringChange, PricingAuthoringEntry, PricingAuthoringRateMode, PricingEvidence } from './pricing-authoring-contract';
// Browser-safe boundary. Credentials and private configuration fingerprints never belong here.
export const PRICING_ADMIN_SCHEMA = 1 as const;
export const PRICING_POLICY_KEY = 'pricing_policy_v1';
export const PRICING_REVISION_PREFIX = 'pricing_policy_revision_v1:';
export const PRICING_OPERATION_PREFIX = 'pricing_policy_operation_v1:';
export const PRICING_UNCONFIGURED_REVISION = 'unconfigured';

export type PricingAdminKind = 'video' | 'image' | 'enhance' | 'h3';
export type PricingAdminBasis = 'site_base_cny' | 'supplier_cost_cny';
export type PricingAdminMode = 'legacy_fixed' | 'legacy_actual' | 'follow' | 'custom' | 'free' | 'unset';
export type PricingAdminUnit = 'image' | 'second';
export type PricingAdminActor = { id: string; displayName: string; avatarUrl: string | null };
export type PricingAdminIdentity = {
  kind: PricingAdminKind;
  channelId: string;
  modelId: string;
  billingMode: 'fixed' | 'actual';
  unit: PricingAdminUnit;
  specifications: Record<string, string>;
};

export type PricingAdminSourceInput = {
  type: 'admin_defined' | 'document' | 'supplier_statement' | 'existing_contract';
  reference: string;
  note: string;
};
export type PricingAdminSource = PricingAdminSourceInput & {
  confirmedAt: string;
  confirmedBy: PricingAdminActor;
};
export type PricingAdminBaseInput = {
  amount: string;
  currency: 'CNY';
  unit: PricingAdminUnit;
  source: PricingAdminSourceInput;
};
export type PricingAdminExchangeInput = {
  sourceCurrency: 'USD' | 'CNY';
  targetCurrency: 'CNY';
  direction: 'CNY_per_source_unit';
  rate: string;
  effectiveFrom: string;
  source: PricingAdminSourceInput;
};
export type PricingAdminExchange = PricingAdminExchangeInput & {
  revision: string;
  confirmedAt: string;
  confirmedBy: PricingAdminActor;
};

export type PricingAdminRow = {
  authoringRateMode?: PricingAuthoringRateMode;
  authoringEntry?: PricingAuthoringEntry | null;
  id: string;
  identity: PricingAdminIdentity;
  label: string;
  providerLabel: string;
  isDefault: boolean;
  appliesTo: string[];
  enabled: boolean;
  availability: 'ready' | 'disabled' | 'unconfigured' | 'needs_review';
  unavailableReason: string | null;
  basisKind: PricingAdminBasis;
  mode: PricingAdminMode;
  baseCny: string | null;
  source: PricingAdminSource | null;
  exchangeRate: PricingAdminExchange | null;
  currentPointsPerCny: string | null;
  currentUnitCredits: string | null;
  legacyRounding: 'ceil_task' | 'fixed_unit' | 'half_up_cent' | null;
  legacyPointsPerUsd: string | null;
  relativeMultiplier: string | null;
  differencePercent: string | null;
  hasDifference: boolean;
  confirmation: 'confirmed' | 'unconfirmed' | 'needs_review' | 'not_applicable';
  canAdopt: boolean;
  adoptionReason: string | null;
  updatedAt: string | null;
};

export const PRICING_ADMIN_LIMITS = {
  rateMin: '0.1', rateMax: '10000.0', rateScale: 1,
  baseMax: '1000000', baseScale: 8,
  exchangeMin: '0.00000001', exchangeMax: '10000', exchangeScale: 8,
  maxTaskCredits: '10000000', maxImageCredits: '100000',
  maxChanges: 2000, maxRequestBytes: 1048576, maxNumberLength: 32,
  previewTtlMs: 300000,
} as const;

export type PricingAdminSnapshot = {
  authoring?: PricingAuthoring;
  schemaVersion: typeof PRICING_ADMIN_SCHEMA;
  actor: PricingAdminActor;
  revision: string;
  catalogFingerprint: string;
  standards: Record<PricingAdminBasis, string | null>;
  rows: PricingAdminRow[];
  limits: typeof PRICING_ADMIN_LIMITS;
  runtime: { imageReady: boolean; reason: string | null };
  updatedAt: string | null;
  updatedBy: PricingAdminActor | null;
};

export type PricingAdminRowChange = {
  specifications?: Record<string, string>;
  authoringRateMode?: 'follow_global' | 'custom';
  baseRelation?: { parentId: string; factor: '1.5' } | null;
  evidence?: PricingEvidence;
  id: string;
  mode?: 'follow' | 'custom' | 'free' | 'legacy_fixed';
  customPointsPerCny?: string;
  basisKind?: PricingAdminBasis;
  base?: PricingAdminBaseInput;
  exchangeRate?: PricingAdminExchangeInput;
};
export type PricingAdminChanges = {
  authoring?: PricingAuthoringChange;
  standards?: Partial<Record<PricingAdminBasis, string>>;
  rows: PricingAdminRowChange[];
};
export type PricingAdminAction =
  | { kind: 'save'; changes: PricingAdminChanges }
  | { kind: 'unify'; basisKind: PricingAdminBasis; ruleIds: string[] }
  | { kind: 'restore'; revisionId: string; ruleIds: string[]; standards?: PricingAdminBasis[] };

export type PricingAdminSimulationInput = {
  rowId: string;
  quantity: string;
  exampleAmount?: string;
};
export type PricingAdminPreviewInput = {
  expectedAuthoringRevision?: string;
  expectedRevision: string;
  catalogFingerprint: string;
  action: PricingAdminAction;
  simulation?: PricingAdminSimulationInput;
  scenarios?: PricingAdminSimulationInput[];
};
export type PricingAdminPriceView = Pick<PricingAdminRow, 'mode' | 'baseCny' | 'basisKind'
  | 'currentPointsPerCny' | 'currentUnitCredits' | 'relativeMultiplier' | 'differencePercent'
  | 'confirmation' | 'hasDifference' | 'exchangeRate' | 'authoringRateMode' | 'authoringEntry'>;
export type PricingAdminSimulation = {
  sourceRowId: string;
  specifications: Record<string, string>;
  deltaCredits?: string | null;
  differencePercent?: string | null;
  rounding?: string;
  rowId: string;
  quantity: string;
  unit: PricingAdminUnit;
  currentCredits: string | null;
  adjustedCredits: string | null;
  authorizedMaximumCredits: string | null;
  isExample: boolean;
  roundedToZero: boolean;
  exactCredits: string | null;
  reason: string | null;
};
export type PricingAdminPreview = {
  authoringRevision?: string;
  authoringChanged?: boolean;
  scenarios?: PricingAdminSimulation[];
  previewToken: string;
  expiresAt: string;
  expectedRevision: string;
  catalogFingerprint: string;
  inputFingerprint: string;
  affectedRuleIds: string[];
  changes: Array<{ id: string; sourceRowId: string; specifications: Record<string, string>; label: string; before: PricingAdminPriceView; after: PricingAdminPriceView }>;
  skipped: Array<{ id: string; reason: string }>;
  simulation: PricingAdminSimulation | null;
};
export type PricingAdminSaveInput = PricingAdminPreviewInput & {
  operationId: string;
  previewToken: string;
};
export type PricingAdminOperation = {
  authoringRevision?: string;
  operationId: string;
  state: 'succeeded' | 'rejected' | 'unknown';
  inputFingerprint: string | null;
  revision: string | null;
  affectedRuleIds: string[];
  error: { code: string; message: string; fields?: Record<string, string> } | null;
  snapshot: PricingAdminSnapshot | null;
};
export type PricingAdminHistoryEntry = {
  authoringBefore?: PricingAuthoring;
  authoringAfter?: PricingAuthoring;
  revisionId: string;
  previousRevision: string;
  createdAt: string;
  actor: PricingAdminActor;
  action: PricingAdminAction['kind'];
  changes: PricingAdminPreview['changes'];
  standardsBefore: Record<PricingAdminBasis, string | null>;
  standardsAfter: Record<PricingAdminBasis, string | null>;
};
export type PricingAdminHistory = { entries: PricingAdminHistoryEntry[]; nextCursor: string | null };
export type PricingAdminFilter = {
  kind?: 'all' | PricingAdminKind;
  search?: string;
  channelId?: string;
  defaultsOnly?: boolean;
  difference?: 'all' | 'different' | 'unconfirmed' | 'custom';
  basisKind?: PricingAdminBasis;
};
export type PricingAdminError = { error: string; code: string; fields?: Record<string, string>; currentRevision?: string };
