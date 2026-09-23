(function () {
    'use strict';

    const state = {
        flows: [],
        presets: [],
        studioSettings: { model: 'gpt-image-2', revision: 0, providerReady: false, prices: {} },
        selectedFlowId: '',
        run: null,
        mode: 'guided',
        guidedSteps: [],
        guidedAssets: [],
        selectedInputAssetIds: [],
        templatePickerStepId: '',
        templateSearch: '',
        loading: false,
        inputUploads: new Map(),
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
    function guidedRoot() { return panel()?.querySelector('[data-toolflow-guided]'); }
    function assetPreview(item) { return item?.thumbnailUrl || item?.previewUrl || item?.downloadUrl || ''; }
    function presetPreview(preset) { return preset?.banner?.thumbnailUrl || preset?.images?.[0]?.thumbnailUrl || ''; }
    function presetLabel(preset) {
        return [preset?.model, preset?.aspectRatio || '自动比例', `${preset?.count || 1} 张`].filter(Boolean).join(' · ');
    }
    function templateSource(item) { return item?.source === 'module' ? 'module' : 'preset'; }
    function templateOptionValue(item) { return `${templateSource(item)}:${item.id}`; }
    function selectedTemplate(step) {
        if (!step) return null;
        return state.presets.find(item => templateSource(item) === 'preset' && item.id === step.templateId)
            || state.presets.find(item => templateSource(item) === 'module' && item.id === step.moduleId)
            || null;
    }
    function templateBinding(item) {
        return templateSource(item) === 'module'
            ? { templateId: '', moduleId: item.id, templateVersion: item.revision ?? '' }
            : { templateId: item.id, moduleId: '', templateVersion: item.revision ?? item.updatedAt ?? '' };
    }
    function parseTemplateOptionValue(value) {
        const [source, ...rest] = String(value || '').split(':');
        const id = rest.join(':');
        if (!id || !['preset', 'module'].includes(source)) return null;
        return { source, id };
    }

    function flowInputNode() { return [...(engine()?.nodes?.values() || [])].find(node => node.type === 'flow-input') || null; }

    function inputAssetIds(node = flowInputNode()) { return parseIds(node?.data?.assetIds || node?.data?.asset_ids); }

    function syncInputStateFromNode() {
        state.selectedInputAssetIds = inputAssetIds();
        return state.selectedInputAssetIds;
    }

    function syncInputNodeFromState() {
        const node = flowInputNode();
        if (!node) return;
        const ids = [...state.selectedInputAssetIds];
        node.data = { ...(node.data || {}), assetIds: ids, asset_ids: ids };
        engine()?.refreshToolflowNode?.(node.id);
    }

    async function request(url, options = {}) {
        const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
        const headers = { ...(options.headers || {}) };
        if (!isFormData && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
        const response = await fetch(url, { credentials: 'same-origin', ...options, headers });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || body.message || '工具流请求失败');
        return body;
    }

    function setState(text, tone = 'info') {
        panel()?.querySelectorAll('[data-toolflow-state]').forEach(element => {
            element.textContent = text;
            element.dataset.tone = tone;
        });
    }

    function setMode(mode) {
        state.mode = mode === 'advanced' ? 'advanced' : 'guided';
        const root = panel();
        if (!root) return;
        root.classList.toggle('is-advanced', state.mode === 'advanced');
        const guided = root.querySelector('[data-toolflow-guided]');
        const advanced = root.querySelector('[data-toolflow-advanced]');
        if (guided) guided.hidden = state.mode !== 'guided';
        if (advanced) advanced.hidden = state.mode !== 'advanced';
        root.querySelectorAll('[data-toolflow-mode]').forEach(button => {
            button.textContent = state.mode === 'guided' ? '高级画布' : '返回步骤模式';
            button.title = state.mode === 'guided' ? '切换到高级画布' : '返回按步骤操作';
        });
        try { localStorage.setItem('ultimate-canvas:toolflow-mode', state.mode); } catch { /* optional preference */ }
    }

    function hydrateGuidedFromFlow(flow) {
        const graph = parseJson(flow?.graph_json, { nodes: [] });
        const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
        state.guidedSteps = nodes
            .filter(node => ['flow-template', 'flow-select', 'flow-confirm'].includes(node.type))
            .sort((a, b) => Number(a.x || 0) - Number(b.x || 0))
            .map((node, index) => ({
                id: node.id || `guided-step-${index + 1}`,
                nodeId: node.id,
                kind: node.type === 'flow-template' ? 'template' : node.type === 'flow-select' ? 'select' : 'confirm',
                templateId: node.data?.templateId || node.data?.template_id || '',
                moduleId: node.data?.moduleId || node.data?.module_id || '',
                templateVersion: node.data?.templateVersion || node.data?.template_version || '',
                systemDefault: !(node.data?.templateId || node.data?.template_id || node.data?.moduleId || node.data?.module_id),
            }));
        state.templatePickerStepId = '';
        syncInputStateFromNode();
        const name = panel()?.querySelector('[data-toolflow-name]');
        if (name) name.value = flow?.name || '';
        renderGuided();
    }

    async function loadGuidedAssets() {
        const project = projectId();
        if (!project) return;
        try {
            const query = new URLSearchParams({ type: 'image', scope: 'project', status: 'all', sort: 'created_desc', project_id: project, limit: '24' });
            const response = await request(`/api/assets/library?${query.toString()}`);
            state.guidedAssets = response.items || [];
            renderGuided();
        } catch (error) {
            state.guidedAssets = [];
            notice(error.message || '素材读取失败，请稍后重试。', 'warn');
            renderGuided();
        }
    }

    function filteredPresets() {
        const query = state.templateSearch.trim().toLowerCase();
        return state.presets.filter(preset => {
            if (!query) return true;
            return [preset.name, preset.groupName, preset.model, templateSource(preset) === 'module' ? '我的模块' : '管理员模板'].filter(Boolean).join(' ').toLowerCase().includes(query);
        });
    }

    function renderTemplatePicker(step) {
        if (state.templatePickerStepId !== step.id) return '';
        const presets = filteredPresets();
        const groups = new Map();
        presets.forEach(preset => {
            const group = preset.groupName || (templateSource(preset) === 'module' ? '我的模块' : preset.scope === 'admin' ? '管理员模板' : '我的模板');
            if (!groups.has(group)) groups.set(group, []);
            groups.get(group).push(preset);
        });
        const body = [...groups.entries()].map(([group, items]) => `
            <section class="guided-template-group">
                <h4>${escapeHtml(group)}</h4>
                <div class="guided-template-options">
                    ${items.map(preset => `<button type="button" class="guided-template-option ${selectedTemplate(step)?.id === preset.id && templateSource(selectedTemplate(step)) === templateSource(preset) ? 'is-selected' : ''}" data-guided-template="${escapeHtml(preset.id)}" data-guided-template-source="${escapeHtml(templateSource(preset))}" data-guided-step="${escapeHtml(step.id)}">
                        <span class="guided-template-thumb">${presetPreview(preset) ? `<img src="${escapeHtml(presetPreview(preset))}" alt="">` : '<span>图</span>'}</span>
                        <span class="guided-template-copy"><strong>${escapeHtml(preset.name)}</strong><small>${escapeHtml(presetLabel(preset))}${templateSource(preset) === 'module' ? ' · 我的模块' : ' · 授权模板'}</small></span>
                        <span class="guided-template-check">${selectedTemplate(step)?.id === preset.id && templateSource(selectedTemplate(step)) === templateSource(preset) ? '✓' : ''}</span>
                    </button>`).join('')}
                </div>
            </section>`).join('');
        return `<div class="guided-template-picker">
            <input class="guided-template-search" data-toolflow-template-search value="${escapeHtml(state.templateSearch)}" placeholder="搜索模板名称或分组">
            ${body || '<div class="guided-empty">没有找到匹配模板</div>'}
        </div>`;
    }

    function renderGuided() {
        const root = guidedRoot();
        if (!root) return;
        const name = root.querySelector('[data-toolflow-name]');
        if (name && !name.value) name.value = currentFlow()?.name || '';
        const steps = root.querySelector('[data-toolflow-steps]');
        if (!steps) return;
        const assets = state.guidedAssets;
        steps.innerHTML = `
            <article class="guided-step-card guided-input-step">
                <div class="guided-step-heading"><span class="guided-step-number">1</span><div><strong>选择素材</strong><small>可以多选图片，也可以上传或粘贴</small></div></div>
                <div class="guided-asset-picker">
                    <div class="guided-asset-actions"><button type="button" class="context-command" data-toolflow-upload>上传图片</button><span>${state.selectedInputAssetIds.length ? `已选 ${state.selectedInputAssetIds.length} 张` : '未选择素材'}</span></div>
                    <div class="guided-asset-grid" data-toolflow-assets>${assets.length ? assets.map(item => `<button type="button" class="guided-asset-option ${state.selectedInputAssetIds.includes(item.assetId || item.id) ? 'is-selected' : ''}" data-guided-asset="${escapeHtml(item.assetId || item.id)}"><span>${assetPreview(item) ? `<img src="${escapeHtml(assetPreview(item))}" alt="">` : '<span class="guided-asset-placeholder">图</span>'}</span><small>${escapeHtml(item.title || '素材')}</small></button>`).join('') : '<div class="guided-empty">当前项目还没有图片素材</div>'}</div>
                </div>
            </article>
            ${state.guidedSteps.map((step, index) => {
                const preset = selectedTemplate(step);
                if (step.kind === 'select') return `<article class="guided-step-card guided-control-step"><div class="guided-step-heading"><span class="guided-step-number">${index + 2}</span><div><strong>筛选结果</strong><small>选择要继续使用的图片</small></div><button type="button" class="guided-remove-step" data-toolflow-remove-step="${escapeHtml(step.id)}" aria-label="删除筛选步骤">×</button></div></article>`;
                if (step.kind === 'confirm') return `<article class="guided-step-card guided-control-step"><div class="guided-step-heading"><span class="guided-step-number">${index + 2}</span><div><strong>人工确认</strong><small>确认后再继续下一步</small></div><button type="button" class="guided-remove-step" data-toolflow-remove-step="${escapeHtml(step.id)}" aria-label="删除确认步骤">×</button></div></article>`;
                return `<article class="guided-step-card guided-template-step ${step.templateId || step.moduleId ? 'has-template' : ''}">
                    <div class="guided-step-heading"><span class="guided-step-number">${index + 2}</span><div><strong>生图模板</strong><small>${preset ? escapeHtml(preset.name) : '请选择一个模板'}</small></div><div class="guided-step-reorder"><button type="button" data-guided-move="up" data-guided-step="${escapeHtml(step.id)}" aria-label="上移">↑</button><button type="button" data-guided-move="down" data-guided-step="${escapeHtml(step.id)}" aria-label="下移">↓</button><button type="button" class="guided-remove-step" data-toolflow-remove-step="${escapeHtml(step.id)}" aria-label="删除模板步骤">×</button></div></div>
                    <button type="button" class="guided-template-trigger" data-guided-template-open="${escapeHtml(step.id)}">${preset ? `<span class="guided-template-thumb">${presetPreview(preset) ? `<img src="${escapeHtml(presetPreview(preset))}" alt="">` : '<span>图</span>'}</span><span><strong>${escapeHtml(preset.name)}</strong><small>${escapeHtml(presetLabel(preset))}</small></span><span class="guided-chevron">⌄</span>` : '<span class="guided-template-empty">选择一个生图模板</span><span class="guided-chevron">⌄</span>'}</button>
                    ${renderTemplatePicker(step)}
                </article>`;
            }).join('')}
            <article class="guided-step-card guided-output-step"><div class="guided-step-heading"><span class="guided-step-number">${state.guidedSteps.length + 2}</span><div><strong>输出到资产库</strong><small>生成结果会自动保存，可在资产管理查看</small></div></div></article>`;
    }

    function flowGraph() {
        ensureGuidedGraph();
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
        hydrateGuidedFromFlow(flow);
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
        const results = await Promise.allSettled([
            request('/api/image-studio/presets'),
            request('/api/image-studio/modules'),
        ]);
        const presetResult = results[0];
        const moduleResult = results[1];
        const errors = results.filter(result => result.status === 'rejected');
        if (errors.length === results.length) {
            state.presets = [];
            const error = errors[0]?.reason;
            setState(error?.message || '模板读取失败，请刷新重试。', 'error');
            notice(error?.message || '模板读取失败，请刷新重试。', 'error');
            renderNodeSettings();
            renderGuided();
            return;
        }
        const presets = presetResult.status === 'fulfilled' && Array.isArray(presetResult.value.presets)
            ? presetResult.value.presets.map(item => ({ ...item, source: 'preset' }))
            : [];
        const modules = moduleResult.status === 'fulfilled' && Array.isArray(moduleResult.value.modules)
            ? moduleResult.value.modules
                .filter(item => item?.id && (String(item.prompt || '').trim() || String(item.context || '').trim()))
                .map(item => ({ ...item, source: 'module' }))
            : [];
        state.presets = [...presets, ...modules];
        engine()?.setFlowTemplateOptions?.(state.presets);
        if (errors.length) notice('部分模板读取失败，已显示当前可用模板。', 'warn');
        renderNodeSettings();
        renderGuided();
    }

    async function loadStudioSettings() {
        try {
            const result = await request('/api/image-studio/settings');
            state.studioSettings = { ...state.studioSettings, ...result };
            engine()?.setFlowSystemSettings?.(state.studioSettings);
        } catch (error) {
            notice(error.message || '系统图片配置读取失败，将在运行前再次校验。', 'warn');
        }
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
        const selected = node.data?.templateId || node.data?.template_id
            ? `preset:${node.data.templateId || node.data.template_id}`
            : node.data?.moduleId || node.data?.module_id
                ? `module:${node.data.moduleId || node.data.module_id}`
                : '';
        root.innerHTML = `<span>图片模板节点：${escapeHtml(node.id)}</span>
            <select data-toolflow-template-select><option value="">使用当前节点提示词</option>${state.presets.map(preset => `<option value="${escapeHtml(templateOptionValue(preset))}">${escapeHtml(preset.name)}${templateSource(preset) === 'module' ? ' · 我的模块' : preset.scope === 'admin' ? ' · 管理员模板' : ''}</option>`).join('')}</select>`;
        const select = root.querySelector('[data-toolflow-template-select]');
        if (select) select.value = selected;
    }

    async function saveFlow() {
        const current = currentFlow();
        const guidedName = panel()?.querySelector('[data-toolflow-name]')?.value?.trim();
        const name = guidedName || current?.name || window.prompt('工作流名称', '我的图片工作流');
        if (!name) return;
        if (state.mode === 'guided' && !state.guidedSteps.some(step => step.kind === 'template')) {
            notice('请先添加至少一个生图模板。', 'warn');
            return;
        }
        if (state.mode === 'guided' && state.guidedSteps.some(step => step.kind === 'template' && !step.templateId && !step.moduleId && !step.systemDefault)) {
            notice('请在每个生图节点内选择模板，或保留系统默认配置后再保存。', 'warn');
            return;
        }
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
            ensureGuidedGraph();
            const nodeInputIds = inputAssetIds();
            const inputIds = state.mode === 'guided'
                ? (nodeInputIds.length ? nodeInputIds : [...state.selectedInputAssetIds])
                : (nodeInputIds.length ? nodeInputIds : parseIds(panel()?.querySelector('[data-toolflow-input-assets]')?.value));
            if (!inputIds.length) { notice('请先选择至少一张输入图片。', 'warn'); return; }
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
        if (node.type === 'flow-input') Object.assign(node.data, { assetIds: inputAssetIds(node), asset_ids: inputAssetIds(node), assetPreviews: Array.isArray(node.data.assetPreviews) ? node.data.assetPreviews : [] });
        if (node.type === 'flow-template') Object.assign(node.data, { title: node.data.title || '生图模板', source: node.data.source || 'system', prompt: node.data.prompt || '', context: node.data.context || '', savedContext: node.data.savedContext ?? node.data.context ?? '', count: node.data.count || 1, ratio: node.data.ratio || 'auto', size: node.data.size || '2K' });
        if (node.type === 'flow-input') node.data.title = node.data.title || '输入图片';
        if (node.type === 'flow-select') node.data.title = node.data.title || '筛选结果';
        if (node.type === 'flow-confirm') node.data.title = node.data.title || '人工确认';
        if (node.type === 'flow-output') node.data.title = node.data.title || '最终输出';
    }

    function ensureGuidedGraph() {
        if (state.mode !== 'guided' || !engine()) return;
        const nodes = [...engine().nodes.values()];
        engine().connections = engine().connections.filter(connection => {
            const from = engine().nodes.get(connection.from);
            const to = engine().nodes.get(connection.to);
            return !(from?.type?.startsWith('flow-') && to?.type?.startsWith('flow-'));
        });
        let input = nodes.find(node => node.type === 'flow-input');
        if (!input) input = engine().addNode('flow-input', 120, 220, { title: '输入图片' });
        let previous = input;
        state.guidedSteps.forEach((step, index) => {
            let node = step.nodeId ? engine().nodes.get(step.nodeId) : null;
            const type = step.kind === 'select' ? 'flow-select' : step.kind === 'confirm' ? 'flow-confirm' : 'flow-template';
            if (!node || node.type !== type) {
                const defaults = type === 'flow-template' ? { title: '生图模板', templateId: step.templateId || '', template_id: step.templateId || '', moduleId: step.moduleId || '', module_id: step.moduleId || '', templateVersion: step.templateVersion || '', source: step.templateId || step.moduleId ? 'template' : 'system' } : {};
                const nodeId = engine().addNode(type, 420 + index * 340, 220, defaults);
                node = engine().nodes.get(nodeId);
                step.nodeId = nodeId;
            }
            if (type === 'flow-template') {
                node.data = { ...(node.data || {}), templateId: step.templateId || undefined, template_id: step.templateId || undefined, moduleId: step.moduleId || undefined, module_id: step.moduleId || undefined, templateVersion: step.templateVersion || undefined, source: step.templateId || step.moduleId ? 'template' : 'system' };
            }
            engine()._createConnection?.(previous.id, node.id);
            previous = node;
        });
        let output = [...engine().nodes.values()].find(node => node.type === 'flow-output');
        if (!output) output = engine().addNode('flow-output', 520 + state.guidedSteps.length * 340, 220, { title: '输出到资产库' });
        engine()._createConnection?.(previous.id, output.id);
        engine()._updateConnections?.();
        renderGuided();
    }

    function addGuidedStep(kind = 'template') {
        const step = { id: `guided-${kind}-${Date.now().toString(36)}`, kind, nodeId: '', templateId: '', moduleId: '', templateVersion: '', systemDefault: kind === 'template' };
        state.guidedSteps.push(step);
        state.templatePickerStepId = kind === 'template' ? step.id : '';
        ensureGuidedGraph();
        renderGuided();
    }

    function removeGuidedStep(stepId) {
        const step = state.guidedSteps.find(item => item.id === stepId);
        if (step?.nodeId && engine()?.nodes.has(step.nodeId)) engine().deleteNode(step.nodeId);
        state.guidedSteps = state.guidedSteps.filter(item => item.id !== stepId);
        if (state.templatePickerStepId === stepId) state.templatePickerStepId = '';
        runtime().markChanged?.('toolflow_guided_step_remove');
        ensureGuidedGraph();
        renderGuided();
    }

    function moveGuidedStep(stepId, direction) {
        const index = state.guidedSteps.findIndex(item => item.id === stepId);
        const nextIndex = direction === 'up' ? index - 1 : index + 1;
        if (index < 0 || nextIndex < 0 || nextIndex >= state.guidedSteps.length) return;
        const next = [...state.guidedSteps];
        [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
        state.guidedSteps = next;
        runtime().markChanged?.('toolflow_guided_step_reorder');
        ensureGuidedGraph();
        renderGuided();
    }

    function toggleGuidedAsset(assetId) {
        if (!assetId) return;
        state.selectedInputAssetIds = state.selectedInputAssetIds.includes(assetId)
            ? state.selectedInputAssetIds.filter(id => id !== assetId)
            : [...state.selectedInputAssetIds, assetId].slice(0, 30);
        syncInputNodeFromState();
        runtime().markChanged?.('toolflow_input_asset_change');
        renderGuided();
    }

    function resetGuidedFlow() {
        state.selectedFlowId = '';
        state.guidedSteps = [];
        state.selectedInputAssetIds = [];
        state.templatePickerStepId = '';
        state.templateSearch = '';
        const name = panel()?.querySelector('[data-toolflow-name]');
        if (name) name.value = '';
        selectFlow('');
        syncInputNodeFromState();
        renderGuided();
        setState('新流程已准备好，请选择素材和模板。');
    }

    function nodeById(nodeId) { return nodeId ? engine()?.nodes.get(nodeId) : null; }

    function applyTemplateToNode(node, value) {
        if (!node || node.type !== 'flow-template') return;
        const binding = parseTemplateOptionValue(value);
        const item = binding ? state.presets.find(preset => templateSource(preset) === binding.source && preset.id === binding.id) : null;
        const next = item ? templateBinding(item) : { templateId: '', moduleId: '', templateVersion: '' };
        node.data = {
            ...(node.data || {}),
            templateId: next.templateId || undefined,
            template_id: next.templateId || undefined,
            moduleId: next.moduleId || undefined,
            module_id: next.moduleId || undefined,
            templateVersion: next.templateVersion || undefined,
            source: item ? 'template' : 'system',
            model: item ? undefined : undefined,
            quality: item ? undefined : undefined,
            ratio: item?.aspectRatio || 'auto',
            aspectRatio: item?.aspectRatio || undefined,
            count: Number(item?.count) || 1,
            size: undefined,
            prompt: '',
            context: '',
            savedContext: '',
        };
        engine()?.refreshToolflowNode?.(node.id);
        renderNodeSettings();
        runtime().markChanged?.('toolflow_node_template_change');
    }

    function updateTemplateNodeField(node, field, rawValue, refresh = true) {
        if (!node || node.type !== 'flow-template') return;
        const value = field === 'count' ? Math.min(8, Math.max(1, Number(rawValue) || 1)) : String(rawValue ?? '');
        node.data = { ...(node.data || {}), [field]: value };
        if (field === 'ratio') node.data.aspectRatio = value;
        if (refresh) {
            engine()?.refreshToolflowNode?.(node.id);
            renderNodeSettings();
        }
        runtime().markChanged?.(`toolflow_node_${field}_change`);
    }

    function updateTemplateContextSaveState(node) {
        if (!node || node.type !== 'flow-template') return;
        const card = document.querySelector(`[data-node-id="${CSS.escape(node.id)}"] [data-toolflow-template-node]`);
        if (!card) return;
        const value = String(card.querySelector(`[data-toolflow-node-field="context"][data-toolflow-node-id="${CSS.escape(node.id)}"]`)?.value ?? node.data?.context ?? '');
        const saved = String(node.data?.savedContext ?? value);
        const dirty = value !== saved;
        const button = card.querySelector(`[data-toolflow-context-save="${CSS.escape(node.id)}"]`);
        const status = card.querySelector(`[data-toolflow-context-status="${CSS.escape(node.id)}"]`);
        const summary = card.querySelector('summary span');
        if (button) { button.disabled = !dirty; button.textContent = dirty ? '保存节点上下文' : '已保存'; }
        if (status) status.textContent = dirty ? '有未保存修改' : '已保存到此节点';
        if (summary) summary.textContent = dirty ? '有未保存修改' : '已保存到此节点';
    }

    function saveTemplateNodeContext(node) {
        if (!node || node.type !== 'flow-template') return;
        const card = document.querySelector(`[data-node-id="${CSS.escape(node.id)}"] [data-toolflow-template-node]`);
        const value = String(card?.querySelector(`[data-toolflow-node-field="context"][data-toolflow-node-id="${CSS.escape(node.id)}"]`)?.value ?? node.data?.context ?? '');
        node.data = { ...(node.data || {}), context: value, savedContext: value };
        engine()?.refreshToolflowNode?.(node.id);
        runtime().markChanged?.('toolflow_node_context_save');
        notice('节点上下文已保存，不会覆盖通用上下文。', 'success');
    }

    function updateInputNodeAssets(node, assets) {
        if (!node || node.type !== 'flow-input') return;
        const deduped = [];
        const seen = new Set();
        assets.forEach(asset => {
            const id = asset?.id || asset?.assetId;
            if (!id || seen.has(id) || deduped.length >= 10) return;
            seen.add(id);
            deduped.push({
                id,
                assetId: id,
                title: asset.title || asset.fileName || '已上传图片',
                thumbnailUrl: asset.thumbnailUrl || asset.originalUrl || '',
                originalUrl: asset.originalUrl || asset.thumbnailUrl || '',
            });
        });
        node.data = { ...(node.data || {}), assetIds: deduped.map(asset => asset.id), asset_ids: deduped.map(asset => asset.id), assetPreviews: deduped };
        state.selectedInputAssetIds = deduped.map(asset => asset.id);
        engine()?.refreshToolflowNode?.(node.id);
        renderGuided();
        runtime().markChanged?.('toolflow_input_assets_change');
    }

    function inputAssetFromLibrary(item, nodeId = '') {
        if (!item || item.kind === 'video') return;
        const node = nodeById(nodeId) || flowInputNode();
        if (!node) { notice('请先在画布中添加输入图片节点。', 'warn'); return; }
        const current = Array.isArray(node.data?.assetPreviews) ? node.data.assetPreviews : [];
        updateInputNodeAssets(node, [...current, {
            id: item.assetId || item.id,
            title: item.title,
            thumbnailUrl: item.thumbnailUrl || item.previewUrl || item.downloadUrl || '',
            originalUrl: item.originalUrl || item.downloadUrl || item.previewUrl || '',
        }]);
    }

    function fileFingerprint(file) {
        if (!file) return Promise.resolve('');
        if (!window.crypto?.subtle) return Promise.resolve(`${file.name}:${file.size}:${file.lastModified}`);
        return file.arrayBuffer().then(buffer => window.crypto.subtle.digest('SHA-256', buffer)).then(hash => Array.from(new Uint8Array(hash)).map(value => value.toString(16).padStart(2, '0')).join(''));
    }

    function uploadInputFile(file, nodeId) {
        const node = nodeById(nodeId);
        if (!node || node.type !== 'flow-input' || !file) return Promise.resolve();
        if (!String(file.type || '').startsWith('image/')) { notice('输入节点只接受图片文件。', 'warn'); return Promise.resolve(); }
        if (!runtime().selectedProjectId || !runtime().selectedVideoCardId) { notice('请先选择项目和视频卡，再上传输入图片。', 'warn'); return Promise.resolve(); }
        const current = Array.isArray(node.data?.assetPreviews) ? node.data.assetPreviews : [];
        if (current.length >= 10) { notice('输入图片最多保留 10 张，请先移除一张。', 'warn'); return Promise.resolve(); }
        return fileFingerprint(file).then(fingerprint => {
            const fingerprints = Array.isArray(node.data?.inputFingerprints) ? node.data.inputFingerprints : [];
            if (fingerprint && fingerprints.includes(fingerprint)) { notice('这张图片已经在输入节点中。', 'info'); return; }
            state.inputUploads.set(nodeId, { status: 'uploading', file, progress: 0 });
            engine()?.setFlowInputUploadState?.(nodeId, { status: 'uploading', progress: 0 });
            return new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                const form = new FormData();
                form.set('file', file);
                form.set('project_id', runtime().selectedProjectId);
                form.set('video_card_id', runtime().selectedVideoCardId);
                if (runtime().documentId) form.set('canvas_document_id', runtime().documentId);
                form.set('canvas_node_id', nodeId);
                xhr.open('POST', '/api/tools/ultimate-canvas/upload');
                xhr.withCredentials = true;
                xhr.upload.onprogress = event => {
                    const progress = event.lengthComputable ? event.loaded / event.total : null;
                    state.inputUploads.set(nodeId, { status: 'uploading', file, progress });
                    engine()?.setFlowInputUploadState?.(nodeId, { status: 'uploading', progress });
                };
                xhr.onerror = () => reject(new Error('网络中断，请重试上传'));
                xhr.onload = () => {
                    let body = {};
                    try { body = JSON.parse(xhr.responseText || '{}'); } catch { /* handled below */ }
                    if (xhr.status < 200 || xhr.status >= 300 || !body.asset?.id) { reject(new Error(body.error || body.message || '图片上传失败')); return; }
                    const nextAssets = [...current, { id: body.asset.id, title: body.asset.fileName || file.name, thumbnailUrl: body.asset.thumbnailUrl || body.asset.originalUrl || '', originalUrl: body.asset.originalUrl || '' }];
                    node.data = { ...(node.data || {}), inputFingerprints: fingerprint ? [...fingerprints, fingerprint].slice(-20) : fingerprints };
                    updateInputNodeAssets(node, nextAssets);
                    state.inputUploads.delete(nodeId);
                    engine()?.setFlowInputUploadState?.(nodeId, null);
                    notice('图片已上传并加入输入节点。', 'success');
                    resolve(body);
                };
                xhr.onloadend = () => {
                    if (xhr.status < 200 || xhr.status >= 300) {
                        state.inputUploads.set(nodeId, { status: 'error', file, message: '图片上传失败' });
                        engine()?.setFlowInputUploadState?.(nodeId, { status: 'error', file, message: '图片上传失败' });
                    }
                };
                xhr.send(form);
            }).catch(error => {
                state.inputUploads.set(nodeId, { status: 'error', file, message: error.message });
                engine()?.setFlowInputUploadState?.(nodeId, { status: 'error', file, message: error.message });
                notice(error.message, 'error');
            });
        });
    }

    function openInputFilePicker(nodeId) { document.querySelector(`[data-toolflow-input-file="${CSS.escape(nodeId)}"]`)?.click(); }

    function openGuidedUpload() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.addEventListener('change', () => uploadGuidedAsset(input.files?.[0]));
        input.click();
    }

    function uploadGuidedAsset(file) {
        if (!file) return;
        const project = projectId();
        const card = runtime().selectedVideoCardId;
        if (!project || !card) { notice('请先选择项目和视频卡，再上传素材。', 'warn'); return; }
        const form = new FormData();
        form.set('file', file);
        form.set('project_id', project);
        form.set('video_card_id', card);
        if (runtime().documentId) form.set('canvas_document_id', runtime().documentId);
        notice('正在上传图片...', 'info');
        request('/api/tools/ultimate-canvas/upload', { method: 'POST', body: form }).then(result => {
            const asset = result.asset || {};
            const id = asset.id;
            if (!id) throw new Error('上传成功但没有返回素材');
            state.guidedAssets = [{ id, assetId: id, title: asset.fileName || '新上传图片', thumbnailUrl: asset.thumbnailUrl || asset.originalUrl || '', kind: 'image' }, ...state.guidedAssets];
            state.selectedInputAssetIds = [...new Set([...state.selectedInputAssetIds, id])];
            const input = flowInputNode();
            if (input) updateInputNodeAssets(input, [...(input.data?.assetPreviews || []), { id, title: asset.fileName || '新上传图片', thumbnailUrl: asset.thumbnailUrl || asset.originalUrl || '', originalUrl: asset.originalUrl || '' }]);
            else syncInputNodeFromState();
            renderGuided();
            notice('图片已加入输入素材。', 'success');
        }).catch(error => notice(error.message || '图片上传失败。', 'error'));
    }

    function bind() {
        if (state.bound || !panel()) return;
        state.bound = true;
        const root = panel();
        let savedMode = 'guided';
        try { savedMode = localStorage.getItem('ultimate-canvas:toolflow-mode') || 'guided'; } catch { /* optional preference */ }
        setMode(savedMode);
        const oldSelected = engine()?.onNodeSelected;
        if (engine()) engine().onNodeSelected = (id, node) => { oldSelected?.(id, node); renderNodeSettings(); };
        root.addEventListener('click', event => {
            const modeToggle = event.target.closest('[data-toolflow-mode]');
            if (modeToggle) { setMode(state.mode === 'guided' ? 'advanced' : 'guided'); return; }
            const inputChoose = event.target.closest('[data-toolflow-input-choose]');
            if (inputChoose) { openInputFilePicker(inputChoose.dataset.toolflowInputChoose); return; }
            const inputRetry = event.target.closest('[data-toolflow-input-retry]');
            if (inputRetry) {
                const pending = state.inputUploads.get(inputRetry.dataset.toolflowInputRetry);
                if (pending?.file) uploadInputFile(pending.file, inputRetry.dataset.toolflowInputRetry);
                return;
            }
            const inputRemove = event.target.closest('[data-toolflow-input-remove]');
            if (inputRemove) {
                const node = nodeById(inputRemove.closest('[data-toolflow-input-node]')?.dataset.toolflowInputNode || '') || flowInputNode();
                if (node) updateInputNodeAssets(node, (node.data?.assetPreviews || []).filter(asset => (asset.id || asset.assetId) !== inputRemove.dataset.toolflowInputRemove));
                return;
            }
            const pick = event.target.closest('[data-toolflow-pick]');
            if (pick) selectFlow(pick.dataset.toolflowPick);
            if (event.target.closest('[data-toolflow-new]')) { resetGuidedFlow(); return; }
            if (event.target.closest('[data-toolflow-save]')) saveFlow();
            if (event.target.closest('[data-toolflow-run]')) runFlow();
            if (event.target.closest('[data-toolflow-upload]')) { openGuidedUpload(); return; }
            const guidedAsset = event.target.closest('[data-guided-asset]');
            if (guidedAsset) { toggleGuidedAsset(guidedAsset.dataset.guidedAsset); return; }
            if (event.target.closest('[data-toolflow-add-template]')) { addGuidedStep('template'); return; }
            const optionalStep = event.target.closest('[data-toolflow-add-step]');
            if (optionalStep) { addGuidedStep(optionalStep.dataset.toolflowAddStep); return; }
            const templateOpen = event.target.closest('[data-guided-template-open]');
            if (templateOpen) {
                state.templatePickerStepId = state.templatePickerStepId === templateOpen.dataset.guidedTemplateOpen ? '' : templateOpen.dataset.guidedTemplateOpen;
                state.templateSearch = '';
                renderGuided();
                return;
            }
            const templateChoice = event.target.closest('[data-guided-template]');
            if (templateChoice) {
                const step = state.guidedSteps.find(item => item.id === templateChoice.dataset.guidedStep);
                if (step) {
                    const item = state.presets.find(preset => preset.id === templateChoice.dataset.guidedTemplate && templateSource(preset) === (templateChoice.dataset.guidedTemplateSource || 'preset'));
                    const binding = item ? templateBinding(item) : { templateId: templateChoice.dataset.guidedTemplate, moduleId: '', templateVersion: '' };
                    step.templateId = binding.templateId;
                    step.moduleId = binding.moduleId;
                    step.templateVersion = binding.templateVersion;
                    step.systemDefault = false;
                    const node = step.nodeId ? engine()?.nodes.get(step.nodeId) : null;
                    if (node && item) applyTemplateToNode(node, templateOptionValue(item));
                    runtime().markChanged?.('toolflow_guided_template_change');
                }
                state.templatePickerStepId = '';
                state.templateSearch = '';
                renderGuided();
                return;
            }
            const removeStep = event.target.closest('[data-toolflow-remove-step]');
            if (removeStep) { removeGuidedStep(removeStep.dataset.toolflowRemoveStep); return; }
            const moveStep = event.target.closest('[data-guided-move]');
            if (moveStep) { moveGuidedStep(moveStep.dataset.guidedStep, moveStep.dataset.guidedMove); return; }
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
        document.addEventListener('click', event => {
            if (root.contains(event.target)) return;
            const inputChoose = event.target.closest('[data-toolflow-input-choose]');
            if (inputChoose) { openInputFilePicker(inputChoose.dataset.toolflowInputChoose); return; }
            const inputRetry = event.target.closest('[data-toolflow-input-retry]');
            if (inputRetry) {
                const pending = state.inputUploads.get(inputRetry.dataset.toolflowInputRetry);
                if (pending?.file) uploadInputFile(pending.file, inputRetry.dataset.toolflowInputRetry);
                return;
            }
            const inputRemove = event.target.closest('[data-toolflow-input-remove]');
            if (inputRemove) {
                const node = nodeById(inputRemove.closest('[data-toolflow-input-node]')?.dataset.toolflowInputNode || '') || flowInputNode();
                if (node) updateInputNodeAssets(node, (node.data?.assetPreviews || []).filter(asset => (asset.id || asset.assetId) !== inputRemove.dataset.toolflowInputRemove));
                return;
            }
            const contextSave = event.target.closest('[data-toolflow-context-save]');
            if (contextSave) saveTemplateNodeContext(nodeById(contextSave.dataset.toolflowContextSave));
        });
        root.querySelector('[data-toolflow-select]')?.addEventListener('change', event => selectFlow(event.target.value));
        root.querySelector('[data-toolflow-node-settings]')?.addEventListener('change', event => {
            if (!event.target.matches('[data-toolflow-template-select]')) return;
            const node = currentNode();
            if (!node) return;
            applyTemplateToNode(node, event.target.value);
        });
        document.addEventListener('change', event => {
            const fileInput = event.target.closest('[data-toolflow-input-file]');
            if (fileInput) {
                const nodeId = fileInput.dataset.toolflowInputFile;
                [...(fileInput.files || [])].slice(0, 10).forEach(file => uploadInputFile(file, nodeId));
                fileInput.value = '';
                return;
            }
            const templateSelect = event.target.closest('[data-toolflow-node-template-select]');
            if (templateSelect) {
                applyTemplateToNode(nodeById(templateSelect.dataset.toolflowNodeTemplateSelect), templateSelect.value);
                return;
            }
            const field = event.target.closest('[data-toolflow-node-field]');
            if (field && field.dataset.toolflowNodeField === 'context') {
                updateTemplateContextSaveState(nodeById(field.dataset.toolflowNodeId));
                return;
            }
            if (field) updateTemplateNodeField(nodeById(field.dataset.toolflowNodeId), field.dataset.toolflowNodeField, field.value);
        });
        root.addEventListener('input', event => {
            const search = event.target.closest('[data-toolflow-template-search]');
            if (!search) return;
            state.templateSearch = search.value;
            const stepId = state.templatePickerStepId;
            renderGuided();
            const next = root.querySelector(`[data-toolflow-template-search]`);
            if (next && stepId === state.templatePickerStepId) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
        });
        document.addEventListener('input', event => {
            const field = event.target.closest('[data-toolflow-node-field]');
            if (field && field.dataset.toolflowNodeField === 'prompt') {
                updateTemplateNodeField(nodeById(field.dataset.toolflowNodeId), 'prompt', field.value, false);
                return;
            }
            if (field && field.dataset.toolflowNodeField === 'context') {
                const node = nodeById(field.dataset.toolflowNodeId);
                updateTemplateContextSaveState(node);
                return;
            }
            const prompt = event.target.closest('[data-toolflow-node-prompt]');
            if (!prompt) return;
            const node = engine()?.nodes.get(prompt.dataset.toolflowNodePrompt);
            if (node) { node.data = { ...(node.data || {}), prompt: prompt.value }; runtime().markChanged?.('toolflow_prompt_change'); }
        });
        document.addEventListener('paste', event => {
            const file = [...(event.clipboardData?.items || [])].find(item => item.type.startsWith('image/'))?.getAsFile();
            if (!file) return;
            const selected = currentNode();
            const targetNode = event.target.closest('[data-toolflow-input-node]') || (selected?.type === 'flow-input' ? document.querySelector(`[data-node-id="${selected.id}"] [data-toolflow-input-node]`) : null);
            if (targetNode) {
                event.preventDefault();
                uploadInputFile(file, targetNode.dataset.toolflowInputNode);
                return;
            }
            if (state.mode === 'guided' && root.classList.contains('active')) {
                event.preventDefault();
                uploadGuidedAsset(file);
            }
        });
        document.addEventListener('dragstart', event => {
            const item = event.target.closest('[data-library-id]');
            if (!item || !event.dataTransfer) return;
            const libraryId = item.dataset.libraryId;
            const libraryItem = [...(runtime().libraryItems || []), ...(runtime().historyItems || [])].find(entry => entry.id === libraryId);
            if (libraryItem) event.dataTransfer.setData('application/x-ultimate-canvas-asset', JSON.stringify(libraryItem));
        });
        document.addEventListener('dragover', event => {
            if (event.target.closest('[data-toolflow-input-node]')) event.preventDefault();
        });
        document.addEventListener('drop', event => {
            const targetNode = event.target.closest('[data-toolflow-input-node]');
            if (!targetNode) return;
            event.preventDefault();
            const files = [...(event.dataTransfer?.files || [])].filter(file => file.type.startsWith('image/'));
            if (files.length) {
                files.slice(0, 10).forEach(file => uploadInputFile(file, targetNode.dataset.toolflowInputNode));
                return;
            }
            try {
                const item = JSON.parse(event.dataTransfer?.getData('application/x-ultimate-canvas-asset') || '{}');
                inputAssetFromLibrary(item, targetNode.dataset.toolflowInputNode);
            } catch { /* unrelated drop payload */ }
        });
        const originalAdd = engine()?.addNode?.bind(engine());
        if (engine() && originalAdd) engine().addNode = (...args) => { const id = originalAdd(...args); addFlowNodeDefaults(engine().nodes.get(id)); renderNodeSettings(); return id; };
        loadFlows(); loadPresets(); loadStudioSettings(); loadGuidedAssets(); restoreRun();
        renderGuided();
        window.setTimeout(loadFlows, 900);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
})();
