import 'server-only';
import type { UsageAnalyticsSnapshot } from './usage-analytics';
import type { UsageFact, UsageSummary } from './usage-types';
import { usageCnyDisplay } from './usage-money';

type CsvValue = string | number | boolean | null | undefined | { numeric: string };
type CsvRow = CsvValue[];
const numeric = (value: string | null | undefined): CsvValue => value === null || value === undefined ? null : { numeric: value };

export function usageCsvCell(value: CsvValue): string {
  let text: string;
  if (typeof value === 'object' && value !== null) {
    if (!/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value.numeric)) throw new Error('Invalid CSV numeric precision');
    text = value.numeric;
  } else {
    text = value === null || value === undefined ? '' : String(value);
    // Names, IDs, labels, query text and any other text are untrusted. Numeric
    // cells above preserve their exact decimal strings, including cash refunds.
    if (typeof value === 'string' && (/^[\s\uFEFF]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text))) text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

const summaryColumns = ['usage_count', 'output_count', 'flow_count', 'active_member_count', 'project_count', 'confirmed_cost_original_micros_json',
  'confirmed_cost_cny_micros', 'confirmed_cost_cny_display', 'charged_points', 'current_reserved_points', 'released_reserve_points', 'actual_refunded_points',
  'pending_cost_count', 'conflict_count', 'unknown_cost_count', 'unassigned_count', 'failed_count', 'result_not_ready_count'];

function summaryCells(value: UsageSummary): CsvValue[] {
  return [value.usageCount, value.outputCount, value.flowCount, value.activeMemberCount, value.projectCount,
    JSON.stringify(value.confirmedCost), numeric(value.confirmedCostCnyMicros), numeric(usageCnyDisplay(value.confirmedCostCnyMicros)), numeric(value.chargedPoints), numeric(value.reservedPoints),
    numeric(value.releasedPoints), numeric(value.refundedPoints), value.pendingCount, value.conflictCount, value.unknownCostCount,
    value.unassignedCount, value.failedCount, value.resultNotReadyCount];
}

function recordCells(fact: UsageFact): CsvValue[] {
  return [fact.sourceKind, fact.sourceId, fact.parentSourceKind, fact.parentSourceId, fact.kind, fact.leaf, fact.occurredAt, fact.updatedAt,
    fact.ownerUserId, fact.ownerLabel, fact.actorUserId, fact.billingSubject, fact.projectId, fact.projectLabel,
    fact.currentOwnerUserId, fact.currentProjectId, fact.attribution, fact.attributionDetail, fact.model, fact.provider,
    fact.resolution, fact.status, fact.retentionStatus, fact.outputCount, fact.resultReady, fact.costStatus,
    JSON.stringify(fact.confirmedCost), numeric(fact.confirmedCostCnyMicros), numeric(usageCnyDisplay(fact.confirmedCostCnyMicros)), numeric(fact.chargedPoints), numeric(fact.reservedPoints),
    numeric(fact.releasedPoints), numeric(fact.refundedPoints), JSON.stringify(fact.ledgerIds), fact.href];
}

