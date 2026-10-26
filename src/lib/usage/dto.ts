export interface SelfUsageScope { kind: 'self'; viewerId: string }
export interface ProjectUsageScope { kind: 'project'; viewerId: string; projectId: string; memberOwnerId?: string }
export interface AdminUsageScope { kind: 'admin'; viewerId: string }
export type PublicUsageScope = SelfUsageScope | ProjectUsageScope;
export type UsageScope = PublicUsageScope | AdminUsageScope;
export type UsageType = 'video' | 'image' | 'other';

export interface UsagePublicQuery {
  month: string;
  time_zone: string;
  type: UsageType;
  project_id: string | null;
  member_owner_id: string | null;
  status: string | null;
  keyword: string | null;
  sort: 'newest' | 'oldest' | 'cost';
  page: number;
  limit: number;
}

export interface UsageCashDTO {
  chargeOriginal: Array<{ currency: string; amountMicros: string }>;
  refundOriginal: Array<{ currency: string; amountMicros: string }>;
  netOriginal: Array<{ currency: string; amountMicros: string }>;
  chargeCnyMicros: string | null;
  refundCnyMicros: string | null;
  netCnyMicros: string | null;
  basis: 'CNY' | 'USD_CNY_DISPLAY' | 'MIXED_CNY_USD' | 'UNAVAILABLE';
  state: 'confirmed' | 'partial' | 'pending' | 'conflict' | 'unavailable';
}

export interface UsagePointsPartDTO {
  charged: string | null;
  refunded: string | null;
  net: string | null;
  reserved: string | null;
  released: string | null;
}
export interface UsagePointsDTO extends UsagePointsPartDTO {
  personal: UsagePointsPartDTO;
  project: UsagePointsPartDTO;
  unclassified: UsagePointsPartDTO;
}

export interface UsageCategorySummary {
  taskCount: number | null;
  requestCount: number | null;
  successfulCount: number | null;
  outputCount: number | null;
  availableCount: number | null;
  cash: UsageCashDTO;
  points: UsagePointsDTO;
  pendingCount: number | null;
  conflictCount: number | null;
}

export interface UsageCoverageDTO {
  source: string;
  label: string;
  status: 'complete' | 'partial' | 'unsupported' | 'restricted';
  detail: string;
}

export interface UsageRecordDTO {
  id: string;
  sourceKind: string;
  type: UsageType;
  occurredAt: string;
  status: string;
  model: string | null;
  project: { id: string | null; label: string; available: boolean };
  taskCount: number | null;
  requestCount: number | null;
  successfulCount: number | null;
  outputCount: number | null;
  availableCount: number | null;
  cash: UsageCashDTO;
  points: UsagePointsDTO;
  originalHref: string | null;
  imageTaskId?: string;
  groupId?: string;
  media?: { thumbnailUrl?: string; imageUrl?: string; videoUrl?: string; downloadUrl?: string };
}

export interface UsageReportDTO {
  schema: 1;
  scope: 'self' | 'project';
  query: UsagePublicQuery;
  asOf: string;
  fingerprint: string;
  range: { startUtc: string; endUtc: string; timeZone: string };
  summary: { video: UsageCategorySummary; image: UsageCategorySummary; other: UsageCategorySummary };
  coverage: UsageCoverageDTO[];
  records: { items: UsageRecordDTO[]; total: number; page: number; pageSize: number; updated?: boolean };
  projects: Array<{ id: string | null; label: string }>;
  trend?: {
    range: { startUtc: string; endUtc: string; label: string };
    items: Array<{ month: string; video: UsageCategorySummary; image: UsageCategorySummary; other: UsageCategorySummary }>;
  };
  restricted: boolean;
}

export interface UsageExportSnapshot {
  report: UsageReportDTO;
  records: UsageRecordDTO[];
}
