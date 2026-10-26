export type UsageSourceKind = 'video_task' | 'image_task' | 'video_studio_run' | 'agent_text_step' | 'role_run' | 'role_attempt' | 'toolflow_run' | 'cutout_receipt';
export type UsageKind = 'video' | 'image' | 'text' | 'flow' | 'cutout';
export type UsageRange = 'month' | 'quarter' | 'half' | 'year' | 'recent6m' | 'all' | 'custom' | '7d' | '30d';
export type UsageAttributionBasis = 'frozen' | 'legacy_current' | 'legacy_snapshot' | 'unassigned' | 'conflict';
export type UsageCostStatus = 'confirmed' | 'pending' | 'conflict' | 'unconnected';

export interface UsageQuery {
  range: UsageRange;
  year: number;
  month: number;
  quarter: number;
  half: number;
  date_from: string | null;
  date_to: string | null;
  time_zone: string;
  grain: 'day' | 'week' | 'month';
  owner_user_id: string | null;
  project_id: string | null;
  kind: UsageKind | null;
  source_kind: UsageSourceKind | null;
  model: string | null;
  provider: string | null;
  status: string | null;
  cost_status: UsageCostStatus | null;
  attribution: UsageAttributionBasis | null;
  resolution: string | null;
  keyword: string | null;
  retention_status: string | null;
  result_ready: 'ready' | 'not_ready' | 'unknown' | null;
  page: number;
  page_size: 20 | 30 | 50 | 100;
  sort: 'newest' | 'oldest' | 'usage' | 'cost' | 'name';
  startUtc: string | null;
  endUtc: string | null;
  members_page?: number;
  projects_page?: number;
  records_page?: number;
  members_sort?: UsageQuery['sort'];
  projects_sort?: UsageQuery['sort'];
  members_search?: string | null;
  projects_search?: string | null;
}

export interface UsageMoney {
  currency: string;
  amountMicros: string;
}

export interface UsageFact {
  sourceKind: UsageSourceKind;
  sourceId: string;
  parentSourceKind: UsageSourceKind | null;
  parentSourceId: string | null;
  kind: UsageKind;
  leaf: boolean;
  occurredAt: string;
  updatedAt: string;
  ownerUserId: string | null;
  ownerLabel: string;
  actorUserId: string | null;
  billingSubject: string | null;
  projectId: string | null;
  projectLabel: string;
  currentOwnerUserId: string | null;
  currentProjectId: string | null;
  attribution: UsageAttributionBasis;
  attributionDetail: string;
  model: string | null;
  provider: string | null;
  resolution: string | null;
  status: string;
  retentionStatus: string | null;
  outputCount: number;
  resultReady: boolean | null;
  costStatus: UsageCostStatus;
  confirmedCost: UsageMoney[];
  confirmedCostCnyMicros: string | null;
  chargedPoints: string | null;
  reservedPoints: string | null;
  releasedPoints: string | null;
  refundedPoints: string | null;
  ledgerIds: string[];
  href: string | null;
}

export interface UsageSummary {
  usageCount: number;
  outputCount: number;
  flowCount: number;
  activeMemberCount: number;
  projectCount: number;
  confirmedCost: UsageMoney[];
  confirmedCostCnyMicros: string | null;
  chargedPoints: string | null;
  reservedPoints: string | null;
  releasedPoints: string | null;
  refundedPoints: string | null;
  pendingCount: number;
  conflictCount: number;
  unknownCostCount: number;
  unassignedCount: number;
  failedCount: number;
  resultNotReadyCount: number;
}

export interface UsageCoverage {
  source: string;
  label: string;
  status: 'complete' | 'partial' | 'unavailable';
  total: number;
  frozen: number;
  legacy: number;
  detail: string;
}

export interface UsageDistribution {
  id: string | null;
  label: string;
  summary: UsageSummary;
}

export interface UsagePage<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface UsageReport {
  query: UsageQuery;
  dataAsOf: string;
  reportFingerprint: string;
  summary: UsageSummary;
  coverage: UsageCoverage[];
  records: UsagePage<UsageFact>;
  members: UsagePage<UsageDistribution>;
  projects: UsagePage<UsageDistribution>;
  memberDirectory: UsagePage<UsageDistribution>;
  projectDirectory: UsagePage<UsageDistribution>;
  selectedMember: (UsageDistribution & { available: boolean }) | null;
  selectedProject: (UsageDistribution & { available: boolean }) | null;
  trend: Array<{ bucket: string; summary: UsageSummary }>;
  unlinkedCosts: { count: number; confirmedCost: UsageMoney[]; href: string };
  exchangeRate: { USD_CNY: string; source: string };
  exceptions: Array<{ key: string; label: string; count: number; href: string }>;
  options: {
    models: string[];
    providers: string[];
    statuses: string[];
  };
}