function* csvRows(snapshot: UsageAnalyticsSnapshot, type: 'summary' | 'records'): Generator<CsvRow> {
  const { report } = snapshot;
  yield ['metadata', 'key', 'value'];
  yield ['metadata', 'schema', 'usage-csv.v1'];
  yield ['metadata', 'export_type', type];
  yield ['metadata', 'data_as_of_utc', report.dataAsOf];
  yield ['metadata', 'report_fingerprint', report.reportFingerprint];
  yield ['metadata', 'query', JSON.stringify(report.query)];
  yield ['metadata', 'statistics_time_zone', report.query.time_zone];
  yield ['metadata', 'cohort_start_utc_inclusive', report.query.startUtc];
  yield ['metadata', 'cohort_end_utc_exclusive', report.query.endUtc];
  yield ['metadata', 'recent6m_semantics', 'Local today minus six calendar months, day clamped to target month end; through today inclusive, ending at tomorrow local midnight. Explicit UTC bounds above are authoritative.'];
  yield ['metadata', 'result_ready_semantics', 'ready=true; not_ready=false; unknown=null. Unknown is never treated as not ready.'];
  yield ['metadata', 'USD_CNY_display_rate', numeric(report.exchangeRate.USD_CNY)];
  yield ['metadata', 'exchange_rate_source', report.exchangeRate.source];
  yield ['metadata', 'cash_precision', 'Integer micros; minor compatibility multiplied by 10000; original currencies never mixed. CNY conversion is display only.'];
  yield ['metadata', 'cash_semantics', 'Confirmed official cash events only; confirmed refunds/reversals negative. Unproven duplicate groups excluded, original rows retained. Partial known amounts do not mean unknown costs are zero.'];
  yield ['metadata', 'point_semantics', 'Original point debits, current reserve, reservation release and actual spend refunds are separate. Parent/child mirrors are not added. Empty is unknown, not zero.'];
  yield ['metadata', 'released_reserve_semantics', 'Reservation release ends frozen liability, including expiry closure; it is not a promise that expired points returned to usable balance, nor an actual spend refund.'];
  yield ['metadata', 'cohort_semantics', 'First source occurrence; later known bills linked to that same cohort as of this snapshot. Unlinked bills use their own bill occurrence time and remain separate.'];
  yield ['metadata', 'attribution_semantics', 'Member is source consumption owner; actor and payer separate. Legacy current ownership is not reconstructed history.'];
  yield ['metadata', 'trend_semantics', 'Sparse local calendar buckets; week starts Monday; no 180-day truncation.'];
  yield ['summary', 'key', 'label', ...summaryColumns];
  yield ['summary', 'all', '当前完整任务群', ...summaryCells(report.summary)];
  if (type === 'summary') {
    for (const member of snapshot.members) yield ['member', member.id || 'unassigned', member.label, ...summaryCells(member.summary)];
    for (const project of snapshot.projects) yield ['project', project.id || 'unassigned', project.label, ...summaryCells(project.summary)];
    for (const point of report.trend) yield ['trend', point.bucket, report.query.grain, ...summaryCells(point.summary)];
  } else {
    yield ['records', 'source_kind', 'source_id', 'parent_source_kind', 'parent_source_id', 'business_kind', 'leaf', 'occurred_at_utc', 'updated_at_utc',
      'consumption_owner_id', 'consumption_owner', 'actor_id', 'billing_subject', 'original_project_id', 'original_project',
      'current_owner_id', 'current_project_id', 'attribution_basis', 'attribution_detail', 'model', 'provider', 'resolution',
      'execution_status', 'retention_status', 'output_count', 'result_ready', 'cost_status', 'confirmed_cost_original_micros_json',
      'confirmed_cost_cny_micros', 'confirmed_cost_cny_display', 'charged_points', 'current_reserved_points', 'released_reserve_points', 'actual_refunded_points', 'ledger_ids_json', 'original_entry'];
    for (const fact of snapshot.records) yield ['record', ...recordCells(fact)];
  }
  yield ['coverage', 'source', 'label', 'status', 'matched_records', 'frozen', 'legacy', 'detail'];
  for (const value of report.coverage) yield ['coverage', value.source, value.label, value.status, value.total, value.frozen, value.legacy, value.detail];
  yield ['unlinked_costs_summary', 'count', 'confirmed_original_micros_json'];
  yield ['unlinked_costs_summary', report.unlinkedCosts.count, JSON.stringify(report.unlinkedCosts.confirmedCost)];
  // Both export types retain full original event evidence and unlinked rows,
  // including conflicts. No records page, TopN, or arbitrary row limit is used.
  yield ['cost_events', 'event_id', 'linked_source_key', 'event_type', 'bill_occurred_at_utc', 'currency', 'amount_micros',
    'proof_status', 'provider', 'proof_id', 'consumption_owner_id', 'original_project_id', 'cash_evidence', 'ledger_user_id', 'ledger_project_id', 'provider_reference', 'provider_scope_fingerprint', 'detail'];
  for (const event of snapshot.cashEvents) yield ['cost_event', event.id, event.sourceKey, event.eventType, event.occurredAt,
    event.currency, numeric(event.amountMicros), event.status, event.provider, event.proofId, event.ownerUserId, event.projectId,
    event.cashEvidence, event.ledgerUserId, event.ledgerProjectId, event.providerReference, event.providerScopeFingerprint, event.detail];
}

/** The transaction has materialized one immutable whitelist snapshot. Encoding
 * and delivery stream it in bounded chunks; no new DB reads occur during export.
 */
export function streamUsageCsv(snapshot: UsageAnalyticsSnapshot, type: 'summary' | 'records', signal?: AbortSignal): ReadableStream<Uint8Array> {
  const iterator = csvRows(snapshot, type);
  const encoder = new TextEncoder();
  let first = true, ended = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (ended) return;
      if (signal?.aborted) { ended = true; iterator.return(undefined); controller.error(new Error('Export interrupted')); return; }
      let chunk = first ? '\uFEFF' : '';
      first = false;
      try {
        while (chunk.length < 32000) {
          const row = iterator.next();
          if (row.done) { ended = true; break; }
          chunk += `${row.value.map(usageCsvCell).join(',')}\r\n`;
        }
        if (chunk) controller.enqueue(encoder.encode(chunk));
        if (ended) controller.close();
      } catch (error) { ended = true; controller.error(error); }
    },
    cancel() { ended = true; iterator.return(undefined); },
  });
}
