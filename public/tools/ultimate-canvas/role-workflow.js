(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.UltimateCanvasRoleWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const API = '/api/tools/ultimate-canvas';
    const PHASE_LABELS = {
        offered: '待接收', needs_material: '待补材料', rejected: '未接收', ready: '待处理',
        working: '处理中', review: '待检查', confirmation: '待本人确认', revision: '待修订',
        delivered: '已交付', failed: '处理失败', unknown: '结果待确认', superseded: '已被新版本替代'
    };
    const EVENT_LABELS = {
        offered: '已交办', task_created: '创建本次任务', requirements_changed: '任务要求已更新',
        accept: '已接收', reject: '已拒绝', request_material: '申请补充材料', draft: '保存草稿',
        submit: '提交成果', approve: '检查通过', return: '退回修订', confirm: '确认交付',
        revise: '继续修订', message: '交流', pause: '暂停任务', resume: '继续任务',
        materials_waiting: '等待必交材料', materials_ready: '必交材料已齐', upstream_revision: '上游成果已更新',
        owner_result_available: '最终成果已交给你', execution_started: '已开始执行', execution_finished: '执行回执已更新',
        ai_review_recommendation: 'AI 检查建议', task_limits_changed: '任务限额已更新', branch_retained: '独立分支原成果已保留'
    };

    function create(bridge) {
        if (!bridge || typeof bridge.context !== 'function' || typeof bridge.request !== 'function'
            || !bridge.workRoot || typeof bridge.dialog !== 'function' || typeof bridge.confirm !== 'function') {
            throw new Error('角色工作面板的共享接口尚未就绪');
        }

        const state = {
            open: false, mode: 'role', tab: 'work', selectedNodeId: '', selectedWorkId: '',
            nodes: [], materials: [], runs: [], works: [], detail: null, scope: '', cursor: null,
            loading: false, loadingMore: false, error: '', listController: null, detailController: null,
            sequence: 0, ctx: safeContext(), root: null, modal: null, modalKind: '',
            taskDraft: null, taskDraftDirty: false, taskDraftError: '', taskSaving: false,
            actionDraft: null, actionDraftDirty: false, editorDraft: '', editorDirty: false,
            messageDraft: '', messageDirty: false, pendingMutation: null, pendingNoticeShown: false,
            storageNoticeShown: false, lastFocused: null, activeDeliveryId: '',
            eventCursor: null, loadingEarlier: false, extraEvents: [], loadingWorkHistory: false, loadingAttempts: false,
            editorItems: Object.create(null), editorAttachments: [], editorBaseline: null,
            messageFrom: '', draftMeta: null, draftConflict: false,
            taskConflict: false, actionSaving: false, modalContent: null, modalContext: null,
            drafts: emptyDrafts(), expanded: {}, restoredScope: '',
            billedAttempts: new Set()
        };
        const scopedMemory = new Map();
        const attachmentViews = new WeakMap();
        const previewControllers = new Set();

        function safeContext() {
            try { return bridge.context() || {}; } catch { return {}; }
        }

        function contextKey(ctx) {
            return [ctx?.userId || '', ctx?.projectId || '', ctx?.documentId || '', ctx?.contextEpoch ?? '', ctx?.scopeKey || ''].join('|');
        }

        function sameContext(a, b) { return contextKey(a) === contextKey(b); }
        function currentContext() { return safeContext(); }
        function isCurrent(ctx, sequence) {
            return sameContext(ctx, currentContext()) && sameContext(ctx, state.ctx)
                && (sequence === undefined || sequence === state.sequence);
        }

        function el(tag, className, text) {
            const item = document.createElement(tag);
            if (className) item.className = className;
            if (text !== undefined && text !== null) item.textContent = String(text);
            return item;
        }

        function icon(name) {
            const registryName = String(name || '').split('-').map(part => part ? part[0].toUpperCase() + part.slice(1) : '').join('');
            const registered = { FileText: 'ScrollText', Paperclip: 'Link', BadgeCheck: 'Check', CornerUpLeft: 'Undo2',
                Save: 'ClipboardList', ArrowRight: 'ArrowUpRight' };
            try { return typeof bridge.icon === 'function' ? bridge.icon(registered[registryName] || registryName) : ''; } catch { return ''; }
        }

        function setIcon(button, name) {
            const markup = icon(name);
            if (markup) button.innerHTML = markup;
        }

        function parseJson(value, fallback) {
            if (value && typeof value === 'object') return value;
            if (typeof value !== 'string' || !value) return fallback;
            try {
                const parsed = JSON.parse(value);
                return parsed && typeof parsed === 'object' ? parsed : fallback;
            } catch { return fallback; }
        }

        function isRecord(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
        function clean(value) { return typeof value === 'string' ? value.trim() : ''; }
        function textOf(value, fallback) { return clean(value) || fallback || ''; }
        function numberOf(value) {
            if (value == null || value === '') return null;
            const next = Number(value); return Number.isFinite(next) ? next : null;
        }
        function finiteInteger(value, min, max) {
            if (value == null || value === '') return null;
            const next = Number(value);
            return Number.isSafeInteger(next) && next >= min && next <= max ? next : null;
        }
        function scaledAmount(value, scale, max) {
            const amount = numberOf(value);
            if (amount === null || amount < 0 || amount > max) return null;
            const scaled = amount * scale, rounded = Math.round(scaled);
            return Number.isSafeInteger(rounded) && Math.abs(scaled - rounded) <= 0.00001 ? rounded : null;
        }
        function formatPoints(value) {
            const amount = numberOf(value);
            return amount === null || amount < 0 ? '金额待核对' : amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }
        function mutationId() {
            if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
            return 'role-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 18);
        }

        function apiUrl(path, params) {
            const query = params ? '?' + new URLSearchParams(params).toString() : '';
            return API + path + query;
        }

        function normalizeError(error) {
            if (error && typeof error === 'object') {
                const data = error.data || error.body || {};
                const message = data.error || data.message || error.message;
                return Object.assign(new Error(textOf(message, '操作失败，请保留当前内容后重试')), {
                    status: Number(error.status) || 0, data, code: data.code || error.code || ''
                });
            }
            return new Error(textOf(error, '操作失败，请保留当前内容后重试'));
        }

        async function requestJson(url, options) {
            const response = await bridge.request(url, options || {});
            if (response && typeof response === 'object' && Number(response.status) >= 400) {
                throw normalizeError(response);
            }
            if (response && response.error && response.data) throw normalizeError(response);
            return response;
        }

        function storageKey(ctx) {
            const scope = typeof ctx?.scopeKey === 'string' ? ctx.scopeKey : '';
            if (!ctx?.userId || !ctx?.documentId || !scope) return '';
            return 'ultimate-canvas:role-workflow:v2:' + encodeURIComponent([ctx.userId, ctx.projectId || '', ctx.documentId, scope].join('|'));
        }

        function validId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value); }
        function copyJson(value) { return JSON.parse(JSON.stringify(value)); }
        function emptyDrafts() { return { works: Object.create(null), tasks: Object.create(null), actions: Object.create(null) }; }
        function validMeta(meta) {
            return isRecord(meta) && validId(meta.workId) && validId(meta.runId)
                && finiteInteger(meta.workRevision, 0, Number.MAX_SAFE_INTEGER) !== null
                && finiteInteger(meta.requirementsRevision, 1, Number.MAX_SAFE_INTEGER) !== null
                && typeof meta.inputDigest === 'string' && meta.inputDigest.length <= 160
                && (meta.deliveryId == null || validId(meta.deliveryId));
        }
        function boundedItems(items) {
            const result = Object.create(null);
            if (!isRecord(items)) return result;
            Object.entries(items).slice(0, 100).forEach(([name, value]) => {
                if (name.length <= 160 && typeof value === 'string' && value.length <= 16000) result[name] = value;
            });
            return result;
        }
        function attachmentSelection(value) {
            if (!isRecord(value)) return null;
            if (validId(value.sourceDeliveryId) && !value.nodeId && finiteInteger(value.index, 0, 19) !== null) {
                return { sourceDeliveryId: value.sourceDeliveryId, index: Number(value.index) };
            }
            if (!validId(value.nodeId) || value.sourceDeliveryId) return null;
            const selection = { nodeId: value.nodeId };
            if (typeof value.sourceDigest === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value.sourceDigest)) selection.sourceDigest = value.sourceDigest;
            return selection;
        }
        function attachmentKey(value) {
            return value.sourceDeliveryId ? 'delivery:' + value.sourceDeliveryId + ':' + value.index : 'node:' + value.nodeId;
        }
        function attachmentSelections(value) {
            const seen = new Set();
            return recordList(value).slice(0, 20).map(attachmentSelection).filter(item => item && !seen.has(attachmentKey(item)) && seen.add(attachmentKey(item)));
        }
        function attachmentSnapshot(value) {
            if (!isRecord(value)) return null;
            const selection = attachmentSelection(value.selection);
            if (!selection) return null;
            const snapshot = { selection, title: typeof value.title === 'string' ? value.title.slice(0, 1000) : '',
                type: typeof value.type === 'string' ? value.type.slice(0, 80) : '' };
            if (value.sourceKind === 'canvas_text') snapshot.sourceKind = 'canvas_text';
            ['nodeId', 'assetId', 'referenceImageId', 'taskId'].forEach(key => { if (validId(value[key])) snapshot[key] = value[key]; });
            if (typeof value.sourceDigest === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value.sourceDigest)) snapshot.sourceDigest = value.sourceDigest;
            return snapshot;
        }
        function savedEditorContent(value) {
            const content = parseJson(value, {});
            return { text: typeof content.text === 'string' ? content.text.slice(0, 100000) : '', items: boundedItems(content.items),
                attachments: recordList(content.attachments).slice(0, 20).map(attachmentSnapshot).filter(Boolean) };
        }
        function validPending(value, ctx) {
            const kinds = ['task_create', 'task_update', 'work_action', 'work_execute'];
            if (!isRecord(value) || !validId(value.mutationId) || !kinds.includes(value.kind)
                || (value.workId && !validId(value.workId))) return null;
            if (!value.url && !value.method && !value.payload) return { mutationId: value.mutationId, kind: value.kind,
                workId: value.workId || '', receiptOnly: true };
            if (typeof value.url !== 'string' || !isRecord(value.payload) || value.payload.mutation_id !== value.mutationId) return null;
            let expected;
            if (value.kind === 'task_create') expected = API + '/role-runs';
            else if (value.kind === 'task_update' && validId(value.url.split('/').pop())) expected = API + '/role-runs/' + value.url.split('/').pop();
            else if (validId(value.workId)) expected = API + '/role-work/' + encodeURIComponent(value.workId) + (value.kind === 'work_execute' ? '/execute' : '');
            if (!expected || value.url !== expected || value.method !== (value.kind === 'task_update' ? 'PATCH' : 'POST')) return null;
            if (value.kind.startsWith('task_') && value.payload.document_id !== ctx.documentId) return null;
            if (value.draftKey && (!value.kind.startsWith('task_') || typeof value.draftKey !== 'string'
                || (value.kind === 'task_update' ? value.draftKey !== value.url.split('/').pop()
                    : !value.draftKey.startsWith('new:') || !validId(value.draftKey.slice(4))))) return null;
            if (JSON.stringify(value.payload).length > 2 * 1024 * 1024) return null;
            return copyJson(value);
        }

        function sanitizeDrafts(raw) {
            const drafts = emptyDrafts();
            const fresh = item => isRecord(item) && finiteInteger(item.updatedAt, 0, Number.MAX_SAFE_INTEGER) !== null;
            Object.entries(isRecord(raw?.works) ? raw.works : {}).forEach(([id, item]) => {
                if (!validId(id) || !fresh(item) || !validMeta(item.meta) || item.meta.workId !== id
                    || typeof item.editorText !== 'string' || item.editorText.length > 100000
                    || typeof item.messageText !== 'string' || item.messageText.length > 16000) return;
                drafts.works[id] = { meta: copyJson(item.meta), editorText: item.editorText, items: boundedItems(item.items),
                    attachments: attachmentSelections(item.attachments), baseline: item.baseline ? savedEditorContent(item.baseline) : null,
                    messageText: item.messageText, messageFrom: validId(item.messageFrom) ? item.messageFrom : '',
                    editorDirty: item.editorDirty === true, messageDirty: item.messageDirty === true, updatedAt: Number(item.updatedAt) };
            });
            Object.entries(isRecord(raw?.tasks) ? raw.tasks : {}).forEach(([key, item]) => {
                if (!fresh(item) || !isRecord(item.draft)) return;
                const draft = item.draft;
                if ((draft.runId && !validId(draft.runId)) || !validId(draft.nodeId)
                    || key !== (draft.runId || 'new:' + draft.nodeId)
                    || finiteInteger(draft.baseRevision, 0, Number.MAX_SAFE_INTEGER) === null
                    || typeof draft.goal !== 'string' || draft.goal.length > 32000
                    || typeof draft.criteria !== 'string' || draft.criteria.length > 16000 || !validId(draft.finalNodeId)
                    || !Array.isArray(draft.participants) || draft.participants.length > 100
                    || draft.participants.some(p => !isRecord(p) || !validId(p.nodeId) || !['required', 'optional', 'excluded'].includes(p.participation))) return;
                const value = copyJson(draft);
                value.participants = draft.participants.map(cloneParticipant);
                value.refresh_materials = draft.refresh_materials === true;
                value.materialNodes = recordList(draft.materialNodes).filter(validId).slice(0, 100);
                ['max_rounds', 'max_calls', 'wait_limit_seconds', 'budget_points_limit', 'budget_usd'].forEach(field => {
                    value[field] = typeof draft[field] === 'string' && draft[field].length <= 30 ? draft[field] : '';
                });
                drafts.tasks[key] = { draft: value, updatedAt: Number(item.updatedAt) };
            });
            Object.entries(isRecord(raw?.actions) ? raw.actions : {}).forEach(([key, item]) => {
                if (!fresh(item) || !validMeta(item.meta) || !['work-return', 'work-reject', 'work-request-material'].includes(item.kind)
                    || key !== item.meta.workId + ':' + item.kind || typeof item.value !== 'string' || item.value.length > 16000) return;
                drafts.actions[key] = copyJson(item);
            });
            return drafts;
        }

        function readStored(ctx) {
            const key = storageKey(ctx);
            if (!key) return {};
            try {
                const legacyKey = 'ultimate-canvas:role-workflow:v1:' + ctx.scopeKey.slice(0, 240);
                const value = parseJson(scopedMemory.get(key) || localStorage.getItem(key) || localStorage.getItem(legacyKey), {});
                if (!isRecord(value) || ![1, 2].includes(value.version)) return {};
                const expanded = {};
                Object.entries(isRecord(value.expanded) ? value.expanded : {}).slice(0, 100).forEach(([name, open]) => {
                    if (/^[A-Za-z0-9:_-]{1,200}$/.test(name) && typeof open === 'boolean') expanded[name] = open;
                });
                return {
                    selectedNodeId: validId(value.selectedNodeId) ? value.selectedNodeId : '',
                    selectedWorkId: validId(value.selectedWorkId) ? value.selectedWorkId : '',
                    tab: ['work', 'talk', 'history'].includes(value.tab) ? value.tab : 'work',
                    pendingMutation: validPending(value.pendingMutation, ctx), expanded,
                    drafts: sanitizeDrafts(value.drafts)
                };
            } catch { return {}; }
        }

        function writeStored(ctx, value) {
            const key = storageKey(ctx);
            if (!key) return;
            const serialized = JSON.stringify(Object.assign({ version: 2 }, value));
            scopedMemory.set(key, serialized);
            try { localStorage.setItem(key, serialized); }
            catch {
                if (sameContext(ctx, state.ctx) && !state.storageNoticeShown) {
                    state.storageNoticeShown = true;
                    bridge.notice?.('草稿暂时只能保留在当前页；请勿关闭后再继续。', 'info');
                }
            }
        }

        function captureDrafts() {
            const now = Date.now();
            if (state.draftMeta && (state.editorDirty || state.messageDirty)) {
                state.drafts.works[state.draftMeta.workId] = { meta: copyJson(state.draftMeta), editorText: state.editorDraft,
                    items: copyJson(state.editorItems), attachments: copyJson(state.editorAttachments), baseline: copyJson(state.editorBaseline),
                    messageText: state.messageDraft, messageFrom: state.messageFrom,
                    editorDirty: state.editorDirty, messageDirty: state.messageDirty, updatedAt: now };
            }
            if (state.taskDraft && state.taskDraftDirty) state.drafts.tasks[taskDraftKey(state.taskDraft)] = { draft: copyJson(state.taskDraft), updatedAt: now };
            if (state.actionDraft?.meta && state.actionDraftDirty) state.drafts.actions[state.actionDraft.meta.workId + ':' + state.actionDraft.kind] = {
                ...copyJson(state.actionDraft), updatedAt: now };
        }

        function persistView() {
            captureDrafts();
            writeStored(state.ctx, {
                selectedNodeId: state.selectedNodeId,
                selectedWorkId: state.selectedWorkId,
                tab: state.tab,
                pendingMutation: state.pendingMutation, drafts: state.drafts, expanded: state.expanded
            });
        }

        function clearPendingMutation(ctx, pending) {
            if (!pending) return;
            if (sameContext(ctx, state.ctx) && state.pendingMutation?.mutationId === pending.mutationId) {
                state.pendingMutation = null; persistView(); updatePendingControls();
            } else {
                const stored = readStored(ctx);
                if (stored.pendingMutation?.mutationId === pending.mutationId) writeStored(ctx, { ...stored, pendingMutation: null });
            }
        }

        function currentMutationDescriptor() {
            const item = state.pendingMutation;
            if (!item || !item.mutationId) return null;
            return item;
        }

        async function recoverReceipt(ctx, descriptor) {
            const pending = descriptor || currentMutationDescriptor();
            if (!pending || !isCurrent(ctx)) return null;
            try {
                const receipt = await requestJson(apiUrl('/role-receipts/' + encodeURIComponent(pending.mutationId)), { method: 'GET' });
                if (receipt && receipt.mutation_id === pending.mutationId) {
                    clearPendingMutation(ctx, pending);
                    return isCurrent(ctx) ? receipt : null;
                }
            } catch (error) {
                const normalized = normalizeError(error);
                if (isCurrent(ctx) && normalized.status !== 404 && !state.pendingNoticeShown) {
                    state.pendingNoticeShown = true;
                    bridge.notice?.('原操作回执暂不可读；不会自动重发。可稍后查询同一编号。', 'warning');
                }
            }
            return null;
        }

        async function sendMutation(url, payload, kind, workId) {
            const ctx = currentContext();
            if (!isCurrent(ctx) || ctx.writable === false) throw new Error('画布正在切换或当前不可编辑；原输入已保留，未发送操作。');
            if (state.pendingMutation) throw new Error('原操作结果尚未确认，请先查询原回执；当前输入已保留。');
            const id = payload.mutation_id || mutationId();
            const body = copyJson(Object.assign({}, payload, { mutation_id: id }));
            const method = kind === 'task_update' ? 'PATCH' : 'POST';
            const pending = { mutationId: id, kind, workId: workId || '', url, method, payload: copyJson(body) };
            if (kind.startsWith('task_') && state.taskDraft) pending.draftKey = taskDraftKey(state.taskDraft);
            if (!validPending(pending, ctx)) throw new Error('操作目标与当前画布不匹配，未发送请求。');
            state.pendingMutation = pending;
            state.pendingNoticeShown = false;
            persistView(); updatePendingControls();
            try {
                const result = await requestJson(url, { method, payload: body });
                if (result && result.mutation_id === id) clearPendingMutation(ctx, pending);
                if (!isCurrent(ctx)) return null;
                if (!result || result.mutation_id !== id) throw Object.assign(new Error('接口未确认原请求编号，请查原回执。'), { code: 'role_operation_unconfirmed' });
                return result;
            } catch (error) {
                const normalized = normalizeError(error);
                const uncertain = !normalized.status || normalized.status >= 500 || normalized.status === 408 || normalized.status === 429
                    || ['write_conflict', 'mutation_conflict'].includes(normalized.code);
                if (!uncertain) {
                    clearPendingMutation(ctx, pending);
                    throw normalized;
                }
                const receipt = await recoverReceipt(ctx, pending);
                if (receipt) return receipt;
                const unresolved = new Error('操作结果尚未确认。已保留原请求编号，不会自动重发；请使用“查询原回执”。');
                unresolved.code = 'role_operation_unconfirmed';
                unresolved.mutationId = id;
                throw unresolved;
            }
        }

        function roleConfig(node) {
            const config = parseJson(node?.roleConfig || node?.data?.roleConfig, {});
            const snapshot = parseJson(config.snapshot || config.role || config, {});
            return { config, snapshot };
        }

        function nodeTitle(node) {
            const role = roleConfig(node).snapshot;
            return textOf(node?.title || node?.data?.title || role.name, '未命名角色');
        }

        function selectedNode() { return state.nodes.find(node => node.id === state.selectedNodeId) || null; }
        function runForWork(work) { return state.runs.find(run => run.id === work?.role_task_run_id) || null; }
        function worksForRun(runId) { return state.works.filter(work => work.role_task_run_id === runId); }
        function currentDetail() { return state.detail && state.detail.work?.id === state.selectedWorkId ? state.detail : null; }
        function taskUpdateAvailable(detail) {
            return Boolean(state.ctx.writable !== false && detail?.summary?.task_update_available === true
                && detail.work?.requirements_revision === detail.run?.requirements_revision);
        }
        function taskControlAvailable(detail) {
            return Boolean(state.ctx.writable !== false && detail?.summary?.task_control_available === true);
        }

        function workMeta(detail) {
            const work = detail?.work;
            if (!work || !detail.run) return null;
            return { workId: work.id, runId: detail.run.id, workRevision: Number(work.revision),
                requirementsRevision: Number(work.requirements_revision), inputDigest: textOf(detail.input_digest, ''),
                deliveryId: work.current_delivery_id || null };
        }

        function matchesMeta(meta, detail) {
            const actual = workMeta(detail);
            return Boolean(meta && actual && meta.workId === actual.workId && meta.runId === actual.runId
                && meta.workRevision === actual.workRevision && meta.requirementsRevision === actual.requirementsRevision
                && meta.inputDigest === actual.inputDigest && (meta.deliveryId || null) === actual.deliveryId);
        }

        function taskDraftKey(draft) { return draft.runId || 'new:' + draft.nodeId; }

        function restoreWorkDraft(detail) {
            const meta = workMeta(detail);
            if (!meta) return;
            const saved = state.drafts.works[meta.workId];
            if (saved) {
                state.draftMeta = copyJson(saved.meta); state.editorDraft = saved.editorText;
                state.editorItems = copyJson(saved.items); state.messageDraft = saved.messageText;
                state.editorAttachments = attachmentSelections(saved.attachments);
                state.editorBaseline = saved.baseline ? savedEditorContent(saved.baseline) : savedEditorContent({});
                state.messageFrom = saved.messageFrom; state.editorDirty = saved.editorDirty;
                state.messageDirty = saved.messageDirty; state.draftConflict = !matchesMeta(saved.meta, detail);
            } else {
                const baseline = savedEditorContent(detail.draft_content || { text: detail.work.draft_text });
                state.draftMeta = meta; state.editorDraft = baseline.text; state.editorItems = copyJson(baseline.items);
                state.editorBaseline = baseline; state.editorAttachments = attachmentSelections(baseline.attachments.map(item => item.selection));
                state.messageDraft = ''; state.messageFrom = '';
                state.editorDirty = false; state.messageDirty = false; state.draftConflict = false;
            }
            if (state.taskDraft?.runId === detail.run.id) state.taskConflict = state.taskDraft.baseRevision !== Number(detail.run.revision);
            syncDialogConflict(detail);
        }

        function syncDialogConflict(detail) {
            const content = state.modalContent;
            if (!content || !isCurrent(state.modalContext)) return;
            const kind = state.modalKind === 'task' && state.taskDraft?.runId === detail.run.id ? 'task'
                : state.actionDraft?.kind === state.modalKind ? 'action' : '';
            if (!kind) return;
            const conflict = kind === 'task' ? state.taskConflict : !matchesMeta(state.actionDraft.meta, detail);
            if (conflict && !content.querySelector('.crw-draft-conflict')) content.querySelector('h2')?.after(renderDraftConflict(kind));
            content.querySelectorAll('[data-action="save-task"], [data-action="submit-text-action"]').forEach(submit => {
                submit.disabled = conflict || state.taskSaving || state.actionSaving;
            });
        }

        function restoreScope(ctx) {
            const stored = readStored(ctx);
            state.ctx = ctx; state.restoredScope = contextKey(ctx);
            state.pendingMutation = stored.pendingMutation || null; state.drafts = stored.drafts || emptyDrafts();
            state.expanded = stored.expanded || {}; state.tab = stored.tab || 'work';
            state.selectedNodeId = stored.selectedNodeId || ''; state.selectedWorkId = stored.selectedWorkId || '';
            return stored;
        }

        function assertWorkUnchanged(ctx, meta) {
            if (!state.open || !isCurrent(ctx) || !matchesMeta(meta, currentDetail())) throw new Error('画布或工作版本已变化；原输入仍是草稿，请读取最新版本后明确选择如何处理。');
        }

        function notifyBillingSettled(result, attemptId) {
            if (!(result?.settlement_applied === true || ['confirmed', 'cash_only', 'not_sent'].includes(result?.fee_state))) return;
            const key = attemptId || result.attemptId || result.id;
            if (!key || state.billedAttempts.has(key)) return;
            state.billedAttempts.add(key);
            try { bridge.onBillingSettled?.(); } catch { /* Billing acknowledgement must not alter the saved result. */ }
        }

        function renderDraftConflict(kind) {
            const box = el('aside', 'crw-draft-conflict');
            box.append(panelMessage('草稿对应的工作或任务版本已变化；原文字保留，不能直接提交到新版本。', 'warning'));
            [['读取最新', 'draft-read-latest', 'refresh-cw'], ['复制草稿', 'draft-copy', 'copy'],
                ['用于当前版本', 'draft-use-current', 'check'], ['放弃草稿', 'draft-discard', 'trash-2']].forEach(([label, action, name]) => {
                const control = button(label, action, '', name); control.dataset.draftKind = kind; box.append(control);
            });
            return box;
        }

        async function resolveDraft(target) {
            const kind = target.dataset.draftKind, ctx = currentContext(), detail = currentDetail();
            const meta = workMeta(detail), task = state.taskDraft, actionDraft = state.actionDraft;
            if (target.dataset.action === 'draft-copy') {
                const value = kind === 'task' ? JSON.stringify(task, null, 2) : kind === 'action' ? actionDraft?.value || ''
                    : [state.editorDraft, JSON.stringify(state.editorItems, null, 2), JSON.stringify(state.editorAttachments, null, 2), state.messageDraft].join('\n\n');
                try {
                    await navigator.clipboard.writeText(value);
                    if (isCurrent(ctx)) bridge.notice?.('草稿已复制。', 'success');
                } catch {
                    if (!isCurrent(ctx)) return;
                    const content = el('div', 'crw-dialog-content');
                    content.append(el('h2', 'crw-dialog-title', '原草稿'));
                    const input = el('textarea', 'crw-textarea'); input.readOnly = true; input.value = value; input.rows = 12;
                    input.setAttribute('aria-label', '可复制的原草稿'); content.append(input, button('关闭', 'dialog-readonly-close', 'primary'));
                    openModal('copy', content); input.select();
                }
                return;
            }
            if (kind === 'task' && task?.runId && task.runId !== detail?.run?.id) {
                throw new Error('原草稿对应另一项已保存任务。请从该任务的参与角色重新打开后处理；当前文字保留，可先复制。');
            }
            if (target.dataset.action === 'draft-read-latest') {
                persistView(); await refresh();
                if (!isCurrent(ctx) || state.selectedWorkId !== meta?.workId) return;
                if (kind === 'task') appendTaskDialog(currentDetail()?.run);
                else if (kind === 'action' && state.actionDraft === actionDraft) {
                    showTextDialog(actionDraft.kind, actionDraft.kind === 'work-return' ? '退回修订' : actionDraft.kind === 'work-reject' ? '拒绝本次任务' : '申请补充材料', '原草稿保留；请核对最新工作版本。', true, '提交');
                }
                return;
            }
            if (target.dataset.action === 'draft-use-current') {
                if (!await bridge.confirm({ title: '用于当前版本？', message: '请先核对已读取的最新工作。保留原文字，但改用当前任务、成果与材料版本；不会自动提交。', confirmText: '采用当前版本' })) return;
                if (!isCurrent(ctx) || !matchesMeta(meta, currentDetail())) return;
                if (kind === 'task' && state.taskDraft === task) {
                    task.baseRevision = Number(currentDetail().run.revision); task.requirementsRevision = meta.requirementsRevision;
                    state.taskConflict = false; state.taskDraftDirty = true; persistView(); appendTaskDialog(currentDetail().run);
                } else if (kind === 'action' && state.actionDraft === actionDraft) {
                    actionDraft.meta = copyJson(meta); state.actionDraftDirty = true; persistView();
                    showTextDialog(actionDraft.kind, actionDraft.kind === 'work-return' ? '退回修订' : actionDraft.kind === 'work-reject' ? '拒绝本次任务' : '申请补充材料', '已明确采用当前版本，原文字未提交。', true, '提交');
                } else if (kind === 'work') {
                    state.draftMeta = copyJson(meta); state.draftConflict = false; persistView(); render();
                }
                return;
            }
            if (!await bridge.confirm({ title: '放弃原草稿？', message: '原未提交文字将移除，随后读取当前服务器版本。可先复制留存。', confirmText: '放弃草稿' })) return;
            if (!isCurrent(ctx) || !matchesMeta(meta, currentDetail())) return;
            if (kind === 'task' && state.taskDraft === task) {
                delete state.drafts.tasks[taskDraftKey(task)]; state.taskDraft = null; state.taskDraftDirty = false;
                state.taskConflict = false; openTaskDialog(task.runId ? currentDetail().run : null);
            } else if (kind === 'action' && state.actionDraft === actionDraft) {
                delete state.drafts.actions[actionDraft.meta.workId + ':' + actionDraft.kind];
                state.actionDraft = null; state.actionDraftDirty = false; closeModal();
            } else if (kind === 'work') {
                delete state.drafts.works[meta.workId]; state.editorDirty = false; state.messageDirty = false;
                restoreWorkDraft(currentDetail()); render();
            }
            persistView();
        }

        function ensureRoot() {
            bridge.workRoot.hidden = !state.open;
            if (state.root && state.root.isConnected) return state.root;
            const host = bridge.workRoot;
            if (!host || typeof host.append !== 'function') throw new Error('当前画布没有角色工作面板位置');
            state.root = el('section', 'crw-root');
            state.root.setAttribute('aria-label', '角色工作面板');
            state.root.setAttribute('data-ultimate-canvas-role-workflow', '');
            bindEvents(state.root);
            host.append(state.root);
            return state.root;
        }

        function bindEvents(surface) {
            if (surface.dataset.crwBound === 'true') return;
            surface.dataset.crwBound = 'true';
            surface.addEventListener('click', handleClick);
            surface.addEventListener('input', handleInput);
            surface.addEventListener('change', handleChange);
            surface.addEventListener('keydown', handleKeydown);
            surface.addEventListener('toggle', handleToggle, true);
        }

        function isEventSurface(target) {
            return Boolean(target && sameContext(state.ctx, currentContext()) && (state.root?.contains(target)
                || (state.modalContent?.contains(target) && sameContext(state.modalContext, currentContext()))));
        }

        function rememberDetails(details, key) {
            details.dataset.expandedKey = key;
            details.open = state.expanded[key] === true;
            return details;
        }

        function handleToggle(event) {
            const details = event.target;
            if (!isEventSurface(details) || !details.matches?.('details')) return;
            if (details.dataset.expandedKey) { state.expanded[details.dataset.expandedKey] = details.open; persistView(); }
            if (details.dataset.dependencies && details.open && state.taskDraft) buildDependencies(details, state.taskDraft);
        }

        function button(label, action, variant, iconName, ariaLabel) {
            const item = el('button', 'crw-button' + (variant ? ' crw-button--' + variant : ''));
            item.type = 'button';
            item.dataset.action = action;
            if (ariaLabel) item.setAttribute('aria-label', ariaLabel);
            if (iconName) setIcon(item, iconName);
            item.append(document.createTextNode(label));
            return item;
        }

        function actionIcon(name, action, label) {
            const item = el('button', 'crw-icon-button');
            item.type = 'button'; item.dataset.action = action;
            item.setAttribute('aria-label', label); item.title = label;
            setIcon(item, name);
            return item;
        }

        function panelMessage(message, tone) {
            const item = el('p', 'crw-message' + (tone ? ' crw-message--' + tone : ''), message);
            item.setAttribute('role', tone === 'error' ? 'alert' : 'status');
            return item;
        }

        function addTime(parent, iso) {
            if (!iso || typeof bridge.renderTime !== 'function') return;
            const wrapper = el('span', 'crw-time');
            try {
                const markup = bridge.renderTime(iso);
                if (typeof markup === 'string') wrapper.innerHTML = markup;
                else if (markup instanceof Node) wrapper.append(markup);
            } catch { /* Missing or invalid times do not break the work panel. */ }
            if (wrapper.childNodes.length) parent.append(wrapper);
        }

        function displayPhase(phase) { return PHASE_LABELS[phase] || '状态待同步'; }
        function recordList(value) { return Array.isArray(value) ? value : []; }

        function normalizeWorkList(result) {
            return recordList(result?.works).filter(item => isRecord(item) && typeof item.id === 'string');
        }

        function hasUnsaved() {
            return state.editorDirty || state.messageDirty || state.taskDraftDirty || state.actionDraftDirty;
        }

        function clearTransientDrafts() {
            state.taskDraft = null; state.taskDraftDirty = false; state.taskDraftError = ''; state.taskSaving = false;
            state.actionDraft = null; state.actionDraftDirty = false;
            state.editorDraft = ''; state.editorDirty = false;
            state.messageDraft = ''; state.messageDirty = false;
            state.editorItems = Object.create(null); state.editorAttachments = []; state.editorBaseline = null;
            state.messageFrom = ''; state.draftMeta = null;
            state.draftConflict = false; state.taskConflict = false; state.actionSaving = false;
            state.loadingEarlier = false; state.loadingWorkHistory = false; state.loadingAttempts = false;
        }

        async function confirmDiscard(reason) {
            if (!hasUnsaved()) return true;
            const ctx = currentContext(); persistView();
            const leave = await bridge.confirm({ title: '保留草稿并离开？',
                message: '未提交内容会保留在当前账号和画布的草稿中，重新打开后可继续编辑。',
                confirmText: '保留草稿并离开' });
            return Boolean(leave && isCurrent(ctx));
        }

        function abortReads() {
            state.sequence += 1;
            state.listController?.abort(); state.detailController?.abort();
            state.listController = null; state.detailController = null;
            state.loadingAttempts = false; state.loadingWorkHistory = false; state.loadingEarlier = false;
        }

        async function loadNodes(ctx) {
            const [roles, materials] = await Promise.all([
                Promise.resolve().then(() => bridge.listRoleNodes()),
                Promise.resolve().then(() => bridge.listMaterialNodes())
            ]);
            if (!isCurrent(ctx)) return false;
            state.nodes = recordList(roles).filter(item => item && typeof item.id === 'string' && item.type !== 'flow-role');
            state.materials = recordList(materials).filter(item => item && typeof item.id === 'string' && item.type !== 'role' && !String(item.type || '').startsWith('flow-'));
            return true;
        }

        async function fetchDetail(workId, ctx, sequence, appendEvents) {
            if (!workId) { state.detail = null; return; }
            state.detailController?.abort();
            const controller = new AbortController(); state.detailController = controller;
            const params = {};
            if (appendEvents && state.eventCursor) params.cursor = state.eventCursor;
            try {
                const result = await requestJson(apiUrl('/role-work/' + encodeURIComponent(workId), params), { method: 'GET', signal: controller.signal });
                if (!isCurrent(ctx, sequence) || controller.signal.aborted) return;
                const next = isRecord(result) ? result : {};
                if (next.work?.id !== workId || next.run?.document_id !== ctx.documentId) throw new Error('工作不属于当前画布，未恢复到当前面板。');
                if (state.detail?.work?.id === workId) {
                    const fresh = new Map(recordList(next.attempts).map(attempt => [attempt.id, attempt]));
                    next.attempts = mergeById(next.attempts, state.detail.attempts).map(attempt => fresh.get(attempt.id) || attempt);
                }
                if (appendEvents && state.detail?.work?.id === workId) {
                    const oldEvents = recordList(state.detail.events);
                    const merged = [...recordList(next.events), ...oldEvents, ...state.extraEvents];
                    const seen = new Set();
                    next.events = merged.filter(item => item && !seen.has(item.id) && seen.add(item.id));
                    state.extraEvents = [];
                }
                state.detail = next;
                state.eventCursor = textOf(next.next_cursor, '') || null;
                restoreWorkDraft(next);
                recordList(next.attempts).forEach(attempt => notifyBillingSettled(attempt, attempt.id));
                if (!state.detail?.run) state.error = '任务信息暂不可用，请刷新后重试。';
            } catch (error) {
                if (controller.signal.aborted || !isCurrent(ctx, sequence)) return;
                state.detail = null;
                state.error = normalizeError(error).message;
            }
        }

        async function loadPage(options) {
            const append = Boolean(options?.append);
            const ctx = currentContext();
            if (state.restoredScope !== contextKey(ctx)) { await contextChanged(); return; }
            if (!ctx.userId || !ctx.documentId) {
                state.ctx = ctx; state.loading = false; state.detail = null; state.runs = []; state.works = [];
                state.error = '请先打开本人可编辑的画布。'; render(); return;
            }
            abortReads();
            const sequence = state.sequence;
            const controller = new AbortController(); state.listController = controller;
            state.ctx = ctx; state.loading = !append; state.loadingMore = append; state.error = '';
            if (!append) render();
            try {
                if (!await loadNodes(ctx) || !isCurrent(ctx, sequence)) return;
                const params = { document_id: ctx.documentId, view: state.mode === 'pending' ? 'pending' : 'all' };
                if (append && state.cursor) params.cursor = state.cursor;
                const result = await requestJson(apiUrl('/role-work', params), { method: 'GET', signal: controller.signal });
                if (!isCurrent(ctx, sequence) || controller.signal.aborted) return;
                const newRuns = recordList(result?.runs);
                const newWorks = normalizeWorkList(result);
                state.runs = append ? mergeById(state.runs, newRuns) : newRuns;
                state.works = append ? mergeById(state.works, newWorks) : newWorks;
                state.scope = textOf(result?.scope, '');
                state.cursor = textOf(result?.next_cursor, '') || null;

                if (state.mode === 'pending' && !state.selectedWorkId) {
                    const firstPending = state.works.find(item => !['delivered', 'superseded'].includes(item.phase));
                    state.selectedWorkId = firstPending?.id || '';
                }
                if (state.mode === 'role' && state.selectedNodeId && !state.selectedWorkId) {
                    const matching = state.works.find(item => item.node_id === state.selectedNodeId);
                    if (matching) state.selectedWorkId = matching.id;
                }
                if (state.mode === 'role' && state.selectedNodeId && !state.selectedWorkId && !state.nodes.some(node => node.id === state.selectedNodeId)) {
                    state.selectedNodeId = '';
                    state.selectedWorkId = '';
                    state.detail = null;
                    state.error = '这个角色已不在当前画布。你仍可从画布重新选择角色。';
                }
                if (state.selectedWorkId) await fetchDetail(state.selectedWorkId, ctx, sequence, false);
                if (!isCurrent(ctx, sequence)) return;
                state.loading = false; state.loadingMore = false;
                if (isCurrent(ctx, sequence)) { persistView(); render(); }
            } catch (error) {
                if (controller.signal.aborted || !isCurrent(ctx, sequence)) return;
                state.loading = false; state.loadingMore = false;
                state.error = normalizeError(error).message;
                render();
            }
        }

        function mergeById(oldRows, newRows) {
            const rows = new Map();
            [...recordList(oldRows), ...recordList(newRows)].forEach(item => { if (item?.id) rows.set(item.id, item); });
            return [...rows.values()];
        }

        function selectedWorkOptions() {
            if (state.mode !== 'role' || !state.selectedNodeId) return [];
            const rows = state.works.filter(item => item.node_id === state.selectedNodeId);
            const selected = currentDetail()?.work;
            if (selected?.node_id === state.selectedNodeId && !rows.some(item => item.id === selected.id)) rows.unshift(selected);
            return rows;
        }

        async function loadSelectedDetail() {
            const ctx = currentContext(), sequence = state.sequence;
            const workId = state.selectedWorkId;
            if (!workId) { state.detail = null; render(); return; }
            await fetchDetail(workId, ctx, sequence, false);
            if (isCurrent(ctx, sequence) && state.selectedWorkId === workId) render();
        }

        async function refresh() {
            if (!state.open) return;
            persistView();
            state.eventCursor = null; state.extraEvents = [];
            await loadPage({ append: false });
        }

        async function open(nodeId, options) {
            const id = textOf(nodeId, '');
            if (!id) throw new Error('请先选择画布中的角色');
            if (state.restoredScope !== contextKey(currentContext())) await contextChanged();
            if (state.open && (state.selectedNodeId !== id || (options?.workId && state.selectedWorkId !== options.workId))) {
                if (!await confirmDiscard('切换角色会放弃当前未提交的文字。')) return false;
                persistView(); closeModal();
                clearTransientDrafts();
            }
            const rememberedWork = state.selectedNodeId === id ? state.selectedWorkId : '';
            state.open = true; state.mode = 'role'; state.selectedNodeId = id;
            state.selectedWorkId = textOf(options?.workId, rememberedWork); state.tab = options?.workId ? 'work' : state.tab || 'work';
            state.detail = null; state.error = ''; state.eventCursor = null; state.extraEvents = [];
            ensureRoot(); persistView(); render(); await refresh();
            return true;
        }

        async function openPending() {
            if (state.restoredScope !== contextKey(currentContext())) await contextChanged();
            if (state.open && !await confirmDiscard('打开待处理列表会放弃当前未提交的文字。')) return false;
            persistView(); closeModal();
            clearTransientDrafts();
            state.open = true; state.mode = 'pending'; state.selectedNodeId = '';
            state.selectedWorkId = ''; state.tab = 'work'; state.detail = null;
            state.error = ''; state.cursor = null; state.eventCursor = null; state.extraEvents = [];
            ensureRoot(); persistView(); render(); await refresh();
            return true;
        }

        async function close() {
            if (!state.open) return true;
            if (!await confirmDiscard()) return false;
            persistView(); clearTransientDrafts(); abortReads(); closeModal(); state.open = false;
            state.root?.remove(); state.root = null; state.detail = null;
            bridge.workRoot.hidden = true;
            return true;
        }

        async function contextChanged() {
            const next = currentContext();
            if (sameContext(state.ctx, next) && state.restoredScope === contextKey(next)) { state.ctx = next; return; }
            if (state.restoredScope) persistView();
            abortReads(); closeModal(); state.root?.replaceChildren();
            state.nodes = []; state.materials = []; state.runs = []; state.works = [];
            state.detail = null; state.cursor = null; state.scope = ''; state.selectedNodeId = '';
            state.selectedWorkId = ''; state.eventCursor = null; state.extraEvents = [];
            clearTransientDrafts();
            restoreScope(next); state.billedAttempts = new Set();
            state.open = Boolean(state.root && state.root.isConnected);
            if (state.open) {
                render();
                if (next.userId && next.documentId) await refresh();
            }
        }

        function render() {
            if (!state.open) return;
            const host = ensureRoot();
            host.replaceChildren();
            host.dataset.mode = state.mode;
            host.append(renderHeader());
            if (state.error) host.append(panelMessage(state.error, 'error'));
            if (state.pendingMutation) host.append(renderPendingReceipt());
            if (state.loading) {
                host.append(panelMessage('正在读取本画布的角色任务…', 'quiet'));
                return;
            }
            if (state.mode === 'pending') host.append(renderPendingList());
            else host.append(renderRoleView());
            if (state.loadingMore) host.append(panelMessage('正在加载下一批…', 'quiet'));
        }

        function renderHeader() {
            const header = el('header', 'crw-header');
            const copy = el('div', 'crw-header-copy');
            copy.append(el('h2', 'crw-title', state.mode === 'pending' ? '待我处理' : '角色工作'));
            const role = selectedNode();
            copy.append(el('p', 'crw-subtitle', state.mode === 'pending' ? '当前画布' : (role ? nodeTitle(role) : '请选择画布角色')));
            header.append(copy);
            const actions = el('div', 'crw-header-actions');
            if (typeof bridge.openLibrary === 'function') actions.append(actionIcon('users', 'return-library', '返回角色库'));
            actions.append(actionIcon('rotate-ccw', 'reset-view', '重置面板视图，保留草稿和回执'));
            actions.append(actionIcon('refresh-cw', 'refresh', '刷新任务状态'));
            actions.append(actionIcon('x', 'close', '关闭角色工作面板'));
            header.append(actions);
            return header;
        }

        function renderTabs() {
            const tabs = el('nav', 'crw-tabs');
            tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '角色任务视图');
            [['work', '工作'], ['talk', '交流'], ['history', '历史']].forEach(([id, label]) => {
                const tab = button(label, 'tab', '', '', label);
                tab.dataset.tab = id; tab.setAttribute('role', 'tab');
                tab.setAttribute('aria-selected', String(state.tab === id));
                tab.tabIndex = state.tab === id ? 0 : -1;
                tabs.append(tab);
            });
            return tabs;
        }

        function renderRoleView() {
            const view = el('div', 'crw-view');
            const detail = currentDetail();
            const role = selectedNode() || (detail ? { id: detail.work.node_id, title: detail.work.snapshot?.role?.name,
                roleConfig: { snapshot: detail.work.snapshot?.role || {} } } : null);
            if (!role) {
                const empty = el('div', 'crw-empty');
                empty.append(el('strong', '', '这个角色不在当前画布'));
                empty.append(el('p', '', '从画布中重新选择角色，或创建并加入一个角色。'));
                empty.append(button('创建角色', 'open-creator', 'primary', 'plus'));
                view.append(empty); return view;
            }
            const roleDetails = detail?.work?.snapshot?.role || roleConfig(role).snapshot;
            const summary = el('section', 'crw-role-summary');
            const title = el('div', 'crw-role-title');
            const avatar = el('span', 'crw-avatar'); setIcon(avatar, roleDetails.executor?.kind === 'ai' ? 'bot' : 'user-round');
            title.append(avatar);
            const name = el('div', 'crw-role-copy'); name.append(el('strong', '', textOf(roleDetails.name, nodeTitle(role))));
            name.append(el('span', 'crw-muted', executorLabel(roleDetails.executor)));
            title.append(name);
            summary.append(title);
            if (roleDetails.responsibilities) summary.append(summaryRow('职责', roleDetails.responsibilities));
            if (roleDetails.delivery) summary.append(summaryRow('交付', roleDetails.delivery));
            view.append(summary, renderTabs());
            if (detail) view.append(renderTaskControls(detail));

            if (state.tab === 'talk') view.append(renderTalk());
            else if (state.tab === 'history') view.append(renderHistory());
            else view.append(renderWork());
            return view;
        }

        function executorLabel(executor) {
            if (executor?.kind === 'ai') return 'AI · ' + textOf(executor.model, '模型待确认');
            if (executor?.kind === 'person') return executor.userId === state.ctx.userId ? '本人处理' : '人员权限待确认';
            return '执行者待指定';
        }

        function summaryRow(label, value) {
            const row = el('div', 'crw-summary-row');
            row.append(el('span', 'crw-muted', label)); row.append(el('p', '', value));
            return row;
        }

        function recordDetails(rows) {
            const details = el('details', 'crw-record-details crw-dependencies');
            details.append(el('summary', '', '查看记录编号'));
            rows.forEach(([label, value]) => { if (value) details.append(summaryRow(label, value)); });
            return details;
        }

        function renderWork() {
            const panel = el('section', 'crw-work'); panel.setAttribute('role', 'tabpanel');
            const works = selectedWorkOptions();
            const selectorRow = el('div', 'crw-task-select-row');
            selectorRow.append(el('label', 'crw-field-label', '本次任务'));
            if (works.length) {
                const select = el('select', 'crw-select'); select.dataset.action = 'select-work';
                works.forEach(work => {
                    const option = el('option', '', textOf(work.goal, '本次任务') + ' · ' + displayPhase(work.phase) + ' · 第' + (Number(work.round) || 1) + '轮');
                    option.value = work.id; option.selected = work.id === state.selectedWorkId; select.append(option);
                });
                selectorRow.append(select);
            } else selectorRow.append(el('p', 'crw-muted', '尚未为这个角色配置任务。'));
            const settings = button(works.length ? '任务设置' : '配置任务', 'task-settings', '', 'sliders-horizontal');
            settings.disabled = currentDetail() ? !taskUpdateAvailable(currentDetail()) : state.ctx.writable === false;
            selectorRow.append(settings);
            panel.append(selectorRow);

            const detail = currentDetail();
            if (!state.selectedWorkId || !detail) {
                if (state.selectedWorkId && !state.error) panel.append(panelMessage('正在读取所选任务…', 'quiet'));
                else if (!state.error) panel.append(renderEmpty('还没有本次任务', '先写清目标、参与角色和输入材料。保存后不会自动调用 AI。'));
                if (state.mode === 'role') panel.append(button('配置本次任务', 'new-task', 'primary', 'plus'));
                return panel;
            }
            if (detail.summary?.action_available === false) panel.append(renderReadOnlyWork(detail));
            panel.append(renderTaskDetail(detail));
            if (state.cursor) panel.append(button('加载更早任务', 'load-more', '', 'chevron-down'));
            return panel;
        }

        function renderEmpty(title, copy) {
            const empty = el('div', 'crw-empty');
            empty.append(el('strong', '', title), el('p', '', copy));
            return empty;
        }

        function renderReadOnlyWork(detail) {
            const box = panelMessage(detail.summary?.action_unavailable_reason || '历史工作只读，原成果、记录和账单继续保留。', 'quiet');
            const currentId = detail.summary?.current_work_id;
            if (currentId && currentId !== detail.work.id) {
                const current = button('返回当前修订', 'history-work', '', 'arrow-right');
                current.dataset.workId = currentId; box.append(current);
            }
            return box;
        }

        function renderTaskControls(detail) {
            const controls = el('section', 'crw-task-controls');
            controls.setAttribute('aria-label', '本次任务控制');
            if (taskControlAvailable(detail)) {
                controls.append(button(detail.run.paused ? '继续任务' : '暂停任务', detail.run.paused ? 'run-resume' : 'run-pause',
                    detail.run.paused ? 'primary' : 'quiet', detail.run.paused ? 'play' : 'pause'));
            }
            if (state.tab !== 'work' && taskUpdateAvailable(detail)) controls.append(button('任务设置', 'task-settings', '', 'sliders-horizontal'));
            if (detail.run.paused) controls.append(el('p', 'crw-muted', '任务已暂停；不能提交或通过成果，原成果与账单仍可查看。已发请求不会重放。'));
            return controls;
        }

        function renderTaskDetail(detail) {
            const work = detail.work || {}, run = detail.run || {}, req = parseJson(detail.requirements, {});
            const block = el('div', 'crw-task-detail');
            const status = el('div', 'crw-status-line');
            status.append(el('strong', 'crw-status', displayPhase(work.phase)));
            if (run.paused) status.append(el('span', 'crw-muted', '任务已暂停；已发出的请求未必已取消'));
            const time = work.updated_at || work.created_at || run.updated_at || run.created_at;
            addTime(status, time);
            block.append(status);
            if (detail.waiting_expired) block.append(panelMessage('等待时间已到；系统没有强行推进。请核对当前状态后再处理。', 'warning'));
            if (work.wait_reason) block.append(panelMessage(work.wait_reason, 'warning'));
            block.append(summaryRow('目标', textOf(req.goal, textOf(work.goal, '目标待同步'))));
            if (req.criteria) block.append(summaryRow('验收要求', req.criteria));
            block.append(renderCollection(run, req));
            block.append(renderInputs(detail));
            block.append(renderCost(run, detail.attempts, detail.execution));
            if (state.draftConflict) block.append(renderDraftConflict('work'));
            const finalReceipt = detail.summary?.final_receipt ? { kind: 'owner_result_available', created_at: detail.summary.final_receipt.created_at,
                detail: detail.summary.final_receipt } : recordList(detail.events).find(event => event.kind === 'owner_result_available');
            if (finalReceipt) block.append(renderEvent(finalReceipt));
            if (detail.revision_source?.readonly === true) {
                const source = el('section', 'crw-revision-source');
                source.append(el('h3', '', '本轮修订原稿'));
                if (typeof detail.revision_source.opinion === 'string' && detail.revision_source.opinion) source.append(el('p', 'crw-input-copy', detail.revision_source.opinion));
                source.append(button('查看固定原稿', 'view-revision-source', '', 'file-text')); block.append(source);
            }
            block.append(renderDeliveries(detail));
            block.append(renderWorkActions(detail));
            return block;
        }

        function renderCollection(run, req) {
            const participants = recordList(req.participants);
            const rows = worksForRun(run.id);
            const section = el('details', 'crw-collection');
            rememberDetails(section, 'collection:' + run.id);
            const summary = el('summary', '', '本次分工 · ' + participants.length + ' 个角色');
            section.append(summary);
            const list = el('div', 'crw-collection-list');
            participants.forEach(participant => {
                const node = state.nodes.find(item => item.id === participant.nodeId);
                const work = rows.find(item => item.node_id === participant.nodeId);
                const line = el('div', 'crw-collection-row');
                line.append(el('span', '', node ? nodeTitle(node) : '角色已不在画布'));
                line.append(el('span', 'crw-muted', participant.participation === 'required' ? '必交' : participant.participation === 'optional' ? '可选' : '不参与'));
                line.append(el('span', 'crw-phase-small', work ? displayPhase(work.phase) : '等待同步'));
                list.append(line);
            });
            if (!participants.length) list.append(el('p', 'crw-muted', '分工信息尚未返回。'));
            section.append(list);
            const final = state.nodes.find(item => item.id === req.finalNodeId);
            section.append(el('p', 'crw-muted', '最终交付角色：' + (final ? nodeTitle(final) : '待同步') + '；成果交给你。可选角色不会阻塞必交收齐。'));
            return section;
        }

        function renderInputs(detail) {
            const section = el('section', 'crw-inputs');
            section.append(el('h3', '', '有效输入'));
            const materials = recordList(detail.materials);
            const dependencies = recordList(detail.inputs);
            if (!materials.length && !dependencies.length) {
                section.append(el('p', 'crw-muted', '本次没有已绑定的材料。'));
                return section;
            }
            materials.forEach(material => {
                const node = state.materials.find(item => item.id === material.nodeId);
                const row = el('div', 'crw-input-row');
                const title = el('div', 'crw-input-heading');
                title.append(el('strong', '', textOf(material.title, textOf(node?.title, '画布材料'))));
                title.append(el('span', 'crw-muted', material.type === 'text' || material.type === 'script' ? '文字快照' : '已绑定原件'));
                row.append(title);
                const sourceText = textOf(material.text, '');
                if (sourceText) row.append(el('p', 'crw-input-copy', sourceText));
                section.append(row);
            });
            dependencies.forEach(input => {
                const node = state.nodes.find(item => item.id === input.nodeId);
                const row = el('div', 'crw-input-row');
                row.append(el('span', '', textOf(node ? nodeTitle(node) : '', '角色交付')));
                row.append(el('span', 'crw-muted', '成果 v' + (Number(input.version) || '?')));
                const content = parseJson(input.content, {});
                const value = textOf(content.text, '');
                if (value) row.append(el('p', 'crw-input-copy', value));
                if (validId(input.sourceWorkId) && validId(input.deliveryId)) {
                    const view = button('查看上游原稿', 'view-input', '', 'file-text');
                    view.dataset.sourceWorkId = input.sourceWorkId; view.dataset.deliveryId = input.deliveryId;
                    view.dataset.inputVersion = String(input.version);
                    row.append(view);
                }
                section.append(row);
            });
            section.append(el('p', 'crw-muted', '以上是本次工作读取的材料快照；后续画布变更不会改写已提交版本。'));
            return section;
        }

        function renderCost(run, attemptsValue, execution) {
            const attempts = recordList(attemptsValue);
            const details = el('details', 'crw-cost');
            rememberDetails(details, 'cost:' + run.id);
            details.append(el('summary', '', '调用与费用'));
            const body = el('div', 'crw-cost-body');
            const limits = [];
            const pointLimit = numberOf(run.budget_points_limit);
            if (pointLimit !== null && pointLimit >= 0) limits.push('本站点上限 ' + formatPoints(pointLimit) + ' 点');
            if (Number.isSafeInteger(run.budget_usd_micros_limit)) limits.push('上游费用上限 ' + formatUsdMicros(run.budget_usd_micros_limit));
            if (Number.isSafeInteger(run.max_calls)) limits.push('最多 ' + run.max_calls + ' 次调用');
            body.append(el('p', 'crw-muted', limits.length ? limits.join(' · ') : '尚未设置费用与调用上限。AI 调用不可用。'));
            const totals = [];
            if (run.reserved_points != null || run.settled_points != null) {
                totals.push('本站点：预留 ' + formatPoints(run.reserved_points || 0) + ' 点 · 结算 ' + formatPoints(run.settled_points || 0) + ' 点');
            }
            if (run.reserved_usd_micros != null || run.settled_usd_micros != null) {
                totals.push('上游：预留 ' + formatUsdMicros(run.reserved_usd_micros || 0) + ' · 结算 ' + formatUsdMicros(run.settled_usd_micros || 0));
            }
            if (totals.length) body.append(el('p', 'crw-cost-total', totals.join('\n')));
            body.append(el('p', 'crw-muted', '金额为本次任务总计；下方只列当前工作已返回的调用回执。'));
            body.append(el('p', 'crw-muted', '已用调用 ' + (Number(run.call_count) || 0) + ' / ' + (run.max_calls == null ? '未设上限' : run.max_calls)));
            if (Number(run.reserved_points) > 0 || Number(run.reserved_usd_micros) > 0
                || attempts.some(attempt => ['pending', 'unknown', 'reserved'].includes(attempt.fee_state) || !attempt.settlement_applied
                && !['confirmed', 'cash_only', 'not_sent'].includes(attempt.fee_state))) {
                body.append(panelMessage('成果处理与费用结算分开：仍有费用待确认。已交付不代表账单已结清。', 'warning'));
            }
            if (!attempts.length) body.append(el('p', 'crw-muted', '尚无 AI 调用回执；这不代表调用免费。'));
            attempts.forEach(attempt => {
                body.append(renderAttemptRow(attempt, true));
            });
            const detail = currentDetail();
            if (detail?.next_attempt_cursor) {
                const more = button(state.loadingAttempts ? '正在读取…' : '加载更早调用', 'load-attempts', '', 'history');
                more.disabled = state.loadingAttempts; body.append(more);
            }
            const workGate = executionGate(execution, 'work', run);
            if (!workGate.ready) body.append(el('p', 'crw-gate-reason', 'AI 执行暂不可用：' + workGate.reason));
            details.append(body);
            return details;
        }

        function renderAttemptRow(attempt, canView) {
            const row = el('div', 'crw-cost-row'), feeState = textOf(attempt.fee_state, 'unknown');
            const heading = el('div', 'crw-cost-heading');
            heading.append(el('strong', '', purposeLabel(attempt.purpose)), el('span', '', attemptStateLabel(attempt.state) + ' · ' + feeLabel(feeState)));
            row.append(heading);
            const amounts = [];
            if (attempt.reserved_points != null) amounts.push('预留 ' + formatPoints(attempt.reserved_points) + ' 点');
            if (attempt.settled_points != null) amounts.push('结算 ' + formatPoints(attempt.settled_points) + ' 点');
            if (attempt.reserved_usd_micros != null) amounts.push('美元预留 ' + formatUsdMicros(attempt.reserved_usd_micros));
            if (attempt.settled_usd_micros != null) amounts.push('美元结算 ' + formatUsdMicros(attempt.settled_usd_micros));
            if (feeState === 'authorization_required') amounts.push('原账单 ' + formatUsdMicros(attempt.confirmed_bill_usd_micros) + ' · 超出本次预留，未追加扣费');
            row.append(el('span', 'crw-muted', amounts.length ? amounts.join(' · ') : '金额待核对'));
            const when = el('span', 'crw-muted'); addTime(when, attempt.started_at); row.append(when);
            if (attempt.state === 'unknown' || ['pending', 'unknown', 'reserved', 'authorization_required'].includes(feeState)) {
                const query = button('查原账单', 'query-attempt', '', 'search'); query.dataset.attemptId = attempt.id; row.append(query);
            }
            if (canView) {
                const view = button(attempt.result_available === true || attempt.result_json ? '查看原回复与费用' : '查看原调用回执', 'view-attempt', '', 'file-text');
                view.dataset.attemptId = attempt.id; row.append(view);
            }
            return row;
        }

        function purposeLabel(value) {
            return value === 'review' ? 'AI 检查建议' : 'AI 执行';
        }

        function attemptStateLabel(value) {
            const labels = { reserved: '已预留，尚无成果', sending: '请求中', succeeded: '已返回', failed: '失败',
                unknown: '结果待确认', not_adopted: '回复已保存，未采纳为成果', not_sent: '已确认未向模型发送' };
            return labels[value] || '状态待核对';
        }

        function formatUsdMicros(value) {
            const amount = numberOf(value);
            if (amount === null) return '金额待核对';
            return '$' + (amount / 1_000_000).toFixed(6);
        }

        function feeLabel(value) {
            const labels = { settled: '已结算', confirmed: '已确认结算', cash_only: '上游费用已确认', not_sent: '未发送，无本次调用费用',
                reserved: '已预留', pending: '费用处理中', unknown: '费用待核对', authorization_required: '超出原预留，待授权处理',
                failed: '结算失败', none: '未产生费用记录' };
            return labels[value] || '费用状态待核对';
        }

        function executionGate(executionValue, purpose, run) {
            const execution = parseJson(executionValue, {});
            const purposes = isRecord(execution.purposes) ? execution.purposes : {};
            const gate = isRecord(purposes[purpose]) ? purposes[purpose] : {};
            const reason = textOf(gate.reason || (purpose === 'work' ? execution.reason : ''), '执行条件或准确报价尚未确认。');
            const pointLimit = numberOf(run?.budget_points_limit);
            const hasPointLimit = pointLimit !== null && pointLimit >= 0;
            const hasUsdLimit = finiteInteger(run?.budget_usd_micros_limit, 0, Number.MAX_SAFE_INTEGER) !== null;
            const maxCalls = finiteInteger(run?.max_calls, 1, 1000);
            const quoteId = textOf(gate.quote_id || (purpose === 'work' ? execution.quote_id : ''), '');
            const tokens = finiteInteger(gate.max_output_tokens, 1, 200000);
            const reservePoints = numberOf(gate.reserve_points);
            const reserveUsdMicros = finiteInteger(gate.reserve_usd_micros, 0, Number.MAX_SAFE_INTEGER);
            const expiresAt = textOf(gate.expires_at, '');
            const expires = Date.parse(expiresAt);
            const source = textOf(gate.source, '');
            const model = textOf(gate.model, '');
            if (!hasPointLimit || !hasUsdLimit) return { ready: false, reason: '仅 AI 调用需要点数与美元上限；人工工作可不填。' };
            if (!maxCalls) return { ready: false, reason: 'AI 调用还需设置最多调用次数；人工工作可不填。' };
            if (gate.enabled !== true || !quoteId || !tokens || reservePoints === null || reservePoints < 0
                || reserveUsdMicros === null || !source || !model || !Number.isFinite(expires)) return { ready: false, reason };
            if (expires <= Date.now()) return { ready: false, reason: '报价已过期，请刷新并重新核对。' };
            return { ready: true, quote: gate, quoteId, maxOutputTokens: tokens, reservePoints, reserveUsdMicros,
                expiresAt, source, model, gate };
        }

        function renderDeliveries(detail) {
            const section = el('section', 'crw-deliveries');
            const deliveries = recordList(detail.deliveries);
            section.append(el('h3', '', '成果'));
            const currentId = detail.work?.current_delivery_id;
            if (!deliveries.length) {
                const draft = parseJson(detail.draft_content, {});
                section.append(el('p', 'crw-muted', detail.work?.draft_text || recordList(draft.attachments).length
                    ? '有已保存草稿，尚未提交为成果版本。' : '尚无已提交成果。'));
                return section;
            }
            deliveries.forEach(delivery => {
                const content = parseJson(delivery.content_json || delivery.content, {});
                const row = el('div', 'crw-delivery-row');
                const label = delivery.id === currentId ? '当前成果 · v' : '历史成果 · v';
                row.append(el('span', delivery.id === currentId ? 'crw-delivery-current' : 'crw-muted', label + (Number(delivery.version) || '?')));
                const submitted = el('span', 'crw-muted'); addTime(submitted, delivery.created_at); row.append(submitted);
                const action = button('查看', 'view-delivery', '', 'file-text'); action.dataset.deliveryId = delivery.id; row.append(action);
                const snippet = textOf(content.text, '');
                if (snippet) row.append(el('p', 'crw-delivery-snippet', snippet.slice(0, 240)));
                section.append(row);
            });
            return section;
        }

        function renderWorkActions(detail) {
            if (detail.summary?.action_available === false) return renderReadOnlyWork(detail);
            const work = detail.work || {}, run = detail.run || {}, req = parseJson(detail.requirements, {});
            const role = parseJson(work.snapshot?.role, parseJson(work.snapshot_json, {}).role || {});
            const executor = role.executor || {};
            const participant = recordList(req.participants).find(item => item.nodeId === work.node_id) || {};
            const box = el('section', 'crw-actions');
            const title = el('div', 'crw-actions-title');
            title.append(el('h3', '', '下一步'));
            box.append(title);

            if (work.phase === 'offered' || work.phase === 'rejected') {
                box.append(button(work.phase === 'rejected' ? '重新接收' : '接收任务', 'work-accept', 'primary', 'check'));
                box.append(button('申请补充材料', 'work-request-material', '', 'paperclip'));
                box.append(button('拒绝本次任务', 'work-reject', 'quiet', 'x'));
            } else if (work.phase === 'needs_material') {
                box.append(panelMessage('必交材料尚未齐全。更新材料或依赖后，只调整受影响分支；独立分支保留。', 'warning'));
                const settings = button('更新任务要求', 'task-settings', 'primary', 'sliders-horizontal');
                settings.disabled = !taskUpdateAvailable(detail); box.append(settings);
                box.append(button('说明缺少什么', 'work-request-material', '', 'message-square'));
            } else if (work.phase === 'review' || work.phase === 'confirmation') {
                box.append(panelMessage(work.phase === 'review' ? '检查对象是当前成果版本；退回会保留旧稿并创建新修订轮。' : '本人确认与检查意见分开记录。', 'quiet'));
                if (work.phase === 'review') {
                    thisAppendExecutionButton(box, detail, 'review');
                    if (canCurrentUserReview(work, participant)) {
                        box.append(button('人工检查并通过', 'work-approve', 'primary', 'badge-check'));
                        box.append(button('退回修订', 'work-return', '', 'corner-up-left'));
                    } else box.append(panelMessage('当前指定检查者尚未授权本人代为检查；AI 建议也不会自动通过成果。', 'warning'));
                } else {
                    box.append(button('确认交付', 'work-approve', 'primary', 'badge-check'));
                    box.append(button('退回修订', 'work-return', '', 'corner-up-left'));
                }
            } else if (work.phase === 'delivered') {
                if (run.status === 'delivered' && req.finalNodeId === work.node_id) box.append(panelMessage('本次最终成果已交给你；未对外发送。', 'success'));
                box.append(button('继续修订', 'work-revise', '', 'pencil'));
            } else if (work.phase === 'unknown') {
                box.append(panelMessage('结果未知时不自动重发。刷新只读取原状态，不会产生新调用。', 'warning'));
                box.append(button('刷新原状态', 'refresh', '', 'refresh-cw'));
            } else if (work.phase === 'failed') {
                box.append(panelMessage('请求失败状态以服务端回执为准；确认允许重试和报价有效后，才可另开一次调用。', 'warning'));
                thisAppendExecutionButton(box, detail, 'work');
            } else if (['ready', 'working', 'revision'].includes(work.phase)) {
                if (canOwnerSubmit(executor, participant)) box.append(renderSubmissionEditor(detail, role, participant));
                else box.append(panelMessage(executor.kind === 'ai' ? 'AI 只能在本次任务预算、服务端就绪状态和有效报价齐备后手动开始。' : '当前执行者尚未配置本人提交权限。', 'quiet'));
                thisAppendExecutionButton(box, detail, 'work');
            }
            if (run.paused) box.querySelectorAll('[data-action]').forEach(control => {
                if (!['task-settings', 'refresh'].includes(control.dataset.action)) control.disabled = true;
            });
            return box;
        }

        function canOwnerSubmit(executor, participant) {
            if (executor.kind === 'person') return executor.userId === state.ctx.userId;
            return participant.ownerMaySubmit === true;
        }

        function canCurrentUserReview(work, participant) {
            const executor = reviewerExecutor(work);
            if (!executor) return false;
            if (executor.kind === 'person') return executor.userId === state.ctx.userId;
            return participant.ownerMayReview === true;
        }

        function reviewerExecutor(work) {
            const reviewer = worksForRun(work.role_task_run_id).find(item => item.node_id === work.reviewer_node_id
                && item.requirements_revision === work.requirements_revision && item.phase !== 'superseded');
            const snapshot = parseJson(reviewer?.snapshot, parseJson(reviewer?.snapshot_json, {}));
            return snapshot?.role?.executor || null;
        }

        function renderSubmissionEditor(detail, role, participant) {
            const box = el('div', 'crw-submit-box');
            const textarea = el('textarea', 'crw-textarea');
            textarea.dataset.editor = 'main'; textarea.setAttribute('aria-label', '成果内容');
            textarea.placeholder = '填写要提交的成果'; textarea.rows = 5;
            textarea.maxLength = 100000; textarea.value = state.editorDraft;
            box.append(textarea);
            recordList(role.requiredItems).forEach(name => {
                const label = el('label', 'crw-field'); label.append(el('span', 'crw-field-label', '必交项 · ' + name));
                const item = el('textarea', 'crw-textarea'); item.dataset.requiredItem = name;
                item.rows = 2; item.setAttribute('aria-label', '必交项 ' + name);
                item.maxLength = 16000; item.value = state.editorItems[name] || '';
                label.append(item); box.append(label);
            });
            box.append(renderAttachmentEditor());
            const save = button('保存草稿', 'work-draft', '', 'save'), submit = button('提交成果', 'work-submit', 'primary', 'send');
            save.disabled = submit.disabled = state.draftConflict;
            box.append(save, submit);
            if (participant.ownerMaySubmit && role.executor?.kind !== 'person') box.append(el('p', 'crw-muted', '本次允许你代为提交；提交记录会标明代提交。'));
            return box;
        }

        function attachmentMetadata(selection) {
            const saved = recordList(state.editorBaseline?.attachments).find(item => attachmentKey(item.selection) === attachmentKey(selection));
            if (saved) return saved;
            const source = currentDetail()?.revision_source;
            if (selection.sourceDeliveryId === source?.deliveryId) {
                const original = recordList(source.content?.attachments)[selection.index];
                if (original) return original;
            }
            const node = state.materials.find(item => item.id === selection.nodeId);
            return { title: node?.title || (selection.sourceDeliveryId ? '原成果附件' : '画布节点已移除'), type: node?.type || '', ...selection };
        }

        function attachmentDescription(attachment, selection) {
            return selection?.sourceDeliveryId ? '固定原成果 · 第' + (selection.index + 1) + '项'
                : attachment.nodeId || selection?.nodeId ? '已选画布原件，提交时固定版本' : '固定交付原件';
        }

        function attachmentRecord(attachment, selection) {
            const rows = [['成果编号', selection?.sourceDeliveryId], ['原件序号', selection?.sourceDeliveryId ? String(selection.index + 1) : ''],
                ['画布节点', attachment.nodeId || selection?.nodeId], ['资产编号', attachment.assetId],
                ['参考编号', attachment.referenceImageId], ['媒体任务', attachment.taskId], ['原件指纹', attachment.sourceDigest]];
            return recordDetails(rows);
        }

        function renderAttachmentEditor() {
            const section = el('section', 'crw-attachment-editor');
            section.append(el('h3', '', '交付原件 · ' + state.editorAttachments.length + ' / 20'));
            state.editorAttachments.forEach((selection, index) => {
                const snapshot = attachmentMetadata(selection), row = el('div', 'crw-attachment-row');
                const copy = el('div', 'crw-attachment-copy');
                copy.append(el('strong', '', textOf(snapshot.title, '交付原件') + (snapshot.type ? ' · ' + snapshot.type : '')),
                    el('span', 'crw-muted', attachmentDescription(snapshot, selection)), attachmentRecord(snapshot, selection));
                const remove = actionIcon('trash-2', 'remove-attachment', '移除此交付原件'); remove.dataset.attachmentIndex = String(index);
                row.append(copy, remove); section.append(row);
            });
            const candidates = state.materials.filter(isAttachmentNode);
            const picker = el('div', 'crw-attachment-picker');
            const select = el('select', 'crw-select'); select.dataset.attachmentNode = ''; select.setAttribute('aria-label', '选择画布交付原件');
            appendOption(select, '', '选择画布原件');
            candidates.forEach(item => appendOption(select, item.id, textOf(item.title, item.type) + ' · ' + item.type));
            const add = button('加入成果', 'add-attachment', '', 'plus'); add.disabled = !candidates.length || state.editorAttachments.length >= 20;
            picker.append(select, add); section.append(picker);
            const source = currentDetail()?.revision_source;
            if (source?.readonly === true && validId(source.deliveryId)) recordList(source.content?.attachments).slice(0, 20).forEach((attachment, index) => {
                const selection = { sourceDeliveryId: source.deliveryId, index };
                if (state.editorAttachments.some(item => attachmentKey(item) === attachmentKey(selection))) return;
                const retain = button('保留原稿：' + textOf(attachment.title, '原件 ' + (index + 1)), 'retain-attachment', '', 'plus');
                retain.dataset.attachmentIndex = String(index); retain.disabled = state.editorAttachments.length >= 20; section.append(retain);
            });
            return section;
        }

        function updateAttachmentEditor() {
            state.editorDirty = true; persistView();
            state.root?.querySelector('.crw-attachment-editor')?.replaceWith(renderAttachmentEditor());
        }

        async function addAttachment(target) {
            const ctx = currentContext(), detail = currentDetail();
            if (!detail || state.editorAttachments.length >= 20) throw new Error('交付原件最多 20 项。');
            const id = target.closest('.crw-attachment-picker')?.querySelector('[data-attachment-node]')?.value;
            if (!validId(id)) throw new Error('请先选择画布原件。');
            await loadNodes(ctx);
            if (!isCurrent(ctx) || currentDetail() !== detail) return;
            const node = state.materials.find(item => item.id === id && isAttachmentNode(item));
            if (!node) throw new Error('所选原件节点已变化，未加入成果。');
            if (state.editorAttachments.length >= 20) throw new Error('交付原件最多 20 项。');
            const selection = attachmentSelection({ nodeId: id, sourceDigest: node.sourceDigest });
            if (!state.editorAttachments.some(item => attachmentKey(item) === attachmentKey(selection))) state.editorAttachments.push(selection);
            updateAttachmentEditor();
        }

        function isAttachmentNode(node) {
            return validId(node?.id) && ['image', 'video', 'audio', 'file', 'text', 'script'].includes(node.type);
        }

        function changeAttachment(target) {
            const index = finiteInteger(target.dataset.attachmentIndex, 0, 19);
            if (index === null) return;
            if (target.dataset.action === 'remove-attachment') state.editorAttachments.splice(index, 1);
            else {
                const source = currentDetail()?.revision_source;
                if (source?.readonly !== true || !validId(source.deliveryId) || !recordList(source.content?.attachments)[index]) throw new Error('原稿原件已不可读，未采用当前节点替代。');
                if (state.editorAttachments.length >= 20) throw new Error('交付原件最多 20 项。');
                const selection = { sourceDeliveryId: source.deliveryId, index };
                if (!state.editorAttachments.some(item => attachmentKey(item) === attachmentKey(selection))) state.editorAttachments.push(selection);
            }
            updateAttachmentEditor();
        }

        function thisAppendExecutionButton(box, detail, purpose) {
            const gate = executionGate(detail.execution, purpose, detail.run);
            if (!gate.ready) {
                box.append(panelMessage(gate.reason, 'warning'));
                return;
            }
            const execute = button(purpose === 'review' ? '获取 AI 检查建议' : '开始 AI 执行', 'work-execute', 'primary', 'play');
            execute.dataset.purpose = purpose; box.append(execute);
            const quote = gate.quote;
            const quoteCopy = quote.summary || quote.display_text || quote.label;
            if (typeof quoteCopy === 'string' && quoteCopy.trim()) box.append(el('p', 'crw-muted', quoteCopy));
            else box.append(el('p', 'crw-muted', '报价已取得；开始前会再次显示真实上限与报价信息。'));
        }

        function renderTalk() {
            const detail = currentDetail();
            const section = el('section', 'crw-talk');
            if (!detail) { section.append(panelMessage('先选择一项本画布任务，再查看交流记录。', 'quiet')); return section; }
            const messages = recordList(detail.events).filter(item => item.kind === 'message');
            if (!messages.length) section.append(renderEmpty('还没有交流记录', '消息只发送给当前任务中选定的角色。'));
            messages.forEach(event => section.append(renderMessage(event)));
            if (detail.summary?.action_available === false) { section.append(renderReadOnlyWork(detail)); return section; }
            if (state.draftConflict) section.append(renderDraftConflict('work'));
            const composer = el('div', 'crw-composer');
            const to = state.nodes.find(node => node.id === state.selectedNodeId);
            composer.append(el('p', 'crw-muted', '发给：' + (to ? nodeTitle(to) : '当前角色')));
            const fromSelect = el('select', 'crw-select'); fromSelect.dataset.messageFrom = '';
            appendOption(fromSelect, '', '以本人名义');
            recordList(detail.requirements?.participants).filter(item => item.participation !== 'excluded').forEach(item => {
                const node = state.nodes.find(candidate => candidate.id === item.nodeId);
                if (node && node.id !== state.selectedNodeId) appendOption(fromSelect, node.id, '以' + nodeTitle(node) + '身份转达');
            });
            fromSelect.value = state.messageFrom; composer.append(fromSelect);
            const textarea = el('textarea', 'crw-textarea'); textarea.dataset.message = '';
            textarea.rows = 3; textarea.maxLength = 16000; textarea.placeholder = '给当前角色补充信息';
            textarea.value = state.messageDraft; composer.append(textarea);
            const send = button('发送给角色', 'send-message', 'primary', 'send'); send.disabled = state.draftConflict; composer.append(send);
            section.append(composer);
            return section;
        }

        function renderMessage(event) {
            const detail = parseJson(event.detail_json || event.detail, {});
            const from = state.nodes.find(node => node.id === event.from_node_id);
            const row = el('article', 'crw-message-row');
            const heading = el('div', 'crw-message-head');
            heading.append(el('strong', '', from ? nodeTitle(from) + ' · 代为转达' : '你'));
            heading.append(el('span', 'crw-muted', event.to_node_id === state.selectedNodeId ? '发给当前角色' : '任务内交流'));
            addTime(heading, event.created_at); row.append(heading);
            row.append(el('p', 'crw-message-copy', textOf(detail.text, '消息内容待同步')));
            return row;
        }

        function renderHistory() {
            const detail = currentDetail();
            const section = el('section', 'crw-history');
            if (!detail) { section.append(panelMessage('先选择一项本画布任务，再查看成果和历史。', 'quiet')); return section; }
            section.append(el('h3', '', '任务修订与轮次'));
            if (detail.summary?.action_available === false) section.append(renderReadOnlyWork(detail));
            recordList(detail.node_work_history).forEach(work => {
                const row = el('div', 'crw-history-row');
                row.append(el('span', '', '要求修订 ' + work.requirements_revision + ' · 第' + work.round + '轮 · ' + displayPhase(work.phase)));
                addTime(row, work.created_at);
                const entry = button(work.id === detail.work.id ? '当前查看' : '查看原工作', 'history-work', '', 'history');
                entry.dataset.workId = work.id; entry.disabled = work.id === detail.work.id; row.append(entry);
                section.append(row);
            });
            if (detail.next_work_cursor) {
                const more = button(state.loadingWorkHistory ? '正在读取…' : '加载更早修订', 'load-work-history', '', 'history');
                more.disabled = state.loadingWorkHistory; section.append(more);
            }
            const deliveries = recordList(detail.deliveries);
            const heading = el('div', 'crw-history-heading');
            heading.append(el('h3', '', '成果版本'));
            heading.append(el('span', 'crw-muted', '当前成果与历史版本分开标识'));
            section.append(heading);
            if (!deliveries.length) section.append(el('p', 'crw-muted', '尚无已提交成果。'));
            deliveries.forEach(delivery => {
                const row = el('div', 'crw-history-row');
                const isCurrent = delivery.id === detail.work?.current_delivery_id;
                row.append(el('span', '', 'v' + (Number(delivery.version) || '?') + (isCurrent ? ' · 当前' : ' · 历史')));
                addTime(row, delivery.created_at);
                const view = button('查看成果', 'view-delivery', '', 'file-text'); view.dataset.deliveryId = delivery.id; row.append(view);
                section.append(row);
            });
            section.append(renderCost(detail.run, detail.attempts, detail.execution));
            section.append(el('h3', 'crw-history-subtitle', '操作记录'));
            const events = [...recordList(detail.events), ...state.extraEvents];
            if (!events.length) section.append(el('p', 'crw-muted', '尚无操作记录。'));
            events.forEach(event => section.append(renderEvent(event)));
            if (detail.next_cursor) section.append(button(state.loadingEarlier ? '正在读取…' : '加载更早记录', 'load-events', '', 'history'));
            return section;
        }

        function renderEvent(event) {
            const row = el('div', 'crw-event-row');
            const kind = textOf(event.kind, '');
            row.append(el('strong', '', EVENT_LABELS[kind] || '任务记录'));
            addTime(row, event.created_at);
            const detail = parseJson(event.detail_json || event.detail, {});
            if (event.actor_user_id) row.append(el('span', 'crw-muted', (event.actor_kind === 'ai' ? 'AI · 发起人：' : '操作人：')
                + (event.actor_user_id === state.ctx.userId ? '本人 · ' : '') + String(event.actor_user_id)));
            if (kind === 'ai_review_recommendation') {
                row.append(el('p', 'crw-muted', 'AI 建议 · ' + textOf(detail.model, '模型未提供') + '；不是检查通过或本人确认。'));
                const content = parseJson(detail.content, {});
                if (typeof content.text === 'string') row.append(el('pre', 'crw-event-content', content.text));
                if (isRecord(content.items)) Object.entries(content.items).forEach(([name, value]) => {
                    row.append(el('strong', 'crw-event-item', name), el('pre', 'crw-event-content', typeof value === 'string' ? value : JSON.stringify(value)));
                });
                if (detail.feePending === true) row.append(el('p', 'crw-muted', '本条记录产生时费用尚待确认，当前账单见“调用与费用”。'));
            }
            if (kind === 'owner_result_available') {
                if (currentDetail()?.run?.status !== 'delivered') row.append(el('p', 'crw-muted', '这是先前交付时的采纳回执；当前修订尚未完成。'));
                row.append(el('p', 'crw-muted', detail.externalDelivery === false ? '最终采纳结果已交给你，未对外发送。' : '外发状态未确认。'));
                recordList(detail.adopted).forEach(item => {
                    const delivery = recordList(currentDetail()?.deliveries).find(candidate => candidate.id === item.deliveryId);
                    row.append(el('p', 'crw-receipt-copy', '采纳工作 ' + textOf(item.workId, '编号未提供') + ' · 成果 ' + textOf(item.deliveryId, '编号未提供')));
                    if (validId(item.workId) && validId(item.deliveryId)) {
                        const view = button(delivery ? '查看采纳成果 v' + delivery.version : '查看采纳成果', 'view-adopted', '', 'file-text');
                        view.dataset.deliveryId = item.deliveryId; view.dataset.workId = item.workId; row.append(view);
                    }
                });
                row.append(el('p', 'crw-muted', detail.feeCleared === true ? '此回执确认无模型调用费用。' : '交付回执未确认费用结清，请另核账单。'));
            }
            const copy = textOf(detail.opinion || detail.reason || detail.goal, '');
            if (copy) row.append(el('p', 'crw-muted', copy));
            if (detail.deliveryVersion) row.append(el('span', 'crw-muted', '成果 v' + detail.deliveryVersion));
            return row;
        }

        function renderPendingList() {
            const list = el('section', 'crw-pending-list');
            const pending = state.works.filter(work => !['delivered', 'superseded'].includes(work.phase));
            list.append(el('p', 'crw-muted', state.scope === 'current_document'
                ? '仅显示当前画布已授权的工作；列表按批次读取。'
                : '列表范围以服务端返回为准；不会把未加载内容计入总数。'));
            if (!pending.length) {
                list.append(renderEmpty('当前批次没有待处理项', state.cursor ? '还有后续任务可加载。' : '没有更多当前画布待处理项。'));
            }
            pending.forEach(work => {
                const node = state.nodes.find(item => item.id === work.node_id);
                const row = el('article', 'crw-pending-row');
                const copy = el('div', 'crw-pending-copy');
                copy.append(el('strong', '', textOf(work.goal, node ? nodeTitle(node) : '画布角色任务')));
                copy.append(el('span', 'crw-muted', (node ? nodeTitle(node) : '角色') + ' · ' + displayPhase(work.phase) + ' · 第' + (Number(work.round) || 1) + '轮'));
                row.append(copy);
                const openButton = button('打开任务', 'open-work', '', 'arrow-right'); openButton.dataset.workId = work.id; openButton.dataset.nodeId = work.node_id; row.append(openButton);
                list.append(row);
            });
            list.append(el('p', 'crw-muted', '当前已加载 ' + state.works.length + ' 项。'));
            if (state.cursor) list.append(button('加载更多', 'load-more', '', 'chevron-down'));
            return list;
        }

        function renderPendingReceipt() {
            const box = el('aside', 'crw-receipt');
            const copy = el('p', '', '有一项操作结果尚未确认。查询同一回执不会重发或再次收费。');
            box.append(copy, button('查询原回执', 'recover-receipt', '', 'search'));
            return box;
        }

        function updatePendingControls() {
            [state.root, state.modalContent].forEach(surface => {
                if (!surface) return;
                surface.querySelector(':scope > .crw-receipt')?.remove();
                if (!state.pendingMutation) return;
                const box = renderPendingReceipt();
                const heading = surface.querySelector(':scope > header, :scope > h2');
                if (heading) heading.after(box); else surface.prepend(box);
            });
        }

        function appendOption(select, value, label) {
            const option = el('option', '', label); option.value = value; select.append(option); return option;
        }

        function appendTaskDialog(existingRun) {
            const editing = Boolean(existingRun);
            const detail = currentDetail();
            const requirements = editing ? parseJson(detail?.requirements, {}) : {};
            const draft = state.taskDraft || createTaskDraft(existingRun, requirements);
            state.taskDraft = draft;
            state.taskConflict = editing && Number(existingRun.revision) !== draft.baseRevision;
            const content = el('div', 'crw-dialog-content');
            content.append(el('h2', 'crw-dialog-title', editing ? '本次任务设置' : '配置本次任务'));
            if (state.taskConflict) content.append(renderDraftConflict('task'));
            const form = el('div', 'crw-dialog-form'); form.dataset.taskForm = '';
            addTextareaField(form, '任务目标', 'goal', draft.goal, 5, true);
            addTextareaField(form, '验收要求', 'criteria', draft.criteria, 3, false);
            form.append(el('h3', 'crw-form-section-title', '参与角色'));
            const participants = el('div', 'crw-participants');
            state.nodes.forEach(node => participants.append(participantEditor(node, draft)));
            draft.participants.filter(item => !state.nodes.some(node => node.id === item.nodeId)).forEach(item => {
                const row = el('label', 'crw-field'); row.append(el('span', 'crw-field-label', '角色已移除 · ' + item.nodeId));
                const select = el('select', 'crw-select'); select.dataset.participantField = 'participation'; select.dataset.nodeId = item.nodeId;
                if (item.participation !== 'excluded') appendOption(select, item.participation, '原设置 · ' + (item.participation === 'required' ? '必交' : '可选'));
                appendOption(select, 'excluded', '不参与新修订'); select.value = item.participation; row.append(select); participants.append(row);
            });
            form.append(participants);
            const finalField = el('label', 'crw-field'); finalField.append(el('span', 'crw-field-label', '最终交付给'));
            const finalSelect = el('select', 'crw-select'); finalSelect.dataset.taskField = 'finalNodeId';
            fillActiveOptions(finalSelect, draft.participants, draft.finalNodeId); finalField.append(finalSelect); form.append(finalField);
            form.append(el('h3', 'crw-form-section-title', '画布输入材料'));
            if (!state.materials.length) form.append(el('p', 'crw-muted', '当前画布没有可选的已保存材料节点。'));
            else state.materials.forEach(material => {
                const label = el('label', 'crw-check-row');
                const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.dataset.materialId = material.id;
                checkbox.checked = draft.materialNodes.includes(material.id); label.append(checkbox);
                label.append(el('span', '', textOf(material.title, material.type || '画布材料'))); form.append(label);
            });
            draft.materialNodes.filter(id => !state.materials.some(item => item.id === id)).forEach(id => {
                const label = el('label', 'crw-check-row'), checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = true;
                checkbox.dataset.materialId = id; label.append(checkbox, el('span', '', '材料已移除 · ' + id)); form.append(label);
            });
            if (editing) {
                const label = el('label', 'crw-check-row'), refresh = el('input'); refresh.type = 'checkbox';
                refresh.dataset.taskField = 'refresh_materials'; refresh.checked = draft.refresh_materials === true;
                label.append(refresh, el('span', '', '将所选材料固定为画布当前正文')); form.append(label);
                form.append(el('p', 'crw-muted', '只保存限额不更新材料或工作。保存任务设置会核对角色实例升级，只更新受影响分支，独立分支及已有轮次保留。'));
            }
            addNumberField(form, '最多修订轮次', 'max_rounds', draft.max_rounds, 1, 100, true);
            addNumberField(form, '最多模型调用次数', 'max_calls', draft.max_calls, 1, 1000, false);
            addNumberField(form, '等待上限（秒）', 'wait_limit_seconds', draft.wait_limit_seconds, 1, 31536000, false);
            form.append(el('h3', 'crw-form-section-title', '费用边界'));
            addNumberField(form, '本站点点数上限', 'budget_points_limit', draft.budget_points_limit, 0, 1000000, false, '0.01');
            addNumberField(form, '上游美元上限', 'budget_usd', draft.budget_usd, 0, 1000, false, '0.000001');
            form.append(el('p', 'crw-muted', '纯手工任务可不填调用次数；启用 AI 必须同时设置点数、美元及调用次数上限。保存不会开始调用。'));
            if (editing) form.append(el('p', 'crw-muted', '上限不能低于已结算与已预留金额，调用次数不能低于已用次数。'));
            const error = el('p', 'crw-message crw-message--error'); error.dataset.taskError = ''; error.hidden = !state.taskDraftError;
            error.textContent = state.taskDraftError; form.append(error);
            const footer = el('div', 'crw-dialog-footer');
            footer.append(button('取消', 'dialog-cancel', 'quiet'));
            if (editing) {
                const limits = button('只保存限额', 'save-task', '', 'save'); limits.dataset.updateKind = 'limits';
                limits.disabled = state.taskSaving || state.taskConflict; footer.append(limits);
            }
            const submit = button(editing ? '保存任务设置' : '保存任务', 'save-task', 'primary', 'save');
            submit.disabled = state.taskSaving || state.taskConflict; footer.append(submit);
            content.append(form, footer);
            openModal('task', content);
        }

        function createTaskDraft(existingRun, requirements) {
            const current = recordList(requirements.participants);
            return {
                runId: existingRun?.id || '', nodeId: state.selectedNodeId, baseRevision: Number(existingRun?.revision) || 0,
                requirementsRevision: Number(existingRun?.requirements_revision) || 0,
                goal: textOf(requirements.goal, ''), criteria: textOf(requirements.criteria, ''),
                participants: state.nodes.map(node => {
                    const prior = current.find(item => item.nodeId === node.id);
                    return prior ? cloneParticipant(prior) : {
                        nodeId: node.id, participation: node.id === state.selectedNodeId ? 'required' : 'excluded',
                        reviewerNodeId: null, confirmRequired: node.id === state.selectedNodeId,
                        ownerMaySubmit: false, ownerMayReview: false, dependencies: []
                    };
                }),
                finalNodeId: textOf(requirements.finalNodeId, state.selectedNodeId),
                materialNodes: recordList(requirements.materialNodes).filter(item => typeof item === 'string'),
                refresh_materials: false,
                max_rounds: String(existingRun?.max_rounds || 1),
                max_calls: existingRun?.max_calls == null ? '' : String(existingRun.max_calls),
                wait_limit_seconds: existingRun?.wait_limit_seconds == null ? '' : String(existingRun.wait_limit_seconds),
                budget_points_limit: existingRun?.budget_points_limit == null ? '' : String(existingRun.budget_points_limit),
                budget_usd: existingRun?.budget_usd_micros_limit == null ? '' : String(Number(existingRun.budget_usd_micros_limit) / 1000000)
            };
        }

        function cloneParticipant(value) {
            return {
                nodeId: value.nodeId, participation: value.participation,
                reviewerNodeId: validId(value.reviewerNodeId) ? value.reviewerNodeId : null,
                confirmRequired: value.confirmRequired === true,
                ownerMaySubmit: value.ownerMaySubmit === true,
                ownerMayReview: value.ownerMayReview === true,
                dependencies: recordList(value.dependencies).filter(item => isRecord(item) && validId(item.nodeId)).slice(0, 100)
                    .map(item => ({ nodeId: item.nodeId, required: item.required === true }))
            };
        }

        function addTextareaField(parent, labelText, key, value, rows, required) {
            const label = el('label', 'crw-field'); label.append(el('span', 'crw-field-label', labelText + (required ? ' · 必填' : '')));
            const input = el('textarea', 'crw-textarea'); input.dataset.taskField = key; input.value = value || ''; input.rows = rows;
            input.maxLength = key === 'goal' ? 12000 : 8000;
            label.append(input); parent.append(label);
        }

        function addNumberField(parent, labelText, key, value, min, max, required, step) {
            const label = el('label', 'crw-field'); label.append(el('span', 'crw-field-label', labelText + (required ? ' · 必填' : '')));
            const input = el('input', 'crw-input'); input.type = 'number'; input.dataset.taskField = key;
            input.min = String(min); input.max = String(max); input.step = step || '1'; input.value = value || '';
            label.append(input); parent.append(label);
        }

        function participantEditor(node, draft) {
            const participant = draft.participants.find(item => item.nodeId === node.id);
            if (!participant) return el('div');
            const row = el('fieldset', 'crw-participant'); row.dataset.participant = node.id;
            const legend = el('legend', '', nodeTitle(node)); row.append(legend);
            const level = el('label', 'crw-field'); level.append(el('span', 'crw-field-label', '本次参与'));
            const select = el('select', 'crw-select'); select.dataset.participantField = 'participation'; select.dataset.nodeId = node.id;
            appendOption(select, 'required', '必交'); appendOption(select, 'optional', '可选'); appendOption(select, 'excluded', '不参与');
            select.value = participant.participation; level.append(select); row.append(level);
            const reviewer = el('label', 'crw-field'); reviewer.append(el('span', 'crw-field-label', '检查角色'));
            const reviewerSelect = el('select', 'crw-select'); reviewerSelect.dataset.participantField = 'reviewerNodeId'; reviewerSelect.dataset.nodeId = node.id;
            appendOption(reviewerSelect, '', '不指定角色检查');
            state.nodes.filter(item => item.id !== node.id).forEach(item => appendOption(reviewerSelect, item.id, nodeTitle(item)));
            reviewerSelect.value = participant.reviewerNodeId || ''; reviewer.append(reviewerSelect); row.append(reviewer);
            row.append(checkRow('交付后需要本人确认', 'confirmRequired', node.id, participant.confirmRequired));
            row.append(checkRow('允许本人代为提交', 'ownerMaySubmit', node.id, participant.ownerMaySubmit));
            row.append(checkRow('允许本人代为检查', 'ownerMayReview', node.id, participant.ownerMayReview));
            const dependencies = el('details', 'crw-dependencies'); dependencies.dataset.dependencies = node.id;
            rememberDetails(dependencies, 'dependencies:' + taskDraftKey(draft) + ':' + node.id);
            dependencies.append(el('summary', '', '材料依赖 · ' + participant.dependencies.length));
            if (dependencies.open) buildDependencies(dependencies, draft);
            row.append(dependencies);
            return row;
        }

        function checkRow(labelText, field, nodeId, checked) {
            const label = el('label', 'crw-check-row');
            const input = el('input'); input.type = 'checkbox'; input.checked = checked === true;
            input.dataset.participantField = field; input.dataset.nodeId = nodeId;
            label.append(input, el('span', '', labelText)); return label;
        }

        function buildDependencies(container, draft) {
            if (container.dataset.built === 'true') return;
            container.dataset.built = 'true';
            const targetId = container.dataset.dependencies;
            const target = draft.participants.find(item => item.nodeId === targetId);
            if (!target) return;
            const activeIds = new Set(draft.participants.filter(item => item.participation !== 'excluded').map(item => item.nodeId));
            state.nodes.filter(node => node.id !== targetId && activeIds.has(node.id)).forEach(node => {
                const prior = target.dependencies.find(item => item.nodeId === node.id);
                const row = el('div', 'crw-dependency-row');
                const label = el('label', 'crw-check-row');
                const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.dataset.dependency = node.id; checkbox.dataset.targetNode = targetId;
                checkbox.checked = Boolean(prior); label.append(checkbox, el('span', '', nodeTitle(node))); row.append(label);
                const required = el('select', 'crw-select crw-select--compact'); required.dataset.dependencyRequired = node.id; required.dataset.targetNode = targetId;
                appendOption(required, 'true', '必需'); appendOption(required, 'false', '可选'); required.value = prior?.required === false ? 'false' : 'true';
                required.disabled = !prior; row.append(required); container.append(row);
            });
            if (!container.querySelector('.crw-dependency-row')) container.append(el('p', 'crw-muted', '先将其他角色设为必交或可选，才能建立材料依赖。'));
        }

        function fillActiveOptions(select, participants, selected) {
            select.replaceChildren();
            recordList(participants).filter(item => item.participation !== 'excluded').forEach(item => {
                const node = state.nodes.find(candidate => candidate.id === item.nodeId);
                if (node) appendOption(select, node.id, nodeTitle(node));
            });
            select.value = selected || '';
        }

        function openModal(kind, content, anchor) {
            persistView(); closeModal();
            const ctx = currentContext();
            state.modalKind = kind; state.modalContent = content; state.modalContext = ctx;
            const title = content.querySelector('h2'); if (title) title.id = 'crw-dialog-title';
            bindEvents(content);
            state.modal = bridge.dialog({
                className: 'canvas-role-workflow-dialog',
                labelledBy: 'crw-dialog-title', content, anchor,
                onDismiss: () => dismissModal(content, ctx)
            });
            updatePendingControls();
            (content.querySelector('textarea, input, select, button') || title)?.focus();
        }

        async function dismissModal(content, ctx) {
            if (state.modalContent !== content || !isCurrent(ctx)) return;
            if (state.taskSaving || state.actionSaving) { bridge.notice?.('正在确认原操作结果，请先等待回执。', 'info'); return; }
            const dirty = state.modalKind === 'task' ? state.taskDraftDirty : state.actionDraftDirty && state.actionDraft?.kind === state.modalKind;
            persistView();
            if (dirty && !await bridge.confirm({ title: '保留草稿并关闭？', message: '未提交内容会保留在当前账号和画布的草稿中。', confirmText: '保留草稿并关闭' })) return;
            if (state.modalContent === content && isCurrent(ctx)) closeModal();
        }

        function openTaskDialog(existingRun) {
            persistView();
            state.taskDraftError = '';
            const key = existingRun?.id || 'new:' + state.selectedNodeId;
            if (!state.taskDraft || taskDraftKey(state.taskDraft) !== key) {
                const saved = state.drafts.tasks[key];
                state.taskDraft = saved ? copyJson(saved.draft) : null; state.taskDraftDirty = Boolean(saved);
            }
            if (state.taskDraft) state.nodes.forEach(node => {
                if (!state.taskDraft.participants.some(item => item.nodeId === node.id)) state.taskDraft.participants.push({
                    nodeId: node.id, participation: 'excluded', reviewerNodeId: null, confirmRequired: false,
                    ownerMaySubmit: false, ownerMayReview: false, dependencies: [] });
            });
            appendTaskDialog(existingRun || null);
        }

        async function openTaskSettings(existingRun) {
            const ctx = currentContext(), detail = currentDetail(), sequence = state.sequence;
            if (ctx.writable === false || !ctx.userId || !ctx.documentId) throw new Error('当前画布只读，不能配置任务。');
            if (existingRun && (!taskUpdateAvailable(detail) || detail.run.id !== existingRun.id)) throw new Error('历史工作或归档画布不能修改任务。');
            await loadNodes(ctx);
            if (!isCurrent(ctx, sequence) || currentDetail() !== detail) return;
            if (existingRun && !taskUpdateAvailable(detail)) return;
            openTaskDialog(existingRun);
        }

        function showTextDialog(kind, title, prompt, required, actionName) {
            const meta = workMeta(currentDetail());
            if (!meta) throw new Error('请先读取当前工作。');
            const saved = state.drafts.actions[meta.workId + ':' + kind];
            if (!state.actionDraft || state.actionDraft.kind !== kind || state.actionDraft.meta.workId !== meta.workId) {
                state.actionDraft = saved ? copyJson(saved) : { kind, value: '', meta, required };
                state.actionDraftDirty = Boolean(saved);
            }
            const content = el('div', 'crw-dialog-content');
            content.append(el('h2', 'crw-dialog-title', title));
            content.append(el('p', 'crw-dialog-copy', prompt));
            const input = el('textarea', 'crw-textarea'); input.rows = 5; input.maxLength = kind === 'work-return' ? 16000 : 8000;
            input.dataset.actionText = kind; input.setAttribute('aria-label', title);
            input.value = state.actionDraft.value;
            content.append(input);
            if (!matchesMeta(state.actionDraft.meta, currentDetail())) content.append(renderDraftConflict('action'));
            const error = el('p', 'crw-message crw-message--error'); error.dataset.actionError = ''; error.hidden = true; content.append(error);
            const footer = el('div', 'crw-dialog-footer');
            footer.append(button('取消', 'dialog-cancel', 'quiet'));
            const submit = button(actionName, 'submit-text-action', 'primary', 'send');
            submit.disabled = !matchesMeta(state.actionDraft.meta, currentDetail()); footer.append(submit);
            content.append(footer);
            state.actionDraft.required = required;
            openModal(kind, content);
        }

        function closeModal() {
            const modal = state.modal;
            const content = state.modalContent;
            state.modal = null; state.modalKind = ''; state.modalContent = null; state.modalContext = null;
            previewControllers.forEach(controller => controller.abort()); previewControllers.clear();
            content?.querySelectorAll('video, audio').forEach(media => { media.pause(); media.removeAttribute('src'); media.load(); });
            content?.replaceChildren();
            if (modal?.close) { try { modal.close(); } catch { /* Already dismissed by the shared modal host. */ } }
        }

        function handleInput(event) {
            const target = event.target;
            if (!isEventSurface(target)) return;
            if (target.matches('[data-editor="main"]')) {
                state.editorDraft = target.value; state.editorDirty = true;
            } else if (target.matches('[data-required-item]')) {
                state.editorItems[target.dataset.requiredItem] = target.value; state.editorDirty = true;
            } else if (target.matches('[data-message]')) {
                state.messageDraft = target.value; state.messageDirty = true;
            } else if (target.matches('[data-action-text]') && state.actionDraft) {
                state.actionDraft.value = target.value; state.actionDraftDirty = true;
            } else if (target.matches('[data-task-field]')) {
                updateTaskDraftField(target.dataset.taskField, target.type === 'checkbox' ? target.checked : target.value); state.taskDraftDirty = true;
            }
            persistView();
        }

        function handleChange(event) {
            const target = event.target;
            if (!isEventSurface(target)) return;
            if (target.matches('[data-action="select-work"]')) { handleClick(event); return; }
            if (target.matches('[data-message-from]')) { state.messageFrom = target.value; state.messageDirty = true; }
            if (target.matches('[data-task-field]')) { updateTaskDraftField(target.dataset.taskField, target.type === 'checkbox' ? target.checked : target.value); state.taskDraftDirty = true; }
            if (target.matches('[data-participant-field]')) {
                const participant = state.taskDraft?.participants.find(item => item.nodeId === target.dataset.nodeId);
                if (!participant) return;
                const key = target.dataset.participantField;
                participant[key] = target.type === 'checkbox' ? target.checked : (key === 'reviewerNodeId' ? target.value || null : target.value);
                state.taskDraftDirty = true;
                if (key === 'participation') refreshTaskRoleOptions();
            }
            if (target.matches('[data-material-id]')) {
                const id = target.dataset.materialId;
                state.taskDraft.materialNodes = target.checked
                    ? unique([...state.taskDraft.materialNodes, id])
                    : state.taskDraft.materialNodes.filter(item => item !== id);
                state.taskDraftDirty = true;
            }
            if (target.matches('[data-dependency]')) updateDependency(target);
            if (target.matches('[data-dependency-required]')) updateDependencyRequirement(target);
            persistView();
        }

        function unique(values) { return [...new Set(values)]; }

        function updateTaskDraftField(key, value) {
            if (!state.taskDraft) return;
            if (['goal', 'criteria', 'finalNodeId', 'max_rounds', 'max_calls', 'wait_limit_seconds', 'budget_points_limit', 'budget_usd', 'refresh_materials'].includes(key)) state.taskDraft[key] = value;
        }

        function updateDependency(target) {
            const participant = state.taskDraft?.participants.find(item => item.nodeId === target.dataset.targetNode);
            if (!participant) return;
            const prior = participant.dependencies.find(item => item.nodeId === target.dataset.dependency);
            if (target.checked && !prior) participant.dependencies.push({ nodeId: target.dataset.dependency, required: true });
            if (!target.checked && prior) participant.dependencies = participant.dependencies.filter(item => item.nodeId !== target.dataset.dependency);
            const required = target.closest('[data-dependencies]')?.querySelector('[data-dependency-required="' + CSS.escape(target.dataset.dependency) + '"][data-target-node="' + CSS.escape(target.dataset.targetNode) + '"]');
            if (required) required.disabled = !target.checked;
            state.taskDraftDirty = true;
            const details = target.closest('[data-dependencies]');
            const summary = details?.querySelector('summary');
            if (summary) summary.textContent = '材料依赖 · ' + participant.dependencies.length;
        }

        function updateDependencyRequirement(target) {
            const participant = state.taskDraft?.participants.find(item => item.nodeId === target.dataset.targetNode);
            const dependency = participant?.dependencies.find(item => item.nodeId === target.dataset.dependency);
            if (dependency) { dependency.required = target.value !== 'false'; state.taskDraftDirty = true; }
        }

        function refreshTaskRoleOptions() {
            if (!state.taskDraft || !state.modal?.dialog) return;
            const finalSelect = state.modal.dialog.querySelector('[data-task-field="finalNodeId"]');
            if (finalSelect) fillActiveOptions(finalSelect, state.taskDraft.participants, state.taskDraft.finalNodeId);
            state.modal.dialog.querySelectorAll('[data-participant-field="reviewerNodeId"]').forEach(select => {
                const current = select.value, nodeId = select.dataset.nodeId;
                select.replaceChildren(); appendOption(select, '', '不指定角色检查');
                state.taskDraft.participants.filter(item => item.participation !== 'excluded' && item.nodeId !== nodeId).forEach(item => {
                    const node = state.nodes.find(candidate => candidate.id === item.nodeId);
                    if (node) appendOption(select, node.id, nodeTitle(node));
                });
                select.value = current;
                if (current && ![...select.options].some(option => option.value === current)) select.value = '';
            });
            state.modal.dialog.querySelectorAll('[data-dependencies]').forEach(details => {
                details.querySelectorAll('.crw-dependency-row, .crw-muted').forEach(row => row.remove());
                delete details.dataset.built;
                if (details.open) buildDependencies(details, state.taskDraft);
            });
        }

        function handleKeydown(event) {
            if (!isEventSurface(event.target)) return;
            const tab = event.target.closest('[role="tab"]');
            if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const tabs = [...tab.parentElement.querySelectorAll('[role="tab"]')];
            const index = tabs.indexOf(tab);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            state.tab = tabs[next].dataset.tab; persistView(); render();
            state.root.querySelector('[data-tab="' + state.tab + '"]')?.focus();
        }

        async function handleClickAsync(event) {
            const target = event.target.closest('[data-action]');
            if (!target || !isEventSurface(target) || target.disabled) return;
            const action = target.dataset.action;
            if (action.startsWith('draft-')) { await resolveDraft(target); return; }
            if (action === 'tab') {
                const tab = target.dataset.tab;
                if (!['work', 'talk', 'history'].includes(tab)) return;
                state.tab = tab; persistView(); render(); return;
            }
            if (action === 'close') { await close(); return; }
            if (action === 'return-library') { await bridge.openLibrary(); return; }
            if (action === 'reset-view') {
                if (!await confirmDiscard()) return;
                persistView(); closeModal(); clearTransientDrafts(); state.tab = 'work'; state.expanded = {};
                state.selectedWorkId = ''; state.detail = null; persistView(); await refresh(); return;
            }
            if (action === 'refresh') { await refresh(); return; }
            if (action === 'history-work') {
                const id = target.dataset.workId;
                const detail = currentDetail();
                if (!validId(id) || id !== detail?.summary?.current_work_id && !recordList(detail?.node_work_history).some(work => work.id === id)) {
                    throw new Error('历史工作不属于当前角色任务。');
                }
                await switchWork(id); state.tab = 'history'; persistView(); render(); return;
            }
            if (action === 'load-work-history') { await loadWorkHistory(); return; }
            if (action === 'load-more') { await loadPage({ append: true }); return; }
            if (action === 'select-work') { if (event.type === 'change') await switchWork(target.value); return; }
            if (action === 'open-work') {
                const nodeId = target.dataset.nodeId, workId = target.dataset.workId;
                if (!await confirmDiscard('打开另一项工作会放弃当前未提交的文字。')) return;
                persistView(); closeModal(); clearTransientDrafts(); state.mode = 'role'; state.selectedNodeId = nodeId; state.tab = 'work';
                state.selectedWorkId = workId; persistView(); render(); await loadPage({ append: false }); return;
            }
            if (action === 'task-settings' || action === 'new-task') {
                const run = action === 'task-settings' ? currentDetail()?.run || runForWork(currentDetail()?.work) : null;
                await openTaskSettings(run || null); return;
            }
            if (action === 'open-creator') { bridge.openCreator?.({ documentId: state.ctx.documentId, returnTo: 'role-work' }); return; }
            if (action === 'dialog-cancel') {
                await dismissModal(state.modalContent, state.modalContext); return;
            }
            if (action === 'dialog-readonly-close') { closeModal(); return; }
            if (action === 'save-task') { await saveTask(target); return; }
            if (action === 'submit-text-action') { await submitTextAction(target); return; }
            if (action === 'recover-receipt') { await queryPendingReceipt(target); return; }
            if (action === 'query-attempt') { await queryAttempt(target); return; }
            if (action === 'load-attempts') { await loadAttempts(); return; }
            if (action === 'view-attempt') { await openAttempt(target); return; }
            if (action === 'view-input') { openInputDelivery(target); return; }
            if (action === 'view-delivery') { openDelivery(target.dataset.deliveryId); return; }
            if (action === 'view-adopted') { await openAdoptedDelivery(target); return; }
            if (action === 'view-revision-source') { openRevisionSource(); return; }
            if (action === 'preview-attachment') { await previewAttachment(target); return; }
            if (action === 'add-attachment') { await addAttachment(target); return; }
            if (action === 'remove-attachment' || action === 'retain-attachment') { changeAttachment(target); return; }
            if (action === 'load-events') { await loadEarlierEvents(); return; }
            if (action === 'send-message') { await sendMessage(target); return; }
            if (action === 'work-accept') { await runAction('accept'); return; }
            if (action === 'work-reject') { showTextDialog('work-reject', '拒绝本次任务', '说明无法接收的原因。', true, '拒绝任务'); return; }
            if (action === 'work-request-material') { showTextDialog('work-request-material', '申请补充材料', '说明缺少什么，以及需要哪项画布材料。', true, '提交申请'); return; }
            if (action === 'work-draft') { await saveWorkDraft(target); return; }
            if (action === 'work-submit') { await submitWork(target); return; }
            if (action === 'work-approve') { await approveWork(); return; }
            if (action === 'work-return') { showTextDialog('work-return', '退回修订', '写清当前成果版本需要修改的内容。旧稿会保留。', true, '退回修订'); return; }
            if (action === 'work-revise') {
                const ctx = currentContext(), meta = workMeta(currentDetail());
                if (await bridge.confirm({ title: '继续修订？', message: '将重开当前角色及依赖它的下游；独立分支保留。已交付成果和费用记录继续留在历史中，修订次数不会自动增加。', confirmText: '新开修订轮' })) {
                    assertWorkUnchanged(ctx, meta); await performWorkAction('revise', {}, meta);
                }
                return;
            }
            if (action === 'run-pause') {
                const ctx = currentContext(), meta = workMeta(currentDetail());
                if (await bridge.confirm({ title: '暂停本次任务？', message: '暂停会停止新的调用，不代表已发请求被取消或退款。', confirmText: '暂停任务' })) {
                    assertWorkUnchanged(ctx, meta); await performWorkAction('pause', {}, meta);
                }
                return;
            }
            if (action === 'run-resume') { await runAction('resume'); return; }
            if (action === 'work-execute') { await executeWork(target); return; }
        }

        function handleClick(event) {
            const ctx = currentContext(), workId = state.selectedWorkId, modal = state.modalContent;
            Promise.resolve(handleClickAsync(event)).catch(error => {
                if (!isCurrent(ctx) || state.selectedWorkId !== workId) return;
                if (modal && state.modalContent === modal) {
                    const field = modal.querySelector('[data-action-error], [data-task-error]');
                    if (field) { field.textContent = normalizeError(error).message; field.hidden = false; return; }
                }
                state.error = normalizeError(error).message; render();
            });
        }

        async function switchWork(workId) {
            if (!await confirmDiscard('切换任务会放弃当前未提交的文字。')) return;
            persistView(); closeModal(); clearTransientDrafts(); state.selectedWorkId = workId; state.detail = null;
            state.eventCursor = null; state.extraEvents = []; persistView(); render(); await loadSelectedDetail();
        }

        function collectRequirements(draft) {
            draft = draft || state.taskDraft;
            const active = draft.participants.filter(item => item.participation !== 'excluded');
            const nodeIds = new Set(active.map(item => item.nodeId));
            const participants = active.map(item => ({
                nodeId: item.nodeId, participation: item.participation,
                reviewerNodeId: item.reviewerNodeId && nodeIds.has(item.reviewerNodeId) ? item.reviewerNodeId : null,
                confirmRequired: item.confirmRequired === true,
                ownerMaySubmit: item.ownerMaySubmit === true,
                ownerMayReview: item.ownerMayReview === true,
                dependencies: recordList(item.dependencies).filter(dep => nodeIds.has(dep.nodeId) && dep.nodeId !== item.nodeId)
                    .map(dep => ({ nodeId: dep.nodeId, required: dep.required === true }))
            }));
            return {
                goal: clean(draft.goal), criteria: clean(draft.criteria), participants,
                finalNodeId: draft.finalNodeId, endpoint: 'owner_result', decisionOwnerId: state.ctx.userId,
                materialNodes: unique(draft.materialNodes.filter(id => state.materials.some(item => item.id === id)))
            };
        }

        function validateRequirements(req, draft) {
            if (!req.goal) return '请填写本次任务目标。';
            if (req.goal.length > 12000 || req.criteria.length > 8000) return '任务目标最多 12,000 字，验收要求最多 8,000 字。';
            if (!req.participants.length) return '请至少选择一个参与角色。';
            if (req.participants.some(item => !state.nodes.some(node => node.id === item.nodeId))) return '参与角色已移除，请明确调整参与设置后再保存。';
            if (draft.materialNodes.some(id => !state.materials.some(item => item.id === id))) return '所选画布材料已移除，请明确调整材料选择后再保存。';
            if (!req.participants.some(item => item.nodeId === req.finalNodeId)) return '请选择当前参与任务的最终交付角色。';
            for (const participant of req.participants) {
                if (participant.reviewerNodeId === participant.nodeId) return '执行角色和检查角色不能相同。';
                if (participant.dependencies.some(dep => !req.participants.some(item => item.nodeId === dep.nodeId))) return '材料依赖必须来自本次参与的角色。';
            }
            const byId = new Map(req.participants.map(item => [item.nodeId, item]));
            const visiting = new Set(), visited = new Set();
            function visit(id) {
                if (visiting.has(id)) return false;
                if (visited.has(id)) return true;
                visiting.add(id);
                const participant = byId.get(id);
                for (const dep of participant?.dependencies || []) if (!visit(dep.nodeId)) return false;
                visiting.delete(id); visited.add(id); return true;
            }
            for (const item of req.participants) if (!visit(item.nodeId)) return '材料依赖不能形成循环；交流与检查关系不受影响。';
            return validateTaskLimits(draft);
        }

        function validateTaskLimits(draft) {
            const rounds = finiteInteger(draft.max_rounds, 1, 100);
            if (!rounds) return '修订轮次必须为 1 到 100 的整数。';
            const calls = finiteInteger(draft.max_calls, 1, 1000);
            if (draft.max_calls !== '' && !calls) return '模型调用次数必须为空或 1 到 1000 的整数。';
            const wait = draft.wait_limit_seconds === '' ? null : finiteInteger(draft.wait_limit_seconds, 1, 31536000);
            if (draft.wait_limit_seconds !== '' && !wait) return '等待上限必须是有效秒数。';
            if (draft.budget_points_limit !== '' && (!/^\d+(?:\.\d{1,2})?$/.test(draft.budget_points_limit)
                || scaledAmount(draft.budget_points_limit, 100, 1000000) === null)) return '本站点点数上限为 0 到 1,000,000 点，最多两位小数。';
            if (draft.budget_usd !== '' && (!/^\d+(?:\.\d{1,6})?$/.test(draft.budget_usd)
                || scaledAmount(draft.budget_usd, 1000000, 1000) === null)) return '上游美元上限为 0 到 1,000 美元，最多六位小数。';
            return '';
        }

        async function saveTask(target) {
            if (state.taskSaving || !state.taskDraft) return;
            let req = collectRequirements();
            const draft = state.taskDraft;
            const limitsOnly = Boolean(draft.runId && target.dataset.updateKind === 'limits');
            if (draft.runId && !taskUpdateAvailable(currentDetail())) throw new Error('此工作不能修改任务，请读取当前工作或恢复画布权限。');
            if (state.pendingMutation) throw new Error('原操作尚未确认，请先查询原回执。');
            if (state.taskConflict || draft.runId && draft.baseRevision !== Number(currentDetail()?.run?.revision)) {
                state.taskConflict = true; state.taskDraftError = '任务版本已变化，请先处理原草稿冲突。'; renderTaskError(); return;
            }
            const validation = limitsOnly ? validateTaskLimits(draft) : validateRequirements(req, draft);
            if (validation) { state.taskDraftError = validation; renderTaskError(); return; }
            const documentContext = currentContext(), content = state.modalContent, nodeId = draft.nodeId;
            persistView();
            state.taskSaving = true; state.taskDraftError = ''; target.disabled = true;
            content?.querySelectorAll('[data-action="save-task"]').forEach(control => { control.disabled = true; });
            const form = content?.querySelector('[data-task-form]'); if (form) form.inert = true;
            try {
                const saved = await bridge.saveDocument('role-task-requirements');
                if (!isCurrent(documentContext) || state.taskDraft !== draft || state.modalContent !== content || state.selectedNodeId !== nodeId) return;
                if (!saved || saved.userId !== documentContext.userId
                    || saved.projectId !== documentContext.projectId || saved.documentId !== documentContext.documentId
                    || saved.contextEpoch !== documentContext.contextEpoch) throw new Error('画布尚未保存确认，本次任务要求未提交。');
                await loadNodes(documentContext);
                if (!isCurrent(documentContext) || state.taskDraft !== draft || state.modalContent !== content || state.selectedNodeId !== nodeId) return;
                if (draft.runId && (!taskUpdateAvailable(currentDetail()) || draft.baseRevision !== Number(currentDetail()?.run?.revision))) {
                    state.taskConflict = true; throw new Error('任务版本已变化，原设置草稿保留，请先处理冲突。');
                }
                req = collectRequirements(draft);
                if (saved.documentRevision !== currentContext().documentRevision) throw new Error('画布保存版本已变化，原任务设置保留，请重读后再保存。');
                const currentValidation = limitsOnly ? validateTaskLimits(draft) : validateRequirements(req, draft);
                if (currentValidation) throw new Error(currentValidation);
                const payload = {
                    document_id: saved.documentId,
                    document_revision: saved.documentRevision,
                    ...(limitsOnly ? { update_kind: 'limits' } : { requirements: req, ...(draft.runId && draft.refresh_materials === true ? { refresh_materials: true } : {}) }),
                    max_rounds: Number(draft.max_rounds),
                    max_calls: draft.max_calls === '' ? null : Number(draft.max_calls),
                    wait_limit_seconds: draft.wait_limit_seconds === '' ? null : Number(draft.wait_limit_seconds),
                    budget_points_limit: draft.budget_points_limit === '' ? null : scaledAmount(draft.budget_points_limit, 100, 1000000) / 100,
                    budget_usd_micros_limit: draft.budget_usd === '' ? null : scaledAmount(draft.budget_usd, 1000000, 1000)
                };
                if (draft.runId) payload.base_revision = draft.baseRevision;
                const result = await sendMutation(apiUrl('/role-runs' + (draft.runId ? '/' + encodeURIComponent(draft.runId) : '')),
                    payload, draft.runId ? 'task_update' : 'task_create');
                if (!result || !isCurrent(documentContext) || state.taskDraft !== draft || state.modalContent !== content) return;
                const work = recordList(result.works || result.result?.works).find(item => item.node_id === nodeId);
                state.selectedWorkId = work?.id || '';
                if (limitsOnly && taskHasRequirementEdits(draft)) {
                    state.taskDraftDirty = true; state.taskConflict = true;
                    bridge.notice?.('限额已保存；其他任务设置仍是原版本草稿，未更新材料或工作。', 'success');
                } else {
                    delete state.drafts.tasks[taskDraftKey(draft)]; state.taskDraft = null; state.taskDraftDirty = false;
                }
                state.taskSaving = false;
                persistView(); closeModal();
                await refresh();
            } catch (error) {
                if (!isCurrent(documentContext) || state.taskDraft !== draft || state.modalContent !== content) return;
                state.taskSaving = false; state.taskDraftError = normalizeError(error).message;
                if (error.code === 'revision_conflict' || error.data?.code === 'revision_conflict') state.taskConflict = true;
                target.disabled = false; persistView(); renderTaskError();
            } finally {
                if (isCurrent(documentContext) && state.taskDraft === draft) {
                    state.taskSaving = false;
                    if (state.modalContent === content) content?.querySelectorAll('[data-action="save-task"]').forEach(control => { control.disabled = state.taskConflict; });
                    if (form) form.inert = false;
                }
            }
        }

        function renderTaskError() {
            const error = state.modalContent?.querySelector('[data-task-error]');
            if (error) { error.textContent = state.taskDraftError; error.hidden = !state.taskDraftError; }
            if (currentDetail()) syncDialogConflict(currentDetail());
        }

        function taskHasRequirementEdits(draft) {
            const detail = currentDetail();
            if (!detail || detail.run.id !== draft.runId || draft.refresh_materials === true) return true;
            const baseline = createTaskDraft(detail.run, parseJson(detail.requirements, {}));
            return JSON.stringify(collectRequirements(draft)) !== JSON.stringify(collectRequirements(baseline));
        }

        function adoptTaskReceipt(pending, result) {
            if (!pending?.kind.startsWith('task_') || !pending.draftKey || !pending.payload || !validId(result?.run?.id)
                || result.run.document_id !== state.ctx.documentId) return;
            const key = pending.draftKey, saved = state.drafts.tasks[key];
            const active = state.taskDraft && taskDraftKey(state.taskDraft) === key;
            const draft = active ? state.taskDraft : saved?.draft;
            if (!draft) return;
            const body = pending.payload;
            const unchanged = (body.update_kind === 'limits' ? !taskHasRequirementEdits(draft)
                : JSON.stringify(collectRequirements(draft)) === JSON.stringify(body.requirements) && (draft.refresh_materials === true) === (body.refresh_materials === true))
                && Number(draft.max_rounds) === body.max_rounds
                && (draft.max_calls === '' ? null : Number(draft.max_calls)) === body.max_calls
                && (draft.wait_limit_seconds === '' ? null : Number(draft.wait_limit_seconds)) === body.wait_limit_seconds
                && (draft.budget_points_limit === '' ? null : Number(draft.budget_points_limit)) === body.budget_points_limit
                && (draft.budget_usd === '' ? null : scaledAmount(draft.budget_usd, 1000000, 1000)) === body.budget_usd_micros_limit;
            delete state.drafts.tasks[key];
            if (active) state.selectedWorkId = recordList(result.works).find(work => work.node_id === draft.nodeId)?.id || '';
            if (unchanged) {
                if (active) {
                    state.taskDraft = null; state.taskDraftDirty = false; state.taskSaving = false;
                    if (state.modalKind === 'task') closeModal();
                }
            } else {
                // Bind later edits to the acknowledged task without silently changing their original base revision.
                draft.runId = result.run.id;
                state.drafts.tasks[taskDraftKey(draft)] = { draft: copyJson(draft), updatedAt: Date.now() };
                if (active) { state.taskDraftDirty = true; state.taskSaving = false; state.taskConflict = true; }
            }
            persistView();
        }

        async function queryPendingReceipt(target) {
            const ctx = currentContext(), pending = state.pendingMutation; target.disabled = true;
            try {
                const result = await recoverReceipt(ctx, pending);
                if (!isCurrent(ctx)) return;
                if (result) {
                    adoptTaskReceipt(pending, result);
                    notifyBillingSettled(result);
                    bridge.notice?.('已找到原操作回执，将重读实际状态；预留回执不代表 AI 成果已完成。', 'success');
                    await refresh();
                    if (isCurrent(ctx) && state.modalKind === 'task' && state.taskConflict) {
                        const run = currentDetail()?.run;
                        appendTaskDialog(run?.id === state.taskDraft?.runId ? run : result.run);
                    }
                } else bridge.notice?.('尚未找到可确认的原回执；未重发操作。请稍后再查。', 'warning');
            } finally { if (isCurrent(ctx)) target.disabled = false; }
        }

        async function queryAttempt(target) {
            const ctx = currentContext(), detail = currentDetail(), sequence = state.sequence, workId = state.selectedWorkId, id = target.dataset.attemptId;
            if (!validId(id) || !recordList(detail?.attempts).some(attempt => attempt.id === id)) throw new Error('原调用不在当前工作中。');
            target.disabled = true;
            try {
                const result = await requestJson(apiUrl('/role-attempts/' + encodeURIComponent(id)), { method: 'POST', payload: {} });
                if (!isCurrent(ctx, sequence) || currentDetail() !== detail) return;
                notifyBillingSettled(result, id);
                const read = await requestJson(apiUrl('/role-attempts/' + encodeURIComponent(id)), { method: 'GET' });
                if (!isCurrent(ctx, sequence) || currentDetail() !== detail) return;
                if (read?.attempt?.id !== id || read.attempt.work_id !== workId) throw new Error('原调用的账单身份不匹配。');
                const attempt = read.attempt;
                detail.attempts = mergeById(detail.attempts, [{ ...attempt, result_available: Boolean(attempt.result_json), result_json: undefined }]);
                notifyBillingSettled(attempt, id);
                if (state.modalContent?.contains(target)) target.closest('.crw-cost-row')?.replaceWith(renderAttemptRow(attempt, false));
                await refresh();
            } finally { if (isCurrent(ctx) && state.selectedWorkId === workId) target.disabled = false; }
        }

        async function openAttempt(target) {
            const ctx = currentContext(), detail = currentDetail(), sequence = state.sequence, modal = state.modalContent;
            const id = target.dataset.attemptId;
            if (!validId(id) || !recordList(detail?.attempts).some(attempt => attempt.id === id)) throw new Error('原调用不属于当前工作。');
            target.disabled = true;
            try {
                const result = await requestJson(apiUrl('/role-attempts/' + encodeURIComponent(id)), { method: 'GET' });
                if (!isCurrent(ctx, sequence) || currentDetail() !== detail || state.modalContent !== modal) return;
                const attempt = result?.attempt;
                if (attempt?.id !== id || attempt.work_id !== detail.work.id) throw new Error('原调用回执的工作身份不匹配。');
                notifyBillingSettled(attempt, id);
                const content = el('div', 'crw-dialog-content'); content.append(el('h2', 'crw-dialog-title', '原调用回执'));
                content.append(recordDetails([['调用编号', id], ['请求编号', attempt.request_id]]));
                content.append(renderAttemptRow(attempt, false));
                const reply = parseJson(attempt.result_json, null);
                if (reply) {
                    content.append(summaryRow('实际模型', textOf(reply.model, '原回执未提供')));
                    if (attempt.purpose === 'review') content.append(panelMessage('这是原 AI 检查建议，不是人工通过或本人确认。', 'quiet'));
                    if (attempt.state === 'not_adopted') content.append(panelMessage('真实回复已保存，但未采纳为有效成果。', 'warning'));
                    appendReadonlyContent(content, isRecord(reply) && Object.prototype.hasOwnProperty.call(reply, 'content')
                        ? parseJson(reply.content, {}) : isRecord(reply) ? reply : {});
                } else content.append(panelMessage('尚无可确认的原回复；预留或发送回执不代表成果完成，不会自动重发。', 'quiet'));
                const finished = el('p', 'crw-muted'); addTime(finished, attempt.finished_at); content.append(finished);
                const footer = el('div', 'crw-dialog-footer'); footer.append(button('关闭', 'dialog-readonly-close', 'primary')); content.append(footer);
                openModal('attempt', content);
            } finally { if (isCurrent(ctx, sequence) && currentDetail() === detail) target.disabled = false; }
        }

        async function performWorkAction(action, extra, expectedMeta) {
            const ctx = currentContext();
            const detail = currentDetail();
            if (!detail?.work) throw new Error('当前工作已变化，请刷新后重新打开。');
            const taskControl = action === 'pause' || action === 'resume';
            if (taskControl ? !taskControlAvailable(detail) : detail.summary?.action_available === false) throw new Error(detail.summary?.action_unavailable_reason || '此工作没有当前操作权限');
            if (!taskControl && action !== 'message' && detail.run.paused) throw new Error('任务已暂停，请先继续任务；原草稿保留。');
            const meta = expectedMeta || workMeta(detail);
            assertWorkUnchanged(ctx, meta);
            const work = detail.work;
            const editor = typeof extra?.text === 'string' ? extra.text : state.editorDraft,
                items = JSON.stringify(extra?.items || state.editorItems), attachments = JSON.stringify(extra?.attachments || state.editorAttachments),
                message = state.messageDraft, from = state.messageFrom;
            const payload = Object.assign({
                base_revision: meta.workRevision,
                requirements_revision: meta.requirementsRevision,
                action
            }, extra || {});
            const result = await sendMutation(apiUrl('/role-work/' + encodeURIComponent(work.id)), payload, 'work_action', work.id);
            if (!result || !isCurrent(ctx) || state.selectedWorkId !== work.id) return null;
            const successor = result.successor || result.result?.successor;
            if (['draft', 'submit'].includes(action) && state.editorDraft === editor && JSON.stringify(state.editorItems) === items
                && JSON.stringify(state.editorAttachments) === attachments) {
                state.editorDirty = false;
            }
            if (action === 'message' && state.messageDraft === message && state.messageFrom === from) {
                state.messageDirty = false; state.messageDraft = ''; state.messageFrom = '';
            }
            if (!state.editorDirty && !state.messageDirty) delete state.drafts.works[work.id];
            if (successor?.id) state.selectedWorkId = successor.id;
            persistView(); await refresh(); return result;
        }

        async function runAction(action) {
            await performWorkAction(action, {});
        }

        function reviewProxy(detail) {
            const work = detail.work;
            if (work.phase === 'confirmation') return false;
            const participant = recordList(detail.requirements?.participants).find(item => item.nodeId === work.node_id) || {};
            const executor = reviewerExecutor(work);
            if (!executor || executor.kind === 'person' && executor.userId !== state.ctx.userId
                || executor.kind !== 'person' && participant.ownerMayReview !== true) throw new Error('指定检查者未授权本人代检查。');
            return executor.kind !== 'person' && participant.ownerMayReview === true;
        }

        async function submitTextAction(target) {
            if (state.actionSaving || !state.actionDraft) return;
            const ctx = currentContext(), draft = state.actionDraft, content = state.modalContent;
            assertWorkUnchanged(ctx, draft.meta);
            const text = draft.value.trim();
            if (draft.required && !text) throw new Error('请先填写说明。');
            if (text.length > (draft.kind === 'work-return' ? 16000 : 8000)) throw new Error('说明内容超过此操作允许的字数，请精简后提交。');
            const action = { 'work-return': 'return', 'work-reject': 'reject', 'work-request-material': 'request_material' }[draft.kind];
            if (!action) throw new Error('此操作不支持提交。');
            const extra = action === 'return' ? { delivery_id: draft.meta.deliveryId, input_digest: draft.meta.inputDigest, opinion: text } : { reason: text };
            if (action === 'return') {
                if (!extra.delivery_id || !extra.input_digest) throw new Error('当前成果与材料版本不完整，请刷新核对。');
                if (reviewProxy(currentDetail())) extra.owner_proxy = true;
            }
            const original = draft.value; state.actionSaving = true; target.disabled = true; persistView();
            try {
                const result = await performWorkAction(action, extra, draft.meta);
                if (!result || !isCurrent(ctx) || state.actionDraft !== draft || state.modalContent !== content) return;
                if (draft.value === original) {
                    delete state.drafts.actions[draft.meta.workId + ':' + draft.kind]; state.actionDraft = null; state.actionDraftDirty = false;
                    persistView(); closeModal();
                }
            } finally {
                if (isCurrent(ctx) && state.actionDraft === draft) { state.actionSaving = false; target.disabled = !matchesMeta(draft.meta, currentDetail()); }
                else if (isCurrent(ctx) && !state.actionDraft) state.actionSaving = false;
            }
        }

        async function saveWorkDraft(target) {
            const ctx = currentContext(), detail = currentDetail(), meta = state.draftMeta, text = state.editorDraft;
            assertWorkUnchanged(ctx, meta);
            const role = parseJson(detail?.work?.snapshot?.role, {});
            const participant = recordList(detail?.requirements?.participants).find(item => item.nodeId === detail?.work?.node_id) || {};
            const body = { text, items: copyJson(state.editorItems), attachments: copyJson(state.editorAttachments),
                ...(participant.ownerMaySubmit === true && role.executor?.kind !== 'person' ? { owner_proxy: true } : {}) };
            target.disabled = true;
            try {
                await prepareAttachmentWrite(ctx, meta, body.attachments);
                await performWorkAction('draft', body, meta);
            } finally { if (isCurrent(ctx)) target.disabled = false; }
        }

        async function submitWork(target) {
            const ctx = currentContext(), detail = currentDetail(), meta = state.draftMeta, text = state.editorDraft;
            assertWorkUnchanged(ctx, meta);
            if (!text.trim() && !state.editorAttachments.length) { bridge.notice?.('请填写成果正文或选择交付原件。', 'warning'); return; }
            const items = Object.create(null), role = parseJson(detail.work?.snapshot?.role, {});
            recordList(role.requiredItems).forEach(name => { items[name] = state.editorItems[name] || ''; });
            const missing = Object.entries(items).filter(([, value]) => !value.trim());
            if (missing.length) { bridge.notice?.('请填写全部必交项。', 'warning'); return; }
            const participant = recordList(detail.requirements?.participants).find(item => item.nodeId === detail.work?.node_id) || {};
            const body = { text, items, attachments: copyJson(state.editorAttachments), input_digest: meta.inputDigest,
                ...(participant.ownerMaySubmit === true && role.executor?.kind !== 'person' ? { owner_proxy: true } : {}) };
            target.disabled = true;
            try {
                await prepareAttachmentWrite(ctx, meta, body.attachments);
                await performWorkAction('submit', body, meta);
            } finally { if (isCurrent(ctx)) target.disabled = false; }
        }

        async function prepareAttachmentWrite(ctx, meta, attachments) {
            if (!recordList(attachments).some(selection => selection.nodeId)) return;
            if (state.pendingMutation) throw new Error('原操作尚未确认，请先查询原回执；交付选择保留。');
            const saved = await bridge.saveDocument('role-work-attachments');
            assertWorkUnchanged(ctx, meta);
            if (!saved || !sameContext(saved, ctx) || saved.documentRevision !== currentContext().documentRevision) throw new Error('原件所在画布尚未保存确认；原输入保留，未提交成果。');
        }

        async function approveWork() {
            const ctx = currentContext(), detail = currentDetail(), work = detail?.work, meta = workMeta(detail);
            if (!work?.current_delivery_id || !detail.input_digest) { bridge.notice?.('成果或材料版本不完整，请刷新后核对。', 'warning'); return; }
            const isReview = work.phase === 'review';
            const confirmed = await bridge.confirm({
                title: isReview ? '通过当前成果？' : '确认当前交付？',
                message: '将处理成果 v' + currentDeliveryVersion(detail) + '。其他版本的审核状态不会沿用。',
                confirmText: isReview ? '通过并继续' : '确认交付'
            });
            if (!confirmed) return;
            assertWorkUnchanged(ctx, meta);
            await performWorkAction(isReview ? 'approve' : 'confirm', {
                delivery_id: meta.deliveryId, input_digest: meta.inputDigest,
                ...(isReview && reviewProxy(detail) ? { owner_proxy: true } : {})
            }, meta);
        }

        function currentDeliveryVersion(detail) {
            const item = recordList(detail.deliveries).find(delivery => delivery.id === detail.work?.current_delivery_id);
            return Number(item?.version) || '?';
        }

        async function sendMessage(target) {
            const ctx = currentContext(), meta = state.draftMeta, text = state.messageDraft.trim(), from = state.messageFrom;
            assertWorkUnchanged(ctx, meta);
            if (!text) { bridge.notice?.('请先填写要发送的内容。', 'warning'); return; }
            target.disabled = true;
            try {
                await performWorkAction('message', {
                    to_node_id: state.selectedNodeId,
                    ...(from ? { from_node_id: from } : {}), text, category: 'message'
                }, meta);
            } finally { if (isCurrent(ctx)) target.disabled = false; }
        }

        function executeQuoteDetails(gate, run) {
            return [
                '模型：' + gate.model + ' · 报价来源：' + gate.source,
                '本次预留：' + formatPoints(gate.reservePoints) + ' 点 · 上游 ' + formatUsdMicros(gate.reserveUsdMicros),
                '本站点预算：' + formatPoints(run.budget_points_limit) + ' 点；已结算 ' + formatPoints(run.settled_points) + '，已预留 ' + formatPoints(run.reserved_points),
                '上游预算：' + formatUsdMicros(run.budget_usd_micros_limit) + '；已结算 ' + formatUsdMicros(run.settled_usd_micros) + '，已预留 ' + formatUsdMicros(run.reserved_usd_micros),
                '已用调用：' + (Number(run.call_count) || 0) + ' / ' + run.max_calls + ' 次',
                '最多输出：' + gate.maxOutputTokens.toLocaleString('zh-CN') + ' tokens',
                '报价有效至：' + new Date(gate.expiresAt).toLocaleString()
            ].join('\n');
        }

        async function executeWork(target) {
            const ctx = currentContext(), detail = currentDetail(), work = detail?.work, run = detail?.run, meta = workMeta(detail);
            const purpose = target.dataset.purpose === 'review' ? 'review' : 'work';
            if (detail?.summary?.action_available === false || run?.paused) throw new Error('此工作当前不可执行；请读取当前修订或继续任务，不会重发原请求。');
            if (state.pendingMutation) throw new Error('原操作未确认，请先查回执，不能再开始调用。');
            if (recordList(detail?.attempts).some(attempt => ['reserved', 'sending', 'unknown'].includes(attempt.state)
                || ['pending', 'unknown', 'authorization_required'].includes(attempt.fee_state))) throw new Error('当前工作有请求或费用未确认，请先查原账单。');
            const gate = executionGate(detail?.execution, purpose, run);
            if (!gate.ready) { bridge.notice?.(gate.reason, 'warning'); await refresh(); return; }
            if (work.phase === 'unknown' || work.phase === 'superseded') {
                bridge.notice?.('此工作尚不能开始新调用；请先核对原回执或当前修订。', 'warning'); return;
            }
            const approved = await bridge.confirm({
                title: purpose === 'review' ? '获取 AI 建议？' : '开始 AI 执行？',
                message: executeQuoteDetails(gate, run) + '\n\n这会产生真实模型请求。' + (purpose === 'review' ? 'AI 只给检查建议，不会代替人工通过或本人确认。' : '结果和费用分别以真实回执为准。'),
                confirmText: '按报价开始'
            });
            if (!approved) return;
            assertWorkUnchanged(ctx, meta);
            const liveGate = executionGate(currentDetail()?.execution, purpose, currentDetail()?.run);
            if (!liveGate.ready || liveGate.quoteId !== gate.quoteId || currentDetail()?.run?.revision !== run.revision) {
                throw new Error('报价、预算或已用调用次数已变化，请刷新后重新核对。');
            }
            target.disabled = true;
            const payload = {
                base_revision: meta.workRevision,
                requirements_revision: meta.requirementsRevision,
                purpose, quote_id: gate.quoteId, max_output_tokens: gate.maxOutputTokens
            };
            try {
                const result = await sendMutation(apiUrl('/role-work/' + encodeURIComponent(work.id) + '/execute'), payload, 'work_execute', work.id);
                if (result && isCurrent(ctx) && state.selectedWorkId === work.id) { notifyBillingSettled(result); await refresh(); }
            } finally { if (isCurrent(ctx)) target.disabled = false; }
        }

        async function loadAttempts() {
            const detail = currentDetail(), ctx = currentContext(), sequence = state.sequence;
            if (!validId(detail?.next_attempt_cursor) || state.loadingAttempts) return;
            state.loadingAttempts = true; render();
            try {
                const next = await requestJson(apiUrl('/role-work/' + encodeURIComponent(detail.work.id), { attempt_cursor: detail.next_attempt_cursor }), { method: 'GET' });
                if (!isCurrent(ctx, sequence) || currentDetail() !== detail) return;
                if (next?.work?.id !== detail.work.id || next.run?.id !== detail.run.id || next.run?.document_id !== ctx.documentId) throw new Error('调用分页的原工作身份不匹配。');
                const summaries = recordList(next.attempts).filter(attempt => validId(attempt?.id)).map(attempt => ({ ...attempt, result_json: undefined }));
                detail.attempts = mergeById(detail.attempts, summaries);
                detail.next_attempt_cursor = validId(next.next_attempt_cursor) ? next.next_attempt_cursor : null;
                summaries.forEach(attempt => notifyBillingSettled(attempt, attempt.id));
            } finally {
                if (isCurrent(ctx, sequence) && currentDetail() === detail) { state.loadingAttempts = false; render(); }
            }
        }

        async function loadWorkHistory() {
            const detail = currentDetail(), ctx = currentContext(), sequence = state.sequence;
            if (!detail?.next_work_cursor || state.loadingWorkHistory) return;
            state.loadingWorkHistory = true; render();
            try {
                const next = await requestJson(apiUrl('/role-work/' + encodeURIComponent(detail.work.id), { work_cursor: detail.next_work_cursor }), { method: 'GET' });
                if (!isCurrent(ctx, sequence) || currentDetail() !== detail) return;
                detail.node_work_history = mergeById(detail.node_work_history, next.node_work_history);
                detail.next_work_cursor = next.next_work_cursor || null;
            } finally {
                if (isCurrent(ctx, sequence) && currentDetail() === detail) { state.loadingWorkHistory = false; render(); }
            }
        }

        async function loadEarlierEvents() {
            const detail = currentDetail();
            if (!detail?.next_cursor || state.loadingEarlier) return;
            const before = detail.next_cursor, ctx = currentContext(), sequence = state.sequence;
            state.loadingEarlier = true; render();
            const controller = new AbortController();
            try {
                const result = await requestJson(apiUrl('/role-work/' + encodeURIComponent(detail.work.id), { cursor: before }), { method: 'GET', signal: controller.signal });
                if (!isCurrent(ctx, sequence) || currentDetail() !== detail) return;
                const nextEvents = recordList(result?.events);
                state.extraEvents = [...state.extraEvents, ...nextEvents];
                state.detail.next_cursor = result?.next_cursor || null;
                state.loadingEarlier = false; render();
            } catch (error) {
                if (isCurrent(ctx, sequence) && currentDetail() === detail) {
                    state.loadingEarlier = false; state.error = normalizeError(error).message; render();
                }
            }
        }

        async function openAdoptedDelivery(target) {
            const ctx = currentContext(), origin = currentDetail(), workId = target.dataset.workId, deliveryId = target.dataset.deliveryId;
            const receipt = origin?.summary?.final_receipt;
            if (!validId(workId) || !validId(deliveryId) || !recordList(receipt?.adopted).some(item => item.workId === workId && item.deliveryId === deliveryId)) {
                throw new Error('此成果不在当前最终采纳回执中。');
            }
            target.disabled = true;
            try {
                const detail = workId === origin.work.id ? origin : await requestJson(apiUrl('/role-work/' + encodeURIComponent(workId)), { method: 'GET' });
                if (!isCurrent(ctx) || currentDetail() !== origin) return;
                if (detail?.run?.id !== origin.run.id || detail?.work?.requirements_revision !== origin.work.requirements_revision) throw new Error('采纳成果的任务版本不匹配。');
                openDelivery(deliveryId, detail, true);
            } finally { if (isCurrent(ctx)) target.disabled = false; }
        }

        function openInputDelivery(target) {
            const detail = currentDetail();
            const input = recordList(detail?.inputs).find(item => item.sourceWorkId === target.dataset.sourceWorkId
                && item.deliveryId === target.dataset.deliveryId && String(item.version) === target.dataset.inputVersion);
            if (!input || !validId(input.sourceWorkId) || !validId(input.deliveryId)
                || !isRecord(parseJson(input.content, null))) throw new Error('此固定上游原稿不在当前工作输入中，请刷新核对；不采用最新上游替代。');
            showReadonlyDelivery({ id: input.deliveryId, version: input.version, content: input.content },
                '上游原稿 v' + input.version + ' · 本次输入');
        }

        function appendReadonlyContent(parent, contentData, deliveryId) {
            const body = el('div', 'crw-delivery-body');
            if (typeof contentData.text === 'string' && contentData.text) body.append(el('pre', 'crw-delivery-fulltext', contentData.text));
            else body.append(el('p', 'crw-muted', recordList(contentData.attachments).length ? '本成果以原件交付，无正文。' : '原回执未提供正文。'));
            if (isRecord(contentData.items)) Object.entries(contentData.items).forEach(([name, value]) => {
                body.append(el('h3', 'crw-delivery-item-title', name), el('pre', 'crw-delivery-fulltext', typeof value === 'string' ? value : JSON.stringify(value ?? '')));
            });
            if (validId(deliveryId)) recordList(contentData.attachments).slice(0, 20).forEach((attachment, index) => {
                if (!isRecord(attachment)) return;
                const row = el('section', 'crw-readonly-attachment');
                row.append(el('strong', '', textOf(attachment.title, '交付原件 ' + (index + 1)) + (attachment.type ? ' · ' + attachment.type : '')),
                    el('p', 'crw-muted', attachmentDescription(attachment, { sourceDeliveryId: deliveryId, index })),
                    attachmentRecord(attachment, { sourceDeliveryId: deliveryId, index }));
                const preview = button(['image', 'video', 'audio'].includes(attachment.type) ? '预览固定原件' : '查看固定文件', 'preview-attachment', '', 'file-text');
                const host = el('div', 'crw-attachment-preview'); host.setAttribute('aria-live', 'polite');
                attachmentViews.set(preview, { deliveryId, index, attachment: copyJson(attachment), host });
                row.append(preview, host); body.append(row);
            });
            parent.append(body);
        }

        function attachmentRoute(deliveryId, index) {
            if (!validId(deliveryId) || finiteInteger(index, 0, 19) === null) throw new Error('固定原件身份无效。');
            return apiUrl('/role-deliveries/' + encodeURIComponent(deliveryId) + '/attachments/' + Number(index));
        }

        async function previewAttachment(target) {
            const view = attachmentViews.get(target), content = state.modalContent, ctx = currentContext(), workId = state.selectedWorkId;
            if (!view || !content?.contains(target) || !isCurrent(ctx)) throw new Error('请重新打开原成果后查看固定原件。');
            const route = attachmentRoute(view.deliveryId, view.index), controller = new AbortController();
            view.controller?.abort(); view.controller = controller;
            const live = () => view.controller === controller && !controller.signal.aborted && isCurrent(ctx) && state.modalContent === content && state.selectedWorkId === workId;
            previewControllers.add(controller); target.disabled = true;
            view.host.querySelectorAll('video, audio').forEach(media => { media.pause(); media.removeAttribute('src'); media.load(); });
            view.host.replaceChildren(panelMessage('正在读取固定原件…', 'quiet'));
            const unavailable = message => {
                if (!live()) return;
                view.host.querySelectorAll('video, audio').forEach(media => { media.pause(); media.removeAttribute('src'); media.load(); });
                view.host.replaceChildren(panelMessage(message + '。原成果保持不变，不会改用当前节点或缩略图。', 'warning'));
            };
            try {
                if (view.attachment.sourceKind === 'canvas_text') {
                    const response = await fetch(route, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
                    if (!response.ok) throw new Error('固定文本原件不可用（HTTP ' + response.status + '）');
                    const text = await response.text();
                    if (!live()) return;
                    if (text.length > 100000) throw new Error('固定文本原件超过可展示长度');
                    view.host.replaceChildren(el('pre', 'crw-delivery-fulltext', text));
                } else {
                    const response = await fetch(route, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store', redirect: 'manual', signal: controller.signal });
                    if (!live()) return;
                    if (!response.ok && response.type !== 'opaqueredirect') throw new Error('固定原件不可用（HTTP ' + response.status + '）');
                    view.host.replaceChildren();
                    const kind = view.attachment.type;
                    if (['image', 'video', 'audio'].includes(kind)) {
                        const media = el(kind === 'image' ? 'img' : kind, 'crw-original-media');
                        if (kind === 'image') { media.alt = textOf(view.attachment.title, '固定交付原件'); media.loading = 'eager'; }
                        else { media.controls = true; media.preload = 'none'; if (kind === 'video') media.playsInline = true; }
                        media.addEventListener('error', () => unavailable('固定原件暂不可预览'), { once: true });
                        media.src = route; view.host.append(media);
                    } else view.host.append(el('p', 'crw-muted', '文件类型未提供内嵌预览，仅提供固定原件入口。'));
                }
                if (!live()) return;
                const links = el('div', 'crw-original-links');
                const open = el('a', 'crw-button', '查看原件'); open.href = route; open.target = '_blank'; open.rel = 'noopener noreferrer';
                const download = el('a', 'crw-button', '下载原件'); download.href = route; download.download = '';
                links.append(open, download); view.host.append(links);
            } catch (error) {
                if (live()) unavailable(error instanceof TypeError ? '固定原件的读取结果尚未确认' : normalizeError(error).message);
            } finally {
                if (live()) target.disabled = false;
                previewControllers.delete(controller);
            }
        }

        function openRevisionSource() {
            const source = currentDetail()?.revision_source;
            if (source?.readonly !== true || !validId(source.deliveryId) || !isRecord(source.content)) throw new Error('固定修订原稿暂不可读，不采用当前稿替代。');
            const content = el('div', 'crw-dialog-content'); content.append(el('h2', 'crw-dialog-title', '固定修订原稿'));
            content.append(recordDetails([['原成果', source.deliveryId]]));
            if (typeof source.opinion === 'string') content.append(summaryRow('修订意见', source.opinion));
            appendReadonlyContent(content, copyJson(source.content), source.deliveryId);
            const footer = el('div', 'crw-dialog-footer'); footer.append(button('关闭', 'dialog-readonly-close', 'primary')); content.append(footer);
            openModal('revision-source', content);
        }

        function openDelivery(deliveryId, sourceDetail, adopted) {
            const detail = sourceDetail || currentDetail();
            const delivery = recordList(detail?.deliveries).find(item => item.id === deliveryId);
            if (!delivery) { bridge.notice?.('成果版本已不在当前页面，请刷新历史。', 'warning'); return; }
            showReadonlyDelivery(delivery, '成果 v' + (Number(delivery.version) || '?') + (adopted ? ' · 已采纳'
                : delivery.id === detail.work?.current_delivery_id ? ' · 当前' : ' · 历史'));
        }

        function showReadonlyDelivery(delivery, title) {
            const contentData = parseJson(delivery.content_json || delivery.content, {});
            const content = el('div', 'crw-dialog-content');
            content.append(el('h2', 'crw-dialog-title', title));
            content.append(recordDetails([['成果编号', delivery.id]]));
            appendReadonlyContent(content, contentData, delivery.id);
            const footer = el('div', 'crw-dialog-footer'); footer.append(button('关闭', 'dialog-readonly-close', 'primary')); content.append(footer);
            openModal('delivery', content);
        }

        return { open, openPending, refresh, contextChanged, hasUnsaved, close };
    }

    return { create };
});
