import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const CANVAS_BATCH_SQL = 'prisma/migrations/20261021180000_canvas_video_batches/migration.sql';
export const CANVAS_BATCH_MIGRATOR = 'ops/sd2-canvas-video-batches-migrate.py';
export const CANVAS_BATCH_MODE = 'src/lib/canvas-video-batches-build-mode.ts';
export const CANVAS_BATCH_SCHEMA_FIELDS = ['schema', 'sqlSha256', 'migrationModuleSha256', 'previousPrismaSha256', 'newPrismaSha256'];
const hash = value => createHash('sha256').update(value).digest('hex');

export function assertCanvasBatchSchemaInput(value) {
  assert.deepEqual(Object.keys(value).sort(), [...CANVAS_BATCH_SCHEMA_FIELDS].sort());
  assert.equal(value.schema, 'sd2-canvas-video-batch-schema-input.v1');
  for (const key of CANVAS_BATCH_SCHEMA_FIELDS.filter(key => key.endsWith('Sha256'))) assert.match(value[key], /^[a-f0-9]{64}$/);
  assert.notEqual(value.previousPrismaSha256, value.newPrismaSha256);
  return value;
}

export function assertCanvasBatchPrismaExtension(previous, next, input) {
  assertCanvasBatchSchemaInput(input);
  assert.equal(hash(previous), input.previousPrismaSha256);
  assert.equal(hash(next), input.newPrismaSha256);
  // The complete reviewed blob is pinned above. This additionally proves that
  // every pre-existing declaration remains byte-for-byte unchanged.
  const oldText = previous.toString('utf8'), text = next.toString('utf8');
  const marker = '// Durable batch/fee identities survive canvas deletion and snapshot retention.\n';
  const start = text.indexOf(marker), end = text.indexOf('model CanvasDocumentRevision {', start);
  assert.ok(start >= 0 && end > start && text.indexOf(marker, start + 1) === -1);
  assert.equal(text.slice(0, start) + text.slice(end), oldText, 'Only the two reviewed batch models may be inserted');
  assert.deepEqual([...text.slice(start, end).matchAll(/^model (\w+) \{/gm)].map(match => match[1]),
    ['CanvasVideoBatch', 'CanvasVideoBatchChild']);
  assert.equal(/^\s*(?:datasource|generator|enum|type|view)\s/m.test(text.slice(start, end)), false);
  return { originalDeclarationsPreserved: true, addedModels: ['CanvasVideoBatch', 'CanvasVideoBatchChild'] };
}
