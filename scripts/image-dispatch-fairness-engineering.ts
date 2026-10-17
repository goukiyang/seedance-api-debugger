import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import dns from 'node:dns/promises';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import path from 'node:path';
import { mock } from 'node:test';

type Kind = 'batch' | 'toolflow';
type Call = { kind: Kind; candidateQueries: number; loaded: number[]; checked: string[] };
type ObservedBatch = { id?: string; key?: string; updated_at?: Date };
type ObservedRun = { id?: string; created_at?: Date };
const sourcePaths = ['src/lib/image-studio/batches.ts', 'src/lib/tools/toolflow-runtime.ts'];
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Fresh SQLite and actual dispatch functions only. No generation worker is started. */
async function main() {
  const root = realpathSync(process.cwd());
  const mode = process.argv.includes('--baseline') ? 'baseline' : 'verify';
  const startedAt = new Date().toISOString();
  const runId = process.env.IMAGE_RECOVERY_GATE_RUN_ID || randomUUID();
  assert.match(runId, /^[a-zA-Z0-9_.:-]{1,120}$/);
  const require = createRequire(import.meta.url);
  const prismaPackage = require.resolve('prisma/package.json');
  const dependency = { root: realpathSync(path.dirname(path.dirname(prismaPackage))), node: process.versions.node,
    prisma: (require('prisma/package.json') as { version: string }).version,
    tsx: (require('tsx/package.json') as { version: string }).version,
    prismaClientRoot: realpathSync(path.dirname(require.resolve('@prisma/client/package.json'))) };
  const scratch = path.join(root, '.role-tests');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(scratch, 'image-dispatch-fairness-'));
  assert.ok(realpathSync(directory).startsWith(realpathSync(scratch) + path.sep));
  const databasePath = path.join(directory, 'synthetic.db');
  assert.equal(Reflect.get(globalThis, 'prisma'), undefined, 'Use a fresh process before importing application code');
  process.env.DATABASE_URL = `file:${databasePath}`;
  Object.assign(process.env, { NODE_ENV: 'test' });
  Reflect.set(globalThis, 'AsyncLocalStorage', AsyncLocalStorage);
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) env[key] = process.env[key]!;
  Object.assign(env, { DATABASE_URL: process.env.DATABASE_URL, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1', NEXT_TELEMETRY_DISABLED: '1' });
  const schemaLog = execFileSync(process.execPath, [path.join(path.dirname(prismaPackage), 'build/index.js'), 'db', 'push',
    '--skip-generate', '--schema', path.join(root, 'prisma/schema.prisma')], { cwd: directory, env, encoding: 'utf8', timeout: 120000 });
  writeFileSync(path.join(directory, 'schema.log'), schemaLog, { mode: 0o600 });
  const { PrismaClient } = await import('@prisma/client');
  const database = new PrismaClient();
  let activeCall: Call | null = null;
  let onBatchPage: ((rows: ObservedBatch[]) => Promise<void>) | null = null;
  let onFlowPage: ((rows: ObservedRun[]) => Promise<void>) | null = null;
  let failCandidateRead: Kind | null = null;
  let raceObserved = false;
  const calls: Call[] = [];
  const candidateRead = (kind: Kind, record: Call | null) => {
    if (!record) return;
    record.candidateQueries++;
    if (failCandidateRead === kind) { failCandidateRead = null; throw new Error('synthetic candidate database unavailable'); }
  };
  const batchCandidate = (where: unknown) => {
    const filter = (where as { value_json?: { contains?: unknown } } | undefined)?.value_json;
    return filter?.contains === '"state":"ready"';
  };
  const flowCandidate = (where: unknown) => Boolean((where as { node_runs?: unknown } | undefined)?.node_runs);
  const check = (kind: Kind, id: unknown) => {
    if (activeCall?.kind !== kind) return;
    assert.ok(typeof id === 'string', 'A dispatched candidate must have an ID');
    if (!activeCall.checked.includes(id)) activeCall.checked.push(id);
  };
  const observed = database.$extends({ query: {
    platformSetting: {
      async findMany({ args, query }) {
        const record = activeCall?.kind === 'batch' && batchCandidate(args.where) ? activeCall : null;
        candidateRead('batch', record);
        const rows = await query(args); if (record) record.loaded.push(rows.length);
        if (record && onBatchPage) await onBatchPage(rows.map((row): ObservedBatch => {
          const { id, key, updated_at } = row;
          assert.ok(typeof id === 'string', 'A batch page candidate must have an ID');
          assert.ok(typeof key === 'string', 'A batch page candidate must have a key');
          assert.ok(updated_at instanceof Date, 'A batch page candidate must have a SQLite Date');
          return { id, key, updated_at };
        }));
        return rows;
      },
      async findFirst({ args, query }) {
        const record = activeCall?.kind === 'batch' && batchCandidate(args.where) ? activeCall : null;
        candidateRead('batch', record);
        return query(args);
      },
      async findUnique({ args, query }) {
        if (typeof args.where.key === 'string' && /^studio_(?:channel_)?batch_v1:/.test(args.where.key)) {
          check('batch', args.where.key.split(':').pop());
        }
        return query(args);
      },
    },
    toolFlowRun: {
      async findMany({ args, query }) {
        const record = activeCall?.kind === 'toolflow' && flowCandidate(args.where) ? activeCall : null;
        candidateRead('toolflow', record);
        const rows = await query(args); if (record) record.loaded.push(rows.length);
        if (record && onFlowPage) await onFlowPage(rows.map((row): ObservedRun => {
          const { id, created_at } = row;
          assert.ok(typeof id === 'string', 'A toolflow page candidate must have an ID');
          assert.ok(created_at instanceof Date, 'A toolflow page candidate must have a SQLite Date');
          return { id, created_at };
        }));
        return rows;
      },
      async findFirst({ args, query }) {
        const record = activeCall?.kind === 'toolflow' && flowCandidate(args.where) ? activeCall : null;
        candidateRead('toolflow', record);
        return query(args);
      },
      async findUnique({ args, query }) { check('toolflow', args.where.id); return query(args); },
    },
  } });
  Reflect.set(globalThis, 'prisma', observed);
  const originalCwd = process.cwd();
  process.chdir(directory);
  let forbiddenCalls = 0, completed = false;
  const blocked = () => { forbiddenCalls++; throw new Error('Network and generation are prohibited in dispatch fairness engineering'); };
  const deferredCandidates = new Set<string>();
  const originalConsoleError = console.error.bind(console);
  mock.method(console, 'error', (...args: unknown[]) => {
    if (args[0] === '[image-batch-dispatch]' && typeof args[1] === 'string') {
      try {
        const value = JSON.parse(args[1]) as { candidateId?: unknown };
        if (typeof value.candidateId === 'string') deferredCandidates.add(value.candidateId);
      } catch { /* Diagnostics never determine the business result. */ }
    }
    originalConsoleError(...args);
  });
  mock.method(globalThis, 'fetch', blocked);
  mock.method(http, 'request', blocked); mock.method(http, 'get', blocked);
  mock.method(https, 'request', blocked); mock.method(https, 'get', blocked);
  mock.method(dns, 'lookup', blocked);
  const checks: string[] = [];
  const sourceSha256 = Object.fromEntries(sourcePaths.map(file => [file, sha(readFileSync(path.join(root, file)))]));
  const fixtureSha256 = sha(readFileSync(path.join(root, 'scripts/image-dispatch-fairness-engineering.ts')));
  const summary: Record<string, unknown> = {};
  try {
    const { prisma } = await import('../src/lib/prisma');
    assert.equal(prisma, observed, 'Actual dispatchers must use only the isolated SQLite client');
    const batches = await import('../src/lib/image-studio/batches');
    const flows = await import('../src/lib/tools/toolflow-runtime');
    assert.equal(await database.user.count(), 0);
    const owners = ['dispatch-owner-a', 'dispatch-owner-b', 'dispatch-owner-c'];
    for (const id of owners) {
      await database.user.create({ data: { id, name: 'Synthetic owner', username: id, email: `${id}@isolated.invalid`,
        password_hash: 'synthetic-not-a-login', role: 'admin', account_type: 'internal' } });
      await database.creditAccount.create({ data: { user_id: id, balance: 100, frozen_credits: 20 } });
    }
    const base = Date.now() - 86400_000;
    const batchRows: Array<{ id: string; key: string; taskId: string }> = [];
    const flowIds: string[] = [];
    const fixtureOwner = async (index: number) => {
      if (index < 13) return owners[index % owners.length];
      const id = `dispatch-tail-owner-${index}`;
      if (!await database.user.findUnique({ where: { id } })) {
        await database.user.create({ data: { id, name: 'Synthetic tail owner', username: id, email: `${id}@isolated.invalid`,
          password_hash: 'synthetic-not-a-login', role: 'admin', account_type: 'internal' } });
        await database.creditAccount.create({ data: { user_id: id, balance: 100, frozen_credits: 5 } });
      }
      return id;
    };
    const batchRow = async (index: number, readyToFinish = false) => {
      const owner = await fixtureOwner(index);
      const id = sha(`synthetic-batch-${index}`), taskId = `synthetic-batch-task-${index}`;
      await database.imageStudioTask.create({ data: { id: taskId, batch_id: id, owner_id: owner, ordinal: 1,
        fingerprint: `frozen-${taskId}`, prompt: 'Synthetic frozen prompt', context: 'Synthetic frozen context', revision: 1,
        model: 'gpt-image-2.5-sunburst', reference_ids: '[]', unit_credits: readyToFinish ? 0 : 5,
        freeze_snapshot: readyToFinish ? null : JSON.stringify([{ source_type: 'balance', amount: 5 }]),
        status: readyToFinish ? 'cancelled' : 'channel_running', billing_status: readyToFinish ? 'channel_cancelled' : 'channel_unmatched',
        snapshot_json: JSON.stringify({ requestId: `synthetic-request-${index}`, configRevision: 'frozen' }),
        lease_token: readyToFinish ? null : `old-worker-${index}`, lease_until: readyToFinish ? null : new Date(base),
        finished_at: readyToFinish ? new Date(base + index) : null } });
      const key = `studio_batch_v1:${owner}:${id}`;
      await database.platformSetting.create({ data: { id: `synthetic-batch-row-${index}`, key, created_at: new Date(base + index), updated_at: new Date(base + index),
        value_json: JSON.stringify({ version: 1, id, ownerId: owner, requestId: `synthetic-request-${index}`, fingerprint: `frozen-batch-${index}`,
          moduleId: `${owner}-default`, moduleName: 'Synthetic batch', state: 'ready', note: '', createdAt: new Date(base + index).toISOString(),
          total: 1, budget: readyToFinish ? 0 : 5, committedCredits: readyToFinish ? 0 : 5, unitCredits: readyToFinish ? 0 : 5, prepared: 1, input: {},
          items: [{ ordinal: 1, sourceName: 'Synthetic source', taskId, attempt: 0, prepared: true, cancelled: false }] }) } });
      return { id, key, taskId, rowId: `synthetic-batch-row-${index}` };
    };
    const blockedGraph = { version: 1, nodes: [
      { id: 'input', type: 'flow-input', x: 0, y: 0, data: {} },
      { id: 'image', type: 'flow-template', x: 1, y: 0, data: {} },
      { id: 'output', type: 'flow-output', x: 2, y: 0, data: {} },
    ], connections: [{ from: 'input', to: 'image' }, { from: 'image', to: 'output' }] };
    const finishGraph = { ...blockedGraph, nodes: blockedGraph.nodes.filter(node => node.id !== 'image'), connections: [{ from: 'input', to: 'output' }] };
    const flowRow = async (index: number, readyToFinish = false) => {
      const owner = await fixtureOwner(index), flowId = `synthetic-flow-${index}`, id = `synthetic-run-${String(index).padStart(3, '0')}`;
      const graph = readyToFinish ? finishGraph : blockedGraph;
      await database.toolFlow.create({ data: { id: flowId, owner_id: owner, name: 'Synthetic flow', graph_json: JSON.stringify(graph) } });
      await database.toolFlowRun.create({ data: { id, flow_id: flowId, owner_id: owner, flow_version: 1, status: 'running',
        created_at: new Date(base + index), started_at: new Date(base + index), frozen_credits: 0,
        snapshot_json: JSON.stringify({ schema: 'toolflow.v1', flow_id: flowId, flow_owner_id: owner, version: 1, name: 'Synthetic flow',
          project_id: null, graph, input_asset_ids: [] }), node_runs: { create: graph.nodes.map(node => ({ node_id: node.id,
          status: node.id === 'input' ? 'succeeded' : node.id === 'image' ? 'running' : 'pending', result_json: '{}' })) } } });
      return id;
    };
    for (let i = 0; i < 12; i++) { batchRows.push(await batchRow(i)); flowIds.push(await flowRow(i)); }
    const suffixBatch = await batchRow(12, true), suffixFlow = await flowRow(12, true);
    const beforeTasks = JSON.stringify(await database.imageStudioTask.findMany({ orderBy: { id: 'asc' } }));
    const beforeAccounts = JSON.stringify(await database.creditAccount.findMany({ orderBy: { id: 'asc' } }));
    const invoke = async (kind: Kind) => {
      const record: Call = { kind, candidateQueries: 0, loaded: [], checked: [] };
      activeCall = record;
      try { if (kind === 'batch') await batches.dispatchStudioBatches(); else await flows.dispatchWaitingToolFlowRuns(); }
      finally { calls.push(record); activeCall = null; }
      return record;
    };
    const batchState = async (key: string) => JSON.parse((await database.platformSetting.findUniqueOrThrow({ where: { key } })).value_json).state as string;
    const outcome: Record<Kind, { suffixReachedAtCall: number | null; unlockedReachedAtCall: number | null;
      cursorMoveAndDeleteSurvived: boolean; exceptionBypassed: boolean; coldStartSafe: boolean }> = {
      batch: { suffixReachedAtCall: null, unlockedReachedAtCall: null, cursorMoveAndDeleteSurvived: false, exceptionBypassed: false, coldStartSafe: false },
      toolflow: { suffixReachedAtCall: null, unlockedReachedAtCall: null, cursorMoveAndDeleteSurvived: false, exceptionBypassed: false, coldStartSafe: false },
    };
    if (mode === 'baseline') {
      for (let i = 0; i < 3; i++) {
        const batchCall = await invoke('batch'), flowCall = await invoke('toolflow');
        assert.equal(await batchState(suffixBatch.key), 'ready');
        assert.equal((await database.toolFlowRun.findUniqueOrThrow({ where: { id: suffixFlow } })).status, 'running');
        assert.deepEqual(batchCall.checked, batchRows.slice(0, 10).map(row => row.id));
        assert.deepEqual(flowCall.checked, flowIds.slice(0, 10));
        assert.equal(batchCall.candidateQueries, 1); assert.equal(flowCall.candidateQueries, 1);
      }
      assert.equal(JSON.stringify(await database.imageStudioTask.findMany({ orderBy: { id: 'asc' } })), beforeTasks);
      assert.equal(JSON.stringify(await database.creditAccount.findMany({ orderBy: { id: 'asc' } })), beforeAccounts);
      checks.push('baseline_actual_dispatchers_repeat_blocked_prefix');
    } else {
      await invoke('batch'); await invoke('toolflow');
      assert.equal(await batchState(suffixBatch.key), 'ready');
      assert.equal((await database.toolFlowRun.findUniqueOrThrow({ where: { id: suffixFlow } })).status, 'running');
      assert.equal(JSON.stringify(await database.imageStudioTask.findMany({ orderBy: { id: 'asc' } })), beforeTasks);
      assert.equal(JSON.stringify(await database.creditAccount.findMany({ orderBy: { id: 'asc' } })), beforeAccounts);
      // Synthetic external completion unlocks an already-scanned old item.
      // Only these two fixture controls are changed, never a real unknown task.
      await database.imageStudioTask.update({ where: { id: batchRows[0].taskId }, data: {
        status: 'uncertain', lease_until: null, lease_token: null, finished_at: new Date(),
      } });
      await database.toolFlowNodeRun.update({ where: { run_id_node_id: { run_id: flowIds[0], node_id: 'image' } }, data: { status: 'succeeded', finished_at: new Date() } });
      let tailsAdded = 0;
      for (let iteration = 0; iteration < 6; iteration++) {
        const index = 13 + iteration;
        await batchRow(index); await flowRow(index); tailsAdded++;
        await invoke('batch'); await invoke('toolflow');
        for (const kind of ['batch', 'toolflow'] as const) {
          const number = calls.filter(call => call.kind === kind).length;
          const suffixReady = kind === 'batch' ? await batchState(suffixBatch.key) === 'complete'
            : (await database.toolFlowRun.findUniqueOrThrow({ where: { id: suffixFlow } })).status === 'succeeded';
          const oldReady = kind === 'batch' ? await batchState(batchRows[0].key) === 'complete'
            : (await database.toolFlowRun.findUniqueOrThrow({ where: { id: flowIds[0] } })).status === 'succeeded';
          if (suffixReady && outcome[kind].suffixReachedAtCall === null) outcome[kind].suffixReachedAtCall = number;
          if (oldReady && outcome[kind].unlockedReachedAtCall === null) outcome[kind].unlockedReachedAtCall = number;
        }
        if (outcome.batch.unlockedReachedAtCall !== null && outcome.toolflow.unlockedReachedAtCall !== null) break;
      }
      for (const kind of ['batch', 'toolflow'] as const) {
        assert.ok(outcome[kind].suffixReachedAtCall !== null && outcome[kind].suffixReachedAtCall! <= 3);
        assert.ok(outcome[kind].unlockedReachedAtCall !== null && outcome[kind].unlockedReachedAtCall! <= 7);
      }
      summary.tailsAddedBeforeOldUnlock = tailsAdded;
      checks.push('blocked_prefix_suffix_reached', 'bounded_sweep_revisits_unlocked_items_with_continuous_tail');

      const movedProbe = await batchRow(100, true), deletedProbe = await flowRow(100, true);
      let moved = false, deleted = false;
      onBatchPage = async rows => {
        if (rows.length <= 10 || !rows.some(row => row.key === movedProbe.key) || rows.slice(0, 10).some(row => row.key === movedProbe.key)) return;
        const row = rows[9]; assert.ok(typeof row.id === 'string' && row.updated_at instanceof Date);
        onBatchPage = null; moved = true;
        await database.platformSetting.update({ where: { id: row.id }, data: { updated_at: new Date(Date.now() + 1000) } });
      };
      onFlowPage = async rows => {
        if (rows.length <= 10 || !rows.some(row => row.id === deletedProbe) || rows.slice(0, 10).some(row => row.id === deletedProbe)) return;
        const row = rows[9]; assert.ok(typeof row.id === 'string');
        onFlowPage = null; deleted = true;
        await database.toolFlowRun.delete({ where: { id: row.id } });
      };
      let batchMutationSeen = false, flowMutationSeen = false;
      for (let iteration = 0; iteration < 8; iteration++) {
        const batchCall = await invoke('batch'), flowCall = await invoke('toolflow');
        if (batchMutationSeen && !outcome.batch.cursorMoveAndDeleteSurvived) assert.equal(batchCall.candidateQueries, 1, 'The unchecked suffix must remain in the captured sweep, not be jumped over');
        if (flowMutationSeen && !outcome.toolflow.cursorMoveAndDeleteSurvived) assert.equal(flowCall.candidateQueries, 1, 'A removed cursor row must not reset or jump the sweep');
        if (moved && await batchState(movedProbe.key) === 'complete') outcome.batch.cursorMoveAndDeleteSurvived = true;
        if (deleted && (await database.toolFlowRun.findUniqueOrThrow({ where: { id: deletedProbe } })).status === 'succeeded') outcome.toolflow.cursorMoveAndDeleteSurvived = true;
        batchMutationSeen = moved; flowMutationSeen = deleted;
        if (outcome.batch.cursorMoveAndDeleteSurvived && outcome.toolflow.cursorMoveAndDeleteSurvived) break;
      }
      assert.ok(moved && deleted && outcome.batch.cursorMoveAndDeleteSurvived && outcome.toolflow.cursorMoveAndDeleteSurvived);

      // Also remove the batch cursor row itself after loading, not just move it.
      const removedProbe = await batchRow(101, true);
      let batchCursorRemoved = false;
      onBatchPage = async rows => {
        if (rows.length <= 10 || !rows.some(row => row.key === removedProbe.key) || rows.slice(0, 10).some(row => row.key === removedProbe.key)) return;
        const row = rows[9]; assert.ok(typeof row.id === 'string');
        onBatchPage = null; batchCursorRemoved = true;
        await database.platformSetting.delete({ where: { id: row.id } });
      };
      for (let iteration = 0; iteration < 8 && (!batchCursorRemoved || await batchState(removedProbe.key) !== 'complete'); iteration++) await invoke('batch');
      assert.ok(batchCursorRemoved); assert.equal(await batchState(removedProbe.key), 'complete');
      checks.push('captured_cursor_survives_move_and_delete');

      const badBatchKey = `studio_batch_v1:${owners[0]}:${sha('invalid-candidate')}`;
      const badBatchValue = '{"state":"ready",invalid';
      await database.platformSetting.create({ data: { id: 'invalid-dispatch-batch', key: badBatchKey, value_json: badBatchValue,
        created_at: new Date(base - 1000), updated_at: new Date(base - 1000) } });
      const badFlow = await flowRow(102);
      await database.toolFlowRun.update({ where: { id: badFlow }, data: { created_at: new Date(base - 1000), snapshot_json: '{}' } });
      const afterErrorBatch = await batchRow(103, true), afterErrorFlow = await flowRow(103, true);
      for (let iteration = 0; iteration < 8; iteration++) {
        await invoke('batch'); await invoke('toolflow');
        outcome.batch.exceptionBypassed = await batchState(afterErrorBatch.key) === 'complete';
        outcome.toolflow.exceptionBypassed = (await database.toolFlowRun.findUniqueOrThrow({ where: { id: afterErrorFlow } })).status === 'succeeded';
        if (outcome.batch.exceptionBypassed && outcome.toolflow.exceptionBypassed && deferredCandidates.has('invalid-dispatch-batch')
          && calls.some(call => call.kind === 'toolflow' && call.checked.includes(badFlow))) break;
      }
      assert.ok(outcome.batch.exceptionBypassed && outcome.toolflow.exceptionBypassed);
      assert.ok(deferredCandidates.has('invalid-dispatch-batch'));
      assert.ok(calls.some(call => call.kind === 'toolflow' && call.checked.includes(badFlow)));
      assert.equal((await database.platformSetting.findUniqueOrThrow({ where: { key: badBatchKey } })).value_json, badBatchValue);
      assert.equal((await database.toolFlowRun.findUniqueOrThrow({ where: { id: badFlow } })).snapshot_json, '{}');
      // Global query failures are not converted into a normal dispatch result.
      for (const kind of ['batch', 'toolflow'] as const) {
        failCandidateRead = kind;
        await assert.rejects(invoke(kind), /synthetic candidate database unavailable/);
      }

      const racing = await batchRow(104, true);
      const raceOriginal = await database.platformSetting.findUniqueOrThrow({ where: { id: racing.rowId } });
      onBatchPage = async rows => {
        if (!rows.slice(0, 10).some(row => row.id === racing.rowId)) return;
        onBatchPage = null;
        await database.platformSetting.update({ where: { id: racing.rowId }, data: {
          value_json: JSON.stringify({ ...JSON.parse(raceOriginal.value_json), state: 'paused' }),
        } });
        raceObserved = true;
      };
      for (let iteration = 0; iteration < 8 && !raceObserved; iteration++) await invoke('batch');
      assert.ok(raceObserved); assert.equal(await batchState(racing.key), 'paused', 'The actual dispatcher must reread and preserve an intervening edit');
      const staleWrite = await database.platformSetting.updateMany({ where: { id: racing.rowId, value_json: raceOriginal.value_json },
        data: { value_json: JSON.stringify({ ...JSON.parse(raceOriginal.value_json), state: 'complete' }) } });
      assert.equal(staleWrite.count, 0, 'The unchanged expected-JSON CAS rejects the stale write in real SQLite');
      checks.push('candidate_exception_does_not_pin_scan');

      const { reserveImageStudioQueueCapacity, QueueCapacityError } = await import('../src/lib/image-studio/queue-capacity');
      const activeStatuses = ['queued', 'running', 'channel_queued', 'channel_running'];
      const activeCount = await database.imageStudioTask.count({ where: { owner_id: owners[0], status: { in: activeStatuses } } });
      assert.ok(activeCount <= 8);
      for (let i = activeCount; i < 8; i++) await database.imageStudioTask.create({ data: {
        id: `synthetic-capacity-${i}`, owner_id: owners[0], batch_id: 'synthetic-capacity', ordinal: i,
        fingerprint: `synthetic-capacity-${i}`, prompt: '', context: '', revision: 1, model: 'gpt-image-2.5-sunburst',
        reference_ids: '[]', unit_credits: 0, status: 'queued',
      } });
      await assert.rejects(database.$transaction(tx => reserveImageStudioQueueCapacity(tx, owners[0], 1)),
        (error: unknown) => error instanceof QueueCapacityError);

      // A real new Node process reloads both modules with absent memory cursors.
      // Its database path is this freshly created fixture, never a caller URL.
      const restartBatch = await batchRow(105, true), restartFlow = await flowRow(105, true);
      const tasksBeforeRestart = await database.imageStudioTask.count();
      const child = `
        import { createRequire } from 'node:module';
        const require = createRequire(${JSON.stringify(path.join(root, 'package.json'))});
        globalThis.AsyncLocalStorage = require('node:async_hooks').AsyncLocalStorage;
        let forbiddenCalls = 0;
        const blocked = () => { forbiddenCalls++; throw new Error('Restart fixture network prohibited'); };
        globalThis.fetch = blocked;
        for (const name of ['node:http', 'node:https']) { const transport = require(name); transport.request = blocked; transport.get = blocked; }
        require('node:dns/promises').lookup = blocked;
        process.chdir(${JSON.stringify(directory)});
        process.exitCode = 1;
        async function run() {
          const { prisma } = require(${JSON.stringify(path.join(root, 'src/lib/prisma.ts'))});
          try {
            const batch = require(${JSON.stringify(path.join(root, 'src/lib/image-studio/batches.ts'))});
            const flow = require(${JSON.stringify(path.join(root, 'src/lib/tools/toolflow-runtime.ts'))});
            for (let i = 0; i < 6; i++) { await batch.dispatchStudioBatches(); await flow.dispatchWaitingToolFlowRuns(); }
          } finally { await prisma.$disconnect(); }
        }
        run().then(() => { console.log(JSON.stringify({ forbiddenCalls })); process.exitCode = forbiddenCalls === 0 ? 0 : 1; }, error => { console.error(error); process.exitCode = 1; });
      `;
      const childOutput = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', child], { cwd: root, env, stdio: 'pipe', timeout: 120000, encoding: 'utf8' });
      const childProof = JSON.parse(childOutput) as { forbiddenCalls: number };
      assert.equal(childProof.forbiddenCalls, 0); forbiddenCalls += childProof.forbiddenCalls;
      assert.equal(await batchState(restartBatch.key), 'complete');
      assert.equal((await database.toolFlowRun.findUniqueOrThrow({ where: { id: restartFlow } })).status, 'succeeded');
      assert.equal(await database.imageStudioTask.count(), tasksBeforeRestart);
      outcome.batch.coldStartSafe = true; outcome.toolflow.coldStartSafe = true;
      checks.splice(3, 0, 'cold_start_and_wrap_are_safe');

      const originalTasks = JSON.parse(beforeTasks) as Array<Record<string, unknown>>;
      for (const original of originalTasks) {
        assert.ok(typeof original.id === 'string');
        const row = await database.imageStudioTask.findUniqueOrThrow({ where: { id: original.id } });
        const current = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
        for (const field of Object.keys(original)) {
          if (row.id === batchRows[0].taskId && ['status', 'lease_until', 'lease_token', 'finished_at', 'updated_at'].includes(field)) continue;
          assert.deepEqual(current[field], original[field], `Dispatch changed frozen task ${row.id}/${field}`);
        }
      }
      const originalAccounts = JSON.parse(beforeAccounts) as Array<Record<string, unknown>>;
      for (const original of originalAccounts) {
        assert.ok(typeof original.id === 'string');
        assert.deepEqual(JSON.parse(JSON.stringify(await database.creditAccount.findUniqueOrThrow({ where: { id: original.id } }))), original);
      }
      checks.push('original_identity_cas_admission_and_credits_preserved');
      summary.business = { originalTasksCompared: originalTasks.length, originalAccountsCompared: originalAccounts.length,
        staleCasRejected: true, admissionRejectedAtEight: true, restartProcess: true };
      assert.deepEqual(checks, ['blocked_prefix_suffix_reached', 'bounded_sweep_revisits_unlocked_items_with_continuous_tail',
        'captured_cursor_survives_move_and_delete', 'cold_start_and_wrap_are_safe', 'candidate_exception_does_not_pin_scan',
        'original_identity_cas_admission_and_credits_preserved']);
    }
    assert.equal(await database.creditLedger.count(), 0); assert.equal(forbiddenCalls, 0);
    for (const kind of ['batch', 'toolflow'] as const) {
      const ownCalls = calls.filter(call => call.kind === kind);
      for (const call of ownCalls) {
        assert.ok(call.candidateQueries <= 2); assert.ok(call.checked.length <= 10);
        assert.ok(call.loaded.every(count => count <= 32));
      }
      summary[kind] = { prefixCount: 12, calls: ownCalls.length,
        maxCandidateQueriesPerCall: Math.max(...ownCalls.map(call => call.candidateQueries)),
        maxCandidateChecksPerCall: Math.max(...ownCalls.map(call => call.checked.length)),
        maxLoadedPerQuery: Math.max(...ownCalls.flatMap(call => call.loaded)), ...outcome[kind] };
    }
    completed = true;
  } finally {
    mock.restoreAll();
    await database.$disconnect();
    process.chdir(originalCwd);
    const receipt = path.join(directory, 'receipt.json');
    writeFileSync(receipt, JSON.stringify({ schema: 'image-dispatch-fairness-engineering.v1', runId, mode, startedAt, finishedAt: new Date().toISOString(),
      fixtureSha256, sourceSha256, dependency, databasePath, checks, summary, calls, completed, forbiddenCalls,
      productionWrites: 0, paidRequests: 0, browserRuns: 0,
      scope: 'Actual dispatch metadata and SQLite CAS only; no original provider query, image generation, full media delivery or production incident reproduction.' }, null, 2), { mode: 0o600 });
    console.log(`Image dispatch fairness engineering receipt: ${receipt}`);
  }
}

process.exitCode = 1;
void main().then(() => { process.exitCode = 0; }, error => { console.error(error); process.exitCode = 1; });
