import { setFixtureDatabase } from './fixtures/database-client';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type ProviderStatusFetcher = import('../src/lib/provider/video-task-status').ProviderStatusFetcher;
type ProviderStatusFetchers = import('../src/lib/provider/video-task-status').ProviderStatusFetchers;

const secret = 'PRIVATE_RECIPE_QUERY_SECRET_7f31';
const secretTaskIds = [
  `success-${secret}`,
  `failed-${secret}`,
  `unknown-${secret}`,
  `exception-${secret}`,
];
const logs: string[] = [];
let syntheticFetchCalls = 0;

function printable(value: unknown) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}:${value.message}`;
  try { return JSON.stringify(value); } catch { return '[unprintable]'; }
}

const output: Pick<Console, 'log' | 'warn' | 'error'> = {
  log: (...values: unknown[]) => { logs.push(values.map(printable).join(' ')); },
  warn: (...values: unknown[]) => { logs.push(values.map(printable).join(' ')); },
  error: (...values: unknown[]) => { logs.push(values.map(printable).join(' ')); },
};

function syntheticResponse(body: Record<string, unknown>, status = 200): typeof fetch {
  return async () => {
    syntheticFetchCalls += 1;
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: multiview-private-query-engineering.ts <receipt-file>');
  const project = realpathSync(process.cwd());
  const scratch = path.join(project, '.role-tests');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  chmodSync(scratch, 0o700);
  const receipt = path.resolve(process.argv[2]);
  const receiptRelative = path.relative(scratch, receipt);
  if (!receiptRelative || receiptRelative.startsWith(`..${path.sep}`) || receiptRelative === '..'
    || path.isAbsolute(receiptRelative)) {
    throw new Error('Query engineering receipt must be inside the existing isolated test directory');
  }
  const receiptParent = path.dirname(receipt);
  if (!existsSync(receiptParent) || !lstatSync(receiptParent).isDirectory()) {
    throw new Error('Query engineering receipt parent must already be an isolated directory');
  }
  const scratchReal = realpathSync(scratch);
  const receiptParentReal = realpathSync(receiptParent);
  if ((!receiptParentReal.startsWith(scratchReal + path.sep) && receiptParentReal !== scratchReal)
    || !lstatSync(receiptParent).isDirectory()) {
    throw new Error('Query engineering receipt must be inside the existing isolated test directory');
  }
  const syntheticDatabase = path.join(scratchReal, 'unused-synthetic.db');
  assert.equal(existsSync(syntheticDatabase), false, 'Synthetic query database must start unopened');
  const guardedEnvironment = ['DATABASE_URL', 'NODE_ENV'] as const;
  const previousEnvironment: Record<typeof guardedEnvironment[number], { present: boolean; value: string | undefined }> = {
    DATABASE_URL: {
      present: Object.prototype.hasOwnProperty.call(process.env, 'DATABASE_URL'),
      value: process.env.DATABASE_URL,
    },
    NODE_ENV: {
      present: Object.prototype.hasOwnProperty.call(process.env, 'NODE_ENV'),
      value: process.env.NODE_ENV,
    },
  };
  const runtime = globalThis as typeof globalThis & {
    prisma?: { $disconnect(): Promise<void> };
    prismaSqlitePragmasStarted?: boolean;
  };
  const hadPrisma = Object.prototype.hasOwnProperty.call(runtime, 'prisma');
  const previousPrisma = runtime.prisma;
  const hadPrismaSqlitePragmasStarted = Object.prototype.hasOwnProperty.call(runtime, 'prismaSqlitePragmasStarted');
  const previousPrismaSqlitePragmasStarted = runtime.prismaSqlitePragmasStarted;
  const hadGlobalFetch = Object.prototype.hasOwnProperty.call(globalThis, 'fetch');
  const originalFetch = globalThis.fetch;

  try {
    Object.assign(process.env, {
      DATABASE_URL: `file:${syntheticDatabase}`,
      NODE_ENV: 'test',
    });
    runtime.prismaSqlitePragmasStarted = true;
    globalThis.fetch = async () => {
      throw new Error('External network calls are prohibited in this synthetic query fixture');
    };
    const { getVideoTaskStatus } = await import('../src/lib/provider/jimeng');
    const { getProviderTaskStatus } = await import('../src/lib/provider/video-task-status');

    const successBody = {
    id: `vendor-${secretTaskIds[0]}`,
    status: 'succeeded',
    content: {
      video_url: `https://private.invalid/${secret}/result.mp4?signature=${secret}`,
      last_frame_url: `https://private.invalid/${secret}/last.png?signature=${secret}`,
    },
    model: 'synthetic-model',
    vendor_prompt: secret,
    vendor_unknown: { nested: secret },
    actual_cost: 12.75,
    currency_or_credit_type: 'CNY',
    billing_status: 'confirmed',
    billing_time: 1700000000,
  };
  const succeeded = await getVideoTaskStatus(secretTaskIds[0], {
    sensitiveRecipe: true,
    fetch: syntheticResponse(successBody),
    console: output,
  });
  assert.equal(succeeded.local_status, 'succeeded');
  assert.equal(succeeded.provider_task_id, successBody.id);
  assert.equal(succeeded.result_video_url, successBody.content.video_url);
  assert.equal(succeeded.result_last_frame_url, successBody.content.last_frame_url);
  assert.equal(succeeded.actual_cost, 12.75);
  assert.equal(succeeded.currency_or_credit_type, 'CNY');
  assert.equal(succeeded.billing_status, 'confirmed');
  assert.equal(succeeded.billing_time, 1700000000);
  assert.deepEqual(succeeded.raw, successBody);

  const failedBody = {
    id: `vendor-${secretTaskIds[1]}`,
    status: 'failed',
    error: `vendor rejected original prompt: ${secret}`,
    actualCost: 3.5,
    currency: 'CNY',
    billingStatus: 'confirmed',
    billingTime: 1700000001,
    unknown_failure_detail: secret,
  };
  const failed = await getVideoTaskStatus(secretTaskIds[1], {
    sensitiveRecipe: true,
    fetch: syntheticResponse(failedBody),
    console: output,
  });
  assert.equal(failed.local_status, 'failed');
  assert.equal(failed.provider_status, 'failed');
  assert.equal(failed.actual_cost, 3.5);
  assert.equal(failed.currency_or_credit_type, 'CNY');
  assert.equal(failed.billing_status, 'confirmed');
  assert.equal(failed.billing_time, 1700000001);
  assert.deepEqual(failed.raw, failedBody);

  const unknownStatus = `future_${secret}`;
  const unknownBody = {
    id: `vendor-${secretTaskIds[2]}`,
    status: unknownStatus,
    message: `unknown state includes original prompt ${secret}`,
    actual_cost: 7.25,
    currency_or_credit_type: 'CNY',
    billing_status: 'pending',
    billing_time: 1700000002,
    raw_extension: secret,
  };
  const unknown = await getVideoTaskStatus(secretTaskIds[2], {
    sensitiveRecipe: true,
    fetch: syntheticResponse(unknownBody),
    console: output,
  });
  assert.equal(unknown.local_status, 'running');
  assert.equal(unknown.provider_status, unknownStatus);
  assert.equal(unknown.actual_cost, 7.25);
  assert.equal(unknown.currency_or_credit_type, 'CNY');
  assert.equal(unknown.billing_status, 'pending');
  assert.equal(unknown.billing_time, 1700000002);
  assert.deepEqual(unknown.raw, unknownBody);

  const throwingFetch: typeof fetch = async () => {
    syntheticFetchCalls += 1;
    throw new Error(`transport copied vendor prompt ${secret}`);
  };
  await assert.rejects(
    () => getVideoTaskStatus(secretTaskIds[3], { sensitiveRecipe: true, fetch: throwingFetch, console: output }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.equal(typeof (error as Error & { code?: string }).code, 'string');
      return true;
    },
  );

  const routedContexts: Array<boolean | undefined> = [];
  const routedSeedance: ProviderStatusFetchers['seedance'] = async (providerTaskId, context) => {
    routedContexts.push(context?.sensitiveRecipe);
    return { provider_task_id: providerTaskId, provider_status: 'running', local_status: 'running', raw: {} };
  };
  const forbiddenOtherProvider: ProviderStatusFetcher = async () => {
    throw new Error('Unexpected non-Seedance fetcher call');
  };
  const routerFetchers: ProviderStatusFetchers = {
    seedance: routedSeedance,
    volcengineIp: forbiddenOtherProvider,
    aiMediaKitEnhanceVideo: forbiddenOtherProvider,
    h3: forbiddenOtherProvider,
  };
  await getProviderTaskStatus({
    provider: 'seedance',
    provider_task_id: 'router-private',
    source_metadata_json: JSON.stringify({
      protected_module: { kind: 'multiview', schema: 1, recipeVersion: '1.0.1' },
    }),
  }, { fetchers: routerFetchers });
  await getProviderTaskStatus(
    { provider: 'seedance', provider_task_id: 'router-ordinary', source_metadata_json: null },
    { fetchers: routerFetchers });
  await getProviderTaskStatus(
    { provider: 'seedance', provider_task_id: 'router-partial-cache' },
    { fetchers: routerFetchers });
  assert.deepEqual(routedContexts, [true, false, true]);

  assert.equal(syntheticFetchCalls, 4);
  const transcript = logs.join('\n');
  for (const forbidden of [secret, ...secretTaskIds, 'https://private.invalid/', 'vendor_prompt',
    'unknown_failure_detail', 'raw_extension', 'transport copied vendor prompt']) {
    assert.ok(!transcript.includes(forbidden), `Sensitive query log leaked: ${forbidden}`);
  }
  assert.match(transcript, /provider_status=succeeded; local_status=succeeded/);
  assert.match(transcript, /provider_status=failed; local_status=failed/);
  assert.match(transcript, /provider_status=unknown; local_status=running/);

    assert.equal(existsSync(syntheticDatabase), false, 'Query engineering must not open its isolated Prisma database');
    writeFileSync(receipt, JSON.stringify({
    schema: 'multiview-private-query-engineering.v1',
    completed: true,
    synthetic: true,
    applicationDatabaseOpened: false,
    productionWrites: 0,
    providerCalls: 0,
    syntheticFetchCalls,
    checks: [
      'protected_query_logs_use_fixed_positive_summary_only',
      'completed_failed_and_unknown_results_preserve_internal_raw_status_and_billing',
      'provider_exception_is_logged_and_rethrown_without_vendor_text',
      'seedance_router_uses_loaded_protection_metadata_and_conservative_partial_cache_context',
    ],
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`Multiview private query engineering receipt: ${receipt}`);
  } finally {
    const constructedPrisma = runtime.prisma;
    try {
      if (constructedPrisma && (!hadPrisma || constructedPrisma !== previousPrisma)) {
        await constructedPrisma.$disconnect();
      }
    } finally {
      if (hadGlobalFetch) globalThis.fetch = originalFetch;
      else Reflect.deleteProperty(globalThis, 'fetch');
      for (const key of guardedEnvironment) {
        const previous = previousEnvironment[key];
        if (previous.present && previous.value !== undefined) Object.assign(process.env, { [key]: previous.value });
        else delete process.env[key];
      }
      if (hadPrisma) setFixtureDatabase(previousPrisma);
      else delete runtime.prisma;
      if (hadPrismaSqlitePragmasStarted) runtime.prismaSqlitePragmasStarted = previousPrismaSqlitePragmasStarted;
      else delete runtime.prismaSqlitePragmasStarted;
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Multiview private query engineering failed');
  process.exitCode = 1;
});
