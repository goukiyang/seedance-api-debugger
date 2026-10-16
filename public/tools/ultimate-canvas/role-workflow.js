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
        ai_review_recommendation: 'AI 检查建议', task_limits_changed: '任务限额已更新', branch_retained: '独立分支原成果已保留',
        collaboration_review: '成果检查', owner_result_accepted: '本人已验收', revision_waiting: '新需求等待应用',
        rule_proposed: '提出规则', rule_adopted: '采用规则', rule_verified: '规则验证记录', retained: '保留规则', reverted: '撤回规则',
        question_opened: '提出问题', question_answered: '答复问题', question_resolved: '问题已解决'
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
            editorItems: Object.create(null), editorChanges: [], editorAttachments: [], editorBaseline: null,
            messageFrom: '', draftMeta: null, draftConflict: false,
            taskConflict: false, actionSaving: false, modalContent: null, modalContext: null,
            drafts: emptyDrafts(), expanded: {}, restoredScope: '',
            billedAttempts: new Set()
        };
        const scopedMemory = new Map();
        const attachmentViews = new WeakMap();
        const previewControllers = new Set();
        const collaboration = { workflowId: '', runId: '', detail: null, runs: [], cursor: null, questionsCursor: null,
            relationMode: 'related', draft: null, dirty: false, busy: false, sequence: 0, editingRequirements: false,
            scroll: {}, drafts: {}, templates: [], templateCursor: null };
        let taskBar = null, authorizationDraft = null, collaborationReadTimer = null, mediaRefreshPending = false;
        const routing = globalThis.UltimateCanvasRoleRouting?.create({ engine: bridge.engine, context: currentContext,
            runId: () => collaboration.runId, requirementId: () => state.selectedNodeId, legacyRelations: relationsFromFlow,
            activeNodes: () => recordList(collaboration.detail?.works)
                .filter(work => ['working', 'revision', 'confirmation', 'unknown'].includes(work.phase)).map(work => work.node_id),
            save: saveCollaborationRelations, notice: (message, tone) => bridge.notice?.(message, tone) });

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
            const metadata = { ...(validId(value.sourceDigest) ? { sourceDigest: value.sourceDigest } : {}),
                ...(typeof value.outputSlotId === 'string' && value.outputSlotId.length <= 160 ? { outputSlotId: value.outputSlotId } : {}) };
            if (validId(value.mediaBindingId) && !value.nodeId && !value.sourceDeliveryId
                && validId(value.sourceDigest)) {
                return { mediaBindingId: value.mediaBindingId, ...metadata };
            }
            if (value.mediaBindingId) return null;
            if (validId(value.sourceDeliveryId) && !value.nodeId && finiteInteger(value.index, 0, 19) !== null) {
                return { sourceDeliveryId: value.sourceDeliveryId, index: Number(value.index), ...metadata };
            }
            if (!validId(value.nodeId) || value.sourceDeliveryId) return null;
            return { nodeId: value.nodeId, ...metadata };
        }
        function attachmentKey(value) {
            if (value.mediaBindingId) return 'media:' + value.mediaBindingId + ':' + value.sourceDigest;
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
            ['nodeId', 'assetId', 'referenceImageId', 'taskId', 'imageTaskId', 'mediaBindingId', 'sourceWorkId'].forEach(key => { if (validId(value[key])) snapshot[key] = value[key]; });
            if (typeof value.outputSlotId === 'string' && value.outputSlotId.length <= 160) snapshot.outputSlotId = value.outputSlotId;
            if (Number.isSafeInteger(value.sourceRequirementsRevision)) snapshot.sourceRequirementsRevision = value.sourceRequirementsRevision;
            if (typeof value.sourceDigest === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value.sourceDigest)) snapshot.sourceDigest = value.sourceDigest;
            return snapshot;
        }
        function savedEditorContent(value) {
            const content = parseJson(value, {});
            return { text: typeof content.text === 'string' ? content.text.slice(0, 100000) : '', items: boundedItems(content.items),
                changes: savedChanges(content.changes),
                attachments: recordList(content.attachments).slice(0, 20).map(attachmentSnapshot).filter(Boolean) };
        }
        function savedChanges(value) {
            return recordList(value).filter(item => typeof item === 'string').slice(0, 30).map(item => item.slice(0, 4000));
        }
        function submissionChanges() {
            if (state.editorChanges.length > 30 || state.editorChanges.some(item => typeof item !== 'string' || item.length > 4000)) {
                throw new Error('修改回应最多30条，每条不超过4000字；当前输入已保留。');
            }
            return state.editorChanges.map(item => item.trim()).filter(Boolean);
        }
        function validPending(value, ctx) {
            const kinds = ['task_create', 'task_update', 'work_action', 'work_execute', 'collaboration', 'collaboration_update'];
            if (!isRecord(value) || !validId(value.mutationId) || !kinds.includes(value.kind)
                || (value.workId && !validId(value.workId))) return null;
            if (!value.url && !value.method && !value.payload) return { mutationId: value.mutationId, kind: value.kind,
                workId: value.workId || '', receiptOnly: true,
                ...(value.kind.startsWith('collaboration') && value.documentId === ctx.documentId && Number.isSafeInteger(value.documentRevision)
                    ? { documentId: value.documentId, documentRevision: value.documentRevision,
                        workflowId: validId(value.workflowId) ? value.workflowId : '',
                        runId: validId(value.runId) ? value.runId : '', pausedWaiting: value.pausedWaiting === true,
                        submittedDraft: validCollaborationDraft(value.submittedDraft) } : {}) };
            if (value.kind.startsWith('collaboration')) {
                if (typeof value.url !== 'string' || !/^\/api\/tools\/ultimate-canvas\/(role-runs(?:\/[A-Za-z0-9_-]+(?:\/(?:control|questions|results))?)?|role-questions\/[A-Za-z0-9_-]+|role-workflow-templates(?:\/[A-Za-z0-9_-]+)?|role-attempts\/[A-Za-z0-9_-]+)$/.test(value.url)) return null;
                if (value.payload?.mutation_id !== value.mutationId) return null;
                return copyJson(value);
            }
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
                    changes: savedChanges(item.changes),
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
                    open: value.open === true, mode: value.mode === 'collaboration' ? 'collaboration' : 'role',
                    selectedNodeId: validId(value.selectedNodeId) ? value.selectedNodeId : '',
                    selectedWorkId: validId(value.selectedWorkId) ? value.selectedWorkId : '',
                    tab: ['work', 'talk', 'history', 'results'].includes(value.tab) ? value.tab : 'work',
                    collaboration: isRecord(value.collaboration) ? value.collaboration : {},
                    pendingMutation: validPending(value.pendingMutation, ctx), expanded,
                    drafts: sanitizeDrafts(value.drafts)
                };
            } catch { return {}; }
        }

        function writeStored(ctx, value) {
            const key = storageKey(ctx);
            if (!key) return false;
            const safe = { ...value };
            if (safe.pendingMutation?.kind?.startsWith('collaboration')) safe.pendingMutation = {
                mutationId: safe.pendingMutation.mutationId, kind: safe.pendingMutation.kind, receiptOnly: true,
                documentId: safe.pendingMutation.documentId, documentRevision: safe.pendingMutation.documentRevision,
                workflowId: safe.pendingMutation.workflowId, runId: safe.pendingMutation.runId,
                pausedWaiting: safe.pendingMutation.pausedWaiting === true,
                submittedDraft: validCollaborationDraft(safe.pendingMutation.submittedDraft) };
            const serialized = JSON.stringify(Object.assign({ version: 2 }, safe));
            scopedMemory.set(key, serialized);
            try {
                localStorage.setItem(key, serialized);
                if (localStorage.getItem(key) !== serialized) throw new Error('storage_not_retained');
                return true;
            }
            catch {
                if (sameContext(ctx, state.ctx) && !state.storageNoticeShown) {
                    state.storageNoticeShown = true;
                    bridge.notice?.('草稿暂时只能保留在当前页；请勿关闭后再继续。', 'info');
                }
                return false;
            }
        }

        function captureDrafts() {
            const now = Date.now();
            if (state.draftMeta && (state.editorDirty || state.messageDirty)) {
                state.drafts.works[state.draftMeta.workId] = { meta: copyJson(state.draftMeta), editorText: state.editorDraft,
                    changes: [...state.editorChanges],
                    items: copyJson(state.editorItems), attachments: copyJson(state.editorAttachments), baseline: copyJson(state.editorBaseline),
                    messageText: state.messageDraft, messageFrom: state.messageFrom,
                    editorDirty: state.editorDirty, messageDirty: state.messageDirty, updatedAt: now };
            }
            if (state.taskDraft && state.taskDraftDirty) state.drafts.tasks[taskDraftKey(state.taskDraft)] = { draft: copyJson(state.taskDraft), updatedAt: now };
            if (state.actionDraft?.meta && state.actionDraftDirty) state.drafts.actions[state.actionDraft.meta.workId + ':' + state.actionDraft.kind] = {
                ...copyJson(state.actionDraft), updatedAt: now };
        }

        function persistView() {
            captureReadingAnchor();
            captureDrafts();
            const collaborationState = collaborationView();
            const recoverable = sanitizeDrafts(state.drafts);
            const saved = writeStored(state.ctx, {
                open: state.open, mode: state.mode,
                selectedNodeId: state.selectedNodeId,
                selectedWorkId: state.selectedWorkId,
                tab: state.tab,
                collaboration: collaborationState,
                pendingMutation: state.pendingMutation, drafts: state.drafts, expanded: state.expanded
            });
            // The normal restore readers must accept each active draft too.
            return saved && (!(state.editorDirty || state.messageDirty) || Boolean(recoverable.works[state.draftMeta?.workId]))
                && (!state.taskDraftDirty || Boolean(recoverable.tasks[taskDraftKey(state.taskDraft || {})]))
                && (!state.actionDraftDirty || state.modalKind === 'collab-prompt'
                    || Boolean(recoverable.actions[state.actionDraft?.meta?.workId + ':' + state.actionDraft?.kind]))
                && (!collaboration.dirty || Boolean(validCollaborationDraft(collaborationState.draft)));
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
                    if (!collaborationReceiptNeedsAdoption(pending, receipt)) clearPendingMutation(ctx, pending);
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

        function collaborationReceiptNeedsAdoption(pending, result) {
            // Keep the original receipt until its saved document is adopted or its pause is acknowledged.
            return pending?.kind?.startsWith('collaboration') && Boolean(pending.submittedDraft
                || result?.document && (result.node || result.workflow) || result?.pending === true || result?.applied === false);
        }

        async function sendMutation(url, payload, kind, workId, submittedDraft) {
            const ctx = currentContext();
            if (!isCurrent(ctx) || ctx.writable === false) throw new Error('画布正在切换或当前不可编辑；原输入已保留，未发送操作。');
            if (state.pendingMutation) throw new Error('原操作结果尚未确认，请先查询原回执；当前输入已保留。');
            const id = payload.mutation_id || mutationId();
            const body = copyJson(Object.assign({}, payload, { mutation_id: id }));
            const method = kind === 'task_update' || kind === 'collaboration_update' ? 'PATCH' : 'POST';
            const pending = { mutationId: id, kind, workId: workId || '', url, method, payload: copyJson(body) };
            if (kind.startsWith('collaboration')) {
                pending.documentId = ctx.documentId; pending.documentRevision = body.document_revision ?? ctx.documentRevision;
                pending.workflowId = collaboration.workflowId; pending.runId = collaboration.runId;
                pending.submittedDraft = validCollaborationDraft(submittedDraft);
            }
            if (kind.startsWith('task_') && state.taskDraft) pending.draftKey = taskDraftKey(state.taskDraft);
            if (!validPending(pending, ctx)) throw new Error('操作目标与当前画布不匹配，未发送请求。');
            state.pendingMutation = pending;
            state.pendingNoticeShown = false;
            persistView(); updatePendingControls();
            try {
                const result = await requestJson(url, { method, payload: body });
                if (result && result.mutation_id === id && !collaborationReceiptNeedsAdoption(pending, result)) clearPendingMutation(ctx, pending);
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
                state.editorChanges = savedChanges(saved.changes);
                state.editorAttachments = attachmentSelections(saved.attachments);
                state.editorBaseline = saved.baseline ? savedEditorContent(saved.baseline) : savedEditorContent({});
                state.messageFrom = saved.messageFrom; state.editorDirty = saved.editorDirty;
                state.messageDirty = saved.messageDirty; state.draftConflict = !matchesMeta(saved.meta, detail);
            } else {
                const baseline = savedEditorContent(detail.draft_content || { text: detail.work.draft_text });
                state.draftMeta = meta; state.editorDraft = baseline.text; state.editorItems = copyJson(baseline.items);
                state.editorChanges = [...baseline.changes];
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
            const view = stored.collaboration || {};
            collaboration.workflowId = validId(view.workflowId) ? view.workflowId : '';
            collaboration.runId = validId(view.runId) ? view.runId : '';
            collaboration.relationMode = view.relationMode === 'all' ? 'all' : 'related';
            collaboration.scroll = isRecord(view.scroll) ? view.scroll : {};
            collaboration.drafts = Object.fromEntries(Object.entries(isRecord(view.drafts) ? view.drafts : {}).slice(-20)
                .map(([key, draft]) => [key, validCollaborationDraft(draft)]).filter(([, draft]) => draft));
            collaboration.draft = validCollaborationDraft(view.draft); collaboration.dirty = Boolean(collaboration.draft);
            collaboration.editingRequirements = view.editingRequirements === true;
            routing?.setMode(collaboration.relationMode);
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
                    : [state.editorDraft, JSON.stringify(state.editorItems, null, 2), state.editorChanges.join('\n\n'), JSON.stringify(state.editorAttachments, null, 2), state.messageDraft].join('\n\n');
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
            state.root.addEventListener('scroll', () => { captureReadingAnchor(); persistView(); }, { passive: true });
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
                || taskBar?.contains(target)
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
            return state.editorDirty || state.messageDirty || state.taskDraftDirty || state.actionDraftDirty || collaboration.dirty;
        }

        function clearTransientDrafts() {
            state.taskDraft = null; state.taskDraftDirty = false; state.taskDraftError = ''; state.taskSaving = false;
            state.actionDraft = null; state.actionDraftDirty = false;
            state.editorDraft = ''; state.editorDirty = false;
            state.messageDraft = ''; state.messageDirty = false;
            state.editorItems = Object.create(null); state.editorChanges = []; state.editorAttachments = []; state.editorBaseline = null;
            state.messageFrom = ''; state.draftMeta = null;
            state.draftConflict = false; state.taskConflict = false; state.actionSaving = false;
            state.loadingEarlier = false; state.loadingWorkHistory = false; state.loadingAttempts = false;
        }

        async function confirmDiscard(reason) {
            if (!hasUnsaved()) return true;
            const ctx = currentContext();
            if (state.modalKind === 'collab-prompt' && state.actionDraftDirty) {
                if (!await bridge.confirm({ title: '放弃这次输入？', message: '这里的输入尚未提交，离开会放弃本次输入；已保存任务与历史保留。', confirmText: '放弃输入并离开' })) return false;
                if (!isCurrent(ctx)) return false;
                state.actionDraftDirty = false; state.actionDraft = null;
                if (!hasUnsaved()) return true;
            }
            if (persistView()) return isCurrent(ctx);
            const leave = await bridge.confirm({ title: '离开当前草稿？',
                message: '本地保存失败，未提交输入只保留在当前页；离开后可能无法恢复。',
                confirmText: '仍然离开' });
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
                Promise.resolve().then(() => bridge.listRoleNodes(state.mode === 'role' ? state.selectedNodeId : '')),
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
            if (state.mode === 'collaboration') return refreshCollaboration(Boolean(options?.append));
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
            const requirement = bridge.engine?.nodes.get(id);
            if (requirement?.type === 'role-requirement') return openWorkflow(requirement.data?.roleRequirement?.workflowId,
                { ...options, runId: requirement.data?.roleRequirement?.runId || '', requirementId: id });
            const flow = bridge.workflowForNode?.(id);
            if (!options?.legacy && (Array.isArray(flow?.relations) || options?.runId
                || flow?.id === collaboration.workflowId && collaboration.runId)) return openWorkflow(flow?.id, { ...options, nodeId: id });
            if (taskBar) taskBar.hidden = true;
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
            if (options?.configure && isCurrent(currentContext())) await openTaskSettings(currentDetail()?.run || null);
            return true;
        }

        async function openPending() {
            if (taskBar) taskBar.hidden = true;
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
            document.body.classList.remove('role-collaboration-panel-open');
            persistView();
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
            collaboration.sequence += 1; collaboration.detail = null; collaboration.runs = []; collaboration.draft = null;
            clearTimeout(collaborationReadTimer); collaborationReadTimer = null; mediaRefreshPending = false; collaboration.drafts = {};
            collaboration.dirty = false; collaboration.busy = false; routing?.cancel(); taskBar?.remove(); taskBar = null;
            const restored = restoreScope(next); state.billedAttempts = new Set();
            if (restored.mode === 'collaboration') state.mode = 'collaboration';
            state.open = Boolean(state.root && state.root.isConnected) || restored.mode === 'collaboration' && restored.open === true;
            if (state.mode === 'collaboration' && !collaborationFlow()) { state.open = false; bridge.workRoot.hidden = true; }
            if (state.open) {
                ensureRoot();
                render();
                if (next.userId && next.documentId) await refresh();
            }
        }

        function render() {
            if (!state.open) return;
            document.body.classList.toggle('role-collaboration-panel-open', state.mode === 'collaboration');
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
            if (state.mode === 'collaboration') { host.append(renderCollaboration()); updatePendingControls(); restoreReadingAnchor(); return; }
            if (state.mode === 'pending') host.append(renderPendingList());
            else host.append(renderRoleView());
            if (state.loadingMore) host.append(panelMessage('正在加载下一批…', 'quiet'));
        }

        function renderHeader() {
            const header = el('header', 'crw-header');
            const copy = el('div', 'crw-header-copy');
            copy.append(el('h2', 'crw-title', state.mode === 'pending' ? '待我处理' : state.mode === 'collaboration' ? '本次工作' : '角色工作'));
            const role = selectedNode();
            copy.append(el('p', 'crw-subtitle', state.mode === 'pending' ? '当前画布' : state.mode === 'collaboration'
                ? collaborationFlow()?.name || '角色协作' : (role ? nodeTitle(role) : '请选择画布角色')));
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
            if (recordList(detail.summary?.context_gaps).length) block.append(panelMessage('岗位要求待补齐：' + detail.summary.context_gaps.join('、') + '。请编辑岗位并切换实例版本，再更新本次任务。', 'warning'));
            if (recordList(detail.summary?.reviewer_context_gaps).length) block.append(panelMessage('指定检查岗位要求待补齐：' + detail.summary.reviewer_context_gaps.join('、') + '。补齐并更新本次任务前不能审核交接。', 'warning'));
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
                totals.push('本站点：预留 ' + formatPoints(run.reserved_points) + ' 点 · 结算 ' + formatPoints(run.settled_points) + ' 点');
            }
            if (run.reserved_usd_micros != null || run.settled_usd_micros != null) {
                totals.push('上游：预留 ' + formatUsdMicros(run.reserved_usd_micros) + ' · 结算 ' + formatUsdMicros(run.settled_usd_micros));
            }
            if (totals.length) body.append(el('p', 'crw-cost-total', totals.join('\n')));
            let rateText = '人民币换算汇率未确认';
            try {
                const currentRateText = typeof bridge.usdToCnyRateText === 'function' ? bridge.usdToCnyRateText() : '';
                if (typeof currentRateText === 'string' && currentRateText.trim()) rateText = currentRateText.trim();
            } catch { /* Keep the explicit unknown-rate label. */ }
            body.append(el('p', 'crw-muted', '金额为本次任务总计；上游金额按 ' + rateText + ' 换算为人民币。下方只列当前工作已返回的调用回执。'));
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
            if (attempt.reserved_usd_micros != null) amounts.push('上游预留 ' + formatUsdMicros(attempt.reserved_usd_micros));
            if (attempt.settled_usd_micros != null) amounts.push('上游结算 ' + formatUsdMicros(attempt.settled_usd_micros));
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
            if (state.mode === 'collaboration' && feeState === 'authorization_required') {
                const authorize = button('核对差额并授权结原单', 'collab-settlement', '', 'check'); authorize.dataset.attemptId = attempt.id; row.append(authorize);
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
            try {
                if (typeof bridge.formatUsdMicros !== 'function') return '金额待核对';
                const formatted = bridge.formatUsdMicros(value);
                return typeof formatted === 'string' && formatted.trim() ? formatted : '金额待核对';
            } catch { return '金额待核对'; }
        }

        function budgetCnyReferenceText(value) {
            const draft = typeof value === 'string' ? value : '';
            const micros = /^\d+(?:\.\d{1,6})?$/.test(draft) ? scaledAmount(draft, 1000000, 1000) : null;
            if (micros === null) return draft
                ? '人民币参考会在美元上限格式有效时显示。'
                : '有效美元上限可显示人民币参考，不改变上游美元限额或实际账单。';
            let rateText = '人民币换算汇率未确认';
            try {
                const currentRateText = typeof bridge.usdToCnyRateText === 'function' ? bridge.usdToCnyRateText() : '';
                if (typeof currentRateText === 'string' && currentRateText.trim()) rateText = currentRateText.trim();
            } catch { /* Keep the explicit unknown-rate label. */ }
            return '人民币参考：' + formatUsdMicros(micros) + '（' + rateText + '，不改变上游美元限额或实际账单）';
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
                row.append(el('span', 'crw-muted', authorLabel(delivery)));
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

            if (recordList(role.contextGaps).length && !['delivered', 'unknown', 'review', 'confirmation'].includes(work.phase)) {
                box.append(panelMessage('岗位要求待补齐，不能开始或提交：' + role.contextGaps.join('、'), 'warning'));
                box.append(button('更新任务要求', 'task-settings', '', 'sliders-horizontal'));
                return box;
            }

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
            const changes = el('section', 'crw-change-editor');
            changes.append(el('h3', '', '修改回应'));
            if (detail.revision_source?.opinion) changes.append(summaryRow('修改意见', detail.revision_source.opinion));
            state.editorChanges.forEach((value, index) => {
                const row = el('div', 'crw-change-row'), field = el('label', 'crw-field');
                field.append(el('span', 'crw-field-label', '回应 ' + (index + 1)));
                const input = el('textarea', 'crw-textarea'); input.dataset.changeIndex = String(index);
                input.rows = 2; input.maxLength = 4000; input.value = value; field.append(input);
                const remove = actionIcon('trash-2', 'remove-change', '移除此条修改回应'); remove.dataset.changeIndex = String(index);
                row.append(field, remove); changes.append(row);
            });
            const add = button('添加回应', 'add-change', '', 'plus'); add.disabled = state.editorChanges.length >= 30;
            changes.append(add); box.append(changes, renderAttachmentEditor());
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
            return { title: node?.title || (selection.mediaBindingId ? '本次媒体原件' : selection.sourceDeliveryId ? '原成果附件' : '画布节点已移除'), type: node?.type || '', ...selection };
        }

        function attachmentDescription(attachment, selection) {
            if (selection?.mediaBindingId) return '固定媒体原件' + (attachment.outputSlotId ? ' · ' + attachment.outputSlotId : '');
            return selection?.sourceDeliveryId ? '固定原成果 · 第' + (selection.index + 1) + '项'
                : attachment.nodeId || selection?.nodeId ? '已选画布原件，提交时固定版本' : '固定交付原件';
        }

        function attachmentRecord(attachment, selection) {
            const rows = [['成果编号', selection?.sourceDeliveryId], ['原件序号', selection?.sourceDeliveryId ? String(selection.index + 1) : ''],
                ['画布节点', attachment.nodeId || selection?.nodeId], ['资产编号', attachment.assetId],
                ['参考编号', attachment.referenceImageId], ['媒体任务', attachment.taskId || attachment.imageTaskId],
                ['媒体绑定', attachment.mediaBindingId || selection?.mediaBindingId], ['交付项', attachment.outputSlotId || selection?.outputSlotId],
                ['来源工作', attachment.sourceWorkId], ['原件指纹', attachment.sourceDigest || selection?.sourceDigest]];
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
            const to = state.nodes.find(node => node.id === detail.work.node_id);
            composer.append(el('p', 'crw-muted', '发给：' + (to ? nodeTitle(to) : '当前角色')));
            const fromSelect = el('select', 'crw-select'); fromSelect.dataset.messageFrom = '';
            appendOption(fromSelect, '', '以本人名义');
            recordList(detail.requirements?.participants).filter(item => item.participation !== 'excluded').forEach(item => {
                const node = state.nodes.find(candidate => candidate.id === item.nodeId);
                if (node && node.id !== detail.work.node_id) appendOption(fromSelect, node.id, '以' + nodeTitle(node) + '身份转达');
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
            const author = actualAuthor(event);
            const avatar = el('span', 'crw-avatar'); setIcon(avatar, authorIcon(author));
            heading.append(avatar, el('strong', '', (from ? nodeTitle(from) + ' · ' : '') + authorLabel(event)));
            heading.append(el('span', 'crw-muted', event.to_node_id === currentDetail()?.work?.node_id ? '发给当前角色' : '任务内交流'));
            addTime(heading, event.created_at); row.append(heading);
            row.append(el('p', 'crw-message-copy', textOf(detail.text, '消息内容待同步')));
            return row;
        }

        function actualAuthor(record) {
            if (['ai', 'person', 'unknown'].includes(record?.author_kind)) return record.author_kind;
            if (['ai', 'person', 'unknown'].includes(record?.actor_kind)) return record.actor_kind;
            if (record?.submission_kind === 'ai') return 'ai';
            if (['person', 'owner_proxy'].includes(record?.submission_kind)) return 'person';
            const detail = parseJson(record?.detail_json || record?.detail, {});
            if (detail.attribution === 'owner_answer') return 'person';
            if (validId(record?.source_attempt_id) || validId(detail.attemptId)) return 'ai';
            return 'unknown';
        }

        function authorIcon(kind) { return kind === 'ai' ? 'bot' : kind === 'person' ? 'user-round' : 'circle-help'; }
        function authorLabel(record) {
            const kind = actualAuthor(record), detail = parseJson(record?.detail_json || record?.detail, {});
            if (kind === 'ai') return 'AI';
            if (kind !== 'person') return '作者未确认';
            if (record.submission_kind === 'owner_proxy' || detail.ownerProxy === true) return '本人代提交';
            if (record.actor_user_id === state.ctx.userId || record.submitted_by === state.ctx.userId || detail.attribution === 'owner_answer') {
                return record.from_node_id && record.kind === 'message' ? '本人转达' : '本人';
            }
            return '人工';
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
            row.append(el('span', 'crw-muted', authorLabel(event)));
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
            const copy = textOf(detail.opinion || detail.reason || detail.goal || detail.text, '');
            if (copy) row.append(el('p', 'crw-muted', copy));
            if (kind === 'collaboration_review') row.append(el('span', 'crw-muted',
                ({ suggest: '检查建议', approve: '检查通过', return: '退回修改', confirm: '本人确认', revise: '继续修改' }[detail.action] || '动作待核对')));
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
            const copy = el('p', '', state.pendingMutation?.pausedWaiting
                ? '原操作仅暂停新派发，新需求尚未保存。完整草稿和原回执已保留。'
                : '有一项操作待确认或待同步到画布。查询同一回执不会重发或再次收费。');
            box.append(copy, button('查询原回执', 'recover-receipt', '', 'search'));
            if (state.pendingMutation?.pausedWaiting) box.append(button('核对后继续编辑', 'collab-recheck-paused', '', 'pencil'));
            return box;
        }

        function updatePendingControls() {
            [state.root, state.modalContent].forEach(surface => {
                if (!surface) return;
                surface.querySelectorAll('[data-action="collab-save-request"], [data-action="collab-save-current"], [data-action="collab-save-configuration"]').forEach(control => {
                    const label = control.lastChild;
                    if (label?.nodeType === 3) {
                        control.dataset.idleLabel ||= label.textContent;
                        label.textContent = state.taskSaving ? '正在保存…' : control.dataset.idleLabel;
                    }
                    control.disabled = state.taskSaving || Boolean(state.pendingMutation) || state.ctx.writable === false;
                    control.setAttribute('aria-busy', String(state.taskSaving));
                });
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
            if (bridge.workflowForNode?.(state.selectedNodeId)) {
                const relationSave = button('保存工作流分工', 'save-workflow-relations', '', 'save');
                relationSave.disabled = state.taskSaving || state.taskConflict; footer.append(relationSave);
            }
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
            if (!existingRun && !recordList(requirements.participants).length) {
                const flow = bridge.workflowForNode?.(state.selectedNodeId);
                if (flow) requirements = { participants: flow.participants, finalNodeId: flow.finalNodeId };
            }
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
            const input = el('input', 'crw-input'); input.type = 'number'; input.dataset.taskField = key;
            input.min = String(min); input.max = String(max); input.step = step || '1'; input.value = value || '';
            if (key === 'budget_usd') {
                const field = el('div', 'crw-field');
                const label = el('label', 'crw-field-label', labelText + (required ? ' · 必填' : ''));
                label.htmlFor = 'crw-budget-usd-limit';
                input.id = label.htmlFor;
                const reference = el('span', 'crw-muted', budgetCnyReferenceText(input.value));
                reference.dataset.budgetCnyReference = '';
                reference.id = 'crw-budget-usd-reference';
                input.setAttribute('aria-describedby', reference.id);
                field.append(label, input, reference);
                parent.append(field);
                return;
            }
            const label = el('label', 'crw-field'); label.append(el('span', 'crw-field-label', labelText + (required ? ' · 必填' : '')));
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
            state.nodes.filter(item => item.id !== node.id && item.roleConfig?.snapshot?.reviewAuthority !== 'none').forEach(item => appendOption(reviewerSelect, item.id, nodeTitle(item)));
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
            const dirty = state.modalKind === 'collab-requirement' ? collaboration.dirty
                : state.modalKind === 'task' ? state.taskDraftDirty : state.actionDraftDirty && state.actionDraft?.kind === state.modalKind;
            const localSafe = persistView();
            if (dirty && state.modalKind === 'collab-prompt') {
                if (!await bridge.confirm({ title: '放弃这次输入？', message: '此操作尚未提交。关闭会放弃这里的输入，已保存任务与历史不变。', confirmText: '放弃输入' })) return;
                if (state.modalContent !== content || !isCurrent(ctx)) return;
                state.actionDraftDirty = false; state.actionDraft = null;
                if (state.modalContent === content && isCurrent(ctx)) closeModal();
                return;
            }
            if (dirty && !localSafe && !await bridge.confirm({ title: '关闭当前草稿？', message: '本地保存失败，输入只保留在当前页；刷新或关闭网页可能无法恢复。', confirmText: '仍然关闭' })) return;
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
            if (target.matches('[data-collaboration-field]')) { updateCollaborationDraft(target); persistView(); return; }
            if (target.matches('[data-editor="main"]')) {
                state.editorDraft = target.value; state.editorDirty = true;
            } else if (target.matches('[data-required-item]')) {
                state.editorItems[target.dataset.requiredItem] = target.value; state.editorDirty = true;
            } else if (target.matches('textarea[data-change-index]')) {
                const index = Number(target.dataset.changeIndex);
                if (Number.isInteger(index) && index >= 0 && index < state.editorChanges.length) {
                    state.editorChanges[index] = target.value; state.editorDirty = true;
                }
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
            if (target.matches('[data-collaboration-field]')) { updateCollaborationDraft(target); persistView(); return; }
            if (target.matches('[data-collaboration-run]')) { void switchCollaborationRun(target.value).catch(showCollaborationError); return; }
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
            if (key === 'budget_usd') {
                const input = state.modalContent?.querySelector('[data-task-field="budget_usd"]');
                const reference = input?.parentElement?.querySelector('[data-budget-cny-reference]');
                if (reference) reference.textContent = budgetCnyReferenceText(value);
            }
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
            if (action.startsWith('collab-')) { await collaborationAction(action, target); return; }
            if (action.startsWith('draft-')) { await resolveDraft(target); return; }
            if (action === 'tab') {
                const tab = target.dataset.tab;
                if (!['work', 'talk', 'history', 'results'].includes(tab)) return;
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
            if (action === 'save-workflow-relations') {
                const ctx = currentContext(), draft = copyJson(state.taskDraft), req = collectRequirements(draft);
                const validation = validateRequirements({ ...req, goal: '工作流分工' }, { ...draft, materialNodes: [], max_rounds: '1', max_calls: '', wait_limit_seconds: '', budget_points_limit: '', budget_usd: '' });
                if (validation) throw new Error(validation);
                state.taskSaving = true; updatePendingControls();
                try {
                    await bridge.saveWorkflowRelations(state.selectedNodeId, { participants: req.participants, finalNodeId: req.finalNodeId });
                    if (isCurrent(ctx)) {
                        bridge.notice?.('工作流分工已保存；任务草稿保留，已有任务和预算未改变。', 'success');
                        persistView(); closeModal();
                    }
                } finally { state.taskSaving = false; updatePendingControls(); }
                return;
            }
            if (action === 'submit-text-action') { await submitTextAction(target); return; }
            if (action === 'recover-receipt') { await queryPendingReceipt(target); return; }
            if (action === 'query-attempt') { await queryAttempt(target); return; }
            if (action === 'load-attempts') { await loadAttempts(); return; }
            if (action === 'view-attempt') { await openAttempt(target); return; }
            if (action === 'view-input') { openInputDelivery(target); return; }
            if (action === 'view-delivery') { openDelivery(target.dataset.deliveryId); return; }
            if (action === 'view-adopted') { await openAdoptedDelivery(target); return; }
            if (action === 'view-revision-source') { await openRevisionSource(); return; }
            if (action === 'add-change' || action === 'remove-change') {
                if (action === 'add-change' && state.editorChanges.length < 30) state.editorChanges.push('');
                else if (action === 'remove-change') {
                    const index = Number(target.dataset.changeIndex);
                    if (!Number.isInteger(index) || index < 0 || index >= state.editorChanges.length) return;
                    state.editorChanges.splice(index, 1);
                } else return;
                state.editorDirty = true; persistView(); render();
                const focusIndex = action === 'add-change' ? state.editorChanges.length - 1 : Math.min(Number(target.dataset.changeIndex), state.editorChanges.length - 1);
                if (focusIndex >= 0) state.root?.querySelector('textarea[data-change-index="' + focusIndex + '"]')?.focus();
                else state.root?.querySelector('[data-action="add-change"]')?.focus();
                return;
            }
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
                if (state.mode === 'collaboration') return promptCollaborationReview('revise');
                const ctx = currentContext(), meta = workMeta(currentDetail());
                if (await bridge.confirm({ title: '继续修订？', message: '将重开当前角色及依赖它的下游；独立分支保留。已交付成果和费用记录继续留在历史中，修订次数不会自动增加。', confirmText: '新开修订轮' })) {
                    assertWorkUnchanged(ctx, meta); await performWorkAction('revise', {}, meta);
                }
                return;
            }
            if (action === 'run-pause') {
                if (state.mode === 'collaboration') { await collaborationControl('pause'); return; }
                const ctx = currentContext(), meta = workMeta(currentDetail());
                if (await bridge.confirm({ title: '暂停本次任务？', message: '暂停会停止新的调用，不代表已发请求被取消或退款。', confirmText: '暂停任务' })) {
                    assertWorkUnchanged(ctx, meta); await performWorkAction('pause', {}, meta);
                }
                return;
            }
            if (action === 'run-resume') { if (state.mode === 'collaboration') await collaborationControl('resume'); else await runAction('resume'); return; }
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
                    if (pending?.kind?.startsWith('collaboration')) {
                        await adoptCollaborationReceipt(ctx, pending, result);
                        if (!isCurrent(ctx)) return;
                        if (collaborationFlow()) { state.mode = 'collaboration'; await refreshCollaboration(false); }
                        else await refresh();
                        return;
                    }
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

        async function performWorkAction(action, extra, expectedMeta, editorChangesAtSubmit) {
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
                changes = JSON.stringify(editorChangesAtSubmit || state.editorChanges),
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
                && JSON.stringify(state.editorAttachments) === attachments && JSON.stringify(state.editorChanges) === changes) {
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
            const changes = [...state.editorChanges];
            assertWorkUnchanged(ctx, meta);
            const role = parseJson(detail?.work?.snapshot?.role, {});
            const participant = recordList(detail?.requirements?.participants).find(item => item.nodeId === detail?.work?.node_id) || {};
            const body = { text, items: copyJson(state.editorItems), changes: submissionChanges(), attachments: copyJson(state.editorAttachments),
                ...(participant.ownerMaySubmit === true && role.executor?.kind !== 'person' ? { owner_proxy: true } : {}) };
            target.disabled = true;
            try {
                await prepareAttachmentWrite(ctx, meta, body.attachments);
                await performWorkAction('draft', body, meta, changes);
            } finally { if (isCurrent(ctx)) target.disabled = false; }
        }

        async function submitWork(target) {
            const ctx = currentContext(), detail = currentDetail(), meta = state.draftMeta, text = state.editorDraft;
            const changes = [...state.editorChanges];
            assertWorkUnchanged(ctx, meta);
            if (!text.trim() && !state.editorAttachments.length) { bridge.notice?.('请填写成果正文或选择交付原件。', 'warning'); return; }
            const items = Object.create(null), role = parseJson(detail.work?.snapshot?.role, {});
            const assignment = recordList(detail.requirements?.participants).find(item => item.nodeId === detail.work?.node_id);
            const required = [...new Set([...recordList(role.requiredItems),
                ...recordList(detail.requirements?.schema === 'role.requirements.v2' ? assignment?.deliverableItems : [])])];
            required.forEach(name => { items[name] = state.editorItems[name] || ''; });
            const missing = Object.entries(items).filter(([, value]) => !value.trim());
            if (missing.length) { bridge.notice?.('请填写全部必交项。', 'warning'); return; }
            const participant = recordList(detail.requirements?.participants).find(item => item.nodeId === detail.work?.node_id) || {};
            const body = { text, items, changes: submissionChanges(), attachments: copyJson(state.editorAttachments), input_digest: meta.inputDigest,
                ...(participant.ownerMaySubmit === true && role.executor?.kind !== 'person' ? { owner_proxy: true } : {}) };
            target.disabled = true;
            try {
                await prepareAttachmentWrite(ctx, meta, body.attachments);
                await performWorkAction('submit', body, meta, changes);
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
            const ctx = currentContext(), meta = state.draftMeta, text = state.messageDraft.trim(), from = state.mode === 'collaboration' ? '' : state.messageFrom;
            assertWorkUnchanged(ctx, meta);
            if (!text) { bridge.notice?.('请先填写要发送的内容。', 'warning'); return; }
            target.disabled = true;
            try {
                await performWorkAction('message', {
                    to_node_id: currentDetail().work.node_id,
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
            appendTextList(body, '修改回应', contentData.changes, '本稿未记录修改回应。');
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
                if (state.mode === 'collaboration') {
                    for (const [action, label] of [['canvas', '放回画布'], ['asset', '存入资产']]) {
                        const use = button(label, 'collab-attachment-' + action, '', action === 'canvas' ? 'plus' : 'save');
                        use.dataset.deliveryId = deliveryId; use.dataset.attachmentIndex = String(index); row.append(use);
                    }
                }
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

        async function readFixedDelivery(runId, deliveryId) {
            if (!validId(runId) || !validId(deliveryId)) throw new Error('原稿身份无效，未读取其他稿件。');
            const result = await requestJson(apiUrl('/role-runs/' + encodeURIComponent(runId), { delivery_id: deliveryId }), { method: 'GET' });
            if (!result?.delivery || result.delivery.id !== deliveryId) throw new Error('指定原稿不可读，未用其他稿替代。');
            return result.delivery;
        }

        async function openRevisionSource() {
            const ctx = currentContext(), detail = currentDetail(), source = detail?.revision_source;
            if (source?.readonly !== true || !validId(source.deliveryId)) throw new Error('固定修订原稿暂不可读，不采用当前稿替代。');
            if (!isRecord(source.content)) {
                const delivery = await readFixedDelivery(detail.run?.id, source.deliveryId);
                if (!isCurrent(ctx) || currentDetail() !== detail) return;
                const original = parseJson(delivery.content_json, null);
                if (!isRecord(original)) throw new Error('固定原稿内容不可读；不会使用当前草稿替代。');
                source.content = original;
                render();
            }
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
            content.append(el('p', 'crw-muted', authorLabel(delivery)));
            content.append(recordDetails([['成果编号', delivery.id]]));
            appendReadonlyContent(content, contentData, delivery.id);
            const footer = el('div', 'crw-dialog-footer'); footer.append(button('关闭', 'dialog-readonly-close', 'primary')); content.append(footer);
            openModal('delivery', content);
        }

        function collaborationFlow() {
            return (bridge.engine?.roleWorkflows || []).find(flow => flow.id === collaboration.workflowId) || null;
        }

        function collaborationView() {
            if (collaboration.dirty && collaboration.draft) {
                collaboration.drafts[collaborationDraftKey(collaboration.draft)] = validCollaborationDraft(collaboration.draft);
            }
            collaboration.drafts = Object.fromEntries(Object.entries(collaboration.drafts).filter(([, draft]) => draft).slice(-20));
            return { workflowId: collaboration.workflowId, runId: collaboration.runId,
                relationMode: collaboration.relationMode, scroll: collaboration.scroll, editingRequirements: collaboration.editingRequirements,
                draft: collaboration.dirty ? collaboration.draft : null, drafts: collaboration.drafts };
        }

        function collaborationDraftKey(draft) { return draft.workflowId + ':' + (draft.runId || 'new'); }
        function forgetCollaborationDraft(draft) { if (draft) delete collaboration.drafts[collaborationDraftKey(draft)]; }
        async function adoptCollaborationReceipt(ctx, pending, result) {
            if (!isCurrent(ctx) || !pending || result?.mutation_id !== pending.mutationId) return false;
            if (pending.workflowId && pending.workflowId !== collaboration.workflowId) {
                throw new Error('这是另一工作流的原回执，请回原工作流后查询；草稿和回执均保留。');
            }
            if (pending.runId && pending.runId !== collaboration.runId) throw new Error('请回原任务查询此回执，当前任务和草稿未改变。');
            if (pending.submittedDraft && !pending.submittedDraft.runId && collaboration.runId && result.run?.id !== collaboration.runId) {
                throw new Error('请回原新需求草稿查询此回执，当前任务未改变。');
            }
            if (pending.submittedDraft && collaboration.dirty && collaboration.draft
                && collaborationDraftKey(collaboration.draft) !== collaborationDraftKey(pending.submittedDraft)) {
                throw new Error('当前另有需求草稿，请返回原需求后查询回执；两份输入均保留。');
            }
            if (result.run && result.run.document_id !== ctx.documentId) throw new Error('回执不属于当前画布，未接纳。');
            const payload = { document_id: pending.documentId || ctx.documentId,
                document_revision: pending.documentRevision ?? ctx.documentRevision };
            if (result.document && (result.node || result.workflow)) {
                const adopt = result.node ? bridge.adoptRoleRunReceipt : bridge.adoptRoleWorkflowTemplateReceipt;
                if (typeof adopt !== 'function') throw new Error('原操作已保存，画布同步暂不可用；原回执已保留，请稍后再查。');
                await adopt(result, payload);
                if (!isCurrent(ctx)) return false;
            }
            if (result.pending === true || result.applied === false) {
                pending.pausedWaiting = true;
                if (state.pendingMutation?.mutationId === pending.mutationId) state.pendingMutation = pending;
                const saved = pending.submittedDraft;
                if (saved && !collaboration.draft) { collaboration.draft = copyJson(saved); collaboration.dirty = true; }
                if (collaboration.draft?.runId === result.run?.id) {
                    collaboration.draft.pauseReceiptId = pending.mutationId; collaboration.dirty = true;
                }
                state.taskConflict = true; collaboration.editingRequirements = true;
                persistView(); updatePendingControls();
                bridge.notice?.('已暂停新派发，但新需求尚未保存。请先核对原请求与费用，再继续编辑并明确保存；不会自动重发。', 'warning');
                return false;
            }
            if (pending.submittedDraft) {
                if (!validId(result.run?.id) || result.requirements?.schema !== 'role.requirements.v2'
                    || result.requirements.workflowId !== pending.submittedDraft.workflowId
                    || pending.submittedDraft.runId && result.run.id !== pending.submittedDraft.runId) throw new Error('需求保存结果尚未确认，草稿和原回执保留。');
                const submitted = pending.submittedDraft, key = collaborationDraftKey(submitted);
                const draft = collaboration.draft && collaborationDraftKey(collaboration.draft) === key
                    ? collaboration.draft : collaboration.drafts[key];
                const unchanged = draft && JSON.stringify(validCollaborationDraft(draft)) === JSON.stringify(submitted);
                if (unchanged) {
                    forgetCollaborationDraft(draft);
                    if (!collaboration.dirty || draft === collaboration.draft) { collaboration.draft = null; collaboration.dirty = false; collaboration.editingRequirements = false; }
                } else if (draft) {
                    forgetCollaborationDraft(draft); draft.runId = result.run.id;
                    collaboration.drafts[collaborationDraftKey(draft)] = validCollaborationDraft(draft);
                    if (!collaboration.dirty || !collaboration.draft || draft === collaboration.draft) {
                        collaboration.draft = draft; collaboration.dirty = true; state.taskConflict = true;
                    }
                }
                collaboration.runId = result.run.id;
                bridge.notice?.(unchanged ? '需求已保存，尚未授权或开始协作。' : '原需求已保存；之后编辑的内容仍是草稿，请核对后再保存。', unchanged ? 'success' : 'warning');
            }
            clearPendingMutation(ctx, pending);
            return true;
        }
        function restoreCollaborationDraft() {
            collaboration.draft = validCollaborationDraft(collaboration.drafts[collaboration.workflowId + ':' + (collaboration.runId || 'new')]);
            collaboration.dirty = Boolean(collaboration.draft);
        }

        function validCollaborationDraft(value) {
            if (!isRecord(value) || !validId(value.workflowId) || (value.runId && !validId(value.runId))
                || typeof value.goal !== 'string' || value.goal.length > 12000
                || typeof value.criteria !== 'string' || value.criteria.length > 8000
                || !Array.isArray(value.participants) || value.participants.length > 100
                || !Array.isArray(value.relations) || value.relations.length > 500
                || !Array.isArray(value.materialNodes) || value.materialNodes.some(id => !validId(id))
                || value.participants.some(p => !isRecord(p) || !validId(p.nodeId))) return null;
            return { workflowId: value.workflowId, runId: value.runId || '', title: textOf(value.title, '').slice(0, 80),
                pauseReceiptId: validId(value.pauseReceiptId) ? value.pauseReceiptId : '',
                baseRevision: finiteInteger(value.baseRevision, 0, Number.MAX_SAFE_INTEGER) ?? 0,
                requirementsRevision: finiteInteger(value.requirementsRevision, 0, Number.MAX_SAFE_INTEGER) ?? 0,
                goal: value.goal, criteria: value.criteria, finalNodeId: validId(value.finalNodeId) ? value.finalNodeId : '',
                materialNodes: value.materialNodes.slice(0, 100),
                participants: value.participants.map(p => ({ ...cloneParticipant(p), assignment: textOf(p.assignment, '').slice(0, 8000),
                    deliverableItems: recordList(p.deliverableItems).filter(item => typeof item === 'string').slice(0, 50).map(item => item.slice(0, 160)),
                    requiredInputs: recordList(p.requiredInputs).filter(item => typeof item === 'string').slice(0, 50).map(item => item.slice(0, 160)),
                    acceptanceCriteria: textOf(p.acceptanceCriteria, '').slice(0, 8000) })),
                relations: value.relations.filter(r => isRecord(r) && validId(r.id) && ['accepts_requirement', 'handoff', 'guidance', 'review'].includes(r.type)
                    && (r.from === 'requirement' || validId(r.from)) && validId(r.to)).map(r => ({ id: r.id, type: r.type, from: r.from, to: r.to,
                        required: r.required === true, items: recordList(r.items).filter(item => typeof item === 'string').slice(0, 50).map(item => item.slice(0, 160)),
                        stage: 'effective', authority: r.authority === 'approve' ? 'approve' : 'suggestion' })) };
        }

        function collaborationRequirements(draft) {
            return { schema: 'role.requirements.v2', workflowId: draft.workflowId, goal: clean(draft.goal), criteria: clean(draft.criteria),
                participants: draft.participants.map(p => ({ ...cloneParticipant(p), assignment: clean(p.assignment),
                    deliverableItems: recordList(p.deliverableItems), requiredInputs: recordList(p.requiredInputs),
                    acceptanceCriteria: clean(p.acceptanceCriteria), reviewerNodeId: null,
                    dependencies: draft.relations.filter(r => r.type === 'handoff' && r.to === p.nodeId).map(r => ({ nodeId: r.from, required: r.required })) })),
                relations: copyJson(draft.relations), finalNodeId: draft.finalNodeId || '', endpoint: 'owner_result',
                decisionOwnerId: state.ctx.userId, materialNodes: [...draft.materialNodes] };
        }

        function relationsFromFlow(flow) {
            if (Array.isArray(flow.relations)) return copyJson(flow.relations);
            const rows = [];
            const add = value => { if (!rows.some(edge => edge.from === value.from && edge.to === value.to && edge.type === value.type))
                rows.push({ ...value, id: 'legacy-' + flow.id.slice(0, 120) + '-' + rows.length }); };
            for (const p of flow.participants || []) {
                if (p.participation === 'excluded') continue;
                for (const dep of p.dependencies || []) add({ type: 'handoff', from: dep.nodeId,
                    to: p.nodeId, required: dep.required, items: [], stage: 'effective', authority: 'suggestion' });
                if (p.reviewerNodeId) add({ type: 'review', from: p.nodeId, to: p.reviewerNodeId,
                    required: false, items: [], stage: 'effective', authority: 'suggestion' });
            }
            for (const edge of flow.guidance || []) add({ type: 'guidance', from: edge.from, to: edge.to,
                required: false, items: [], stage: 'effective', authority: 'suggestion' });
            return rows;
        }

        function newCollaborationDraft() {
            const flow = collaborationFlow(), result = collaboration.detail, req = result?.requirements || {};
            const sameRun = result?.run?.id === collaboration.runId;
            return { workflowId: flow.id, runId: sameRun ? result.run.id : '', title: textOf(req.goal, '本次需求').slice(0, 80),
                baseRevision: Number(sameRun ? result.run.revision : 0), requirementsRevision: Number(sameRun ? result.run.requirements_revision : 0),
                goal: textOf(req.goal, ''), criteria: textOf(req.criteria, ''), materialNodes: copyJson(req.materialNodes || []),
                participants: (sameRun ? req.participants || [] : flow.participants || []).map(p => ({ ...cloneParticipant(p),
                    assignment: textOf(p.assignment, ''), deliverableItems: recordList(p.deliverableItems),
                    requiredInputs: recordList(p.requiredInputs), acceptanceCriteria: textOf(p.acceptanceCriteria, '') })),
                relations: sameRun ? copyJson(req.relations || []) : relationsFromFlow(flow), finalNodeId: sameRun ? req.finalNodeId || '' : flow.finalNodeId || '' };
        }

        function currentCollaborationWork() {
            return recordList(collaboration.detail?.works).find(work => work.id === state.selectedWorkId) || null;
        }

        function readingKey() { return [collaboration.workflowId, collaboration.runId, state.selectedWorkId, state.tab].join(':'); }
        function captureReadingAnchor() {
            if (state.mode !== 'collaboration' || !state.root) return;
            const parent = state.root.getBoundingClientRect();
            const anchor = [...state.root.querySelectorAll('[data-reading-id]')].find(item => item.getBoundingClientRect().bottom >= parent.top + 60);
            collaboration.scroll[readingKey()] = { id: anchor?.dataset.readingId || '', offset: anchor ? anchor.getBoundingClientRect().top - parent.top : 0,
                top: Math.min(1000000, Math.max(0, state.root.scrollTop)) };
        }
        function restoreReadingAnchor() {
            const saved = collaboration.scroll[readingKey()]; if (!saved || !state.root) return;
            const anchor = typeof saved.id === 'string' && saved.id.length <= 200
                ? [...state.root.querySelectorAll('[data-reading-id]')].find(item => item.dataset.readingId === saved.id) : null;
            if (anchor && Number.isFinite(saved.offset)) state.root.scrollTop += anchor.getBoundingClientRect().top - state.root.getBoundingClientRect().top - saved.offset;
            else if (Number.isFinite(saved.top)) state.root.scrollTop = Math.min(1000000, Math.max(0, saved.top));
        }

        function showCollaborationError(error) {
            state.error = normalizeError(error).message; render();
        }

        async function openWorkflow(workflowId, options) {
            options = options || {};
            if (!validId(workflowId)) throw new Error('工作流已不可用，请从工作流列表重新打开。');
            if (state.restoredScope !== contextKey(currentContext())) await contextChanged();
            if (state.open && !await confirmDiscard()) return false;
            captureReadingAnchor(); persistView(); closeModal(); clearTransientDrafts();
            const previous = collaboration.workflowId;
            const rememberedWork = state.selectedWorkId;
            state.open = true; state.mode = 'collaboration'; collaboration.workflowId = workflowId;
            if (!collaborationFlow()) throw new Error('工作流不属于当前画布。');
            const deep = new URLSearchParams(location.search);
            const explicitRun = options.runId !== undefined ? options.runId : deep.get('role_run_id') || currentContext().roleRunId;
            collaboration.runId = options.newTask ? '' : validId(explicitRun) ? explicitRun : explicitRun === '' ? '' : previous === workflowId ? collaboration.runId : '';
            state.selectedNodeId = options.nodeId || options.requirementId || '';
            state.selectedWorkId = options.workId || deep.get('role_work_id') || (previous === workflowId ? rememberedWork : '');
            state.messageFrom = ''; state.detail = null; state.error = ''; collaboration.detail = null;
            state.tab = ['work', 'talk', 'results'].includes(options.tab) ? options.tab : ['work', 'talk', 'results'].includes(state.tab) ? state.tab : 'work';
            collaboration.editingRequirements = false;
            if (collaboration.draft?.workflowId !== workflowId || collaboration.draft?.runId !== collaboration.runId) restoreCollaborationDraft();
            ensureRoot(); await refreshCollaboration(false, options.newTask || Boolean(options.requirementId && !options.runId));
            if (options.newTask || options.configure || !collaboration.runId) openRequirementEditor();
            return true;
        }

        async function refreshCollaboration(append, noRestore, quiet) {
            const ctx = currentContext(), flow = collaborationFlow(); if (!flow || !isCurrent(ctx)) return;
            captureReadingAnchor();
            const before = quiet ? JSON.stringify([collaboration.detail, state.detail, collaboration.runs]) : '';
            const sequence = ++collaboration.sequence; state.loading = !append && !quiet; state.loadingMore = append; state.error = ''; if (!quiet) render();
            try {
                await loadNodes(ctx);
                const params = { document_id: ctx.documentId, workflow_id: flow.id };
                if (append && collaboration.cursor) params.cursor = collaboration.cursor;
                const list = await requestJson(apiUrl('/role-runs', params), { method: 'GET' });
                if (!isCurrent(ctx) || sequence !== collaboration.sequence || collaboration.workflowId !== flow.id) return;
                const rows = recordList(list.runs).filter(run => run.document_id === ctx.documentId);
                collaboration.runs = append ? mergeById(collaboration.runs, rows) : rows;
                collaboration.cursor = list.next_cursor || null;
                const pendingNew = state.pendingMutation?.submittedDraft;
                if (!collaboration.runId && !noRestore && !(pendingNew?.workflowId === flow.id && !pendingNew.runId)) {
                    const active = rows.find(run => run.control && !['delivered', 'cancelled'].includes(run.status));
                    collaboration.runId = active?.id || '';
                    restoreCollaborationDraft();
                }
                if (collaboration.runId) {
                    const detail = await requestJson(apiUrl('/role-runs/' + encodeURIComponent(collaboration.runId)), { method: 'GET' });
                    if (!isCurrent(ctx) || sequence !== collaboration.sequence) return;
                    if (detail.run?.document_id !== ctx.documentId || (detail.requirements?.workflowId && detail.requirements.workflowId !== flow.id)
                        || (detail.control?.workflow_id && detail.control.workflow_id !== flow.id)) throw new Error('任务与当前工作流不符，未显示私人内容。');
                    collaboration.detail = detail; collaboration.questionsCursor = detail.question_next_cursor || detail.next_question_cursor || detail.question_cursor || null;
                    if (!detail.control || detail.requirements?.schema !== 'role.requirements.v2') {
                        const work = recordList(detail.works).find(item => item.node_id === state.selectedNodeId) || recordList(detail.works)[0];
                        if (work) { state.mode = 'role'; await open(work.node_id, { workId: work.id, legacy: true }); return; }
                    }
                    const selected = recordList(detail.works).find(work => work.id === state.selectedWorkId)
                        || recordList(detail.works).find(work => work.node_id === state.selectedNodeId && work.phase !== 'superseded');
                    state.selectedWorkId = selected?.id || ''; state.detail = null;
                    state.runs = [detail.run]; state.works = recordList(detail.works);
                    if (selected) await fetchDetail(selected.id, ctx, state.sequence, false);
                    if (collaboration.draft?.runId === detail.run.id && collaboration.draft.baseRevision !== Number(detail.run.revision)) {
                        state.taskConflict = true;
                    } else state.taskConflict = false;
                } else { collaboration.detail = null; state.selectedWorkId = ''; state.detail = null; }
                if (!isCurrent(ctx) || sequence !== collaboration.sequence) return;
                state.loading = false; state.loadingMore = false;
                const changed = !quiet || before !== JSON.stringify([collaboration.detail, state.detail, collaboration.runs]);
                if (changed) { updateCollaborationCards(); renderTaskBar(); routing?.render(); render(); }
                persistView();
            } catch (error) {
                if (!isCurrent(ctx) || sequence !== collaboration.sequence) return;
                state.loading = false; state.loadingMore = false;
                if ([401, 403, 404].includes(normalizeError(error).status)) { collaboration.detail = null; state.detail = null; state.works = []; updateCollaborationCards(); }
                showCollaborationError(error);
            } finally { scheduleCollaborationRead(); }
        }

        function scheduleCollaborationRead() {
            clearTimeout(collaborationReadTimer); collaborationReadTimer = null;
            if (state.mode !== 'collaboration' || !collaborationFlow() || !collaboration.detail?.run
                || !mediaRefreshPending && ['draft', 'delivered', 'cancelled'].includes(collaboration.detail.run.status)) return;
            const ctx = currentContext(), runId = collaboration.runId;
            collaborationReadTimer = setTimeout(async () => {
                if (!isCurrent(ctx) || state.mode !== 'collaboration' || runId !== collaboration.runId) return;
                if (document.hidden || hasUnsaved() || state.modalContent || state.loading || state.actionSaving || state.taskSaving || collaboration.busy || state.pendingMutation) {
                    scheduleCollaborationRead(); return;
                }
                mediaRefreshPending = false; await refreshCollaboration(false, false, true);
            }, 15000);
        }

        async function switchCollaborationRun(runId) {
            if (runId && !validId(runId)) return;
            if (!await confirmDiscard()) return;
            captureReadingAnchor(); persistView(); closeModal(); clearTransientDrafts();
            collaboration.runId = runId; collaboration.detail = null; restoreCollaborationDraft();
            state.selectedWorkId = ''; state.detail = null; await refreshCollaboration(false, !runId);
            if (!runId) openRequirementEditor();
        }

        function runLabel(result) {
            const run = result?.run;
            if (!run) return '未创建任务';
            if (run.paused || result.control?.pause_reason) return textOf(result.control?.pause_reason, '已暂停');
            return { draft: '需求已保存', active: '协作中', ready_for_acceptance: '待你验收', delivered: '本人已验收', cancelled: '已取消' }[run.status] || '等待处理';
        }

        function pendingWorks() { return recordList(collaboration.detail?.works).filter(work => ['offered', 'review', 'confirmation', 'unknown', 'failed', 'needs_material', 'revision'].includes(work.phase)); }
        function pendingQuestions() { return recordList(collaboration.detail?.questions).filter(q => ['open', 'answered', 'escalated'].includes(q.status)); }
        function renderTaskBar() {
            if (!bridge.engine || !collaborationFlow()) return;
            if (!taskBar) { taskBar = el('section', 'role-collaboration-taskbar'); taskBar.setAttribute('aria-label', '当前协作任务'); bindEvents(taskBar); document.body.append(taskBar); }
            taskBar.replaceChildren();
            taskBar.hidden = false;
            const detail = collaboration.detail, copy = el('div', 'role-taskbar-copy');
            copy.append(el('strong', '', textOf(detail?.requirements?.goal, collaborationFlow().name).slice(0, 80)), el('span', 'crw-muted', runLabel(detail)));
            const working = recordList(detail?.works).filter(work => work.phase === 'working');
            if (working.length) copy.append(el('small', '', working.map(work => work.snapshot?.role?.name || work.node_id).join('、') + '处理中'));
            taskBar.append(copy);
            const actions = el('div', 'role-taskbar-actions');
            const pending = button('待我处理 ' + (pendingWorks().length + pendingQuestions().length), 'collab-pending', '', 'bell');
            if (collaboration.questionsCursor) { pending.title = '已读取的待处理项，更多问题可分批读取'; pending.append(el('span', '', '+')); }
            actions.append(pending, button('本次成果', 'collab-results', '', 'clipboard-list'));
            if (detail?.run && !['draft', 'cancelled', 'delivered'].includes(detail.run.status)) actions.append(actionIcon(detail.run.paused ? 'play' : 'pause',
                detail.run.paused ? 'collab-resume' : 'collab-pause', detail.run.paused ? '继续任务' : '暂停任务'));
            actions.append(actionIcon('ellipsis', 'collab-more', '任务更多操作')); taskBar.append(actions);
        }

        function updateCollaborationCards() {
            const engine = bridge.engine, detail = collaboration.detail; if (!engine) return;
            for (const node of engine.nodes.values()) {
                const card = engine.canvas.querySelector('[data-node-id="' + CSS.escape(node.id) + '"]'); if (!card) continue;
                if (node.type === 'role-requirement' && node.data?.roleRequirement?.workflowId === collaboration.workflowId) {
                    const match = node.data.roleRequirement.runId === collaboration.runId && Boolean(detail);
                    const goal = card.querySelector('[data-role-goal]'); if (goal) goal.textContent = match ? detail.requirements.goal : node.data.roleRequirement.runId ? '打开查看此任务需求' : '未绑定草稿';
                    const status = card.querySelector('[data-role-run-status]'); if (status) status.textContent = match ? runLabel(detail) : '未读取';
                    const start = card.querySelector('[data-role-requirement-start]'); if (start) start.textContent = match && detail.run.status !== 'draft' ? '查看当前工作' : '开始协作';
                }
                if (node.type === 'role' && collaborationFlow()?.nodeIds.includes(node.id)) {
                    const work = recordList(detail?.works).find(item => item.node_id === node.id && item.phase !== 'superseded');
                    const participant = recordList(detail?.requirements?.participants).find(p => p.nodeId === node.id);
                    const title = card.querySelector('[data-role-current-work]'); if (title) title.textContent = work ? textOf(participant?.assignment, '本次工作') + ' · 第' + (work.round || 1) + '轮' : '待安排';
                    const status = card.querySelector('[data-role-current-phase]'); if (status) { status.textContent = work ? displayPhase(work.phase) : '未参与当前任务'; status.dataset.phase = work?.phase || ''; }
                    const reason = card.querySelector('[data-role-current-reason]'); if (reason) reason.textContent = work?.wait_reason || '';
                }
            }
        }

        function renderCollaboration() {
            const view = el('div', 'crw-view crw-collaboration');
            if (collaboration.editingRequirements) { view.append(buildRequirementEditor()); return view; }
            const selector = el('select', 'crw-select'); selector.dataset.collaborationRun = ''; selector.setAttribute('aria-label', '当前任务');
            appendOption(selector, '', '新需求草稿');
            collaboration.runs.forEach(run => appendOption(selector, run.id, textOf(run.goal, '本次需求').slice(0, 80) + ' · ' + runLabel({ run, control: run.control })));
            if (collaboration.runId && !collaboration.runs.some(run => run.id === collaboration.runId)) appendOption(selector, collaboration.runId, '当前指定任务');
            selector.value = collaboration.runId; view.append(selector);
            if (collaboration.cursor) view.append(button('更早任务', 'collab-more-runs', '', 'chevron-down'));
            const tabs = el('nav', 'crw-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '本次工作');
            [['work', '工作'], ['talk', '交流'], ['results', '成果']].forEach(([id, text]) => { const b = button(text, 'collab-tab'); b.dataset.tab = id;
                b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(id === state.tab)); b.tabIndex = id === state.tab ? 0 : -1; tabs.append(b); });
            view.append(tabs);
            if (state.tab === 'results') view.append(renderCollaborationResults());
            else if (state.tab === 'talk') view.append(renderCollaborationTalk());
            else view.append(renderCollaborationWork());
            const footer = el('footer', 'crw-collaboration-footer'); footer.append(button('本次成果', 'collab-results', '', 'clipboard-list'), button('查看历史', 'collab-history', '', 'history'));
            view.append(footer); return view;
        }

        function renderCollaborationWork() {
            const panel = el('section', 'crw-work'), detail = collaboration.detail;
            const req = detail?.requirements;
            if (!detail) { panel.append(renderEmpty('提需求', '先保存目标，之后再加入岗位与材料。'), button('提需求', 'collab-edit-requirement', 'primary', 'pencil')); return panel; }
            panel.append(el('h3', '', runLabel(detail)), summaryRow('目标', req.goal));
            const actions = el('div', 'crw-actions');
            actions.append(button('需求与分工', 'collab-edit-requirement', '', 'pencil'), button('范围与预算', 'collab-authorize', detail.run.status === 'draft' ? 'primary' : '', 'sliders-horizontal'));
            panel.append(actions);
            if (!detail.readiness?.enabled) panel.append(panelMessage(textOf(detail.readiness?.reason, '角色文字能力尚未启用；草稿与人工成果可保留。'), 'quiet'));
            if (detail.run.paused || detail.control?.pause_reason) panel.append(panelMessage(textOf(detail.control?.pause_reason, '任务已暂停，已发请求与原稿继续保留。'), 'warning'));
            const list = el('section', 'crw-work-list');
            recordList(detail.works).filter(work => work.phase !== 'superseded').forEach(work => {
                const row = el('div', 'crw-pending-row'); row.dataset.readingId = work.id;
                const copy = el('div', 'crw-pending-copy'), avatar = el('span', 'crw-avatar'); setIcon(avatar, work.snapshot?.role?.executor?.kind === 'ai' ? 'bot' : 'user-round');
                const p = req.participants.find(item => item.nodeId === work.node_id);
                copy.append(el('strong', '', work.snapshot?.role?.name || nodeTitle(state.nodes.find(n => n.id === work.node_id))),
                    el('span', '', textOf(p?.assignment, '本次分工待填写')), el('small', 'crw-muted', displayPhase(work.phase) + (work.wait_reason ? ' · ' + work.wait_reason : '')));
                const open = button('查看', 'collab-select-work', '', 'arrow-right'); open.dataset.workId = work.id;
                row.append(avatar, copy, open); list.append(row);
            });
            panel.append(list, renderRelationsList());
            const work = currentCollaborationWork(), workDetail = currentDetail();
            if (work && workDetail) {
                const p = req.participants.find(item => item.nodeId === work.node_id) || {};
                const section = el('section', 'crw-selected-work'); section.dataset.readingId = 'selected:' + work.id;
                section.append(el('h3', '', work.snapshot?.role?.name || '本次岗位'), summaryRow('分工', p.assignment || '待填写'),
                    summaryRow('交付', recordList(p.deliverableItems).join('、') || '按岗位长期交付要求'), summaryRow('验收', p.acceptanceCriteria || req.criteria || '待补充'));
                section.append(renderInputs(workDetail), renderDeliveries(workDetail));
                if (['offered', 'rejected'].includes(work.phase) && workDetail.summary?.action_available !== false) section.append(button('接收任务', 'work-accept', 'primary', 'check'),
                    button('申请补充材料', 'work-request-material', '', 'paperclip'), button('拒绝任务', 'work-reject', '', 'x'));
                if (work.phase === 'confirmation' && workDetail.summary?.action_available !== false) section.append(button('确认当前稿', 'work-approve', 'primary', 'check'), button('退回修改', 'work-return', '', 'undo-2'));
                if (work.phase === 'delivered' && workDetail.summary?.action_available !== false) section.append(button('继续修改', 'work-revise', '', 'pencil'));
                if (work.phase === 'review' && workDetail.summary?.action_available !== false) section.append(renderCollaborationReviewers(work, p));
                if (state.draftConflict) section.append(renderDraftConflict('work'));
                if (workDetail.summary?.action_available !== false && canOwnerSubmit(work.snapshot?.role?.executor, p)
                    && ['ready', 'working', 'revision'].includes(work.phase)) section.append(renderSubmissionEditor(workDetail,
                        { ...work.snapshot?.role, requiredItems: [...new Set([...recordList(work.snapshot?.role?.requiredItems), ...recordList(p.deliverableItems)])] }, p));
                const media = el('div', 'crw-actions');
                for (const kind of ['image', 'video']) { const b = button(kind === 'image' ? '生成图片' : '生成视频', 'collab-media', '', kind === 'image' ? 'image' : 'video'); b.dataset.kind = kind; media.append(b); }
                section.append(media);
                for (const binding of recordList(workDetail.media?.bindings).filter(binding => binding.workId === work.id)) {
                    const row = el('div', 'crw-pending-row'); row.append(el('span', '', textOf(binding.outputSlotId, '生成原件') + ' · '
                        + ({ pending: '生成中', unknown: '结果待确认', failed: '生成失败', ready: '原件已就绪', late: '迟到原件，仅归原工作' }[binding.state] || '状态待核对')));
                    const adopt = button('采用本次原件', 'collab-adopt-media'); adopt.dataset.bindingId = binding.id;
                    adopt.disabled = !['late', 'ready'].includes(binding.state); row.append(adopt); section.append(row);
                    row.append(el('small', 'crw-muted', Number.isFinite(binding.settledPoints) ? '已结算 ' + formatPoints(binding.settledPoints) + ' 点' : '费用待核对'));
                }
                if (workDetail.media?.limited) section.append(el('p', 'crw-muted', '媒体读取已到本次上限，部分旧记录未列出；不代表原件丢失或费用为零。'));
                if (work.phase === 'unknown') section.append(panelMessage('原请求结果未知，只读取原状态，不重发生成。', 'warning'));
                const history = button('工作历史', 'collab-work-history', '', 'history'); section.append(history); panel.append(section);
            }
            return panel;
        }

        function renderCollaborationReviewers(work, participant) {
            const box = el('section', 'crw-reviewers'); box.append(el('h4', '', '检查当前稿'));
            const relations = recordList(collaboration.detail?.requirements?.relations).filter(r => r.type === 'review' && r.from === work.node_id);
            for (const relation of relations) {
                const reviewer = recordList(collaboration.detail?.works).find(w => w.node_id === relation.to && w.phase !== 'superseded');
                const role = reviewer?.snapshot?.role, executor = role?.executor;
                const canAct = role?.reviewAuthority !== 'none' && Boolean(executor)
                    && (executor.kind === 'person' ? executor.userId === state.ctx.userId : participant.ownerMayReview === true);
                const row = el('div', 'crw-reviewer-row');
                row.append(el('strong', '', role?.name || '检查岗位'), el('span', 'crw-muted', executor?.kind === 'ai' ? 'AI 检查；本人代检查需明确授权' : '指定本人检查'));
                if (!canAct) row.append(el('p', 'crw-muted', '此岗位当前不可由本人代检查，原稿与检查关系保留。'));
                for (const [action, label] of [['approve', '检查通过'], ['return', '退回修改'], ['suggest', '补充建议']]) {
                    if (relation.authority !== 'approve' && action !== 'suggest') continue;
                    const b = button(label, 'collab-review-' + action, action === 'approve' ? 'primary' : '', action === 'approve' ? 'check' : action === 'return' ? 'undo-2' : 'message-square');
                    b.dataset.reviewerId = relation.to; b.disabled = !canAct; row.append(b);
                }
                box.append(row);
            }
            return box;
        }

        async function promptCollaborationReview(action, reviewerId) {
            const ctx = currentContext(), detail = currentDetail(), work = detail?.work, meta = workMeta(detail);
            if (!work?.current_delivery_id || !detail.input_digest) throw new Error('当前稿与输入版本未齐，请刷新后核对。');
            const reviewer = recordList(collaboration.detail?.works).find(w => w.node_id === reviewerId && w.phase !== 'superseded');
            if (action !== 'revise' && !reviewer) throw new Error('检查岗位已变化，请重读本次分工。');
            const role = reviewer?.snapshot?.role;
            const body = { delivery_id: meta.deliveryId, input_digest: meta.inputDigest,
                ...(reviewerId ? { reviewer_node_id: reviewerId } : {}),
                ...(role?.executor?.kind !== 'person' && reviewerId ? { owner_proxy: true } : {}) };
            if (action === 'approve') {
                if (!await bridge.confirm({ title: '通过当前稿？', message: '以本人名义确认 ' + (role.name || '检查岗位') + ' 对成果 v' + currentDeliveryVersion(detail)
                    + ' 的检查。不是 AI 自动批准，其他版本结论不沿用。', confirmText: '确认检查通过' })) return;
                assertWorkUnchanged(ctx, meta); return performWorkAction('approve', body, meta);
            }
            return collaborationPrompt(action === 'suggest' ? '补充检查建议' : '提出修改', [{ key: 'opinion', label: action === 'suggest'
                ? '建议以本人名义记录，不代表已通过。' : '写清当前稿 v' + currentDeliveryVersion(detail) + ' 需要修改什么；旧稿、原件和费用保留。' }],
                action === 'suggest' ? '保存建议' : '建立修订轮', async values => {
                    if (!clean(values.opinion)) throw new Error('请填写具体意见。');
                    assertWorkUnchanged(ctx, meta); return performWorkAction(action, { ...body, opinion: values.opinion }, meta);
                });
        }

        function renderRelationsList() {
            const flow = collaborationFlow(), section = el('details', 'crw-dependencies'); rememberDetails(section, 'relations:' + flow.id);
            section.append(el('summary', '', '关系 · ' + (flow.relations?.length || 0)));
            const visibility = button(collaboration.relationMode === 'all' ? '只突出相关关系' : '查看全部关系', 'collab-relation-mode', '', 'eye'); section.append(visibility);
            const search = el('input', 'crw-input'); search.type = 'search'; search.placeholder = '搜索关系'; search.setAttribute('aria-label', '搜索关系'); section.append(search);
            const rows = el('div');
            const name = id => id === 'requirement' ? '本次需求' : nodeTitle(state.nodes.find(node => node.id === id));
            const types = { accepts_requirement: '接收需求', handoff: '交接成果', guidance: '指导协作', review: '请对方检查' };
            (flow.relations || []).forEach(edge => { const b = button(name(edge.from) + ' → ' + name(edge.to) + ' · ' + types[edge.type], 'collab-edit-relation');
                b.dataset.relationId = edge.id; rows.append(b); });
            search.addEventListener('input', () => rows.querySelectorAll('button').forEach(b => { b.hidden = !b.textContent.includes(search.value.trim()); }));
            section.append(rows, button('撤销上次关系修改', 'collab-undo-relation', '', 'undo-2'));
            section.append(el('p', 'crw-muted', '配置修改默认下次任务生效，当前任务需明确应用新修订。')); return section;
        }

        function renderCollaborationTalk() {
            const panel = el('section', 'crw-talk'), detail = collaboration.detail;
            if (!detail) return renderEmpty('还没有已保存任务', '先保存需求，再进行交流。');
            if (currentDetail()) {
                const talk = renderTalk(); talk.querySelector('[data-message-from]')?.remove(); panel.append(talk);
            } else panel.append(el('p', 'crw-muted', '选择一个岗位，可给它补充要求或回应修改意见。'));
            const questions = el('section', 'crw-questions'); questions.append(el('h3', '', '需要回应的问题'));
            recordList(detail.questions).forEach(question => {
                const body = parseJson(question.body_json || question.body, {}), row = el('article', 'crw-question'); row.dataset.readingId = question.id;
                const source = recordList(detail.works).find(w => w.id === question.from_work_id), target = recordList(detail.works).find(w => w.id === question.target_work_id);
                const heading = el('div', 'crw-message-head'), avatar = el('span', 'crw-avatar'); setIcon(avatar, authorIcon(actualAuthor(question)));
                heading.append(avatar, el('strong', '', (source?.snapshot?.role?.name || '岗位') + ' · ' + authorLabel(question) + ' → ' + (target?.snapshot?.role?.name || '本人'))); addTime(heading, question.created_at);
                row.append(heading, el('p', 'crw-message-copy', textOf(body.question || question.question, '问题正文待读取')),
                    el('small', 'crw-muted', ({ open: '待答复', answering: '答复中', answered: '已答复，未解除阻塞', resolved: '已解决', escalated: '转本人处理', cancelled: '已取消' }[question.status] || '状态待同步') + (question.blocking ? ' · 阻塞相关工作' : '')));
                if (question.answer) {
                    const answer = question.answer, answerDetail = parseJson(answer.detail_json || answer.detail, {});
                    const answerHead = el('div', 'crw-message-head'), answerAvatar = el('span', 'crw-avatar');
                    setIcon(answerAvatar, authorIcon(actualAuthor(answer)));
                    answerHead.append(answerAvatar, el('strong', '', '答复 · ' + authorLabel(answer))); addTime(answerHead, answer.created_at);
                    row.append(answerHead, el('p', 'crw-message-copy', textOf(answerDetail.text, '答复待读取')));
                }
                for (const [action, text] of [['answer', '答复'], ['resolve', '确认已解决'], ['escalate', '转本人'], ['cancel', '取消问题']]) {
                    if (action === 'answer' && (question.answer || !['open', 'escalated'].includes(question.status))) continue;
                    if (['resolved', 'cancelled'].includes(question.status) || action === 'resolve' && question.status !== 'answered') continue;
                    const b = button(text, 'collab-question-' + action, action === 'answer' ? 'primary' : ''); b.dataset.questionId = question.id; row.append(b);
                }
                questions.append(row);
            });
            if (collaboration.questionsCursor) questions.append(button('更早问题', 'collab-more-questions', '', 'chevron-down'));
            if (currentCollaborationWork()) questions.append(button('提出问题', 'collab-ask', '', 'message-square'));
            panel.append(questions); return panel;
        }

        function renderCollaborationResults() {
            const panel = el('section', 'crw-results'), detail = collaboration.detail;
            if (!detail) return renderEmpty('还没有成果', '需求与分工保存后，可在这里查看实际提交稿。');
            const manifest = detail.manifest;
            panel.append(el('h3', '', detail.run.status === 'delivered' ? '本人已验收' : manifest ? '本次成果' : '成果待齐'));
            if (!manifest) {
                panel.append(el('p', 'crw-muted', '尚未形成有效整合稿，已有成果仍可查看。'));
                const required = new Set(recordList(detail.requirements?.participants).filter(p => p.participation === 'required').map(p => p.nodeId));
                if (validId(detail.requirements?.finalNodeId)) required.add(detail.requirements.finalNodeId);
                if (!detail.requirements?.finalNodeId) panel.append(el('p', '', '最终整合岗位尚未指定。'));
                for (const nodeId of required) {
                    const work = recordList(detail.works).find(w => w.node_id === nodeId && w.phase !== 'superseded'
                        && w.requirements_revision === detail.run.requirements_revision);
                    if (work?.phase === 'delivered' && validId(work.current_delivery_id)) continue;
                    panel.append(el('p', '', (work?.snapshot?.role?.name || nodeTitle(state.nodes.find(n => n.id === nodeId)))
                        + ' · ' + (work ? displayPhase(work.phase) : '尚无当前工作')));
                }
            }
            const deliveries = manifest ? recordList(manifest.deliveries) : recordList(detail.works)
                .filter(w => w.phase !== 'superseded' && validId(w.current_delivery_id) && w.requirements_revision === detail.run.requirements_revision)
                .map(w => ({ workId: w.id, deliveryId: w.current_delivery_id }));
            for (const delivery of deliveries) {
                const id = delivery.deliveryId || delivery.id; if (!validId(id)) continue;
                const row = el('div', 'crw-delivery-row'); row.dataset.readingId = id;
                const work = recordList(detail.works).find(w => w.id === delivery.workId);
                row.append(el('strong', '', work?.snapshot?.role?.name || '有效成果'), el('span', 'crw-muted',
                    (delivery.version ? 'v' + delivery.version + ' · ' : '') + (work ? displayPhase(work.phase) : '版本待核对')));
                if (delivery.acceptanceCriteria) row.append(summaryRow('验收要求', delivery.acceptanceCriteria));
                const b = button('查看原稿与原件', 'collab-delivery', '', 'file-text'); b.dataset.deliveryId = id; row.append(b); panel.append(row);
            }
            if (manifest) {
                appendTextList(panel, '验收要求', manifest.criteria, '未记录验收要求。');
                const changes = el('section', 'crw-result-changes'); changes.append(el('h3', '', '修改意见与回应'));
                if (!recordList(manifest.changes).length) changes.append(el('p', 'crw-muted', '本次没有返工记录。'));
                for (const change of recordList(manifest.changes)) {
                    if (!isRecord(change)) continue;
                    const row = el('section', 'crw-result-change'), work = recordList(detail.works).find(w => w.id === change.workId);
                    row.append(el('h4', '', work?.snapshot?.role?.name || '成果修订'), summaryRow('修改意见', textOf(change.opinion, '原记录未提供修改意见')));
                    appendTextList(row, '本稿回应', change.response, '本稿未记录修改回应。');
                    for (const [id, label] of [[change.sourceDeliveryId, '查看修订原稿'], [change.currentDeliveryId, '查看修改后稿件']]) {
                        if (!validId(id)) continue;
                        const open = button(label, 'collab-delivery', '', 'file-text'); open.dataset.deliveryId = id; row.append(open);
                    }
                    changes.append(row);
                }
                panel.append(changes);
                if (detail.run.status !== 'delivered') panel.append(button('验收本次成果', 'collab-accept-result', 'primary', 'check'), button('需要修改', 'collab-reject-result', '', 'undo-2'));
            }
            if (currentDetail()) panel.append(renderDeliveries(currentDetail()));
            panel.append(renderCost(detail.run, currentDetail()?.attempts, currentDetail()?.execution));
            panel.append(el('p', 'crw-muted', '成果验收与费用结清分开；费用待核对不因验收消失。'));
            panel.append(button('事实回顾与规则', 'collab-retrospective', '', 'history'), button('保存为工作流模板', 'collab-save-template', '', 'save'));
            return panel;
        }

        function appendTextList(parent, title, value, empty) {
            const section = el('section', 'crw-text-list'); section.append(el('h3', 'crw-delivery-item-title', title));
            const rows = typeof value === 'string' ? [value] : recordList(value).filter(item => typeof item === 'string');
            const texts = rows.filter(item => item.trim());
            if (texts.length) {
                const list = el('ol'); texts.forEach(text => list.append(el('li', 'crw-delivery-fulltext', text))); section.append(list);
            } else section.append(el('p', 'crw-muted', empty));
            parent.append(section);
        }

        function collabField(parent, label, key, value, options) {
            options = options || {};
            const field = el('label', 'crw-field'); field.append(el('span', 'crw-field-label', label));
            const input = el(options.type === 'select' ? 'select' : options.multiline ? 'textarea' : 'input', options.multiline ? 'crw-textarea' : options.type === 'select' ? 'crw-select' : 'crw-input');
            input.dataset.collaborationField = key; if (options.nodeId) input.dataset.nodeId = options.nodeId;
            if (options.multiline) { input.rows = options.rows || 3; input.maxLength = options.maxLength || 12000; }
            else if (options.type === 'number') { input.type = 'number'; input.min = options.min ?? '0'; input.max = options.max ?? '1000000'; input.step = options.step || '1'; }
            if (options.type === 'select') for (const [id, text] of options.options || []) appendOption(input, id, text);
            input.value = value ?? ''; field.append(input); parent.append(field); return input;
        }

        function updateCollaborationDraft(target) {
            const key = target.dataset.collaborationField;
            if (state.modalKind === 'collab-authorization' && authorizationDraft) {
                authorizationDraft[key] = target.value; return;
            }
            const draft = collaboration.draft; if (!draft) return;
            if (target.dataset.nodeId) {
                const p = draft.participants.find(item => item.nodeId === target.dataset.nodeId); if (!p) return;
                if (['deliverableItems', 'requiredInputs'].includes(key)) p[key] = target.value.split('\n').map(s => s.trim()).filter(Boolean);
                else p[key] = target.type === 'checkbox' ? target.checked : target.value;
            } else if (key === 'materialNodes') draft.materialNodes = [...(state.modalContent || state.root).querySelectorAll('[data-collaboration-field="materialNodes"]:checked')].map(n => n.value);
            else if (['goal', 'criteria', 'title', 'finalNodeId'].includes(key)) draft[key] = target.value;
            collaboration.dirty = true;
        }

        function openRequirementEditor() {
            collaboration.editingRequirements = true; state.open = true; state.mode = 'collaboration'; persistView(); render();
        }

        function buildRequirementEditor() {
            if (!collaborationFlow()) return;
            if (!collaboration.draft || collaboration.draft.workflowId !== collaboration.workflowId || collaboration.draft.runId !== collaboration.runId) collaboration.draft = newCollaborationDraft();
            const draft = collaboration.draft, content = el('div', 'crw-requirement-editor');
            content.append(el('h2', 'crw-dialog-title', collaboration.runId ? '需求与分工' : '提需求'));
            if (collaboration.runId) content.append(panelMessage('默认只改下次任务配置。明确用于当前任务时，新修订会暂停旧授权，保留在途请求与原稿。', 'quiet'));
            if (draft.runId && draft.baseRevision !== Number(collaboration.detail?.run?.revision)) {
                const conflict = el('aside', 'crw-draft-conflict');
                conflict.append(panelMessage('任务版本已变化，以下是保留的草稿。先核对已保存需求，再决定是否继续用于当前任务。', 'warning'),
                    button('核对已保存需求', 'collab-rebase-draft', '', 'search'));
                content.append(conflict);
            }
            if (draft.pauseReceiptId) {
                const pause = el('div', 'crw-actions');
                pause.append(el('span', 'crw-muted', '此草稿曾因原请求未确认而暂停，尚未自动应用。'), button('查看暂停回执', 'collab-view-pause-receipt', '', 'file-text'));
                content.append(pause);
            }
            collabField(content, '目标', 'goal', draft.goal, { multiline: true, rows: 4 });
            collabField(content, '验收要求', 'criteria', draft.criteria, { multiline: true, maxLength: 8000 });
            for (const nodeId of collaborationFlow().nodeIds) if (!draft.participants.some(p => p.nodeId === nodeId)) draft.participants.push({
                nodeId, participation: 'excluded', reviewerNodeId: null, confirmRequired: false, ownerMaySubmit: false, ownerMayReview: false,
                dependencies: [], assignment: '', deliverableItems: [], requiredInputs: [], acceptanceCriteria: '' });
            content.append(el('h3', 'crw-form-section-title', '本次分工'));
            for (const p of draft.participants) {
                const node = state.nodes.find(n => n.id === p.nodeId), details = el('details', 'crw-participant');
                details.append(el('summary', '', node ? nodeTitle(node) : '岗位已移除'));
                collabField(details, '本次参与', 'participation', p.participation, { type: 'select', nodeId: p.nodeId, options: [['required', '必交'], ['optional', '可选'], ['excluded', '不参与']] });
                collabField(details, '本次工作', 'assignment', p.assignment, { nodeId: p.nodeId, multiline: true });
                collabField(details, '交付项（每行一项）', 'deliverableItems', recordList(p.deliverableItems).join('\n'), { nodeId: p.nodeId, multiline: true, maxLength: 4800 });
                collabField(details, '需要的输入（每行一项）', 'requiredInputs', recordList(p.requiredInputs).join('\n'), { nodeId: p.nodeId, multiline: true, maxLength: 7200 });
                collabField(details, '本次验收要求', 'acceptanceCriteria', p.acceptanceCriteria, { nodeId: p.nodeId, multiline: true, maxLength: 8000 });
                for (const [key, label] of [['confirmRequired', '此岗位交付需要本人确认'], ['ownerMaySubmit', '允许本人代提交'], ['ownerMayReview', '允许本人代检查']]) {
                    const row = el('label', 'crw-check-row'), check = el('input'); check.type = 'checkbox'; check.dataset.collaborationField = key; check.dataset.nodeId = p.nodeId; check.checked = p[key]; row.append(check, el('span', '', label)); details.append(row);
                }
                content.append(details);
            }
            collabField(content, '最终整合岗位', 'finalNodeId', draft.finalNodeId, { type: 'select', options: [['', '稍后选择'],
                ...state.nodes.filter(node => collaborationFlow().nodeIds.includes(node.id)).map(node => [node.id, nodeTitle(node)])] });
            const materials = el('details', 'crw-dependencies'); materials.append(el('summary', '', '材料 · ' + draft.materialNodes.length));
            state.materials.forEach(node => { if (node.type === 'role-requirement') return; const row = el('label', 'crw-check-row'), check = el('input');
                check.type = 'checkbox'; check.value = node.id; check.dataset.collaborationField = 'materialNodes'; check.checked = draft.materialNodes.includes(node.id); row.append(check, el('span', '', node.title)); materials.append(row); });
            if (typeof bridge.selectRoleMaterials === 'function') materials.append(button('选择或上传材料', 'collab-pick-materials', '', 'paperclip'));
            else materials.append(el('p', 'crw-muted', '先在原画布上传或粘贴材料，再从这里选取。'));
            content.append(materials);
            const error = el('p', 'crw-message crw-message--error'); error.dataset.actionError = ''; error.hidden = true; content.append(error);
            const footer = el('footer', 'crw-dialog-footer'); footer.append(button('返回', 'collab-close-editor', 'quiet'));
            if (collaboration.runId) footer.append(button('保存下次任务配置', 'collab-save-configuration', 'primary', 'save'), button('用于当前任务', 'collab-save-current', '', 'check'));
            else footer.append(button('保存需求草稿', 'collab-save-request', 'primary', 'save'));
            content.append(footer); return content;
        }

        async function saveCollaborationRelations(workflowId, relations, extra) {
            if (typeof bridge.saveRoleWorkflowConfiguration !== 'function') throw new Error('关系保存桥接尚未集成，未写入当前任务。');
            if (state.pendingMutation) throw new Error('请先查询原操作回执；关系输入保留，未改变当前任务。');
            const flow = (bridge.engine.roleWorkflows || []).find(f => f.id === workflowId); if (!flow) throw new Error('工作流已变化。');
            const ctx = currentContext();
            globalThis.UltimateCanvasRoleRouting?.validate(flow, relations);
            const values = { ...extra, relations: copyJson(relations) };
            await bridge.saveRoleWorkflowConfiguration(workflowId, values);
            if (isCurrent(ctx) && collaboration.workflowId === workflowId) { routing?.render(); persistView(); }
        }

        async function saveCollaborationRequest(applyCurrent) {
            const draft = collaboration.draft, ctx = currentContext(); if (!draft || collaboration.busy) return;
            if (state.pendingMutation) throw new Error('先查询或核对原操作回执；当前需求草稿保留，未再次保存。');
            const submitted = validCollaborationDraft(draft);
            if (!submitted) throw new Error('需求草稿格式不完整，请核对当前输入。');
            const req = collaborationRequirements(submitted);
            if (!req.goal) throw new Error('请填写目标，其余内容可稍后补齐。');
            if (req.participants.some(p => p.participation !== 'excluded' && !state.nodes.some(n => n.id === p.nodeId))) throw new Error('参与岗位已移除，请先调整分工。');
            globalThis.UltimateCanvasRoleRouting?.validate(collaborationFlow(), req.relations);
            if (draft.runId && draft.baseRevision !== Number(collaboration.detail?.run?.revision)) throw new Error('任务已更新，原草稿保留；先刷新核对，再明确采用当前版本。');
            if (!draft.runId && typeof bridge.adoptRoleRunReceipt !== 'function') throw new Error('需求卡同事务回执桥接尚未集成，未提交新任务。');
            if (draft.runId && applyCurrent) {
                const affected = recordList(collaboration.detail?.works).filter(w => w.phase !== 'superseded').map(w => w.snapshot?.role?.name || '岗位');
                if (!await bridge.confirm({ title: '用于当前任务？', message: '将按本次分工重新核对受影响工作（' + affected.join('、') + '）。旧授权撤销并暂停；已发请求与账单归原版本，不重发。', confirmText: '保存当前修订' })) return;
            }
            if (!isCurrent(ctx) || collaboration.draft !== draft || JSON.stringify(validCollaborationDraft(draft)) !== JSON.stringify(submitted)) {
                throw new Error('确认期间需求草稿已变化，请核对后重新保存。');
            }
            collaboration.busy = true; state.taskSaving = true;
            collaboration.dirty = true; persistView(); updatePendingControls();
            try {
                const saved = await bridge.saveDocument('before_role_requirements_v2');
                if (!isCurrent(ctx) || draft !== collaboration.draft) return;
                if (!saved || !sameContext(saved, ctx) || !Number.isSafeInteger(saved.documentRevision)) throw new Error('原画布保存结果未确认，需求草稿保留。');
                const payload = { document_id: saved.documentId, document_revision: saved.documentRevision, requirements: req,
                    ...(submitted.runId ? { base_revision: submitted.baseRevision, requirements_revision: submitted.requirementsRevision, apply_current: applyCurrent === true }
                        : { ...(bridge.engine.nodes.get(state.selectedNodeId)?.type === 'role-requirement'
                            && !bridge.engine.nodes.get(state.selectedNodeId).data?.roleRequirement?.runId ? { requirement_node_id: state.selectedNodeId } : {}),
                            position: { x: (bridge.engine.container.clientWidth / 2 - bridge.engine.offsetX) / bridge.engine.scale,
                            y: (bridge.engine.container.clientHeight / 2 - bridge.engine.offsetY) / bridge.engine.scale } }) };
                const result = await sendMutation(apiUrl('/role-runs' + (submitted.runId ? '/' + encodeURIComponent(submitted.runId) : '')), payload,
                    submitted.runId ? 'collaboration_update' : 'collaboration', '', submitted);
                if (!result || !isCurrent(ctx)) return;
                await adoptCollaborationReceipt(ctx, state.pendingMutation, result);
                if (isCurrent(ctx)) await refreshCollaboration(false);
            } finally { if (isCurrent(ctx)) { collaboration.busy = false; state.taskSaving = false; persistView(); updatePendingControls(); } }
        }

        async function rebaseCollaborationDraft(paused) {
            const ctx = currentContext(), draft = collaboration.draft, pending = state.pendingMutation;
            if (!draft?.runId || collaboration.busy) return;
            if (pending && (!paused || !pending.pausedWaiting || pending.runId !== draft.runId)) throw new Error('请先查询原操作回执。');
            const runId = draft.runId;
            if (paused) {
                const receipt = await recoverReceipt(ctx, pending);
                if (!isCurrent(ctx) || collaboration.draft !== draft) return;
                if (!receipt || receipt.run?.id !== runId || receipt.applied !== false || receipt.pending !== true) {
                    throw new Error('尚未确认原暂停回执，继续保留草稿与原请求编号。');
                }
            }
            const latest = await requestJson(apiUrl('/role-runs/' + encodeURIComponent(runId)), { method: 'GET' });
            if (!isCurrent(ctx) || collaboration.draft !== draft || collaboration.runId !== runId) return;
            if (latest.run?.id !== runId || latest.run.document_id !== ctx.documentId || latest.requirements?.workflowId !== draft.workflowId
                || !Number.isSafeInteger(latest.run.revision) || !Number.isSafeInteger(latest.run.requirements_revision)) throw new Error('当前任务版本未确认，未改变草稿。');
            const approved = await bridge.confirm({ title: '继续编辑草稿？',
                message: '已保存目标：' + textOf(latest.requirements.goal, '未记录') + '\n已保存验收要求：' + textOf(latest.requirements.criteria, '未记录')
                    + '\n保留你的完整草稿，以此版本继续编辑。此操作不保存新需求、不恢复授权；再次保存时仍会核对原请求与费用。',
                confirmText: '保留草稿继续编辑' });
            if (!approved || !isCurrent(ctx) || collaboration.draft !== draft || collaboration.runId !== runId || state.pendingMutation !== pending) return;
            draft.baseRevision = latest.run.revision; draft.requirementsRevision = latest.run.requirements_revision;
            collaboration.dirty = true; state.taskConflict = false; collaboration.editingRequirements = true;
            if (paused) { draft.pauseReceiptId = pending.mutationId; clearPendingMutation(ctx, pending); }
            persistView(); await refreshCollaboration(false);
        }

        function openAuthorization() {
            const detail = collaboration.detail; if (!detail) throw new Error('请先保存需求草稿。');
            authorizationDraft = { budget_points_limit: '', budget_cny: '', reserve_cny: '', max_calls: String(Math.min(3 * detail.requirements.participants.filter(p => p.participation !== 'excluded').length + 4, 100)),
                max_rounds: '3', expires_in_seconds: '86400', media: [] };
            const content = el('div', 'crw-dialog-content'); content.append(el('h2', 'crw-dialog-title', '范围与预算'));
            content.append(panelMessage('授权仅用于本任务。离开页面后可继续；暂停只停止新调用，已发请求不取消或退款。', 'quiet'));
            for (const p of detail.requirements.participants.filter(p => p.participation !== 'excluded')) {
                const work = detail.works.find(w => w.node_id === p.nodeId), role = work?.snapshot?.role || roleConfig(state.nodes.find(n => n.id === p.nodeId)).snapshot;
                content.append(summaryRow(role.name || '岗位', (p.assignment || '本次分工未填') + '\n' + executorLabel(role.executor) + ' · ' + (role.tools || []).join('、') + (p.confirmRequired ? '\n交付须本人确认' : '')));
            }
            const reviews = detail.requirements.relations.filter(r => r.type === 'review');
            content.append(summaryRow('检查', reviews.length ? reviews.map(r => nodeTitle(state.nodes.find(n => n.id === r.from)) + ' → ' + nodeTitle(state.nodes.find(n => n.id === r.to))
                + (r.authority === 'approve' ? '（可通过或退回）' : '（仅建议）')).join('\n') : '未指定角色检查；最终成果仍由本人验收'));
            collabField(content, '本任务总点数上限（含绑定图片视频）', 'budget_points_limit', '', { type: 'number', step: '0.01' });
            collabField(content, '文字调用控制额度（人民币等值）', 'budget_cny', '', { type: 'number', step: '0.000007', max: 7000 });
            collabField(content, '单次文字预留（人民币等值）', 'reserve_cny', '', { type: 'number', step: '0.000007', max: 7000 });
            collabField(content, '最多模型调用次数', 'max_calls', authorizationDraft.max_calls, { type: 'number', min: 1, max: 1000 });
            collabField(content, '最多修订轮次', 'max_rounds', '3', { type: 'number', min: 1, max: 100 });
            collabField(content, '授权有效期（秒）', 'expires_in_seconds', '86400', { type: 'number', min: 1, max: 86400 });
            content.append(el('p', 'crw-muted', '文字按实费 1 美元 = 35 点，人民币按 1 美元 = ' + currencyRate() + ' 元显示。预留不是报价，也不是供应商硬限额。金额不自动填入。'));
            const media = el('details', 'crw-dependencies'); media.append(el('summary', '', '允许使用的图片视频范围'));
            const rows = el('div'); media.append(rows);
            const add = button('添加明确媒体范围', 'collab-add-media');
            add.addEventListener('click', () => {
                if (authorizationDraft.media.length >= 20) return;
                const entry = { kind: 'image', model: '', providerId: null, maxPoints: '' }; authorizationDraft.media.push(entry);
                const line = el('fieldset', 'crw-participant'); line.append(el('legend', '', '媒体范围'));
                const addField = (name, key, type, values) => { const l = el('label', 'crw-field'); l.append(el('span', 'crw-field-label', name));
                    const input = el(type === 'select' ? 'select' : 'input', 'crw-input'); if (values) values.forEach(v => appendOption(input, v, v === 'image' ? '图片' : '视频'));
                    else { input.type = type || 'text'; if (type === 'number') { input.min = '0'; input.step = '0.01'; } }
                    input.value = entry[key] || ''; input.addEventListener('input', () => { entry[key] = key === 'providerId' ? input.value || null : input.value; }); l.append(input); line.append(l); };
                addField('类型', 'kind', 'select', ['image', 'video']); addField('模型标识', 'model'); addField('供应商标识（沿默认可留空）', 'providerId'); addField('本项点数上限', 'maxPoints', 'number');
                const remove = el('button', 'crw-icon-button'); remove.type = 'button'; remove.setAttribute('aria-label', '移除此范围'); setIcon(remove, 'trash-2');
                remove.addEventListener('click', () => { authorizationDraft.media = authorizationDraft.media.filter(item => item !== entry); line.remove(); }); line.append(remove); rows.append(line);
            });
            media.append(add); content.append(media);
            if (!detail.readiness?.enabled) content.append(panelMessage(textOf(detail.readiness?.reason, '角色文字政策未启用。'), 'warning'));
            const error = el('p', 'crw-message crw-message--error'); error.dataset.actionError = ''; error.hidden = true; content.append(error);
            const footer = el('footer', 'crw-dialog-footer'); footer.append(button('取消', 'dialog-cancel', 'quiet'));
            const start = button('授权并开始协作', 'collab-authorize-start', 'primary', 'play'); start.disabled = !detail.readiness?.enabled; footer.append(start);
            content.append(footer); openModal('collab-authorization', content);
        }

        function controlVersions() {
            const detail = collaboration.detail; if (!detail?.run || !detail.control) throw new Error('任务控制状态尚未读取。');
            return { base_revision: Number(detail.run.revision), requirements_revision: Number(detail.run.requirements_revision), control_revision: Number(detail.control.revision) };
        }

        async function collaborationControl(action, extra) {
            if (collaboration.busy) return;
            const ctx = currentContext(), id = collaboration.runId, detail = collaboration.detail;
            if (!id || !detail) throw new Error('先选择已保存的任务。');
            const payload = { action, ...controlVersions(), ...extra };
            if (['revoke_authorization', 'cancel', 'pause'].includes(action)) {
                if (!await bridge.confirm({ title: action === 'cancel' ? '取消任务？' : action === 'pause' ? '暂停任务？' : '撤销授权？',
                    message: '停止新的调用。保留已发请求、成果、历史及费用，不代表供应商请求取消或退款。', confirmText: action === 'cancel' ? '取消任务' : action === 'pause' ? '暂停任务' : '撤销授权' })) return;
            }
            if (!isCurrent(ctx) || collaboration.detail !== detail) throw new Error('任务状态已变化，未提交旧操作。');
            collaboration.busy = true; state.actionSaving = true;
            try {
                const result = await sendMutation(apiUrl('/role-runs/' + encodeURIComponent(id) + '/control'), payload, 'collaboration');
                if (!result || !isCurrent(ctx) || collaboration.runId !== id) return;
                if (action === 'authorize') { authorizationDraft = null; closeModal(); }
                bridge.notice?.(result.queued ? '已保存并入队，尚未证明已执行完成。' : '操作已保存，将读取实际状态。', 'success');
                await refreshCollaboration(false);
            } finally { collaboration.busy = false; state.actionSaving = false; persistView(); }
        }

        async function authorizeStart() {
            const draft = authorizationDraft; if (!draft) return;
            const points = scaledAmount(draft.budget_points_limit, 100, 1000000), rate = currencyRate();
            const usd = draft.budget_cny === '' ? null : scaledAmount(Number(draft.budget_cny) / rate, 1000000, 1000);
            const reserve = draft.reserve_cny === '' ? null : scaledAmount(Number(draft.reserve_cny) / rate, 1000000, 1000);
            if (points === null || points <= 0 || usd === null || usd <= 0 || reserve === null || reserve <= 0 || reserve > usd) throw new Error('请明确总点数、文字额度及单次预留，单次预留不能高于文字总额度。');
            const maxCalls = finiteInteger(draft.max_calls, 1, 1000), maxRounds = finiteInteger(draft.max_rounds, 1, 100), expiry = finiteInteger(draft.expires_in_seconds, 1, 86400);
            if (!maxCalls || !maxRounds || !expiry) throw new Error('请核对调用次数、轮次与授权有效期。');
            const media = draft.media.map(entry => { const max = scaledAmount(entry.maxPoints, 100, 1000000);
                if (!clean(entry.model) || clean(entry.model).length > 120 || entry.providerId && !validId(entry.providerId) || max === null) throw new Error('每项媒体范围须明确模型、供应商及点数上限。');
                return { kind: entry.kind, model: clean(entry.model), providerId: entry.providerId, maxPoints: max / 100 }; });
            await collaborationControl('authorize', { start: true, budget_points_limit: points / 100, budget_usd_micros_limit: usd,
                reserve_usd_micros: reserve, max_calls: maxCalls, max_rounds: maxRounds, expires_in_seconds: expiry, media });
        }

        async function collaborationPrompt(title, fields, submitText, onSubmit) {
            const content = el('div', 'crw-dialog-content'); content.append(el('h2', 'crw-dialog-title', title));
            const inputs = {};
            fields.forEach(field => { const l = el('label', 'crw-field'); l.append(el('span', 'crw-field-label', field.label));
                if (field.note) l.append(el('span', 'crw-muted', field.note));
                const input = el(field.options ? 'select' : field.check ? 'input' : 'textarea', field.check ? '' : field.options ? 'crw-select' : 'crw-textarea');
                if (field.options) field.options.forEach(([id, name]) => appendOption(input, id, name));
                if (field.check) { input.type = 'checkbox'; input.checked = Boolean(field.value); } else { input.value = field.value || ''; input.maxLength = field.maxLength || 16000; }
                l.append(input); content.append(l); inputs[field.key] = input;
            });
            const error = el('p', 'crw-message crw-message--error'); error.hidden = true; error.setAttribute('role', 'alert'); content.append(error);
            const footer = el('footer', 'crw-dialog-footer'); footer.append(button('取消', 'dialog-cancel', 'quiet'));
            const submit = el('button', 'crw-button crw-button--primary', submitText); submit.type = 'button';
            const ctx = currentContext(), runId = collaboration.runId, workId = state.selectedWorkId;
            state.actionDraft = { kind: 'collab-prompt' }; state.actionDraftDirty = false;
            Object.values(inputs).forEach(input => input.addEventListener('input', () => { state.actionDraftDirty = true; }));
            submit.addEventListener('click', async () => {
                if (submit.disabled || !isCurrent(ctx) || runId !== collaboration.runId || workId !== state.selectedWorkId) return;
                submit.disabled = true; state.actionSaving = true;
                const values = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.type === 'checkbox' ? input.checked : input.value]));
                try {
                    await onSubmit(values);
                    if (state.pendingMutation) throw new Error('原操作结果尚未确认，输入保留；只查询原回执，不重发。');
                    if (isCurrent(ctx) && runId === collaboration.runId) { state.actionDraftDirty = false; state.actionDraft = null; closeModal(); await refreshCollaboration(false); }
                }
                catch (e) { if (isCurrent(ctx)) { error.textContent = normalizeError(e).message; error.hidden = false; } }
                finally { submit.disabled = false; state.actionSaving = false; }
            });
            footer.append(submit); content.append(footer); openModal('collab-prompt', content);
        }

        async function collaborationAction(action, target) {
            if (action.startsWith('collab-review-')) return promptCollaborationReview(action.slice('collab-review-'.length), target.dataset.reviewerId);
            if (action === 'collab-close-editor') { if (!await confirmDiscard()) return; collaboration.editingRequirements = false; render(); return; }
            if (action === 'collab-tab') { captureReadingAnchor(); state.tab = target.dataset.tab; persistView(); render(); return; }
            if (action === 'collab-results') { state.open = true; state.mode = 'collaboration'; state.tab = 'results'; persistView(); render(); return; }
            if (action === 'collab-edit-requirement') return openRequirementEditor();
            if (action === 'collab-save-request') return saveCollaborationRequest(false);
            if (action === 'collab-save-current') return saveCollaborationRequest(true);
            if (action === 'collab-rebase-draft') return rebaseCollaborationDraft(false);
            if (action === 'collab-recheck-paused') return rebaseCollaborationDraft(true);
            if (action === 'collab-view-pause-receipt') {
                const ctx = currentContext(), draft = collaboration.draft, id = draft?.pauseReceiptId;
                if (!validId(id)) return;
                const receipt = await requestJson(apiUrl('/role-receipts/' + encodeURIComponent(id)), { method: 'GET' });
                if (!isCurrent(ctx) || collaboration.draft !== draft) return;
                if (receipt?.mutation_id !== id || receipt.run?.id !== draft.runId) throw new Error('原暂停回执身份未确认。');
                const content = el('div', 'crw-dialog-content'); content.append(el('h2', '', '原暂停回执'),
                    panelMessage(receipt.applied === false ? '此操作只暂停了新派发，当时未保存新需求。当前状态请以本次任务为准。' : '原操作结果请核对当前任务。', 'quiet'),
                    recordDetails([['请求编号', id]]), button('关闭', 'dialog-readonly-close', 'primary'));
                openModal('pause-receipt', content); return;
            }
            if (action === 'collab-save-configuration') {
                const draft = collaboration.draft, ctx = currentContext(); if (!draft || collaboration.busy) return;
                if (state.pendingMutation) throw new Error('先核对原操作回执；当前草稿仍保留。');
                const req = collaborationRequirements(draft), version = JSON.stringify(draft), savedReq = collaboration.detail?.requirements;
                const hasUnsavedRequirements = draft.goal !== (savedReq?.goal || '') || draft.criteria !== (savedReq?.criteria || '')
                    || JSON.stringify(draft.materialNodes) !== JSON.stringify(savedReq?.materialNodes || []) || Boolean(draft.pauseReceiptId);
                collaboration.busy = true; state.taskSaving = true; updatePendingControls();
                try {
                    await saveCollaborationRelations(draft.workflowId, req.relations, { participants: req.participants, finalNodeId: req.finalNodeId });
                    if (!isCurrent(ctx) || collaboration.draft !== draft) return;
                    const preserve = hasUnsavedRequirements || JSON.stringify(draft) !== version;
                    if (!preserve) { forgetCollaborationDraft(draft); collaboration.dirty = false; collaboration.draft = null; }
                    else collaboration.dirty = true;
                    collaboration.editingRequirements = false; persistView(); render();
                    bridge.notice?.(preserve ? '下次分工已保存；目标、验收和材料等未保存内容仍在需求草稿中。当前任务未变化。' : '分工已保存，下次任务生效。当前任务未变化。', 'success');
                } finally { if (isCurrent(ctx)) { collaboration.busy = false; state.taskSaving = false; persistView(); updatePendingControls(); } } return;
            }
            if (action === 'collab-authorize') return openAuthorization();
            if (action === 'collab-authorize-start') return authorizeStart();
            if (action === 'collab-add-media') return;
            if (action === 'collab-settlement') return authorizeSettlement(target.dataset.attemptId);
            if (action.startsWith('collab-attachment-')) {
                if (typeof bridge.useRoleDeliveryAttachment !== 'function') throw new Error('原件使用桥接尚未集成，未修改画布或资产。');
                const result = await bridge.useRoleDeliveryAttachment({ deliveryId: target.dataset.deliveryId, index: Number(target.dataset.attachmentIndex),
                    action: action.slice('collab-attachment-'.length) });
                if (!result || result.saved !== true) throw new Error('尚未确认原件使用结果，未显示成功。');
                bridge.notice?.(action.endsWith('canvas') ? '原件已放回画布。' : '原件已存入资产。', 'success'); return;
            }
            if (action === 'collab-adopt-media') {
                if (!validId(target.dataset.bindingId)) throw new Error('绑定编号无效。');
                if (!persistView()) throw new Error('本地草稿未能保存，尚未采用原件；请先保存当前成果草稿。');
                return performWorkAction('adopt_media', { binding_id: target.dataset.bindingId });
            }
            if (action === 'collab-pause' || action === 'collab-resume') return collaborationControl(action === 'collab-pause' ? 'pause' : 'resume');
            if (action === 'collab-more-runs') return refreshCollaboration(true);
            if (action === 'collab-select-work') {
                if (!await confirmDiscard()) return;
                const work = recordList(collaboration.detail?.works).find(w => w.id === target.dataset.workId); if (!work) return;
                captureReadingAnchor(); persistView(); clearTransientDrafts(); state.selectedWorkId = work.id; state.selectedNodeId = work.node_id;
                await fetchDetail(work.id, currentContext(), state.sequence, false); persistView(); render(); return;
            }
            if (action === 'collab-relation-mode') { collaboration.relationMode = collaboration.relationMode === 'all' ? 'related' : 'all'; routing?.setMode(collaboration.relationMode); persistView(); render(); return; }
            if (action === 'collab-edit-relation') { const flow = collaborationFlow(), edge = flow?.relations?.find(r => r.id === target.dataset.relationId); if (edge) routing?.edit(flow, edge); return; }
            if (action === 'collab-undo-relation') return routing?.undo();
            if (action === 'collab-pick-materials') { const ids = await bridge.selectRoleMaterials(); if (Array.isArray(ids) && collaboration.draft) { collaboration.draft.materialNodes = ids.filter(validId); collaboration.dirty = true; openRequirementEditor(); } return; }
            if (action === 'collab-more') {
                const content = el('div', 'crw-dialog-content'); content.append(el('h2', '', '任务操作'));
                content.append(button('撤销本任务授权', 'collab-revoke', '', 'shield'), button('取消本次任务', 'collab-cancel', '', 'x'),
                    button('新需求', 'collab-new', '', 'plus'), button('工作流模板', 'collab-templates', '', 'copy'), button('关闭', 'dialog-readonly-close'));
                openModal('collab-more', content); return;
            }
            if (action === 'collab-revoke' || action === 'collab-cancel') { closeModal(); return collaborationControl(action === 'collab-revoke' ? 'revoke_authorization' : 'cancel'); }
            if (action === 'collab-new') { closeModal(); return switchCollaborationRun(''); }
            if (action === 'collab-pending') {
                const content = el('div', 'crw-dialog-content'); content.append(el('h2', '', '待我处理'));
                pendingWorks().forEach(work => { const b = button((work.snapshot?.role?.name || '岗位') + ' · ' + displayPhase(work.phase), 'collab-select-work'); b.dataset.workId = work.id;
                    b.addEventListener('click', () => closeModal()); content.append(b); });
                pendingQuestions().forEach(q => { const b = button('问题 · ' + (parseJson(q.body_json || q.body, {}).question || q.question || q.status), 'collab-show-question'); b.dataset.questionId = q.id; content.append(b); });
                if (!pendingWorks().length && !pendingQuestions().length) content.append(el('p', 'crw-muted', '当前已读取记录中没有待处理项。'));
                if (collaboration.questionsCursor) content.append(button('读取更多问题', 'collab-more-questions'));
                content.append(button('关闭', 'dialog-readonly-close')); openModal('collab-pending', content); return;
            }
            if (action === 'collab-show-question') { closeModal(); state.tab = 'talk'; render(); state.root.querySelector('[data-reading-id="' + CSS.escape(target.dataset.questionId) + '"]')?.scrollIntoView({ block: 'nearest' }); return; }
            if (action === 'collab-more-questions') {
                const ctx = currentContext(), runId = collaboration.runId, cursor = collaboration.questionsCursor;
                const result = await requestJson(apiUrl('/role-runs/' + encodeURIComponent(runId), { question_cursor: cursor || '' }));
                if (!isCurrent(ctx) || runId !== collaboration.runId) return;
                collaboration.detail.questions = mergeById(collaboration.detail.questions, result.questions); collaboration.questionsCursor = result.question_next_cursor || result.next_question_cursor || result.question_cursor || null; render(); return;
            }
            if (action === 'collab-ask') {
                const work = currentCollaborationWork(), version = controlVersions(); if (!work) return;
                return collaborationPrompt('提出问题', [{ key: 'target_work_id', label: '交给谁处理', options: [['', '本人'], ...collaboration.detail.works.filter(w => w.id !== work.id && w.phase !== 'superseded').map(w => [w.id, w.snapshot?.role?.name || '岗位'])] },
                    { key: 'question', label: '问题' }, { key: 'blocking', label: '没有答案无法继续本工作', check: true }], '提交问题', values => {
                    if (!clean(values.question)) throw new Error('请填写问题。');
                    return sendMutation(apiUrl('/role-runs/' + collaboration.runId + '/questions'), { ...version, from_work_id: work.id, target_work_id: values.target_work_id || null, question: values.question, blocking: values.blocking }, 'collaboration');
                });
            }
            if (action.startsWith('collab-question-')) {
                const question = recordList(collaboration.detail?.questions).find(q => q.id === target.dataset.questionId); if (!question) return;
                const method = action.slice('collab-question-'.length), version = { base_revision: Number(question.revision), requirements_revision: Number(question.requirements_revision) };
                if (method === 'answer' && (question.answer || !['open', 'escalated'].includes(question.status))) throw new Error('此问题已答复或正在处理，请刷新查看，不会重复答复。');
                if (method === 'answer') return collaborationPrompt('答复问题', [{ key: 'text', label: '答复以本人名义记录，不冒充 AI；答复不等于解除阻塞。' }], '保存答复', values => {
                    if (!clean(values.text)) throw new Error('请填写答复。'); return sendMutation(apiUrl('/role-questions/' + question.id), { ...version, action: method, text: values.text }, 'collaboration'); });
                if (!await bridge.confirm({ title: method === 'resolve' ? '确认已解决？' : method === 'cancel' ? '取消问题？' : '转本人处理？', message: '只处理此问题，保留原话与答复历史。', confirmText: '确认' })) return;
                await sendMutation(apiUrl('/role-questions/' + question.id), { ...version, action: method }, 'collaboration'); return refreshCollaboration(false);
            }
            if (action === 'collab-media') {
                const work = currentCollaborationWork(); if (!work) throw new Error('先选择当前岗位工作。');
                if (typeof bridge.openRoleMedia !== 'function') throw new Error('原生成器媒体桥接尚未集成。');
                const items = [...new Set([...recordList(work.snapshot?.role?.requiredItems),
                    ...recordList(collaboration.detail.requirements.participants.find(p => p.nodeId === work.node_id)?.deliverableItems)])];
                if (!items.length) throw new Error('请先在需求与分工中明确本次交付项，再从原生成器生成。');
                return collaborationPrompt('选择本次交付项', [{ key: 'outputSlotId', label: '生成结果归入此岗位的交付项', options: items.map(name => [name, name]) }], '打开原生成器', async values => {
                    if (!values.outputSlotId) throw new Error('请先在本次分工中填写交付项。'); await bridge.openRoleMedia({ workId: work.id, kind: target.dataset.kind, outputSlotId: values.outputSlotId }); });
            }
            if (action === 'collab-accept-result') {
                const manifest = collaboration.detail?.manifest; if (!manifest) throw new Error('当前成果清单未齐。');
                if (!await bridge.confirm({ title: '验收本次成果？', message: '确认当前整合稿及清单中的有效原件。费用结清仍按原账单另行核对。', confirmText: '验收当前版' })) return;
                return collaborationControl('accept_result', { manifest_event_id: manifest.eventId, manifest_digest: manifest.digest });
            }
            if (action === 'collab-reject-result') return collaborationPrompt('需要修改', [{ key: 'reason', label: '写清本版需要修改什么' }], '提交修改意见', values => {
                if (!clean(values.reason)) throw new Error('请填写修改意见。'); return collaborationControl('reject_result', { reason: values.reason }); });
            if (action === 'collab-delivery') {
                const ctx = currentContext(), runId = collaboration.runId, id = target.dataset.deliveryId;
                const delivery = await readFixedDelivery(runId, id);
                if (!isCurrent(ctx) || runId !== collaboration.runId) return;
                showReadonlyDelivery(delivery, '成果 v' + (delivery.version || '?')); return;
            }
            if (action === 'collab-work-history') { state.tab = 'results'; const content = el('div', 'crw-dialog-content'); content.append(el('h2', '', '工作历史'), renderHistory(), button('关闭', 'dialog-readonly-close')); openModal('collab-history', content); return; }
            if (action === 'collab-history') return openCollaborationHistory();
            if (action === 'collab-retrospective') return openRetrospective();
            if (action === 'collab-save-template') return saveTemplate();
            if (action === 'collab-templates') return openTemplates(false);
            if (action === 'collab-more-templates') return openTemplates(true);
            if (action === 'collab-use-template') return useTemplate(target.dataset.templateId);
        }

        async function openCollaborationHistory() {
            const content = el('div', 'crw-dialog-content'); content.append(el('h2', '', '任务历史'));
            for (const run of collaboration.runs) {
                const b = button(textOf(run.goal, '任务') + ' · ' + runLabel({ run, control: run.control }), 'collab-history-run');
                b.addEventListener('click', () => { closeModal(); void switchCollaborationRun(run.id).catch(showCollaborationError); });
                content.append(b);
            }
            const fields = el('div');
            const input = el('input', 'crw-input'); input.placeholder = '消息或稿件记录编号'; input.setAttribute('aria-label', '精确历史记录编号');
            const read = button('读取指定历史', 'collab-read-exact');
            read.addEventListener('click', async () => {
                if (!validId(input.value)) return;
                const ctx = currentContext(), runId = collaboration.runId;
                try { const result = await requestJson(apiUrl('/role-runs/' + runId, { event_id: input.value }));
                    if (!isCurrent(ctx) || collaboration.runId !== runId) return;
                    const event = result.event; if (!event) throw new Error('指定记录不可读。'); fields.replaceChildren(renderEvent(event)); }
                catch (e) { fields.replaceChildren(panelMessage(normalizeError(e).message, 'error')); }
            });
            content.append(input, read, fields, button('关闭', 'dialog-readonly-close')); openModal('collab-history', content);
        }

        async function openRetrospective() {
            const ctx = currentContext(), runId = collaboration.runId;
            const result = await requestJson(apiUrl('/role-runs/' + runId + '/results'));
            if (!isCurrent(ctx) || runId !== collaboration.runId) return;
            const content = el('div', 'crw-dialog-content'); content.append(el('h2', '', '事实回顾'));
            const facts = result.facts || result.review || result.events || [];
            if (typeof facts === 'string') content.append(el('pre', 'crw-event-content', facts));
            else recordList(facts).forEach(fact => content.append(isRecord(fact) && fact.kind ? renderEvent(fact) : el('p', '', typeof fact === 'string' ? fact : JSON.stringify(fact))));
            content.append(el('p', 'crw-muted', '提议与正式采用分开。采用生成角色新版本，不替换旧任务；后续验证须关联实际稿件。'));
            for (const [action, text] of [['rule_proposed', '提出规则'], ['rule_adopted', '采用规则'], ['rule_verified', '记录后续验证'], ['retained', '保留规则'], ['reverted', '撤回规则']]) {
                const b = button(text, 'collab-rule-' + action);
                b.addEventListener('click', () => {
                    const works = recordList(collaboration.detail?.works);
                    void collaborationPrompt(text, [{ key: 'work_id', label: '对应岗位工作', options: works.map(w => [w.id, w.snapshot?.role?.name || '岗位']) },
                        { key: 'proposal_event_id', label: '原提议记录编号（采用或后续验证时填写）' }, { key: 'text', label: '规则与依据' },
                        { key: 'evidence_delivery_id', label: '实际稿件依据编号（后续验证）' }], text, async values => {
                        const work = works.find(w => w.id === values.work_id); if (!work) throw new Error('请指定岗位工作。');
                        if (values.proposal_event_id && !validId(values.proposal_event_id) || values.evidence_delivery_id && !validId(values.evidence_delivery_id)) throw new Error('记录编号无效。');
                        let role = null;
                        if (['rule_adopted', 'reverted'].includes(action)) {
                            const definitionId = work.snapshot?.definitionId;
                            if (!validId(definitionId)) throw new Error('原岗位版本引用不可读，未采用规则。');
                            const current = await requestJson(apiUrl('/roles/' + definitionId)); role = current.role;
                            if (!role || !Number.isSafeInteger(role.revision) || !Number.isSafeInteger(role.current_version)) throw new Error('长期角色当前版本未确认。');
                            if (!await bridge.confirm({ title: text, message: '将从角色当前 v' + role.current_version + ' 保存新版本，不修改旧任务。', confirmText: text })) throw new Error('已取消，原输入保留。');
                        }
                        await sendMutation(apiUrl('/role-runs/' + runId + '/results'), { action, work_id: work.id, text: values.text,
                            ...controlVersions(), proposal_event_id: values.proposal_event_id || undefined, evidence_delivery_id: values.evidence_delivery_id || undefined,
                            base_role_revision: role?.revision, base_role_version: role?.current_version }, 'collaboration');
                    }).catch(showCollaborationError);
                }); content.append(b);
            }
            content.append(button('关闭', 'dialog-readonly-close')); openModal('collab-retrospective', content);
        }

        async function saveTemplate() {
            const flow = collaborationFlow(); if (!flow) return;
            return collaborationPrompt('保存工作流模板', [{ key: 'name', label: '模板名称', value: flow.name, maxLength: 80 }], '保存模板', async values => {
                if (!clean(values.name)) throw new Error('请填写模板名称。');
                const saved = await bridge.saveDocument('role_template_save');
                await sendMutation(apiUrl('/role-workflow-templates'), { action: 'save', name: clean(values.name), document_id: saved.documentId, workflow_id: flow.id }, 'collaboration');
                bridge.notice?.('模板已保存，不携带材料、运行、授权或预算。', 'success');
            });
        }

        async function openTemplates(append) {
            const ctx = currentContext(); const params = append && collaboration.templateCursor ? { cursor: collaboration.templateCursor } : {};
            const result = await requestJson(apiUrl('/role-workflow-templates', params)); if (!isCurrent(ctx)) return;
            collaboration.templates = append ? mergeById(collaboration.templates, result.templates) : recordList(result.templates);
            collaboration.templateCursor = result.next_cursor || null;
            const content = el('div', 'crw-dialog-content'); content.append(el('h2', '', '我的工作流模板'));
            collaboration.templates.forEach(template => { const row = el('div', 'crw-pending-row'); row.append(el('span', '', template.name + ' · v' + template.current_version));
                const use = button('使用', 'collab-use-template', 'primary'); use.dataset.templateId = template.id; row.append(use);
                const version = button('保存新版', 'collab-template-version'), archive = button('归档', 'collab-template-archive');
                version.disabled = !collaborationFlow();
                version.addEventListener('click', () => void (async () => { const saved = await bridge.saveDocument('role_template_version');
                    await sendMutation(apiUrl('/role-workflow-templates/' + template.id), { action: 'save_version', base_revision: template.revision,
                        document_id: saved.documentId, workflow_id: collaboration.workflowId, name: template.name }, 'collaboration_update'); await openTemplates(false); })().catch(showCollaborationError));
                archive.addEventListener('click', () => void (async () => { if (!await bridge.confirm({ title: '归档模板？', message: '已有画布实例与任务不改变。', confirmText: '归档' })) return;
                    await sendMutation(apiUrl('/role-workflow-templates/' + template.id), { action: 'archive', base_revision: template.revision }, 'collaboration_update'); await openTemplates(false); })().catch(showCollaborationError));
                row.append(version, archive); content.append(row); });
            if (collaboration.templateCursor) content.append(button('加载更多', 'collab-more-templates', '', 'chevron-down'));
            content.append(button('关闭', 'dialog-readonly-close')); openModal('collab-templates', content);
        }

        async function useTemplate(id) {
            const template = collaboration.templates.find(t => t.id === id); if (!template) return;
            if (typeof bridge.adoptRoleWorkflowTemplateReceipt !== 'function') throw new Error('模板使用回执桥接尚未集成，未提交。');
            const ctx = currentContext(), saved = await bridge.saveDocument('before_role_template_use');
            const payload = { action: 'use', template_id: id, version: template.current_version, document_id: saved.documentId,
                document_revision: saved.documentRevision, position: { x: (bridge.engine.container.clientWidth / 2 - bridge.engine.offsetX) / bridge.engine.scale,
                    y: (bridge.engine.container.clientHeight / 2 - bridge.engine.offsetY) / bridge.engine.scale } };
            const result = await sendMutation(apiUrl('/role-workflow-templates'), payload, 'collaboration');
            if (!result || !isCurrent(ctx)) return;
            if (!await adoptCollaborationReceipt(ctx, state.pendingMutation, result)) return;
            closeModal(); await openWorkflow(result.workflow?.id || result.workflowId, { newTask: true });
        }

        function currencyRate() {
            const rate = typeof bridge.usdToCnyRate === 'function' ? Number(bridge.usdToCnyRate()) : 7;
            if (!Number.isFinite(rate) || rate <= 0) throw new Error('人民币换算汇率未确认。');
            return rate;
        }

        async function authorizeSettlement(id) {
            if (!validId(id)) return;
            const ctx = currentContext(), runId = collaboration.runId;
            const result = await requestJson(apiUrl('/role-attempts/' + id));
            if (!isCurrent(ctx) || runId !== collaboration.runId) return;
            const attempt = result.attempt || result;
            if (attempt.work_id !== state.selectedWorkId || !attempt.receipt_digest || !Number.isSafeInteger(attempt.base_revision)) throw new Error('精确账单摘要、原工作或任务修订未确认，不能授权差额。');
            return collaborationPrompt('差额授权', [{ key: 'points', label: '本任务累计总点数上限（结此原单）',
                note: '原单实际文字费用：' + formatUsdMicros(attempt.confirmed_bill_usd_micros) + '；本任务原上限 ' + formatPoints(attempt.budget_points_limit) + ' 点。其他已结算与待核预留也计入上限。' },
                { key: 'cny', label: '本任务累计文字费用上限（人民币等值）' }], '授权结原单', async values => {
                const points = scaledAmount(values.points, 100, 1000000), usd = values.cny === '' ? null : scaledAmount(Number(values.cny) / currencyRate(), 1000000, 1000);
                if (points === null || usd === null) throw new Error('请明确累计点数和费用上限。');
                if (!await bridge.confirm({ title: '授权原单差额？', message: '只结算已核对的原请求，不生成或重发；累计上限 ' + formatPoints(points / 100) + ' 点。', confirmText: '授权结原单' })) throw new Error('已取消，未结算。');
                await sendMutation(apiUrl('/role-attempts/' + id), { action: 'authorize_settlement', base_revision: attempt.base_revision,
                    receipt_digest: attempt.receipt_digest, authorized_total_points_limit: points / 100, authorized_total_usd_micros_limit: usd }, 'collaboration');
            });
        }

        document.addEventListener('click', event => {
            const request = event.target.closest('[data-role-requirement-open], [data-role-requirement-start]'); if (!request) return;
            event.preventDefault(); event.stopPropagation();
            const id = request.dataset.roleRequirementOpen || request.dataset.roleRequirementStart;
            void open(id).then(() => { if (request.dataset.roleRequirementStart && collaboration.detail?.run?.status === 'draft') openAuthorization(); }).catch(showCollaborationError);
        });
        document.addEventListener('rolemedia:changed', event => {
            const value = event.detail, ctx = currentContext();
            if (state.mode !== 'collaboration' || !value || value.documentId !== ctx.documentId || value.runId !== collaboration.runId
                || !recordList(collaboration.detail?.works).some(work => work.id === value.workId)) return;
            mediaRefreshPending = true;
            if (!hasUnsaved() && !state.modalContent && !state.loading && !collaboration.busy && !state.pendingMutation) {
                mediaRefreshPending = false; void refreshCollaboration(false, false, true);
            } else { bridge.notice?.('原岗位媒体状态已变化；当前输入保留，保存或离开编辑后再同步。', 'info'); scheduleCollaborationRead(); }
        });
        document.addEventListener('visibilitychange', () => { if (document.hidden) { captureReadingAnchor(); persistView(); }
            else if (state.mode === 'collaboration' && collaborationFlow() && !hasUnsaved() && !state.modalContent && !state.pendingMutation) void refreshCollaboration(false, false, true); });
        window.addEventListener('pagehide', () => { captureReadingAnchor(); persistView(); });
        if (bridge.engine) bridge.engine.roleCollaboration = { openWorkflow, openTemplates: () => openTemplates(false),
            selectedRunId: () => collaboration.runId, refresh: () => refreshCollaboration(false), hasPending: () => Boolean(collaboration.busy || routing?.hasPending()) };

        return { open, openPending, refresh, contextChanged, hasUnsaved, close, openWorkflow, openTemplates: () => openTemplates(false) };
    }

    return { create };
});
