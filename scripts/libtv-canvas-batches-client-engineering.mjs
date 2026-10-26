import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { create, counts } = require('../public/tools/ultimate-canvas/video-batches.js');
const endpoint = '/api/tools/ultimate-canvas/video-batches';
const scope = { userId: 'user-1', documentId: 'document-1', nodeId: 'node-1' };
const copy = value => structuredClone(value);
const checks = [];
globalThis.fetch = () => { throw Error('Network forbidden in synthetic client checks'); };

function fixture(overrides = {}) {
    const storage = overrides.storage || new Map();
    const calls = [];
    let batch = null, operation = null, active = 0, maximumActive = 0, current = true, sequence = 0;
    const makeBatch = () => ({ id: 'batch-1', contract_version: 1, request_id: 'key-1',
        document_id: scope.documentId, node_id: scope.nodeId, count: 2, revision: 1,
        state: 'prepared', created_at: '2026-10-21T20:00:00Z', dispatch_limit: 1,
        children: [1, 2].map(ordinal => ({ id: `child-${ordinal}`, ordinal, request_id: `request-${ordinal}`,
            idempotency_key: `child-key-${ordinal}`, state: 'prepared', task_id: null, revision: 1,
            create_url: ordinal === 1 ? '/api/tasks/create' : '/api/ip/tasks/create',
            create_body: { canvas_video_batch: { batch_id: 'batch-1', child_id: `child-${ordinal}`, contract_version: 1, child_revision: 1 },
                idempotency_key: `child-key-${ordinal}` } })) });
    const request = async (url, options = {}) => {
        const method = options.method || 'GET';
        calls.push({ url, method, payload: copy(options.payload) });
        if (overrides.intercept) {
            const intercepted = await overrides.intercept(url, options, { batch, calls });
            if (intercepted !== undefined) return copy(intercepted);
        }
        if (method === 'POST' && url === endpoint && options.payload.action === 'quote') {
            return { quote_token: 'synthetic-only', authorized_total: 3.3,
                children: [{ authorized_maximum: 1.1 }, { authorized_maximum: 2.2 }] };
        }
        if (method === 'POST' && url === endpoint && options.payload.action === 'prepare') {
            batch = makeBatch(); batch.request_id = options.payload.request_id;
            return { batch: copy(batch) };
        }
        if (method === 'POST' && ['/api/tasks/create', '/api/ip/tasks/create'].includes(url)) {
            active++; maximumActive = Math.max(maximumActive, active);
            await Promise.resolve();
            const child = batch.children.find(item => item.id === options.payload.canvas_video_batch.child_id);
            child.task_id = `task-${child.ordinal}`; child.state = 'accepted'; batch.revision++;
            active--;
            return { task_id: child.task_id, status: 'queued' };
        }
        if (method === 'PATCH') {
            operation = { operation_id: options.payload.operation_id, state: 'applied' };
            if (options.payload.action === 'stop') for (const child of batch.children) {
                if (child.state === 'prepared') child.state = 'rejected';
            }
            batch.revision++;
            return { batch: copy(batch), operation };
        }
        if (url.includes('document_id=')) return { batches: batch ? [copy(batch)] : [], next_cursor: null };
        return { batch: copy(batch), ...(operation ? { operation } : {}) };
    };
    const controller = create({
        storage: { getItem: key => storage.get(key) || null, setItem: (key, value) => {
            if (overrides.storageFailure) throw Error('Storage unavailable'); storage.set(key, value);
        } }, request, uuid: () => `key-${++sequence}`, isCurrent: () => current,
        confirm: async quote => { assert.equal(quote.authorized_total, 3.3); return overrides.confirm?.() ?? true; },
        flush: async () => overrides.flush?.() ?? true,
    });
    return { controller, calls, storage, makeBatch, setBatch: value => { batch = value; },
        changeContext: () => { current = false; }, maximumActive: () => maximumActive };
}

