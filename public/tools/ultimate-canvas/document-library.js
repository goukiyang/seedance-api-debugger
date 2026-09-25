(function () {
    'use strict';

    const ENDPOINT = '/api/tools/ultimate-canvas/document';
    const LAST_KEY = 'ultimate-canvas:last-library-document';
    const labels = { rename: '重命名', duplicate: '创建副本', archive: '归档', restore: '恢复', restore_revision: '恢复版本' };
    let options, root, ui, dialog, projects = [], documents = [];
    let projectId = '', status = 'active', query = '', cursor = null, snapshot = '';
    let sequence = 0, loading = false, busy = false, timer, previousFocus;
    let lastId = '', retryList = null, dialogJob = null;
    const pendingMutations = new Map();
    let pendingCreate = null, historySequence = 0, historyState = null;
    let phase = 'initial', projectsReady = false, selectedInitialProject = false;
    const backgroundInert = new Map();

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function button(text, handler, className) {
        const node = el('button', className || 'uc-doc-button', text);
        node.type = 'button';
        node.addEventListener('click', handler);
        return node;
    }

    function idOf(doc) { return String(doc?.id || doc?.document_id || ''); }
    function current() { return options.getCurrentDocument() || null; }
    function key() { return JSON.stringify([projectId, status, query]); }
    function project() { return projects.find(item => String(item.id) === projectId); }
    function canCreate() {
        return isCreatableProject(project());
    }
    function isCreatableProject(item) {
        // can_generate is the bootstrap capability; reject an explicitly inactive project.
        return Boolean(item && item.can_generate === true && (!item.status || item.status === 'active'));
    }

    function imageUrl(value) {
        if (typeof value !== 'string' || !value.trim()) return '';
        try {
            const url = new URL(value, window.location.href);
            return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
        } catch { return ''; }
    }

    function avatar(owner) {
        const name = owner?.name || owner?.username;
        if (!name) return null;
        const wrap = el('span', 'uc-doc-owner');
        const face = el('span', 'uc-doc-avatar', Array.from(String(name))[0]);
        face.setAttribute('aria-hidden', 'true');
        const url = imageUrl(owner.avatar_url);
        if (url) {
            const img = el('img');
            img.alt = '';
            img.referrerPolicy = 'no-referrer';
            img.addEventListener('error', () => img.remove(), { once: true });
            img.src = url;
            face.append(img);
        }
        wrap.append(face, el('span', 'uc-doc-owner-name', name));
        return wrap;
    }

    function errorMessage(error, action) {
        const code = Number(error?.status || error?.statusCode);
        if (code === 401) return '登录已失效，请重新登录后再试。当前列表和输入已保留。';
        if (code === 403) return '没有操作权限，请联系项目管理员。';
        if (code === 404) return '画布已不存在或无法访问，请刷新列表。';
        if (code === 409) return '画布已被更新，请关闭此窗口并刷新列表后再试。';
        return action + '失败，请检查网络后重试。当前内容已保留。';
    }

    function definitelyRejected(error) {
        const code = Number(error?.status || error?.statusCode);
        return code >= 400 && code < 500 && code !== 408 && code !== 429;
    }

    function announce(message) {
        ui.message.textContent = message;
        try { options.notice?.(message); } catch { /* A toast must not change the operation result. */ }
    }

    function fail(error, action, retry) {
        ui.errorText.textContent = errorMessage(error, action);
        ui.error.hidden = false;
        retryList = retry || null;
        ui.retry.hidden = !retryList;
    }

    function clearError() {
        ui.error.hidden = true;
        retryList = null;
    }

    function syncProjects() {
        const source = options.getProjects();
        const list = Array.isArray(source) ? source : source?.context?.projects || source?.projects;
        if (!Array.isArray(list)) throw new Error('Projects unavailable');
        projects = list.filter(item => item && item.id && item.status !== 'deleted');
        if (!selectedInitialProject) {
            const selected = current()?.project_id || source?.context?.selected_project_id;
            if (projects.some(item => String(item.id) === String(selected))) projectId = String(selected);
            selectedInitialProject = true;
        }
        if (projectId && !project()) projectId = '';
        ui.project.replaceChildren(el('option', '', '全部项目'));
        ui.project.firstChild.value = '';
        projects.forEach(item => {
            const option = el('option', '', item.display_name || item.name || '未命名项目');
            option.value = item.id;
            ui.project.append(option);
        });
        ui.project.value = projectId;
        ui.manage.hidden = !projects.some(item => item.my_role === 'admin');
        ui.projectOwner.replaceChildren();
        const owner = avatar(project()?.owner);
        if (owner) ui.projectOwner.append(owner);
        projectsReady = true;
    }

    function updateControls() {
        const stale = snapshot !== key();
        const noProjects = projectsReady && projects.length === 0;
        ui.project.disabled = busy || noProjects;
        ui.search.disabled = busy || noProjects;
        ui.tabs.forEach(tab => {
            tab.disabled = busy || noProjects;
            tab.setAttribute('aria-pressed', String(tab.dataset.status === status));
        });
        ui.newButton.disabled = busy || loading || !projects.some(isCreatableProject);
        ui.refresh.disabled = busy || loading;
        const currentId = idOf(current());
        ui.close.hidden = !currentId;
        ui.close.disabled = busy || !currentId;
        ui.more.disabled = busy || loading || stale;
        ui.more.hidden = !cursor;
        ui.more.textContent = loading ? '正在加载…' : '加载更多';
        ui.list.setAttribute('aria-busy', String(loading));
        ui.list.querySelectorAll('button').forEach(node => { node.disabled = busy || loading || stale || phase === 'error'; });
        ui.list.querySelectorAll('summary').forEach(node => {
            node.setAttribute('aria-disabled', String(busy || loading || stale || phase === 'error'));
            node.tabIndex = busy || loading || stale || phase === 'error' ? -1 : 0;
        });
        const resume = status === 'active' && !stale && documents.find(doc => idOf(doc) === lastId && doc.status === 'active');
        ui.resume.hidden = !resume;
        ui.resume.disabled = busy || loading || phase === 'error';
        ui.resume.textContent = resume ? '继续上次：' + (resume.title || '未命名画布') : '';
        ui.message.textContent = loading ? '正在加载画布…' : stale && documents.length ? '下方保留上次列表，请重试加载当前筛选。' : '';
        renderState();
    }

    function renderState() {
        ui.state.hidden = documents.length > 0 && phase !== 'no-projects';
        ui.empty.hidden = true;
        ui.stateRetry.hidden = true;
        ui.stateNew.hidden = true;
        ui.state.setAttribute('aria-busy', String(loading));
        if (phase === 'initial' || loading) {
            ui.stateTitle.textContent = '正在加载画布';
            ui.stateDescription.textContent = '正在读取项目和画布列表…';
        } else if (phase === 'error') {
            ui.stateTitle.textContent = '暂时无法加载';
            ui.stateDescription.textContent = '读取失败不代表画布不存在。请重试。';
            ui.stateRetry.hidden = false;
        } else if (phase === 'no-projects') {
            ui.stateTitle.textContent = '暂无可访问项目';
            ui.stateDescription.textContent = '请联系管理员加入项目后刷新。';
            ui.stateRetry.hidden = false;
        } else if (!documents.length) {
            ui.stateTitle.textContent = query ? '没有匹配的画布' : status === 'archived' ? '暂无已归档画布' : '还没有画布';
            ui.stateDescription.textContent = query ? '换个名称搜索，或清空搜索条件。'
                : status === 'archived' ? '归档的画布会显示在这里。'
                    : projects.some(isCreatableProject) ? '在项目中新建第一张画布。' : '当前项目没有创建权限，请联系项目管理员。';
            ui.stateNew.hidden = Boolean(query) || status !== 'active' || !projects.some(isCreatableProject);
        }
        ui.stateRetry.disabled = busy || loading;
        ui.stateNew.disabled = busy || loading;
    }

    function dateLabel(value) {
        const date = new Date(value);
        return value && Number.isFinite(date.getTime())
            ? date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
            : '更新时间未知';
    }

    function renderList() {
        const focusedId = document.activeElement?.closest('[data-document-id]')?.dataset.documentId;
        ui.list.replaceChildren();
        documents.forEach(doc => {
            const row = el('li', 'uc-doc-row');
            row.dataset.documentId = idOf(doc);
            const open = button('', () => openDocument(doc), 'uc-doc-open');
            open.setAttribute('aria-label', (doc.status === 'archived' ? '已归档：' : '打开：') + (doc.title || '未命名画布'));
            const preview = el('span', 'uc-doc-preview');
            const placeholder = el('span', 'uc-doc-placeholder');
            const glyph = el('span', 'uc-doc-placeholder-icon', '▧');
            glyph.setAttribute('aria-hidden', 'true');
            placeholder.append(glyph, el('span', '', '暂无预览'));
            preview.append(placeholder);
            // Only the server-approved thumbnail is used. Never inspect document_json or node assets.
            const url = imageUrl(doc.thumbnail_url);
            if (url) {
                const img = el('img');
                img.alt = '';
                img.loading = 'lazy';
                img.referrerPolicy = 'no-referrer';
                img.addEventListener('load', () => { placeholder.hidden = true; }, { once: true });
                img.addEventListener('error', () => { img.remove(); placeholder.hidden = false; }, { once: true });
                img.src = url;
                preview.append(img);
            }
            const copy = el('span', 'uc-doc-copy');
            copy.append(el('strong', 'uc-doc-title', doc.title || '未命名画布'));
            const meta = el('span', 'uc-doc-meta');
            const owningProject = projects.find(item => String(item.id) === String(doc.project_id));
            meta.append(el('span', '', owningProject?.display_name || owningProject?.name || '项目不可用'));
            const owner = avatar(doc.owner || (doc.owner_name ? { name: doc.owner_name, avatar_url: doc.owner_avatar_url } : null));
            if (owner) meta.append(owner);
            const time = el('time', '', dateLabel(doc.updated_at));
            if (doc.updated_at && Number.isFinite(new Date(doc.updated_at).getTime())) time.dateTime = new Date(doc.updated_at).toISOString();
            meta.append(time);
            if (doc.status === 'archived') meta.append(el('span', 'uc-doc-archived', '已归档'));
            copy.append(meta);
            open.append(preview, copy);
            const details = el('details', 'uc-doc-actions');
            const summary = el('summary', '', '⋯');
            summary.title = '更多操作';
            summary.setAttribute('aria-label', '更多操作：' + (doc.title || '未命名画布'));
            summary.addEventListener('click', event => {
                if (busy || loading || snapshot !== key() || phase === 'error') { event.preventDefault(); return; }
                ui.list.querySelectorAll('details[open]').forEach(other => { if (other !== details) other.open = false; });
            });
            const menu = el('div', 'uc-doc-action-menu');
            (doc.status === 'archived' ? ['restore'] : ['rename', 'duplicate', 'history', 'archive']).forEach(action => {
                menu.append(button(action === 'history' ? '版本历史' : labels[action], () => {
                    details.open = false;
                    if (action === 'history') showHistory(doc, summary);
                    else if (action === 'rename' || action === 'archive') showDialog(action, doc, summary);
                    else mutate(action, doc);
                }, action === 'archive' ? 'uc-doc-danger' : 'uc-doc-menu-button'));
            });
            details.append(summary, menu);
            row.append(open, details);
            ui.list.append(row);
        });
        ui.empty.hidden = documents.length > 0 || loading || !ui.error.hidden;
        ui.empty.textContent = query ? '没有找到匹配的画布' : status === 'archived' ? '暂无已归档画布' : '暂无画布';
        ui.count.textContent = documents.length ? '已加载 ' + documents.length + ' 个画布' : '';
        if (focusedId) Array.from(ui.list.children).find(row => row.dataset.documentId === focusedId)?.querySelector('button')?.focus({ preventScroll: true });
        updateControls();
    }

    async function load(append) {
        if (!root || busy || (append && (loading || !cursor || snapshot !== key()))) return false;
        const token = ++sequence;
        const requestedKey = key();
        const nextCursor = append ? cursor : '';
        loading = true;
        phase = 'loading';
        clearError();
        ui.empty.hidden = true;
        updateControls();
        try {
            const params = new URLSearchParams({ list: '1', project_id: projectId, status, q: query, cursor: nextCursor || '' });
            const data = await options.requestJson(ENDPOINT + '?' + params.toString(), { cache: 'no-store' });
            if (token !== sequence) return false;
            if (!Array.isArray(data?.documents)) throw new Error('Invalid document list');
            const valid = data.documents.filter(doc => idOf(doc) && doc.status === status && (!projectId || String(doc.project_id) === projectId));
            const merged = new Map((append ? documents : []).map(doc => [idOf(doc), doc]));
            valid.forEach(doc => merged.set(idOf(doc), doc));
            documents = Array.from(merged.values());
            // Pagination order is owned by the server; sorting only the loaded subset would move rows between pages.
            cursor = typeof data.next_cursor === 'string' && data.next_cursor !== nextCursor ? data.next_cursor : null;
            snapshot = requestedKey;
            phase = 'ready';
            return true;
        } catch (error) {
            if (token === sequence) { phase = 'error'; fail(error, '加载画布', () => load(append)); }
            return false;
        } finally {
            if (token === sequence) { loading = false; renderList(); }
        }
    }

    async function refresh() {
        if (!root || busy) return false;
        clearTimeout(timer);
        query = ui.search.value.trim();
        try { syncProjects(); } catch (error) {
            ++sequence;
            loading = false;
            phase = 'error';
            fail(error, '读取项目', refresh);
            updateControls();
            return false;
        }
        if (!projects.length) {
            ++sequence;
            loading = false;
            phase = 'no-projects';
            documents = [];
            cursor = null;
            snapshot = '';
            clearError();
            renderList();
            return true;
        }
        return load(false);
    }

    async function leave() {
        if ((await options.beforeLeave()) !== false) return true;
        const message = '当前画布尚未保存，未执行此操作。请先处理保存提示。';
        if (dialog.open) { ui.dialogError.textContent = message; ui.dialogError.hidden = false; }
        else { ui.errorText.textContent = message; ui.error.hidden = false; ui.retry.hidden = true; }
        return false;
    }

    function remember(doc) {
        lastId = idOf(doc);
        try { window.sessionStorage.setItem(LAST_KEY, lastId); } catch { /* Storage is optional. */ }
    }

    async function openDocument(doc, returning) {
        if (busy || (!returning && (loading || snapshot !== key() || phase === 'error'))) return false;
        if (!idOf(doc)) return false;
        if (doc.status && doc.status !== 'active') { announce('请先恢复画布，再打开编辑。'); return false; }
        busy = true;
        clearTimeout(timer);
        ++sequence;
        if (loading) phase = snapshot === key() ? 'ready' : 'error';
        loading = false;
        clearError();
        updateControls();
        try {
            if (!await leave()) return;
            if ((await options.openDocument(doc)) === false) throw new Error('Open declined');
            if (idOf(current()) !== idOf(doc)) throw new Error('Document not loaded');
            remember(doc);
            busy = false;
            closeAfterOpen();
            return true;
        } catch (error) { fail(error, '打开画布'); }
        finally { busy = false; updateControls(); }
    }

    function returnToEditor() {
        const doc = current();
        // The current editor may be outside the selected project, search or archive tab.
        // Reopen through the parent to revalidate access and restore writable state.
        if (idOf(doc)) return openDocument(doc, true);
        return false;
    }

    function mutationId() {
        if (window.crypto?.randomUUID) return window.crypto.randomUUID();
        const bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }

    async function mutate(action, doc, title, job) {
        if (busy || loading || snapshot !== key() || phase === 'error') return false;
        busy = true;
        clearTimeout(timer);
        ++sequence;
        loading = false;
        clearError();
        updateControls();
        setDialogBusy(true);
        const attemptKey = JSON.stringify([idOf(doc), action, title, job?.targetRevision]);
        try {
            if (!Number.isInteger(doc.revision) || doc.revision < 0) throw new Error('Missing revision');
            const beforeRevision = current()?.revision;
            if (!await leave()) return false;
            const latest = current();
            if (idOf(latest) === idOf(doc) && Number.isInteger(latest.revision) && latest.revision !== beforeRevision) {
                doc = { ...doc, revision: latest.revision };
                if (job) job.doc = doc;
            }
            let payload = pendingMutations.get(attemptKey);
            if (!payload) {
                payload = { document_id: idOf(doc), action, base_revision: doc.revision, mutation_id: job?.mutationId || mutationId(), protocol_version: 2 };
                if (title !== undefined) payload.title = title;
                if (action === 'restore_revision') payload.target_revision = job.targetRevision;
                pendingMutations.set(attemptKey, payload);
            }
            const result = await options.requestJson(ENDPOINT, { method: 'PATCH', payload });
            if (result?.success === false || result?.error) throw new Error('Mutation rejected');
            pendingMutations.delete(attemptKey);
            if (dialog.open) dialog.close();
            busy = false;
            await load(false);
            announce(labels[action] + '成功');
            return true;
        } catch (error) {
            if (definitelyRejected(error)) {
                pendingMutations.delete(attemptKey);
                if (job) job.mutationId = null;
            }
            if (dialog.open) {
                ui.dialogError.textContent = errorMessage(error, labels[action]);
                ui.dialogError.hidden = false;
            } else fail(error, labels[action]);
            return false;
        } finally { busy = false; updateControls(); setDialogBusy(false); }
    }

    function setDialogBusy(value) {
        dialog.querySelectorAll('button, input, select').forEach(node => { node.disabled = value; });
        ui.submit.textContent = value ? '正在处理…' : dialogJob?.action === 'new' ? '创建画布' : labels[dialogJob?.action] || '确定';
        dialog.setAttribute('aria-busy', String(value));
    }

    function showPendingCreate(job) {
        if (!job.createRequest) return;
        ui.titleInput.disabled = true;
        ui.dialogProject.disabled = true;
        ui.submit.textContent = job.created ? '重新打开' : '重试创建';
        ui.dialogDescription.hidden = false;
        ui.dialogDescription.textContent = job.created
            ? '画布已创建，尚未打开。重试只会重新打开这张画布。'
            : '上次创建结果尚未确认，重试将沿用原项目、名称和请求，不会另发新建请求。';
    }

    function showDialog(action, doc, trigger) {
        if (busy || loading || dialog.open) return;
        dialogJob = action === 'new' && pendingCreate ? pendingCreate : { action, doc, trigger: trigger || document.activeElement, mutationId: null, title: null, created: null };
        if (action === 'new') pendingCreate = dialogJob;
        ui.history.hidden = true;
        ui.historyBack.hidden = true;
        ui.historyRetry.hidden = true;
        ui.submit.hidden = false;
        ui.dialogTitle.textContent = action === 'new' ? '新建画布' : action === 'archive' ? '归档画布' : '重命名';
        ui.dialogError.hidden = true;
        ui.titleLabel.hidden = action === 'archive';
        ui.titleInput.required = action !== 'archive';
        ui.titleInput.value = action === 'rename' ? doc.title || '' : dialogJob.createRequest?.title || '';
        ui.dialogProjectLabel.hidden = action !== 'new';
        ui.dialogProject.replaceChildren();
        projects.filter(isCreatableProject).forEach(item => {
            const option = el('option', '', item.display_name || item.name || '未命名项目');
            option.value = item.id;
            ui.dialogProject.append(option);
        });
        if (canCreate()) ui.dialogProject.value = projectId;
        if (dialogJob.createRequest) ui.dialogProject.value = dialogJob.createRequest.projectId;
        ui.dialogDescription.hidden = action !== 'archive';
        ui.dialogDescription.textContent = action === 'archive' ? '归档“' + (doc.title || '未命名画布') + '”？归档后不再显示在使用中列表，可在已归档中恢复。' : '';
        setDialogBusy(false);
        showPendingCreate(dialogJob);
        dialog.showModal();
        (action === 'archive' ? ui.cancel : ui.titleInput.disabled ? ui.submit : ui.titleInput).focus();
        if (action === 'rename') ui.titleInput.select();
    }

    function renderHistory() {
        dialogJob.action = 'history';
        ui.dialogTitle.textContent = '版本历史';
        ui.dialogDescription.hidden = false;
        ui.dialogDescription.textContent = historyState.doc.title || '未命名画布';
        ui.titleLabel.hidden = true;
        ui.titleInput.required = false;
        ui.dialogProjectLabel.hidden = true;
        ui.history.hidden = false;
        ui.historyBack.hidden = true;
        ui.historyRetry.hidden = true;
        ui.submit.hidden = true;
        ui.dialogError.hidden = true;
        ui.history.replaceChildren();
        if (!historyState.revisions.length) {
            ui.history.append(el('p', '', historyState.loading ? '正在读取版本…' : '暂无历史版本'));
            return;
        }
        const list = el('ol', 'uc-doc-history-list');
        historyState.revisions.forEach(revision => {
            const row = el('li', 'uc-doc-history-row');
            const detail = el('div');
            detail.append(el('strong', '', '版本 ' + revision.revision), el('p', '', revision.title || '未命名画布'), el('time', '', dateLabel(revision.created_at)));
            row.append(detail);
            if (revision.revision === historyState.doc.revision) row.append(el('span', 'uc-doc-count', '当前版本'));
            else row.append(button('恢复', () => {
                dialogJob.action = 'restore_revision';
                dialogJob.targetRevision = revision.revision;
                dialogJob.mutationId = null;
                ui.history.hidden = true;
                ui.historyBack.hidden = false;
                ui.submit.hidden = false;
                ui.dialogTitle.textContent = '恢复版本';
                ui.dialogDescription.textContent = '恢复到版本 ' + revision.revision + '（' + dateLabel(revision.created_at) + '）？当前画布内容将被此版本替换。';
                setDialogBusy(false);
                ui.cancel.focus();
            }));
            list.append(row);
        });
        ui.history.append(list);
    }

    async function loadHistory() {
        const state = historyState;
        const token = ++historySequence;
        state.loading = true;
        renderHistory();
        ui.history.setAttribute('aria-busy', 'true');
        try {
            const params = new URLSearchParams({ history: '1', document_id: idOf(state.doc) });
            const data = await options.requestJson(ENDPOINT + '?' + params.toString(), { cache: 'no-store' });
            if (token !== historySequence || !dialog.open) return;
            if (!Array.isArray(data?.revisions)) throw new Error('Invalid revision list');
            state.revisions = data.revisions.filter(item => Number.isInteger(item.revision) && item.revision >= 0)
                .sort((a, b) => b.revision - a.revision).slice(0, 20);
            state.loading = false;
            renderHistory();
        } catch (error) {
            if (token !== historySequence || !dialog.open) return;
            ui.history.replaceChildren();
            ui.dialogError.textContent = errorMessage(error, '读取版本历史');
            ui.dialogError.hidden = false;
            ui.historyRetry.hidden = false;
        } finally {
            if (token === historySequence) { state.loading = false; ui.history.setAttribute('aria-busy', 'false'); }
        }
    }

    function showHistory(doc, trigger) {
        if (busy || loading || dialog.open) return;
        dialogJob = { action: 'history', doc, trigger, mutationId: null };
        historyState = { doc, revisions: [], loading: true };
        setDialogBusy(false);
        renderHistory();
        dialog.showModal();
        ui.cancel.focus();
        void loadHistory();
    }

    async function submitDialog(event) {
        event.preventDefault();
        if (busy || !dialogJob || dialogJob.action === 'history') return;
        const job = dialogJob;
        const title = ui.titleInput.value.trim();
        if (['new', 'rename'].includes(job.action) && !title) {
            ui.dialogError.textContent = '请输入画布名称。';
            ui.dialogError.hidden = false;
            ui.titleInput.focus();
            return;
        }
        ui.dialogError.hidden = true;
        if (job.action !== 'new') {
            if (!job.mutationId || job.title !== title) { job.mutationId = mutationId(); job.title = title; }
            await mutate(job.action, job.doc, job.action === 'rename' ? title : undefined, job);
            return;
        }
        const selected = ui.dialogProject.value;
        if (!projects.some(item => String(item.id) === selected && isCreatableProject(item))) {
            ui.dialogError.textContent = '请选择可创建画布的项目。';
            ui.dialogError.hidden = false;
            return;
        }
        busy = true;
        updateControls();
        setDialogBusy(true);
        try {
            if (!await leave()) return;
            // An uncertain create keeps its exact inputs and mutation ID on every retry.
            if (!job.createRequest) job.createRequest = { projectId: selected, title, mutation_id: mutationId(), protocol_version: 2, base_revision: 0 };
            if (!job.created) {
                const request = job.createRequest;
                const result = await options.createDocument(request.projectId, request.title, {
                    mutation_id: request.mutation_id, protocol_version: request.protocol_version, base_revision: request.base_revision
                });
                job.created = result?.document || result;
                if (!idOf(job.created)) { job.created = null; throw new Error('Missing created document'); }
            }
            if ((await options.openDocument(job.created)) === false) throw new Error('Open declined');
            if (idOf(current()) !== idOf(job.created)) throw new Error('Document not loaded');
            remember(job.created);
            pendingCreate = null;
            dialog.close();
            busy = false;
            closeAfterOpen();
            announce('画布已创建');
        } catch (error) {
            // Keep creation immutable even for an HTTP error: legacy callbacks may fail
            // while opening an already-created document. Never turn that into a fresh POST.
            ui.dialogError.textContent = errorMessage(error, job.created ? '打开新画布' : '创建画布');
            ui.dialogError.hidden = false;
        } finally {
            busy = false;
            updateControls();
            setDialogBusy(false);
            showPendingCreate(job);
        }
    }

    function mount(config) {
        ['requestJson', 'getProjects', 'getCurrentDocument', 'openDocument', 'createDocument', 'beforeLeave'].forEach(name => {
            if (typeof config?.[name] !== 'function') throw new TypeError('UltimateCanvasDocuments requires ' + name);
        });
        if (root) return root;
        options = config;
        try { lastId = window.sessionStorage.getItem(LAST_KEY) || ''; } catch { /* Storage is optional. */ }
        root = el('section', 'uc-doc-library');
        root.id = 'ultimate-canvas-documents';
        root.hidden = true;
        root.setAttribute('aria-label', '项目与画布');
        root.tabIndex = -1;
        const heading = el('div', 'uc-doc-heading');
        const title = el('h1', '', '项目与画布');
        const actions = el('div', 'uc-doc-heading-actions');
        ui = {};
        ui.close = button('×', returnToEditor, 'uc-doc-button uc-doc-icon-button');
        ui.close.title = '返回画布';
        ui.close.setAttribute('aria-label', '返回画布');
        ui.newButton = button('新建画布', () => showDialog('new'), 'uc-doc-button uc-doc-primary');
        ui.manage = el('a', 'uc-doc-project-link', '项目管理');
        ui.manage.href = '/projects';
        ui.manage.target = '_top';
        ui.manage.hidden = true;
        ui.manage.addEventListener('click', async event => {
            event.preventDefault();
            if (busy) return;
            busy = true;
            updateControls();
            try { if (await leave()) window.top.location.href = ui.manage.href; }
            catch (error) { fail(error, '离开画布'); }
            finally { busy = false; updateControls(); }
        });
        actions.append(ui.manage, ui.newButton, ui.close);
        heading.append(title, actions);
        const filters = el('div', 'uc-doc-filters');
        const projectLabel = el('label', 'uc-doc-field');
        ui.project = el('select');
        projectLabel.append(el('span', '', '项目'), ui.project);
        ui.project.addEventListener('change', () => { projectId = ui.project.value; refresh(); });
        const searchLabel = el('label', 'uc-doc-field uc-doc-search');
        ui.search = el('input');
        ui.search.type = 'search';
        ui.search.placeholder = '搜索画布';
        ui.search.maxLength = 120;
        searchLabel.append(el('span', 'uc-doc-sr-only', '搜索画布'), ui.search);
        ui.search.addEventListener('input', () => {
            clearTimeout(timer);
            query = ui.search.value.trim();
            ++sequence;
            loading = false;
            updateControls();
            timer = setTimeout(() => load(false), 300);
        });
        ui.refresh = button('↻', refresh, 'uc-doc-button uc-doc-icon-button');
        ui.refresh.title = '刷新列表';
        ui.refresh.setAttribute('aria-label', '刷新列表');
        ui.projectOwner = el('div', 'uc-doc-project-owner');
        filters.append(projectLabel, searchLabel, ui.refresh, ui.projectOwner);
        const subbar = el('div', 'uc-doc-subbar');
        const tabs = el('div', 'uc-doc-tabs');
        tabs.setAttribute('role', 'group');
        tabs.setAttribute('aria-label', '画布状态');
        ui.tabs = ['active', 'archived'].map(value => {
            const tab = button(value === 'active' ? '使用中' : '已归档', () => { status = value; refresh(); }, 'uc-doc-tab');
            tab.dataset.status = value;
            tabs.append(tab);
            return tab;
        });
        subbar.append(tabs, el('span', 'uc-doc-sort', '最近更新优先'));
        ui.resume = button('', () => {
            const doc = documents.find(item => idOf(item) === lastId && item.status === 'active');
            if (doc) openDocument(doc);
        }, 'uc-doc-resume');
        ui.resume.hidden = true;
        ui.error = el('div', 'uc-doc-error');
        ui.error.hidden = true;
        ui.error.setAttribute('role', 'alert');
        ui.errorText = el('span');
        ui.retry = button('重试', () => { if (retryList) retryList(); });
        ui.error.append(ui.errorText, ui.retry);
        ui.message = el('p', 'uc-doc-message');
        ui.message.setAttribute('role', 'status');
        ui.list = el('ul', 'uc-doc-list');
        ui.list.setAttribute('aria-label', '画布列表');
        ui.empty = el('p', 'uc-doc-empty');
        ui.state = el('div', 'uc-doc-state');
        ui.state.setAttribute('role', 'status');
        ui.stateTitle = el('h2');
        ui.stateDescription = el('p');
        ui.stateRetry = button('重新加载', refresh);
        ui.stateNew = button('新建画布', () => showDialog('new'), 'uc-doc-button uc-doc-primary');
        ui.state.append(ui.stateTitle, ui.stateDescription, ui.stateRetry, ui.stateNew);
        ui.more = button('加载更多', () => load(true));
        ui.more.hidden = true;
        ui.count = el('span', 'uc-doc-count');
        const footer = el('div', 'uc-doc-footer');
        footer.append(ui.count, ui.more);
        root.append(heading, filters, subbar, ui.resume, ui.error, ui.message, ui.list, ui.state, ui.empty, footer);
        dialog = el('dialog', 'uc-doc-dialog');
        dialog.setAttribute('aria-labelledby', 'uc-doc-dialog-title');
        dialog.setAttribute('aria-describedby', 'uc-doc-dialog-description');
        const form = el('form');
        ui.dialogTitle = el('h2');
        ui.dialogTitle.id = 'uc-doc-dialog-title';
        ui.dialogDescription = el('p');
        ui.dialogDescription.id = 'uc-doc-dialog-description';
        ui.titleLabel = el('label', 'uc-doc-field');
        ui.titleInput = el('input');
        ui.titleInput.maxLength = 120;
        ui.titleInput.autocomplete = 'off';
        ui.titleLabel.append(el('span', '', '画布名称'), ui.titleInput);
        ui.dialogProjectLabel = el('label', 'uc-doc-field');
        ui.dialogProject = el('select');
        ui.dialogProjectLabel.append(el('span', '', '所属项目'), ui.dialogProject);
        ui.dialogError = el('p', 'uc-doc-error');
        ui.dialogError.setAttribute('role', 'alert');
        ui.history = el('div', 'uc-doc-history');
        ui.history.hidden = true;
        ui.historyRetry = button('重新读取版本', loadHistory);
        ui.historyRetry.hidden = true;
        ui.historyBack = button('返回历史', () => { if (!busy) renderHistory(); });
        ui.historyBack.hidden = true;
        const dialogActions = el('div', 'uc-doc-dialog-actions');
        ui.cancel = button('取消', () => { if (!busy) dialog.close(); });
        ui.submit = el('button', 'uc-doc-button uc-doc-primary', '确定');
        ui.submit.type = 'submit';
        dialogActions.append(ui.historyBack, ui.cancel, ui.submit);
        form.append(ui.dialogTitle, ui.dialogDescription, ui.dialogProjectLabel, ui.titleLabel, ui.history, ui.dialogError, ui.historyRetry, dialogActions);
        form.addEventListener('submit', submitDialog);
        dialog.append(form);
        dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
        dialog.addEventListener('close', () => {
            ++historySequence;
            if (root.hidden) return;
            if (dialogJob?.trigger?.isConnected) dialogJob.trigger.focus({ preventScroll: true });
            else root.focus({ preventScroll: true });
        });
        root.append(dialog);
        // Keep the editor's document-level shortcuts from handling library input.
        ['keydown', 'keyup', 'keypress', 'paste', 'wheel', 'pointerdown', 'pointerup', 'click'].forEach(type => {
            root.addEventListener(type, event => {
                if (type === 'keydown' && event.key === 'Escape' && !dialog.open) {
                    event.preventDefault();
                    const menu = root.querySelector('details[open]');
                    if (menu) { menu.open = false; menu.querySelector('summary').focus(); }
                    else returnToEditor();
                }
                event.stopPropagation();
            });
        });
        root.addEventListener('click', event => {
            if (!event.target.closest('details')) root.querySelectorAll('details[open]').forEach(item => { item.open = false; });
        });
        document.body.append(root);
        updateControls();
        if (!new URLSearchParams(window.location.search).get('document_id')) void show();
        return root;
    }

    async function show() {
        if (!root) throw new Error('Mount UltimateCanvasDocuments first');
        if (root.hidden) previousFocus = document.activeElement;
        root.hidden = false;
        document.body.classList.add('canvas-library-open');
        const canvas = document.getElementById('canvas-container');
        if (canvas && !backgroundInert.has(canvas)) {
            backgroundInert.set(canvas, canvas.inert);
            canvas.inert = true;
        }
        if (!lastId) lastId = idOf(current());
        root.focus({ preventScroll: true });
        return refresh();
    }

    function hide() {
        if (!root || root.hidden || busy) return false;
        // Parent-only completion hook after openManagedDocument succeeds. User close/Escape
        // always takes returnToEditor, which reopens and restores writable state first.
        return closeAfterOpen();
    }

    function closeAfterOpen() {
        const loaded = current();
        if (!idOf(loaded) || !loaded.project_id || !Number.isInteger(loaded.revision)) return false;
        if (dialog.open) dialog.close();
        clearTimeout(timer);
        ++sequence;
        loading = false;
        root.hidden = true;
        document.body.classList.remove('canvas-library-open');
        backgroundInert.forEach((value, node) => { node.inert = value; });
        backgroundInert.clear();
        if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
        return true;
    }

    window.UltimateCanvasDocuments = { mount, show, hide, refresh };
}());
