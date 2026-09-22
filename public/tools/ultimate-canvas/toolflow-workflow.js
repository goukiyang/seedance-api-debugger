(function () {
    'use strict';

    const state = {
        flows: [],
        presets: [],
        selectedFlowId: '',
        run: null,
        loading: false,
        pollTimer: null,
        bound: false,
    };

    const RUN_LABELS = {
        queued: '排队中', running: '执行中', waiting_selection: '等待筛选', waiting_confirmation: '等待确认',
        paused: '已暂停', succeeded: '已完成', partial_success: '部分完成', failed: '失败', cancelled: '已取消',
    };

    function runtime() { return window.UltimateCanvasRuntime || {}; }
    function engine() { return window.canvasEngine; }
    function panel() { return document.getElementById('toolflow-panel'); }
    function notice(message, tone) { window.showCanvasNotice?.(message, tone || 'info'); }
    function projectId() { return runtime().selectedProjectId || null; }
    function json(value) { return JSON.stringify(value); }
    function escapeHtml(value) { const div = document.createElement('div'); div.textContent = String(value ?? ''); return div.innerHTML; }
    function parseIds(value) { return [...new Set(String(value || '').split(',').map(item => item.trim()).filter(Boolean))].slice(0, 30); }
    function parseJson(value, fallback = {}) { try { const next = JSON.parse(value || ''); return next && typeof next === 'object' ? next : fallback; } catch { return fallback; } }
    function currentNode() { const selected = engine()?.selectedNodeId; return selected ? engine().nodes.get(selected) : null; }
    function currentFlow() { return state.flows.find(item => item.id === state.selectedFlowId) || null; }

    async function request(url, options = {}) {
        const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || body.message || '工具流请求失败');
        return body;
    }

    function setState(text, tone = 'info') {
        const element = panel()?.querySelector('[data-toolflow-state]');
        if (!element) return;
        element.textContent = text;
        element.dataset.tone = tone;
    }

    function flowGraph() {
        const snapshot = engine()?.serialize?.() || { nodes: [], connections: [] };
        const nodes = snapshot.nodes.filter(node => String(node.type || '').startsWith('flow-')).map(node => ({
            id: node.id, type: node.type, x: node.x, y: node.y, data: { ...(node.data || {}), flowNode: true },
        }));
        const ids = new Set(nodes.map(node => node.id));
        return { version: 1, nodes, connections: snapshot.connections.filter(edge => ids.has(edge.from) && ids.has(edge.to)) };
    }

    function setRun(run) {
        state.run = run || null;
        try {
            if (run?.id) localStorage.setItem('ultimate-canvas:toolflow-run', run.id);
            else localStorage.removeItem('ultimate-canvas:toolflow-run');
        } catch { /* localStorage is an optional refresh hint only. */ }
        renderRun(run);
    }

    function selectFlow(id) {
        state.selectedFlowId = id || '';
        const select = panel()?.querySelector('[data-toolflow-select]');
        if (select) select.value = state.selectedFlowId;
        const flow = currentFlow();
        const visibility = panel()?.querySelector('[data-toolflow-visibility]');
        if (visibility) visibility.value = flow?.visibility || 'private';
        renderList();
    }

    function renderList() {
        const root = panel()?.querySelector('[data-toolflow-list]');
        const select = panel()?.querySelector('[data-toolflow-select]');
        if (!root || !select) return;
        select.innerHTML = '<option value="">未选择</option>' + state.flows.map(flow => `<option value="${escapeHtml(flow.id)}">${escapeHtml(flow.name)} · v${flow.version}</option>`).join('');
        select.value = state.selectedFlowId;
        root.innerHTML = state.flows.length ? state.flows.map(flow => `
            <button type="button" class="toolflow-list-item ${flow.id === state.selectedFlowId ? 'is-active' : ''}" data-toolflow-pick="${escapeHtml(flow.id)}">
                <strong>${escapeHtml(flow.name)}</strong><span>v${flow.version} · ${flow.visibility === 'private' ? '仅自己' : flow.visibility === 'shared' ? '项目成员' : '公开'}</span>
            </button>`).join('') : '<div class="empty-state"><strong>还没有工具流</strong><span>先添加工具流节点，再点击保存。</span></div>';
    }

    async function loadPresets() {
        try {
            const result = await request('/api/image-studio/presets');
            state.presets = result.presets || [];
            renderNodeSettings();
        } catch { state.presets = []; }
    }

    async function loadFlows() {
        if (state.loading) return;
        state.loading = true;
        try {
            const query = projectId() ? `?project_id=${encodeURIComponent(projectId())}` : '';
            const result = await request(`/api/tools/ultimate-canvas/flows${query}`);
            state.flows = result.flows || [];
            if (!state.flows.some(flow => flow.id === state.selectedFlowId)) state.selectedFlowId = state.flows[0]?.id || '';
            selectFlow(state.selectedFlowId);
        } catch (error) { setState(error.message, 'error'); }
        finally { state.loading = false; }
    }

    function renderNodeSettings() {
        const root = panel()?.querySelector('[data-toolflow-node-settings]');
        const node = currentNode();
        if (!root) return;
        if (!node || node.type !== 'flow-template') {
            root.innerHTML = '<span>选中图片模板节点后可选择授权模板。</span>';
            return;
        }
        const selected = node.data?.templateId || node.data?.template_id || '';
        root.innerHTML = `<span>图片模板节点：${escapeHtml(node.id)}</span>
            <select data-toolflow-template-select><option value="">使用当前节点提示词</option>${state.presets.map(preset => `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.name)}${preset.scope === 'admin' ? ' · 管理员模板' : ''}</option>`).join('')}</select>`;
        const select = root.querySelector('[data-toolflow-template-select]');
        if (select) select.value = selected;
    }

    async function saveFlow() {
        const current = currentFlow();
        const name = current?.name || window.prompt('工具流名称', '我的图片工具流');
        if (!name) return;
        try {
            const result = await request('/api/tools/ultimate-canvas/flows', { method: 'POST', body: json({
                id: state.selectedFlowId || undefined,
                name,
                project_id: projectId(),
                graph: flowGraph(),
                visibility: panel()?.querySelector('[data-toolflow-visibility]')?.value || 'private',
            }) });
            state.selectedFlowId = result.flow.id;
            await loadFlows();
            selectFlow(state.selectedFlowId);
            setState(`已保存 · v${result.flow.version}`, 'success');
        } catch (error) { setState(error.message, 'error'); notice(error.message, 'error'); }
    }

    function nodeRun(run, status) { return (run?.node_runs || []).find(node => node.status === status); }
    function allActive(run) { return run && ['queued', 'running', 'waiting_selection', 'waiting_confirmation', 'paused'].includes(run.status); }

    function renderRun(run) {
        const approval = panel()?.querySelector('[data-toolflow-approval]');
        const nodeResults = panel()?.querySelector('[data-toolflow-node-results]');
        if (!run) {
            if (approval) approval.hidden = true;
            if (nodeResults) nodeResults.innerHTML = '';
            setState('尚未运行');
            return;
        }
        const tone = ['succeeded'].includes(run.status) ? 'success' : ['failed', 'cancelled'].includes(run.status) ? 'error' : ['waiting_selection', 'waiting_confirmation', 'paused'].includes(run.status) ? 'waiting' : 'running';
        setState(`${RUN_LABELS[run.status] || run.status}${run.flow_version ? ` · v${run.flow_version}` : ''}`, tone);
        if (nodeResults) {
            const retryable = (run.node_runs || []).filter(node => {
                const result = parseJson(node.result_json);
                return ['failed', 'succeeded'].includes(node.status) && (node.status === 'failed' || (result.failedTaskIds || []).length);
            });
            nodeResults.innerHTML = retryable.length
                ? retryable.map(node => `<div class="toolflow-node-result"><span>节点 ${escapeHtml(node.node_id)} 有失败图片</span><button type="button" class="context-command" data-toolflow-retry="${escapeHtml(node.node_id)}">重试</button></div>`).join('')
                : '';
        }
        const waiting = run.node_runs?.find(node => node.status === 'waiting_selection' || node.status === 'waiting_confirmation');
        if (!approval || !waiting) { if (approval) approval.hidden = true; return; }
        const result = parseJson(waiting.result_json);
        const candidates = result.candidateAssetIds || parseJsonArray(waiting.input_asset_ids);
        approval.hidden = false;
        approval.querySelector('[data-toolflow-approval-title]').textContent = waiting.status === 'waiting_selection' ? '请选择继续结果' : '流程需要人工确认';
        approval.querySelector('[data-toolflow-approval-detail]').innerHTML = waiting.status === 'waiting_selection'
            ? `<div class="toolflow-selection-list">${candidates.map((id, index) => `<label><input type="checkbox" data-toolflow-result value="${escapeHtml(id)}" checked><span>结果 ${index + 1}</span><code>${escapeHtml(id)}</code></label>`).join('')}</div>`
            : '上游节点已完成，确认后才会执行后续节点。';
        approval.dataset.nodeId = waiting.node_id;
    }

    function parseJsonArray(value) { try { const next = JSON.parse(value || '[]'); return Array.isArray(next) ? next : []; } catch { return []; } }

    async function refreshRun() {
        if (!state.run?.id) return;
        try {
            const result = await request(`/api/tools/ultimate-canvas/flows/runs/${encodeURIComponent(state.run.id)}`);
            setRun(result.run);
            if (allActive(result.run)) schedulePoll();
            else if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; }
        } catch (error) { setState(error.message, 'error'); }
    }

    function schedulePoll() {
        if (state.pollTimer) return;
        state.pollTimer = setTimeout(() => { state.pollTimer = null; refreshRun(); }, 2500);
    }

    async function restoreRun() {
        let runId = '';
        try { runId = localStorage.getItem('ultimate-canvas:toolflow-run') || ''; } catch { /* optional */ }
        if (runId) {
            try { const result = await request(`/api/tools/ultimate-canvas/flows/runs/${encodeURIComponent(runId)}`); setRun(result.run); if (allActive(result.run)) schedulePoll(); return; } catch { /* stale local hint */ }
        }
        try {
            const result = await request('/api/tools/ultimate-canvas/flows/runs');
            const active = (result.runs || []).find(run => allActive(run));
            if (active) { setRun(active); schedulePoll(); }
        } catch { /* the canvas itself remains usable when there is no run */ }
    }

    async function runFlow() {
        if (state.run && allActive(state.run)) { notice('已有工具流正在运行，请等待、暂停或取消。', 'warn'); return; }
        const flow = currentFlow();
        if (!flow) { notice('请先保存并选择工具流。', 'warn'); return; }
        try {
            const inputIds = parseIds(panel()?.querySelector('[data-toolflow-input-assets]')?.value);
            const result = await request(`/api/tools/ultimate-canvas/flows/${encodeURIComponent(flow.id)}/runs`, { method: 'POST', body: json({ input_asset_ids: inputIds }) });
            setRun(result.run);
            setState('已进入现有图片任务队列', 'running');
            schedulePoll();
        } catch (error) { setState(`执行失败：${error.message}`, 'error'); notice(error.message, 'error'); }
    }

    async function updateRun(action, extra = {}) {
        if (!state.run?.id) return;
        try { const result = await request(`/api/tools/ultimate-canvas/flows/runs/${encodeURIComponent(state.run.id)}`, { method: 'PATCH', body: json({ action, ...extra }) }); setRun(result.run); if (allActive(result.run)) schedulePoll(); }
        catch (error) { notice(error.message, 'error'); setState(error.message, 'error'); }
    }

    function addFlowNodeDefaults(node) {
        if (!node?.type?.startsWith('flow-')) return;
        node.data = { ...(node.data || {}) };
        if (node.type === 'flow-template') Object.assign(node.data, { title: node.data.title || '图片模板', prompt: node.data.prompt || '', count: node.data.count || 1, ratio: node.data.ratio || 'auto', size: node.data.size || '2K' });
        if (node.type === 'flow-input') node.data.title = node.data.title || '输入图片';
        if (node.type === 'flow-select') node.data.title = node.data.title || '筛选结果';
        if (node.type === 'flow-confirm') node.data.title = node.data.title || '人工确认';
        if (node.type === 'flow-output') node.data.title = node.data.title || '最终输出';
    }

    function bind() {
        if (state.bound || !panel()) return;
        state.bound = true;
        const root = panel();
        const oldSelected = engine()?.onNodeSelected;
        if (engine()) engine().onNodeSelected = (id, node) => { oldSelected?.(id, node); renderNodeSettings(); };
        root.addEventListener('click', event => {
            const pick = event.target.closest('[data-toolflow-pick]');
            if (pick) selectFlow(pick.dataset.toolflowPick);
            if (event.target.closest('[data-toolflow-new]')) { state.selectedFlowId = ''; selectFlow(''); setState('请在画布添加工具流节点后保存。'); }
            if (event.target.closest('[data-toolflow-save]')) saveFlow();
            if (event.target.closest('[data-toolflow-run]')) runFlow();
            if (event.target.closest('[data-toolflow-approve]')) {
                const approval = root.querySelector('[data-toolflow-approval]');
                const ids = [...root.querySelectorAll('[data-toolflow-result]:checked')].map(input => input.value);
                updateRun('decision', { node_id: approval?.dataset.nodeId, selected_asset_ids: ids, confirmed: true });
            }
            if (event.target.closest('[data-toolflow-cancel]')) updateRun('cancel');
            if (event.target.closest('[data-toolflow-pause]')) updateRun('pause');
            if (event.target.closest('[data-toolflow-resume]')) updateRun('resume');
            const retry = event.target.closest('[data-toolflow-retry]');
            if (retry) updateRun('retry', { node_id: retry.dataset.toolflowRetry });
        });
        root.querySelector('[data-toolflow-select]')?.addEventListener('change', event => selectFlow(event.target.value));
        root.querySelector('[data-toolflow-node-settings]')?.addEventListener('change', event => {
            if (!event.target.matches('[data-toolflow-template-select]')) return;
            const node = currentNode();
            if (!node) return;
            node.data = { ...(node.data || {}), templateId: event.target.value || undefined, template_id: event.target.value || undefined };
            runtime().markChanged?.('toolflow_template_change');
            renderNodeSettings();
        });
        document.addEventListener('input', event => {
            const prompt = event.target.closest('[data-toolflow-node-prompt]');
            if (!prompt) return;
            const node = engine()?.nodes.get(prompt.dataset.toolflowNodePrompt);
            if (node) { node.data = { ...(node.data || {}), prompt: prompt.value }; runtime().markChanged?.('toolflow_prompt_change'); }
        });
        const originalAdd = engine()?.addNode?.bind(engine());
        if (engine() && originalAdd) engine().addNode = (...args) => { const id = originalAdd(...args); addFlowNodeDefaults(engine().nodes.get(id)); renderNodeSettings(); return id; };
        loadFlows(); loadPresets(); restoreRun();
        window.setTimeout(loadFlows, 900);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
})();
