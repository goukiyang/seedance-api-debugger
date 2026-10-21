(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.UltimateCanvasVideoBatches = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const endpoint = '/api/tools/ultimate-canvas/video-batches';
    const terminal = new Set(['succeeded', 'failed', 'cancelled', 'rejected']);
    const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
    const clone = value => JSON.parse(JSON.stringify(value));

    function counts(batch) {
        const children = batch?.children || [];
        return { total: children.length, accepted: children.filter(child => child.task_id).length,
            prepared: children.filter(child => child.state === 'prepared').length,
            unconfirmed: children.filter(child => child.state === 'unconfirmed').length,
            succeeded: children.filter(child => child.state === 'succeeded').length,
            failed: children.filter(child => ['failed', 'cancelled', 'rejected'].includes(child.state)).length };
    }

    function create(options) {
        const states = new Map();
        const keyFor = scope => `sd2:canvas:video-batch:v1:${scope.userId}:${scope.documentId}:${scope.nodeId}`;
        const current = scope => options.isCurrent(scope);
        const uuid = () => options.uuid ? options.uuid() : crypto.randomUUID();
        function stateFor(scope) {
            if (![scope.userId, scope.documentId, scope.nodeId].every(validId)) throw Error('批次所属画布尚未就绪。');
            const key = keyFor(scope);
            if (!states.has(key)) {
                let fence = {};
                try {
                    const saved = JSON.parse(options.storage.getItem(key) || 'null');
                    if (saved?.version === 1 && saved.scope === key) fence = saved.fence || {};
                } catch { fence = { unreadable: true }; }
                states.set(key, { batches: [], fence, busy: false, readOrder: 0, error: '', nextCursor: null });
            }
            return states.get(key);
        }
        function persist(scope, state) {
            const key = keyFor(scope);
            options.storage.setItem(key, JSON.stringify({ version: 1, scope: key, fence: state.fence }));
        }
        function emit(scope, state) {
            if (current(scope)) options.onChange?.(scope, state);
        }
        function retainBeforeSend(scope, state, change) {
            const before = clone(state.fence);
            change();
            try { persist(scope, state); }
            catch { state.fence = before; throw Error('原请求记录暂时无法保存，本次操作未发送。'); }
        }
        function accept(scope, state, batch) {
            if (!batch || batch.document_id !== scope.documentId || batch.node_id !== scope.nodeId
                || !validId(batch.id) || batch.contract_version !== 1 || ![2, 4].includes(batch.count)
                || !Array.isArray(batch.children) || batch.children.length !== batch.count) throw Error('批次回执与当前对象不一致，未继续派发。');
            const previous = state.batches.find(item => item.id === batch.id);
            if (previous && previous.revision > batch.revision) return previous;
            state.batches = [batch, ...state.batches.filter(item => item.id !== batch.id)]
                .sort((left, right) => String(right.created_at || '').localeCompare(String(left.created_at || '')) || right.id.localeCompare(left.id));
            if (state.fence.prepare?.requestId === batch.request_id) delete state.fence.prepare;
            for (const child of batch.children) {
                // A fresh prepared row is not proof that an earlier POST cannot still arrive.
                const sent = state.fence.children?.[child.id];
                const quoteAttemptSealed = Number.isSafeInteger(sent?.childRevision) && child.revision > sent.childRevision
                    && child.rejection_receipt?.code === 'canvas_video_batch_requote_required'
                    && child.rejection_receipt?.rejected_revision === sent.childRevision;
                if (child.task_id || terminal.has(child.state) || quoteAttemptSealed) delete state.fence.children?.[child.id];
            }
            persist(scope, state);
            options.onBatch?.(scope, batch);
            return batch;
        }
        async function read(scope, { more = false } = {}) {
            const state = stateFor(scope), order = ++state.readOrder;
            if (state.fence.unreadable) throw Error('原批次请求记录暂时无法读取，请保留当前浏览器数据并重试。');
            try {
                if (state.fence.prepare) {
                    const response = await options.request(`${endpoint}?request_id=${encodeURIComponent(state.fence.prepare.requestId)}`, { cache: 'no-store' });
                    if (order !== state.readOrder) return state;
                    if (response.batch) accept(scope, state, response.batch);
                }
                const query = new URLSearchParams({ document_id: scope.documentId, node_id: scope.nodeId });
                if (more && state.nextCursor) query.set('cursor', state.nextCursor);
                const response = await options.request(`${endpoint}?${query}`, { cache: 'no-store' });
                if (order !== state.readOrder) return state;
                for (const batch of response.batches || []) accept(scope, state, batch);
                state.nextCursor = response.next_cursor || null;
                if (state.fence.operation) {
                    const operation = state.fence.operation;
                    const result = await options.request(`${endpoint}/${encodeURIComponent(operation.batchId)}?operation_id=${encodeURIComponent(operation.operationId)}`, { cache: 'no-store' });
                    if (order !== state.readOrder) return state;
                    if (result.batch) accept(scope, state, result.batch);
                    if (result.operation?.operation_id === operation.operationId && result.operation?.state === 'applied') {
                        delete state.fence.operation; persist(scope, state);
                    }
                }
                state.error = '';
            } catch (error) { state.error = error.message || '批次读取失败，可重新查询原请求。'; }
            emit(scope, state);
            return state;
        }
        function blocked(scope) {
            const state = stateFor(scope);
            return state.busy || state.fence.unreadable || Boolean(state.fence.prepare || state.fence.operation)
                || Object.keys(state.fence.children || {}).length > 0
                || state.batches.some(batch => batch.children.some(child => !terminal.has(child.state)));
        }
        function requireContext(scope) {
            if (!current(scope)) throw Error('画布目标已变化，请在原画布查看批次。');
        }
        async function start(scope, input, count, unchanged) {
            if (![2, 4].includes(count)) throw Error('视频数量只能为1、2或4。');
            const state = stateFor(scope);
            if (blocked(scope)) { await read(scope); throw Error('已有批次或原请求待处理，请先查询原批次。'); }
            requireContext(scope);
            state.busy = true; state.error = ''; emit(scope, state);
            try {
                const requestId = uuid();
                const body = { contract_version: 1, request_id: requestId, document_id: scope.documentId,
                    node_id: scope.nodeId, count, input: clone(input) };
                const quote = await options.request(endpoint, { method: 'POST', payload: { ...body, action: 'quote' } });
                requireContext(scope);
                if (!unchanged()) throw Error('参数已变化，未创建批次，请重新确认。');
                if (!await options.confirm(quote, false)) return false;
                requireContext(scope);
                if (!unchanged()) throw Error('参数已变化，未创建批次，请重新确认。');
                if (!await options.flush()) throw Error('画布尚未确认保存，批次未提交。');
                requireContext(scope);
                if (!unchanged()) throw Error('参数已变化，批次未提交。');
                retainBeforeSend(scope, state, () => { state.fence.prepare = { requestId, count }; });
                emit(scope, state);
                const response = await options.request(endpoint, { method: 'POST', payload: { ...body, action: 'prepare', quote_token: quote.quote_token } });
                const batch = accept(scope, state, response.batch);
                emit(scope, state);
                if (!current(scope)) return true;
                await dispatch(scope, state, batch);
                return true;
            } catch (error) {
                state.error = error.message || '提交结果待确认，请查询原请求。';
                throw error;
            } finally { state.busy = false; emit(scope, state); }
        }
        async function dispatch(scope, state, batch) {
            const candidates = batch.children.filter(child => child.state === 'prepared' && !state.fence.children?.[child.id]);
            const concurrency = Math.max(1, Math.min(4, Number(batch.dispatch_limit) || 1));
            let next = 0;
            async function run() {
                while (next < candidates.length && current(scope)) {
                    const child = candidates[next++];
                    if (!validId(child.id) || !['/api/tasks/create', '/api/ip/tasks/create'].includes(child.create_url)
                        || child.create_body?.canvas_video_batch?.batch_id !== batch.id
                        || child.create_body?.canvas_video_batch?.child_id !== child.id
                        || !Number.isSafeInteger(child.revision) || child.revision < 1
                        || child.create_body?.canvas_video_batch?.child_revision !== child.revision
                        || child.create_body?.idempotency_key !== child.idempotency_key) throw Error('子任务派发回执不完整，已停止继续提交。');
                    retainBeforeSend(scope, state, () => {
                        state.fence.children ||= {};
                        state.fence.children[child.id] = { batchId: batch.id, requestId: child.request_id, childRevision: child.revision };
                    });
                    emit(scope, state);
                    try {
                        const response = await options.request(child.create_url, { method: 'POST', payload: child.create_body, policy: 'video' });
                        const taskId = response.task_id || response.id;
                        if (validId(taskId)) options.onAccepted?.(scope, batch, child, response);
                    } catch (error) {
                        state.error = error.message || '子任务受理情况待核对。';
                    }
                    // Only the server's durable child/Task receipt releases the local uncertainty fence.
                    try {
                        const response = await options.request(`${endpoint}/${encodeURIComponent(batch.id)}`, { cache: 'no-store' });
                        accept(scope, state, response.batch);
                    } catch (error) { state.error = error.message || '子任务回执暂时无法读取。'; }
                    emit(scope, state);
                }
            }
            const jobs = [];
            for (let index = 0; index < Math.min(concurrency, candidates.length); index++) jobs.push(run());
            // Client concurrency is bounded by the server's configured dispatch contract.
            await Promise.all(jobs);
        }
        async function continueBatch(scope, batchId) {
            const state = stateFor(scope);
            if (state.busy || state.fence.prepare || state.fence.operation || state.fence.unreadable) return false;
            state.busy = true; emit(scope, state);
            try {
                const response = await options.request(`${endpoint}/${encodeURIComponent(batchId)}`, { cache: 'no-store' });
                const batch = accept(scope, state, response.batch);
                requireContext(scope);
                await dispatch(scope, state, batch);
                return true;
            } finally { state.busy = false; emit(scope, state); }
        }
        async function operation(scope, batchId, action) {
            const state = stateFor(scope);
            if (state.busy || state.fence.prepare || state.fence.operation || state.fence.unreadable) return false;
            state.busy = true; emit(scope, state);
            try {
                const response = await options.request(`${endpoint}/${encodeURIComponent(batchId)}`, { cache: 'no-store' });
                const batch = accept(scope, state, response.batch);
                requireContext(scope);
                let quote;
                if (action === 'reauthorize') {
                    if (batch.children.some(child => state.fence.children?.[child.id])) throw Error('原子请求受理情况尚未确认，请先查询原批次；未更改原报价。');
                    quote = await options.request(endpoint, { method: 'POST', payload: { action: 'quote', batch_id: batch.id, contract_version: 1 } });
                    requireContext(scope);
                    if (!await options.confirm(quote, true)) return false;
                }
                requireContext(scope);
                const operationId = uuid();
                retainBeforeSend(scope, state, () => { state.fence.operation = { batchId, operationId, action }; });
                emit(scope, state);
                const result = await options.request(`${endpoint}/${encodeURIComponent(batchId)}`, { method: 'PATCH', payload: {
                    action, operation_id: operationId, revision: batch.revision, ...(quote ? { quote_token: quote.quote_token } : {}) } });
                accept(scope, state, result.batch);
                delete state.fence.operation; persist(scope, state);
                return true;
            } catch (error) { state.error = error.message || '操作结果待确认，请查询原操作。'; throw error; }
            finally { state.busy = false; emit(scope, state); }
        }
        return { start, read, blocked, continueBatch, operation, peek: stateFor, counts };
    }
    return { create, counts };
});
