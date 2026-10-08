(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.UltimateCanvasCommands = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    /*
     * Lead integration contract: load after canvas-engine.js. Create one instance
     * per loaded document. Call begin()/commit() around direct config edits or
     * checkpoint() after a completed edit. onChange is the single save/toolbar
     * hook; onRestore must stop polling for removed nodes and refresh/reconcile
     * restored nodes using server reads only. Undo history is memory-only.
     */

    const DEFAULT_MAX_ENTRIES = 40;
    const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
    const CONFIG_KEYS = new Set([
        'title', 'prompt', 'authoredText', 'description', 'context', 'savedContext', 'contextRules', 'mode', 'imageSettings',
        'videoSettings', 'settings', 'model', 'textModel', 'quality', 'ratio', 'size', 'resolution', 'count',
        'duration', 'cameraPresets', 'templateId', 'template_id', 'templateVersion', 'moduleId', 'module_id',
        'source', 'executionMode', 'inputSource', 'retryCount', 'outputMode', 'canvasStyle', 'planSource',
        'planReferences', 'planParameterSource', 'videoCardId', 'videoBranchId', 'storyWorkflow', 'storySource', 'canvasGroup',
        'referenceImageIds', 'reference_image_ids', 'provider', 'promptMentions'
    ]);
    const TRANSIENT_KEYS = new Set([
        'status', 'state', 'error', 'result', 'results', 'progress', 'generatedtext', 'generationsummary',
        'storyrequest', 'storyimages', 'storymedianodes', 'storyreferences', 'storylineage', 'storyversions',
        'taskid', 'taskids', 'providertaskid', 'providertaskids', 'upstreamtaskid', 'imagetaskid', 'videotaskid',
        'studiotaskid', 'imagestudiotaskid', 'runid', 'runids', 'flowrunid', 'toolflowrunid', 'batchid',
        'batchids', 'stylejob', 'requestid', 'mutationid', 'idempotencykey', 'submissionid', 'documentid',
        'canvasdocumentid', 'activegenerationnodeid', 'generationresult', 'generationerror', 'generationprogress',
        'generationstatus', 'videosubmission', 'videosubmissionlegacy', 'videohistory', 'selectedvideoresult',
        'generationpayload', 'previewvideotaskid', 'taskstatus', 'runstatus', 'batchstatus', 'statusendpoint',
        'pollingurl', 'pollurl', 'frozencost', 'quotedcost', 'pointquote', 'quote', 'reservation', 'settlement',
        'ledgerentry', 'chargedpoints', 'costfreeze', 'providerresponse'
    ]);
    const MEDIA_KEYS = new Set([
        'previewimage', 'referenceimage', 'referenceimages', 'thumbnail', 'thumbnails', 'poster', 'cover',
        'preview', 'previews', 'src', 'srcset', 'href', 'assetpreviews', 'stabledownloadready', 'image', 'images',
        'video', 'audio', 'videopreviewurl', 'videodownloadurl', 'resultvideourl', 'imagdownloadurl'
    ]);
    const TASK_ID_FIELDS = [
        'taskId', 'task_id', 'providerTaskId', 'provider_task_id', 'runId', 'run_id', 'batchId', 'batch_id'
    ];
    const REQUEST_INPUT_FIELDS = [
        'nodeId', 'kind', 'requestId', 'projectId', 'videoCardId', 'videoBranchId', 'documentId', 'mode',
        'prompt', 'promptUserEdited', 'referenceImageIds', 'promptMentions', 'settings'
    ];
    const INPUT_SETTING_FIELDS = new Set(['provider', 'model', 'ratio', 'duration', 'resolution', 'quality', 'size', 'count', 'mode']);
    const SAFE_VIDEO_REFERENCE_FIELDS = [
        'taskId', 'requestId', 'contentKey', 'assetId', 'libraryItemId'
    ];

    function normalizeKey(key) {
        return String(key).replace(/[_-]/g, '').toLowerCase();
    }

    function isRecord(value) {
        return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    }

    function clone(value) {
        if (value === undefined) return undefined;
        if (typeof structuredClone === 'function') return structuredClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    function stableValue(value) {
        if (Array.isArray(value)) return value.map(stableValue);
        if (!isRecord(value)) return value;
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
    }

    function stableStringify(value) {
        return JSON.stringify(stableValue(value));
    }

    function isEphemeralUrl(value) {
        return typeof value === 'string' && (/^(?:blob:|data:(?:image|video|audio)\/[^;,]+;base64,)/i.test(value));
    }

    function isBinaryPayload(value) {
        return value instanceof ArrayBuffer || ArrayBuffer.isView(value)
            || (typeof Blob === 'function' && value instanceof Blob);
    }

    function sanitize(value, key = '') {
        if (isEphemeralUrl(value) || isBinaryPayload(value)) return undefined;
        if (Array.isArray(value)) return value.map(item => sanitize(item)).filter(item => item !== undefined);
        if (!isRecord(value)) return value;
        const result = {};
        Object.entries(value).forEach(([childKey, childValue]) => {
            const normalized = normalizeKey(childKey);
            if (TRANSIENT_KEYS.has(normalized) || MEDIA_KEYS.has(normalized)
                || /(?:url|urls|uri|uris)$/.test(normalized)
                || /(?:quote|cost|charge|billing|reservation|settlement|ledger|frozen|points?|credit|payment|refund|balance|fee|amount)$/i.test(normalized)
                || /^(?:quoted|frozen|settled|actualcost|estimatedcost|charged|billing|reservation|settlement|ledger|payment|refund|balance|fee|(?:point|credit)(?:quote|cost|amount|balance|freeze|settlement))/i.test(normalized)) return;
            const clean = sanitize(childValue, childKey);
            if (clean !== undefined) result[childKey] = clean;
        });
        return result;
    }

    function safeIdentifier(value) {
        if (typeof value !== 'string' && typeof value !== 'number') return null;
        const text = String(value).trim();
        return text && text.length <= 256 ? text : null;
    }

    function pickFields(value, fields) {
        if (!isRecord(value)) return null;
        const result = {};
        fields.forEach(key => {
            const item = value[key];
            if (item === undefined || item === null) return;
            if (key === 'promptMentions' && isRecord(item)) {
                result[key] = sanitize(item);
                return;
            }
            if (key === 'settings' && isRecord(item)) {
                const settings = {};
                Object.entries(item).forEach(([settingKey, settingValue]) => {
                    if (INPUT_SETTING_FIELDS.has(settingKey) && (typeof settingValue === 'string' || typeof settingValue === 'number')) {
                        settings[settingKey] = settingValue;
                    }
                });
                if (Object.keys(settings).length) result.settings = settings;
                return;
            }
            if (key === 'referenceImageIds' && Array.isArray(item)) {
                result[key] = item.map(safeIdentifier).filter(Boolean);
                return;
            }
            if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') result[key] = item;
        });
        return Object.keys(result).length ? result : null;
    }

    function safeVideoReference(value) {
        if (!isRecord(value)) return null;
        const result = {};
        SAFE_VIDEO_REFERENCE_FIELDS.forEach(key => {
            const id = safeIdentifier(value[key]);
            if (id) result[key] = id;
        });
        return Object.keys(result).length ? result : null;
    }

    function captureRuntimeReferences(data = {}) {
        const refs = {};
        if (data.generationStatus && data.generationStatus !== 'idle' || data.generatedText || data.result
            || data.generationResult || data.storyRequest) refs.hadGeneration = true;
        if (data.storyRequest) refs.storyRequest = { state: 'unconfirmed', stage: data.storyRequest.stage,
            message: '恢复的文字请求结果未确认；不会自动重发。' };
        TASK_ID_FIELDS.forEach(key => {
            const id = safeIdentifier(data[key]);
            if (id) refs[key] = id;
        });
        const submission = data.videoSubmission;
        if (isRecord(submission)) {
            const requestId = safeIdentifier(submission.requestId);
            const taskId = safeIdentifier(submission.taskId);
            const input = pickFields(submission.input, ['model', 'ratio', 'duration', 'resolution', 'prompt', 'promptMentions']);
            const generationPayload = pickFields(submission.generationPayload, REQUEST_INPUT_FIELDS);
            if (requestId || taskId) {
                refs.videoSubmission = {
                    ...(requestId ? { requestId } : {}),
                    ...(taskId ? { taskId } : {}),
                    state: 'unconfirmed',
                    ...(safeIdentifier(submission.userId) ? { userId: safeIdentifier(submission.userId) } : {}),
                    ...(safeIdentifier(submission.documentId) ? { documentId: safeIdentifier(submission.documentId) } : {}),
                    ...(input ? { input } : {}),
                    ...(generationPayload ? { generationPayload } : {})
                };
            }
        }
        if (Array.isArray(data.videoHistory)) {
            refs.videoHistory = data.videoHistory.map(safeVideoReference).filter(Boolean);
        }
        const selected = safeVideoReference(data.selectedVideoResult);
        if (selected) refs.selectedVideoResult = selected;
        return refs;
    }

    function captureState(engine) {
        return {
            version: 1,
            nodes: [...engine.nodes.values()].map(node => ({
                id: node.id,
                type: node.type,
                x: Number(node.x) || 0,
                y: Number(node.y) || 0,
                data: sanitize(node.data || {}),
                runtimeReferences: captureRuntimeReferences(node.data || {})
            })),
            connections: engine.connections.map(({ from, to }) => ({ from, to })),
            planSplits: engine.planSplits ? sanitize(engine.planSplits) : null,
            nextNodeId: Number(engine.nextNodeId) || 1
        };
    }

    function extractCurrentRuntime(data = {}) {
        const result = {};
        Object.entries(data).forEach(([key, value]) => {
            const normalized = normalizeKey(key);
            if (TRANSIENT_KEYS.has(normalized) || MEDIA_KEYS.has(normalized) || /(?:url|urls|uri|uris)$/.test(normalized)
                || ['taskid', 'taskids', 'providertaskid', 'providertaskids', 'runid', 'batchid', 'requestid',
                    'generationstatus', 'generationresult', 'generationerror', 'generationprogress', 'videoresult',
                    'frozencost', 'quotedcost', 'pointquote', 'quote', 'reservation', 'settlement', 'ledgerentry',
                    'chargedpoints', 'costfreeze', 'providerresponse', 'assetid', 'referenceimageid',
                    'workspaceassetid', 'libraryitemid', 'contentkey', 'stabledownloadready', 'previewavailable',
                    'imageurl', 'originalurl', 'thumbnailurl', 'videopreviewurl', 'videodownloadurl',
                    'resultvideourl', 'resultlastframeurl', 'imagedownloadurl'].includes(normalized)) {
                result[key] = value;
            }
        });
        return result;
    }

    function rehydrateRuntimeReferences(data, refs) {
        Object.entries(refs || {}).forEach(([key, value]) => {
            if (key === 'hadGeneration') return;
            if (key === 'videoHistory') {
                data.videoHistory = value.map(item => ({ ...clone(item), status: 'querying', stableDownloadReady: false }));
            } else if (key === 'videoSubmission') {
                data.videoSubmission = { ...clone(value), state: 'unconfirmed' };
            } else {
                data[key] = clone(value);
            }
        });
        return data;
    }

    function duplicateNodeData(node, idMap, groupIdMap) {
        const source = node.data || {};
        const data = {};
        Object.entries(source).forEach(([key, value]) => {
            if (!CONFIG_KEYS.has(key)) return;
            const clean = sanitize(value, key);
            if (clean !== undefined) data[key] = clean;
        });
        const sourceAsset = ['upload', 'asset', 'reference_image'].includes(String(source.source))
            && !source.taskId && !source.generationResult && source.generationStatus !== 'succeeded';
        if (node.type === 'flow-input') {
            const ids = source.assetIds || source.asset_ids;
            if (Array.isArray(ids)) data.assetIds = ids.map(safeIdentifier).filter(Boolean);
            data.asset_ids = [...(data.assetIds || [])];
        } else if (sourceAsset) {
            ['assetId', 'asset_id', 'referenceImageId', 'reference_image_id'].forEach(key => {
                const id = safeIdentifier(source[key]);
                if (id) data[key] = id;
            });
        }
        ['referenceImageIds', 'reference_image_ids'].forEach(key => {
            if (Array.isArray(source[key])) data[key] = source[key].map(safeIdentifier).filter(Boolean);
        });
        if (isRecord(data.planSource)) {
            const sourceNodeId = String(data.planSource.sourceNodeId || '');
            data.planSource.sourceNodeId = idMap.get(sourceNodeId) || null;
        }
        if (isRecord(data.storySource)) data.storySource.nodeId = idMap.get(String(data.storySource.nodeId || '')) || null;
        if (Array.isArray(data.planReferences)) {
            data.planReferences = data.planReferences.map(item => isRecord(item)
                ? { ...item, nodeId: idMap.get(String(item.nodeId || '')) || item.nodeId }
                : item);
        }
        const group = isRecord(data.canvasGroup) ? data.canvasGroup : null;
        if (group?.id) {
            if (!groupIdMap.has(group.id)) groupIdMap.set(group.id, `group-${uniqueToken()}`);
            data.canvasGroup = {
                version: 1,
                id: groupIdMap.get(group.id),
                ...(typeof group.name === 'string' && group.name ? { name: group.name.slice(0, 80) } : {})
            };
        }
        return data;
    }

    function uniqueToken() {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

    function byteLength(value) {
        const text = stableStringify(value);
        if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).length;
        return text.length * 2;
    }

    function createCanvasCommands(engine, options = {}) {
        if (!engine || !(engine.nodes instanceof Map) || !Array.isArray(engine.connections)) {
            throw new TypeError('createCanvasCommands requires a canvas engine');
        }
        const maxEntries = Math.max(1, Number(options.maxEntries) || DEFAULT_MAX_ENTRIES);
        const maxBytes = Math.max(1024, Number(options.maxBytes) || DEFAULT_MAX_BYTES);
        const coalesceMs = Math.max(0, Number(options.coalesceMs) || 500);
        let undoStack = [];
        let redoStack = [];
        let usedBytes = 0;
        let sequence = 0;
        let present = captureState(engine);

        function state() {
            return {
                canUndo: undoStack.length > 0,
                canRedo: redoStack.length > 0,
                undoCount: undoStack.length,
                redoCount: redoStack.length,
                bytes: usedBytes,
                maxEntries,
                maxBytes
            };
        }

        function notify(label, action, details = {}) {
            options.onChange?.({ label, action, ...details, history: state() });
        }

        function resizeRecord(record) {
            usedBytes -= record.bytes || 0;
            record.bytes = byteLength(record.before) + byteLength(record.after);
            usedBytes += record.bytes;
        }

        function trim() {
            while (undoStack.length + redoStack.length > maxEntries || usedBytes > maxBytes) {
                const undoOldest = undoStack[0];
                const redoOldest = redoStack.reduce((oldest, item) => !oldest || item.sequence < oldest.sequence ? item : oldest, null);
                const oldest = !undoOldest ? redoOldest : !redoOldest ? undoOldest
                    : undoOldest.sequence < redoOldest.sequence ? undoOldest : redoOldest;
                if (!oldest) break;
                if (undoStack[0] === oldest) undoStack.shift();
                else redoStack.splice(redoStack.indexOf(oldest), 1);
                usedBytes -= oldest.bytes || 0;
                options.onLimit?.({ reason: 'history-trimmed', label: oldest.label, history: state() });
            }
        }

        function record(label, before, after, coalesceKey) {
            // Server status changes are not editable transactions.
            const editable = snapshot => ({ ...snapshot, nodes: snapshot.nodes.map(({ runtimeReferences, ...node }) => node) });
            if (stableStringify(editable(before)) === stableStringify(editable(after))) return false;
            const beforeBytes = byteLength(before);
            const afterBytes = byteLength(after);
            if (beforeBytes + afterBytes > maxBytes) {
                options.onLimit?.({ reason: 'snapshot-too-large', label, history: state() });
                return false;
            }
            redoStack.forEach(item => { usedBytes -= item.bytes || 0; });
            redoStack = [];
            const prior = undoStack[undoStack.length - 1];
            const now = Date.now();
            if (coalesceKey && prior?.coalesceKey === coalesceKey && now - prior.updatedAt <= coalesceMs) {
                prior.after = after;
                prior.updatedAt = now;
                resizeRecord(prior);
            } else {
                const entry = { label, before, after, sequence: ++sequence, coalesceKey: coalesceKey || null, updatedAt: now, bytes: 0 };
                resizeRecord(entry);
                undoStack.push(entry);
            }
            present = after;
            trim();
            return true;
        }

        function restore(snapshot, action, label, counterpart) {
            const current = new Map([...engine.nodes.entries()].map(([id, node]) => [id, node.data || {}]));
            const requiresReconciliation = [];
            const nodes = snapshot.nodes.map(node => {
                const data = clone(node.data || {});
                if (current.has(node.id)) {
                    Object.assign(data, extractCurrentRuntime(current.get(node.id)));
                } else {
                    rehydrateRuntimeReferences(data, node.runtimeReferences);
                    data.generationStatus = Object.keys(node.runtimeReferences || {}).length ? 'unconfirmed' : 'idle';
                    if (Object.keys(node.runtimeReferences || {}).length) requiresReconciliation.push(node.id);
                }
                return { ...node, data };
            });
            // Keep nodes/edges added by completed Provider callbacks outside this edit transaction.
            const editedIds = new Set((counterpart?.nodes || snapshot.nodes).map(node => node.id));
            const targetIds = new Set(nodes.map(node => node.id));
            for (const node of engine.nodes.values()) {
                if (!targetIds.has(node.id) && !editedIds.has(node.id)) {
                    nodes.push(clone(node)); targetIds.add(node.id);
                }
            }
            const connections = clone(snapshot.connections);
            for (const edge of engine.connections) {
                if (!targetIds.has(edge.from) || !targetIds.has(edge.to)) continue;
                if ((counterpart?.connections || snapshot.connections).some(item => item.from === edge.from && item.to === edge.to)) continue;
                if (!connections.some(item => item.from === edge.from && item.to === edge.to)) connections.push({ from: edge.from, to: edge.to });
            }
            const result = engine.applyCommandSnapshot({ ...snapshot, nodes, connections });
            if (!result) return false;
            const details = { ...result, requiresReconciliation };
            options.onRestore?.({ action, label, ...details });
            return details;
        }

        function begin(label, beginOptions = {}) {
            return { label: String(label || '编辑'), before: captureState(engine), coalesceKey: beginOptions.coalesceKey || null };
        }

        function commit(token) {
            if (!token?.before) return false;
            const after = captureState(engine);
            const changed = record(token.label || '编辑', token.before, after, token.coalesceKey);
            present = after;
            if (changed) {
                engine._notifyCanvasGeometryChanged?.('command', { label: token.label || '编辑' });
                notify(token.label || '编辑', 'commit');
            }
            return changed;
        }

        function checkpoint(label = '编辑', checkpointOptions = {}) {
            const after = captureState(engine);
            const changed = record(label, present, after, checkpointOptions.coalesceKey);
            present = after;
            if (changed) {
                engine._notifyCanvasGeometryChanged?.('command', { label });
                notify(label, 'commit');
            }
            return changed;
        }

        function perform(label, operation, performOptions = {}) {
            if (typeof operation !== 'function') throw new TypeError('perform requires a synchronous operation');
            const token = begin(label, performOptions);
            try {
                const result = operation();
                if (result === false || result?.ok === false) return result;
                commit(token);
                return result;
            } catch (error) {
                restore(token.before, 'rollback', label);
                throw error;
            }
        }

        function undo() {
            const entry = undoStack.pop();
            if (!entry) return false;
            usedBytes -= entry.bytes || 0;
            const applied = restore(entry.before, 'undo', entry.label, entry.after);
            if (!applied) {
                undoStack.push(entry);
                usedBytes += entry.bytes || 0;
                return false;
            }
            redoStack.push(entry);
            usedBytes += entry.bytes || 0;
            present = captureState(engine);
            notify(entry.label, 'undo', applied);
            return applied;
        }

        function redo() {
            const entry = redoStack.pop();
            if (!entry) return false;
            usedBytes -= entry.bytes || 0;
            const applied = restore(entry.after, 'redo', entry.label, entry.before);
            if (!applied) {
                redoStack.push(entry);
                usedBytes += entry.bytes || 0;
                return false;
            }
            undoStack.push(entry);
            usedBytes += entry.bytes || 0;
            present = captureState(engine);
            notify(entry.label, 'redo', applied);
            return applied;
        }

        function duplicateSelection(duplicateOptions = {}) {
            const selectedIds = typeof engine.getSelectedNodeIds === 'function'
                ? engine.getSelectedNodeIds() : [...(engine.selectedNodeIds || [])];
            if (!selectedIds.length) return { ok: false, reason: 'empty-selection' };
            const originals = selectedIds.map(id => engine.nodes.get(id)).filter(Boolean);
            if (!originals.length) return { ok: false, reason: 'missing-selection' };
            return perform('复制子图', () => {
                const before = captureState(engine);
                const idMap = new Map();
                const groupIdMap = new Map();
                const offsetX = Number.isFinite(Number(duplicateOptions.offsetX)) ? Number(duplicateOptions.offsetX) : 40;
                const offsetY = Number.isFinite(Number(duplicateOptions.offsetY)) ? Number(duplicateOptions.offsetY) : 40;
                const createdIds = [];
                let nextNumericId = Math.max(1, Number(engine.nextNodeId) || 1);
                originals.forEach(node => {
                    let candidate = `node-${nextNumericId++}`;
                    while (engine.nodes.has(candidate) || [...idMap.values()].includes(candidate)) candidate = `node-${nextNumericId++}`;
                    idMap.set(node.id, candidate);
                });
                originals.forEach(node => {
                    const data = duplicateNodeData(node, idMap, groupIdMap);
                    data.id = idMap.get(node.id);
                    const id = engine.addNodeForCommand(node.type, node.x + offsetX, node.y + offsetY, data);
                    if (!id) throw new Error('复制节点失败');
                    if (id !== idMap.get(node.id)) throw new Error('复制节点编号与预留编号不一致');
                    createdIds.push(id);
                });
                for (const edge of engine.connections) {
                    if (!idMap.has(edge.from) || !idMap.has(edge.to)) continue;
                    if (!engine.connectNodesForCommand(idMap.get(edge.from), idMap.get(edge.to))) {
                        engine.applyCommandSnapshot(before);
                        return { ok: false, reason: 'connection-rejected' };
                    }
                }
                engine.selectNodes?.(createdIds, createdIds[createdIds.length - 1]);
                return { ok: true, createdIds, idMap: Object.fromEntries(idMap) };
            });
        }

        return {
            begin,
            commit,
            checkpoint,
            perform,
            undo,
            redo,
            duplicateSelection,
            clear() {
                undoStack = [];
                redoStack = [];
                usedBytes = 0;
                present = captureState(engine);
                notify('清除历史', 'clear');
            },
            getState: state,
            capture: () => captureState(engine)
        };
    }

    return { createCanvasCommands, captureState, duplicateNodeData };
});
