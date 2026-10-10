(function () {
    'use strict';

    const API = '/api/tools/ultimate-canvas';
    const STORAGE_PREFIX = 'ultimate-canvas-role-module:v1';
    const emptySnapshot = () => ({
        schema: 'role.v1', name: '', responsibilities: '', delivery: '', criteria: '', boundary: '',
        executor: { kind: 'unassigned' }, tools: ['manual'], requiredItems: []
    });

    window.UltimateCanvasRoleCreator = { create };

    function create(bridge) {
        if (!bridge || typeof bridge.context !== 'function' || typeof bridge.request !== 'function' || typeof bridge.dialog !== 'function') {
            throw new Error('角色模块缺少必要的画布接口。');
        }

        let library = null;
        let creator = null;
        let closed = false;
        const layers = [];
        const requests = new Set();
        const memory = new Map();

        function context() { return bridge.context() || {}; }
        function stamp() {
            const ctx = context();
            return {
                userId: String(ctx.userId || ''), projectId: String(ctx.projectId || ''),
                documentId: String(ctx.documentId || ''), contextEpoch: ctx.contextEpoch,
                scopeKey: String(ctx.scopeKey || '')
            };
        }
        function sameContext(a, b = stamp()) {
            return a && a.userId === b.userId && a.projectId === b.projectId
                && a.documentId === b.documentId && a.contextEpoch === b.contextEpoch
                && a.scopeKey === b.scopeKey;
        }
        function scopeKey(token, includeDocument) {
            if (!token.userId) return '';
            const parts = [token.userId, token.projectId || 'no-project'];
            if (includeDocument) parts.push(token.documentId || 'no-document');
            return STORAGE_PREFIX + ':' + parts.map(encodeURIComponent).join(':');
        }
        function localState(token) {
            const key = scopeKey(token, true);
            if (!key) return { key: '', value: { drafts: {}, pending: {}, joins: {} } };
            if (memory.has(key)) return { key, value: memory.get(key) };
            let value = { drafts: {}, pending: {}, joins: {} };
            try {
                const raw = localStorage.getItem(key);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (parsed && typeof parsed === 'object') value = {
                        drafts: parsed.drafts && typeof parsed.drafts === 'object' && !Array.isArray(parsed.drafts) ? parsed.drafts : {},
                        pending: parsed.pending && typeof parsed.pending === 'object' && !Array.isArray(parsed.pending) ? parsed.pending : {},
                        joins: parsed.joins && typeof parsed.joins === 'object' && !Array.isArray(parsed.joins) ? parsed.joins : {}
                    };
                }
            } catch (_) { /* Storage is optional; the current in-memory draft remains usable. */ }
            memory.set(key, value);
            return { key, value };
        }
        function writeLocal(token, update) {
            const current = localState(token);
            update(current.value);
            if (!current.key) return false;
            memory.set(current.key, current.value);
            try { localStorage.setItem(current.key, JSON.stringify(current.value)); return true; }
            catch (_) { return false; }
        }
        function prefs(token) {
            const key = scopeKey(token, false);
            if (!key) return { status: 'active', q: '', selected: '', scrollTop: 0 };
            try {
                const value = JSON.parse(localStorage.getItem(key) || '{}');
                return { status: value.status === 'archived' ? 'archived' : 'active', q: typeof value.q === 'string' ? value.q.slice(0, 120) : '',
                    selected: typeof value.selected === 'string' ? value.selected : '',
                    scrollTop: Number.isFinite(value.scrollTop) ? Math.max(0, value.scrollTop) : 0 };
            } catch (_) { return { status: 'active', q: '', selected: '', scrollTop: 0 }; }
        }
        function savePrefs(token, value) {
            const key = scopeKey(token, false);
            if (!key) return;
            try { localStorage.setItem(key, JSON.stringify({ status: value.status, q: value.q, selected: value.selected, scrollTop: value.scrollTop })); } catch (_) { /* Preferences are optional. */ }
        }
        function html(value) { return bridge.escape(String(value ?? '')); }
        function icon(name) { return typeof bridge.icon === 'function' ? bridge.icon(name) : ''; }
        function uuid() {
            if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
            return 'role-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
        }
        function snapshotCopy(raw) {
            const source = raw && typeof raw === 'object' ? raw : {};
            const executor = source.executor && typeof source.executor === 'object' ? source.executor : {};
            return {
                schema: 'role.v1', name: String(source.name || ''),
                responsibilities: String(source.responsibilities || ''), delivery: String(source.delivery || ''),
                criteria: String(source.criteria || ''), boundary: String(source.boundary || ''),
                executor: ['person', 'ai', 'unassigned'].includes(executor.kind)
                    ? { kind: executor.kind, ...(executor.userId ? { userId: executor.userId } : {}), ...(executor.model ? { model: executor.model } : {}) }
                    : { kind: 'unassigned' },
                tools: Array.isArray(source.tools) ? source.tools.filter(item => item === 'manual' || item === 'text') : ['manual'],
                requiredItems: Array.isArray(source.requiredItems) ? source.requiredItems.map(String).slice(0, 30) : []
            };
        }
        function canonical(value) { return JSON.stringify(value); }
        function roleId(role) { return String(role?.id || role?.definitionId || ''); }
        function roleVersion(role) { return Number(role?.current_version ?? role?.currentVersion ?? 1) || 1; }
        function roleRevision(role) { return Number(role?.revision ?? 1) || 1; }
        function roleStatus(role) { return String(role?.status || 'active'); }
        function mutationError(result) {
            if (result && Number.isFinite(result.status) && result.status >= 400) {
                const data = result.data || {};
                const error = new Error(data.message || data.error || '请求失败，请稍后重试。');
                error.status = result.status;
                error.data = data;
                throw error;
            }
            if (result && Number.isFinite(result.status) && 'data' in result) return result.data;
            return result;
        }
        function messageOf(error) {
            const data = error?.data || error?.response;
            return String(data?.message || (typeof data?.error === 'string' ? data.error : data?.error?.message)
                || error?.message || '请求失败，请稍后重试。');
        }
        function errorStatus(error) { return Number(error?.status ?? error?.response?.status) || 0; }
        function errorCode(error) { return error?.data?.code || error?.response?.code || ''; }
        function apiErrorIsCertain(error) {
            const statusCode = errorStatus(error);
            return !error?.receiptLookup && statusCode >= 400 && statusCode < 500 && statusCode !== 429
                && !['write_conflict', 'mutation_conflict'].includes(errorCode(error));
        }
        async function request(url, options, token, isRead) {
            if (!sameContext(token)) throw new Error('画布或账号已切换，请重新打开角色库。');
            let controller = null;
            if (isRead) { controller = new AbortController(); requests.add(controller); }
            try {
                const result = await bridge.request(url, {
                    method: options?.method || 'GET',
                    ...(options && 'payload' in options ? { payload: options.payload } : {}),
                    ...(controller ? { signal: controller.signal } : {})
                });
                const value = mutationError(result);
                if (!sameContext(token)) throw new Error('画布或账号已切换，已忽略旧页面返回。');
                return value;
            } finally {
                if (controller) requests.delete(controller);
            }
        }
        function topLayer(layer) {
            const open = document.querySelectorAll('dialog[open]');
            return open.length && open[open.length - 1] === layer?.dialog;
        }
        function addLayer(options) {
            let layer, dismissing = false;
            const dismiss = async () => {
                if (!layer || layer.closed || dismissing || !topLayer(layer)) return false;
                dismissing = true;
                try {
                    const allow = await (options.onDismiss ? options.onDismiss() : true);
                    if (allow === false || layer.closed || !topLayer(layer)) return false;
                    layer.close();
                    return true;
                } finally { dismissing = false; }
            };
            const native = bridge.dialog({
                className: options.className,
                labelledBy: options.labelledBy,
                content: options.content,
                anchor: options.anchor,
                onDismiss: dismiss
            });
            layer = {
                dialog: native.dialog, closed: false, dismiss,
                close: () => {
                    if (layer.closed) return;
                    layer.closed = true;
                    native.close();
                    removeLayer(layer);
                    options.onClose?.();
                }
            };
            layers.push(layer);
            return layer;
        }
        function removeLayer(layer) {
            const index = layers.lastIndexOf(layer);
            if (index >= 0) layers.splice(index, 1);
        }
        function hardCloseLayers() {
            for (const layer of layers.slice().reverse()) {
                try { layer.close(); } catch (_) { /* A layer may already be closed. */ }
            }
            layers.length = 0;
            clearLibrary(false);
            creator = null;
        }
        function cancelReads() {
            for (const controller of requests) controller.abort();
            requests.clear();
        }
        function status(root, text, type) {
            const output = root?.querySelector('[data-role-status]');
            if (!output) return;
            output.textContent = text || '';
            output.dataset.tone = type || 'info';
        }
        function callNotice(text, type) {
            if (typeof bridge.notice === 'function') bridge.notice(text, type || 'info');
        }
        function notifySaved() {
            try { bridge.onSaved?.(); }
            catch (_) { callNotice('保存已完成，视图更新失败，请重新打开。', 'warn'); }
        }
        function confirm(options) {
            return typeof bridge.confirm === 'function' ? bridge.confirm(options) : Promise.resolve(false);
        }
        function timeMarkup(value) {
            if (!value || typeof bridge.renderTime !== 'function') return '';
            return bridge.renderTime(value) || '';
        }
        function textModels(ctx = context()) {
            const input = Array.isArray(ctx.textModels) ? ctx.textModels : [];
            return input.map(item => {
                if (typeof item === 'string') return { id: item, label: item };
                if (!item || typeof item !== 'object') return null;
                const id = String(item.id || item.value || '');
                if (!id || item.ready === false || item.available === false) return null;
                return { id, label: String(item.label || item.name || id) };
            }).filter(Boolean);
        }
        function creatorKey(mode, id) { return (mode || 'create') + ':' + (id || 'new'); }
        function loadDraft(token, key) {
            const state = localState(token).value;
            const draft = state.drafts[key];
            return draft && typeof draft === 'object' ? draft : null;
        }
        function persistCreator(value = creator) {
            if (!value) return false;
            value.localSafe = writeLocal(value.token, state => {
                state.drafts[value.key] = {
                    snapshot: value.snapshot,
                    baseline: value.baseline,
                    baseVersion: value.baseVersion,
                    baseRevision: value.baseRevision,
                    requestedVersion: value.requestedVersion,
                    expanded: value.expanded,
                    saveMode: value.saveMode,
                    pendingMutation: value.pendingMutation,
                    savedRole: value.savedRole,
                    joinMutationId: value.joinMutationId,
                    joinMessage: value.joinMessage,
                    position: value.position,
                    pendingConnection: value.pendingConnection,
                    childDrafts: value.childDrafts
                };
            });
            return value.localSafe;
        }
        function discardCreatorDraft(value) {
            if (!writeLocal(value.token, state => { delete state.drafts[value.key]; })) {
                callNotice('本地草稿未能清理，刷新后可能仍会显示旧草稿。', 'warn');
            }
        }
        function openRoot(layer, selector) { return layer?.dialog?.querySelector(selector); }
        function summary(value, fallback) {
            const first = String(value || '').trim().split(/[\n。！？.!?]/, 1)[0].trim();
            return first ? (first.length > 54 ? first.slice(0, 54) + '…' : first) : fallback;
        }

        async function openLibrary(options = {}) {
            closed = false;
            const token = stamp();
            if (!bridge.libraryRoot) { callNotice('角色库面板尚未准备好。', 'warn'); return; }
            if (library && sameContext(library.token, token)) {
                library.options = { position: options.position || null, pendingConnection: options.pendingConnection || null };
                await loadLibrary(library, false);
                return;
            }
            clearLibrary(false);
            const saved = prefs(token);
            const state = {
                token, options: { position: options.position || null, pendingConnection: options.pendingConnection || null },
                status: ['active', 'archived'].includes(options.status) ? options.status : saved.status,
                q: typeof options.q === 'string' ? options.q.slice(0, 120) : saved.q,
                roles: [], nextCursor: null, loading: false, error: '', root: bridge.libraryRoot,
                requestId: 0, searchTimer: null, selected: options.status || options.q != null ? '' : saved.selected,
                scrollTop: options.status || options.q != null ? 0 : saved.scrollTop,
                mutating: false, joiningKey: '', operationMessage: ''
            };
            library = state;
            renderLibrary(state);
            await loadLibrary(state, false);
        }

        function clearLibrary(closePanel) {
            const state = library;
            if (state) {
                if (state.searchTimer) clearTimeout(state.searchTimer);
                state.requestId++;
                state.root.replaceChildren();
                state.root.onclick = null;
                state.root.onscroll = null;
            } else if (bridge.libraryRoot) bridge.libraryRoot.replaceChildren();
            library = null;
            if (closePanel && typeof bridge.closeLibrary === 'function') bridge.closeLibrary();
        }

        function renderLibrary(state) {
            if (!state.root || library !== state || !sameContext(state.token)) return;
            const writable = context().writable === true && !!context().documentId;
            const canCreate = !!state.token.userId;
            const focus = state.root.querySelector('[data-role-search]');
            const restoreSearch = document.activeElement === focus;
            const selection = focus ? [focus.selectionStart, focus.selectionEnd] : null;
            const pending = Object.values(localState(state.token).value.pending || {}).length > 0;
            const pendingJoins = Object.entries(localState(state.token).value.joins || {});
            const rows = state.roles.map(role => {
                const id = roleId(role), currentVersion = roleVersion(role);
                const updated = role.updated_at || role.updatedAt;
                return '<li class="role-library-row' + (state.selected === id ? ' is-selected' : '') + '" data-role-row="' + html(id) + '">' +
                    '<div class="role-library-info"><strong>' + html(role.name || '未命名角色') + '</strong>' +
                    '<span>v' + html(currentVersion) + (updated ? ' · ' + timeMarkup(updated) : '') + '</span></div>' +
                    '<div class="role-library-actions">' +
                    '<button type="button" class="role-icon-button" data-role-action="preview" data-role-id="' + html(id) + '" aria-label="预览角色" title="预览角色">' + icon('Eye') + '</button>' +
                    (state.status === 'active' ? '<button type="button" class="role-icon-button" data-role-action="copy" data-role-id="' + html(id) + '" aria-label="复制角色" title="复制角色">' + icon('Copy') + '</button>' : '') +
                    (state.status === 'active' ? '<button type="button" class="role-icon-button" data-role-action="edit" data-role-id="' + html(id) + '" aria-label="编辑角色" title="编辑角色">' + icon('Pencil') + '</button>' : '') +
                    '<button type="button" class="role-icon-button" data-role-action="' + (state.status === 'active' ? 'archive' : 'restore') + '" data-role-id="' + html(id) + '" aria-label="' + (state.status === 'active' ? '归档角色' : '恢复角色') + '" title="' + (state.status === 'active' ? '归档角色' : '恢复角色') + '">' + icon(state.status === 'active' ? 'Archive' : 'RotateCcw') + '</button>' +
                    (writable && state.status === 'active' ? '<button type="button" class="role-row-primary" data-role-action="join" data-role-id="' + html(id) + '">加入画布</button>' : '') +
                    '</div></li>';
            }).join('');
            state.root.innerHTML = '<div class="role-module-root role-library-root">' +
                '<header class="role-module-head"><div><h2 id="canvas-role-library-title">角色库</h2><span class="role-scope-label">我的角色</span></div>' +
                '<div class="role-head-actions"><details class="role-more-menu"><summary aria-label="更多角色库操作" title="更多角色库操作">' + icon('MoreHorizontal') + '</summary><div><button type="button" data-role-view-reset>重置筛选与选择</button></div></details><button type="button" class="role-icon-button" data-role-close aria-label="关闭" title="关闭">' + icon('X') + '</button></div></header>' +
                '<div class="role-library-toolbar"><div class="role-library-tabs" role="tablist" aria-label="角色状态筛选">' +
                '<button type="button" role="tab" aria-selected="' + (state.status === 'active') + '" data-role-status="active">在用</button>' +
                '<button type="button" role="tab" aria-selected="' + (state.status === 'archived') + '" data-role-status="archived">已归档</button></div>' +
                '<label class="role-search">' + icon('Search') + '<input type="search" aria-label="搜索角色" maxlength="120" data-role-search value="' + html(state.q) + '" placeholder="搜索角色"></label>' +
                '<button type="button" class="role-primary-command" data-create-role ' + (canCreate ? '' : 'disabled') + '>' + icon('Plus') + '创建角色</button></div>' +
                (pending ? '<div class="role-pending-strip"><span>有一项保存结果待核对。</span><button type="button" data-role-reconcile>继续核对</button></div>' : '') +
                pendingJoins.map(([key, join]) => '<div class="role-pending-strip"><span>' + html(state.roles.find(role => roleId(role) === (join.definitionId || key.split(':')[0]))?.name || '角色') + ' v' + html(join.version || key.split(':')[1]) + ' 加入结果待核对。</span><button type="button" data-role-retry-join="' + html(key) + '" ' + (writable ? '' : 'disabled') + '>继续加入</button></div>').join('') +
                (state.error ? '<div class="role-error-state" role="alert"><span>' + html(state.error) + '</span><button type="button" data-role-reload>重新加载</button></div>' : '') +
                (state.loading && !state.roles.length ? '<div class="role-library-skeleton" aria-label="正在加载"><i></i><i></i><i></i></div>' : '') +
                (!state.error && !state.loading && !state.roles.length ? '<div class="role-empty-state"><strong>' + (state.status === 'active' ? '还没有角色' : '没有已归档角色') + '</strong></div>' : '') +
                '<ul class="role-library-list" aria-live="polite">' + rows + '</ul>' +
                (state.loading && state.roles.length ? '<p class="role-library-loading" role="status">正在加载…</p>' : '') +
                (state.nextCursor && !state.error ? '<button type="button" class="role-load-more" data-role-more ' + (state.loading ? 'disabled' : '') + '>加载更多</button>' : '') +
                '<p class="role-module-status" data-role-status-message role="status">' + html(state.operationMessage) + '</p>' +
                '</div>';
            state.root.onclick = event => onLibraryClick(state, event);
            if (!state.loading) state.root.scrollTop = state.scrollTop;
            state.root.onscroll = () => {
                if (library !== state || state.loading || !sameContext(state.token)) return;
                state.scrollTop = state.root.scrollTop; savePrefs(state.token, state);
            };
            state.root.querySelectorAll('[data-role-action], [data-role-reconcile], [data-role-retry-join]').forEach(button => {
                button.disabled = state.mutating || !!state.joiningKey || (button.hasAttribute('data-role-retry-join') && !writable);
            });
            const search = state.root.querySelector('[data-role-search]');
            if (restoreSearch && search) {
                search.focus();
                if (selection && selection[0] != null) search.setSelectionRange(selection[0], selection[1]);
            }
            search?.addEventListener('input', () => {
                state.q = search.value;
                state.selected = ''; state.scrollTop = 0;
                savePrefs(state.token, state);
                if (state.searchTimer) clearTimeout(state.searchTimer);
                state.searchTimer = setTimeout(() => { if (library === state) void loadLibrary(state, false); }, 250);
            });
        }

        async function loadLibrary(state, append) {
            if (library !== state || !sameContext(state.token)) return;
            const requestId = ++state.requestId;
            state.loading = true;
            state.error = '';
            if (!append) { state.roles = []; state.nextCursor = null; }
            renderLibrary(state);
            const params = new URLSearchParams({ status: state.status, q: state.q });
            if (append && state.nextCursor) params.set('cursor', state.nextCursor);
            try {
                const result = await request(API + '/roles?' + params.toString(), {}, state.token, true);
                if (library !== state || requestId !== state.requestId || !sameContext(state.token)) return;
                if (!Array.isArray(result?.roles)) throw new Error('角色库返回格式无效，请重新加载。');
                const items = result.roles;
                state.roles = append ? [...new Map(state.roles.concat(items).map(role => [roleId(role), role])).values()] : items;
                state.nextCursor = typeof result?.next_cursor === 'string' ? result.next_cursor : null;
                if (!append && !state.roles.some(role => roleId(role) === state.selected)) state.selected = '';
                savePrefs(state.token, state);
            } catch (error) {
                if (library !== state || requestId !== state.requestId || error?.name === 'AbortError') return;
                state.error = messageOf(error);
            } finally {
                if (library === state && requestId === state.requestId) { state.loading = false; renderLibrary(state); }
            }
        }

        async function onLibraryClick(state, event) {
            const button = event.target.closest('button');
            if (!button || button.disabled || library !== state || !sameContext(state.token)) return;
            if (button.hasAttribute('data-role-close')) return clearLibrary(true);
            if (button.hasAttribute('data-role-view-reset')) {
                state.status = 'active'; state.q = ''; state.selected = ''; state.scrollTop = 0;
                savePrefs(state.token, state);
                return void loadLibrary(state, false);
            }
            if (button.dataset.roleStatus) {
                state.status = button.dataset.roleStatus;
                state.selected = ''; state.scrollTop = 0;
                savePrefs(state.token, state);
                return void loadLibrary(state, false);
            }
            if (button.hasAttribute('data-create-role')) return void openCreator({ mode: 'create', position: state.options.position, pendingConnection: state.options.pendingConnection });
            if (button.hasAttribute('data-role-reload')) return void loadLibrary(state, false);
            if (button.hasAttribute('data-role-more')) return void loadLibrary(state, true);
            if (button.hasAttribute('data-role-reconcile')) return void reconcileLibraryPending(state);
            if (button.dataset.roleRetryJoin) {
                const key = button.dataset.roleRetryJoin;
                const join = localState(state.token).value.joins[key];
                if (join) return void joinExisting(state, { id: join.definitionId || key.split(':')[0], current_version: join.version || Number(key.split(':')[1]) }, key);
                return;
            }
            const id = button.dataset.roleId;
            const role = state.roles.find(item => roleId(item) === id);
            if (!role) return;
            state.selected = id; savePrefs(state.token, state);
            state.root.querySelectorAll('[data-role-row]').forEach(row => row.classList.toggle('is-selected', row.dataset.roleRow === id));
            switch (button.dataset.roleAction) {
                case 'preview': return void openPreview(id, roleVersion(role), state.token);
                case 'copy': return void openCreator({ roleId: id, version: roleVersion(role), mode: 'copy', position: state.options.position, pendingConnection: state.options.pendingConnection });
                case 'edit': return void openCreator({ roleId: id, version: roleVersion(role), mode: 'edit', position: state.options.position, pendingConnection: state.options.pendingConnection });
                case 'join': return void joinExisting(state, role);
                case 'archive': return void archiveRole(state, role, 'archive');
                case 'restore': return void archiveRole(state, role, 'restore');
            }
        }

        function modelOptionsMarkup(snapshot, ctx) {
            const models = textModels(ctx);
            const selected = snapshot.executor.model || '';
            const available = models.some(model => model.id === selected);
            return models.length
                ? '<label class="role-model-field"><span>文字模型</span><select data-role-model>' + (!available ? '<option value="" selected disabled>请重新选择可用模型</option>' : '') + models.map(model => '<option value="' + html(model.id) + '"' + (model.id === selected ? ' selected' : '') + '>' + html(model.label) + '</option>').join('') + '</select></label>'
                : '<p class="role-muted-note">当前没有可用的文字模型，不能保存为 AI 执行者。</p>';
        }
        function creatorTitle(mode) { return mode === 'edit' ? '编辑角色' : mode === 'copy' ? '复制角色' : '新建角色'; }
        function creatorLabel(value) {
            const warning = value.localSafe === false ? '本地草稿保存失败，刷新可能丢失此页内容。' : '';
            if (value.loadingSource) return '正在读取角色版本…';
            if (value.savedRole && value.joinMessage) return value.joinMessage + (warning ? ' ' + warning : '');
            if (value.pendingMutation) return (value.message || '保存结果待核对，请沿用原请求继续核对。') + (warning ? ' ' + warning : '');
            return [value.message, warning].filter(Boolean).join(' ');
        }
        function creatorLocked(value) { return value.busy || !!value.pendingMutation || !!value.savedRole || value.loadingSource || !!value.loadError; }
        function renderCreator(value) {
            if (creator !== value || !value.root || !sameContext(value.token)) return;
            const snap = value.snapshot;
            const ctx = context();
            const canJoin = ctx.writable === true && !!ctx.documentId;
            const toolsSummary = snap.tools.map(tool => tool === 'manual' ? '人工提交' : '文字能力').join('、') || '未选择';
            const createOnly = value.saveMode === 'library' || !canJoin;
            const mainLabel = value.busy ? (value.phase === 'joining' ? '正在加入…' : '正在保存…')
                : value.savedRole ? (value.saveMode === 'join' && canJoin ? '继续加入画布' : '保留到角色库')
                : value.pendingMutation ? '继续核对保存' : value.mode === 'edit' ? '保存新版本'
                : createOnly ? '仅创建到角色库' : '创建并加入画布';
            const archived = value.mode === 'edit' && value.role && roleStatus(value.role) !== 'active';
            const disabled = creatorLocked(value) || archived;
            const submitDisabled = value.busy || value.loadingSource || (!value.pendingMutation && !value.savedRole && (!!value.loadError || !!value.conflict || archived));
            value.root.innerHTML = '<div class="role-module-root role-creator-root">' +
                '<header class="role-module-head"><div class="role-creator-title"><h2 id="canvas-role-creator-title">' + creatorTitle(value.mode) + '</h2><span class="role-scope-label">我的角色库</span>' +
                (value.mode === 'edit' && value.role ? '<span class="role-version-badge">v' + html(value.baseVersion) + '</span>' : '') + '</div>' +
                '<div class="role-head-actions">' + (value.mode !== 'edit' ? '<button type="button" class="role-text-action" data-role-template ' + (disabled ? 'disabled' : '') + '>用模板</button>' : '') +
                '<button type="button" class="role-icon-button" data-role-preview aria-label="预览角色" title="预览角色" ' + (value.busy || value.loadingSource ? 'disabled' : '') + '>' + icon('Eye') + '</button>' +
                '<details class="role-more-menu"><summary aria-label="更多角色操作" title="更多角色操作">' + icon('MoreHorizontal') + '</summary><div><button type="button" data-role-reset ' + (disabled ? 'disabled' : '') + '>重置本次草稿</button></div></details>' +
                '<button type="button" class="role-icon-button" data-role-close aria-label="关闭" title="关闭">' + icon('X') + '</button></div></header>' +
                (value.loadError ? '<div class="role-error-state" role="alert">' + html(value.loadError) + '<button type="button" data-role-source-retry>重新读取</button></div>' : '') +
                (value.conflict ? '<div class="role-conflict-strip" role="alert"><p>' + html(value.conflict.message) + '</p><div><button type="button" data-role-read-latest>查看最新版本</button><button type="button" data-role-copy-draft ' + (value.pendingMutation || value.busy ? 'disabled' : '') + '>复制草稿为新角色</button></div></div>' : '') +
                '<main class="role-creator-body" ' + (value.loadingSource ? 'aria-busy="true"' : '') + '>' +
                '<div class="role-form-row role-name-row"><label for="role-name-' + html(value.domId) + '">名称</label><input id="role-name-' + html(value.domId) + '" data-role-name maxlength="80" value="' + html(snap.name) + '" placeholder="角色名称" ' + (disabled ? 'disabled' : '') + '></div>' +
                '<button type="button" class="role-summary-row" data-role-edit-field="responsibilities" ' + (disabled ? 'disabled' : '') + '><span>职责</span><span class="role-summary-value">' + html(summary(snap.responsibilities, '填写职责')) + (value.childDrafts.responsibilities ? '<small class="role-field-pending">有未确定输入</small>' : '') + '</span>' + icon('ChevronRight') + '</button>' +
                '<button type="button" class="role-summary-row" data-role-edit-field="delivery" ' + (disabled ? 'disabled' : '') + '><span>交付</span><span class="role-summary-value">' + html(summary(snap.delivery, '填写交付')) + (value.childDrafts.delivery ? '<small class="role-field-pending">有未确定输入</small>' : '') + '</span>' + icon('ChevronRight') + '</button>' +
                '<fieldset class="role-executor-field" ' + (disabled ? 'disabled' : '') + '><legend>执行者</legend><div class="role-segmented" role="group" aria-label="执行者类型">' +
                [['ai', 'AI'], ['person', '本人'], ['unassigned', '稍后指定']].map(item => '<button type="button" aria-pressed="' + (snap.executor.kind === item[0]) + '" data-role-executor="' + item[0] + '" class="' + (snap.executor.kind === item[0] ? 'is-selected' : '') + '">' + item[1] + '</button>').join('') +
                '</div>' + (snap.executor.kind === 'ai' ? modelOptionsMarkup(snap, ctx) : snap.executor.kind === 'person' ? '<p class="role-muted-note">仅可指定本人；同事权限尚未开放。</p>' : '') + '</fieldset>' +
                '<details class="role-disclosure" data-role-disclosure="tools" ' + (value.expanded.tools ? 'open' : '') + '><summary><span>技能与工具</span><span>' + html(toolsSummary) + '</span>' + icon('ChevronDown') + '</summary><div class="role-disclosure-content">' +
                '<label class="role-check-row"><input type="checkbox" data-role-tool="manual" ' + (snap.tools.includes('manual') ? 'checked' : '') + (disabled ? ' disabled' : '') + '>人工提交</label>' +
                '<label class="role-check-row"><input type="checkbox" data-role-tool="text" ' + (snap.tools.includes('text') ? 'checked' : '') + (disabled ? ' disabled' : '') + '>文字能力</label>' +
                '</div></details>' +
                '<details class="role-disclosure" data-role-disclosure="rules" ' + (value.expanded.rules ? 'open' : '') + '><summary><span>材料与规则</span><span>' + (snap.requiredItems.length ? '必交项 ' + snap.requiredItems.length : snap.criteria || snap.boundary ? '规则已设置' : '未设置') + '</span>' + icon('ChevronDown') + '</summary><div class="role-disclosure-content">' +
                '<button type="button" class="role-inline-action" data-role-edit-field="responsibilities" ' + (disabled ? 'disabled' : '') + '>编辑职责与边界</button><button type="button" class="role-inline-action" data-role-edit-field="delivery" ' + (disabled ? 'disabled' : '') + '>编辑交付与验收</button></div></details>' +
                '</main>' +
                '<p class="role-module-status" data-role-status role="status" aria-live="polite">' + html(creatorLabel(value)) + '</p>' +
                '<footer class="role-creator-footer"><button type="button" class="role-secondary-command" data-role-cancel ' + (value.busy ? 'disabled' : '') + '>取消</button>' +
                (value.mode === 'edit' ? '<button type="button" class="role-primary-command" data-role-submit ' + (submitDisabled ? 'disabled' : '') + '>' + html(mainLabel) + '</button>' :
                    '<div class="role-split-command"><button type="button" class="role-primary-command" data-role-submit ' + (submitDisabled ? 'disabled' : '') + '>' + html(mainLabel) + '</button><button type="button" class="role-split-toggle" data-role-split-toggle aria-label="选择创建方式" aria-expanded="false" ' + (disabled ? 'disabled' : '') + '>' + icon('ChevronDown') + '</button><div class="role-split-menu" role="menu" data-role-split-menu hidden>' +
                    (canJoin ? '<button type="button" role="menuitemradio" aria-checked="' + (!createOnly) + '" data-role-save-mode="join">创建并加入画布</button>' : '') +
                    '<button type="button" role="menuitemradio" aria-checked="' + createOnly + '" data-role-save-mode="library">仅创建到角色库</button></div></div>') +
                '</footer></div>';
            value.root.onclick = event => onCreatorClick(value, event);
            value.root.oninput = event => onCreatorInput(value, event);
            value.root.onchange = event => onCreatorChange(value, event);
            value.root.onkeydown = event => {
                const menu = value.root.querySelector('[data-role-split-menu]');
                const toggle = value.root.querySelector('[data-role-split-toggle]');
                const more = value.root.querySelector('.role-more-menu');
                if (event.key === 'Escape' && menu && !menu.hidden) {
                    event.preventDefault(); menu.hidden = true; toggle?.setAttribute('aria-expanded', 'false'); toggle?.focus();
                } else if (event.key === 'Escape' && more?.open) {
                    event.preventDefault(); more.open = false; more.querySelector('summary')?.focus();
                } else if (event.target === toggle && event.key === 'ArrowDown' && !toggle.disabled) {
                    event.preventDefault(); menu.hidden = false; toggle.setAttribute('aria-expanded', 'true'); menu.querySelector('button')?.focus();
                }
            };
            value.root.querySelectorAll('details[data-role-disclosure]').forEach(detail => {
                detail.addEventListener('toggle', () => {
                    if (creator !== value || !detail.isConnected) return;
                    value.expanded[detail.dataset.roleDisclosure] = detail.open;
                    persistCreator(value);
                });
            });
        }

        async function openCreator(options = {}) {
            if (creator) return;
            closed = false;
            const mode = ['create', 'edit', 'copy'].includes(options.mode) ? options.mode : 'create';
            const token = stamp();
            if (!token.userId) { callNotice('请先登录再创建角色。', 'warn'); return; }
            const key = creatorKey(mode, options.roleId || '');
            const saved = loadDraft(token, key);
            const start = {
                mode, token, key, roleId: options.roleId || '', requestedVersion: Number(options.version) || undefined,
                position: saved?.pendingMutation || saved?.savedRole ? saved.position || null : options.position || null,
                pendingConnection: saved?.pendingMutation || saved?.savedRole ? saved.pendingConnection || null : options.pendingConnection || null,
                role: null, baseVersion: Number(saved?.baseVersion ?? saved?.base_version ?? saved?.pendingMutation?.payload?.base_version) || 0,
                baseRevision: Number(saved?.baseRevision ?? saved?.base_revision ?? saved?.pendingMutation?.payload?.base_revision) || 0,
                snapshot: snapshotCopy(saved?.snapshot || emptySnapshot()),
                baseline: saved?.baseline || canonical(emptySnapshot()), expanded: saved?.expanded || { tools: false, rules: false },
                saveMode: saved?.saveMode === 'join' ? 'join' : saved?.saveMode === 'library' ? 'library'
                    : context().writable === true && token.documentId ? 'join' : 'library',
                pendingMutation: saved?.pendingMutation || null,
                savedRole: saved?.savedRole || null, joinMutationId: saved?.joinMutationId || '',
                joinMessage: saved?.joinMessage || '', message: '', error: '', busy: false,
                phase: '', loadingSource: !!options.roleId && !saved?.pendingMutation && !saved?.savedRole && (mode === 'edit' || !saved?.snapshot),
                loadError: '', domId: uuid().replace(/[^a-zA-Z0-9_-]/g, ''),
                root: null, layer: null, childDirty: false,
                childDrafts: Object.fromEntries(['responsibilities', 'delivery'].filter(field => saved?.childDrafts?.[field]
                    && typeof saved.childDrafts[field] === 'object').map(field => [field, saved.childDrafts[field]])),
                hasDraft: !!saved?.snapshot, conflict: null, localSafe: null
            };
            creator = start;
            start.layer = addLayer({
                className: 'canvas-role-creator-dialog', labelledBy: 'canvas-role-creator-title', content: '<div data-role-creator-root></div>',
                onDismiss: () => dismissCreator(start),
                onClose: () => { if (creator === start) creator = null; },
                anchor: options.anchor
            });
            start.root = openRoot(start.layer, '[data-role-creator-root]');
            renderCreator(start);
            if (start.loadingSource) await loadCreatorRole(start);
            else {
                persistCreator(start);
                renderCreator(start);
            }
        }

        async function loadCreatorRole(value) {
            const token = value.token;
            if (value.busy || value.pendingMutation || value.savedRole) return;
            value.loadingSource = true; value.loadError = ''; renderCreator(value);
            try {
                const targetVersion = value.mode === 'edit' && value.baseVersion ? value.baseVersion : value.requestedVersion;
                const result = await getRoleData(value.roleId, targetVersion, token);
                if (creator !== value || !sameContext(token)) return;
                value.role = result.role;
                const sourceVersion = Number(result.version.version);
                if (!value.hasDraft) {
                    value.snapshot = snapshotCopy(result.snapshot);
                    if (value.mode === 'copy') value.snapshot.name = (value.snapshot.name || '角色').slice(0, 77) + ' 副本';
                    value.baseVersion = sourceVersion;
                    value.baseRevision = roleRevision(result.role);
                    value.baseline = value.mode === 'edit' ? canonical(result.snapshot) : canonical(emptySnapshot());
                    value.hasDraft = true;
                }
                value.conflict = value.mode === 'edit' && (!value.baseVersion || !value.baseRevision
                    || value.baseVersion !== roleVersion(result.role) || value.baseRevision !== roleRevision(result.role))
                    ? { message: value.baseVersion
                        ? '当前草稿基于 v' + value.baseVersion + '，角色库已变为 v' + roleVersion(result.role) + '。草稿和原版本已保留，请查看最新版本或复制草稿。'
                        : '这份草稿缺少原版本信息，已保留内容。请查看最新版本或复制草稿。' } : null;
                value.loadingSource = false;
                persistCreator(value);
            } catch (error) {
                if (creator !== value || error?.name === 'AbortError') return;
                value.loadingSource = false;
                value.loadError = messageOf(error);
                if (value.mode === 'edit' && value.hasDraft) value.conflict = {
                    message: '暂时无法核对原角色版本，草稿与原版本信息已保留。可重新读取，或复制草稿为新角色。'
                };
            }
            renderCreator(value);
        }

        async function getRoleData(id, version, token) {
            const params = new URLSearchParams();
            if (version) params.set('version', String(version));
            const result = await request(API + '/roles/' + encodeURIComponent(id) + (params.size ? '?' + params.toString() : ''), {}, token, true);
            const role = result?.role || result?.data?.role;
            let snapshot = result?.version?.snapshot || result?.snapshot;
            if (!snapshot && typeof result?.version?.snapshot_json === 'string') {
                try { snapshot = JSON.parse(result.version.snapshot_json); } catch (_) { /* Invalid server response is handled below. */ }
            }
            if (roleId(role) !== String(id) || snapshot?.schema !== 'role.v1'
                || !Number.isSafeInteger(result?.version?.version) || result.version.version < 1
                || (version && result.version.version !== Number(version))
                || !Number.isSafeInteger(role?.current_version) || !Number.isSafeInteger(role?.revision)
                || role.current_version < 1 || role.revision < 1) throw new Error('角色详情格式无效，请重新读取。');
            return { role, snapshot: snapshotCopy(snapshot), version: result.version };
        }

        async function dismissCreator(value) {
            if (creator !== value || value.busy) return false;
            const dirty = hasCreatorChanges(value);
            if (dirty) {
                const localSafe = persistCreator(value);
                const outcome = value.savedRole ? '角色已存到角色库，不会重新创建。'
                    : value.pendingMutation ? '保存结果未确认，原请求编号与内容不会改变。' : '修改尚未提交。';
                const close = await confirm({ title: '关闭角色？', message: outcome + (localSafe
                    ? '已保留为本账号的本地草稿，关闭后可继续。'
                    : '本地草稿保存失败，刷新或关闭网页可能丢失。'), confirmText: localSafe ? '关闭并保留' : '仍然关闭' });
                if (!close) return false;
            }
            return true;
        }
        function hasCreatorChanges(value) {
            return !!value && (!!value.pendingMutation || !!value.savedRole || canonical(value.snapshot) !== value.baseline
                || value.childDirty || Object.keys(value.childDrafts || {}).length > 0);
        }
        async function dismissAll() {
            if (creator) {
                await creator.layer.dismiss();
            } else {
                clearLibrary(true);
            }
        }

        function onCreatorInput(value, event) {
            if (creator !== value || creatorLocked(value)) return;
            const target = event.target;
            if (target.matches('[data-role-name]')) value.snapshot.name = target.value;
            if (!persistCreator(value)) status(value.root, creatorLabel(value), 'warning');
        }
        function onCreatorChange(value, event) {
            if (creator !== value || creatorLocked(value)) return;
            const target = event.target;
            if (target.matches('[data-role-model]')) {
                const model = textModels(context()).find(item => item.id === target.value);
                if (model) value.snapshot.executor = { kind: 'ai', model: model.id };
                persistCreator(value);
            } else if (target.matches('[data-role-tool]')) {
                const next = new Set(value.snapshot.tools);
                target.checked ? next.add(target.dataset.roleTool) : next.delete(target.dataset.roleTool);
                value.snapshot.tools = [...next].filter(item => item === 'manual' || item === 'text');
                persistCreator(value);
                renderCreator(value);
                value.root.querySelector('[data-role-tool="' + target.dataset.roleTool + '"]')?.focus();
            }
        }
        async function onCreatorClick(value, event) {
            const button = event.target.closest('button');
            if (!event.target.closest('.role-split-command')) {
                const menu = value.root.querySelector('[data-role-split-menu]');
                if (menu) menu.hidden = true;
                value.root.querySelector('[data-role-split-toggle]')?.setAttribute('aria-expanded', 'false');
            }
            if (!button || button.disabled || creator !== value || !sameContext(value.token)) return;
            if (button.hasAttribute('data-role-close') || button.hasAttribute('data-role-cancel')) return void dismissAll();
            if (button.hasAttribute('data-role-source-retry')) return void loadCreatorRole(value);
            if (button.hasAttribute('data-role-preview')) return void openPreview('', undefined, value.token, value.snapshot);
            if (button.hasAttribute('data-role-read-latest')) return void openPreview(value.roleId, undefined, value.token);
            if (button.hasAttribute('data-role-copy-draft')) return void copyConflictDraft(value);
            if (button.hasAttribute('data-role-reset')) return void resetCreatorDraft(value);
            if (button.hasAttribute('data-role-submit')) return void submitCreator(value);
            if (creatorLocked(value)) return;
            if (button.hasAttribute('data-role-template')) return void openTemplatePicker(value);
            if (button.dataset.roleEditField) return void openTextEditor(value, button.dataset.roleEditField, button);
            if (button.dataset.roleExecutor) {
                const kind = button.dataset.roleExecutor;
                if (kind === 'person') value.snapshot.executor = { kind: 'person', userId: value.token.userId };
                else if (kind === 'unassigned') value.snapshot.executor = { kind: 'unassigned' };
                else {
                    const models = textModels(context());
                    if (!models.length) { status(value.root, '当前没有可用文字模型，未更改执行者。', 'warning'); return; }
                    const existing = models.find(item => item.id === value.snapshot.executor.model);
                    value.snapshot.executor = { kind: 'ai', model: existing?.id || models[0].id };
                }
                persistCreator(value);
                renderCreator(value);
                value.root.querySelector('[data-role-executor="' + kind + '"]')?.focus();
                return;
            }
            if (button.hasAttribute('data-role-split-toggle')) {
                const menu = value.root.querySelector('[data-role-split-menu]');
                const open = menu?.hidden;
                if (menu) menu.hidden = !open;
                button.setAttribute('aria-expanded', String(!!open));
                return;
            }
            if (button.dataset.roleSaveMode) {
                value.saveMode = button.dataset.roleSaveMode;
                persistCreator(value);
                renderCreator(value);
                value.root.querySelector('[data-role-submit]')?.focus();
                return;
            }
        }

        async function copyConflictDraft(value) {
            if (creator !== value || value.busy || value.loadingSource || value.pendingMutation || value.savedRole
                || !sameContext(value.token) || !topLayer(value.layer)) return;
            const copyKey = creatorKey('copy', value.roleId);
            const existing = loadDraft(value.token, copyKey);
            if (existing?.pendingMutation || existing?.savedRole) {
                status(value.root, '已有复制操作待核对，请先关闭当前编辑并继续该复制操作。', 'warning'); return;
            }
            if (existing?.snapshot && !await confirm({ title: '替换复制草稿？', message: '已有未提交的复制草稿，是否用当前保留内容替换？', confirmText: '替换' })) return;
            if (creator !== value || !sameContext(value.token)) return;
            persistCreator(value);
            writeLocal(value.token, state => {
                state.drafts[copyKey] = {
                    snapshot: snapshotCopy(value.snapshot), baseline: canonical(emptySnapshot()),
                    baseVersion: value.baseVersion, baseRevision: value.baseRevision,
                    expanded: value.expanded, childDrafts: JSON.parse(JSON.stringify(value.childDrafts)),
                    saveMode: value.saveMode, requestedVersion: value.baseVersion,
                    position: value.position, pendingConnection: value.pendingConnection
                };
            });
            value.layer.close();
            await openCreator({ mode: 'copy', roleId: value.roleId, version: value.baseVersion,
                position: value.position, pendingConnection: value.pendingConnection });
        }

        async function resetCreatorDraft(value) {
            if (creator !== value || creatorLocked(value)) return;
            const accepted = await confirm({ title: '重置草稿？', message: value.mode === 'edit'
                ? '清除当前未提交内容，重新读取角色库最新版本。'
                : '清除当前未提交内容和二级输入草稿。', confirmText: '重置' });
            if (!accepted || creator !== value || !sameContext(value.token)) return;
            discardCreatorDraft(value);
            value.snapshot = emptySnapshot(); value.baseline = canonical(emptySnapshot());
            value.childDrafts = {}; value.childDirty = false; value.hasDraft = false;
            value.conflict = null; value.message = ''; value.baseVersion = 0; value.baseRevision = 0;
            if (value.mode === 'edit') value.requestedVersion = undefined;
            if (value.roleId) await loadCreatorRole(value);
            else { persistCreator(value); renderCreator(value); }
        }

        function openTextEditor(value, field) {
            if (creator !== value || creatorLocked(value) || !topLayer(value.layer)
                || !['responsibilities', 'delivery'].includes(field) || !sameContext(value.token)) return;
            const duty = field === 'responsibilities';
            const saved = value.childDrafts[field];
            const draft = saved ? {
                main: String(saved.main || ''), secondary: String(saved.secondary || ''),
                requiredItems: Array.isArray(saved.requiredItems) ? saved.requiredItems.map(String) : []
            } : {
                main: duty ? value.snapshot.responsibilities : value.snapshot.delivery,
                secondary: duty ? value.snapshot.boundary : value.snapshot.criteria,
                requiredItems: value.snapshot.requiredItems.slice()
            };
            const id = 'role-subtitle-' + uuid().replace(/[^a-zA-Z0-9_-]/g, '');
            let root = null, dirty = !!saved;
            const title = duty ? '职责' : '交付';
            const layer = addLayer({
                className: 'canvas-role-secondary-dialog', labelledBy: id,
                content: '<div data-role-secondary-root></div>',
                onDismiss: async () => {
                    if (!dirty) return true;
                    const localSafe = persistChild();
                    return confirm({ title: '保留输入？', message: localSafe
                        ? '这层还未确定，内容已保留为本地草稿，未应用到角色。'
                        : '本地保存失败。这层还未确定，刷新或关闭网页可能丢失输入。',
                        confirmText: localSafe ? '关闭并保留' : '仍然关闭' });
                },
                onClose: () => {
                    value.childDirty = Object.keys(value.childDrafts).length > 0;
                    if (creator === value && sameContext(value.token)) {
                        renderCreator(value);
                        value.root.querySelector('[data-role-edit-field="' + field + '"]')?.focus();
                    }
                }
            });
            root = openRoot(layer, '[data-role-secondary-root]');
            function persistChild() {
                value.childDrafts[field] = { main: draft.main, secondary: draft.secondary, requiredItems: draft.requiredItems.slice() };
                value.childDirty = true;
                return persistCreator(value);
            }
            function changed() {
                dirty = true;
                if (!persistChild()) status(root, '本地草稿保存失败，刷新可能丢失输入。', 'warning');
            }
            function render() {
                if (!root || layer.closed || creator !== value || !sameContext(value.token)) return;
                const itemRows = draft.requiredItems.map((item, index) => '<div class="role-required-item"><input type="text" maxlength="160" data-required-item="' + index + '" aria-label="必交项 ' + (index + 1) + '" value="' + html(item) + '"><button type="button" class="role-icon-button" data-remove-required="' + index + '" aria-label="移除必交项" title="移除必交项">' + icon('X') + '</button></div>').join('');
                const secondary = '<label class="role-field-label">' + (duty ? '职责边界与方法' : '验收要求（可选）') + '<textarea data-secondary-secondary rows="3" maxlength="8000" placeholder="可留空">' + html(draft.secondary) + '</textarea></label>';
                root.innerHTML = '<div class="role-module-root role-secondary-root"><header class="role-module-head"><h2 id="' + id + '">' + title + '</h2><button type="button" class="role-icon-button" data-sub-close aria-label="关闭" title="关闭">' + icon('X') + '</button></header>' +
                    '<main class="role-secondary-body"><label class="role-field-label">' + (duty ? '职责内容' : '交付内容') + '<textarea data-secondary-main rows="5" maxlength="12000">' + html(draft.main) + '</textarea></label>' +
                    (duty ? '<details class="role-secondary-options" ' + (draft.secondary ? 'open' : '') + '><summary>边界与方法（可选）</summary>' + secondary + '</details>' : secondary) +
                    (!duty ? '<section class="role-required-list"><div class="role-secondary-section-head"><strong>必交项</strong><button type="button" class="role-inline-action" data-add-required ' + (draft.requiredItems.length >= 30 ? 'disabled' : '') + '>' + icon('Plus') + '添加</button></div>' + (itemRows || '<p class="role-muted-note">未配置必交项，不会自动判断是否齐全。</p>') + '</section>' : '') +
                    '<p class="role-module-status" data-role-status role="status">' + (value.localSafe === false ? '本地草稿保存失败，刷新可能丢失输入。' : '') + '</p></main><footer class="role-secondary-footer"><button type="button" class="role-secondary-command" data-sub-close>取消</button><button type="button" class="role-primary-command" data-sub-apply>确定</button></footer></div>';
                root.onclick = onClick;
                root.oninput = event => {
                    if (layer.closed || creator !== value || !sameContext(value.token)) return;
                    const target = event.target;
                    if (target.matches('[data-secondary-main]')) draft.main = target.value;
                    else if (target.matches('[data-secondary-secondary]')) draft.secondary = target.value;
                    else if (target.matches('[data-required-item]')) draft.requiredItems[Number(target.dataset.requiredItem)] = target.value;
                    else return;
                    changed();
                };
            }
            async function onClick(event) {
                const button = event.target.closest('button');
                if (!button || button.disabled || !topLayer(layer) || creator !== value || !sameContext(value.token)) return;
                if (button.hasAttribute('data-sub-close')) return void layer.dismiss();
                if (button.hasAttribute('data-add-required')) {
                    if (draft.requiredItems.length < 30) {
                        draft.requiredItems.push(''); changed(); render();
                        root.querySelector('[data-required-item="' + (draft.requiredItems.length - 1) + '"]')?.focus();
                    }
                    return;
                }
                if (button.dataset.removeRequired != null) {
                    draft.requiredItems.splice(Number(button.dataset.removeRequired), 1); changed(); render(); return;
                }
                if (!button.hasAttribute('data-sub-apply')) return;
                if (!draft.main.trim()) {
                    status(root, duty ? '请填写职责内容。' : '请填写交付内容。', 'warning');
                    root.querySelector('[data-secondary-main]')?.focus(); return;
                }
                const items = draft.requiredItems.map(item => item.trim()).filter(Boolean);
                if (!duty && (draft.requiredItems.some(item => !item.trim()) || new Set(items).size !== items.length)) {
                    status(root, '请填写或移除空白必交项，名称不能重复。', 'warning'); return;
                }
                if (draft.main.length > 12000 || draft.secondary.length > 8000 || items.length > 30 || items.some(item => item.length > 160)) {
                    status(root, '输入内容过长，请缩短后再确定。', 'warning'); return;
                }
                if (duty) {
                    value.snapshot.responsibilities = draft.main.trim(); value.snapshot.boundary = draft.secondary.trim();
                } else {
                    value.snapshot.delivery = draft.main.trim(); value.snapshot.criteria = draft.secondary.trim();
                    value.snapshot.requiredItems = items;
                }
                delete value.childDrafts[field];
                value.childDirty = Object.keys(value.childDrafts).length > 0;
                dirty = false; persistCreator(value); layer.close(); renderCreator(value);
                value.root.querySelector('[data-role-edit-field="' + field + '"]')?.focus();
            }
            render();
        }

        function previewMarkup(snap) {
            const executor = snap.executor.kind === 'ai'
                ? 'AI · ' + ((textModels(context()).find(item => item.id === snap.executor.model)?.label) || snap.executor.model || '文字模型')
                : snap.executor.kind === 'person' ? '本人' : '稍后指定';
            return '<div class="role-preview-content"><dl><div><dt>名称</dt><dd>' + html(snap.name || '未命名角色') + '</dd></div>' +
                '<div><dt>执行者</dt><dd>' + html(executor) + '</dd></div>' +
                '<div><dt>职责</dt><dd>' + html(snap.responsibilities || '未填写') + '</dd></div>' +
                (snap.boundary ? '<div><dt>边界</dt><dd>' + html(snap.boundary) + '</dd></div>' : '') +
                '<div><dt>交付</dt><dd>' + html(snap.delivery || '未填写') + '</dd></div>' +
                (snap.criteria ? '<div><dt>验收要求</dt><dd>' + html(snap.criteria) + '</dd></div>' : '') +
                (snap.requiredItems.length ? '<div><dt>必交项</dt><dd><ul>' + snap.requiredItems.map(item => '<li>' + html(item) + '</li>').join('') + '</ul></dd></div>' : '') +
                '<div><dt>已配置能力</dt><dd>' + html(snap.tools.map(tool => tool === 'manual' ? '人工提交' : '文字能力').join('、') || '无') + '</dd></div></dl></div>';
        }
        async function openPreview(id, version, token, localSnapshot) {
            if (!token || !sameContext(token)) return;
            const domId = 'role-preview-title-' + uuid().replace(/[^a-zA-Z0-9_-]/g, '');
            const layer = addLayer({ className: 'canvas-role-preview-dialog', labelledBy: domId, content: '<div data-role-preview-root></div>' });
            const root = openRoot(layer, '[data-role-preview-root]');
            let snapshot = localSnapshot ? snapshotCopy(localSnapshot) : null;
            let role = null, loading = false, requestId = 0, requestedVersion = version;
            function render(loading, error) {
                if (!root || layer.closed || !sameContext(token)) return;
                const latest = role ? roleVersion(role) : (version || 1);
                root.innerHTML = '<div class="role-module-root role-preview-root"><header class="role-module-head"><div><h2 id="' + domId + '">角色预览</h2>' + (role ? '<span class="role-version-badge">v' + html(version || latest) + '</span>' : '') + '</div><button type="button" class="role-icon-button" data-preview-close aria-label="关闭" title="关闭">' + icon('X') + '</button></header>' +
                    (role && latest > 1 ? '<div class="role-preview-version"><label>版本<input type="number" min="1" max="' + latest + '" step="1" data-preview-version value="' + html(version || latest) + '" ' + (loading ? 'disabled' : '') + '></label><button type="button" class="role-secondary-command" data-preview-read ' + (loading ? 'disabled' : '') + '>查看</button><span>共 ' + latest + ' 个版本</span></div>' : '') +
                    (error ? '<div class="role-error-state" role="alert">' + html(error) + '<button type="button" data-preview-retry>重试</button></div>' : loading ? '<div class="role-library-skeleton"><i></i><i></i></div>' : snapshot ? previewMarkup(snapshot) : '<p class="role-muted-note">没有可预览的角色版本。</p>') +
                    '<footer class="role-secondary-footer">' + (!creator && role && !loading && !error && roleStatus(role) === 'active' ? '<button type="button" class="role-secondary-command" data-preview-copy>复制此版本</button>' : '') + '<button type="button" class="role-secondary-command" data-preview-close>关闭</button></footer></div>';
                root.onclick = async event => {
                    const button = event.target.closest('button');
                    if (!button || button.disabled || !topLayer(layer) || !sameContext(token)) return;
                    if (button.hasAttribute('data-preview-close')) { await layer.dismiss(); return; }
                    if (button.hasAttribute('data-preview-copy') && role && !creator) {
                        layer.close();
                        await openCreator({ roleId: roleId(role), version: Number(version || latest), mode: 'copy',
                            position: library?.options.position, pendingConnection: library?.options.pendingConnection });
                    } else if (button.hasAttribute('data-preview-retry')) void loadPreview(requestedVersion);
                    else if (button.hasAttribute('data-preview-read')) {
                        const input = root.querySelector('[data-preview-version]');
                        const target = Number(input.value);
                        if (!Number.isSafeInteger(target) || target < 1 || target > latest) { input.reportValidity(); return; }
                        void loadPreview(target);
                    }
                };
            }
            async function loadPreview(targetVersion) {
                if (!id || layer.closed || !sameContext(token)) { render(false); return; }
                const readId = ++requestId;
                requestedVersion = targetVersion;
                loading = true; render(true);
                try {
                    const result = await getRoleData(id, targetVersion, token);
                    if (layer.closed || readId !== requestId || !sameContext(token)) return;
                    role = result.role; snapshot = result.snapshot; version = result.version.version;
                    loading = false;
                    render(false);
                } catch (error) {
                    if (!layer.closed && readId === requestId && sameContext(token) && error?.name !== 'AbortError') {
                        loading = false; render(false, messageOf(error));
                    }
                }
            }
            if (id) await loadPreview(version);
            else render(false);
        }

        async function openTemplatePicker(value) {
            if (creator !== value || creatorLocked(value) || !topLayer(value.layer) || !sameContext(value.token)) return;
            const token = value.token, id = 'role-template-title-' + uuid().replace(/[^a-zA-Z0-9_-]/g, '');
            const layer = addLayer({ className: 'canvas-role-template-dialog', labelledBy: id, content: '<div data-role-template-root></div>' });
            const root = openRoot(layer, '[data-role-template-root]');
            let rows = [], cursor = null, loading = false, selecting = false, error = '';
            function render() {
                if (!root || layer.closed || creator !== value || !sameContext(token)) return;
                root.innerHTML = '<div class="role-module-root role-template-root"><header class="role-module-head"><h2 id="' + id + '">选择模板</h2><button type="button" class="role-icon-button" data-template-close aria-label="关闭" title="关闭">' + icon('X') + '</button></header>' +
                    '<main class="role-template-body">' + (error ? '<div class="role-error-state" role="alert">' + html(error) + '<button type="button" data-template-reload>重新加载</button></div>' : '') +
                    (loading && !rows.length ? '<div class="role-library-skeleton"><i></i><i></i></div>' : '') +
                    '<ul class="role-library-list">' + rows.map(role => '<li class="role-library-row"><div class="role-library-info"><strong>' + html(role.name || '未命名角色') + '</strong><span>v' + roleVersion(role) + '</span></div><button type="button" class="role-row-primary" data-template-use="' + html(roleId(role)) + '" ' + (loading || selecting ? 'disabled' : '') + '>复制为新角色</button></li>').join('') + '</ul>' +
                    (!loading && !error && !rows.length ? '<p class="role-empty-state">没有可用模板</p>' : '') +
                    (cursor ? '<button type="button" class="role-load-more" data-template-more ' + (loading || selecting ? 'disabled' : '') + '>加载更多</button>' : '') + (selecting ? '<p class="role-module-status" role="status">正在读取模板…</p>' : '') + '</main></div>';
                root.onclick = event => {
                    const button = event.target.closest('button'); if (!button || button.disabled || !topLayer(layer)) return;
                    if (button.hasAttribute('data-template-close')) { void layer.dismiss(); return; }
                    if (button.hasAttribute('data-template-reload')) void load(false);
                    if (button.hasAttribute('data-template-more')) void load(true);
                    if (button.dataset.templateUse) void useTemplate(button.dataset.templateUse);
                };
            }
            async function load(append) {
                if (loading || selecting || layer.closed || !sameContext(token)) return;
                loading = true; error = ''; if (!append) { rows = []; cursor = null; } render();
                const params = new URLSearchParams({ status: 'active', q: '' }); if (append && cursor) params.set('cursor', cursor);
                try {
                    const result = await request(API + '/roles?' + params.toString(), {}, token, true);
                    if (layer.closed || creator !== value || !sameContext(token)) return;
                    if (!Array.isArray(result?.roles)) throw new Error('模板返回格式无效，请重新加载。');
                    rows = append ? [...new Map(rows.concat(result.roles).map(role => [roleId(role), role])).values()] : result.roles;
                    cursor = typeof result.next_cursor === 'string' ? result.next_cursor : null;
                } catch (failure) { if (failure?.name !== 'AbortError') error = messageOf(failure); }
                finally { loading = false; render(); }
            }
            async function useTemplate(id) {
                const source = rows.find(row => roleId(row) === id);
                if (!source || selecting || loading || creator !== value || creatorLocked(value) || layer.closed || !sameContext(token)) return;
                selecting = true; error = ''; render();
                try {
                    if (hasCreatorChanges(value) && !await confirm({ title: '替换角色内容？', message: '用模板替换当前未提交内容和二级输入草稿。', confirmText: '替换' })) return;
                    if (layer.closed || creator !== value || !sameContext(token) || creatorLocked(value)) return;
                    const result = await getRoleData(id, roleVersion(source), token);
                    if (layer.closed || creator !== value || !sameContext(token) || creatorLocked(value)) return;
                    const name = result.snapshot.name || '角色';
                    value.snapshot = snapshotCopy(result.snapshot);
                    value.snapshot.name = name.slice(0, 77) + ' 副本';
                    value.childDrafts = {}; value.childDirty = false; value.hasDraft = true;
                    value.baseline = canonical(emptySnapshot());
                    persistCreator(value);
                    layer.close(); renderCreator(value);
                } catch (failure) { error = messageOf(failure); render(); }
                finally { selecting = false; render(); }
            }
            render();
            await load(false);
        }

        function mutationDescriptor(kind, path, payload) {
            return { kind, path, payload: JSON.parse(JSON.stringify(payload)), mutationId: payload.mutation_id };
        }
        async function mutationRequest(descriptor, token) {
            const result = await request(descriptor.path, { method: descriptor.kind === 'create' ? 'POST' : 'PATCH', payload: descriptor.payload }, token, false);
            return result;
        }
        async function receiptOrRetry(descriptor, token) {
            try {
                return await request(API + '/role-receipts/' + encodeURIComponent(descriptor.mutationId), {}, token, true);
            } catch (error) {
                if (errorStatus(error) === 404) return mutationRequest(descriptor, token);
                error.receiptLookup = true;
                throw error;
            }
        }
        function extractCreated(result, descriptor) {
            const role = result?.role || result?.result?.role;
            const version = result?.version || result?.result?.version;
            const expected = snapshotCopy(descriptor.payload.snapshot);
            for (const field of ['name', 'responsibilities', 'delivery', 'criteria', 'boundary']) expected[field] = expected[field].trim();
            expected.requiredItems = expected.requiredItems.map(item => item.trim());
            expected.tools = [...new Set(expected.tools)];
            if (!roleId(role) || !Number.isSafeInteger(version?.version) || version.version < 1
                || !version.snapshot || version.snapshot.schema !== 'role.v1'
                || result?.mutation_id !== descriptor.mutationId
                || canonical(snapshotCopy(version.snapshot)) !== canonical(expected)
                || (descriptor.kind === 'edit' && roleId(role) !== creator?.roleId)) {
                throw new Error('角色保存回执不完整，请继续核对原回执。');
            }
            return { role, version };
        }
        async function submitCreator(value) {
            if (creator !== value || value.busy || value.loadingSource || !sameContext(value.token) || !topLayer(value.layer)) return;
            if (value.savedRole) {
                if (value.saveMode === 'join' && context().writable === true && context().documentId) return void retryJoin(value);
                discardCreatorDraft(value); value.layer.close();
                callNotice('角色已保留在角色库。', 'success'); return;
            }
            const recovering = !!value.pendingMutation;
            if (!value.pendingMutation) {
                if (value.loadError || value.conflict || (value.mode === 'edit' && (!value.role || roleStatus(value.role) !== 'active'))) return;
                const childField = Object.keys(value.childDrafts)[0];
                if (childField) {
                    status(value.root, '还有二级输入未确定，请先确认保留内容。', 'warning');
                    return void openTextEditor(value, childField, value.root.querySelector('[data-role-edit-field="' + childField + '"]'));
                }
                const snap = snapshotCopy(value.snapshot);
                snap.name = snap.name.trim();
                if (!snap.name) { status(value.root, '请填写角色名称。', 'warning'); value.root.querySelector('[data-role-name]')?.focus(); return; }
                if (!snap.responsibilities.trim()) { status(value.root, '请填写职责。', 'warning'); return void openTextEditor(value, 'responsibilities', value.root.querySelector('[data-role-edit-field="responsibilities"]')); }
                if (!snap.delivery.trim()) { status(value.root, '请填写交付。', 'warning'); return void openTextEditor(value, 'delivery', value.root.querySelector('[data-role-edit-field="delivery"]')); }
                if (snap.name.length > 80 || snap.responsibilities.length > 12000 || snap.delivery.length > 12000
                    || snap.criteria.length > 8000 || snap.boundary.length > 8000 || snap.requiredItems.some(item => item.length > 160)) {
                    status(value.root, '输入内容过长，请缩短后再保存。', 'warning'); return;
                }
                if (snap.executor.kind === 'person') snap.executor = { kind: 'person', userId: value.token.userId };
                if (snap.executor.kind === 'ai') {
                    const model = textModels().find(item => item.id === snap.executor.model);
                    if (!model) { status(value.root, '所选文字模型当前不可用，请重新选择。', 'warning'); return; }
                    snap.executor = { kind: 'ai', model: model.id };
                }
                if (snap.executor.kind === 'unassigned') snap.executor = { kind: 'unassigned' };
                snap.tools = [...new Set(snap.tools.filter(tool => tool === 'manual' || tool === 'text'))];
                snap.requiredItems = snap.requiredItems.map(item => String(item).trim()).filter(Boolean);
                value.snapshot = snap;
                if (value.saveMode === 'join' && (context().writable !== true || !context().documentId)) {
                    value.saveMode = 'library';
                }
                const mutationId = uuid();
                const payload = value.mode === 'edit'
                    ? { mutation_id: mutationId, base_revision: value.baseRevision, base_version: value.baseVersion, action: 'edit', snapshot: snap }
                    : { mutation_id: mutationId, snapshot: snap };
                value.pendingMutation = mutationDescriptor(value.mode === 'edit' ? 'edit' : 'create', value.mode === 'edit' ? API + '/roles/' + encodeURIComponent(value.roleId) : API + '/roles', payload);
                value.pendingMutation.saveMode = value.saveMode;
            }
            const descriptor = value.pendingMutation;
            value.busy = true; value.phase = 'saving'; value.message = ''; persistCreator(value); renderCreator(value);
            try {
                const result = await (recovering ? receiptOrRetry(descriptor, value.token) : mutationRequest(descriptor, value.token));
                if (creator !== value || !sameContext(value.token)) { persistCreator(value); return; }
                const created = extractCreated(result, descriptor);
                if (value.mode === 'edit') {
                    value.pendingMutation = null; value.busy = false; value.phase = '';
                    discardCreatorDraft(value); value.layer.close();
                    if (library) void loadLibrary(library, false);
                    notifySaved();
                    callNotice('已保存新版本 v' + created.version.version + '。', 'success');
                    return;
                }
                value.savedRole = { id: roleId(created.role), version: created.version.version };
                value.snapshot = snapshotCopy(created.version.snapshot);
                value.pendingMutation = null; value.baseline = canonical(value.snapshot); value.busy = false; value.phase = '';
                value.saveMode = descriptor.saveMode || value.saveMode;
                value.message = '已创建到角色库。'; persistCreator(value);
                if (library) void loadLibrary(library, false);
                notifySaved();
                if (value.saveMode === 'library') {
                    discardCreatorDraft(value); value.layer.close();
                    callNotice('已创建到角色库。', 'success'); return;
                }
                renderCreator(value);
                await retryJoin(value);
            } catch (error) {
                if (creator !== value || !sameContext(value.token)) { persistCreator(value); return; }
                value.busy = false; value.phase = '';
                if (apiErrorIsCertain(error)) {
                    value.pendingMutation = null;
                    value.message = messageOf(error);
                    if (errorCode(error) === 'revision_conflict') {
                        value.conflict = { message: '角色库已更新，当前草稿和原版本已保留。请查看最新版本或复制草稿。' };
                    }
                } else value.message = '保存结果未确认；已保留原请求编号和内容。点击“继续核对保存”恢复。';
                persistCreator(value); renderCreator(value);
                if (apiErrorIsCertain(error)) callNotice(messageOf(error), 'warn');
            }
        }

        async function retryJoin(value) {
            if (creator !== value || !value.savedRole || value.busy || !sameContext(value.token)) return;
            if (context().writable !== true || !context().documentId) {
                value.joinMessage = '角色已创建，当前画布不可写；可稍后回到可写画布加入。';
                persistCreator(value); renderCreator(value); return;
            }
            const joinKey = value.savedRole.id + ':' + value.savedRole.version;
            const prior = localState(value.token).value.joins[joinKey];
            if (prior?.mutationId && value.joinMutationId && prior.mutationId !== value.joinMutationId) {
                value.joinMessage = '有另一项加入请求待核对，请先在角色库继续该请求。此处原请求仍保留。';
                persistCreator(value); renderCreator(value); return;
            }
            if (prior?.mutationId) {
                value.joinMutationId = prior.mutationId;
                value.position = prior.position; value.pendingConnection = prior.pendingConnection;
            } else if (!value.joinMutationId) value.joinMutationId = uuid();
            const localSafe = writeLocal(value.token, state => {
                state.joins[joinKey] = { mutationId: value.joinMutationId, definitionId: value.savedRole.id,
                    version: value.savedRole.version, position: value.position, pendingConnection: value.pendingConnection };
            });
            if (!localSafe) callNotice('本地恢复记录保存失败，请勿刷新待核对的加入请求。', 'warn');
            value.busy = true; value.phase = 'joining'; value.joinMessage = ''; persistCreator(value); renderCreator(value);
            if (library) renderLibrary(library);
            try {
                const joined = await bridge.joinRole({
                    definitionId: value.savedRole.id, version: value.savedRole.version,
                    mutationId: value.joinMutationId, position: value.position,
                    pendingConnection: value.pendingConnection
                });
                if (creator !== value || !sameContext(value.token)) { persistCreator(value); return; }
                if (!joined?.nodeId || joined.documentId !== value.token.documentId) throw new Error('加入画布回执不完整，保留原请求以便重试。');
                writeLocal(value.token, state => {
                    if (state.joins[joinKey]?.mutationId === value.joinMutationId) delete state.joins[joinKey];
                });
                value.busy = false; value.phase = '';
                value.joinMessage = ''; persistCreator(value);
                discardCreatorDraft(value);
                value.layer.close();
                if (library) void loadLibrary(library, false);
                notifySaved();
            } catch (error) {
                if (creator !== value || !sameContext(value.token)) { persistCreator(value); return; }
                value.busy = false; value.phase = '';
                value.joinMessage = '角色已创建，加入画布结果未确认。' + (messageOf(error) ? ' ' + messageOf(error) : '');
                persistCreator(value); renderCreator(value);
            }
        }

        async function joinExisting(state, role, retryKey) {
            if (library !== state || state.joiningKey || state.mutating || !sameContext(state.token) || context().writable !== true || !context().documentId || typeof bridge.joinRole !== 'function') return;
            const id = roleId(role);
            const joins = localState(state.token).value.joins;
            const key = retryKey || Object.keys(joins).find(item => item.startsWith(id + ':')) || id + ':' + roleVersion(role);
            const saved = joins[key] || {};
            const version = saved.version || Number(key.split(':')[1]);
            if (!id || !Number.isSafeInteger(version) || version < 1) { callNotice('原加入请求的角色版本无效，未新建请求。', 'warn'); return; }
            const join = saved.mutationId ? { ...saved, definitionId: id, version }
                : { mutationId: uuid(), definitionId: id, version, position: state.options.position, pendingConnection: state.options.pendingConnection };
            const localSafe = writeLocal(state.token, local => { local.joins[key] = join; });
            state.joiningKey = key;
            state.operationMessage = '正在加入画布…' + (localSafe ? '' : ' 本地保存失败，请勿刷新。');
            renderLibrary(state);
            try {
                const result = await bridge.joinRole({ definitionId: id, version, mutationId: join.mutationId, position: join.position, pendingConnection: join.pendingConnection });
                if (library !== state || !sameContext(state.token)) return;
                if (!result?.nodeId || result.documentId !== state.token.documentId) throw new Error('加入画布回执不完整。');
                writeLocal(state.token, local => { delete local.joins[key]; });
                notifySaved();
                clearLibrary(true);
            } catch (error) {
                if (library !== state || !sameContext(state.token)) return;
                state.operationMessage = '加入画布结果未确认，重试会沿用同一请求：' + messageOf(error);
                callNotice('加入画布结果未确认：' + messageOf(error), 'warn');
            } finally {
                if (library === state) { state.joiningKey = ''; renderLibrary(state); }
            }
        }

        async function archiveRole(state, role, action) {
            if (library !== state || state.mutating || state.joiningKey || !sameContext(state.token)) return;
            const label = action === 'archive' ? '归档' : '恢复';
            const accepted = await confirm({ title: label + '角色？', message: action === 'archive' ? '归档后不能再加入新画布，已有历史不会删除。' : '恢复后角色可重新加入画布。', confirmText: label });
            if (!accepted || library !== state || !sameContext(state.token)) return;
            const id = roleId(role), key = 'role:' + id;
            const prior = localState(state.token).value.pending[key];
            const descriptor = prior || mutationDescriptor('patch', API + '/roles/' + encodeURIComponent(id), {
                mutation_id: uuid(), base_revision: roleRevision(role), base_version: roleVersion(role), action
            });
            const localSafe = writeLocal(state.token, local => { local.pending[key] = descriptor; });
            state.operationMessage = localSafe ? '' : '本地保存失败，请勿刷新待核对的请求。';
            await resolveRoleAction(state, key, descriptor, !!prior);
        }
        async function resolveRoleAction(state, key, descriptor, recovering = true) {
            if (state.mutating || !sameContext(state.token)) return;
            state.mutating = true; renderLibrary(state);
            try {
                const result = await (recovering ? receiptOrRetry(descriptor, state.token) : mutationRequest(descriptor, state.token));
                if (library !== state || !sameContext(state.token)) return;
                const role = result?.role;
                const expectedStatus = descriptor.payload.action === 'archive' ? 'archived' : 'active';
                if (roleId(role) !== key.slice(5) || roleStatus(role) !== expectedStatus || result?.version !== null || result?.mutation_id !== descriptor.mutationId) {
                    throw new Error('角色变更回执不完整，原请求已保留。');
                }
                writeLocal(state.token, local => { delete local.pending[key]; });
                state.error = '';
                callNotice(descriptor.payload.action === 'archive' ? '角色已归档。' : '角色已恢复。', 'success');
                await loadLibrary(state, false);
            } catch (error) {
                if (library !== state || !sameContext(state.token)) return;
                if (apiErrorIsCertain(error)) writeLocal(state.token, local => { delete local.pending[key]; });
                state.error = apiErrorIsCertain(error) ? messageOf(error) : '保存结果未确认，原请求已保留；可继续核对。';
                renderLibrary(state);
            } finally {
                if (library === state) { state.mutating = false; renderLibrary(state); }
            }
        }
        async function reconcileLibraryPending(state) {
            if (library !== state || state.mutating || state.joiningKey || !sameContext(state.token)) return;
            const pending = Object.entries(localState(state.token).value.pending || {});
            if (!pending.length) return;
            const [key, descriptor] = pending[0];
            await resolveRoleAction(state, key, descriptor);
        }

        function hasUnsaved() { return hasCreatorChanges(creator); }
        function contextChanged() {
            cancelReads();
            hardCloseLayers();
            closed = false;
        }
        async function close() {
            if (closed) return;
            while (layers.length) {
                const layer = layers[layers.length - 1];
                if (!await layer.dismiss()) return;
            }
            closed = true;
            cancelReads();
            hardCloseLayers();
            clearLibrary(true);
        }

        return { openLibrary, openCreator, contextChanged, hasUnsaved, close };
    }
}());
