import { usageExchangeRate } from '@/lib/admin/usage-money';
import type { UsageExportSnapshot } from './dto';

export function usageCsvCell(value: unknown, numeric = false): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (!(numeric && /^-?\d+(?:\.\d+)?$/.test(text)) && /^[\s\u0000-\u001f]*[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export async function* usageCsvChunks(snapshot: UsageExportSnapshot): AsyncGenerator<string> {
  const { report, records } = snapshot;
  const row = (values: unknown[]) => `${values.map(value => usageCsvCell(value)).join(',')}\r\n`;
  yield '\uFEFF';
  for (const [key, value] of Object.entries({ schema: report.schema, scope: report.scope, as_of: report.asOf, fingerprint: report.fingerprint,
    query: JSON.stringify(report.query), start_utc_inclusive: report.range.startUtc, end_utc_exclusive: report.range.endUtc,
    time_zone: report.range.timeZone, currency_display_policy: usageExchangeRate.source, usd_cny_display_rate: usageExchangeRate.USD_CNY,
    coverage: JSON.stringify(report.coverage), restricted: report.restricted,
    accounting_semantics: 'Current-price revaluation: calculated/accounted totals include only included leaf quotes, never actual cash. Failed/cancelled/in-flight quotes are reference only. Legacy quotes without included use calculated status. Historical cash and point debits are unchanged.',
    quote_snapshot_semantics: 'Unit prices, quantities, equivalent points and pricing/mapping revisions are frozen in this snapshot; no rate reads during export.',
    reference_point_semantics: 'Equivalent points at current rates, not actual point debits; totals include only included quotes.' })) yield row([key, value]);
  yield row(['record_id', 'source', 'type', 'occurred_at_utc', 'status', 'model', 'project', 'project_available',
    'task_count', 'request_count', 'successful_count', 'output_count', 'available_count', 'cash_state', 'cash_basis',
    'charge_original_micros', 'refund_original_micros', 'net_original_micros', 'charge_cny_micros', 'refund_cny_micros', 'net_cny_micros',
    'points_charged', 'points_refunded', 'points_net', 'points_reserved', 'points_released',
    'personal_points', 'project_points', 'unclassified_points', 'original_href', 'calculated_cny_micros', 'accounted_cny_micros', 'calculated_count',
    'unit_cny', 'quote_unit', 'quote_quantity', 'current_cost_cny_micros', 'reference_points', 'points_per_cny', 'rate_revision', 'mapping_revision',
    'rule_id', 'quote_included', 'quote_estimated', 'quote_source', 'quote_basis']);
  const rows = Array.isArray(records) ? records : records.values();
  try {
    let chunk = '';
    for await (const record of rows) {
      const values = [record.id, record.sourceKind, record.type, record.occurredAt, record.status, record.model, record.project.label, record.project.available,
        record.taskCount, record.requestCount, record.successfulCount, record.outputCount, record.availableCount, record.cash.state, record.cash.basis,
        JSON.stringify(record.cash.chargeOriginal), JSON.stringify(record.cash.refundOriginal), JSON.stringify(record.cash.netOriginal),
        record.cash.chargeCnyMicros, record.cash.refundCnyMicros, record.cash.netCnyMicros,
        record.points.charged, record.points.refunded, record.points.net, record.points.reserved, record.points.released,
        JSON.stringify(record.points.personal), JSON.stringify(record.points.project), JSON.stringify(record.points.unclassified), record.originalHref,
        record.cash.calculatedCnyMicros, record.cash.accountedCnyMicros, record.cash.calculatedCount || 0,
        record.referenceQuote?.unitCny, record.referenceQuote?.unit, record.referenceQuote?.quantity,
        record.referenceQuote?.amountCnyMicros, record.referenceQuote?.points, record.referenceQuote?.pointsPerCny,
        record.referenceQuote?.revision, record.referenceQuote?.mappingRevision, record.referenceQuote?.ruleId,
        record.referenceQuote?.included, record.referenceQuote?.estimated, record.referenceQuote?.source, record.referenceQuote?.detail];
      chunk += `${values.map((value, index) => usageCsvCell(value, index >= 8 && index <= 12 || index >= 18 && index <= 25 || index >= 30 && index <= 33 || index >= 35 && index <= 38)).join(',')}\r\n`;
      if (chunk.length >= 16 * 1024) { yield chunk; chunk = ''; }
    }
    if (chunk) yield chunk;
  } finally { await snapshot.dispose?.(); }
}