{
    const f = fixture();
    assert.equal(await f.controller.start(scope, { prompt: 'frozen seed', seed: 8 }, 2, () => true), true);
    assert.equal(f.maximumActive(), 1);
    assert.deepEqual(f.calls.filter(item => item.url.endsWith('/create')).map(item => item.payload.idempotency_key), ['child-key-1', 'child-key-2']);
    assert.deepEqual(counts(f.controller.peek(scope).batches[0]), { total: 2, accepted: 2, prepared: 0, unconfirmed: 0, succeeded: 0, failed: 0 });
    const posts = f.calls.filter(item => item.method === 'POST').length;
    await f.controller.read(scope); await f.controller.continueBatch(scope, 'batch-1');
    assert.equal(f.calls.filter(item => item.method === 'POST').length, posts, 'accepted children never dispatch again');
    checks.push('independent frozen children, serial admission, accepted children query-only');
}
{
    const f = fixture({ intercept: async (url, options) => {
        if (url === endpoint && options.payload?.action === 'prepare') throw Error('Lost prepare response');
    } });
    await assert.rejects(f.controller.start(scope, {}, 2, () => true), /Lost prepare/);
    const before = f.calls.length;
    await f.controller.read(scope);
    assert.ok(f.controller.peek(scope).fence.prepare);
    assert.ok(f.calls.slice(before).every(item => item.method === 'GET'));
    const restored = fixture({ storage: f.storage });
    assert.equal(Boolean(restored.controller.blocked(scope)), true);
    await restored.controller.read(scope);
    assert.ok(restored.calls.every(item => item.method === 'GET'));
    assert.ok(restored.controller.peek(scope).fence.prepare, 'missing receipt cannot prove rejection');
    checks.push('lost parent receipt survives reload, absence never permits resend');
}
{
    const f = fixture({ intercept: async (url, options) => {
        if (url.endsWith('/create') && options.method === 'POST') throw Error('Unknown child admission');
    } });
    await f.controller.start(scope, {}, 2, () => true);
    assert.equal(Object.keys(f.controller.peek(scope).fence.children).length, 2);
    const posts = f.calls.filter(item => item.url.endsWith('/create')).length;
    await f.controller.continueBatch(scope, 'batch-1');
    assert.equal(f.calls.filter(item => item.url.endsWith('/create')).length, posts);
    await assert.rejects(f.controller.operation(scope, 'batch-1', 'reauthorize'), /尚未确认/);
    const revised = copy(f.controller.peek(scope).batches[0]);
    for (const child of revised.children) {
        child.revision = 2;
        child.rejection_receipt = { code: 'canvas_video_batch_requote_required', rejected_revision: 1 };
    }
    revised.revision++;
    f.setBatch(revised); await f.controller.read(scope);
    assert.equal(Object.keys(f.controller.peek(scope).fence.children).length, 0, 'Only a durable original-revision barrier releases the quote attempt');
    checks.push('fresh prepared rows cannot erase unknown child requests');
}
{
    const f = fixture({ intercept: async (_url, options) => {
        if (options.method === 'PATCH') throw Error('Lost operation response');
    } });
    f.setBatch(f.makeBatch()); await f.controller.read(scope);
    await assert.rejects(f.controller.operation(scope, 'batch-1', 'stop'), /Lost operation/);
    await f.controller.read(scope);
    assert.ok(f.controller.peek(scope).fence.operation);
    assert.equal(await f.controller.operation(scope, 'batch-1', 'stop'), false);
    assert.equal(f.calls.filter(item => item.method === 'PATCH').length, 1);
    checks.push('unknown stop retains original operation ID and does not repeat PATCH');
}
{
    const f = fixture({ storageFailure: true });
    await assert.rejects(f.controller.start(scope, {}, 2, () => true), /未发送/);
    assert.equal(f.calls.some(item => item.payload?.action === 'prepare'), false);
    const changed = fixture({ confirm: () => { changed.changeContext(); return true; } });
    await assert.rejects(changed.controller.start(scope, {}, 2, () => true), /目标已变化/);
    assert.equal(changed.calls.some(item => item.payload?.action === 'prepare'), false);
    const edited = fixture();
    await assert.rejects(edited.controller.start(scope, {}, 2, () => false), /参数已变化/);
    assert.equal(edited.calls.some(item => item.payload?.action === 'prepare'), false);
    checks.push('storage, account/context and edited-input barriers before writes');
}
{
    const f = fixture(); f.setBatch(f.makeBatch());
    await f.controller.read(scope); await f.controller.operation(scope, 'batch-1', 'stop');
    assert.equal(f.controller.peek(scope).fence.operation, undefined);
    await f.controller.continueBatch(scope, 'batch-1');
    assert.equal(f.calls.some(item => item.url.endsWith('/create')), false);
    assert.equal(Boolean(f.controller.blocked({ ...scope, userId: 'user-2' })), false);
    checks.push('stopped children cannot dispatch, account state isolated');
}
console.log(JSON.stringify({ checks, passed: checks.length, networkCalls: 0 }));
