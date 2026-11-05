import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Prisma } from '@prisma/client';
import { withUsageReadSnapshot } from '../src/lib/usage/sqlite-read-snapshot';
import { usageReaderDatabase } from '../src/lib/usage/database';
import { readUsageFacts } from '../src/lib/usage/facts';
import { UsageSummaryFold } from '../src/lib/usage/summary-fold';
import { PublicUsageSummaryFold } from '../src/lib/usage/public-summary-fold';
import { publicUsageCash, publicUsagePoints, publicUsageProject } from '../src/lib/usage/aggregate';
import { summarizeUsageFacts } from '../src/lib/admin/usage-analytics';
import type { UsageRecordDTO } from '../src/lib/usage/dto';
import { attachAccountingCosts, calculateRateCost } from '../src/lib/usage/accounting';

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), 'usage-rate-accounting-'));
  const previous = process.env.DATABASE_URL, originalFetch = globalThis.fetch;
  const filename = path.join(directory, 'fixture.db'), time = Date.parse('2026-11-05T10:00:00Z');
  process.env.DATABASE_URL = `file:${filename}`;
  globalThis.fetch = async () => { throw new Error('offline engineering fixture: network forbidden'); };
  try {
    const identity = (kind: 'image' | 'video', modelId: string, channelId: string, specifications = {}) => ({ kind, modelId, channelId, specifications, billingMode: 'fixed', unit: kind === 'image' ? 'image' : 'second' });
    const rules = [
      { id: 'image', identity: identity('image', 'gemini-3-pro-image-preview', 'channel'), mode: 'custom', baseCny: '0.07', source: { confirmedAt: '2026-11-05T00:00:00Z' } },
      { id: 'video', identity: identity('video', 'dreamina-seedance-2-0-260128', 'seedance', { resolution: '720p', referenceVideo: 'none', pricingPurpose: 'standard' }), mode: 'custom', baseCny: '1.12345678', source: { confirmedAt: '2026-11-05T00:00:00Z' } },
      ...[['medium', 'gpt-image-2.5-sunburst', 'medium-channel', '0.05'], ['max', 'gpt-image-2.5-sunburst', 'max-channel', '0.1'], ['banana', 'gemini-nano-banana-2.1', 'banana-channel', '0.06']].map(([id, model, channel, baseCny]) => ({
        id, identity: identity('image', model, channel), mode: 'custom', baseCny, source: { confirmedAt: '2026-11-05T00:00:00Z' },
      })),
    ];
    const frozen = { pricing: { baseCny: '0.05', mode: 'custom', revision: 'frozen-old', identity: { billingMode: 'fixed' } } };
    const image = (id: string, extra = {}) => ({ id, owner_id: 'owner', model: 'gemini-3-pro-image-preview', quality: 'auto', output_size: '2K', status: 'succeeded', asset_id: `asset-${id}`,
      billing_status: 'fixed_settled', snapshot_json: JSON.stringify({ imageChannel: { channelId: 'channel' } }), actual_credits: 7, unit_credits: 7, billing_settled_at: time, created_at: time, updated_at: time, ...extra });
    const video = (id: string, extra = {}) => ({ id, provider: 'seedance', model: 'dreamina-seedance-2-0-260128', user_id: 'owner', owner_user_id: 'owner', project_id: 'project', local_status: 'succeeded', is_draft: 0,
      duration: 5, resolution: '720p', created_at: time, updated_at: time, actual_cost: 99, frozen_cost: 0, refund_amount: 0, public_video_url: '/synthetic-not-read', ...extra });
    const seed = {
      User: [{ id: 'owner', name: 'Fixture' }], Project: [{ id: 'project', name: 'Fixture Project' }],
      PlatformSetting: [{ id: 'policy', key: 'pricing_policy_v1', value_json: JSON.stringify({ schemaVersion: 1, revision: 'current', rules }) },
        { id: 'defaults', key: 'image_generation_model_defaults_v1', value_json: JSON.stringify({ qualityRoutes: { 'gpt-image-2.5-sunburst': { medium: 'medium-channel', max: 'max-channel' } } }) }],
      ImageStudioTask: [image('image-current'), image('image-frozen', { billing_contract_json: JSON.stringify(frozen) }),
        image('image-failed', { status: 'failed', asset_id: null }), image('image-unknown', { status: 'uncertain', asset_id: null }),
        image('image-unpriced', { model: 'unpriced' }), image('image-other-channel', { snapshot_json: JSON.stringify({ imageChannel: { channelId: 'unpriced-channel' } }) }),
        image('image-medium', { model: 'gpt-image-2.5-sunburst', quality: 'medium', snapshot_json: '{}' }),
        image('image-max', { model: 'gpt-image-2.5-sunburst', quality: 'max', snapshot_json: '{}' }),
        image('image-banana', { model: 'gemini-nano-banana-2.1', snapshot_json: JSON.stringify({ imageChannel: { channelId: 'banana-channel' } }) })],
      VideoTask: [video('video-asset', { provider_cost_currency: 'USD', provider_final_amount_micros: 2000000 }),
        video('video-rate'), video('video-token', { provider: 'volcengine_ark', model: 'doubao-seedance-2-0-260128', provider_usage_snapshot: '{"completion_tokens":500}' }),
        video('video-bill', { provider_task_id: 'provider-bill', provider_cost_currency: 'USD', provider_final_amount_micros: 200000, provider_cost_status: 'official_confirmed',
          provider_usage_snapshot: '{"completion_tokens":100}', provider_cost_snapshot: '{"source":"provider_get_result"}', provider_cost_confirmed_at: time }),
        video('video-upgrade', { source_draft_task_id: 'draft' }), video('video-failed', { local_status: 'failed' })],
      CostLedger: [{ id: 'cash', source_type: 'task', source_id: 'video-bill', task_id: 'video-bill', user_id: 'owner', project_id: 'project', provider_name: 'seedance', provider_task_id: 'provider-bill',
        event_type: 'official_charge', amount_micros: 200000, currency: 'USD', cost_source: 'provider_usage', confidence: 'confirmed', official_charge_id: 'provider-bill', occurred_at: time, created_at: time }],
    };
    const quote = (name: string) => `"${name}"`;
    const ddl = Prisma.dmmf.datamodel.models.map(model => `CREATE TABLE ${quote(model.dbName || model.name)} (${model.fields.filter(field => field.kind !== 'object')
      .map(field => `${quote(field.dbName || field.name)} ${field.type === 'DateTime' ? 'DATETIME' : field.type === 'Boolean' ? 'BOOLEAN' : ['Int', 'BigInt'].includes(field.type) ? 'INTEGER' : ['Float', 'Decimal'].includes(field.type) ? 'DOUBLE' : 'TEXT'}${field.isId ? ' PRIMARY KEY' : ''}`).join(',')});`).join('\n');
    const setup = spawnSync('python3', ['-c', `import json,sqlite3,sys
p=json.load(sys.stdin)
c=sqlite3.connect(p['file'])
c.executescript(p['ddl'])
for table,rows in p['seed'].items():
 for row in rows:
  names=list(row)
  c.execute('INSERT INTO "'+table+'" ('+','.join('"'+n+'"' for n in names)+') VALUES ('+','.join('?' for n in names)+')',[row[n] for n in names])
c.commit()
c.close()
`],
      { input: JSON.stringify({ file: filename, ddl, seed }), encoding: 'utf8' });
    assert.ifError(setup.error); assert.equal(setup.status, 0, setup.stderr);
    const result = await withUsageReadSnapshot(async reader => {
      const db = usageReaderDatabase(reader);
      const snapshot = await readUsageFacts(db, '2026-11-05T12:00:00Z');
      const byId = new Map(snapshot.facts.map(fact => [fact.sourceId, fact]));
      const cost = (id: string) => byId.get(id)!.accountingCost;
      assert.equal(cost('image-current')?.amountCnyMicros, '70000');
      assert.equal(cost('image-medium')?.amountCnyMicros, '50000');
      assert.equal(cost('image-max')?.amountCnyMicros, '100000');
      assert.equal(cost('image-banana')?.amountCnyMicros, '60000');
      assert.equal(cost('image-frozen')?.amountCnyMicros, '50000');
      assert.equal(cost('image-frozen')?.revision, 'frozen-old');
      assert.equal(cost('video-asset')?.amountCnyMicros, '14000000');
      assert.equal(cost('video-token')?.amountCnyMicros, '7000000');
      assert.equal(cost('video-rate')?.amountCnyMicros, '5617284');
      assert.equal(byId.get('video-bill')?.confirmedCostCnyMicros, '1400000');
      for (const id of ['video-bill', 'video-upgrade', 'video-failed', 'image-failed', 'image-unknown', 'image-unpriced', 'image-other-channel']) assert.equal(cost(id), undefined, id);
      const conflicted = { ...byId.get('image-current')!, costStatus: 'conflict' as const, accountingCost: undefined };
      await attachAccountingCosts(db, [{ fact: conflicted, raw: {} }]); assert.equal(conflicted.accountingCost, undefined);
      const ambiguous = { revision: 'conflict', qualityRoutes: {}, rules: [rules[0], { ...rules[0], id: 'duplicate', baseCny: '0.09' }] };
      assert.equal(calculateRateCost(byId.get('image-current')!, { channel_id: 'channel' }, ambiguous as Parameters<typeof calculateRateCost>[2]), null);
      const expected = summarizeUsageFacts(snapshot.facts), fold = new UsageSummaryFold();
      for (const fact of snapshot.facts) fold.add(fact);
      assert.deepEqual(fold.value(), expected);
      assert.equal(expected.calculatedCount, 8); assert.equal(expected.calculatedCostCnyMicros, '26947284');
      assert.equal(expected.accountedCostCnyMicros, '28347284');
      const cash = publicUsageCash(snapshot.facts, snapshot.cashEvents), publicFold = new PublicUsageSummaryFold();
      for (const fact of snapshot.facts) {
        const record: UsageRecordDTO = { id: `${fact.sourceKind}:${fact.sourceId}`, sourceKind: fact.sourceKind, type: fact.kind === 'video' ? 'video' : 'image', occurredAt: fact.occurredAt, status: fact.status, model: fact.model,
          project: publicUsageProject(fact, snapshot.projectDirectory), taskCount: 1, requestCount: 1, successfulCount: fact.status === 'succeeded' ? 1 : 0,
          outputCount: fact.outputCount, availableCount: null, cash: publicUsageCash([fact], snapshot.cashEvents), points: publicUsagePoints([fact]), originalHref: null };
        publicFold.add(fact, record, snapshot.cashEvents);
      }
      assert.deepEqual(publicFold.value().cash, cash); assert.equal(cash.accountedCnyMicros, expected.accountedCostCnyMicros);
      assert.equal(cash.netCnyMicros, '1400000');
      const raw = await db.$queryRaw<Array<{ count: number }>>`SELECT count(*) AS count FROM CostLedger`;
      assert.equal(Number(raw[0].count), 1);
      assert.ok(snapshot.sourceFingerprintParts.some(part => part.includes('frozen-old')));
      return { checks: 20, calculatedCount: expected.calculatedCount, accountedCnyMicros: expected.accountedCostCnyMicros, actualCnyMicros: cash.netCnyMicros };
    }, { dataAsOf: '2026-11-05T12:00:00Z' });
    process.stdout.write(`${JSON.stringify({ ok: true, offlineFixture: true, ...result })}\n`);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
    globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
