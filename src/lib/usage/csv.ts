import { usageExchangeRate } from '@/lib/admin/usage-money';
import type { UsageExportSnapshot } from './dto';

export function usageCsvCell(value: unknown, numeric = false): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (!(numeric && /^-?\d+(?:\.\d+)?$/.test(text)) && /^[\s\u0000-\u001f]*[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function* usageCsvChunks(snapshot: UsageExportSnapshot): Generator<string> {
  const { report, records } = snapshot;
  const row = (values: unknown[]) => `${values.map(value => usageCsvCell(value)).join(',')}\r\n`;
  yield '\uFEFF';
  for (const [key, value] of Object.entries({ schema: report.schema, scope: report.scope, as_of: report.asOf, fingerprint: report.fingerprint,
    query: JSON.stringify(report.query), start_utc_inclusive: report.range.startUtc, end_utc_exclusive: report.range.endUtc,
    time_zone: report.range.timeZone, currency_display_policy: usageExchangeRate.source, usd_cny_display_rate: usageExchangeRate.USD_CNY,
    coverage: JSON.stringify(report.coverage), restricted: report.restricted })) yield row([key, value]);
  yield row(['record_id', 'source', 'type', 'occurred_at_utc', 'status', 'model', 'project', 'project_available',
    'task_count', 'request_count', 'successful_count', 'output_count', 'available_count', 'cash_state', 'cash_basis',
    'charge_original_micros', 'refund_original_micros', 'net_original_micros', 'charge_cny_micros', 'refund_cny_micros', 'net_cny_micros',
    'points_charged', 'points_refunded', 'points_net', 'points_reserved', 'points_released',
    'personal_points', 'project_points', 'unclassified_points', 'original_href']);
  for (let offset = 0; offset < records.length; offset += 500) {
    let chunk = '';
    for (const record of records.slice(offset, offset + 500)) {
      const values = [record.id, record.sourceKind, record.type, record.occurredAt, record.status, record.model, record.project.label, record.project.available,
        record.taskCount, record.requestCount, record.successfulCount, record.outputCount, record.availableCount, record.cash.state, record.cash.basis,
        JSON.stringify(record.cash.chargeOriginal), JSON.stringify(record.cash.refundOriginal), JSON.stringify(record.cash.netOriginal),
        record.cash.chargeCnyMicros, record.cash.refundCnyMicros, record.cash.netCnyMicros,
        record.points.charged, record.points.refunded, record.points.net, record.points.reserved, record.points.released,
        JSON.stringify(record.points.personal), JSON.stringify(record.points.project), JSON.stringify(record.points.unclassified), record.originalHref];
      chunk += `${values.map((value, index) => usageCsvCell(value, index >= 8 && index <= 12 || index >= 18 && index <= 25)).join(',')}\r\n`;
    }
    yield chunk;
  }
}
