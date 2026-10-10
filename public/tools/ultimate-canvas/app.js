/**
 * 无限画布 App – Application logic
 * Matches LibLib.tv interaction patterns:
 * - Double-click canvas → floating add-node menu at mouse position
 * - Left toolbar opens slide-out panels
 * - Node actions create connected nodes
 * - Text node has bottom input bar with model selector
 * - Video node has inline props panel with tabs/tools
 */
(function () {
    'use strict';

    const engine = new CanvasEngine('canvas-container', 'canvas', 'connections-svg');
    window.canvasEngine = engine;
    let pendingReferenceImport = null;
    const inlineVideoPlayers = new Map();
    const videoReadOrders = new Map();
    let videoReadSequence = 0;
    let videoRecheck = null;
    let lastVideoRecheck = 0;
    let roleCreator = null, roleWorkflow = null, roleInstanceLayer = null;

    function ensureNoticeStack() {
        let stack = document.getElementById('canvas-notice-stack');
        if (!stack) {
            stack = document.createElement('div');
            stack.id = 'canvas-notice-stack';
            stack.className = 'canvas-notice-stack';
            document.body.appendChild(stack);
        }
        return stack;
    }

    function showCanvasNotice(message, tone = 'info') {
        const stack = ensureNoticeStack();
        const notice = document.createElement('div');
        notice.className = `canvas-notice ${tone}`;
        notice.textContent = message;
        stack.appendChild(notice);
        window.setTimeout(() => {
            notice.classList.add('is-leaving');
            window.setTimeout(() => notice.remove(), 180);
        }, 3200);
    }

    window.showCanvasNotice = showCanvasNotice;
    window.addEventListener('message', event => {
        if (event.origin !== window.location.origin || event.source !== window.parent) return;
        if (event.data?.type !== 'sd2-canvas-preview-error'
            || typeof event.data.contentKey !== 'string'
            || !/^(asset|reference_image|video_task):[a-zA-Z0-9_-]+$/.test(event.data.contentKey)) return;
        showCanvasNotice('这条媒体目前无法预览，请确认仍有查看权限。', 'warn');
    });

    const canvasRuntime = {
        bootstrap: null,
        bootstrapLoaded: false,
        bootstrapError: null,
        documentId: null,
        documentRevision: 0,
        documentSchemaVersion: 2,
        documentTitle: '未命名画布',
        explicitDocumentId: new URLSearchParams(window.location.search).get('document_id'),
        explicitFocusNode: new URLSearchParams(window.location.search).get('focus_node'),
        documentWritable: false,
        documentDirty: false,
        editSequence: 0,
        documentOperation: false,
        uploadsInFlight: 0,
        saveConflict: false,
        pendingCopy: null,
        flushPromise: null,
        failedSaveRequest: null,
        libraryMounted: false,
        pendingDocumentCreate: null,
        documentLoaded: false,
        documentRestoring: false,
        saveTimer: null,
        saveState: 'idle',
        saveError: null,
        selectedProjectId: null,
        selectedVideoCardId: null,
        selectedVideoBranchId: null,
        documentProjectId: null,
        documentVideoCardId: null,
        contextEpoch: 0,
        bootstrapRequestId: 0,
        documentRequestId: 0,
        saveCoordinator: null,
        contextSwitching: false,
        openContextMenu: null,
        projectCreateOpen: false,
        videoCardCreateOpen: false,
        libraryLoaded: false,
        historyLoaded: false,
        libraryItems: [],
        historyItems: [],
        videoCardDetails: new Map(),
        videoCardBranches: new Map(),
        videoCardTasks: new Map(),
        videoCardLoads: new Map(),
        videoCardLoadErrors: new Map(),
        videoCardSelectedTaskIds: new Map(),
        videoCardView: { mode: 'list', section: 'info', cardId: null, search: '' },
        pendingGenerationReferenceTargetId: null,
        pollingCoordinator: null,
        generationPopover: null,
        referenceSelection: null,
        videoEstimates: new Map(),
        unsentVideoRequests: new Map(),
        pendingGenerationSubmissions: window.UltimateCanvasGenerationInteractions.createGenerationSubmissionTracker()
    };

    window.UltimateCanvasRuntime = {
        get selectedProjectId() { return canvasRuntime.selectedProjectId; },
        get selectedVideoCardId() { return canvasRuntime.selectedVideoCardId; },
        get selectedVideoBranchId() { return canvasRuntime.selectedVideoBranchId; },
        get documentId() { return canvasRuntime.documentId; },
        get libraryItems() { return canvasRuntime.libraryItems; },
        get historyItems() { return canvasRuntime.historyItems; },
        get bootstrap() { return canvasRuntime.bootstrap; },
        markChanged(reason = 'toolflow_change') { scheduleCanvasSave(reason); },
        requestName: requestCanvasName,
    };

    let graphRestoring = false;
    document.querySelectorAll('[data-graph-icon]').forEach(button => {
        button.innerHTML = window.UltimateCanvasIcons(button.dataset.graphIcon);
    });
    const graphCommands = window.UltimateCanvasCommands.createCanvasCommands(engine, {
        onChange: ({ action }) => {
            if (action !== 'clear') scheduleCanvasSave('graph_edit');
            updateGraphTools();
        },
        onRestore: ({ removedNodeIds }) => {
            for (const id of removedNodeIds) window.UltimateCanvasNodePricing?.dispose(id);
            // Resume uses existing task IDs and GET status only, never generation.
            stopAllVideoPolling();
            graphRestoring = true;
            try { hydrateNodeViews(); } finally { graphRestoring = false; }
            updateGraphTools();
        },
        onLimit: () => showCanvasNotice('较早的撤销记录已释放，画布内容仍保留。')
    });
    const canvasMinimap = window.UltimateCanvasMinimap.createCanvasMinimap(engine,
        document.getElementById('canvas-minimap'), { colors: {
            background: '#202124', border: '#53555a', node: '#a0a4aa', selected: '#4cd6ba',
            flow: '#deb775', connection: '#666a73', viewport: '#eeeeef'
        } });

    function graphEditAllowed() {
        return canvasRuntime.documentWritable && !canvasRuntime.contextSwitching && !canvasRuntime.documentRestoring
            && !canvasRuntime.documentOperation && !canvasRuntime.failedSaveRequest && !canvasRuntime.saveConflict
            && !roleJoinPending()
            && !canvasRuntime.uploadsInFlight && canvasRuntime.pendingGenerationSubmissions.size() === 0
            && ![...engine.nodes.values()].some(node =>
                ['pending', 'unconfirmed'].includes(node.data?.storyRequest?.state)
                || ['submitting', 'submitted', 'running', 'queued', 'processing', 'unconfirmed', 'uncertain'].includes(node.data?.generationStatus)
                || node.data?.videoSubmission?.state === 'unconfirmed'
                || document.querySelector(`[data-node-id="${CSS.escape(node.id)}"] .is-generating, [data-node-id="${CSS.escape(node.id)}"] [data-busy="true"]`));
    }

    function minimapKey() {
        return `sd2:canvas:minimap:${canvasRuntime.bootstrap?.user?.id || 'unknown'}:${canvasRuntime.documentId || 'none'}`;
    }

    function updateGraphTools() {
        const allowed = graphEditAllowed();
        const selected = engine.getSelectedNodeIds();
        const state = graphCommands.getState();
        for (const [id, enabled] of [['btn-undo', state.canUndo], ['btn-redo', state.canRedo],
            ['btn-copy-nodes', selected.length > 0], ['btn-group', selected.length > 1],
            ['btn-ungroup', selected.some(id => engine.nodes.get(id)?.data?.canvasGroup)]]) {
            const button = document.getElementById(id);
            if (button) {
                button.disabled = !allowed || !enabled;
                if (id === 'btn-copy-nodes' || id === 'btn-group') {
                    const label = `${id === 'btn-copy-nodes' ? '复制选中节点' : '分组选中节点'}（${selected.length}）`;
                    button.title = label; button.setAttribute('aria-label', label);
                }
            }
        }
        engine.nodes.forEach(node => {
            const el = document.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`);
            el?.classList.toggle('canvas-node-grouped', Boolean(node.data?.canvasGroup?.id));
        });
        canvasMinimap.render();
    }

    function runGraphAction(action, targetNodeId = null) {
        if (!graphEditAllowed()) return showCanvasNotice('请先处理保存或未确认的请求，再编辑画布结构。', 'warn');
        syncAllNodesFromDom();
        graphRestoring = true;
        try {
            if (action === 'undo') graphCommands.undo();
            if (action === 'redo') graphCommands.redo();
            if (action === 'copy') {
                if (targetNodeId) engine.selectNode(targetNodeId);
                const placement = duplicatePlacement();
                if (!placement) { showCanvasNotice('右侧没有足够空位，请先腾出位置再创建副本。', 'warn'); return; }
                const result = graphCommands.duplicateSelection({ ...placement,
                    referencesForNode: nodeId => generationReferenceItems(nodeId).map(item => ({ ...item,
                        nodeId: item.referenceImageId ? `snapshot-reference-${item.referenceImageId}` : item.nodeId })) });
                if (result.ok) {
                    hydrateNodeViews();
                    const nodeId = result.createdIds[0];
                    const copied = engine.nodes.get(nodeId), rect = document.getElementById('canvas-container').getBoundingClientRect();
                    if (copied && (copied.x * engine.scale + engine.offsetX < 0 || (copied.x + 624) * engine.scale + engine.offsetX > rect.width
                        || copied.y * engine.scale + engine.offsetY < 0 || (copied.y + 440) * engine.scale + engine.offsetY > rect.height)) {
                        engine.offsetX = 24 - copied.x * engine.scale; engine.offsetY = 24 - copied.y * engine.scale;
                        engine._applyTransform();
                    }
                    document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"] .image-props-textarea, [data-node-id="${CSS.escape(nodeId)}"] .video-props-textarea`)?.focus();
                }
            }
            if (action === 'group') window.UltimateCanvasGroups.groupSelected(engine, graphCommands);
            if (action === 'ungroup') window.UltimateCanvasGroups.ungroupSelected(engine, graphCommands);
        } finally { graphRestoring = false; }
        updateGraphTools();
    }
    engine.onDuplicateNode = nodeId => runGraphAction('copy', nodeId);
    function duplicatePlacement() {
        const selected = engine.getSelectedNodeIds().map(id => engine.nodes.get(id)).filter(Boolean);
        if (!selected.length) return null;
        const bounds = node => {
            const element = document.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`);
            return { x: node.x, y: node.y, width: element?.offsetWidth || 624, height: element?.offsetHeight || 440 };
        };
        const selectedBounds = selected.map(bounds), occupied = [...engine.nodes.values()].map(bounds);
        const width = Math.max(...selectedBounds.map(node => node.x + node.width)) - Math.min(...selectedBounds.map(node => node.x));
        for (let index = 0; index < 60; index++) {
            const offsetX = width + 80 + Math.floor(index / 10) * 704, offsetY = (index % 10) * 504;
            const collision = selectedBounds.some(copy => occupied.some(node => copy.x + offsetX < node.x + node.width + 24
                && copy.x + offsetX + copy.width + 24 > node.x && copy.y + offsetY < node.y + node.height + 24
                && copy.y + offsetY + copy.height + 24 > node.y));
            if (!collision) return { offsetX, offsetY };
        }
        return null;
    }

    // Only synchronous user editing transactions enter history, not polling or Provider callbacks.
    let graphGesture = null;
    document.addEventListener('pointerdown', event => {
        if (!event.isTrusted || !graphEditAllowed() || !event.target.closest('#canvas-container')) return;
        syncAllNodesFromDom(); graphGesture = graphCommands.begin('移动节点');
    }, true);
    document.addEventListener('pointerup', () => {
        if (!graphGesture) return;
        const token = graphGesture; graphGesture = null;
        queueMicrotask(() => { syncAllNodesFromDom(); graphCommands.commit(token); updateGraphTools(); });
    }, true);
    for (const eventName of ['click', 'beforeinput', 'change', 'keydown']) {
        document.addEventListener(eventName, event => {
            if (!event.isTrusted || graphRestoring || !graphEditAllowed()) return;
            if (event.target.closest('#canvas-floating-toolbar')) return;
            if (eventName === 'keydown' && !['Delete', 'Backspace'].includes(event.key)) return;
            syncAllNodesFromDom();
            const token = graphCommands.begin('编辑画布', { coalesceKey: event.target.closest('.canvas-node')?.dataset.nodeId });
            queueMicrotask(() => {
                if (graphRestoring || canvasRuntime.documentRestoring) return;
                syncAllNodesFromDom(); graphCommands.commit(token); updateGraphTools();
            });
        }, true);
    }
    document.addEventListener('keydown', event => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey
            || event.target.closest('input,textarea,select,[contenteditable="true"],[role="dialog"]')) return;
        const key = event.key.toLowerCase();
        const action = key === 'z' ? (event.shiftKey ? 'redo' : 'undo') : key === 'y' ? 'redo' : key === 'd' ? 'copy' : null;
        if (!action) return;
        event.preventDefault(); event.stopImmediatePropagation(); runGraphAction(action);
    }, true);
    for (const [id, action] of [['btn-undo', 'undo'], ['btn-redo', 'redo'], ['btn-copy-nodes', 'copy'],
        ['btn-group', 'group'], ['btn-ungroup', 'ungroup']]) {
        document.getElementById(id)?.addEventListener('click', () => runGraphAction(action));
    }

    const planSplit = window.UltimateCanvasPlanSplitUI.create({
        engine, dialog: openCanvasProductDialog, confirm: requestCanvasConfirmation,
        sourceText: nodeId => {
            const node = engine.nodes.get(nodeId);
            const el = document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
            return el?.querySelector('.node-text-content')?.innerText ?? el?.querySelector('.node-text-content')?.textContent
                ?? node?.data?.authoredText ?? node?.data?.generatedText ?? node?.data?.prompt ?? node?.data?.description ?? '';
        },
        writable: () => canvasRuntime.documentWritable && !canvasRuntime.contextSwitching,
        bindings: node => {
            const explicit = node?.data?.videoSettings || {};
            const settings = node?.type === 'video' ? generationSettingsForNode(node) : { ...explicit };
            const card = selectedVideoCard();
            if (!settings.model && canvasRuntime.bootstrap?.capabilities?.video?.model) settings.model = canvasRuntime.bootstrap.capabilities.video.model;
            if (!settings.ratio && card?.ratio) settings.ratio = card.ratio;
            if (!settings.duration && card?.duration) settings.duration = card.duration;
            if (!settings.resolution) settings.resolution = canvasRuntime.bootstrap?.capabilities?.video?.interaction?.resolutions?.includes('720p') ? '720p' : undefined;
            return { settings, references: node ? generationReferenceItems(node.id) : [],
                contextRules: contextRulesForNode({ type: 'video', data: {} }),
                cardId: canvasRuntime.selectedVideoCardId, branchId: canvasRuntime.selectedVideoBranchId,
                label: `模型：${settings.model || '待选择'}（${explicit.model ? '来源节点' : '当前画布'}） · 时长：${settings.duration || '待选择'}秒（${explicit.duration ? '来源节点' : '视频卡'}） · 比例：${settings.ratio || '待选择'}（${explicit.ratio ? '来源节点' : '视频卡'}） · 分辨率：${settings.resolution || '待选择'}（${explicit.resolution ? '来源节点' : '当前画布'}）` };
        },
        notice: showCanvasNotice, save: scheduleCanvasSave, flush: flushCanvasSave,
        cache: () => cacheCanvasDraft(canvasSaveSnapshot('plan_split_draft')),
        snapshot: canvasDocumentPayload, render: renderAllGenerationNodeControls
    });
    engine.onPlanSplit = nodeId => { void planSplit.open(nodeId); };

    async function openStoryStudio(nodeId) {
        if (!canvasRuntime.documentWritable || canvasRuntime.contextSwitching) return;
        if (window.UltimateCanvasGetExitRisk?.().busy?.length) {
            showCanvasNotice('当前请求尚未确认，请先处理后再打开故事与分镜。', 'warn');
            return;
        }
        const node = engine.nodes.get(nodeId);
        if (!node || !['text', 'script'].includes(node.type)) return;
        scheduleCanvasSave('open_story_studio');
        if (!await flushCanvasSave('open_story_studio') || !canvasRuntime.documentId) {
            showCanvasNotice('请先保存画布，再打开故事与分镜。', 'warn');
            return;
        }
        if (engine.nodes.get(nodeId) !== node) return;
        const query = new URLSearchParams({ document_id: canvasRuntime.documentId, node_id: nodeId });
        window.top.location.href = '/story-studio?' + query;
    }

    function renderStoryEntry(nodeId) {
        const node = engine.nodes.get(nodeId);
        const el = document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
        if (!node || !el || !['text', 'script'].includes(node.type)) return;
        let entry = el.querySelector('[data-story-entry]');
        if (!entry) {
            entry = document.createElement('button');
            entry.type = 'button'; entry.dataset.storyEntry = nodeId;
            entry.className = 'canvas-story-entry';
            entry.innerHTML = window.UltimateCanvasIcons('Clapperboard') + '<span>故事与分镜</span>';
            entry.onclick = event => { event.stopPropagation(); void openStoryStudio(nodeId); };
            (el.querySelector('.node-body') || el).appendChild(entry);
        }
        entry.disabled = !canvasRuntime.documentWritable || canvasRuntime.contextSwitching;
    }

    function canvasGenerationQuotePayload(nodeId) {
        const nodeEl = document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
        const payload = nodeEl && collectGenerationPayload(nodeEl);
        return payload ? { ...payload, prompt: promptWithConnectedText(payload) } : null;
    }

    function canvasGenerationQuoteSnapshot(nodeId) {
        const node = engine.nodes.get(nodeId);
        const payload = canvasGenerationQuotePayload(nodeId);
        if (!node || !payload) return '';
        return JSON.stringify({
            userId: canvasRuntime.bootstrap?.user?.id,
            projectId: canvasRuntime.selectedProjectId,
            cardId: canvasRuntime.selectedVideoCardId,
            documentId: canvasRuntime.documentId,
            writable: canvasRuntime.documentWritable && !canvasRuntime.contextSwitching,
            mode: payload.mode,
            prompt: payload.prompt,
            promptMentions: payload.promptMentions || null,
            settings: payload.settings,
            referenceImageIds: payload.referenceImageIds || [],
            style: node.data?.canvasStyle || null
        });
    }

    const canvasBillingViews = new Map();
    function renderCanvasBilling(nodeId) {
        const entry = canvasBillingViews.get(nodeId), node = engine.nodes.get(nodeId);
        const region = document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"] .generated-reference-card`);
        region?.querySelector('[data-canvas-image-billing]')?.remove();
        if (!region || !node || !entry || entry.owner !== canvasRuntime.bootstrap?.user?.id || entry.documentId !== canvasRuntime.documentId
            || entry.assetId !== node.data?.assetId) return;
        const view = entry.billing;
        const badge = document.createElement('span'); badge.dataset.canvasImageBilling = '';
        badge.className = 'canvas-image-billing';
        badge.textContent = view?.amountMicros !== null && view?.chargedCredits !== null
            && Number.isSafeInteger(view?.amountMicros) && Number.isFinite(view?.chargedCredits)
            ? `$${(view.amountMicros / 1000000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} · ${view.chargedCredits.toFixed(2)}点`
            : ['awaiting_response', 'pending', 'reconciling'].includes(view?.status) ? '费用核对中' : '费用待核对';
        region.append(badge);
    }
    const canvasStyles = window.UltimateCanvasStyles.create({
        billing: (nodeId, rows) => {
            const owner = canvasRuntime.bootstrap?.user?.id;
            rows.filter(item => item.billing && item.assetId).forEach((item, index) => {
                const target = index === 0 ? nodeId : `image-result-${item.assetId}`;
                if (index > 0 && rows.filter(row => row.assetId === item.assetId).length !== 1) return;
                const previous = canvasBillingViews.get(target);
                if (previous && (previous.billing.status !== item.billing.status || previous.billing.chargedCredits !== item.billing.chargedCredits)) {
                    window.parent.postMessage({ type: 'sd2-canvas-billing-settled', userId: owner }, location.origin);
                }
                if (canvasBillingViews.size >= 1024 && !canvasBillingViews.has(target)) canvasBillingViews.delete(canvasBillingViews.keys().next().value);
                canvasBillingViews.set(target, { owner, documentId: canvasRuntime.documentId, assetId: item.assetId, taskId: item.taskId, billing: item.billing });
                renderCanvasBilling(target);
            });
        },
        request: requestJson,
        confirm: requestCanvasConfirmation,
        getQuoteSnapshot: canvasGenerationQuoteSnapshot,
        getGenerationPayload: canvasGenerationQuotePayload,
        clearActualQuote: nodeId => window.UltimateCanvasNodePricing?.clearActualQuote(nodeId),
        quoteConsumed: nodeId => window.UltimateCanvasNodePricing?.invalidateProjection(nodeId),
        showQuote: (nodeId, quote) => {
            const nodeEl = document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
            const line = engine.nodes.get(nodeId)?.data?.canvasStyle
                ? nodeEl?.querySelector('[data-style-price]')
                : nodeEl?.querySelector('[data-canvas-node-price]');
            if (!line) return;
            const total = Number(quote?.estimatedCredits);
            line.textContent = Number.isFinite(total) && total >= 0 && Number.isSafeInteger(Math.ceil(total))
                ? `合计约 ${Math.ceil(total).toLocaleString('zh-CN')} 点数` : '费用待估算';
        },
        clearQuote: nodeId => {
            if (engine.nodes.has(nodeId)) renderGenerationNodeControls(nodeId);
        },
        getNode: nodeId => engine.nodes.get(nodeId),
        context: () => ({ userId: canvasRuntime.bootstrap?.user?.id, projectId: canvasRuntime.selectedProjectId,
            cardId: canvasRuntime.selectedVideoCardId, documentId: canvasRuntime.documentId,
            writable: canvasRuntime.documentWritable && !canvasRuntime.contextSwitching }),
        setPrompt: (nodeId, prompt) => {
            const nodeEl = document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
            const input = nodeEl && promptInputFor(nodeEl, 'image');
            if (input) input.value = prompt || '';
        },
        render: renderGenerationNodeControls, save: scheduleCanvasSave, flush: flushCanvasSave,
        notice: showCanvasNotice,
        status: (nodeId, status, message) => setNodeGenerationStatus(document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`), status, message),
        apply: (nodeId, payload, result) => {
            const nodeEl = document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
            if (nodeEl) applyGenerationResult(nodeEl, payload, result);
        }
    });

    function backendEndpoint(candidate, fallback, policy = 'canvas') {
        return window.UltimateCanvasBackendContract.resolveApiEndpoint(
            candidate,
            fallback,
            window.location.origin,
            policy
        );
    }

    function configureGenerationEndpoints() {
        if (!window.CanvasGenerationAPI?.configure) return;
        const capabilities = canvasRuntime.bootstrap?.capabilities || {};
        window.CanvasGenerationAPI.configure({
            endpoints: {
                text: backendEndpoint(capabilities.text?.endpoint, '/api/tools/ultimate-canvas/generate', 'text'),
                script: backendEndpoint(capabilities.script?.endpoint, '/api/tools/ultimate-canvas/generate', 'script'),
                image: backendEndpoint(capabilities.image?.endpoint, '/api/assets/generate', 'image'),
                video: backendEndpoint(capabilities.video?.endpoint, '/api/tasks/create', 'video')
            }
        });
    }

    function selectedProject() {
        return selectedProjectFromBootstrap(canvasRuntime.bootstrap);
    }

    function selectedVideoCard() {
        return selectedVideoCardFromBootstrap(canvasRuntime.bootstrap);
    }

    function selectedVideoBranches() {
        return canvasRuntime.videoCardBranches.get(canvasRuntime.selectedVideoCardId) || [];
    }

    function canvasWorkspaceKey() {
        if (!canvasRuntime.selectedProjectId || !canvasRuntime.selectedVideoCardId) return '';
        return `ultimate-canvas:${canvasRuntime.selectedProjectId}:${canvasRuntime.selectedVideoCardId}`;
    }

    function workspaceHeaders() {
        const key = canvasWorkspaceKey();
        return key ? { 'x-tab-id': key } : {};
    }

    async function requestJson(url, options = {}) {
        const method = options.method || 'GET';
        const policy = options.policy || 'canvas';
        const endpoint = backendEndpoint(url, '', policy);
        if (!endpoint) {
            throw window.UltimateCanvasBackendContract.createApiError(400, {
                error: 'invalid_canvas_endpoint',
                endpoint: String(url || ''),
                policy
            }, 'Canvas request endpoint is not allowed.');
        }
        const hasPayload = options.payload !== undefined;
        const payload = hasPayload && endpoint.split('?')[0] === '/api/tools/ultimate-canvas/document'
            ? { ...options.payload, required_capabilities: ['role.v1'] } : options.payload;
        const body = options.body !== undefined
            ? options.body
            : hasPayload
                ? JSON.stringify(payload)
                : undefined;
        const requestHeaders = {
            ...(hasPayload ? { 'Content-Type': 'application/json' } : {}),
            ...workspaceHeaders(),
            ...(endpoint.split('?')[0] === '/api/tools/ultimate-canvas/document' ? { 'x-canvas-capabilities': 'role.v1' } : {}),
            ...(options.headers || {})
        };
        const res = await fetch(endpoint, {
            method,
            credentials: 'same-origin',
            headers: requestHeaders,
            body,
            cache: options.cache,
            signal: options.signal
        });
        const text = await res.text();
        let data = {};
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            data = { raw: text };
        }
        if (!res.ok) {
            throw window.UltimateCanvasBackendContract.createApiError(res.status, data);
        }
        return data;
    }

    function postJson(url, payload, options = {}) {
        return requestJson(url, { ...options, method: 'POST', payload });
    }

    function patchJson(url, payload, options = {}) {
        return requestJson(url, { ...options, method: 'PATCH', payload });
    }

    function deleteJson(url, options = {}) {
        return requestJson(url, { ...options, method: 'DELETE' });
    }

    function invalidateVideoCardWorkspace(cardId) {
        if (!cardId) return;
        canvasRuntime.videoCardDetails.delete(cardId);
        canvasRuntime.videoCardBranches.delete(cardId);
        canvasRuntime.videoCardTasks.delete(cardId);
        canvasRuntime.videoCardLoads.delete(cardId);
        canvasRuntime.videoCardLoadErrors.delete(cardId);
    }

    async function loadVideoCardWorkspace(cardId, options = {}) {
        if (!cardId) return null;
        const epoch = canvasRuntime.contextEpoch;
        const cached = !options.force
            && canvasRuntime.videoCardDetails.has(cardId)
            && canvasRuntime.videoCardBranches.has(cardId)
            && canvasRuntime.videoCardTasks.has(cardId);
        if (cached) {
            return {
                detail: canvasRuntime.videoCardDetails.get(cardId),
                branches: canvasRuntime.videoCardBranches.get(cardId),
                tasks: canvasRuntime.videoCardTasks.get(cardId)
            };
        }
        if (!options.force && canvasRuntime.videoCardLoads.has(cardId)) {
            return canvasRuntime.videoCardLoads.get(cardId);
        }

        canvasRuntime.videoCardLoadErrors.delete(cardId);
        const request = Promise.all([
            requestJson(`/api/video-cards/${encodeURIComponent(cardId)}`, { cache: 'no-store' }),
            requestJson(`/api/video-cards/${encodeURIComponent(cardId)}/branches`, { cache: 'no-store' }),
            requestJson(`/api/video-cards/${encodeURIComponent(cardId)}/tasks`, { cache: 'no-store' })
        ]).then(([detail, branchesPayload, tasksPayload]) => {
            const branches = branchesPayload?.branches || [];
            const tasks = tasksPayload?.tasks || [];
            if (epoch !== canvasRuntime.contextEpoch) return { detail, branches, tasks };
            canvasRuntime.videoCardDetails.set(cardId, detail);
            canvasRuntime.videoCardBranches.set(cardId, branches);
            canvasRuntime.videoCardTasks.set(cardId, tasks);
            if (cardId === canvasRuntime.selectedVideoCardId) {
                canvasRuntime.selectedVideoBranchId = window.UltimateCanvasVideoCards.chooseBranch(
                    branches,
                    canvasRuntime.selectedVideoBranchId
                ) || null;
            }
            return { detail, branches, tasks };
        }).catch(error => {
            if (epoch === canvasRuntime.contextEpoch) canvasRuntime.videoCardLoadErrors.set(cardId, error);
            throw error;
        }).finally(() => {
            if (canvasRuntime.videoCardLoads.get(cardId) === request) canvasRuntime.videoCardLoads.delete(cardId);
        });

        canvasRuntime.videoCardLoads.set(cardId, request);
        return request;
    }

    function selectVideoBranch(branchId) {
        const nextBranchId = window.UltimateCanvasVideoCards.chooseBranch(
            selectedVideoBranches(),
            branchId
        ) || null;
        if (canvasRuntime.selectedVideoBranchId === nextBranchId) return nextBranchId;
        canvasRuntime.selectedVideoBranchId = nextBranchId;
        scheduleCanvasSave('video_branch_change');
        return nextBranchId;
    }

    async function refreshProjectVideoCards(projectId = canvasRuntime.selectedProjectId) {
        if (!projectId || !canvasRuntime.bootstrap?.context) return [];
        const data = await requestJson(`/api/projects/${encodeURIComponent(projectId)}/video-cards`, {
            cache: 'no-store'
        });
        if (projectId !== canvasRuntime.selectedProjectId) return [];

        const previousCards = new Map(
            (canvasRuntime.bootstrap.context.video_cards || []).map(card => [card.id, card])
        );
        const permissions = data?.permissions || {};
        const cards = (data?.video_cards || [])
            .filter(card => card.status !== 'discarded')
            .map(card => {
                const previous = previousCards.get(card.id) || {};
                const canGenerate = window.UltimateCanvasVideoCards.operationAllowed({
                    video_card: card,
                    permissions: { can_generate: permissions.can_generate }
                }, 'generate');
                return {
                    ...previous,
                    ...card,
                    can_generate: canGenerate,
                    can_manage: Boolean(permissions.can_manage_project),
                    status_label: previous.status_label || card.status,
                    spec_label: videoCardSpecFor(card),
                    branch_count: previous.branch_count || 0,
                    removal_action: previous.removal_action || null,
                    removal_reason: previous.removal_reason || ''
                };
            });
        canvasRuntime.bootstrap.context.video_cards = cards;
        renderRuntimeContextControls();
        return cards;
    }

    function openVideoCardManagement(cardId) {
        if (!cardId) return;
        canvasRuntime.videoCardView = {
            ...canvasRuntime.videoCardView,
            mode: 'detail',
            section: 'info',
            cardId
        };
        canvasRuntime.openContextMenu = 'video-card';
        renderRuntimeContextControls();
        loadVideoCardWorkspace(cardId).then(() => {
            if (canvasRuntime.videoCardView.mode === 'detail'
                && canvasRuntime.videoCardView.cardId === cardId) {
                renderRuntimeContextControls();
            }
        }).catch(() => {
            if (canvasRuntime.videoCardView.mode === 'detail'
                && canvasRuntime.videoCardView.cardId === cardId) {
                renderRuntimeContextControls();
            }
        });
    }

    async function refreshVideoCardManagement(cardId) {
        if (!cardId) return;
        invalidateVideoCardWorkspace(cardId);
        renderRuntimeContextControls();
        try {
            await loadVideoCardWorkspace(cardId, { force: true });
        } finally {
            if (canvasRuntime.videoCardView.mode === 'detail'
                && canvasRuntime.videoCardView.cardId === cardId) {
                renderRuntimeContextControls();
            }
        }
    }

    async function executeVideoCardOperation(operation, input = {}) {
        const cardId = input.cardId || canvasRuntime.videoCardView.cardId;
        const changesGenerationContext = ['card-seal', 'card-archive', 'card-discard'].includes(operation);
        if (changesGenerationContext && cardId === canvasRuntime.selectedVideoCardId) {
            const saved = await flushCanvasSave(`before_${operation}`);
            if (!saved) throw new Error('\u753b\u5e03\u4fdd\u5b58\u5931\u8d25\uff0c\u5df2\u53d6\u6d88\u89c6\u9891\u5361\u64cd\u4f5c\u3002');
        }

        const descriptor = window.UltimateCanvasVideoCards.requestFor(operation, {
            ...input,
            cardId
        });
        const result = await requestJson(descriptor.url, {
            method: descriptor.method,
            payload: descriptor.payload
        });
        if (operation.startsWith('approval-')) return result;

        invalidateVideoCardWorkspace(cardId);
        await refreshProjectVideoCards();
        if (changesGenerationContext && cardId === canvasRuntime.selectedVideoCardId) {
            canvasRuntime.videoCardView = {
                ...canvasRuntime.videoCardView,
                mode: 'list',
                section: 'info',
                cardId: null
            };
            await loadCanvasBootstrap(canvasRuntime.selectedProjectId, null, { restoreDocument: false });
        } else {
            await loadVideoCardWorkspace(cardId, { force: true });
            renderRuntimeContextControls();
        }
        return result;
    }

    async function executeVideoBranchAction(operation, input = {}) {
        const cardId = input.cardId || canvasRuntime.videoCardView.cardId;
        const descriptor = window.UltimateCanvasVideoCards.requestFor(operation, {
            ...input,
            cardId
        });
        let result;
        try {
            result = await requestJson(descriptor.url, {
                method: descriptor.method,
                payload: descriptor.payload
            });
        } catch (error) {
            const activeCount = window.UltimateCanvasVideoCards.activeBranches(
                canvasRuntime.videoCardBranches.get(cardId) || []
            ).length;
            if (operation === 'branch-create'
                && !input.confirmOverLimit
                && error?.status === 400
                && activeCount >= 5) {
                const confirmed = await requestCanvasConfirmation({
                    title: '\u65b9\u5411\u6570\u91cf\u786e\u8ba4',
                    message: `\u5f53\u524d\u5df2\u6709 ${activeCount} \u4e2a\u6d3b\u8dc3\u65b9\u5411\uff0c\u7ee7\u7eed\u65b0\u5efa\u53ef\u80fd\u589e\u52a0\u6574\u7406\u6210\u672c\u3002`,
                    detail: input.title || '',
                    confirmLabel: '\u4ecd\u7136\u65b0\u5efa'
                });
                if (confirmed) {
                    return executeVideoBranchAction(operation, {
                        ...input,
                        confirmOverLimit: true
                    });
                }
            }
            throw error;
        }

        invalidateVideoCardWorkspace(cardId);
        if (input.action === 'promote_to_card') await refreshProjectVideoCards();
        await loadVideoCardWorkspace(cardId, { force: true });
        renderRuntimeContextControls();
        scheduleCanvasSave('video_branch_operation');
        return result;
    }

    async function handleVideoBranchAction(button) {
        const action = button.dataset.action;
        const cardId = button.dataset.cardId;
        const branchId = button.dataset.branchId;
        const targetBranchId = button.dataset.targetBranchId || null;
        const branch = (canvasRuntime.videoCardBranches.get(cardId) || [])
            .find(item => item.id === branchId);
        if (!action || !cardId || !branchId) return;
        if (action !== 'set_primary') {
            const labels = {
                close: videoCardUiText.closeBranch,
                merge: videoCardUiText.mergeBranch,
                promote_to_card: videoCardUiText.promoteBranch
            };
            const confirmed = await requestCanvasConfirmation({
                title: labels[action] || videoCardUiText.branches,
                message: `\u786e\u8ba4\u5904\u7406\u65b9\u5411\u300c${branch?.title || branchId}\u300d\uff1f`,
                detail: branch?.description || branch?.status || '',
                confirmLabel: labels[action] || videoCardUiText.operations,
                danger: action === 'close'
            });
            if (!confirmed) return;
        }
        await executeVideoBranchAction('branch-action', {
            cardId,
            branchId,
            action,
            targetBranchId
        });
        showCanvasNotice('\u65b9\u5411\u72b6\u6001\u5df2\u66f4\u65b0\u3002', 'info');
    }

    function cachedVideoTask(taskId) {
        for (const tasks of canvasRuntime.videoCardTasks.values()) {
            const task = tasks.find(item => item.id === taskId);
            if (task) return task;
        }
        return null;
    }

    function refreshVideoTaskNode(task, nodeId = '') {
        if (!task?.id) return;
        const nodeIds = nodeId
            ? [nodeId]
            : Array.from(engine.nodes.values())
                .filter(node => node.type === 'video' && node.data?.taskId === task.id)
                .map(node => node.id);
        nodeIds.forEach(id => {
            const node = engine.nodes.get(id);
            if (!node) return;
            if (node.data.taskId !== task.id) { applyVideoTaskStatus(id, task); return; }
            node.data = {
                ...node.data,
                videoCardId: task.video_card_id || node.data?.videoCardId || canvasRuntime.selectedVideoCardId,
                videoBranchId: task.video_branch_id || node.data?.videoBranchId || null,
                versionRole: task.version_role || node.data?.versionRole || 'normal'
            };
            applyVideoTaskStatus(id, task);
        });
        if (nodeIds.length) scheduleCanvasSave('video_task_refresh');
    }

    async function executeVideoTaskVersion(cardId, taskId, role) {
        const operation = role === 'candidate'
            ? 'version-candidate'
            : role === 'best' ? 'version-best' : 'version-final';
        const descriptor = window.UltimateCanvasVideoCards.requestFor(operation, { cardId, taskId });
        await requestJson(descriptor.url, { method: descriptor.method, payload: descriptor.payload });
        invalidateVideoCardWorkspace(cardId);
        await refreshProjectVideoCards();
        const workspace = await loadVideoCardWorkspace(cardId, { force: true });
        const updatedTask = workspace?.tasks?.find(task => task.id === taskId);
        if (updatedTask) refreshVideoTaskNode(updatedTask);
        renderRuntimeContextControls();
        return updatedTask || null;
    }

    async function retryVideoTask(taskId, nodeId = '', cardId = '') {
        const sourceTask = cachedVideoTask(taskId);
        const descriptor = window.UltimateCanvasVideoCards.requestFor('task-retry', { taskId });
        const result = await requestJson(descriptor.url, {
            method: descriptor.method,
            payload: descriptor.payload
        });
        const nextTaskId = result?.id || result?.task_id;
        if (!nextTaskId) throw new Error('\u91cd\u8bd5\u6210\u529f\u4f46\u672a\u8fd4\u56de\u65b0\u4efb\u52a1 ID\u3002');

        let targetNodeId = nodeId || Array.from(engine.nodes.values())
            .find(node => node.type === 'video' && node.data?.taskId === taskId)?.id;
        const resolvedCardId = result.video_card_id || cardId || sourceTask?.video_card_id || canvasRuntime.selectedVideoCardId;
        const resolvedBranchId = result.video_branch_id || sourceTask?.video_branch_id || canvasRuntime.selectedVideoBranchId;
        if (!targetNodeId) {
            const center = canvasCenter();
            targetNodeId = engine.addNode('video', center.x, center.y, {
                title: sourceTask?.prompt || '\u89c6\u9891\u91cd\u8bd5\u4efb\u52a1',
                prompt: sourceTask?.prompt || '',
                videoCardId: resolvedCardId,
                videoBranchId: resolvedBranchId
            });
        }

        stopVideoPolling(taskId);
        const node = engine.nodes.get(targetNodeId);
        if (node) {
            releaseInlineVideos(targetNodeId);
            node.data = {
                ...node.data,
                taskId: nextTaskId,
                providerTaskId: result.provider_task_id || null,
                videoCardId: resolvedCardId,
                videoBranchId: resolvedBranchId,
                generationStatus: result.local_status || result.status || 'submitted',
                generationResult: result,
                videoPreviewUrl: '', videoDownloadUrl: '', thumbnailUrl: '', resultVideoUrl: '', resultLastFrameUrl: '',
                stableDownloadReady: false, previewAvailable: false, playableAvailable: false, videoPlaybackPosition: null,
                versionRole: 'normal'
            };
        }
        refreshVideoTaskNode({
            ...result,
            id: nextTaskId,
            video_card_id: resolvedCardId,
            video_branch_id: resolvedBranchId,
            version_role: 'normal'
        }, targetNodeId);
        pollVideoTask(nextTaskId, targetNodeId);
        if (resolvedCardId) {
            invalidateVideoCardWorkspace(resolvedCardId);
            await loadVideoCardWorkspace(resolvedCardId, { force: true }).catch(() => null);
        }
        renderRuntimeContextControls();
        return result;
    }

    async function moveVideoTasks(form) {
        const cardId = form.dataset.cardId;
        const taskIds = Array.from(selectedVideoTaskIds(cardId));
        const targetCardId = form.elements.target_card_id?.value;
        if (!taskIds.length) throw new Error('\u8bf7\u5148\u9009\u62e9\u8981\u8fc1\u79fb\u7684\u4efb\u52a1\u3002');
        const descriptor = window.UltimateCanvasVideoCards.requestFor('tasks-move', {
            cardId,
            targetCardId,
            taskIds,
            targetBranchId: form.elements.target_branch_id?.value || null,
            reason: form.elements.reason?.value?.trim() || null
        });
        const result = await requestJson(descriptor.url, { method: descriptor.method, payload: descriptor.payload });
        selectedVideoTaskIds(cardId).clear();
        invalidateVideoCardWorkspace(cardId);
        invalidateVideoCardWorkspace(targetCardId);
        await refreshProjectVideoCards();
        await loadVideoCardWorkspace(cardId, { force: true });
        renderRuntimeContextControls();
        return result;
    }

    async function splitVideoCard(form) {
        const cardId = form.dataset.cardId;
        const taskIds = Array.from(selectedVideoTaskIds(cardId));
        if (!taskIds.length) throw new Error('\u8bf7\u5148\u9009\u62e9\u8981\u62c6\u5206\u7684\u4efb\u52a1\u3002');
        const descriptor = window.UltimateCanvasVideoCards.requestFor('card-split', {
            cardId,
            title: form.elements.title?.value?.trim(),
            taskIds,
            reason: form.elements.reason?.value?.trim() || null
        });
        const result = await requestJson(descriptor.url, { method: descriptor.method, payload: descriptor.payload });
        selectedVideoTaskIds(cardId).clear();
        invalidateVideoCardWorkspace(cardId);
        await refreshProjectVideoCards();
        await loadVideoCardWorkspace(cardId, { force: true });
        renderRuntimeContextControls();
        return result;
    }

    async function mergeVideoCard(form) {
        const cardId = form.dataset.cardId;
        const targetCardId = form.elements.target_card_id?.value;
        if (cardId === canvasRuntime.selectedVideoCardId) {
            const saved = await flushCanvasSave('before_video_card_merge');
            if (!saved) throw new Error('\u753b\u5e03\u4fdd\u5b58\u5931\u8d25\uff0c\u5df2\u53d6\u6d88\u5408\u5e76\u3002');
        }
        const descriptor = window.UltimateCanvasVideoCards.requestFor('card-merge', {
            cardId,
            targetCardId,
            reason: form.elements.reason?.value?.trim() || null
        });
        const result = await requestJson(descriptor.url, { method: descriptor.method, payload: descriptor.payload });
        stopAllVideoPolling();
        invalidateVideoCardWorkspace(cardId);
        invalidateVideoCardWorkspace(targetCardId);
        await refreshProjectVideoCards();
        await loadCanvasBootstrap(canvasRuntime.selectedProjectId, targetCardId, { restoreDocument: false });
        canvasRuntime.videoCardView = {
            ...canvasRuntime.videoCardView,
            mode: 'detail',
            section: 'tasks',
            cardId: targetCardId
        };
        await loadVideoCardWorkspace(targetCardId, { force: true });
        renderRuntimeContextControls();
        scheduleCanvasSave('video_card_merge');
        return result;
    }

    function changedVideoCardValues(form) {
        const values = {};
        const nullable = new Set(['objective', 'platform', 'ratio', 'target_resolution']);
        const numeric = new Set(['duration', 'budget_credits']);
        [
            'title',
            'objective',
            'platform',
            'ratio',
            'duration',
            'target_resolution',
            'budget_credits',
            'budget_currency'
        ].forEach(name => {
            const field = form.elements[name];
            if (!field || field.disabled) return;
            const current = String(field.value ?? '').trim();
            const original = String(field.dataset.original ?? '').trim();
            if (current === original) return;
            if (numeric.has(name)) {
                values[name] = current === '' ? null : Number(current);
            } else if (nullable.has(name)) {
                values[name] = current || null;
            } else {
                values[name] = current;
            }
        });
        return values;
    }

    async function confirmVideoCardLifecycle(operation, cardId) {
        const detail = canvasRuntime.videoCardDetails.get(cardId);
        const card = detail?.video_card
            || canvasRuntime.bootstrap?.context?.video_cards?.find(item => item.id === cardId);
        if (!card) return;
        const labels = {
            'card-seal': videoCardUiText.seal,
            'card-archive': videoCardUiText.archive,
            'card-discard': videoCardUiText.discard
        };
        const label = labels[operation] || videoCardUiText.operations;
        const taskCount = card.summary?.task_count || canvasRuntime.videoCardTasks.get(cardId)?.length || 0;
        const branchCount = canvasRuntime.videoCardBranches.get(cardId)?.length || 0;
        const confirmed = await requestCanvasConfirmation({
            title: label,
            message: `\u786e\u8ba4\u5bf9\u89c6\u9891\u5361\u300c${card.title || card.id}\u300d\u6267\u884c${label}\uff1f`,
            detail: `\u72b6\u6001 ${card.status || '-'} \u00b7 \u4efb\u52a1 ${taskCount} \u00b7 \u65b9\u5411 ${branchCount}`,
            confirmLabel: label,
            danger: operation === 'card-discard'
        });
        if (!confirmed) return;
        await executeVideoCardOperation(operation, { cardId });
        showCanvasNotice(`\u89c6\u9891\u5361\u5df2${label}\u3002`, 'info');
    }

    function uniqueList(items) {
        return Array.from(new Set((items || []).filter(Boolean)));
    }

    function referenceIdsFromNodeData(data = {}) {
        return window.UltimateCanvasGenerationInteractions.referenceIdsFromNodeData(data);
    }

    function referenceUrlsFromNodeData(data = {}) {
        const urls = [];
        ['previewImage', 'referenceImage', 'imageUrl', 'thumbnailUrl', 'originalUrl'].forEach(key => {
            if (typeof data[key] === 'string' && /^https?:\/\//i.test(data[key])) urls.push(data[key]);
        });
        if (data.generationResult?.imageUrl) urls.push(data.generationResult.imageUrl);
        if (Array.isArray(data.generationResult?.assets)) {
            data.generationResult.assets.forEach(asset => {
                if (asset?.originalUrl) urls.push(asset.originalUrl);
                if (asset?.thumbnailUrl) urls.push(asset.thumbnailUrl);
            });
        }
        return urls;
    }

    function collectReferenceImageIds(payload) {
        const ids = [...referenceIdsFromNodeData(payload || {})];
        (payload.sourceNodes || []).forEach(source => {
            ids.push(...referenceIdsFromNodeData(source.data || {}));
        });
        return uniqueList(ids);
    }

    function collectWorkspaceReferenceImageIds(payload) {
        const ids = [];
        const collect = (data = {}) => {
            const hasWorkspaceBinding = Boolean(data.workspaceAssetId || data.workspace_asset_id);
            if (hasWorkspaceBinding) ids.push(...referenceIdsFromNodeData(data));
        };
        collect(payload || {});
        (payload.sourceNodes || []).forEach(source => collect(source.data || {}));
        return uniqueList(ids);
    }

    function collectReferenceImageUrls(payload) {
        const urls = [...referenceUrlsFromNodeData(payload || {})];
        (payload.sourceNodes || []).forEach(source => {
            urls.push(...referenceUrlsFromNodeData(source.data || {}));
        });
        return uniqueList(urls).filter(url => /^https:\/\//i.test(url)).slice(0, 9);
    }

    function imageActionForMode(mode) {
        const map = {
            'text-to-image': 'text_to_image_reference',
            'image-to-image': 'image_variant',
            'upscale-image': 'image_variant',
            'first-frame-draft': 'first_frame_draft',
            'last-frame-draft': 'last_frame_draft',
            'image-reference': 'storyboard_keyframes'
        };
        return map[mode] || 'text_to_image_reference';
    }

    function videoModeForCanvasMode(mode) {
        if (mode === 'first-last-frame-video') return 'first_last_frame';
        if (mode === 'smart-multi-frame-video') return 'smart_multi_frame';
        return 'all_in_one_reference';
    }

    function ratioFromContext() {
        return selectedVideoCard()?.ratio || '16:9';
    }

    function durationFromContext() {
        const duration = Number(selectedVideoCard()?.duration || 5);
        return Number.isFinite(duration) ? duration : 5;
    }

    function resolutionFromContext() {
        const value = selectedVideoCard()?.target_resolution || '720p';
        return ['480p', '720p', '1080p'].includes(value) ? value : '720p';
    }

    function baseContextPayload(payload) {
        return {
            ...window.UltimateCanvasVideoCards.generationContext({
                projectId: canvasRuntime.selectedProjectId,
                cardId: canvasRuntime.selectedVideoCardId,
                branchId: payload.videoBranchId || canvasRuntime.selectedVideoBranchId,
                documentId: canvasRuntime.documentId,
                nodeId: payload.nodeId,
                tabId: canvasWorkspaceKey()
            }),
            client_name: 'ultimate_canvas',
            source_request_id: `ultimate_canvas:${payload.nodeId}:${payload.requestId || Date.now()}`
        };
    }

    function installGenerationAdapter() {
        if (!window.CanvasGenerationAPI?.setAdapter) return;
        window.CanvasGenerationAPI.setAdapter({
            async generate(payload) {
                const capabilities = canvasRuntime.bootstrap?.capabilities || {};
                if (payload.kind === 'text' || payload.kind === 'script') {
                    const endpoint = payload.kind === 'script'
                        ? backendEndpoint(capabilities.script?.endpoint, '/api/tools/ultimate-canvas/generate', 'script')
                        : backendEndpoint(capabilities.text?.endpoint, '/api/tools/ultimate-canvas/generate', 'text');
                    return postJson(endpoint, {
                        ...payload,
                        ...baseContextPayload(payload)
                    }, { policy: payload.kind });
                }

                if (payload.kind === 'image') {
                    if (engine.nodes.get(payload.nodeId)?.data?.canvasStyle) {
                        return canvasStyles.generate(payload, promptWithConnectedText(payload));
                    }
                    payload = { ...payload, referenceImageIds: payload.referenceImageIds || collectReferenceImageIds(payload) };
                    const result = await canvasStyles.generateOrdinary(payload, promptWithConnectedText(payload));
                    if (!result.legacyRequired) return result;
                    const descriptor = window.UltimateCanvasGenerationNodes.imageRequest({
                        projectId: canvasRuntime.selectedProjectId,
                        cardId: canvasRuntime.selectedVideoCardId,
                        branchId: payload.videoBranchId || canvasRuntime.selectedVideoBranchId,
                        documentId: canvasRuntime.documentId,
                        nodeId: payload.nodeId,
                        workspaceKey: canvasWorkspaceKey(),
                        requestId: payload.requestId,
                        mode: payload.mode,
                        prompt: promptWithConnectedText(payload),
                        ...(payload.promptMentions ? { promptMentions: payload.promptMentions } : {}),
                        referenceImageIds: payload.referenceImageIds || collectReferenceImageIds(payload),
                        settings: payload.settings || {}
                    });
                    descriptor.url = backendEndpoint(capabilities.image?.endpoint, descriptor.url, 'image');
                    const data = await requestJson(descriptor.url, {
                        method: descriptor.method,
                        payload: descriptor.payload,
                        policy: 'image'
                    });
                    const normalized = window.UltimateCanvasGenerationNodes.normalizeImageResult(data);
                    return {
                        ...data,
                        ...normalized,
                        message: '图片生成完成，已进入资产库',
                        previewImage: normalized.imageUrl,
                        asset_id: normalized.assetId,
                        reference_image_id: normalized.referenceImageId,
                        workspace_asset_id: normalized.workspaceAssetId
                    };
                }

                if (payload.kind === 'video') {
                    const context = currentGenerationContext(payload.nodeId);
                    const node = engine.nodes.get(payload.nodeId);
                    const prior = node?.data?.videoSubmission;
                    const unsent = prior?.requestId === payload.requestId && canvasRuntime.unsentVideoRequests.get(payload.nodeId) === prior;
                    if (!node || (prior?.state === 'unconfirmed' && !unsent)) throw Error('提交结果待确认，请查询已有请求；不会重复提交。');
                    const descriptor = window.UltimateCanvasGenerationNodes.videoRequest({
                        projectId: canvasRuntime.selectedProjectId,
                        cardId: canvasRuntime.selectedVideoCardId,
                        branchId: payload.videoBranchId || canvasRuntime.selectedVideoBranchId,
                        documentId: canvasRuntime.documentId,
                        nodeId: payload.nodeId,
                        workspaceKey: canvasWorkspaceKey(),
                        requestId: payload.requestId,
                        mode: payload.mode,
                        prompt: promptWithConnectedText(payload),
                        promptUserEdited: true,
                        ...(payload.promptMentions ? { promptMentions: payload.promptMentions } : {}),
                        referenceImageIds: payload.referenceImageIds || collectReferenceImageIds(payload),
                        settings: payload.settings || {}
                    });
                    descriptor.url = backendEndpoint(descriptor.url, '', 'video');
                    if (unsent) descriptor.payload = structuredClone(prior.input);
                    const submission = unsent ? prior : { requestId: payload.requestId, state: 'unconfirmed',
                        userId: canvasRuntime.bootstrap?.user?.id, documentId: canvasRuntime.documentId,
                        projectId: canvasRuntime.selectedProjectId, cardId: canvasRuntime.selectedVideoCardId,
                        input: structuredClone(descriptor.payload), generationPayload: structuredClone(payload) };
                    prepareVideoSubmissionView(node);
                    node.data.videoSubmission = submission;
                    canvasRuntime.unsentVideoRequests.set(payload.nodeId, submission);
                    node.data.generationStatus = 'unconfirmed';
                    decorateGeneratedNode(node.id, '视频生成任务', '提交结果待确认，不会重复生成');
                    scheduleCanvasSave('video_before_submit');
                    cacheCanvasDraft(canvasSaveSnapshot('video_before_submit'));
                    // This persisted uncertainty barrier precedes the POST, including a crash between the two.
                    if (!await flushCanvasSave('video_before_submit')) {
                        throw Error('请求未发送：完整输入尚未安全保存，请保留草稿并重试保存。');
                    }
                    if (!window.UltimateCanvasGenerationInteractions.generationContextMatches(context, currentGenerationContext(payload.nodeId))
                        || node.data.videoSubmission !== submission) throw Error('画布已切换，请在原画布查询此请求；不会提交。');
                    canvasRuntime.unsentVideoRequests.delete(payload.nodeId);
                    const data = await requestJson(descriptor.url, {
                        method: descriptor.method,
                        payload: descriptor.payload,
                        policy: 'video'
                    });
                    const normalized = window.UltimateCanvasGenerationNodes.normalizeVideoCreate(data);
                    return {
                        ...data,
                        ...normalized,
                        task_id: normalized.taskId,
                        provider_task_id: normalized.providerTaskId,
                        frozen_cost: normalized.frozenCost,
                        message: normalized.submissionUnconfirmed ? '上游受理未确认，请查询原请求，不要重新生成' : '视频任务已提交，正在轮询状态',
                        statusEndpoint: `${payload.settings?.provider === 'volcengine_ip' ? '/api/ip' : '/api'}/video/status/${normalized.taskId}?refresh=true`
                    };
                }

                throw new Error('当前节点类型还没有正式生成接口。');
            }
        });
    }

    function selectedProjectFromBootstrap(data) {
        const projectId = data?.context?.selected_project_id;
        return data?.context?.projects?.find(project => project.id === projectId) || null;
    }

    function selectedVideoCardFromBootstrap(data) {
        const videoCardId = data?.context?.selected_video_card_id;
        return data?.context?.video_cards?.find(card => card.id === videoCardId) || null;
    }

    function isCanvasAdmin() {
        return canvasRuntime.bootstrap?.user?.role === 'admin';
    }

    function normalizeContextRules(value) {
        return typeof value === 'string' ? value : '';
    }

    function contextRulesForNode(node) {
        return normalizeContextRules(node?.data?.contextRules ?? node?.data?.context_rules);
    }

    function refreshContextRulesButtons(root = document) {
        const rulesModal = document.querySelector('[data-context-rules-modal]');
        if (rulesModal && !rulesOwnerMatches(rulesModal)) closeContextRulesModal(true);
        document.body.classList.toggle('is-canvas-admin', isCanvasAdmin());
        root.querySelectorAll?.('.canvas-node').forEach(nodeEl => {
            const node = engine.nodes.get(nodeEl.dataset.nodeId);
            const hasRules = Boolean(contextRulesForNode(node));
            nodeEl.querySelectorAll('[data-context-rules-open]').forEach(button => {
                button.classList.toggle('has-rules', hasRules);
                button.title = hasRules
                    ? '已设置上下文规则，点击编辑'
                    : '编辑影响本节点 LLM 上下文的规则';
                button.setAttribute('aria-label', button.title);
            });
        });
    }

    function formatCredits(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return '0';
        if (Math.abs(number) >= 1000) return Math.round(number).toLocaleString('zh-CN');
        return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/\.?0+$/, '');
    }

    function projectDisplayNameFor(project) {
        if (!project) return '选择项目';
        return project.display_name || (project.type === 'personal' ? '个人空间' : project.name) || '未命名项目';
    }

    function projectMetaFor(project) {
        if (!project) return '选择生成内容的归属项目';
        if (project.meta_label) return project.meta_label;
        const kind = project.type === 'personal' ? '个人默认' : project.type === 'public' ? '预算记账项目' : '协作项目';
        return `${kind} · ${project._count?.tasks || 0} 任务 · ${project._count?.reference_albums || 0} 图集`;
    }

    function ownerIdentity(owner, fallbackId = '') {
        const value = owner || {};
        return {
            id: value.id || fallbackId || '',
            name: value.name || value.username || value.email || '未知用户',
            avatarUrl: value.avatar_url || ''
        };
    }

    function avatarHue(seed) {
        let hash = 0;
        String(seed || 'canvas').split('').forEach(char => {
            hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
        });
        return Math.abs(hash) % 360;
    }

    function identityAvatarHtml(owner, fallbackId = '', className = '') {
        const identity = ownerIdentity(owner, fallbackId);
        const classes = `context-avatar ${className}`.trim();
        if (identity.avatarUrl) {
            return `<span class="${classes}"><img src="${escapeHtml(identity.avatarUrl)}" alt=""></span>`;
        }
        const initial = identity.name.trim().slice(0, 1).toUpperCase() || 'U';
        return `<span class="${classes}" style="--avatar-hue:${avatarHue(identity.id || identity.name)}">${escapeHtml(initial)}</span>`;
    }

    function contextChevronHtml() {
        return '<svg class="context-trigger-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
    }

    function projectMenuHtml(projects, selectedProjectId) {
        const groups = [
            { key: 'owned', label: '我的项目' },
            { key: 'joined', label: '参与项目' },
            { key: 'other', label: '其他项目' }
        ];
        const sections = groups.map(group => {
            const items = projects.filter(project => (project.group || 'owned') === group.key);
            if (!items.length) return '';
            return `
                <div class="context-menu-group">
                    <div class="context-menu-group-label">${group.label}</div>
                    ${items.map(project => {
                        const owner = ownerIdentity(project.owner, project.owner_user_id);
                        const selected = project.id === selectedProjectId;
                        const removalAction = project.removal_action || '';
                        return `
                            <div class="context-menu-row ${selected ? 'is-selected' : ''}">
                                <button type="button" class="context-menu-row-main" data-project-select="${escapeHtml(project.id)}" ${canvasRuntime.contextSwitching ? 'disabled' : ''}>
                                    ${identityAvatarHtml(project.owner, project.owner_user_id)}
                                    <span class="context-menu-row-copy">
                                        <span class="context-menu-row-title">${escapeHtml(projectDisplayNameFor(project))}</span>
                                        <span class="context-menu-row-owner">${escapeHtml(owner.name)}</span>
                                        <span class="context-menu-row-meta">${escapeHtml(projectMetaFor(project))}</span>
                                    </span>
                                    <span class="context-menu-check" aria-hidden="true">${selected ? '✓' : ''}</span>
                                </button>
                                ${removalAction ? `
                                    <button type="button" class="context-row-action ${removalAction === 'delete' ? 'danger' : ''}"
                                        data-project-remove="${escapeHtml(project.id)}"
                                        data-removal-action="${escapeHtml(removalAction)}"
                                        title="${escapeHtml(project.removal_reason || (removalAction === 'delete' ? '删除空项目' : '归档项目'))}">
                                        ${removalAction === 'delete' ? '删除' : '归档'}
                                    </button>
                                ` : ''}
                            </div>`;
                    }).join('')}
                </div>`;
        }).join('');

        return `
            <div class="canvas-context-menu ${canvasRuntime.openContextMenu === 'project' ? 'is-open' : ''}" data-context-menu="project">
                <div class="context-menu-head">
                    <span><strong>项目列表</strong><small>${projects.length} 个可生成项目</small></span>
                    <button type="button" class="context-command" data-project-create-toggle>${canvasRuntime.projectCreateOpen ? '取消' : '新建项目'}</button>
                </div>
                ${canvasRuntime.projectCreateOpen ? `
                    <form class="context-create-form" data-project-create-form>
                        <label>项目名称<input name="project_name" maxlength="80" autocomplete="off" placeholder="例如：品牌短片" required></label>
                        <button type="submit" class="context-primary-command" ${canvasRuntime.contextSwitching ? 'disabled' : ''}>创建并选中</button>
                    </form>
                ` : ''}
                <div class="context-menu-list">
                    ${sections || '<div class="context-menu-empty">还没有可用项目，可以先新建一个。</div>'}
                </div>
                <a class="context-menu-footer-link" href="/projects" target="_top">打开项目管理</a>
            </div>`;
    }

    function videoCardSpecFor(card) {
        if (!card) return '选择或新建视频卡';
        return card.spec_label || [card.platform, card.ratio, card.duration ? `${card.duration}s` : '', card.target_resolution]
            .filter(Boolean).join(' · ') || '未设置生成规格';
    }

    function videoCardStatusFor(card) {
        return card?.status_label || card?.status || '未选择';
    }

    const videoCardUiText = {
        title: '\u89c6\u9891\u5361',
        back: '\u8fd4\u56de\u5217\u8868',
        refresh: '\u5237\u65b0',
        search: '\u641c\u7d22\u89c6\u9891\u5361',
        manage: '\u539f\u4f4d\u7ba1\u7406',
        info: '\u4fe1\u606f',
        branches: '\u65b9\u5411',
        tasks: '\u8bb0\u5f55',
        operations: '\u64cd\u4f5c',
        loading: '\u6b63\u5728\u8bfb\u53d6\u89c6\u9891\u5361\u8be6\u60c5...',
        emptyBranches: '\u6682\u65e0\u65b9\u5411\u5206\u652f',
        emptyTasks: '\u6682\u65e0\u751f\u6210\u8bb0\u5f55',
        retry: '\u91cd\u8bd5',
        taskCount: '\u751f\u6210\u6b21\u6570',
        owner: '\u8d1f\u8d23\u4eba',
        status: '\u72b6\u6001',
        spec: '\u4ea4\u4ed8\u89c4\u683c',
        save: '\u4fdd\u5b58\u4fee\u6539',
        cardTitle: '\u6807\u9898',
        objective: '\u89c6\u9891\u76ee\u6807',
        platform: '\u5e73\u53f0',
        ratio: '\u6bd4\u4f8b',
        duration: '\u65f6\u957f\uff08\u79d2\uff09',
        resolution: '\u76ee\u6807\u5206\u8fa8\u7387',
        budget: '\u9884\u7b97\u70b9\u6570',
        currency: '\u9884\u7b97\u5e01\u79cd',
        seal: '\u5c01\u677f',
        archive: '\u5f52\u6863',
        discard: '\u5e9f\u5f03',
        ratioApproval: '\u7533\u8bf7\u6bd4\u4f8b\u53d8\u66f4',
        reopenApproval: '\u7533\u8bf7\u91cd\u5f00',
        targetRatio: '\u76ee\u6807\u6bd4\u4f8b',
        reason: '\u539f\u56e0',
        submitApproval: '\u63d0\u4ea4\u7533\u8bf7',
        createBranch: '\u65b0\u5efa\u65b9\u5411',
        branchTitle: '\u65b9\u5411\u540d\u79f0',
        branchDescription: '\u65b9\u5411\u8bf4\u660e',
        selectBranch: '\u9009\u62e9',
        selectedBranch: '\u5df2\u9009',
        setPrimary: '\u8bbe\u4e3a\u4e3b\u65b9\u5411',
        closeBranch: '\u5173\u95ed',
        mergeBranch: '\u5408\u5e76\u5230\u4e3b\u65b9\u5411',
        promoteBranch: '\u5347\u683c\u4e3a\u89c6\u9891\u5361',
        branchCount: '\u65b9\u5411\u6570',
        candidate: '\u6807\u8bb0\u5019\u9009',
        best: '\u5f53\u524d\u6700\u4f73',
        final: '\u6700\u7ec8\u7248',
        retryTask: '\u91cd\u8bd5',
        play: '\u64ad\u653e',
        download: '\u4e0b\u8f7d',
        moveTasks: '\u8fc1\u79fb\u6240\u9009\u4efb\u52a1',
        splitCard: '\u62c6\u5206\u4e3a\u65b0\u89c6\u9891\u5361',
        mergeCard: '\u5408\u5e76\u5230\u76ee\u6807\u5361',
        targetCard: '\u76ee\u6807\u89c6\u9891\u5361',
        targetBranch: '\u76ee\u6807\u65b9\u5411',
        newCardTitle: '\u65b0\u89c6\u9891\u5361\u6807\u9898',
        noBranch: '\u4e0d\u6307\u5b9a\u65b9\u5411',
        selectedTasks: '\u5df2\u9009\u4efb\u52a1',
        operationHint: '\u5361\u7247\u7ba1\u7406\u64cd\u4f5c\u4f1a\u6839\u636e\u5f53\u524d\u6743\u9650\u548c\u72b6\u6001\u663e\u793a\u3002'
    };

    function videoCardSelectOptions(values, selected) {
        return values.map(value => `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('');
    }

    function videoCardInfoFormHtml(detail) {
        const card = detail?.video_card;
        if (!card) return '';
        const canEdit = window.UltimateCanvasVideoCards.operationAllowed(detail, 'card-update');
        const disabled = canEdit ? '' : 'disabled';
        const ratioLocked = Boolean(card.ratio_locked || card.project?.type === 'public' || card.final_task_id);
        const canRequestApproval = Boolean(detail?.video_card);
        const ratioDisabled = canEdit && !ratioLocked ? '' : 'disabled';
        const duration = card.duration ?? 5;
        const budget = card.budget_credits ?? '';
        return `
            <form class="video-card-info-form" data-video-card-info-form data-card-id="${escapeHtml(card.id)}">
                <div class="video-card-form-grid">
                    <label><span>${escapeHtml(videoCardUiText.cardTitle)}</span><input name="title" value="${escapeHtml(card.title || '')}" data-original="${escapeHtml(card.title || '')}" maxlength="120" required ${disabled}></label>
                    <label><span>${escapeHtml(videoCardUiText.platform)}</span><input name="platform" value="${escapeHtml(card.platform || '')}" data-original="${escapeHtml(card.platform || '')}" maxlength="80" ${disabled}></label>
                    <label class="is-wide"><span>${escapeHtml(videoCardUiText.objective)}</span><textarea name="objective" data-original="${escapeHtml(card.objective || '')}" maxlength="1000" rows="3" ${disabled}>${escapeHtml(card.objective || '')}</textarea></label>
                    <label><span>${escapeHtml(videoCardUiText.ratio)}</span><select name="ratio" data-original="${escapeHtml(card.ratio || '')}" ${ratioDisabled}>${videoCardSelectOptions(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], card.ratio || '16:9')}</select></label>
                    <label><span>${escapeHtml(videoCardUiText.duration)}</span><input name="duration" type="number" min="4" max="15" step="1" value="${escapeHtml(duration)}" data-original="${escapeHtml(duration)}" ${disabled}></label>
                    <label><span>${escapeHtml(videoCardUiText.resolution)}</span><select name="target_resolution" data-original="${escapeHtml(card.target_resolution || '')}" ${disabled}>${videoCardSelectOptions(['480p', '720p', '1080p'], card.target_resolution || '720p')}</select></label>
                    <label><span>${escapeHtml(videoCardUiText.budget)}</span><input name="budget_credits" type="number" min="0" step="0.01" value="${escapeHtml(budget)}" data-original="${escapeHtml(budget)}" ${disabled}></label>
                    <label><span>${escapeHtml(videoCardUiText.currency)}</span><input name="budget_currency" value="${escapeHtml(card.budget_currency || 'credits')}" data-original="${escapeHtml(card.budget_currency || 'credits')}" maxlength="16" ${disabled}></label>
                </div>
                ${canEdit ? `<div class="video-card-form-actions"><button type="submit" class="context-primary-command">${escapeHtml(videoCardUiText.save)}</button></div>` : ''}
            </form>
            ${ratioLocked && canRequestApproval ? `
                <form class="video-card-inline-approval" data-video-card-approval-ratio data-card-id="${escapeHtml(card.id)}">
                    <strong>${escapeHtml(videoCardUiText.ratioApproval)}</strong>
                    <label><span>${escapeHtml(videoCardUiText.targetRatio)}</span><select name="target_ratio" required>${videoCardSelectOptions(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], card.ratio || '16:9')}</select></label>
                    <label class="is-wide"><span>${escapeHtml(videoCardUiText.reason)}</span><input name="reason" minlength="2" maxlength="300" required></label>
                    <button type="submit" class="context-command">${escapeHtml(videoCardUiText.submitApproval)}</button>
                </form>` : ''}`;
    }

    function videoCardBranchesHtml(detail, branches) {
        const card = detail?.video_card;
        if (!card) return '';
        const canManage = Boolean(detail?.permissions?.can_manage);
        const activeBranches = window.UltimateCanvasVideoCards.activeBranches(branches);
        const primary = activeBranches.find(branch => branch.is_primary || branch.status === 'primary');
        const rows = branches.map(branch => {
            const isActive = activeBranches.some(item => item.id === branch.id);
            const isSelected = branch.id === canvasRuntime.selectedVideoBranchId;
            const actionButtons = canManage && isActive ? `
                ${!branch.is_primary ? `<button type="button" data-video-branch-action data-action="set_primary" data-card-id="${escapeHtml(card.id)}" data-branch-id="${escapeHtml(branch.id)}">${escapeHtml(videoCardUiText.setPrimary)}</button>` : ''}
                ${!branch.is_primary ? `<button type="button" data-video-branch-action data-action="close" data-card-id="${escapeHtml(card.id)}" data-branch-id="${escapeHtml(branch.id)}">${escapeHtml(videoCardUiText.closeBranch)}</button>` : ''}
                ${primary && primary.id !== branch.id ? `<button type="button" data-video-branch-action data-action="merge" data-card-id="${escapeHtml(card.id)}" data-branch-id="${escapeHtml(branch.id)}" data-target-branch-id="${escapeHtml(primary.id)}">${escapeHtml(videoCardUiText.mergeBranch)}</button>` : ''}
                <button type="button" data-video-branch-action data-action="promote_to_card" data-card-id="${escapeHtml(card.id)}" data-branch-id="${escapeHtml(branch.id)}">${escapeHtml(videoCardUiText.promoteBranch)}</button>
            ` : '';
            return `
                <div class="video-card-branch-row ${isSelected ? 'is-selected' : ''}">
                    <button type="button" class="video-card-branch-main" data-video-branch-select="${escapeHtml(branch.id)}" ${isActive ? '' : 'disabled'}>
                        <span><strong>${escapeHtml(branch.title || branch.id)}</strong><small>${escapeHtml(branch.description || branch.status || '')}</small></span>
                        <small>${escapeHtml(branch.summary?.task_count || 0)} · ${escapeHtml(isSelected ? videoCardUiText.selectedBranch : branch.status || '')}</small>
                    </button>
                    ${actionButtons ? `<div class="video-card-branch-actions">${actionButtons}</div>` : ''}
                </div>`;
        }).join('');
        return `
            ${canManage ? `
                <form class="video-card-branch-create-form" data-video-branch-create-form data-card-id="${escapeHtml(card.id)}">
                    <label><span>${escapeHtml(videoCardUiText.branchTitle)}</span><input name="title" maxlength="80" required></label>
                    <label><span>${escapeHtml(videoCardUiText.branchDescription)}</span><input name="description" maxlength="300"></label>
                    <button type="submit" class="context-primary-command">${escapeHtml(videoCardUiText.createBranch)}</button>
                </form>` : ''}
            ${rows ? `<div class="video-card-branch-list">${rows}</div>` : `<div class="context-menu-empty">${escapeHtml(videoCardUiText.emptyBranches)}</div>`}`;
    }

    function selectedVideoTaskIds(cardId) {
        if (!canvasRuntime.videoCardSelectedTaskIds.has(cardId)) {
            canvasRuntime.videoCardSelectedTaskIds.set(cardId, new Set());
        }
        return canvasRuntime.videoCardSelectedTaskIds.get(cardId);
    }

    function videoTaskVersionLabel(role) {
        if (role === 'candidate') return videoCardUiText.candidate;
        if (role === 'current_best') return videoCardUiText.best;
        if (role === 'final') return videoCardUiText.final;
        return role || '';
    }

    function videoCardTargetOptions(cardId) {
        return (canvasRuntime.bootstrap?.context?.video_cards || [])
            .filter(card => card.id !== cardId
                && card.can_manage
                && !['sealed', 'merged', 'archived', 'discarded'].includes(card.status));
    }

    function videoCardTasksHtml(detail, tasks, branches) {
        const card = detail?.video_card;
        if (!card) return '';
        const canManage = Boolean(detail?.permissions?.can_manage);
        const canGenerate = Boolean(detail?.permissions?.can_generate);
        const selectedIds = selectedVideoTaskIds(card.id);
        const branchById = new Map(branches.map(branch => [branch.id, branch]));
        const rows = tasks.map(task => {
            const owner = ownerIdentity(task.owner || task.user, task.owner_user_id || task.user_id);
            const status = task.local_status || task.status || '';
            const successful = status === 'succeeded';
            const retryable = canGenerate && ['succeeded', 'failed', 'cancelled'].includes(status);
            const branch = branchById.get(task.video_branch_id);
            return `
                <div class="video-card-task-row ${selectedIds.has(task.id) ? 'is-selected' : ''}">
                    ${canManage ? `<label class="video-card-task-check"><input type="checkbox" data-video-task-select="${escapeHtml(task.id)}" data-card-id="${escapeHtml(card.id)}" ${selectedIds.has(task.id) ? 'checked' : ''}><span></span></label>` : ''}
                    <div class="video-card-task-main">
                        <strong title="${escapeHtml(task.prompt || task.id)}">${escapeHtml(task.prompt || task.id)}</strong>
                        <small>${escapeHtml(status)} · ${escapeHtml(owner.name)} · ${escapeHtml(branch?.title || videoCardUiText.noBranch)}</small>
                        <small>${escapeHtml(task.actual_cost ?? task.estimated_cost ?? 0)} · ${escapeHtml(task.created_at ? new Date(task.created_at).toLocaleString('zh-CN') : '')}</small>
                    </div>
                    <span class="video-card-task-role">${escapeHtml(videoTaskVersionLabel(task.version_role))}</span>
                    <div class="video-card-task-actions">
                        ${successful ? `<a href="/api/video/play/${encodeURIComponent(task.id)}" target="_blank" rel="noreferrer">${escapeHtml(videoCardUiText.play)}</a><a href="/api/video/download/${encodeURIComponent(task.id)}" target="_blank" rel="noreferrer">${escapeHtml(videoCardUiText.download)}</a>` : ''}
                        ${retryable ? `<button type="button" data-video-task-retry="${escapeHtml(task.id)}" data-card-id="${escapeHtml(card.id)}">${escapeHtml(videoCardUiText.retryTask)}</button>` : ''}
                        ${canManage && successful ? `
                            <button type="button" data-video-task-version="candidate" data-task-id="${escapeHtml(task.id)}" data-card-id="${escapeHtml(card.id)}">${escapeHtml(videoCardUiText.candidate)}</button>
                            <button type="button" data-video-task-version="best" data-task-id="${escapeHtml(task.id)}" data-card-id="${escapeHtml(card.id)}">${escapeHtml(videoCardUiText.best)}</button>
                            <button type="button" data-video-task-version="final" data-task-id="${escapeHtml(task.id)}" data-card-id="${escapeHtml(card.id)}">${escapeHtml(videoCardUiText.final)}</button>` : ''}
                    </div>
                </div>`;
        }).join('');

        const targetCards = videoCardTargetOptions(card.id);
        const targetCardId = targetCards.some(item => item.id === canvasRuntime.videoCardView.targetCardId)
            ? canvasRuntime.videoCardView.targetCardId
            : targetCards[0]?.id || '';
        canvasRuntime.videoCardView.targetCardId = targetCardId;
        if (targetCardId
            && !canvasRuntime.videoCardBranches.has(targetCardId)
            && !canvasRuntime.videoCardLoads.has(targetCardId)) {
            loadVideoCardWorkspace(targetCardId).then(() => {
                if (canvasRuntime.videoCardView.section === 'tasks') renderRuntimeContextControls();
            }).catch(() => null);
        }
        const targetBranches = canvasRuntime.videoCardBranches.get(targetCardId) || [];
        const activeTargetBranches = window.UltimateCanvasVideoCards.activeBranches(targetBranches);
        const selectedCount = selectedIds.size;
        const organizeForms = canManage && tasks.length ? `
            <div class="video-card-task-organize">
                <strong>${escapeHtml(videoCardUiText.selectedTasks)} · ${selectedCount}</strong>
                <form data-video-task-move-form data-card-id="${escapeHtml(card.id)}">
                    <label><span>${escapeHtml(videoCardUiText.targetCard)}</span><select name="target_card_id" data-video-task-target-card required>${targetCards.map(target => `<option value="${escapeHtml(target.id)}" ${target.id === targetCardId ? 'selected' : ''}>${escapeHtml(target.title)}</option>`).join('')}</select></label>
                    <label><span>${escapeHtml(videoCardUiText.targetBranch)}</span><select name="target_branch_id"><option value="">${escapeHtml(videoCardUiText.noBranch)}</option>${activeTargetBranches.map(branch => `<option value="${escapeHtml(branch.id)}">${escapeHtml(branch.title)}</option>`).join('')}</select></label>
                    <label class="is-wide"><span>${escapeHtml(videoCardUiText.reason)}</span><input name="reason" maxlength="300"></label>
                    <button type="submit" class="context-command" ${selectedCount && targetCardId ? '' : 'disabled'}>${escapeHtml(videoCardUiText.moveTasks)}</button>
                </form>
                <form data-video-card-split-form data-card-id="${escapeHtml(card.id)}">
                    <label><span>${escapeHtml(videoCardUiText.newCardTitle)}</span><input name="title" maxlength="120" required></label>
                    <label class="is-wide"><span>${escapeHtml(videoCardUiText.reason)}</span><input name="reason" maxlength="300"></label>
                    <button type="submit" class="context-command" ${selectedCount ? '' : 'disabled'}>${escapeHtml(videoCardUiText.splitCard)}</button>
                </form>
            </div>` : '';
        return `${rows ? `<div class="video-card-task-list">${rows}</div>` : `<div class="context-menu-empty">${escapeHtml(videoCardUiText.emptyTasks)}</div>`}${organizeForms}`;
    }

    function videoCardOperationsHtml(detail, branches, tasks) {
        const card = detail?.video_card;
        if (!card) return '';
        const canManage = Boolean(detail?.permissions?.can_manage);
        const canRequestApproval = Boolean(detail?.video_card);
        const hasHistory = tasks.length > 0
            || branches.length > 0
            || Boolean(card.current_best_task_id)
            || Boolean(card.final_task_id);
        const lifecycleAction = card.is_fallback
            || ['sealed', 'merged', 'archived', 'discarded'].includes(card.status)
            ? null
            : hasHistory ? 'archive' : 'discard';
        const canSeal = canManage
            && window.UltimateCanvasVideoCards.operationAllowed(detail, 'card-seal');
        const targetCards = videoCardTargetOptions(card.id);
        const mergeAllowed = canManage
            && targetCards.length > 0
            && window.UltimateCanvasVideoCards.operationAllowed(detail, 'card-merge');
        return `
            <div class="video-card-operation-list">
                <p>${escapeHtml(videoCardUiText.operationHint)}</p>
                ${canSeal ? `<button type="button" class="context-command" data-video-card-seal="${escapeHtml(card.id)}">${escapeHtml(videoCardUiText.seal)}</button>` : ''}
                ${canManage && lifecycleAction ? `<button type="button" class="context-command ${lifecycleAction === 'discard' ? 'danger' : ''}" data-video-card-lifecycle="${escapeHtml(lifecycleAction)}" data-card-id="${escapeHtml(card.id)}">${escapeHtml(lifecycleAction === 'discard' ? videoCardUiText.discard : videoCardUiText.archive)}</button>` : ''}
                ${canRequestApproval && ['sealed', 'archived'].includes(card.status) ? `
                    <form class="video-card-inline-approval" data-video-card-approval-reopen data-card-id="${escapeHtml(card.id)}">
                        <strong>${escapeHtml(videoCardUiText.reopenApproval)}</strong>
                        <label class="is-wide"><span>${escapeHtml(videoCardUiText.reason)}</span><input name="reason" minlength="2" maxlength="300" required></label>
                        <button type="submit" class="context-command">${escapeHtml(videoCardUiText.submitApproval)}</button>
                    </form>` : ''}
                ${mergeAllowed ? `
                    <form class="video-card-merge-form" data-video-card-merge-form data-card-id="${escapeHtml(card.id)}">
                        <strong>${escapeHtml(videoCardUiText.mergeCard)}</strong>
                        <label><span>${escapeHtml(videoCardUiText.targetCard)}</span><select name="target_card_id" required>${targetCards.map(target => `<option value="${escapeHtml(target.id)}">${escapeHtml(target.title)}</option>`).join('')}</select></label>
                        <label class="is-wide"><span>${escapeHtml(videoCardUiText.reason)}</span><input name="reason" maxlength="300" required></label>
                        <button type="submit" class="context-command">${escapeHtml(videoCardUiText.mergeCard)}</button>
                    </form>` : ''}
            </div>`;
    }

    function videoCardDetailMenuHtml(selectedProject) {
        const cardId = canvasRuntime.videoCardView.cardId;
        const cachedDetail = canvasRuntime.videoCardDetails.get(cardId);
        const detailError = canvasRuntime.videoCardLoadErrors.get(cardId);
        const card = cachedDetail?.video_card
            || canvasRuntime.bootstrap?.context?.video_cards?.find(item => item.id === cardId)
            || null;
        const branches = canvasRuntime.videoCardBranches.get(cardId) || [];
        const tasks = canvasRuntime.videoCardTasks.get(cardId) || [];
        const section = canvasRuntime.videoCardView.section || 'info';
        const sections = [
            ['info', videoCardUiText.info],
            ['branches', videoCardUiText.branches],
            ['tasks', videoCardUiText.tasks],
            ['operations', videoCardUiText.operations]
        ];

        let body = `<div class="context-menu-empty">${escapeHtml(videoCardUiText.loading)}</div>`;
        if (detailError) {
            body = `
                <div class="video-card-detail-error">
                    <span>${escapeHtml(detailError.message || String(detailError))}</span>
                    <button type="button" class="context-command" data-video-card-refresh="${escapeHtml(cardId)}">${escapeHtml(videoCardUiText.retry)}</button>
                </div>`;
        } else if (cachedDetail) {
            if (section === 'info') {
                const owner = ownerIdentity(card?.owner, card?.owner_user_id);
                body = `
                    <div class="video-card-summary-grid">
                        <span><small>${escapeHtml(videoCardUiText.status)}</small><strong>${escapeHtml(videoCardStatusFor(card))}</strong></span>
                        <span><small>${escapeHtml(videoCardUiText.spec)}</small><strong>${escapeHtml(videoCardSpecFor(card))}</strong></span>
                        <span><small>${escapeHtml(videoCardUiText.owner)}</small><strong>${escapeHtml(owner.name)}</strong></span>
                        <span><small>${escapeHtml(videoCardUiText.taskCount)}</small><strong>${escapeHtml(card?.summary?.task_count || tasks.length)}</strong></span>
                    </div>
                    ${videoCardInfoFormHtml(cachedDetail)}`;
            } else if (section === 'branches') {
                body = videoCardBranchesHtml(cachedDetail, branches);
            } else if (section === 'tasks') {
                body = videoCardTasksHtml(cachedDetail, tasks, branches);
            } else {
                body = videoCardOperationsHtml(cachedDetail, branches, tasks);
            }
        }

        return `
            <div class="canvas-context-menu video-card-menu video-card-context-detail ${canvasRuntime.openContextMenu === 'video-card' ? 'is-open' : ''}" data-context-menu="video-card">
                <div class="context-menu-head video-card-detail-head">
                    <button type="button" class="context-command" data-video-card-view-back>${escapeHtml(videoCardUiText.back)}</button>
                    <span><strong>${escapeHtml(card?.title || videoCardUiText.title)}</strong><small>${escapeHtml(selectedProject ? projectDisplayNameFor(selectedProject) : '')}</small></span>
                    <button type="button" class="context-command" data-video-card-refresh="${escapeHtml(cardId)}">${escapeHtml(videoCardUiText.refresh)}</button>
                </div>
                <div class="video-card-section-tabs" role="tablist">
                    ${sections.map(([key, label]) => `<button type="button" class="${section === key ? 'is-active' : ''}" data-video-card-section="${key}" role="tab" aria-selected="${section === key}">${escapeHtml(label)}</button>`).join('')}
                </div>
                <div class="video-card-detail-body">${body}</div>
            </div>`;
    }

    function videoCardMenuHtml(cards, selectedProject, selectedVideoCardId) {
        if (canvasRuntime.videoCardView.mode === 'detail' && canvasRuntime.videoCardView.cardId) {
            return videoCardDetailMenuHtml(selectedProject);
        }
        const search = (canvasRuntime.videoCardView.search || '').trim().toLocaleLowerCase();
        if (search) {
            cards = cards.filter(card => [
                card.title,
                card.objective,
                ownerIdentity(card.owner, card.owner_user_id).name,
                videoCardStatusFor(card),
                videoCardSpecFor(card)
            ].some(value => String(value || '').toLocaleLowerCase().includes(search)));
        }
        const canCreate = Boolean(selectedProject?.can_generate);
        const items = cards.map(card => {
            const selected = card.id === selectedVideoCardId;
            const owner = ownerIdentity(card.owner, card.owner_user_id);
            const taskCount = card.summary?.task_count || 0;
            return `
                <div class="context-menu-row video-card-row ${selected ? 'is-selected' : ''} ${card.can_generate ? '' : 'is-locked'}">
                    <button type="button" class="context-menu-row-main" data-video-card-select="${escapeHtml(card.id)}" ${canvasRuntime.contextSwitching ? 'disabled' : ''}>
                        ${identityAvatarHtml(card.owner, card.owner_user_id, 'is-small')}
                        <span class="context-menu-row-copy">
                            <span class="context-menu-row-title">${escapeHtml(card.title || '未命名视频卡')}</span>
                            <span class="context-menu-row-owner">${escapeHtml(owner.name)} · ${escapeHtml(videoCardStatusFor(card))}</span>
                            <span class="context-menu-row-meta">${escapeHtml(videoCardSpecFor(card))} · ${taskCount} 次生成</span>
                        </span>
                        <span class="context-menu-check" aria-hidden="true">${selected ? '✓' : ''}</span>
                    </button>
                    <a class="context-row-icon-action" href="/projects/${encodeURIComponent(card.project_id)}/video-cards/${encodeURIComponent(card.id)}" target="_top" title="查看视频卡" aria-label="查看视频卡">↗</a>
                    <button type="button" class="context-row-icon-action video-card-manage-action"
                        data-video-card-manage="${escapeHtml(card.id)}"
                        title="${escapeHtml(videoCardUiText.manage)}"
                        aria-label="${escapeHtml(videoCardUiText.manage)}">&#9881;</button>
                    ${card.removal_action ? `
                        <button type="button" class="context-row-action ${card.removal_action === 'discard' ? 'danger' : ''}"
                            data-video-card-remove="${escapeHtml(card.id)}"
                            data-removal-action="${escapeHtml(card.removal_action)}"
                            title="${escapeHtml(card.removal_reason || '')}">
                            ${card.removal_action === 'discard' ? '废弃' : '归档'}
                        </button>
                    ` : ''}
                </div>`;
        }).join('');

        return `
            <div class="canvas-context-menu video-card-menu ${canvasRuntime.openContextMenu === 'video-card' ? 'is-open' : ''}" data-context-menu="video-card">
                <div class="context-menu-head">
                    <span><strong>视频卡</strong><small>${cards.length} 张 · 归属当前项目</small></span>
                    <button type="button" class="context-command" data-video-card-create-toggle ${canCreate ? '' : 'disabled'}>${canvasRuntime.videoCardCreateOpen ? '取消' : '新建视频卡'}</button>
                </div>
                <div class="video-card-list-tools">
                    <input type="search" value="${escapeHtml(canvasRuntime.videoCardView.search || '')}"
                        data-video-card-search placeholder="${escapeHtml(videoCardUiText.search)}" autocomplete="off">
                    <button type="button" class="context-command" data-video-card-refresh="">${escapeHtml(videoCardUiText.refresh)}</button>
                </div>
                ${canvasRuntime.videoCardCreateOpen ? `
                    <form class="context-create-form" data-video-card-create-form>
                        <label>标题<input name="video_card_title" maxlength="120" autocomplete="off" placeholder="例如：开场镜头" required></label>
                        <label>视频目标<textarea name="video_card_objective" maxlength="1000" rows="2" placeholder="说明这张卡要产出什么"></textarea></label>
                        <button type="submit" class="context-primary-command" ${canvasRuntime.contextSwitching ? 'disabled' : ''}>创建并选中</button>
                    </form>
                ` : ''}
                <div class="context-menu-list">
                    ${items || '<div class="context-menu-empty">当前项目还没有视频卡，创建后才能提交生成。</div>'}
                </div>
                ${selectedProject ? `<a class="context-menu-footer-link" href="/projects/${encodeURIComponent(selectedProject.id)}" target="_top">查看项目详情</a>` : ''}
            </div>`;
    }

    function applyBootstrapState(data) {
        const project = selectedProjectFromBootstrap(data);
        const videoCard = selectedVideoCardFromBootstrap(data);
        const previousProjectId = canvasRuntime.selectedProjectId;
        const previousVideoCardId = canvasRuntime.selectedVideoCardId;
        if (previousProjectId !== (project?.id || null) || previousVideoCardId !== (videoCard?.id || null)) {
            invalidateGenerationContext();
        }
        canvasRuntime.selectedProjectId = project?.id || null;
        canvasRuntime.selectedVideoCardId = videoCard?.id || null;
        if (previousVideoCardId !== canvasRuntime.selectedVideoCardId) {
            canvasRuntime.selectedVideoBranchId = null;
        }
        const documentMeta = data?.context?.canvas_document || null;
        if (canvasRuntime.documentProjectId !== project?.id) {
            canvasRuntime.documentId = canvasRuntime.explicitDocumentId || null;
            canvasRuntime.documentProjectId = project?.id || null;
            canvasRuntime.documentVideoCardId = null;
            canvasRuntime.documentLoaded = false;
        }
        const projectNameEl = document.getElementById('project-name');
        const avatarEl = document.getElementById('user-avatar');
        if (projectNameEl) {
            projectNameEl.textContent = videoCard?.title
                ? `${projectDisplayNameFor(project)} / ${videoCard.title}`
                : projectDisplayNameFor(project);
        }
        if (avatarEl && data?.user?.name) {
            avatarEl.textContent = data.user.name.slice(0, 1);
            avatarEl.title = data.user.name;
        }
        window.ultimateCanvasBootstrap = data;
        renderRuntimeContextControls(data);
        configureGenerationEndpoints();
        installGenerationAdapter();
        updateGenerationLabels(data);
        refreshContextRulesButtons();
    }

    function renderContextControls(data, backend) {
        const left = document.querySelector('.header-left');
        if (!left) return;
        let wrap = document.getElementById('canvas-context-controls');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.id = 'canvas-context-controls';
            wrap.className = 'canvas-context-controls';
            left.appendChild(wrap);
        }
        const projects = data?.context?.projects || [];
        const cards = data?.context?.video_cards || [];
        const project = selectedProjectFromBootstrap(data);
        const card = selectedVideoCardFromBootstrap(data);
        const contextReady = Boolean(project?.can_generate && card?.can_generate);
        const contextStatus = !project
            ? '缺少项目'
            : !card
                ? '缺少视频卡'
                : card.can_generate
                    ? '已接入后台'
                    : data?.context?.generation_blocked_reason || `视频卡${videoCardStatusFor(card)}`;
        const resolvedContextStatus = contextReady ? backend.label : contextStatus;
        wrap.innerHTML = `
            <button type="button" class="context-command" data-canvas-library>画布列表</button>
            <button type="button" class="context-command canvas-document-title" data-canvas-rename title="重命名画布">${escapeHtml(canvasRuntime.documentTitle)}</button>
            <button type="button" class="context-command" data-canvas-new>新建画布</button>
            <div class="canvas-context-picker" data-context-picker="project">
                <span class="context-picker-label">项目</span>
                <button type="button" class="canvas-context-trigger" data-context-toggle="project" aria-expanded="${canvasRuntime.openContextMenu === 'project'}">
                    ${project ? identityAvatarHtml(project.owner, project.owner_user_id, 'is-trigger') : '<span class="context-trigger-placeholder"></span>'}
                    <span class="context-trigger-copy">
                        <strong>${escapeHtml(projectDisplayNameFor(project))}</strong>
                        <small>${escapeHtml(projectMetaFor(project))}</small>
                    </span>
                    ${contextChevronHtml()}
                </button>
                ${projectMenuHtml(projects, data.context.selected_project_id)}
            </div>
            <div class="canvas-context-picker" data-context-picker="video-card">
                <span class="context-picker-label">视频卡</span>
                <button type="button" class="canvas-context-trigger" data-context-toggle="video-card" aria-expanded="${canvasRuntime.openContextMenu === 'video-card'}" ${project ? '' : 'disabled'}>
                    <span class="context-video-card-mark"></span>
                    <span class="context-trigger-copy">
                        <strong>${escapeHtml(card?.title || '选择 / 新建视频卡')}</strong>
                        <small>${escapeHtml(card ? `${videoCardStatusFor(card)} · ${videoCardSpecFor(card)}` : '生成任务必须归属视频卡')}</small>
                    </span>
                    ${contextChevronHtml()}
                </button>
                ${videoCardMenuHtml(cards, project, data.context.selected_video_card_id)}
            </div>
            ${contextReady ? '' : `<span class="context-status warn" title="${escapeHtml(resolvedContextStatus)}">
                ${escapeHtml(resolvedContextStatus)}
            </span>`}
            <button type="button" id="canvas-save-state" data-save-now class="context-status save ${canvasRuntime.saveState}" title="点击立即保存" ${canvasRuntime.contextSwitching ? 'disabled' : ''}>
                ${canvasRuntime.saveState === 'saved' ? '已保存' : canvasRuntime.saveState === 'saving' ? '保存中' : canvasRuntime.saveState === 'error' ? '保存失败' : '未保存'}
            </button>
        `;
    }

    function updateGenerationLabels(data) {
        const caps = data?.capabilities || {};
        document.querySelectorAll('[data-text-model]').forEach(select => {
            const node = engine.nodes.get(select.closest('.canvas-node')?.dataset.nodeId);
            const selected = node?.data?.textModel || caps.text?.model || 'gpt-5.5';
            const models = [...(caps.text?.model_options || [])];
            if (!models.some(item => item.value === selected)) models.unshift({ value: selected, label: selected });
            select.disabled = !caps.text?.enabled;
            const key = JSON.stringify(models);
            if (select.dataset.optionsKey === key && select.value === selected) return;
            select.replaceChildren(...models.map(item => new Option(item.label, item.value, false, item.value === selected)));
            select.dataset.optionsKey = key;
        });
        document.querySelectorAll('.node-type-image [data-generation-model-label]').forEach(el => {
            el.textContent = caps.image?.model || caps.image?.label || '图形生成';
        });
        document.querySelectorAll('.node-type-video [data-generation-model-label]').forEach(el => {
            el.textContent = caps.video?.model || caps.video?.label || '默认视频 API';
        });
        renderAllGenerationNodeControls();
    }

    function updateGenerationNodeModelLabel(nodeEl, node) {
        const imageSelect = nodeEl?.querySelector('[data-generation-image-model]');
        if (imageSelect && node?.type === 'image') {
            if (node.data?.canvasStyle) {
                const style = node.data.canvasStyle;
                imageSelect.replaceChildren(new Option(style.modelLabel || style.model, style.model));
                imageSelect.disabled = true;
                imageSelect.title = '使用风格模板的模型；移除风格后可自由选择';
                return;
            }
            const capability = canvasRuntime.bootstrap?.capabilities?.image || {};
            const options = capability.model_options || [{ value: capability.model, label: capability.label || capability.model }];
            const selected = node.data?.imageSettings?.model || capability.model;
            imageSelect.innerHTML = options.filter(item => item.value).map(item => `<option value="${escapeHtml(item.value)}"${item.value === selected ? ' selected' : ''}>${escapeHtml(item.label || item.value)}</option>`).join('');
            imageSelect.disabled = !capability.enabled || !options.length;
            imageSelect.title = '';
            return;
        }
        const label = nodeEl?.querySelector('[data-generation-model-label]');
        if (!label || !node) return;
        const capabilities = canvasRuntime.bootstrap?.capabilities || {};
        if (node.type === 'image') {
            label.textContent = capabilities.image?.model || capabilities.image?.label || '图形生成';
        } else if (node.type === 'video') {
            const model = generationSettingsForNode(node).model;
            label.textContent = capabilities.video?.model_options?.find(item => item.value === model)?.label || model || '待选择模型';
        }
    }

    async function loadCanvasBootstrap(
        projectId = canvasRuntime.selectedProjectId,
        videoCardId = canvasRuntime.selectedVideoCardId,
        options = {}
    ) {
        if (projectId !== canvasRuntime.selectedProjectId || videoCardId !== canvasRuntime.selectedVideoCardId) {
            clearAllVideoEstimates();
        }
        const requestId = ++canvasRuntime.bootstrapRequestId;
        try {
            const url = new URL('/api/tools/ultimate-canvas/bootstrap', window.location.origin);
            if (projectId) url.searchParams.set('project_id', projectId);
            if (videoCardId) url.searchParams.set('video_card_id', videoCardId);
            const data = await requestJson(url.toString(), {
                cache: 'no-store'
            });
            if (requestId !== canvasRuntime.bootstrapRequestId) return null;
            canvasRuntime.bootstrap = data;
            canvasRuntime.bootstrapLoaded = true;
            canvasRuntime.bootstrapError = null;
            applyBootstrapState(data);
            if (options.restoreDocument !== false) {
                await loadCanvasDocument({ clearWhenMissing: options.clearWhenMissing !== false });
            }
            await loadLibraryPanels();
            return data;
        } catch (error) {
            if (requestId !== canvasRuntime.bootstrapRequestId) return null;
            canvasRuntime.bootstrap = null;
            canvasRuntime.bootstrapLoaded = false;
            canvasRuntime.bootstrapError = error;
            refreshContextRulesButtons();
            showCanvasNotice(error?.message || '后台能力读取失败，请刷新后重试。', 'error');
            return null;
        }
    }

    function renderRuntimeContextControls(data = canvasRuntime.bootstrap) {
        if (!data) return;
        const backend = window.UltimateCanvasBackendContract.backendStatus(data);
        renderContextControls(data, backend);
    }

    function closeContextMenus() {
        canvasRuntime.openContextMenu = null;
        canvasRuntime.projectCreateOpen = false;
        canvasRuntime.videoCardCreateOpen = false;
        renderRuntimeContextControls();
    }

    function setContextSwitching(busy) {
        canvasRuntime.contextSwitching = busy;
        renderRuntimeContextControls();
        updateDocumentInteraction();
    }

    function invalidateGenerationContext() {
        releaseInlineVideos();
        videoReadOrders.clear();
        cancelReferenceImport();
        canvasRuntime.pendingGenerationSubmissions.releaseAll(entry => entry.release?.(true));
        canvasRuntime.contextEpoch += 1;
        roleInstanceLayer?.close(); roleInstanceLayer = null;
        roleCreator?.contextChanged();
        roleWorkflow?.contextChanged();
    }

    function openCanvasProductDialog(options) {
        const opener = document.activeElement;
        const dialog = document.createElement('dialog');
        dialog.className = `canvas-product-dialog ${options.className || ''}`;
        if (options.labelledBy) dialog.setAttribute('aria-labelledby', options.labelledBy);
        // Role leaves construct safe DOM with listeners; preserve that DOM rather than stringify it.
        if (options.content instanceof Node) dialog.append(options.content);
        else dialog.innerHTML = options.content;
        let down = null, dismissing = false;
        const outside = event => {
            const box = dialog.getBoundingClientRect();
            return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
        };
        const dismiss = async () => {
            if (dismissing || document.querySelectorAll('dialog[open]')[document.querySelectorAll('dialog[open]').length - 1] !== dialog) return;
            dismissing = true;
            try { await options.onDismiss?.(); } finally { dismissing = false; }
        };
        dialog.addEventListener('cancel', event => { event.preventDefault(); void dismiss(); });
        dialog.addEventListener('keydown', event => { event.stopPropagation(); });
        dialog.addEventListener('pointerdown', event => { down = outside(event) ? { x: event.clientX, y: event.clientY } : null; });
        dialog.addEventListener('pointerup', event => {
            if (down && outside(event) && Math.hypot(event.clientX - down.x, event.clientY - down.y) < 6) void dismiss();
            down = null;
        });
        const close = () => {
            dialog.close(); dialog.remove();
            window.parent.postMessage({ type: 'sd2-canvas-modal', open: !!document.querySelector('dialog[open]') }, window.location.origin);
            if (opener?.isConnected) opener.focus();
        };
        document.body.append(dialog); dialog.showModal();
        if (options.anchor && window.innerWidth > 640) {
            const anchor = options.anchor.getBoundingClientRect();
            const box = dialog.getBoundingClientRect();
            dialog.style.position = 'fixed';
            dialog.style.margin = '0';
            dialog.style.right = 'auto';
            dialog.style.bottom = 'auto';
            dialog.style.left = Math.max(16, Math.min(anchor.left, window.innerWidth - box.width - 16)) + 'px';
            dialog.style.top = Math.max(16, Math.min(anchor.bottom + 8, window.innerHeight - box.height - 16)) + 'px';
        }
        window.parent.postMessage({ type: 'sd2-canvas-modal', open: true }, window.location.origin);
        return { dialog, close };
    }

    function requestCanvasConfirmation(options = {}) {
        return new Promise(resolve => {
            const id = `canvas-confirm-${crypto.randomUUID()}`;
            const finish = value => { layer.close(); resolve(value); };
            const layer = openCanvasProductDialog({ className: 'canvas-confirm-dialog', labelledBy: id,
                onDismiss: () => finish(false), content: `
                    <div class="canvas-confirm-head">
                        <strong id="${id}">${escapeHtml(options.title || '确认操作')}</strong>
                        <button type="button" class="canvas-confirm-close" data-confirm-value="false" aria-label="关闭">×</button>
                    </div>
                    <p>${escapeHtml(options.message || '请确认是否继续。')}</p>
                    ${options.detail ? `<div class="canvas-confirm-detail">${escapeHtml(options.detail)}</div>` : ''}
                    <div class="canvas-confirm-actions">
                        <button type="button" class="context-command" data-confirm-value="false" autofocus>取消</button>
                        <button type="button" class="context-primary-command ${options.danger ? 'danger' : ''}" data-confirm-value="true">${escapeHtml(options.confirmLabel || '确认')}</button>
                    </div>
                ` });
            layer.dialog.addEventListener('click', event => {
                const value = event.target.closest('[data-confirm-value]')?.dataset.confirmValue;
                if (value) finish(value === 'true');
            });
        });
    }

    function requestCanvasName(value, options = {}) {
        return new Promise(resolve => {
            const id = 'canvas-name-' + crypto.randomUUID();
            const finish = value => { layer.close(); resolve(value); };
            const layer = openCanvasProductDialog({
                className: 'canvas-confirm-dialog', labelledBy: id, anchor: document.activeElement,
                onDismiss: () => finish(null),
                content: `<div class="canvas-confirm-head"><strong id="${id}">${escapeHtml(options.title || '画布名称')}</strong></div>
                    <input class="canvas-name-input" data-canvas-name ${options.maxLength === null ? '' : 'maxlength="120"'} aria-label="${escapeHtml(options.title || '画布名称')}" value="${escapeHtml(value || '')}">
                    <div class="canvas-confirm-actions"><button type="button" class="context-command" data-name-cancel>取消</button>
                    <button type="button" class="context-primary-command" data-name-save>保存名称</button></div>`
            });
            const input = layer.dialog.querySelector('[data-canvas-name]');
            const save = layer.dialog.querySelector('[data-name-save]');
            const update = () => { save.disabled = !input.value.trim(); };
            input.addEventListener('input', update);
            layer.dialog.querySelector('[data-name-cancel]').onclick = () => finish(null);
            save.onclick = () => { if (input.value.trim()) finish(input.value.trim()); };
            input.addEventListener('keydown', event => { if (event.key === 'Enter' && input.value.trim()) finish(input.value.trim()); });
            update(); input.focus(); input.select();
        });
    }

    function requestCanvasBackup(backups) {
        if (!backups.length) { showCanvasNotice('暂无可恢复的备份。', 'info'); return Promise.resolve(null); }
        return new Promise(resolve => {
            const id = 'canvas-backup-' + crypto.randomUUID();
            const finish = value => { layer.close(); resolve(value); };
            const layer = openCanvasProductDialog({
                className: 'canvas-confirm-dialog', labelledBy: id, onDismiss: () => finish(null),
                content: `<div class="canvas-confirm-head"><strong id="${id}">恢复备份</strong></div>
                    <p>选择备份另存为恢复副本，不覆盖原画布；当前修改仍会先保存。</p>
                    <div class="canvas-backup-list">${backups.map((backup, index) => `<label>
                        <input type="radio" name="${id}" value="${index}" ${index === backups.length - 1 ? 'checked' : ''}>
                        <span><strong>${escapeHtml(backup.request?.title || '未命名画布')}</strong>
                        <small>${escapeHtml(backup.savedAt ? new Date(backup.savedAt).toLocaleString('zh-CN') : '时间未知')}</small></span></label>`).join('')}</div>
                    <div class="canvas-confirm-actions"><button type="button" class="context-command" data-backup-cancel autofocus>取消</button>
                    <button type="button" class="context-primary-command" data-backup-save>另存恢复</button></div>`
            });
            layer.dialog.querySelector('[data-backup-cancel]').onclick = () => finish(null);
            layer.dialog.querySelector('[data-backup-save]').onclick = () => {
                const selected = layer.dialog.querySelector('input:checked');
                if (selected) finish(backups[Number(selected.value)]);
            };
        });
    }

    function clearCanvasForContext() {
        invalidateGenerationContext();
        disposeCanvasPricing();
        canvasRuntime.documentRestoring = true;
        try {
            clearAllVideoEstimates();
            engine.restore({ nodes: [], connections: [], viewport: {} });
        } finally {
            canvasRuntime.documentRestoring = false;
        }
    }

    function resetProjectScopedRuntime(projectId) {
        ++canvasRuntime.documentRequestId;
        invalidateGenerationContext();
        disposeCanvasPricing();
        stopAllVideoPolling();
        canvasRuntime.selectedProjectId = projectId || null;
        canvasRuntime.selectedVideoCardId = null;
        canvasRuntime.selectedVideoBranchId = null;
        canvasRuntime.documentId = null;
        canvasRuntime.explicitDocumentId = null;
        canvasRuntime.documentRevision = 0;
        canvasRuntime.documentSchemaVersion = 2;
        canvasRuntime.documentWritable = false;
        canvasRuntime.documentDirty = false;
        canvasRuntime.documentTitle = '未命名画布';
        canvasRuntime.failedSaveRequest = null;
        canvasRuntime.saveConflict = false;
        canvasRuntime.documentProjectId = null;
        canvasRuntime.documentVideoCardId = null;
        canvasRuntime.documentLoaded = false;
        canvasRuntime.libraryLoaded = false;
        canvasRuntime.historyLoaded = false;
        canvasRuntime.libraryItems = [];
        canvasRuntime.historyItems = [];
        canvasRuntime.videoCardDetails.clear();
        canvasRuntime.videoCardBranches.clear();
        canvasRuntime.videoCardTasks.clear();
        canvasRuntime.videoCardLoads.clear();
        canvasRuntime.videoCardLoadErrors.clear();
        canvasRuntime.videoCardSelectedTaskIds.clear();
        canvasRuntime.videoCardView = { mode: 'list', section: 'info', cardId: null, search: '' };
        canvasRuntime.pendingGenerationReferenceTargetId = null;
    }

    async function switchProjectContext(projectId) {
        if (!projectId || projectId === canvasRuntime.selectedProjectId || canvasRuntime.contextSwitching) {
            closeContextMenus();
            return;
        }
        if (engine.nodes.size > 0 || canvasRuntime.documentId) {
            const confirmed = await requestCanvasConfirmation({
                title: '切换项目',
                message: '当前画布会先保存，再打开目标项目的画布列表。你可以选择已有画布，或新建画布。',
                detail: `当前：${projectDisplayNameFor(selectedProject())}`,
                confirmLabel: '保存并切换'
            });
            if (!confirmed) return;
        }
        canvasRuntime.openContextMenu = null;
        finishReferenceSelection({ returnToTarget: false });
        canvasRuntime.projectCreateOpen = false;
        setContextSwitching(true);
        try {
            const saved = await flushCanvasSave('before_project_change');
            if (!saved) throw new Error('当前画布保存失败，已取消切换项目，避免内容错存。');
            invalidateGenerationContext();
            stopAllVideoPolling();
            disposeCanvasPricing();
            canvasRuntime.documentWritable = false;
            await window.UltimateCanvasDocuments?.show({ projectId });
        } catch (error) {
            showCanvasNotice(error?.message || '项目切换失败。', 'error');
        } finally {
            setContextSwitching(false);
        }
    }

    async function switchVideoCardContext(videoCardId) {
        if (!videoCardId || videoCardId === canvasRuntime.selectedVideoCardId || canvasRuntime.contextSwitching) {
            closeContextMenus();
            return;
        }
        canvasRuntime.openContextMenu = null;
        finishReferenceSelection({ returnToTarget: false });
        canvasRuntime.videoCardCreateOpen = false;
        setContextSwitching(true);
        try {
            const saved = await flushCanvasSave('before_video_card_change');
            if (!saved) throw new Error('当前画布保存失败，已取消切换视频卡。');
            invalidateGenerationContext();
            stopAllVideoPolling();
            canvasRuntime.selectedVideoBranchId = null;
            const data = await loadCanvasBootstrap(canvasRuntime.selectedProjectId, videoCardId, { restoreDocument: false });
            if (!data) throw new Error('视频卡切换失败，请稍后重试。');
            canvasRuntime.documentVideoCardId = canvasRuntime.selectedVideoCardId;
            scheduleCanvasSave('video_card_change');
            showCanvasNotice(`已切换到视频卡「${selectedVideoCard()?.title || '未命名'}」`, 'info');
        } catch (error) {
            showCanvasNotice(error?.message || '视频卡切换失败。', 'error');
        } finally {
            setContextSwitching(false);
        }
    }

    async function createProjectFromMenu(form) {
        const name = form.elements.project_name?.value?.trim() || '';
        if (!name || canvasRuntime.contextSwitching) return;
        setContextSwitching(true);
        try {
            const data = await postJson('/api/projects', { name, type: 'team' });
            if (!data?.project?.id) throw new Error('后端没有返回新项目 ID');
            const saved = await flushCanvasSave('before_project_create_switch');
            if (!saved) throw new Error('当前画布保存失败，新项目已创建但未切换。');
            const projects = canvasRuntime.bootstrap?.context?.projects;
            if (projects && !projects.some(project => project.id === data.project.id)) projects.push(data.project);
            invalidateGenerationContext();
            stopAllVideoPolling();
            disposeCanvasPricing();
            canvasRuntime.documentWritable = false;
            await window.UltimateCanvasDocuments?.show({ projectId: data.project.id });
            showCanvasNotice(`已新建「${data.project.name}」，请选择新建画布。`, 'info');
        } catch (error) {
            showCanvasNotice(error?.message || '新建项目失败。', 'error');
        } finally {
            canvasRuntime.openContextMenu = null;
            canvasRuntime.projectCreateOpen = false;
            setContextSwitching(false);
        }
    }

    async function removeProjectFromMenu(projectId, action) {
        const project = canvasRuntime.bootstrap?.context?.projects?.find(item => item.id === projectId);
        if (!project || !action || canvasRuntime.contextSwitching) return;
        const confirmed = await requestCanvasConfirmation({
            title: action === 'archive' ? '归档项目' : '删除空项目',
            message: action === 'archive'
                ? '这个项目已有任务或图集，将转为只读归档，不会删除历史内容。'
                : '这个项目当前没有任务或图集，删除后不会再出现在项目列表中。',
            detail: `${projectDisplayNameFor(project)} · ${projectMetaFor(project)}`,
            confirmLabel: action === 'archive' ? '确认归档' : '确认删除',
            danger: action === 'delete'
        });
        if (!confirmed) return;

        setContextSwitching(true);
        try {
            if (projectId === canvasRuntime.selectedProjectId) {
                const saved = await flushCanvasSave('before_project_remove');
                if (!saved) throw new Error('当前画布保存失败，已取消项目操作。');
            }
            if (action === 'archive') await patchJson(`/api/projects/${encodeURIComponent(projectId)}`, { action: 'archive' });
            else await deleteJson(`/api/projects/${encodeURIComponent(projectId)}`);

            if (projectId === canvasRuntime.selectedProjectId) {
                resetProjectScopedRuntime(null);
                clearCanvasForContext();
                canvasRuntime.bootstrapLoaded = false;
                await loadCanvasBootstrap(null, null, { restoreDocument: true, clearWhenMissing: true });
            } else {
                await loadCanvasBootstrap(canvasRuntime.selectedProjectId, canvasRuntime.selectedVideoCardId, { restoreDocument: false });
            }
            showCanvasNotice(action === 'archive' ? '项目已归档。' : '空项目已删除。', 'info');
        } catch (error) {
            showCanvasNotice(error?.message || '项目操作失败。', 'error');
        } finally {
            canvasRuntime.openContextMenu = null;
            setContextSwitching(false);
        }
    }

    async function createVideoCardFromValues(title, objective, confirmDuplicate = false) {
        if (!title || !canvasRuntime.selectedProjectId || canvasRuntime.contextSwitching) return;
        setContextSwitching(true);
        try {
            const data = await postJson(`/api/projects/${encodeURIComponent(canvasRuntime.selectedProjectId)}/video-cards`, {
                title,
                objective: objective || null,
                confirm_duplicate: confirmDuplicate
            });
            if (!data?.video_card?.id) throw new Error('后端没有返回新视频卡 ID');
            await loadCanvasBootstrap(canvasRuntime.selectedProjectId, data.video_card.id, { restoreDocument: false });
            canvasRuntime.documentVideoCardId = data.video_card.id;
            scheduleCanvasSave('video_card_create');
            showCanvasNotice(`已创建视频卡「${data.video_card.title}」`, 'info');
            canvasRuntime.openContextMenu = null;
            canvasRuntime.videoCardCreateOpen = false;
        } catch (error) {
            if (error?.status === 409 && error?.response?.code === 'SIMILAR_VIDEO_CARD_EXISTS' && !confirmDuplicate) {
                const confirmed = await requestCanvasConfirmation({
                    title: '可能存在重复视频卡',
                    message: '同一项目下发现标题或目标相近的视频卡。你可以取消后选择已有卡，也可以确认继续新建。',
                    detail: error.response?.similar_video_cards?.[0]?.title || title,
                    confirmLabel: '仍然新建'
                });
                canvasRuntime.contextSwitching = false;
                if (confirmed) return await createVideoCardFromValues(title, objective, true);
            } else {
                showCanvasNotice(error?.message || '新建视频卡失败。', 'error');
            }
        } finally {
            setContextSwitching(false);
        }
    }

    function createVideoCardFromMenu(form) {
        const title = form.elements.video_card_title?.value?.trim() || '';
        const objective = form.elements.video_card_objective?.value?.trim() || '';
        return createVideoCardFromValues(title, objective, false);
    }

    async function removeVideoCardFromMenu(videoCardId, action) {
        const card = canvasRuntime.bootstrap?.context?.video_cards?.find(item => item.id === videoCardId);
        if (!card || !action || canvasRuntime.contextSwitching) return;
        const confirmed = await requestCanvasConfirmation({
            title: action === 'archive' ? '归档视频卡' : '废弃空视频卡',
            message: action === 'archive'
                ? '视频卡已有生成记录，归档后保留历史，但不能继续生成。'
                : '这张视频卡还没有生成记录，废弃后将从当前列表移除。',
            detail: `${card.title} · ${videoCardSpecFor(card)}`,
            confirmLabel: action === 'archive' ? '确认归档' : '确认废弃',
            danger: action === 'discard'
        });
        if (!confirmed) return;

        setContextSwitching(true);
        try {
            await patchJson(`/api/video-cards/${encodeURIComponent(videoCardId)}`, { action });
            const wasSelected = videoCardId === canvasRuntime.selectedVideoCardId;
            await loadCanvasBootstrap(
                canvasRuntime.selectedProjectId,
                wasSelected ? null : canvasRuntime.selectedVideoCardId,
                { restoreDocument: false }
            );
            if (wasSelected) scheduleCanvasSave('video_card_remove');
            showCanvasNotice(action === 'archive' ? '视频卡已归档。' : '空视频卡已废弃。', 'info');
        } catch (error) {
            showCanvasNotice(error?.message || '视频卡操作失败。', 'error');
        } finally {
            canvasRuntime.openContextMenu = null;
            setContextSwitching(false);
        }
    }

    installAutosaveHooks();
    engine.onConnectionRejected = (_fromId, _toId, reason) => showCanvasNotice(reason || '这条连线不兼容。', 'warn');
    initializeCanvasDocuments();

    document.addEventListener('input', event => {
        const search = event.target.closest('[data-video-card-search]');
        if (!search) return;
        const value = search.value || '';
        canvasRuntime.videoCardView.search = value;
        renderRuntimeContextControls();
        window.requestAnimationFrame(() => {
            const next = document.querySelector('[data-video-card-search]');
            if (!next) return;
            next.focus();
            next.setSelectionRange(value.length, value.length);
        });
    });

    document.addEventListener('change', event => {
        const taskSelect = event.target.closest('[data-video-task-select]');
        if (taskSelect) {
            const selectedIds = selectedVideoTaskIds(taskSelect.dataset.cardId);
            if (taskSelect.checked) selectedIds.add(taskSelect.dataset.videoTaskSelect);
            else selectedIds.delete(taskSelect.dataset.videoTaskSelect);
            renderRuntimeContextControls();
            return;
        }

        const targetCard = event.target.closest('[data-video-task-target-card]');
        if (targetCard) {
            const targetCardId = targetCard.value;
            canvasRuntime.videoCardView.targetCardId = targetCardId;
            if (!targetCardId) {
                renderRuntimeContextControls();
                return;
            }
            loadVideoCardWorkspace(targetCardId).then(renderRuntimeContextControls).catch(error => {
                showCanvasNotice(error?.message || '\u76ee\u6807\u89c6\u9891\u5361\u65b9\u5411\u8bfb\u53d6\u5931\u8d25\u3002', 'warn');
            });
        }
    });

    document.addEventListener('click', event => {
        const toggle = event.target.closest('[data-context-toggle]');
        if (toggle) {
            const kind = toggle.dataset.contextToggle;
            const opening = canvasRuntime.openContextMenu !== kind;
            canvasRuntime.openContextMenu = opening ? kind : null;
            if (kind !== 'project') canvasRuntime.projectCreateOpen = false;
            if (kind !== 'video-card') canvasRuntime.videoCardCreateOpen = false;
            if (kind === 'video-card' && opening) {
                canvasRuntime.videoCardView = {
                    ...canvasRuntime.videoCardView,
                    mode: 'list',
                    section: 'info',
                    cardId: null
                };
            }
            renderRuntimeContextControls();
            if (kind === 'video-card' && opening) {
                refreshProjectVideoCards().catch(error => {
                    showCanvasNotice(error?.message || '\u89c6\u9891\u5361\u5217\u8868\u5237\u65b0\u5931\u8d25\u3002', 'warn');
                });
            }
            return;
        }

        const videoCardRefresh = event.target.closest('[data-video-card-refresh]');
        if (videoCardRefresh) {
            const cardId = videoCardRefresh.dataset.videoCardRefresh;
            const action = cardId
                ? refreshVideoCardManagement(cardId)
                : refreshProjectVideoCards();
            action.catch(error => {
                showCanvasNotice(error?.message || '\u89c6\u9891\u5361\u5237\u65b0\u5931\u8d25\u3002', 'warn');
            });
            return;
        }

        const videoCardViewBack = event.target.closest('[data-video-card-view-back]');
        if (videoCardViewBack) {
            canvasRuntime.videoCardView = {
                ...canvasRuntime.videoCardView,
                mode: 'list',
                section: 'info',
                cardId: null
            };
            renderRuntimeContextControls();
            return;
        }

        const videoCardSection = event.target.closest('[data-video-card-section]');
        if (videoCardSection) {
            canvasRuntime.videoCardView.section = videoCardSection.dataset.videoCardSection || 'info';
            renderRuntimeContextControls();
            return;
        }

        const videoCardManage = event.target.closest('[data-video-card-manage]');
        if (videoCardManage) {
            openVideoCardManagement(videoCardManage.dataset.videoCardManage);
            return;
        }

        const videoBranchSelect = event.target.closest('[data-video-branch-select]');
        if (videoBranchSelect) {
            selectVideoBranch(videoBranchSelect.dataset.videoBranchSelect);
            renderRuntimeContextControls();
            return;
        }

        const videoBranchAction = event.target.closest('[data-video-branch-action]');
        if (videoBranchAction) {
            handleVideoBranchAction(videoBranchAction).catch(error => {
                showCanvasNotice(error?.message || '\u65b9\u5411\u64cd\u4f5c\u5931\u8d25\u3002', 'error');
            });
            return;
        }

        const videoTaskVersion = event.target.closest('[data-video-task-version], [data-generated-task-version]');
        if (videoTaskVersion) {
            closeGenerationPopover();
            const role = videoTaskVersion.dataset.videoTaskVersion
                || videoTaskVersion.dataset.generatedTaskVersion;
            executeVideoTaskVersion(
                videoTaskVersion.dataset.cardId || canvasRuntime.selectedVideoCardId,
                videoTaskVersion.dataset.taskId,
                role
            ).then(() => {
                showCanvasNotice('\u89c6\u9891\u7248\u672c\u6807\u8bb0\u5df2\u66f4\u65b0\u3002', 'info');
            }).catch(error => {
                showCanvasNotice(error?.message || '\u89c6\u9891\u7248\u672c\u6807\u8bb0\u5931\u8d25\u3002', 'error');
            });
            return;
        }

        const videoTaskRetry = event.target.closest('[data-video-task-retry], [data-generated-task-retry]');
        if (videoTaskRetry) {
            closeGenerationPopover();
            const taskId = videoTaskRetry.dataset.videoTaskRetry
                || videoTaskRetry.dataset.generatedTaskRetry;
            requestCanvasConfirmation({
                title: videoCardUiText.retryTask,
                message: '\u91cd\u8bd5\u4f1a\u521b\u5efa\u65b0\u7684\u771f\u5b9e\u751f\u6210\u4efb\u52a1\uff0c\u5e76\u6309\u540e\u7aef\u89c4\u5219\u51bb\u7ed3\u6216\u6d88\u8017\u70b9\u6570\u3002',
                detail: taskId,
                confirmLabel: videoCardUiText.retryTask
            }).then(confirmed => {
                if (!confirmed) return null;
                const nodeId = videoTaskRetry.dataset.nodeId;
                const node = engine.nodes.get(nodeId);
                if (node?.data?.planSource || node?.data?.videoSubmission) {
                    const el = document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
                    const submit = el?.querySelector('[data-generation-submit]');
                    if (el && submit) return submitNodeGeneration(el, submit);
                    return null;
                }
                return retryVideoTask(
                    taskId,
                    videoTaskRetry.dataset.nodeId || '',
                    videoTaskRetry.dataset.cardId || ''
                );
            }).then(result => {
                if (result) showCanvasNotice('\u91cd\u8bd5\u4efb\u52a1\u5df2\u63d0\u4ea4\u3002', 'info');
            }).catch(error => {
                showCanvasNotice(error?.message || '\u4efb\u52a1\u91cd\u8bd5\u5931\u8d25\u3002', 'error');
            });
            return;
        }

        if (event.target.closest('.generation-task-action-menu a')) {
            closeGenerationPopover();
            return;
        }

        const videoCardSeal = event.target.closest('[data-video-card-seal]');
        if (videoCardSeal) {
            confirmVideoCardLifecycle('card-seal', videoCardSeal.dataset.videoCardSeal).catch(error => {
                showCanvasNotice(error?.message || '\u89c6\u9891\u5361\u5c01\u677f\u5931\u8d25\u3002', 'error');
            });
            return;
        }

        const videoCardLifecycle = event.target.closest('[data-video-card-lifecycle]');
        if (videoCardLifecycle) {
            const operation = videoCardLifecycle.dataset.videoCardLifecycle === 'discard'
                ? 'card-discard'
                : 'card-archive';
            confirmVideoCardLifecycle(operation, videoCardLifecycle.dataset.cardId).catch(error => {
                showCanvasNotice(error?.message || '\u89c6\u9891\u5361\u72b6\u6001\u64cd\u4f5c\u5931\u8d25\u3002', 'error');
            });
            return;
        }

        const projectCreateToggle = event.target.closest('[data-project-create-toggle]');
        if (projectCreateToggle) {
            canvasRuntime.projectCreateOpen = !canvasRuntime.projectCreateOpen;
            renderRuntimeContextControls();
            document.querySelector('[data-project-create-form] input')?.focus();
            return;
        }

        const videoCardCreateToggle = event.target.closest('[data-video-card-create-toggle]');
        if (videoCardCreateToggle) {
            canvasRuntime.videoCardCreateOpen = !canvasRuntime.videoCardCreateOpen;
            renderRuntimeContextControls();
            document.querySelector('[data-video-card-create-form] input')?.focus();
            return;
        }

        const projectSelect = event.target.closest('[data-project-select]');
        if (projectSelect) {
            switchProjectContext(projectSelect.dataset.projectSelect);
            return;
        }

        const projectRemove = event.target.closest('[data-project-remove]');
        if (projectRemove) {
            removeProjectFromMenu(projectRemove.dataset.projectRemove, projectRemove.dataset.removalAction);
            return;
        }

        const videoCardSelect = event.target.closest('[data-video-card-select]');
        if (videoCardSelect) {
            switchVideoCardContext(videoCardSelect.dataset.videoCardSelect);
            return;
        }

        const videoCardRemove = event.target.closest('[data-video-card-remove]');
        if (videoCardRemove) {
            removeVideoCardFromMenu(videoCardRemove.dataset.videoCardRemove, videoCardRemove.dataset.removalAction);
            return;
        }

        const saveNow = event.target.closest('[data-save-now]');
        if (saveNow) {
            if (canvasRuntime.contextSwitching) return;
            flushCanvasSave('manual').then(saved => {
                showCanvasNotice(saved ? '画布已保存。' : '画布保存失败，请稍后重试。', saved ? 'info' : 'error');
            });
            return;
        }

        if (canvasRuntime.openContextMenu && !event.target.closest('.canvas-context-picker')) {
            closeContextMenus();
        }
    });

    document.addEventListener('submit', event => {
        const videoTaskMoveForm = event.target.closest('[data-video-task-move-form]');
        if (videoTaskMoveForm) {
            event.preventDefault();
            const taskCount = selectedVideoTaskIds(videoTaskMoveForm.dataset.cardId).size;
            const target = videoTaskMoveForm.elements.target_card_id?.selectedOptions?.[0]?.textContent || '';
            requestCanvasConfirmation({
                title: videoCardUiText.moveTasks,
                message: `\u786e\u8ba4\u8fc1\u79fb ${taskCount} \u4e2a\u4efb\u52a1\u5230\u300c${target}\u300d\uff1f`,
                detail: videoTaskMoveForm.elements.reason?.value?.trim() || '',
                confirmLabel: videoCardUiText.moveTasks
            }).then(confirmed => confirmed ? moveVideoTasks(videoTaskMoveForm) : null).then(result => {
                if (result) showCanvasNotice('\u6240\u9009\u4efb\u52a1\u5df2\u8fc1\u79fb\u3002', 'info');
            }).catch(error => {
                showCanvasNotice(error?.message || '\u4efb\u52a1\u8fc1\u79fb\u5931\u8d25\u3002', 'error');
            });
            return;
        }

        const videoCardSplitForm = event.target.closest('[data-video-card-split-form]');
        if (videoCardSplitForm) {
            event.preventDefault();
            const taskCount = selectedVideoTaskIds(videoCardSplitForm.dataset.cardId).size;
            const title = videoCardSplitForm.elements.title?.value?.trim() || '';
            requestCanvasConfirmation({
                title: videoCardUiText.splitCard,
                message: `\u786e\u8ba4\u5c06 ${taskCount} \u4e2a\u4efb\u52a1\u62c6\u5206\u5230\u65b0\u89c6\u9891\u5361\u300c${title}\u300d\uff1f`,
                detail: videoCardSplitForm.elements.reason?.value?.trim() || '',
                confirmLabel: videoCardUiText.splitCard
            }).then(confirmed => confirmed ? splitVideoCard(videoCardSplitForm) : null).then(result => {
                if (result) showCanvasNotice('\u65b0\u89c6\u9891\u5361\u5df2\u4ece\u6240\u9009\u4efb\u52a1\u62c6\u5206\u521b\u5efa\u3002', 'info');
            }).catch(error => {
                showCanvasNotice(error?.message || '\u89c6\u9891\u5361\u62c6\u5206\u5931\u8d25\u3002', 'error');
            });
            return;
        }

        const videoCardMergeForm = event.target.closest('[data-video-card-merge-form]');
        if (videoCardMergeForm) {
            event.preventDefault();
            const sourceCard = canvasRuntime.videoCardDetails.get(videoCardMergeForm.dataset.cardId)?.video_card;
            const target = videoCardMergeForm.elements.target_card_id?.selectedOptions?.[0]?.textContent || '';
            requestCanvasConfirmation({
                title: videoCardUiText.mergeCard,
                message: `\u786e\u8ba4\u5c06\u300c${sourceCard?.title || videoCardMergeForm.dataset.cardId}\u300d\u5408\u5e76\u5230\u300c${target}\u300d\uff1f`,
                detail: videoCardMergeForm.elements.reason?.value?.trim() || '',
                confirmLabel: videoCardUiText.mergeCard,
                danger: true
            }).then(confirmed => confirmed ? mergeVideoCard(videoCardMergeForm) : null).then(result => {
                if (result) showCanvasNotice('\u89c6\u9891\u5361\u5df2\u5408\u5e76\u3002', 'info');
            }).catch(error => {
                showCanvasNotice(error?.message || '\u89c6\u9891\u5361\u5408\u5e76\u5931\u8d25\u3002', 'error');
            });
            return;
        }

        const videoBranchCreateForm = event.target.closest('[data-video-branch-create-form]');
        if (videoBranchCreateForm) {
            event.preventDefault();
            const submit = videoBranchCreateForm.querySelector('[type="submit"]');
            if (submit) submit.disabled = true;
            executeVideoBranchAction('branch-create', {
                cardId: videoBranchCreateForm.dataset.cardId,
                title: videoBranchCreateForm.elements.title?.value?.trim(),
                description: videoBranchCreateForm.elements.description?.value?.trim()
            }).then(() => {
                showCanvasNotice('\u65b9\u5411\u5df2\u521b\u5efa\u3002', 'info');
            }).catch(error => {
                if (submit) submit.disabled = false;
                showCanvasNotice(error?.message || '\u65b9\u5411\u521b\u5efa\u5931\u8d25\u3002', 'error');
            });
            return;
        }

        const videoCardInfoForm = event.target.closest('[data-video-card-info-form]');
        if (videoCardInfoForm) {
            event.preventDefault();
            const values = changedVideoCardValues(videoCardInfoForm);
            if (!Object.keys(values).length) {
                showCanvasNotice('\u6ca1\u6709\u9700\u8981\u4fdd\u5b58\u7684\u4fee\u6539\u3002', 'info');
                return;
            }
            const submit = videoCardInfoForm.querySelector('[type="submit"]');
            if (submit) submit.disabled = true;
            executeVideoCardOperation('card-update', {
                cardId: videoCardInfoForm.dataset.cardId,
                values
            }).then(() => {
                showCanvasNotice('\u89c6\u9891\u5361\u4fe1\u606f\u5df2\u4fdd\u5b58\u3002', 'info');
            }).catch(error => {
                if (submit) submit.disabled = false;
                showCanvasNotice(error?.message || '\u89c6\u9891\u5361\u4fdd\u5b58\u5931\u8d25\u3002', 'error');
            });
            return;
        }

        const ratioApprovalForm = event.target.closest('[data-video-card-approval-ratio]');
        if (ratioApprovalForm) {
            event.preventDefault();
            const submit = ratioApprovalForm.querySelector('[type="submit"]');
            if (submit) submit.disabled = true;
            executeVideoCardOperation('approval-ratio', {
                projectId: canvasRuntime.selectedProjectId,
                cardId: ratioApprovalForm.dataset.cardId,
                targetRatio: ratioApprovalForm.elements.target_ratio?.value,
                reason: ratioApprovalForm.elements.reason?.value?.trim()
            }).then(() => {
                showCanvasNotice('\u6bd4\u4f8b\u53d8\u66f4\u7533\u8bf7\u5df2\u63d0\u4ea4\u3002', 'info');
                ratioApprovalForm.reset();
                if (submit) submit.disabled = false;
            }).catch(error => {
                if (submit) submit.disabled = false;
                showCanvasNotice(error?.message || '\u6bd4\u4f8b\u53d8\u66f4\u7533\u8bf7\u5931\u8d25\u3002', 'error');
            });
            return;
        }

        const reopenApprovalForm = event.target.closest('[data-video-card-approval-reopen]');
        if (reopenApprovalForm) {
            event.preventDefault();
            const submit = reopenApprovalForm.querySelector('[type="submit"]');
            if (submit) submit.disabled = true;
            executeVideoCardOperation('approval-reopen', {
                projectId: canvasRuntime.selectedProjectId,
                cardId: reopenApprovalForm.dataset.cardId,
                reason: reopenApprovalForm.elements.reason?.value?.trim()
            }).then(() => {
                showCanvasNotice('\u89c6\u9891\u5361\u91cd\u5f00\u7533\u8bf7\u5df2\u63d0\u4ea4\u3002', 'info');
                reopenApprovalForm.reset();
                if (submit) submit.disabled = false;
            }).catch(error => {
                if (submit) submit.disabled = false;
                showCanvasNotice(error?.message || '\u89c6\u9891\u5361\u91cd\u5f00\u7533\u8bf7\u5931\u8d25\u3002', 'error');
            });
            return;
        }

        const projectForm = event.target.closest('[data-project-create-form]');
        if (projectForm) {
            event.preventDefault();
            createProjectFromMenu(projectForm);
            return;
        }
        const videoCardForm = event.target.closest('[data-video-card-create-form]');
        if (videoCardForm) {
            event.preventDefault();
            createVideoCardFromMenu(videoCardForm);
        }
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && canvasRuntime.openContextMenu) closeContextMenus();
    });

    function updateSaveIndicator() {
        updateDocumentInteraction();
        updateGraphTools();
        const el = document.getElementById('canvas-save-state');
        if (!el) return;
        const labels = {
            idle: '未保存',
            saving: '保存中',
            saved: '已保存',
            error: '保存失败',
            conflict: '版本冲突',
            offline: '离线待同步'
        };
        el.textContent = canvasRuntime.documentLoaded && !canvasRuntime.documentWritable ? '只读' : labels[canvasRuntime.saveState] || '未保存';
        el.className = `context-status save ${canvasRuntime.saveState}`;
        if (canvasRuntime.saveError) el.title = canvasRuntime.saveError;
        el.disabled = !canvasRuntime.documentWritable || canvasRuntime.contextSwitching || canvasRuntime.saveState === 'saving';
        let recovery = document.getElementById('canvas-save-recovery');
        if (!recovery) {
            recovery = document.createElement('div');
            recovery.id = 'canvas-save-recovery';
            recovery.className = 'canvas-save-recovery';
            recovery.innerHTML = '<span>修改尚未同步</span><button type="button" data-canvas-save-copy>另存副本</button><button type="button" data-canvas-reload>重新读取</button><button type="button" data-canvas-recover-backup>恢复冲突备份</button>';
            document.body.appendChild(recovery);
        }
        const failed = ['conflict', 'error', 'offline'].includes(canvasRuntime.saveState);
        const backup = readConflictBackups().length > 0;
        recovery.hidden = !failed && !backup;
        recovery.querySelector('span').textContent = failed ? '修改尚未同步' : '此设备保留了冲突备份';
        recovery.querySelector('[data-canvas-recover-backup]').hidden = !backup;
        recovery.querySelector('[data-canvas-save-copy]').hidden = !failed || !canvasRuntime.documentWritable;
        recovery.querySelector('[data-canvas-reload]').hidden = !failed;
        recovery.querySelectorAll('button').forEach(button => { button.disabled = canvasRuntime.documentOperation; });
    }

    function hasUnsavedCanvasChanges() {
        const rules = document.querySelector('[data-context-rules-modal]');
        const rulesDirty = rules && (rules._saving || rulesModalDirty(rules));
        return canvasRuntime.documentDirty || canvasRuntime.saveState === 'saving'
            || Boolean(canvasRuntime.failedSaveRequest) || canvasRuntime.documentOperation || Boolean(rulesDirty)
            || Boolean(roleCreator?.hasUnsaved()) || Boolean(roleWorkflow?.hasUnsaved()) || Boolean(roleInstanceLayer?.dirty);
    }

    function canvasExitRisk() {
        const rules = document.querySelector('[data-context-rules-modal]');
        const busy = [
            canvasRuntime.saveState === 'saving' ? '画布正在保存' : '',
            canvasRuntime.documentOperation || canvasRuntime.contextSwitching || canvasRuntime.documentRestoring ? '画布操作正在处理' : '',
            canvasRuntime.uploadsInFlight ? '画布素材正在上传' : '',
            rules?._saving ? '画布规则正在保存' : ''
        ].filter(Boolean);
        const unsaved = [];
        if (rulesModalDirty(rules)) unsaved.push('画布规则');
        if (roleCreator?.hasUnsaved()) unsaved.push('角色设置草稿');
        if (roleWorkflow?.hasUnsaved()) unsaved.push('角色工作草稿');
        if (roleInstanceLayer?.dirty) unsaved.push('角色实例版本');
        if (roleJoinPending()) busy.push('角色加入结果待核对，请用原请求恢复');
        let recoverable = false;
        let snapshot;
        let contentSignature = '';
        try {
            snapshot = canvasSaveSnapshot('exit_check');
            const cached = JSON.parse(localStorage.getItem(draftStorageKey()) || 'null');
            const content = raw => {
                const value = JSON.parse(raw);
                // The save timestamp changes on every snapshot without changing the recoverable content.
                delete value.savedAt;
                return JSON.stringify(value);
            };
            if (snapshot?.request) contentSignature = content(snapshot.request.document_json);
            recoverable = !!canvasRuntime.documentId && !!snapshot?.request && cached?.baseRevision === canvasRuntime.documentRevision
                && typeof cached.request?.document_json === 'string' && content(cached.request.document_json) === contentSignature
                && cached.request?.title === snapshot.request.title;
        } catch { /* Unavailable storage is not proof of a recoverable draft. */ }
        if ((canvasRuntime.documentDirty || canvasRuntime.failedSaveRequest) && !recoverable) unsaved.push('未存入浏览器的画布内容');
        return { unsaved, busy, revision: JSON.stringify([canvasRuntime.editSequence, canvasRuntime.documentTitle, contentSignature,
            rules?._nodeDraft, rules?._purpose, rules?._draft]) };
    }

    function updateDocumentInteraction() {
        const busy = canvasRuntime.documentOperation || canvasRuntime.contextSwitching || canvasRuntime.documentRestoring;
        document.body.classList.toggle('canvas-document-busy', busy);
        document.body.classList.toggle('canvas-document-readonly', !canvasRuntime.documentWritable);
        const workspace = document.getElementById('canvas-workspace');
        if (workspace) workspace.inert = busy;
        document.querySelectorAll('[data-canvas-new], [data-canvas-library], [data-canvas-rename]').forEach(button => {
            button.disabled = busy || (button.hasAttribute('data-canvas-rename') && !canvasRuntime.documentWritable);
        });
        if (window.parent !== window) window.parent.postMessage({ type: 'sd2-canvas-dirty', dirty: hasUnsavedCanvasChanges() }, window.location.origin);
    }

    // Also covers shortcuts registered outside the editor subtree.
    ['keydown', 'paste', 'drop', 'pointerdown', 'mousedown', 'click', 'beforeinput'].forEach(type => {
        window.addEventListener(type, event => {
            const target = event.target instanceof Element ? event.target : null;
            const busy = canvasRuntime.documentOperation || canvasRuntime.contextSwitching || canvasRuntime.documentRestoring;
            if (target?.closest('[data-canvas-confirm], .canvas-product-dialog[open]')) return;
            if (!busy && !canvasRuntime.documentWritable && safeVideoReadInteraction(target, event)) return;
            if (!busy && target?.closest('[data-plan-open], [data-plan-view-source], [data-video-history-preview], [data-video-history-more]')) return;
            if (target?.closest('#ultimate-canvas-documents') && !busy) return;
            const editorEvent = target?.closest('#canvas-workspace, .generation-popover, [data-prompt-editor], [data-context-rules-editor]');
            const shortcut = ['keydown', 'paste', 'drop'].includes(type) && !target?.closest('#header-bar, #canvas-save-recovery');
            if ((busy && (editorEvent || shortcut || target?.closest('#header-bar, #canvas-save-recovery')))
                || (!canvasRuntime.documentWritable && (editorEvent || shortcut))) {
                if (type === 'drop' && Array.from(event.dataTransfer?.types || []).includes('Files')) showCanvasNotice('当前画布不可编辑，未上传文件。', 'warn');
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        }, true);
    });

    function safeVideoReadInteraction(target, event) {
        if (event.type === 'keydown' && event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) return true;
        if (!target?.closest('[data-canvas-inline-video], [data-video-play], [data-video-read-retry], [data-canvas-media-preview]')) return false;
        if (['click', 'pointerdown', 'mousedown'].includes(event.type)) return true;
        return event.type === 'keydown' && !event.ctrlKey && !event.metaKey && !event.altKey
            && [' ', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Escape'].includes(event.key);
    }

    async function withDocumentOperation(action) {
        if (canvasRuntime.documentOperation || canvasRuntime.contextSwitching) throw new Error('画布正在处理，请稍后再操作。');
        canvasRuntime.documentOperation = true;
        updateDocumentInteraction();
        try {
            if (canvasRuntime.flushPromise) await canvasRuntime.flushPromise;
            return await action();
        }
        finally {
            canvasRuntime.documentOperation = false;
            updateSaveIndicator();
            if (canvasRuntime.documentDirty && canvasRuntime.saveState === 'idle' && !canvasRuntime.failedSaveRequest && !canvasRuntime.saveConflict) {
                scheduleCanvasSave('after_document_operation');
            }
        }
    }

    function disposeCanvasPricing() {
        engine.nodes.forEach((_node, nodeId) => window.UltimateCanvasNodePricing?.dispose(nodeId));
    }

    function documentMutationId() {
        return crypto.randomUUID();
    }

    function draftStorageKey() {
        const userId = canvasRuntime.bootstrap?.user?.id;
        return userId && canvasRuntime.documentId
            ? `sd2:canvas-draft:${userId}:${canvasRuntime.selectedProjectId}:${canvasRuntime.documentId}` : null;
    }

    function cacheCanvasDraft(snapshot) {
        const key = draftStorageKey();
        if (!key || !snapshot?.request) return false;
        try {
            localStorage.setItem(key, JSON.stringify({ baseRevision: canvasRuntime.documentRevision, savedAt: Date.now(), request: snapshot.request }));
            return true;
        } catch {
            showCanvasNotice('本地草稿空间不足，请保持页面打开并保存到服务器。', 'warn');
            return false;
        }
    }

    function readConflictBackups() {
        const key = draftStorageKey();
        if (!key) return [];
        try {
            const items = JSON.parse(localStorage.getItem(key.replace('sd2:canvas-draft:', 'sd2:canvas-conflict:')) || '[]');
            return Array.isArray(items) ? items.filter(item => item?.request?.document_json) : [];
        } catch { return []; }
    }

    function preserveConflictBackup(snapshot) {
        const key = draftStorageKey();
        if (!key || !snapshot?.request) throw new Error('无法保留备份，已取消重新读取。');
        const items = readConflictBackups();
        if (!items.some(item => item.request.document_json === snapshot.request.document_json)) {
            items.push({ request: snapshot.request, baseRevision: snapshot.request.base_revision, savedAt: Date.now() });
        }
        try { localStorage.setItem(key.replace('sd2:canvas-draft:', 'sd2:canvas-conflict:'), JSON.stringify(items)); }
        catch { throw new Error('本地空间不足，备份未保存；请先另存副本。'); }
    }

    function snapshotWithoutLiveTasks(raw) {
        const clean = value => {
            if (Array.isArray(value)) return value.map(clean);
            if (!value || typeof value !== 'object') return value;
            return Object.fromEntries(Object.entries(value)
                .filter(([key]) => !/^(role_?(?:task_?run_?id|work_?id|attempt_?id|delivery_?id|confirmation|handoff|fees)|task_?ids?|provider_?task_?id|run_?id|batch_?id|generationResult|generationError|statusEndpoint|frozenCost|styleJob|imageBillingJob|videoSubmission|videoSubmissionLegacy|videoHistory|selectedVideoResult|previewVideoTaskId|generationPayload)$/i.test(key))
                .map(([key, item]) => [key, key === 'generationStatus' ? 'idle' : clean(item)]));
        };
        return JSON.stringify(clean(JSON.parse(raw)));
    }

    async function createRecoveryCopy(snapshot, title) {
        const content = snapshotWithoutLiveTasks(snapshot.request.document_json);
        const signaturePayload = JSON.parse(content);
        delete signaturePayload.savedAt;
        const signature = JSON.stringify([snapshot.request.project_id, title, signaturePayload]);
        if (canvasRuntime.pendingCopy && canvasRuntime.pendingCopy.signature !== signature) {
            throw new Error('上次副本创建结果尚未确认，请先重新读取或恢复原备份后重试。');
        }
        const pending = canvasRuntime.pendingCopy || { signature, request: {
            ...snapshot.request, document_id: undefined, document_json: content,
            base_revision: 0, protocol_version: 2, mutation_id: documentMutationId(), title
        } };
        canvasRuntime.pendingCopy = pending;
        if (!pending.document) {
            const result = await postJson('/api/tools/ultimate-canvas/document', pending.request);
            pending.document = result.document;
        }
        invalidateGenerationContext();
        stopAllVideoPolling();
        const result = await requestJson(`/api/tools/ultimate-canvas/document?document_id=${encodeURIComponent(pending.document.id)}`, { cache: 'no-store' });
        if (!result.document?.document_json) throw new Error('副本已创建，但正文读取失败，请重试。');
        canvasRuntime.pendingCopy = null;
        return result.document;
    }

    function syncDocumentUrl() {
        if (!canvasRuntime.documentId) return;
        const url = new URL(window.location.href);
        url.searchParams.set('document_id', canvasRuntime.documentId);
        history.replaceState(null, '', url);
        if (window.parent !== window) window.parent.postMessage({ type: 'sd2-canvas-document', documentId: canvasRuntime.documentId }, window.location.origin);
    }

    async function openManagedDocument(doc) {
        return withDocumentOperation(() => openManagedDocumentNow(doc));
    }

    async function openManagedDocumentNow(doc, options = {}) {
        if (!options.skipSave && canvasRuntime.documentWritable && !await flushCanvasSave('before_document_open', true)) throw new Error('保存失败，未切换画布。');
        invalidateGenerationContext();
        stopAllVideoPolling();
        disposeCanvasPricing();
        const data = doc.document_json ? { document: doc }
            : await requestJson(`/api/tools/ultimate-canvas/document?document_id=${encodeURIComponent(doc.id)}`, { cache: 'no-store' });
        if (!data.document || !['active', 'archived'].includes(data.document.status)) throw new Error('画布不存在或无权访问。');
        const parsed = JSON.parse(data.document.document_json);
        const nextProjectId = data.document.project_id;
        if (!nextProjectId) throw new Error('此旧画布尚未关联项目，已保留原内容，请管理员处理归属。');
        const previous = {
            bootstrap: canvasRuntime.bootstrap, selectedProjectId: canvasRuntime.selectedProjectId,
            selectedVideoCardId: canvasRuntime.selectedVideoCardId, selectedVideoBranchId: canvasRuntime.selectedVideoBranchId,
            documentId: canvasRuntime.documentId, explicitDocumentId: canvasRuntime.explicitDocumentId,
            documentProjectId: canvasRuntime.documentProjectId, documentVideoCardId: canvasRuntime.documentVideoCardId,
            documentWritable: canvasRuntime.documentWritable, documentLoaded: canvasRuntime.documentLoaded
        };
        canvasRuntime.documentWritable = false;
        canvasRuntime.explicitDocumentId = data.document.id;
        setContextSwitching(true);
        try {
            const bootstrap = await loadCanvasBootstrap(nextProjectId, parsed?.context?.video_card_id || null, { restoreDocument: false });
            if (!bootstrap) throw new Error('项目读取失败，未覆盖原画布。');
            canvasRuntime.documentLoaded = false;
            const loaded = await loadCanvasDocument({ document: data.document, skipDraft: options.skipDraft });
            if (!loaded) throw new Error('画布未恢复，请重试。');
            window.UltimateCanvasDocuments?.hide();
        } catch (error) {
            Object.assign(canvasRuntime, previous);
            canvasRuntime.bootstrapLoaded = Boolean(previous.bootstrap);
            renderRuntimeContextControls();
            throw error;
        } finally {
            setContextSwitching(false);
        }
    }

    async function createManagedDocument(projectId, title, meta = {}) {
        return withDocumentOperation(() => createManagedDocumentNow(projectId, title, meta));
    }

    async function createManagedDocumentNow(projectId, title, meta = {}) {
        if (canvasRuntime.documentWritable && !await flushCanvasSave('before_document_create', true)) throw new Error('当前画布尚未保存。');
        if (canvasRuntime.pendingDocumentCreate && meta.mutation_id
            && canvasRuntime.pendingDocumentCreate.mutation_id !== meta.mutation_id) {
            throw new Error('上次创建结果尚未确认，请先重试原创建操作。');
        }
        const request = canvasRuntime.pendingDocumentCreate || {
            protocol_version: 2, base_revision: 0, mutation_id: meta.mutation_id || documentMutationId(), project_id: projectId,
            title: title || '未命名画布', document_json: JSON.stringify({ schema: 'ultimate_canvas.v1', context: { project_id: projectId }, canvas: { nodes: [], connections: [], panX: 0, panY: 0, scale: 1 } })
        };
        canvasRuntime.pendingDocumentCreate = request;
        const result = await postJson('/api/tools/ultimate-canvas/document', request);
        canvasRuntime.pendingDocumentCreate = null;
        return result.document;
    }

    async function initializeCanvasDocuments() {
        canvasRuntime.documentOperation = true;
        updateDocumentInteraction();
        document.body.classList.add('canvas-document-loading');
        try {
            let initial = null;
            if (canvasRuntime.explicitDocumentId) {
                initial = (await requestJson(`/api/tools/ultimate-canvas/document?document_id=${encodeURIComponent(canvasRuntime.explicitDocumentId)}`, { cache: 'no-store' })).document;
                if (!initial) throw new Error('画布不存在或无权访问。');
            }
            const initialContext = initial ? JSON.parse(initial.document_json)?.context : null;
            const bootstrap = await loadCanvasBootstrap(initial?.project_id || null, initialContext?.video_card_id || null, { restoreDocument: false });
            if (!bootstrap) throw new Error('项目读取失败，请刷新重试。');
            window.UltimateCanvasDocuments?.mount({
                requestJson,
                getProjects: () => canvasRuntime.bootstrap?.context?.projects || [],
                getCurrentDocument: () => ({ id: canvasRuntime.documentId, project_id: canvasRuntime.selectedProjectId, title: canvasRuntime.documentTitle, revision: canvasRuntime.documentRevision }),
                openDocument: openManagedDocument,
                createDocument: createManagedDocument,
                getReturnFocusTarget: () => document.querySelector('[data-canvas-library]'),
                onInitialCancel: async () => {
                    const risk = window.UltimateCanvasGetExitRisk?.();
                    if (risk?.busy?.length || canvasRuntime.failedSaveRequest || canvasRuntime.saveConflict) {
                        showCanvasNotice('当前请求或保存尚未确认，先处理后再返回首页。', 'warn');
                        return false;
                    }
                    // No document has been chosen: return to a real page, never create one on cancel.
                    window.top.location.assign('/');
                    return { focusTarget: document.querySelector('[data-canvas-library]') };
                },
                beforeLeave: async () => {
                    return withDocumentOperation(async () => {
                        const saved = canvasRuntime.documentWritable ? await flushCanvasSave('before_library', true) : true;
                        if (saved) {
                            invalidateGenerationContext();
                            stopAllVideoPolling();
                            disposeCanvasPricing();
                            canvasRuntime.documentWritable = false;
                        }
                        return saved;
                    });
                },
                notice: showCanvasNotice
            });
            canvasRuntime.libraryMounted = true;
            window.UltimateCanvasNodePricing?.mount({ requestJson, getNodeSettings: generationSettingsForNode,
                getProjectId: () => canvasRuntime.selectedProjectId, getBootstrap: () => canvasRuntime.bootstrap,
                getQuoteSnapshot: canvasGenerationQuoteSnapshot,
                onActualQuoteRequired: (node, quote) => canvasStyles.prefetchActualQuote(node.id, quote),
                onQuoteInvalidated: nodeId => canvasStyles.invalidateQuote(nodeId) });
            if (initial) {
                await loadCanvasDocument({ document: initial });
            } else {
                window.UltimateCanvasDocuments?.show();
            }
        } catch (error) {
            showCanvasNotice(error.message || '画布加载失败，请刷新重试。', 'error');
        } finally {
            canvasRuntime.documentOperation = false;
            document.body.classList.remove('canvas-document-loading');
            updateSaveIndicator();
        }
    }

    document.addEventListener('click', async event => {
        try {
            if (event.target.closest('[data-canvas-save-copy]')) {
                await withDocumentOperation(async () => {
                    await canvasRuntime.saveCoordinator.flush();
                    const snapshot = canvasSaveSnapshot('conflict_copy');
                    if (!snapshot?.request) return;
                    preserveConflictBackup(snapshot);
                    const copy = await createRecoveryCopy(snapshot, `${canvasRuntime.documentTitle.slice(0, 112)}（副本）`);
                    if (snapshot.documentId !== canvasRuntime.documentId || snapshot.projectId !== canvasRuntime.selectedProjectId
                        || snapshot.editSequence !== canvasRuntime.editSequence) {
                        cacheCanvasDraft(canvasSaveSnapshot('copy_pending_changes'));
                        showCanvasNotice('副本已创建，期间产生的新修改仍留在当前画布，请继续保存。', 'warn');
                        return;
                    }
                    await openManagedDocumentNow(copy, { skipSave: true, skipDraft: true });
                });
            } else if (event.target.closest('[data-canvas-reload]')) {
                await withDocumentOperation(async () => {
                    if (!await requestCanvasConfirmation({ title: '重新读取画布', message: '未同步内容会独立保留为冲突备份，之后可另存恢复。', confirmLabel: '重新读取' })) return;
                    await canvasRuntime.saveCoordinator.flush();
                    preserveConflictBackup(canvasSaveSnapshot('before_reload'));
                    await openManagedDocumentNow({ id: canvasRuntime.documentId }, { skipSave: true, skipDraft: true });
                });
            } else if (event.target.closest('[data-canvas-recover-backup]')) {
                await withDocumentOperation(async () => {
                    const backups = readConflictBackups();
                    const backup = await requestCanvasBackup(backups);
                    if (!backup) return;
                    if (canvasRuntime.documentWritable && !await flushCanvasSave('before_backup_recovery', true)) throw new Error('请先保存当前修改或另存副本。');
                    const copy = await createRecoveryCopy(backup, `${String(backup.request.title || '画布').slice(0, 108)}（恢复副本）`);
                    await openManagedDocumentNow(copy, { skipSave: true, skipDraft: true });
                });
            } else if (event.target.closest('[data-canvas-library]')) {
                await showManagedLibrary();
            } else if (event.target.closest('[data-canvas-new]')) {
                if (!canvasRuntime.selectedProjectId) return window.UltimateCanvasDocuments?.show();
                await withDocumentOperation(async () => {
                    const doc = await createManagedDocumentNow(canvasRuntime.selectedProjectId, '未命名画布');
                    await openManagedDocumentNow(doc);
                });
            } else if (event.target.closest('[data-canvas-rename]')) {
                if (!canvasRuntime.documentWritable) return;
                const title = await requestCanvasName(canvasRuntime.documentTitle);
                if (!title?.trim()) return;
                canvasRuntime.documentTitle = title.trim().slice(0, 120);
                renderRuntimeContextControls();
                scheduleCanvasSave('rename');
            }
        } catch (error) { showCanvasNotice(error.message || '画布操作失败', 'error'); }
    });

    document.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            if (canvasRuntime.documentWritable) void flushCanvasSave('keyboard');
        }
    }, true);
    window.addEventListener('beforeunload', event => {
        // The React host owns the prompt when embedded, avoiding a second iframe prompt.
        const risk = canvasExitRisk();
        if (window.parent === window && (risk.unsaved.length || risk.busy.length)) { event.preventDefault(); event.returnValue = ''; }
    });
    window.UltimateCanvasHasUnsavedChanges = hasUnsavedCanvasChanges;
    window.UltimateCanvasGetExitRisk = canvasExitRisk;
    window.addEventListener('online', () => {
        if (canvasRuntime.saveState === 'offline') void flushCanvasSave('reconnect');
    });

    async function showManagedLibrary() {
        return withDocumentOperation(async () => {
            if (canvasRuntime.documentWritable && !await flushCanvasSave('before_library', true)) return;
            invalidateGenerationContext();
            stopAllVideoPolling();
            canvasRuntime.documentWritable = false;
            disposeCanvasPricing();
            await window.UltimateCanvasDocuments?.show();
        });
    }

    function syncNodeDataFromDom(nodeId, node) {
        if (node?.type === 'role') return;
        const nodeEl = document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
        if (!nodeEl || !node) return;
        const prompt = collectNodePrompt(nodeEl, node.type);
        const label = nodeEl.querySelector('.node-label')?.textContent?.trim() || '';
        const tabText = nodeEl.querySelector('[data-generation-mode-label]')?.textContent.trim() || activeTabText(nodeEl);
        const contextRules = contextRulesForNode(node);
        const editor = ['text', 'script'].includes(node.type) ? nodeEl.querySelector('.node-text-content') : null;
        const editableValue = editor?.innerText ?? editor?.textContent ?? '';
        const authored = editor && (typeof node.data?.authoredText === 'string'
            || !node.data?.generatedText || editableValue !== node.data.generatedText);
        node.data = {
            ...node.data,
            title: node.data?.title || label,
            prompt: ['text', 'script', 'video', 'image'].includes(node.type) ? prompt : prompt || node.data?.prompt || '',
            ...(authored ? { authoredText: editableValue } : {}),
            contextRules,
            mode: node.type === 'video'
                ? (generationModeMap[tabText] || node.data?.mode || 'text-to-video')
                : node.type === 'image'
                    ? (node.data?.mode || 'text-to-image')
                    : node.data?.mode
        };
    }

    function syncAllNodesFromDom() {
        engine.nodes.forEach((node, nodeId) => syncNodeDataFromDom(nodeId, node));
    }

    function canvasDocumentPayload(context = {}) {
        syncAllNodesFromDom();
        return {
            schema: 'ultimate_canvas.v1',
            schemaVersion: canvasRuntime.documentSchemaVersion === 3 || [...engine.nodes.values()].some(n => n.type === 'role') ? 3 : 2,
            requiredCapabilities: ['role.v1'],
            savedAt: new Date().toISOString(),
            context: {
                project_id: context.projectId ?? canvasRuntime.selectedProjectId,
                video_card_id: context.videoCardId ?? canvasRuntime.selectedVideoCardId,
                video_branch_id: canvasRuntime.selectedVideoBranchId || null
            },
            canvas: engine.serialize()
        };
    }

    function canvasSaveSnapshot(reason) {
        if (canvasRuntime.documentRestoring) return true;
        if (!canvasRuntime.documentWritable) return true;
        if (!canvasRuntime.bootstrapLoaded || !canvasRuntime.selectedProjectId) return true;
        const projectId = canvasRuntime.selectedProjectId;
        const videoCardId = canvasRuntime.selectedVideoCardId;
        const videoBranchId = canvasRuntime.selectedVideoBranchId;
        const documentId = canvasRuntime.documentProjectId === projectId ? canvasRuntime.documentId : null;
        if (!engine.nodes.size && !documentId) return null;
        const payload = window.UltimateCanvasGenerationInteractions.durableCanvasDocument(
            canvasDocumentPayload({ projectId, videoCardId })
        );
        return {
            contextEpoch: canvasRuntime.contextEpoch,
            editSequence: canvasRuntime.editSequence,
            projectId,
            videoCardId,
            videoBranchId,
            documentId,
            request: {
                document_id: documentId,
                project_id: projectId,
                title: canvasRuntime.documentTitle,
                protocol_version: 2,
                required_capabilities: ['role.v1'],
                base_revision: canvasRuntime.documentRevision,
                mutation_id: documentMutationId(),
                active_generation_node_id: engine.selectedNodeId,
                document_json: JSON.stringify(payload),
                save_reason: reason
            }
        };
    }

    function canvasSaveContextMatches(snapshot) {
        return snapshot.contextEpoch === canvasRuntime.contextEpoch
            && snapshot.documentId === canvasRuntime.documentId
            && snapshot.projectId === canvasRuntime.selectedProjectId
            && snapshot.videoCardId === canvasRuntime.selectedVideoCardId
            && snapshot.videoBranchId === canvasRuntime.selectedVideoBranchId;
    }

    canvasRuntime.saveCoordinator = window.UltimateCanvasSaveCoordinator.createCanvasSaveCoordinator({
        isCurrent: job => canvasSaveContextMatches(job.snapshot),
        executor: job => {
            const request = { ...job.snapshot.request };
            if (!canvasSaveContextMatches(job.snapshot)) throw new Error('画布已切换，已停止旧保存请求。');
            if (canvasRuntime.saveConflict) throw Object.assign(new Error('请先处理版本冲突。'), { status: 409 });
            if (canvasRuntime.failedSaveRequest) throw new Error('上次保存结果未确认，请先重试保存。');
            request.base_revision = canvasRuntime.documentRevision;
            if (!request.document_id
                && canvasSaveContextMatches(job.snapshot)
                && canvasRuntime.documentProjectId === job.snapshot.projectId) {
                request.document_id = canvasRuntime.documentId;
            }
            return postJson('/api/tools/ultimate-canvas/document', request).catch(error => {
                if (canvasSaveContextMatches(job.snapshot)) {
                    const status = Number(error?.status);
                    canvasRuntime.failedSaveRequest = !status || status >= 500 || [408, 429].includes(status) ? request : null;
                    canvasRuntime.saveConflict = status === 409;
                }
                throw error;
            });
        },
        onStart: job => {
            if (!canvasSaveContextMatches(job.snapshot)) return;
            canvasRuntime.saveState = 'saving';
            canvasRuntime.saveError = null;
            updateSaveIndicator();
        },
        onSuccess: (result, job, state) => {
            const snapshot = job.snapshot;
            if (!canvasSaveContextMatches(snapshot)) return;
            canvasRuntime.documentId = result.document?.id || snapshot.documentId || canvasRuntime.documentId;
            canvasRuntime.documentProjectId = snapshot.projectId;
            canvasRuntime.documentVideoCardId = snapshot.videoCardId;
            canvasRuntime.documentRevision = result.document?.revision ?? canvasRuntime.documentRevision;
            try {
                const savedNodes = JSON.parse(snapshot.request.document_json)?.canvas?.nodes || [];
                for (const savedNode of savedNodes) {
                    const currentNode = engine.nodes.get(savedNode.id);
                    const pendingRules = currentNode?._pendingTextRules;
                    if (pendingRules && savedNode.data?.contextRules === pendingRules.candidate.contextRules
                        && savedNode.data?.textPurpose === pendingRules.candidate.textPurpose) delete currentNode._pendingTextRules;
                }
            } catch { /* A missing acknowledgement cannot make an unconfirmed rule active. */ }
            canvasRuntime.documentDirty = snapshot.editSequence !== canvasRuntime.editSequence || Boolean(state.hasPending || canvasRuntime.saveTimer);
            canvasRuntime.saveState = canvasRuntime.documentDirty ? 'idle' : 'saved';
            canvasRuntime.saveError = null;
            if (!canvasRuntime.documentDirty) { try { localStorage.removeItem(draftStorageKey()); } catch {} }
            syncDocumentUrl();
            updateSaveIndicator();
        },
        onError: (error, job, state) => {
            if (!canvasSaveContextMatches(job.snapshot) || state.hasPending) return;
            canvasRuntime.saveState = error?.status === 409 ? 'conflict' : navigator.onLine ? 'error' : 'offline';
            canvasRuntime.saveError = error?.message || '保存失败';
            showCanvasNotice(canvasRuntime.saveError, 'warn');
            updateSaveIndicator();
        }
    });

    async function saveCanvasDocument(reason = 'autosave') {
        if (canvasRuntime.documentOperation || canvasRuntime.saveConflict || roleJoinPending()) return false;
        const snapshot = canvasSaveSnapshot(reason);
        if (!snapshot || snapshot === true) return true;
        const outcome = await canvasRuntime.saveCoordinator.request(snapshot);
        return outcome.ok;
    }

    async function flushCanvasSave(reason = 'flush', insideDocumentOperation = false) {
        if (canvasRuntime.documentOperation && !insideDocumentOperation) return false;
        if (canvasRuntime.flushPromise) return canvasRuntime.flushPromise;
        const pending = flushCanvasSaveNow(reason);
        canvasRuntime.flushPromise = pending;
        try { return await pending; }
        finally { if (canvasRuntime.flushPromise === pending) canvasRuntime.flushPromise = null; }
    }

    async function flushCanvasSaveNow(reason) {
        if (!canvasRuntime.documentWritable) return true;
        if (roleJoinPending()) return false;
        if (canvasRuntime.saveConflict) return false;
        if (!canvasRuntime.documentDirty && canvasRuntime.saveState === 'saved' && !canvasRuntime.failedSaveRequest) return true;
        window.clearTimeout(canvasRuntime.saveTimer);
        canvasRuntime.saveTimer = null;
        await canvasRuntime.saveCoordinator.flush();
        if (canvasRuntime.saveConflict) return false;
        const identity = canvasSaveSnapshot(reason);
        if (!identity?.request) return !canvasRuntime.documentDirty;
        if (canvasRuntime.failedSaveRequest) {
            const failedRequest = canvasRuntime.failedSaveRequest;
            try {
                canvasRuntime.saveState = 'saving';
                updateSaveIndicator();
                const result = await postJson('/api/tools/ultimate-canvas/document', failedRequest);
                if (!canvasSaveContextMatches(identity)) return false;
                canvasRuntime.documentRevision = result.document.revision;
                canvasRuntime.failedSaveRequest = null;
            } catch (error) {
                if (!canvasSaveContextMatches(identity)) return false;
                const status = Number(error?.status);
                if (status && status < 500 && ![408, 429].includes(status)) canvasRuntime.failedSaveRequest = null;
                canvasRuntime.saveConflict = status === 409;
                canvasRuntime.saveState = status === 409 ? 'conflict' : navigator.onLine ? 'error' : 'offline';
                updateSaveIndicator();
                showCanvasNotice(error.message || '保存重试失败，草稿已保留。', 'warn');
                return false;
            }
        }
        // A save is a barrier only once it includes every edit made while it was in flight.
        while (canvasSaveContextMatches(identity)) {
            window.clearTimeout(canvasRuntime.saveTimer);
            canvasRuntime.saveTimer = null;
            const snapshot = canvasSaveSnapshot(reason);
            if (!snapshot?.request) return false;
            cacheCanvasDraft(snapshot);
            const outcome = await canvasRuntime.saveCoordinator.flush(snapshot);
            if (!outcome.ok || !canvasSaveContextMatches(identity)) return false;
            if (snapshot.editSequence === canvasRuntime.editSequence) return true;
        }
        return false;
    }

    function scheduleCanvasSave(reason = 'change') {
        if (canvasRuntime.documentRestoring || !canvasRuntime.documentWritable) return;
        canvasRuntime.editSequence += 1;
        canvasRuntime.documentDirty = true;
        window.clearTimeout(canvasRuntime.saveTimer);
        if (!canvasRuntime.saveConflict && canvasRuntime.saveState !== 'saving') {
            canvasRuntime.saveState = 'idle';
        }
        updateSaveIndicator();
        canvasRuntime.saveTimer = window.setTimeout(() => {
            canvasRuntime.saveTimer = null;
            cacheCanvasDraft(canvasSaveSnapshot(reason));
            if (!navigator.onLine) { canvasRuntime.saveState = 'offline'; updateSaveIndicator(); return; }
            if (!canvasRuntime.failedSaveRequest && !canvasRuntime.saveConflict && !canvasRuntime.documentOperation) void saveCanvasDocument(reason);
        }, 900);
    }

    function hydrateNodeViews() {
        let recoveredTasklessVideoStatus = false;
        engine.nodes.forEach((node) => {
            if (node.type === 'video' && !node.data?.taskId && !node.data?.videoSubmission
                && ['submitted', 'running', 'queued', 'processing'].includes(node.data?.generationStatus)) {
                node.data.generationStatus = 'unconfirmed';
                node.data.videoSubmissionLegacy = true;
                recoveredTasklessVideoStatus = true;
            }
            const nodeEl = document.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`);
            if (!nodeEl) return;
            renderGenerationNodeControls(node.id);
            if (node.data?.generationStatus === 'failed') {
                setNodeGenerationStatus(nodeEl, 'error', node.data.generationError || '上次生成失败，输入和素材已保留');
            } else if (node.data?.generationStatus === 'succeeded') {
                setNodeGenerationStatus(nodeEl, 'success', '生成已完成');
            } else if (node.data?.generationStatus && node.data.generationStatus !== 'idle') {
                const needsAction = ['unconfirmed', 'uncertain'].includes(node.data.generationStatus);
                setNodeGenerationStatus(nodeEl, needsAction ? 'warn' : 'info', videoStageLabel(node.data.generationStatus));
            }
            if (node.type === 'image') {
                syncImageModeButtons(nodeEl, node.data?.mode || 'text-to-image');
                if (node.data?.styleJob) void canvasStyles.resume(node.id);
                if (node.data?.imageBillingJob) void canvasStyles.resumeBilling(node.id);
            }
            if ((node.type === 'text' || node.type === 'script') && (typeof node.data?.authoredText === 'string'
                || node.data?.generatedText || node.data?.prompt)) {
                renderTextNodeBody(nodeEl, node);
                return;
            }
            if (['upload', 'asset', 'reference_image'].includes(node.data?.source) && node.data?.assetId && !node.data?.taskId) {
                const mediaUrl = `/api/content-reactions/media?key=${encodeURIComponent(`asset:${node.data.assetId}`)}&variant=preview`;
                decorateGeneratedNode(node.id, node.data.title || '导入素材', '',
                    node.type === 'image' ? mediaUrl : node.data.thumbnailUrl || '', { mediaType: node.type, mediaUrl, imageUrl: mediaUrl });
                return;
            }
            if (node.type === 'image' && (node.data?.previewImage || node.data?.thumbnailUrl)) {
                decorateGeneratedNode(
                    node.id,
                    node.data.title || '图片生成结果',
                    node.data.description || node.data.prompt || '已恢复图片节点',
                    node.data.previewImage || node.data.thumbnailUrl || '',
                    {
                        imageUrl: node.data.originalUrl || node.data.imageUrl || node.data.previewImage || node.data.thumbnailUrl || '',
                        downloadUrl: node.data.imageDownloadUrl || node.data.originalUrl
                            || node.data.imageUrl || node.data.previewImage || node.data.thumbnailUrl || ''
                    }
                );
                return;
            }
            if (node.type === 'video' && node.data?.taskId) {
                applyVideoTaskStatus(node.id, videoTaskForNode(node));
            }
        });
        return recoveredTasklessVideoStatus;
    }

    async function loadCanvasDocument(options = {}) {
        if (!canvasRuntime.selectedProjectId || canvasRuntime.documentLoaded) return false;
        canvasRuntime.documentWritable = false;
        const projectId = canvasRuntime.selectedProjectId;
        const requestId = ++canvasRuntime.documentRequestId;
        const explicitId = canvasRuntime.explicitDocumentId;
        const isCurrent = () => requestId === canvasRuntime.documentRequestId
            && projectId === canvasRuntime.selectedProjectId && explicitId === canvasRuntime.explicitDocumentId;
        let recoveredTasklessVideoStatus = false;
        let recoveredDraft = false;
        canvasRuntime.documentRestoring = true;
        updateDocumentInteraction();
        try {
            const url = new URL('/api/tools/ultimate-canvas/document', window.location.origin);
            url.searchParams.set('project_id', projectId);
            if (canvasRuntime.explicitDocumentId) url.searchParams.set('document_id', canvasRuntime.explicitDocumentId);
            const data = options.document ? { document: options.document } : await requestJson(url.toString(), { cache: 'no-store' });
            if (!isCurrent()) return false;
            if (!data.document?.document_json) {
                if (options.clearWhenMissing !== false) {
                    stopAllVideoPolling();
                    clearCanvasForContext();
                }
                canvasRuntime.documentId = null;
                canvasRuntime.documentProjectId = projectId;
                canvasRuntime.documentVideoCardId = canvasRuntime.selectedVideoCardId;
                canvasRuntime.saveState = 'idle';
                canvasRuntime.documentLoaded = true;
                canvasRuntime.documentDirty = false;
                updateSaveIndicator();
                return false;
            }
            let documentToRestore = data.document;
            let parsed = JSON.parse(documentToRestore.document_json);
            const savedProjectId = parsed?.context?.project_id || data.document.project_id;
            if (savedProjectId && savedProjectId !== projectId) {
                throw new Error('画布文档归属与当前项目不一致，已停止恢复。');
            }
            const userId = canvasRuntime.bootstrap?.user?.id;
            const draftKey = userId ? `sd2:canvas-draft:${userId}:${projectId}:${documentToRestore.id}` : null;
            let draft = null;
            try { if (draftKey) draft = JSON.parse(localStorage.getItem(draftKey) || 'null'); } catch {}
            if (!options.skipDraft && documentToRestore.status === 'active' && draft?.request?.document_json
                && draft.request.document_json !== documentToRestore.document_json) {
                const sameRevision = draft.baseRevision === documentToRestore.revision;
                const recover = await requestCanvasConfirmation({ title: '发现未保存草稿',
                    message: sameRevision ? '要恢复这台设备的未保存修改吗？' : '服务器内容已更新。恢复草稿会另存新画布，不覆盖原画布。', confirmLabel: '恢复草稿' });
                if (!isCurrent()) return false;
                if (recover) {
                    if (sameRevision) {
                        parsed = JSON.parse(draft.request.document_json);
                        recoveredDraft = true;
                    } else {
                        documentToRestore = await createRecoveryCopy(draft, `${documentToRestore.title.slice(0, 108)}（恢复副本）`);
                        if (!isCurrent()) return false;
                        // New documents are restored exclusively from the server's sanitized body.
                        parsed = JSON.parse(documentToRestore.document_json);
                    }
                }
            }
            const savedVideoBranchId = parsed?.context?.video_branch_id || null;
            let branchId = savedVideoBranchId;
            if (savedVideoBranchId && canvasRuntime.selectedVideoCardId) {
                try {
                    const workspace = await loadVideoCardWorkspace(canvasRuntime.selectedVideoCardId);
                    if (!isCurrent()) return false;
                    branchId = window.UltimateCanvasVideoCards.chooseBranch(
                        workspace?.branches || [],
                        savedVideoBranchId
                    ) || null;
                } catch (error) {
                    if (!isCurrent()) return false;
                    branchId = null;
                    showCanvasNotice(error?.message || '\u89c6\u9891\u65b9\u5411\u6062\u590d\u5931\u8d25\uff0c\u5df2\u56de\u9000\u5230\u9ed8\u8ba4\u65b9\u5411\u3002', 'warn');
                }
            }
            if (!isCurrent()) return false;
            if (!Array.isArray(parsed?.canvas?.nodes) || !Array.isArray(parsed?.canvas?.connections)) throw new Error('画布正文不完整，已停止恢复。');
            if (parsed.context?.project_id && parsed.context.project_id !== projectId) throw new Error('草稿项目不一致，已停止恢复。');
            invalidateGenerationContext();
            stopAllVideoPolling();
            disposeCanvasPricing();
            clearAllVideoEstimates();
            window.clearTimeout(canvasRuntime.saveTimer);
            canvasRuntime.saveTimer = null;
            canvasRuntime.documentId = documentToRestore.id;
            canvasRuntime.explicitDocumentId = documentToRestore.id;
            canvasRuntime.documentRevision = documentToRestore.revision || 0;
            canvasRuntime.documentSchemaVersion = documentToRestore.schema_version || parsed.schemaVersion || 2;
            canvasRuntime.documentTitle = recoveredDraft ? draft.request.title : documentToRestore.title || '未命名画布';
            canvasRuntime.failedSaveRequest = null;
            canvasRuntime.saveConflict = false;
            canvasRuntime.documentProjectId = projectId;
            canvasRuntime.documentVideoCardId = parsed?.context?.video_card_id || canvasRuntime.selectedVideoCardId;
            canvasRuntime.selectedVideoBranchId = branchId;
            canvasRuntime.documentWritable = documentToRestore.status === 'active';
            engine.restore(parsed.canvas || parsed);
            window.UltimateCanvasToolflow?.normalizeLoadedFlowNodes?.();
            recoveredTasklessVideoStatus = hydrateNodeViews();
            if (canvasRuntime.explicitFocusNode && /^[A-Za-z0-9_-]{1,160}$/.test(canvasRuntime.explicitFocusNode)
                && engine.nodes.has(canvasRuntime.explicitFocusNode)) {
                planSplit.focus([canvasRuntime.explicitFocusNode], { includeControls: true });
                canvasRuntime.explicitFocusNode = null;
            }
            refreshContextRulesButtons();
            canvasRuntime.saveState = 'saved';
            canvasRuntime.saveError = null;
            canvasRuntime.documentLoaded = true;
            canvasRuntime.documentDirty = recoveredDraft;
            canvasRuntime.editSequence += 1;
            syncDocumentUrl();
            renderRuntimeContextControls();
            if (!canvasRuntime.documentWritable) {
                stopAllVideoPolling();
                showCanvasNotice('此画布已归档，只能查看。请到画布列表恢复后编辑。', 'info');
            }
            return true;
        } catch (error) {
            if (requestId !== canvasRuntime.documentRequestId || projectId !== canvasRuntime.selectedProjectId) return false;
            canvasRuntime.documentLoaded = false;
            canvasRuntime.saveState = 'error';
            canvasRuntime.saveError = error?.message || '画布恢复失败';
            showCanvasNotice(canvasRuntime.saveError, 'warn');
            return false;
        } finally {
            if (requestId === canvasRuntime.documentRequestId) {
                canvasRuntime.documentRestoring = false;
                updateSaveIndicator();
                if (recoveredTasklessVideoStatus && projectId === canvasRuntime.selectedProjectId) {
                    scheduleCanvasSave('recover_taskless_video_status');
                }
                if (canvasRuntime.documentDirty) scheduleCanvasSave('draft_recovery');
                if (canvasRuntime.documentLoaded && canvasRuntime.documentWritable) {
                    engine.nodes.forEach(node => {
                        if (node.data?.videoSubmission?.state === 'unconfirmed') void recoverVideoSubmission(node.id);
                    });
                }
                if (canvasRuntime.documentLoaded) void recheckBoundVideoNodes();
            }
        }
    }

    function installAutosaveHooks() {
        const originalRestore = engine.restore.bind(engine);
        engine.restore = (...args) => {
            releaseInlineVideos();
            videoReadOrders.clear();
            const result = originalRestore(...args);
            graphCommands.clear();
            let visible = false;
            try { visible = localStorage.getItem(minimapKey()) === '1'; } catch {}
            document.getElementById('canvas-minimap').hidden = !visible;
            document.getElementById('btn-minimap').classList.toggle('active', visible);
            updateGraphTools();
            return result;
        };
        const originalAddNode = engine.addNode.bind(engine);
        engine.addNode = (...args) => {
            const nodeId = originalAddNode(...args);
            refreshContextRulesButtons();
            updateGenerationLabels(canvasRuntime.bootstrap);
            scheduleCanvasSave('node_add');
            return nodeId;
        };
        const originalDeleteNode = engine.deleteNode.bind(engine);
        engine.deleteNode = (...args) => {
            window.UltimateCanvasNodePricing?.dispose(args[0]);
            const deletedNode = engine.nodes.get(args[0]);
            releaseInlineVideos(args[0]);
            for (const key of videoReadOrders.keys()) if (key.startsWith(`${args[0]}:`)) videoReadOrders.delete(key);
            if (deletedNode?.data?.taskId) stopVideoPolling(deletedNode.data.taskId, deletedNode.id);
            (deletedNode?.data?.videoHistory || []).forEach(item => stopVideoPolling(item.taskId, deletedNode.id));
            const estimate = canvasRuntime.videoEstimates.get(args[0]);
            if (estimate?.timer) window.clearTimeout(estimate.timer);
            estimate?.controller?.abort();
            canvasRuntime.videoEstimates.delete(args[0]);
            const nextSelection = CanvasReferenceSelection.deleteNode(canvasRuntime.referenceSelection, args[0]);
            if (canvasRuntime.referenceSelection && !nextSelection.active) {
                finishReferenceSelection({ returnToTarget: false });
            } else if (nextSelection) {
                canvasRuntime.referenceSelection = nextSelection;
            }
            const result = originalDeleteNode(...args);
            syncReferenceSelection();
            renderReferenceSelectionStatus();
            renderAllGenerationNodeControls();
            scheduleCanvasSave('node_delete');
            return result;
        };
        const originalCreateConnection = engine._createConnection.bind(engine);
        engine._createConnection = (...args) => {
            const result = originalCreateConnection(...args);
            syncReferenceSelection();
            renderGenerationNodeControls(args[1]);
            scheduleCanvasSave('connection_change');
            return result;
        };
        const originalMouseUp = engine._onMouseUp.bind(engine);
        engine._onMouseUp = (...args) => {
            const wasDragging = engine.isDraggingNode;
            const result = originalMouseUp(...args);
            if (wasDragging) scheduleCanvasSave('node_move');
            return result;
        };
        engine.onConnectionDeleted = (_fromId, toId) => {
            syncReferenceSelection();
            renderReferenceSelectionStatus();
            renderGenerationNodeControls(toId);
            scheduleCanvasSave('connection_change');
        };
    }

    document.addEventListener('input', (event) => {
        const nodeEl = event.target.closest('.canvas-node');
        if (nodeEl) {
            scheduleCanvasSave('node_input');
            const node = engine.nodes.get(nodeEl.dataset.nodeId);
            if (node?.type === 'video' && event.target.matches('.video-props-textarea')) {
                syncNodeDataFromDom(node.id, node);
                renderGenerationNodeControls(node.id);
            }
            if (['text', 'script'].includes(node?.type)) engine.nodes.forEach(item => {
                if (item.data?.planSource?.sourceNodeId === node.id) planSplit.renderNode(item.id);
            });
        }
    });

    function canvasCenter() {
        const rect = document.getElementById('canvas-container').getBoundingClientRect();
        return {
            x: (rect.width / 2 - engine.offsetX) / engine.scale - 300,
            y: (rect.height / 2 - engine.offsetY) / engine.scale - 170
        };
    }

    function itemPreview(item) {
        return item.thumbnailUrl || item.previewUrl || item.downloadUrl || '';
    }

    function renderLibraryItems(container, items, emptyText) {
        if (!container) return;
        if (!items?.length) {
            container.innerHTML = `<div class="empty-state"><strong>${escapeHtml(emptyText)}</strong><span>当前项目下还没有可复用内容。</span></div>`;
            return;
        }
        container.innerHTML = `<div class="canvas-library-list">${items.map(item => `
            <button class="canvas-library-item" draggable="true" data-library-id="${escapeHtml(item.id)}">
                <span class="library-thumb">
                    ${itemPreview(item)
                        ? `<img src="${escapeHtml(itemPreview(item))}" alt="${escapeHtml(item.title)}">`
                        : '<span class="library-thumb-placeholder"></span>'}
                </span>
                <span class="library-meta">
                    <strong>${escapeHtml(item.title || item.id)}</strong>
                    <small>${escapeHtml(item.kind)} · ${escapeHtml(item.status || item.source || '')}</small>
                </span>
            </button>
        `).join('')}</div>`;
    }

    async function fetchLibraryItems(params) {
        const url = new URL('/api/assets/library', window.location.origin);
        Object.entries(params).forEach(([key, value]) => {
            if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
        });
        const data = await requestJson(url.toString(), { cache: 'no-store' });
        return data.items || [];
    }

    async function loadLibraryPanels(force = false) {
        if (!canvasRuntime.bootstrapLoaded || !canvasRuntime.selectedProjectId) return;
        if (!force && canvasRuntime.libraryLoaded && canvasRuntime.historyLoaded) return;
        const projectId = canvasRuntime.selectedProjectId;
        try {
            const [assetItems, historyItems] = await Promise.all([
                fetchLibraryItems({
                    type: 'all',
                    scope: 'project',
                    status: 'all',
                    sort: 'created_desc',
                    project_id: projectId,
                    limit: 24
                }),
                fetchLibraryItems({
                    type: 'video',
                    scope: 'project',
                    status: 'all',
                    sort: 'created_desc',
                    project_id: projectId,
                    limit: 24
                })
            ]);
            if (projectId !== canvasRuntime.selectedProjectId) return;
            canvasRuntime.libraryItems = assetItems;
            canvasRuntime.historyItems = historyItems;
            renderLibraryItems(document.getElementById('assets-panel-body'), assetItems, '暂无素材');
            renderLibraryItems(document.getElementById('history-panel-body'), historyItems, '暂无生成历史');
            canvasRuntime.libraryLoaded = true;
            canvasRuntime.historyLoaded = true;
        } catch (error) {
            showCanvasNotice(error?.message || '素材/历史加载失败。', 'warn');
        }
    }

    function createNodeFromLibraryItem(item) {
        if (!item) return;
        const center = canvasCenter();
        const isVideo = item.kind === 'video';
        const referenceTargetId = canvasRuntime.pendingGenerationReferenceTargetId;
        const referenceTarget = referenceTargetId ? engine.nodes.get(referenceTargetId) : null;
        const nodeX = referenceTarget ? referenceTarget.x - 720 : center.x;
        const nodeY = referenceTarget ? referenceTarget.y : center.y;
        const nodeId = engine.addNode(isVideo ? 'video' : 'image', nodeX, nodeY, {
            title: item.title,
            prompt: item.prompt || item.title,
            description: item.prompt || item.title,
            assetId: item.assetId || null,
            referenceImageId: item.referenceImageId || null,
            workspaceAssetId: item.workspaceAssetId || item.workspace_asset_id || null,
            taskId: item.taskId || null,
            previewImage: itemPreview(item),
            thumbnailUrl: item.thumbnailUrl || itemPreview(item),
            originalUrl: item.originalUrl || item.downloadUrl || '',
            width: item.width || null,
            height: item.height || null,
            videoPreviewUrl: item.previewUrl || null,
            videoDownloadUrl: item.downloadUrl || null,
            source: item.source,
            generationStatus: item.status || 'active'
        });
        decorateGeneratedNode(
            nodeId,
            item.title || (isVideo ? '历史视频' : '历史素材'),
            item.prompt || `${item.source || '素材'} 已加入画布`,
            item.thumbnailUrl || itemPreview(item),
            isVideo && item.taskId ? {
                taskId: item.taskId,
                videoUrl: item.previewUrl,
                downloadUrl: item.downloadUrl
            } : isVideo && item.assetId ? {
                mediaType: 'video', mediaUrl: `/api/content-reactions/media?key=${encodeURIComponent(`asset:${item.assetId}`)}&variant=preview`
            } : {
                imageUrl: item.originalUrl || item.downloadUrl || itemPreview(item),
                downloadUrl: item.downloadUrl || item.originalUrl || itemPreview(item)
            }
        );
        if (referenceTargetId && !isVideo && engine.nodes.has(referenceTargetId)) {
            if (canvasRuntime.referenceSelection?.targetNodeId === referenceTargetId) {
                selectCanvasReference(nodeId);
            } else {
                engine.connectNodes(nodeId, referenceTargetId);
            }
            canvasRuntime.pendingGenerationReferenceTargetId = CanvasReferenceSelection.pendingTargetId(
                canvasRuntime.referenceSelection
            );
            renderGenerationNodeControls(referenceTargetId);
            showCanvasNotice('参考图已加入并连接到生成节点。', 'info');
        }
        showPanel(null);
        scheduleCanvasSave('library_item_add');
        return nodeId;
    }

    document.addEventListener('click', (event) => {
        const libraryItem = event.target.closest('.canvas-library-item');
        if (!libraryItem) return;
        const itemId = libraryItem.dataset.libraryId;
        const item = [...(canvasRuntime.libraryItems || []), ...(canvasRuntime.historyItems || [])]
            .find(entry => entry.id === itemId);
        if (canvasRuntime.pendingGenerationReferenceTargetId && item?.kind === 'video') {
            showCanvasNotice('视频不能作为图片参考，请选择一张已入库图片。', 'warn');
            return;
        }
        createNodeFromLibraryItem(item);
    });

    async function uploadCanvasFile(file, role = '', canvasNodeId = '', onProgress = null, originalRequestId = '') {
        if (!canvasRuntime.selectedProjectId || !canvasRuntime.selectedVideoCardId) {
            throw new Error('请先选择项目和视频卡，再上传素材。');
        }
        if (!canvasRuntime.documentId || !graphEditAllowed() || window.parent === window) throw new Error('请先保存可编辑画布，再上传素材。');
        const requestId = originalRequestId || crypto.randomUUID();
        const captured = uploadContextKey();
        canvasRuntime.uploadsInFlight += 1;
        try {
            return await new Promise((resolve, reject) => {
                canvasUploadRequests.set(requestId, { captured, nodeId: canvasNodeId, resolve, reject, onProgress });
                window.parent.postMessage({ type: 'sd2-canvas-upload-request', requestId,
                    userId: canvasRuntime.bootstrap?.user?.id, documentId: canvasRuntime.documentId,
                    projectId: canvasRuntime.selectedProjectId, cardId: canvasRuntime.selectedVideoCardId,
                    files: [{ file, nodeId: canvasNodeId }] }, window.location.origin);
            });
        } finally { canvasRuntime.uploadsInFlight -= 1; }
    }

    const canvasUploadRequests = new Map();
    function uploadContextKey() { return JSON.stringify([canvasRuntime.bootstrap?.user?.id, canvasRuntime.documentId,
        canvasRuntime.selectedProjectId, canvasRuntime.selectedVideoCardId, canvasRuntime.contextEpoch]); }
    window.UltimateCanvasUploadContextMatches = requestId => {
        const pending = canvasUploadRequests.get(requestId);
        return Boolean(pending && pending.captured === uploadContextKey() && canvasRuntime.documentWritable
            && !canvasRuntime.contextSwitching && !canvasRuntime.documentRestoring);
    };
    window.addEventListener('message', event => {
        if (event.origin !== location.origin || event.source !== window.parent || event.data?.type !== 'sd2-canvas-upload-receipt') return;
        const message = event.data;
        const pending = canvasUploadRequests.get(message.requestId);
        if (!pending) return;
        if (!window.UltimateCanvasUploadContextMatches(message.requestId)) {
            canvasUploadRequests.delete(message.requestId); pending.reject(new Error('画布目标已改变，原素材保留，未写回旧画布')); return;
        }
        if (message.progress) { pending.onProgress?.(message.progress); return; }
        if (message.nodeId !== pending.nodeId || typeof message.success !== 'boolean') return;
        canvasUploadRequests.delete(message.requestId);
        if (message.success && message.result?.success) pending.resolve(message.result);
        else pending.reject(new Error(message.error || '上传结果尚未确认，未重传原文件'));
    });

    function canvasFilePosition(clientX, clientY) {
        const rect = document.getElementById('canvas-container').getBoundingClientRect();
        return { x: (clientX - rect.left - engine.offsetX) / engine.scale,
            y: (clientY - rect.top - engine.offsetY) / engine.scale };
    }
    function canvasUploadPosition(nodeIds, cx, cy) {
        let x = cx;
        nodeIds.forEach(nodeId => {
            const node = engine.nodes.get(nodeId);
            if (!node) return;
            const element = document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
            x = Math.max(x, node.x + (element?.offsetWidth || 624) + 40);
        });
        return { x, y: cy };
    }
    function queueCanvasFiles(files, cx, cy, pendingConnection = null) {
        if (!graphEditAllowed()) { showCanvasNotice('当前画布不可编辑或正在处理，未上传文件。', 'warn'); return; }
        const entries = Array.from(files || []);
        if (entries.length > 20) { showCanvasNotice('一次最多导入20个文件，请分批选择。', 'warn'); return; }
        if (!entries.length) return;
        const queuedContext = uploadContextKey();
        const placedNodeIds = [];
        let tray = document.querySelector('[data-canvas-upload-tray]');
        if (!tray) { tray = document.createElement('div'); tray.dataset.canvasUploadTray = ''; tray.className = 'canvas-upload-tray'; document.body.appendChild(tray); }
        let chain = Promise.resolve();
        entries.forEach(file => {
            const row = document.createElement('div'); row.className = 'canvas-upload-row';
            const label = document.createElement('span'); label.textContent = file.name; row.appendChild(label);
            const status = document.createElement('span'); status.textContent = '等待上传'; row.appendChild(status);
            const retry = document.createElement('button'); retry.type = 'button'; retry.title = '恢复此文件'; retry.innerHTML = window.UltimateCanvasIcons('RotateCcw', 14); retry.hidden = true; row.appendChild(retry);
            const remove = document.createElement('button'); remove.type = 'button'; remove.title = '移除上传条目，不删除原素材'; remove.innerHTML = window.UltimateCanvasIcons('X', 14); row.appendChild(remove);
            tray.appendChild(row);
            let running = false, removed = false;
            const nodeId = `node-upload-${crypto.randomUUID()}`;
            const uploadRequestId = crypto.randomUUID();
            const run = async () => {
                if (removed || running) return;
                if (queuedContext !== uploadContextKey()) { status.textContent = '画布或账号已变化，未上传此文件'; retry.hidden = true; return; }
                if (!/^(image|video|audio)\//.test(file.type) || (pendingConnection?.role === 'input' && !file.type.startsWith('image/'))) {
                    status.textContent = '此处不支持该文件类型'; return;
                }
                running = true; retry.hidden = true; remove.disabled = true; status.textContent = '正在读取原文件';
                const captured = uploadContextKey();
                try {
                    const result = await uploadCanvasFile(file, '', nodeId, progress => {
                        status.textContent = progress.totalBytes > 0 && Number.isFinite(progress.loadedBytes)
                            ? `${progress.label || '正在上传'} ${Math.min(100, Math.round(progress.loadedBytes / progress.totalBytes * 100))}%`
                            : progress.label || '正在上传';
                    }, uploadRequestId);
                    if (captured !== uploadContextKey()) throw new Error('画布目标已改变，未写回旧画布');
                    if (!engine.nodes.has(nodeId)) {
                        const position = canvasUploadPosition(placedNodeIds, cx, cy);
                        createUploadedNode(result, position.x, position.y, pendingConnection, nodeId);
                    }
                    status.textContent = '已加入画布';
                } catch (error) { status.textContent = error?.message || '上传未确认'; retry.hidden = false; }
                finally {
                    if (engine.nodes.has(nodeId) && !placedNodeIds.includes(nodeId)) placedNodeIds.push(nodeId);
                    running = false; remove.disabled = false;
                }
            };
            retry.addEventListener('click', () => { chain = chain.then(run); });
            remove.addEventListener('click', () => { if (!running) { removed = true; row.remove(); if (!tray.children.length) tray.remove(); } });
            chain = chain.then(run);
        });
    }

    function createUploadedNode(uploadResult, cx, cy, pendingConnection = null, requestedNodeId = '') {
        const asset = uploadResult.asset || {};
        const type = asset.mimeType?.startsWith('video/') ? 'video'
            : asset.mimeType?.startsWith('audio/') ? 'audio'
                : 'image';
        const imagePreview = type === 'image' ? (asset.thumbnailUrl || asset.originalUrl || '') : '';
        const nodeId = engine.addNode(type, cx, cy, {
            id: requestedNodeId || undefined,
            title: asset.fileName || '上传素材',
            description: uploadResult.reference_image_id ? '已上传并加入参考图体系' : '已上传到站内资产库',
            assetId: asset.id,
            referenceImageId: uploadResult.reference_image_id || null,
            workspaceAssetId: uploadResult.workspace_asset_id || null,
            previewImage: imagePreview,
            thumbnailUrl: imagePreview,
            originalUrl: asset.originalUrl || '',
            width: asset.width || null,
            height: asset.height || null,
            videoPreviewUrl: type === 'video' ? asset.originalUrl || '' : '',
            source: 'upload'
        });
        decorateGeneratedNode(
            nodeId,
            asset.fileName || '上传素材',
            uploadResult.reference_image_id ? '已上传并可作为生成参考图。' : '已上传到站内资产库。',
            imagePreview, { mediaType: type, mediaUrl: asset.id ? `/api/content-reactions/media?key=${encodeURIComponent(`asset:${asset.id}`)}&variant=preview` : '' }
        );
        connectMenuNode(nodeId, pendingConnection);
        scheduleCanvasSave('upload_asset');
        loadLibraryPanels(true);
    }

    const generationModeMap = {
        '文生视频': 'text-to-video',
        '全部参考': 'all-reference-video',
        '全能参考': 'all-reference-video',
        '图生视频': 'image-to-video',
        '首尾帧': 'first-last-frame-video',
        '图片参考': 'image-reference-video'
    };

    function generationSettingsForNode(node) {
        if (!node) return {};
        if (node.type === 'image') {
            if (node.data?.canvasStyle) {
                const style = node.data.canvasStyle;
                const first = availableGenerationReferenceItems(node.id).find(item => item.width > 0 && item.height > 0);
                const ratio = window.UltimateCanvasGenerationInteractions.resolveImageRatio(style.aspectRatio || 'auto', first, '1:1');
                return { model: style.model, quality: style.quality, ratio: ratio.resolved, requestedRatio: style.aspectRatio,
                    ratioSource: ratio.source, resolution: style.resolution,
                    size: window.UltimateCanvasGenerationInteractions.imageSizeForRatio(ratio.resolved, style.resolution),
                    count: style.count, maximumCount: style.count, sizeOptions: [style.resolution] };
            }
            const capability = canvasRuntime.bootstrap?.capabilities?.image || {};
            const current = node.data?.imageSettings || {};
            const model = current.model || capability.model;
            const limits = capability.model_options?.find(item => item.value === model)?.capabilities || capability.capabilities || {};
            const maximum = Math.max(1, Number(limits.max_outputs_per_request) || 1);
            const references = availableGenerationReferenceItems(node.id);
            const firstReference = references.find(item => Number.isInteger(Number(item.width)) && Number(item.width) > 0
                && Number.isInteger(Number(item.height)) && Number(item.height) > 0) || null;
            const ratioResolution = window.UltimateCanvasGenerationInteractions.resolveImageRatio(
                current.ratio || 'auto', firstReference, '1:1'
            );
            const resolutionOptions = Array.isArray(limits.size_options) && limits.size_options.length
                ? limits.size_options
                : ['1K', '2K'];
            const requestedResolution = current.resolution || (resolutionOptions.includes(current.size) ? current.size : limits.default_resolution || resolutionOptions[resolutionOptions.length - 1]);
            const customSize = typeof current.size === 'string' && /^\d+x\d+$/.test(current.size) ? current.size : '';
            return {
                model,
                quality: current.quality || limits.default_quality || 'auto',
                qualityOptions: limits.quality_options || [],
                ratio: ratioResolution.resolved,
                requestedRatio: ratioResolution.requested,
                ratioSource: ratioResolution.source,
                resolution: requestedResolution,
                size: customSize || window.UltimateCanvasGenerationInteractions.imageSizeForRatio(ratioResolution.resolved, requestedResolution),
                count: Math.max(1, Math.min(maximum, Number(current.count) || 1)),
                maximumCount: maximum,
                sizeOptions: resolutionOptions
            };
        }
        if (node.type === 'video') {
            const current = node.data?.videoSettings || {};
            if (node.data?.planSource) return { ...current };
            const model = current.model || canvasRuntime.bootstrap?.capabilities?.video?.model;
            const option = canvasRuntime.bootstrap?.capabilities?.video?.model_options?.find(item => item.value === model);
            return {
                ...current,
                model, provider: current.provider || option?.provider || 'seedance', referenceImageLimit: option?.reference_media?.imageLimit || 9,
                ratio: current.ratio || ratioFromContext(),
                duration: Number(current.duration || durationFromContext()),
                resolution: current.resolution || resolutionFromContext(),
                generateAudio: current.generateAudio === true,
                returnLastFrame: current.returnLastFrame === true,
                watermark: current.watermark === true
            };
        }
        return {};
    }

    function generationCapabilitiesForNode(node) {
        const capability = canvasRuntime.bootstrap?.capabilities?.[node.type];
        if (node.type !== 'video') return capability;
        const model = node.data?.videoSettings?.model || capability?.model;
        const option = capability?.model_options?.find(item => item.value === model);
        return { ...capability, interaction: { ...capability?.interaction,
            max_reference_images: option?.reference_media?.imageLimit || 9,
            resolutions: option?.resolutions || capability?.interaction?.resolutions } };
    }

    function videoEstimateSignature(settings) {
        return `${settings.provider || 'seedance'}:${settings.model || ''}:${settings.resolution}:${settings.duration}`;
    }

    function scheduleVideoEstimate(nodeId) {
        const node = engine.nodes.get(nodeId);
        if (!node || node.type !== 'video') return;
        const settings = generationSettingsForNode(node);
        const estimateSignature = videoEstimateSignature(settings);
        const previous = canvasRuntime.videoEstimates.get(nodeId);
        if (previous?.signature === estimateSignature && ['pending', 'success', 'failure'].includes(previous.status)) return;
        if (previous?.timer) window.clearTimeout(previous.timer);
        previous?.controller?.abort();

        const controller = new AbortController();
        const entry = { signature: estimateSignature, status: 'pending', controller, timer: null };
        entry.timer = window.setTimeout(async () => {
            const endpoint = '/api/tasks/estimate';
            const url = new URL(endpoint, window.location.origin);
            url.searchParams.set('resolution', settings.resolution);
            url.searchParams.set('duration', String(settings.duration));
            url.searchParams.set('provider', settings.provider || 'seedance');
            const model = settings.model;
            if (model) url.searchParams.set('model', model);
            try {
                const data = await requestJson(url.toString(), {
                    cache: 'no-store',
                    signal: controller.signal
                });
                if (typeof data?.estimatedCost !== 'number' || !Number.isSafeInteger(data.estimatedCost) || data.estimatedCost < 0) throw new Error('estimate unavailable');
                const current = canvasRuntime.videoEstimates.get(nodeId);
                const currentNode = engine.nodes.get(nodeId);
                if (current?.controller !== controller
                    || current?.signature !== estimateSignature
                    || videoEstimateSignature(generationSettingsForNode(currentNode)) !== estimateSignature) return;
                canvasRuntime.videoEstimates.set(nodeId, {
                    signature: estimateSignature,
                    status: 'success',
                    estimatedCost: Number(data.estimatedCost)
                });
                renderGenerationNodeControls(nodeId);
            } catch (error) {
                if (error?.name === 'AbortError') return;
                const current = canvasRuntime.videoEstimates.get(nodeId);
                if (current?.controller !== controller || current?.signature !== estimateSignature) return;
                canvasRuntime.videoEstimates.set(nodeId, { signature: estimateSignature, status: 'failure' });
                renderGenerationNodeControls(nodeId);
            }
        }, 350);
        canvasRuntime.videoEstimates.set(nodeId, entry);
    }

    function generationReferenceItems(nodeId) {
        const seen = new Set();
        const connected = engine.connections
            .filter(connection => connection.to === nodeId)
            .map((connection, index) => ({ node: engine.nodes.get(connection.from), index }))
            .filter(item => item.node?.type === 'image')
            .map(({ node, index }) => {
                const data = node.data || {};
                const referenceImageId = referenceIdsFromNodeData(data)[0] || '';
                const preview = referenceUrlsFromNodeData(data)[0]
                    || data.previewImage
                    || data.thumbnailUrl
                    || '';
                return {
                    nodeId: node.id,
                    referenceImageId,
                    assetId: data.assetId || null,
                    preview,
                    title: data.title || `参考图 ${index + 1}`,
                    width: data.width || data.assetWidth || null,
                    height: data.height || data.assetHeight || null,
                    available: Boolean(referenceImageId)
                };
            })
            ;
        return [...(engine.nodes.get(nodeId)?.data?.planReferences || []).map(item => ({ ...item,
            preview: item.referenceImageId ? `/api/reference-images/${encodeURIComponent(item.referenceImageId)}/content?variant=thumbnail` : '' })), ...connected].filter(item => {
                const key = item.referenceImageId || `node:${item.nodeId}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
    }

    function generationReferenceImageIds(nodeId) {
        return generationReferenceItems(nodeId)
            .filter(item => item.available)
            .map(item => item.referenceImageId);
    }

    function availableGenerationReferenceItems(nodeId) {
        return generationReferenceItems(nodeId).filter(item => item.available);
    }

    function generationModeState(node, referenceCount = availableGenerationReferenceItems(node.id).length) {
        const capability = window.UltimateCanvasGenerationInteractions.normalizeCapabilities(
            node.type,
            generationCapabilitiesForNode(node)
        );
        const selectedMode = node.data?.mode || node.data?.generationIntent?.mode
            || (node.type === 'video' ? 'text-to-video' : 'text-to-image');
        const options = window.UltimateCanvasGenerationInteractions.modeOptions(node.type, capability, referenceCount);
        return { capability, selectedMode, options, selected: options.find(option => option.id === selectedMode) };
    }

    function referenceSelectionMaximum(node) {
        const state = generationModeState(node);
        return Math.max(0, Math.min(
            Number(state.capability.maxReferenceImages) || 0,
            Number(state.selected?.maximumReferences ?? state.capability.maxReferenceImages) || 0
        ));
    }

    function referenceSelectionItems(nodeId) {
        return generationReferenceItems(nodeId)
            .filter(item => item.available)
            .map(item => ({ nodeId: item.nodeId, referenceImageId: item.referenceImageId }));
    }

    function cancelReferenceImport() {
        if (!pendingReferenceImport) return;
        window.parent.postMessage({ type: 'sd2-canvas-reference-invalidated', requestId: pendingReferenceImport.requestId }, window.location.origin);
        pendingReferenceImport = null;
    }
    function referenceImportSignature(nodeId) {
        const node = engine.nodes.get(nodeId);
        return JSON.stringify([node?.data?.mode || '', node?.data?.canvasStyle || null,
            generationSettingsForNode(node), generationReferenceItems(nodeId).map(item => [item.nodeId, item.referenceImageId])]);
    }
    function referenceImportMatches(requestId) {
        const pending = pendingReferenceImport;
        const current = pending ? currentGenerationContext(pending.nodeId) : null;
        return Boolean(pending && requestId === pending.requestId && canvasRuntime.documentWritable && !canvasRuntime.contextSwitching
            && pending.userId === canvasRuntime.bootstrap?.user?.id
            && pending.captured.documentId === current.documentId
            && window.UltimateCanvasGenerationInteractions.generationContextMatches(pending.captured, current)
            && !hasCurrentGenerationSubmission(pending.nodeId)
            && referenceImportSignature(pending.nodeId) === pending.signature);
    }
    window.UltimateCanvasReferenceContextMatches = referenceImportMatches;
    let pendingMention = null, mentionComposing = false;
    function closeCanvasMention() {
        if (pendingMention) window.parent.postMessage({ type: 'sd2-canvas-mention-invalidated', requestId: pendingMention.requestId }, location.origin);
        pendingMention = null;
    }
    function mentionContextMatches(requestId) {
        const pending = pendingMention;
        return Boolean(pending && pending.requestId === requestId && pending.input.isConnected
            && pending.input.value === pending.prompt && pending.input.selectionStart === pending.cursor
            && pending.input.selectionEnd === pending.cursor && pending.context === uploadContextKey()
            && document.activeElement === pending.input && engine.nodes.get(pending.nodeId) === pending.node
            && referenceImportSignature(pending.nodeId) === pending.signature && graphEditAllowed());
    }
    window.UltimateCanvasMentionContextMatches = mentionContextMatches;
    function requestCanvasMention(input) {
        if (!input?.matches?.('.image-props-textarea,.video-props-textarea') || mentionComposing || window.parent === window) return;
        const nodeId = input.closest('[data-node-id]')?.dataset.nodeId, node = engine.nodes.get(nodeId);
        const prompt = input.value, cursor = input.selectionStart;
        if (!node || cursor !== input.selectionEnd || !graphEditAllowed()) { closeCanvasMention(); return; }
        const before = prompt.slice(0, cursor);
        if (!/@[^\s@]*$/.test(before)) { closeCanvasMention(); return; }
        const items = [...availableGenerationReferenceItems(nodeId)];
        engine.nodes.forEach(item => {
            const id = item.type === 'image' ? referenceIdsFromNodeData(item.data || {})[0] : '';
            if (id && !items.some(reference => reference.referenceImageId === id)) items.push({ referenceImageId: id,
                nodeId: item.id, title: item.data?.title || '画布图片', available: true });
        });
        const bindings = node.data?.promptMentions?.version === 1 ? node.data.promptMentions.items || [] : [];
        const reserved = new Set([...bindings.map(item => item.token), ...(prompt.match(/@图[1-9]\d*/g) || [])]);
        let next = 1;
        const candidates = items.slice(0, 79).map(item => {
            let token = bindings.find(binding => binding.referenceImageId === item.referenceImageId)?.token;
            if (!token) { while (reserved.has(`@图${next}`)) next++; token = `@图${next++}`; reserved.add(token); }
            return { ...item, title: item.title || '参考图片', token };
        });
        const rect = input.getBoundingClientRect(), requestId = crypto.randomUUID();
        pendingMention = { requestId, input, prompt, cursor, nodeId, node, candidates,
            signature: referenceImportSignature(nodeId), context: uploadContextKey() };
        window.parent.postMessage({ type: 'sd2-canvas-mention-request', requestId,
            userId: canvasRuntime.bootstrap?.user?.id, nodeId, documentId: canvasRuntime.documentId,
            projectId: canvasRuntime.selectedProjectId, cardId: canvasRuntime.selectedVideoCardId,
            prompt, cursor, candidates, left: rect.left, top: rect.bottom + 4 }, location.origin);
    }
    document.addEventListener('compositionstart', () => { mentionComposing = true; closeCanvasMention(); });
    document.addEventListener('compositionend', event => { mentionComposing = false; requestCanvasMention(event.target); });
    document.addEventListener('input', event => requestCanvasMention(event.target));
    document.addEventListener('keyup', event => { if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) requestCanvasMention(event.target); });
    document.addEventListener('pointerdown', event => { if (pendingMention && event.target !== pendingMention.input) closeCanvasMention(); });
    document.addEventListener('keydown', event => {
        if (!pendingMention || mentionComposing || event.isComposing || !['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        window.parent.postMessage({ type: 'sd2-canvas-mention-key', requestId: pendingMention.requestId, key: event.key }, location.origin);
    }, true);
    window.addEventListener('message', event => {
        if (event.origin !== location.origin || event.source !== window.parent) return;
        const message = event.data;
        if (message?.type === 'sd2-canvas-mention-cancel' && message.requestId === pendingMention?.requestId) { pendingMention = null; return; }
        if (message?.type === 'sd2-canvas-mention-library' && mentionContextMatches(message.requestId)) {
            const originalMention = pendingMention, nodeId = originalMention.nodeId;
            closeCanvasMention();
            if (openReferenceImport(nodeId)) pendingReferenceImport.mentionInput = originalMention;
            return;
        }
        if (message?.type !== 'sd2-canvas-mention-apply' || !mentionContextMatches(message.requestId)) return;
        const pending = pendingMention;
        const candidate = pending.candidates.find(item => item.referenceImageId === message.referenceImageId && item.token === message.token);
        if (!candidate || typeof message.prompt !== 'string' || !Number.isInteger(message.cursor)) return;
        const start = pending.prompt.lastIndexOf('@', pending.cursor - 1);
        const after = pending.prompt.slice(pending.cursor), insertion = candidate.token + (/^\s/.test(after) ? '' : ' ');
        const expected = pending.prompt.slice(0, start) + insertion + after;
        if (message.prompt !== expected || message.cursor !== start + insertion.length) return;
        const current = generationReferenceImageIds(pending.nodeId);
        if (!current.includes(candidate.referenceImageId) && current.length >= referenceSelectionMaximum(pending.node)) {
            showCanvasNotice('参考区已满，未修改正文，请先移除一张参考图。', 'warn'); return;
        }
        syncNodeDataFromDom(pending.nodeId, pending.node);
        graphCommands.perform('prompt_reference', () => {
            const node = pending.node;
            if (!current.includes(candidate.referenceImageId)) node.data.planReferences = [...(node.data.planReferences || []),
                { ...candidate, nodeId: `mention-reference-${candidate.referenceImageId}`, available: true }];
            const items = node.data.promptMentions?.version === 1 ? [...node.data.promptMentions.items] : [];
            if (!items.some(item => item.token === candidate.token)) items.push({ token: candidate.token, referenceImageId: candidate.referenceImageId });
            node.data.promptMentions = { version: 1, items }; node.data.prompt = message.prompt;
            pending.input.value = message.prompt; renderGenerationNodeControls(node.id);
            scheduleCanvasSave('prompt_reference');
        });
        pending.input.focus(); pending.input.setSelectionRange(message.cursor, message.cursor); pendingMention = null;
    });
    function openReferenceImport(nodeId) {
        const node = engine.nodes.get(nodeId);
        if (!node || !['image', 'video'].includes(node.type) || !canvasRuntime.documentWritable || canvasRuntime.contextSwitching) return false;
        if (window.parent === window) { showCanvasNotice('请从站内画布页面打开参考图选择器。', 'warn'); return false; }
        const capacity = referenceSelectionMaximum(node) - availableGenerationReferenceItems(nodeId).length;
        if (capacity < 1 || hasCurrentGenerationSubmission(nodeId)) { showCanvasNotice('当前参考区已满或生成正在提交，请稍后再添加。', 'warn'); return false; }
        cancelReferenceImport(); closeGenerationPopover();
        const requestId = crypto.randomUUID();
        pendingReferenceImport = { requestId, nodeId, userId: canvasRuntime.bootstrap?.user?.id,
            captured: window.UltimateCanvasGenerationInteractions.captureGenerationContext(currentGenerationContext(nodeId)),
            signature: referenceImportSignature(nodeId), capacity, returnFocus: document.activeElement };
        window.parent.postMessage({ type: 'sd2-canvas-reference-request', requestId, userId: pendingReferenceImport.userId,
            nodeId, documentId: canvasRuntime.documentId || null, projectId: canvasRuntime.selectedProjectId || null,
            cardId: canvasRuntime.selectedVideoCardId || null, capacity,
            currentReferenceImageIds: generationReferenceImageIds(nodeId),
            currentAssetIds: generationReferenceItems(nodeId).flatMap(item => item.assetId ? [item.assetId] : []) }, window.location.origin);
        return true;
    }
    window.addEventListener('message', event => {
        if (event.origin !== window.location.origin || event.source !== window.parent) return;
        const message = event.data;
        if (message?.type === 'sd2-canvas-reference-cancel' && message.requestId === pendingReferenceImport?.requestId) {
            const focus = pendingReferenceImport.returnFocus;
            pendingReferenceImport = null; focus?.focus?.(); return;
        }
        if (message?.type !== 'sd2-canvas-reference-apply') return;
        const pending = pendingReferenceImport;
        const valid = referenceImportMatches(message.requestId) && Array.isArray(message.references)
            && message.references.length > 0 && message.references.length <= pending.capacity
            && message.references.every(item => item && typeof item.referenceImageId === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(item.referenceImageId)
                && (item.assetId === null || typeof item.assetId === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(item.assetId))
                && typeof item.title === 'string' && item.title.length <= 240
                && [item.width, item.height].every(value => value === null || Number.isSafeInteger(value) && value > 0));
        let success = false;
        if (valid) {
            const node = engine.nodes.get(pending.nodeId);
            const current = generationReferenceItems(node.id);
            const seen = new Set(current.map(item => item.referenceImageId));
            const additions = message.references.filter(item => { if (seen.has(item.referenceImageId)) return false; seen.add(item.referenceImageId); return true; });
            if (current.filter(item => item.available).length + additions.length <= referenceSelectionMaximum(node)) {
                // Reuse the existing durable reference-input list. Never write the generated result or processing URL.
                node.data.planReferences = [...(node.data.planReferences || []), ...additions.map(item => ({
                    nodeId: `import-reference-${item.referenceImageId}`, referenceImageId: item.referenceImageId,
                    assetId: item.assetId, title: item.title, width: item.width, height: item.height, available: true,
                    preview: `/api/reference-images/${encodeURIComponent(item.referenceImageId)}/content?variant=thumbnail`
                }))];
                renderGenerationNodeControls(node.id); finishReferenceSelection({ returnToTarget: false });
                canvasRuntime.pendingGenerationReferenceTargetId = null;
                engine._hideAddMenu?.(); engine._hideContextMenu?.(); engine.selectNode(node.id);
                scheduleCanvasSave('generation_reference_import'); success = true;
            }
        }
        window.parent.postMessage({ type: 'sd2-canvas-reference-receipt', requestId: message.requestId, success }, window.location.origin);
        if (success) {
            pendingReferenceImport = null;
            setTimeout(() => {
                pending.returnFocus?.focus?.();
                const mention = pending.mentionInput;
                if (mention && mention.input.isConnected && mention.input.value === mention.prompt
                    && mention.input.selectionStart === mention.cursor && mention.input.selectionEnd === mention.cursor
                    && mention.context === uploadContextKey() && engine.nodes.get(mention.nodeId) === mention.node) requestCanvasMention(mention.input);
            }, 0);
            showCanvasNotice('参考图已添加，尚未开始生成。', 'info');
        }
    });

    function syncReferenceSelection() {
        const state = canvasRuntime.referenceSelection;
        if (!state) return null;
        canvasRuntime.referenceSelection = CanvasReferenceSelection.sync(
            state,
            referenceSelectionItems(state.targetNodeId)
        );
        canvasRuntime.pendingGenerationReferenceTargetId = CanvasReferenceSelection.pendingTargetId(
            canvasRuntime.referenceSelection
        );
        return canvasRuntime.referenceSelection;
    }

    function updateReferenceSelectionMarkers() {
        const state = canvasRuntime.referenceSelection;
        document.querySelectorAll('.canvas-node').forEach(nodeEl => {
            const node = engine.nodes.get(nodeEl.dataset.nodeId);
            const compatible = Boolean(state && node?.type === 'image' && referenceIdsFromNodeData(node.data || {}).length);
            nodeEl.classList.toggle('is-reference-compatible', compatible);
            nodeEl.classList.toggle('is-reference-incompatible', Boolean(state && !compatible));
        });
    }

    function renderReferenceSelectionStatus() {
        document.querySelector('[data-reference-selection-status]')?.remove();
        engine._hideAddMenu?.(); engine._hideContextMenu?.();
        const state = canvasRuntime.referenceSelection;
        if (!state) return;
        const target = engine.nodes.get(state.targetNodeId);
        if (!target) return;
        const count = availableGenerationReferenceItems(target.id).length;
        const status = document.createElement('div');
        status.className = 'canvas-reference-selection-status';
        status.dataset.referenceSelectionStatus = '';
        status.innerHTML = `
            <span>从画布选择参考 <strong>${count}/${state.maximumReferences}</strong></span>
            <button type="button" data-reference-selection-action="library" title="从素材库选择">素材库</button>
            ${state.multiple ? '<button type="button" data-reference-selection-action="return" title="完成多选参考">完成</button>' : '<button type="button" data-reference-selection-action="multiple" title="一次选择多张参考">多选参考</button>'}
            <button type="button" data-reference-selection-action="exit" title="取消选择">取消</button>`;
        document.body.appendChild(status);
    }

    function finishReferenceSelection(options = {}) {
        const state = canvasRuntime.referenceSelection;
        if (!state) return false;
        canvasRuntime.referenceSelection = null;
        if (canvasRuntime.pendingGenerationReferenceTargetId === state.targetNodeId) {
            canvasRuntime.pendingGenerationReferenceTargetId = null;
        }
        document.querySelector('[data-reference-selection-status]')?.remove();
        engine._hideAddMenu?.(); engine._hideContextMenu?.();
        updateReferenceSelectionMarkers();
        if (options.returnToTarget !== false && engine.nodes.has(state.targetNodeId)) {
            engine.selectNode(state.targetNodeId);
        } else if (options.restorePrevious && state.previousSelectedNodeId && engine.nodes.has(state.previousSelectedNodeId)) {
            engine.selectNode(state.previousSelectedNodeId);
        }
        if (options.reason) showCanvasNotice(options.reason, options.tone || 'info');
        return true;
    }

    function startReferenceSelection(targetNodeId, options = {}) {
        const target = engine.nodes.get(targetNodeId);
        if (!target || !['image', 'video'].includes(target.type)) return false;
        finishReferenceSelection({ returnToTarget: false });
        const maximumReferences = referenceSelectionMaximum(target);
        if (availableGenerationReferenceItems(targetNodeId).length >= maximumReferences) {
            showCanvasNotice(`当前模式最多支持 ${maximumReferences} 个参考图`, 'warn');
            return false;
        }
        closeGenerationPopover();
        canvasRuntime.referenceSelection = CanvasReferenceSelection.start({
            targetNodeId,
            previousSelectedNodeId: engine.selectedNodeId,
            maximumReferences,
            multiple: options.multiple === true,
            references: referenceSelectionItems(targetNodeId)
        });
        canvasRuntime.pendingGenerationReferenceTargetId = CanvasReferenceSelection.pendingTargetId(
            canvasRuntime.referenceSelection
        );
        updateReferenceSelectionMarkers();
        renderReferenceSelectionStatus();
        return true;
    }

    function selectCanvasReference(sourceNodeId) {
        const state = canvasRuntime.referenceSelection;
        const source = engine.nodes.get(sourceNodeId);
        const target = state ? engine.nodes.get(state.targetNodeId) : null;
        if (!state || !target || source?.type !== 'image') return false;
        const decision = CanvasReferenceSelection.add(state, {
            nodeId: sourceNodeId,
            referenceImageId: referenceIdsFromNodeData(source.data || {})[0] || ''
        });
        if (!decision.accepted) {
            showCanvasNotice('请选择尚未加入的合法图片参考。', 'warn');
            return false;
        }
        if (!engine.connectNodes(sourceNodeId, target.id)) return false;
        canvasRuntime.referenceSelection = decision.session;
        canvasRuntime.pendingGenerationReferenceTargetId = CanvasReferenceSelection.pendingTargetId(decision.session);
        renderGenerationNodeControls(target.id);
        scheduleCanvasSave('generation_reference_add');
        if (decision.finished) {
            finishReferenceSelection({ reason: state.multiple ? `已达当前模式的 ${state.maximumReferences} 张参考图上限` : '参考图已添加，尚未开始生成。' });
        } else {
            renderReferenceSelectionStatus();
        }
        return true;
    }

    function removeGenerationReference(targetNodeId, sourceNodeId) {
        const node = engine.nodes.get(targetNodeId);
        if (node?.data?.planReferences?.some(item => item.nodeId === sourceNodeId)) {
            node.data.planReferences = node.data.planReferences.filter(item => item.nodeId !== sourceNodeId);
        } else if (!engine.disconnectNodes(sourceNodeId, targetNodeId)) return false;
        syncReferenceSelection();
        renderGenerationNodeControls(targetNodeId);
        renderReferenceSelectionStatus();
        scheduleCanvasSave('generation_reference_remove');
        return true;
    }

    function setSelectOptions(select, values, selectedValue) {
        if (!select) return;
        const uniqueValues = Array.from(new Set((values || []).filter(Boolean)));
        if (selectedValue && !uniqueValues.includes(selectedValue)) uniqueValues.unshift(selectedValue);
        select.replaceChildren(...uniqueValues.map(value => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = value;
            option.selected = value === selectedValue;
            return option;
        }));
    }

    function generationNodeLongEdge(nodeEl) {
        const nodeType = nodeEl?.classList?.contains('node-type-image') ? 'image' : 'video';
        return window.UltimateCanvasGenerationInteractions.generationNodeLongEdge(nodeType, window.innerWidth);
    }

    function applyGenerationNodeDimensions(nodeEl, settings) {
        const node = engine.nodes.get(nodeEl?.dataset?.nodeId);
        const width = Number(node?.data?.width), height = Number(node?.data?.height);
        if (node?.type === 'image' && node.data?.source === 'reference_image' && node.data?.originalUrl
            && Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0) {
            const scale = generationNodeLongEdge(nodeEl) / Math.max(width, height);
            nodeEl.style.setProperty('--generation-node-width', `${width * scale}px`);
            nodeEl.style.setProperty('--generation-node-height', `${height * scale}px`);
            nodeEl.dataset.generationRatio = window.UltimateCanvasGenerationInteractions.ratioFromImageDimensions(width, height) || settings.ratio;
            return { width: width * scale, height: height * scale, ratio: nodeEl.dataset.generationRatio };
        }
        const dimensions = window.UltimateCanvasGenerationInteractions
            .generationNodeDimensions(settings.ratio, generationNodeLongEdge(nodeEl));
        nodeEl.style.setProperty('--generation-node-width', `${dimensions.width}px`);
        nodeEl.style.setProperty('--generation-node-height', `${dimensions.height}px`);
        nodeEl.dataset.generationRatio = dimensions.ratio;
        return dimensions;
    }

    function ensureGenerationPriceStack(nodeEl) {
        const footerRight = nodeEl?.querySelector('.video-footer-right');
        const submit = footerRight?.querySelector('[data-generation-submit]');
        if (!footerRight || !submit) return null;
        let stack = footerRight.querySelector('[data-generation-price-stack]');
        if (!stack) {
            stack = document.createElement('div');
            stack.dataset.generationPriceStack = '';
            stack.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;gap:2px;';
            footerRight.insertBefore(stack, submit);
        }
        if (submit.parentElement !== stack) stack.appendChild(submit);
        return stack;
    }

    function renderGenerationNodeControls(nodeId) {
        planSplit.renderNode(nodeId);
        renderStoryEntry(nodeId);
        renderVideoResultHistory(nodeId);
        const node = engine.nodes.get(nodeId);
        const nodeEl = document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
        if (!node || !nodeEl || !['image', 'video'].includes(node.type)) return;
        const priceStack = ensureGenerationPriceStack(nodeEl);

        const settings = generationSettingsForNode(node);
        applyGenerationNodeDimensions(nodeEl, settings);
        const nodeMode = node.data?.mode || node.data?.generationIntent?.mode
            || (node.type === 'video' ? 'text-to-video' : 'text-to-image');
        const promptInput = promptInputFor(nodeEl, node.type);
        const referenceCount = availableGenerationReferenceItems(nodeId).length;
        const importButton = nodeEl.querySelector('[data-generation-command="import-reference"]');
        if (importButton) importButton.disabled = !canvasRuntime.documentWritable || canvasRuntime.contextSwitching
            || hasCurrentGenerationSubmission(nodeId) || referenceCount >= referenceSelectionMaximum(node);
        const importCount = nodeEl.querySelector('[data-import-reference-count]');
        if (importCount) importCount.textContent = referenceCount ? `已添加 ${referenceCount} 张` : '';
        const modeState = generationModeState(node, referenceCount);
        const mode = modeState.selected;
        const interactionReadiness = node.data?.canvasStyle ? { ready: true } : window.UltimateCanvasGenerationInteractions.generationInteractionReadiness(
            node.type,
            modeState.capability,
            node.data || {},
            referenceCount,
            nodeMode,
            { transientPending: hasCurrentGenerationSubmission(nodeId) }
        );
        if (node.type === 'video' && (node.data?.planSource || node.data?.videoSubmission || node.data?.videoSubmissionLegacy)) {
            const readiness = generationReadiness({ kind: 'video', nodeId, mode: nodeMode,
                prompt: promptInput?.value ?? node.data?.prompt ?? '', settings,
                referenceImageIds: generationReferenceImageIds(nodeId) });
            if (!readiness.ready) Object.assign(interactionReadiness, readiness);
        }
        updateGenerationNodeModelLabel(nodeEl, node);
        const modelTrigger = nodeEl.querySelector('[data-generation-model-trigger]');
        if (modelTrigger) {
            const locked = generationSettingsLockReason(node);
            modelTrigger.setAttribute('aria-disabled', locked ? 'true' : 'false');
            modelTrigger.title = locked || '选择视频模型';
        }
        if (promptInput && !promptInput.value && node.data?.prompt) promptInput.value = node.data.prompt;
        const modeLabel = nodeEl.querySelector('[data-generation-mode-label]');
        if (modeLabel) modeLabel.textContent = mode?.label || nodeMode;
        let supportedQuickChoices = 0;
        nodeEl.querySelectorAll('[data-generation-quick-mode]').forEach(quickMode => {
            const quickModeState = window.UltimateCanvasGenerationInteractions.quickModeActionability(
                modeState.options,
                quickMode.dataset.generationQuickMode,
                referenceCount,
                modeState.capability.enabled
            );
            quickMode.hidden = !quickModeState.visible;
            quickMode.disabled = !quickModeState.enabled;
            if (quickModeState.visible) supportedQuickChoices += 1;
        });
        const quickActions = nodeEl.querySelector('.generation-empty-actions');
        if (quickActions) quickActions.hidden = supportedQuickChoices === 0;
        const submit = nodeEl.querySelector('[data-generation-submit]');
        if (submit && !submit.classList.contains('is-loading')) submit.disabled = !interactionReadiness.ready;
        const existingStatus = nodeEl.querySelector('.node-generation-status');
        if (!interactionReadiness.ready) {
            setNodeGenerationStatus(nodeEl, 'warn', interactionReadiness.message);
            nodeEl.querySelector('.node-generation-status')?.setAttribute('data-interaction-invalid', 'true');
        } else if (existingStatus?.dataset.interactionInvalid === 'true') {
            existingStatus.remove();
        }

        if (node.type === 'image') {
            const spec = nodeEl.querySelector('[data-generation-spec]');
            const cost = nodeEl.querySelector('[data-generation-cost]');
            if (cost) cost.hidden = true;
            const style = node.data?.canvasStyle;
            const styleJob = node.data?.styleJob;
            const modelLine = nodeEl.querySelector('.video-model-info');
            let stylePrice = nodeEl.querySelector('[data-style-price]');
            if (!stylePrice) {
                stylePrice = document.createElement('span');
                stylePrice.className = 'cost-label';
                stylePrice.dataset.stylePrice = '';
                stylePrice.setAttribute('role', 'status');
                stylePrice.setAttribute('aria-live', 'polite');
            }
            if (priceStack && stylePrice.parentElement !== priceStack) priceStack.appendChild(stylePrice);
            stylePrice.hidden = !style;
            if (style) {
                window.UltimateCanvasNodePricing?.refresh(nodeEl, node);
                modelLine?.classList.remove('has-canvas-node-price');
                const select = nodeEl.querySelector('[data-generation-image-model]');
                if (select) select.hidden = false;
                const actualQuoteRequired = window.UltimateCanvasNodePricing?.actualQuoteRequired(node.id);
                const actualQuote = window.UltimateCanvasNodePricing?.actualQuote(node.id);
                const actualTotal = Math.ceil(Number(actualQuote?.estimatedCredits));
                const fixedTotal = style.unitCredits * style.count;
                stylePrice.textContent = actualQuoteRequired === true && actualQuote?.billingMode === 'actual'
                    && Number.isSafeInteger(actualTotal) && actualTotal >= 0
                    ? `合计约 ${actualTotal.toLocaleString('zh-CN')} 点数`
                    : actualQuoteRequired === false && Number.isSafeInteger(style.unitCredits)
                        && style.unitCredits >= 0 && Number.isSafeInteger(style.count) && style.count > 0
                        && Number.isSafeInteger(fixedTotal)
                        ? `合计约 ${fixedTotal.toLocaleString('zh-CN')} 点数` : '费用待估算';
                stylePrice.title = '按应用风格时的报价；价格变化时会停止提交';
                if (submit && !submit.classList.contains('is-loading')) submit.disabled = Boolean(styleJob && styleJob.state !== 'unconfirmed') || style.appliedBy !== canvasRuntime.bootstrap?.user?.id;
            } else window.UltimateCanvasNodePricing?.refresh(nodeEl, node);
            if (spec) spec.textContent = `${style?.aspectRatio === 'auto' ? '跟随参考' : settings.ratio} · ${style?.quality || settings.resolution}${style?.quality ? ` · ${settings.resolution}` : ''} · ${settings.count}张`;
            const styleLabel = nodeEl.querySelector('[data-generation-style-label]');
            if (styleLabel) styleLabel.textContent = style?.name || '风格';
            nodeEl.querySelector('[data-generation-command="style-gallery"]')?.classList.toggle('is-active', Boolean(style));
            const clearStyle = nodeEl.querySelector('[data-generation-command="clear-style"]');
            if (clearStyle) { clearStyle.hidden = !style; clearStyle.disabled = Boolean(styleJob); }
            const refreshStyle = nodeEl.querySelector('[data-generation-command="refresh-style"]');
            if (refreshStyle) refreshStyle.hidden = !styleJob;
            if (promptInput) promptInput.readOnly = Boolean(styleJob);
            nodeEl.querySelectorAll('[data-generation-popover]').forEach(button => {
                button.disabled = Boolean(style || styleJob);
                if (style) button.title = '使用风格模板的生成参数；移除风格后可调整';
                else button.removeAttribute('title');
            });
            if (style && existingStatus?.dataset.interactionInvalid === 'true') existingStatus.remove();
        } else {
            const spec = nodeEl.querySelector('[data-generation-spec]');
            if (spec) {
                spec.textContent = `${settings.ratio || '画幅待选择'} · ${settings.resolution || '分辨率待选择'} · ${settings.duration ? settings.duration + '秒' : '时长待选择'}${settings.generateAudio ? ' · 声音' : ''}`;
            }
            const cost = nodeEl.querySelector('[data-generation-cost]');
            const estimate = canvasRuntime.videoEstimates.get(nodeId);
            const estimateSignature = videoEstimateSignature(settings);
            if (cost) {
                if (priceStack && cost.parentElement !== priceStack) priceStack.appendChild(cost);
                cost.classList.add('canvas-node-credits');
                Object.assign(cost.style, {
                    border: '0', background: 'transparent', color: 'var(--text-tertiary)',
                    padding: '0', minHeight: '0', margin: '0', cursor: 'pointer',
                    font: 'inherit', fontSize: '11px', whiteSpace: 'nowrap',
                });
                cost.textContent = node.data?.frozenCost
                    ? `已冻结 ${node.data.frozenCost}`
                    : estimate?.signature === estimateSignature && estimate.status === 'success'
                        ? `预计 ${estimate.estimatedCost} 点`
                        : estimate?.signature === estimateSignature && estimate.status === 'failure' ? '报价失败 · 点击重查'
                        : estimate?.signature === estimateSignature && estimate.status === 'pending' ? '正在报价' : '报价待确认';
                cost.onclick = () => { canvasRuntime.videoEstimates.delete(nodeId); scheduleVideoEstimate(nodeId); };
                cost.title = '点击重新读取当前模型的价格';
            }
            if (settings.model && settings.duration && settings.resolution) scheduleVideoEstimate(nodeId);
        }

        const references = generationReferenceItems(nodeId);
        const referenceList = nodeEl.querySelector('[data-generation-reference-list]');
        if (referenceList) {
            referenceList.hidden = references.length === 0;
            referenceList.innerHTML = references.length
                ? references.map((item, index) => `
                    <span class="generation-reference-item ${item.available ? '' : 'is-unavailable'}" title="${escapeHtml(item.available ? item.title : `${item.title} 尚未入库`)}">
                        ${item.preview ? `<img src="${escapeHtml(item.preview)}" alt="">` : '<span class="generation-reference-thumb"></span>'}
                        <strong>${escapeHtml(item.title)}</strong>
                        <span>${item.available
                            ? escapeHtml(window.UltimateCanvasGenerationInteractions.referenceRole(nodeMode, index))
                            : '未入库'}</span>
                        <button type="button" class="generation-reference-remove" data-generation-reference-remove="${escapeHtml(item.nodeId)}"
                            title="移除参考图" aria-label="移除参考图">&times;</button>
                    </span>`).join('')
                : '';
        }
        const region = nodeEl.querySelector('[data-generation-result-region]');
        const hasResultMedia = Boolean(node.data?.originalUrl || node.data?.assetId || node.data?.videoPreviewUrl
            || node.data?.resultVideoUrl || node.data?.selectedVideoResult?.playUrl || node.data?.generationResult?.imageUrl
            || node.data?.generationResult?.assets?.length || node.data?.generationStatus === 'succeeded' && node.data?.previewImage);
        if (region && !hasResultMedia) {
            const available = references.filter(item => item.available && item.referenceImageId);
            if (available.length) {
                const index = Math.min(available.length - 1, Number(node._referencePreviewIndex) || 0);
                decorateGeneratedNode(nodeId, '参考预览', '', `/api/reference-images/${encodeURIComponent(available[index].referenceImageId)}/content?variant=thumbnail`);
                const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'reference-preview-open';
                preview.dataset.canvasMediaPreview = ''; preview.dataset.contentKey = `reference_image:${available[index].referenceImageId}`;
                preview.title = '查看参考原图'; preview.setAttribute('aria-label', preview.title); preview.innerHTML = window.UltimateCanvasIcons('Maximize2', 16);
                region.appendChild(preview);
                if (available.length > 1) {
                    const switcher = document.createElement('button'); switcher.type = 'button'; switcher.className = 'reference-preview-switch';
                    switcher.title = '切换参考预览，不改变发送顺序'; switcher.textContent = `${index + 1}/${available.length}`;
                    switcher.addEventListener('click', () => { node._referencePreviewIndex = (index + 1) % available.length; renderGenerationNodeControls(nodeId); });
                    region.appendChild(switcher);
                }
                region.dataset.referencePreview = 'true';
            } else if (region.dataset.referencePreview === 'true') {
                region.replaceChildren(); delete region.dataset.referencePreview;
            }
        }
        refreshOpenGenerationSpecPopover(node);
        syncImageResultActionsTrigger(nodeEl, node);
        syncVideoTaskActionsTrigger(nodeEl, node);
    }

    function renderAllGenerationNodeControls() {
        engine.nodes.forEach(node => renderGenerationNodeControls(node.id));
        updateGraphTools();
    }

    function applyGenerationQuickMode(nodeId, mode) {
        const node = engine.nodes.get(nodeId);
        if (!node || !['image', 'video'].includes(node.type)) return false;
        const referenceCount = availableGenerationReferenceItems(nodeId).length;
        const modeState = generationModeState(node, referenceCount);
        const selectedMode = modeState.options.find(option => option.id === mode);
        const quickModeState = window.UltimateCanvasGenerationInteractions.quickModeActionability(
            modeState.options,
            mode,
            referenceCount,
            modeState.capability.enabled
        );
        if (!quickModeState.visible || !quickModeState.enabled) return false;
        window.UltimateCanvasGenerationInteractions.applyGenerationQuickAction({
            selectNode: id => engine.selectNode(id),
            configureMode: (id, selected) => {
                const target = engine.nodes.get(id);
                if (target) target.data = { ...target.data, mode: selected };
            },
            renderControls: renderGenerationNodeControls,
            startReferenceSelection,
            scheduleSave: scheduleCanvasSave
        }, {
            nodeId,
            nodeType: node.type,
            mode,
            minimumReferences: selectedMode?.minimumReferences || 0,
            referenceCount
        });
        return true;
    }

    function generationChoiceGroup(name, label, values, selected, format = value => String(value)) {
        return `<section class="generation-choice-section" data-generation-choice-section="${escapeHtml(name)}">
            <h3>${escapeHtml(label)}</h3>
            <div class="generation-choice-grid">
                ${values.map(value => {
                    const raw = String(value);
                    const active = raw === String(selected);
                    const ratio = name === 'ratio' && /^\d+:\d+$/.test(raw)
                        ? `<span class="generation-ratio-glyph" style="--generation-choice-ratio:${raw.replace(':', ' / ')}" aria-hidden="true"></span>`
                        : '';
                    return `<button type="button" class="generation-choice-button" data-generation-setting-choice="${escapeHtml(name)}"
                        data-generation-value="${escapeHtml(raw)}" aria-pressed="${active}">${ratio}<span>${escapeHtml(format(value))}</span></button>`;
                }).join('')}
            </div>
        </section>`;
    }

    function generationDurationSlider(values, selected) {
        const durations = values.map(Number).filter(Number.isFinite);
        if (!durations.length) {
            return '<section class="generation-choice-section"><h3>时长</h3><div class="generation-spec-static">不可用</div></section>';
        }
        const selectedIndex = durations.findIndex(value => value === Number(selected));
        const activeIndex = selectedIndex >= 0 ? selectedIndex : 0;
        const activeDuration = durations[activeIndex];
        return `<section class="generation-choice-section generation-duration-section" data-generation-choice-section="duration">
            <div class="generation-duration-heading">
                <h3>时长</h3>
                <output data-generation-duration-output>${escapeHtml(selectedIndex >= 0 ? `${activeDuration}s` : `${selected || '待选择'}秒（需重新选择）`)}</output>
            </div>
            <input type="range" class="generation-duration-slider" min="0" max="${durations.length - 1}" step="1" value="${activeIndex}"
                data-generation-duration-slider data-generation-duration-values="${escapeHtml(durations.join(','))}"
                aria-label="时长" aria-valuetext="${escapeHtml(`${activeDuration}秒`)}">
            <div class="generation-duration-scale" aria-hidden="true"><span>${escapeHtml(`${durations[0]}s`)}</span><span>${escapeHtml(`${durations.at(-1)}s`)}</span></div>
        </section>`;
    }

    function syncGenerationDurationSlider(slider) {
        const durations = String(slider?.dataset?.generationDurationValues || '')
            .split(',')
            .map(Number)
            .filter(Number.isFinite);
        if (!durations.length) return null;
        const index = Math.max(0, Math.min(durations.length - 1, Number(slider.value) || 0));
        const duration = durations[index];
        slider.value = String(index);
        slider.setAttribute('aria-valuetext', `${duration}秒`);
        const output = slider.closest('[data-generation-choice-section="duration"]')
            ?.querySelector('[data-generation-duration-output]');
        if (output) output.textContent = `${duration}s`;
        return duration;
    }

    function renderModePopover(node) {
        const capability = window.UltimateCanvasGenerationInteractions.normalizeCapabilities(
            node.type,
            generationCapabilitiesForNode(node)
        );
        const selected = node.data?.mode || node.data?.generationIntent?.mode
            || (node.type === 'video' ? 'text-to-video' : 'text-to-image');
        return `<div class="generation-popover-list">${window.UltimateCanvasGenerationInteractions
            .modeOptions(node.type, capability, availableGenerationReferenceItems(node.id).length)
            .map(option => `<button type="button" class="generation-popover-option ${option.id === selected ? 'is-active' : ''}"
                data-generation-mode="${escapeHtml(option.id)}" ${option.enabled ? '' : 'disabled aria-disabled="true"'}>
                <span>${escapeHtml(option.label)}</span>${option.reason ? `<small>${escapeHtml(option.reason)}</small>` : ''}
            </button>`).join('')}</div>`;
    }

    function renderSpecPopover(node) {
        const settings = generationSettingsForNode(node);
        const capability = window.UltimateCanvasGenerationInteractions.normalizeCapabilities(
            node.type,
            generationCapabilitiesForNode(node)
        );
        if (node.type === 'image') {
            const sizeControl = settings.sizeOptions.length
                ? generationChoiceGroup('resolution', '分辨率', settings.sizeOptions, settings.resolution || settings.size)
                : capability.fixedSize
                    ? `<section class="generation-choice-section"><h3>尺寸</h3><div class="generation-spec-static">${escapeHtml(capability.fixedSize)}</div></section>`
                    : '<section class="generation-choice-section"><h3>尺寸</h3><div class="generation-spec-static">不可用</div></section>';
            const counts = Array.from({ length: settings.maximumCount }, (_, index) => index + 1);
            return `<div class="generation-popover-spec" data-generation-settings="image">
                ${generationChoiceGroup('ratio', '比例', capability.ratios, settings.requestedRatio || settings.ratio)}
                <p class="generation-spec-hint">当前生效：${escapeHtml(settings.ratio)} · ${escapeHtml(settings.ratioSource === 'reference' ? '首张有效参考图' : '模型默认或手动选择')} · ${escapeHtml(settings.size)}</p>
                ${sizeControl}
                ${settings.qualityOptions?.length ? generationChoiceGroup('quality', '质量', settings.qualityOptions, settings.quality, value => ({ auto: '自动', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' })[value] || value) : ''}
                <p class="generation-spec-hint">背景写入画面描述；当前接口没有独立透明背景参数。</p>
                ${generationChoiceGroup('count', '生成数量', counts, settings.count, value => `${value}张`)}
            </div>`;
        }
        return `<div class="generation-popover-spec" data-generation-settings="video">
            ${generationChoiceGroup('model', '模型', (canvasRuntime.bootstrap?.capabilities?.video?.model_options || []).map(item => item.value), settings.model,
                value => { const option = canvasRuntime.bootstrap?.capabilities?.video?.model_options?.find(item => item.value === value); return (option?.label || value) + (option?.ready === false ? '（未配置）' : ''); })}
            ${generationChoiceGroup('ratio', '比例', capability.ratios, settings.ratio)}
            ${generationDurationSlider(canvasRuntime.bootstrap?.capabilities?.video?.interaction?.duration_by_model?.[settings.model] || [], settings.duration)}
            ${generationChoiceGroup('resolution', '分辨率', canvasRuntime.bootstrap?.capabilities?.video?.model_options?.find(item => item.value === settings.model)?.resolutions || capability.resolutions, settings.resolution)}
            <p class="generation-spec-hint">切换模型保留原参数；不支持的值请重新选择。2.5 首尾帧的实际比例跟随首帧。</p>
            ${capability.supportsAudio ? generationChoiceGroup('generateAudio', '生成声音', [true, false], settings.generateAudio, value => value ? '开启' : '关闭') : ''}
            ${capability.supportsLastFrame ? generationChoiceGroup('returnLastFrame', '返回尾帧', [true, false], settings.returnLastFrame, value => value ? '开启' : '关闭') : ''}
            ${capability.supportsWatermark ? generationChoiceGroup('watermark', '水印', [true, false], settings.watermark, value => value ? '开启' : '关闭') : ''}
        </div>`;
    }

    function generationSettingsLockReason(node) {
        if (!canvasRuntime.documentWritable) return '当前画布只读，无法修改模型和参数';
        if (canvasRuntime.contextSwitching || canvasRuntime.documentRestoring) return '画布正在切换，请稍后再修改';
        if (canvasRuntime.documentOperation || canvasRuntime.failedSaveRequest || canvasRuntime.saveConflict) return '请先处理画布保存状态，再修改模型和参数';
        if (node.data?.videoSubmissionLegacy || node.data?.videoSubmission?.state === 'unconfirmed') return '原请求受理情况未知，请先查询原请求；不会重新发送';
        if (hasCurrentGenerationSubmission(node.id) || ['submitting', 'submitted', 'running', 'queued', 'processing', 'unconfirmed', 'uncertain'].includes(node.data?.generationStatus)) return '原请求正在提交或生成，请等待或查询原任务';
        if (node.type === 'image' && (node.data?.canvasStyle || node.data?.styleJob)) return '使用风格模板的生成参数；移除风格后可调整';
        return '';
    }

    function applyGenerationSettingChoice(node, name, rawValue) {
        const locked = generationSettingsLockReason(node);
        if (locked) { showCanvasNotice(locked, 'warn'); return false; }
        const current = generationSettingsForNode(node);
        if (node.type === 'image') {
            const allowed = new Set(['ratio', 'resolution', 'count', 'quality']);
            if (!allowed.has(name)) return false;
            node.data = {
                ...node.data,
                imageSettings: {
                    model: current.model,
                    quality: name === 'quality' ? rawValue : current.quality,
                    ratio: name === 'ratio' ? rawValue : current.requestedRatio,
                    resolution: name === 'resolution' ? rawValue : current.resolution,
                    size: name === 'ratio' || name === 'resolution' ? '' : current.size,
                    count: name === 'count' ? Number(rawValue) : current.count
                }
            };
        } else if (node.type === 'video') {
            const allowed = new Set(['model', 'ratio', 'duration', 'resolution', 'generateAudio', 'returnLastFrame', 'watermark']);
            if (!allowed.has(name)) return false;
            const modelOption = name === 'model' ? canvasRuntime.bootstrap?.capabilities?.video?.model_options?.find(item => item.value === rawValue) : null;
            if (name === 'model' && (!modelOption?.provider || modelOption.ready === false)) {
                showCanvasNotice(modelOption?.reason || '此模型尚未配置，暂不能选用', 'warn'); return false;
            }
            const booleanValue = rawValue === 'true';
            node.data = {
                ...node.data,
                videoSettings: {
                    ...current,
                    model: name === 'model' ? rawValue : current.model,
                    provider: name === 'model' ? modelOption.provider : current.provider,
                    ratio: name === 'ratio' ? rawValue : current.ratio,
                    duration: name === 'duration' ? Number(rawValue) : current.duration,
                    resolution: name === 'resolution' ? rawValue : current.resolution,
                    generateAudio: name === 'generateAudio' ? booleanValue : current.generateAudio,
                    returnLastFrame: name === 'returnLastFrame' ? booleanValue : current.returnLastFrame,
                    watermark: name === 'watermark' ? booleanValue : current.watermark
                }
            };
            if (node.data.planSource) node.data.planParameterSource = `${node.data.planParameterSource || ''}；${name} 已由此节点手动选择：${rawValue}`;
            const previousEstimate = canvasRuntime.videoEstimates.get(node.id);
            if (previousEstimate?.timer) window.clearTimeout(previousEstimate.timer);
            previousEstimate?.controller?.abort();
            canvasRuntime.videoEstimates.delete(node.id);
        } else return false;
        renderGenerationNodeControls(node.id);
        scheduleCanvasSave(`${node.type}_settings_change`);
        return true;
    }

    function refreshOpenGenerationSpecPopover(node) {
        const state = canvasRuntime.generationPopover;
        if (!state || state.kind !== 'spec' || state.nodeId !== node?.id || !state.element?.isConnected) return false;
        state.element.innerHTML = renderSpecPopover(node);
        positionGenerationPopover(state);
        return true;
    }

    function renderCameraPopover(node) {
        const selectedId = node.data?.cameraPresets?.[0]?.id || '';
        return `<div class="generation-popover-list">${VIDEO_CAMERA_PRESETS.map(preset => `
            <button type="button" class="generation-popover-option ${selectedId === preset.id ? 'is-active' : ''}"
                data-generation-camera-preset="${escapeHtml(preset.id)}"><span>${escapeHtml(preset.label)}</span><small>${escapeHtml(preset.prompt)}</small></button>
        `).join('')}</div>`;
    }

    function videoTaskActionsForNode(node, overrides = {}) {
        const data = node?.data || {};
        const normalized = window.UltimateCanvasGenerationNodes.normalizeVideoStatus(videoTaskForNode(node));
        const cardId = data.videoCardId || canvasRuntime.selectedVideoCardId || '';
        const detail = canvasRuntime.videoCardDetails.get(cardId);
        const cardSummary = canvasRuntime.bootstrap?.context?.video_cards?.find(card => card.id === cardId);
        const previewUrl = normalized.playUrl;
        const downloadUrl = normalized.downloadUrl;
        const actions = window.UltimateCanvasGenerationInteractions.videoTaskActionAvailability({
            taskId: data.taskId,
            status: data.generationStatus,
            previewUrl,
            downloadUrl,
            canRetry: Boolean(detail?.permissions?.can_generate || cardSummary?.can_generate),
            canManage: Boolean(detail?.permissions?.can_manage || cardSummary?.can_manage)
        });
        return actions ? { ...actions, cardId } : null;
    }

    function syncVideoTaskActionsTrigger(nodeEl, node, overrides = {}) {
        const toolbar = nodeEl?.querySelector('.generation-node-toolbar');
        const existing = toolbar?.querySelector('[data-generation-popover="task-actions"]');
        if (existing && canvasRuntime.generationPopover?.anchor === existing) closeGenerationPopover();
        existing?.remove();
        const actions = node?.type === 'video' ? videoTaskActionsForNode(node, overrides) : null;
        if (!toolbar || !actions) return;
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'generation-command generation-task-more';
        trigger.dataset.generationPopover = 'task-actions';
        trigger.setAttribute('aria-expanded', 'false');
        trigger.textContent = '\u66f4\u591a';
        trigger._generationTaskActions = actions;
        toolbar.appendChild(trigger);
    }

    function renderVideoTaskActionsPopover(node, actionModel = null) {
        const actions = actionModel || videoTaskActionsForNode(node);
        if (!actions) return '';
        const attributes = `data-task-id="${escapeHtml(actions.taskId)}" data-node-id="${escapeHtml(node.id)}" data-card-id="${escapeHtml(actions.cardId)}"`;
        return `<div class="generation-popover-list generation-task-action-menu">
            <a href="${escapeHtml(actions.detailUrl)}" target="_blank" rel="noreferrer">\u4efb\u52a1\u8be6\u60c5</a>
            ${actions.previewUrl ? `<button type="button" data-canvas-media-preview data-content-key="${escapeHtml(`video_task:${actions.taskId}`)}">\u9884\u89c8</button><a href="${escapeHtml(actions.previewUrl)}" target="_blank" rel="noreferrer">\u65b0\u6807\u7b7e\u6253\u5f00</a>` : ''}
            ${actions.downloadUrl ? `<a href="${escapeHtml(actions.downloadUrl)}" target="_blank" rel="noreferrer">\u4e0b\u8f7d</a>` : ''}
            ${actions.canRetry ? `<button type="button" data-generated-task-retry="${escapeHtml(actions.taskId)}" data-node-id="${escapeHtml(node.id)}" data-card-id="${escapeHtml(actions.cardId)}">${escapeHtml(videoCardUiText.retryTask)}</button>` : ''}
            ${actions.canMarkVersion ? `
                <button type="button" data-generated-task-version="candidate" ${attributes}>${escapeHtml(videoCardUiText.candidate)}</button>
                <button type="button" data-generated-task-version="best" ${attributes}>${escapeHtml(videoCardUiText.best)}</button>
                <button type="button" data-generated-task-version="final" ${attributes}>${escapeHtml(videoCardUiText.final)}</button>` : ''}
        </div>`;
    }

    function imageResultActionsForNode(node, overrides = {}) {
        if (node?.type !== 'image') return null;
        const data = node.data || {};
        const result = data.generationResult || {};
        const assetId = data.assetId || data.asset_id;
        const referenceImageId = data.referenceImageId || data.reference_image_id;
        const contentKey = assetId ? `asset:${assetId}`
            : referenceImageId ? `reference_image:${referenceImageId}` : '';
        const imageUrl = data.originalUrl || overrides.imageUrl || data.imageUrl || data.previewImage
            || result.original_url || result.originalUrl || result.image_url || result.imageUrl;
        if (!imageUrl) return null;
        return {
            contentKey: /^(asset|reference_image):[a-zA-Z0-9_-]+$/.test(contentKey) ? contentKey : '',
            imageUrl,
            downloadUrl: data.imageDownloadUrl || overrides.downloadUrl || data.originalUrl
                || result.download_url || result.downloadUrl || imageUrl
        };
    }

    function syncImageResultActionsTrigger(nodeEl, node, overrides = {}) {
        const toolbar = nodeEl?.querySelector('.generation-node-toolbar');
        const existing = toolbar?.querySelector('[data-generation-popover="result-actions"]');
        if (existing && canvasRuntime.generationPopover?.anchor === existing) closeGenerationPopover();
        existing?.remove();
        const actions = imageResultActionsForNode(node, overrides);
        if (!toolbar || !actions) return;
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'generation-command generation-task-more generation-icon-command';
        trigger.dataset.generationPopover = 'result-actions';
        trigger.setAttribute('aria-expanded', 'false');
        trigger.setAttribute('aria-label', '更多操作');
        trigger.title = '更多操作';
        trigger.textContent = '更多';
        trigger._generationResultActions = actions;
        toolbar.appendChild(trigger);
    }

    function renderImageResultActionsPopover(node, actionModel = null) {
        const actions = actionModel || imageResultActionsForNode(node);
        if (!actions) return '';
        return `<div class="generation-popover-list generation-task-action-menu">
            ${actions.contentKey ? `<button type="button" data-canvas-media-preview data-content-key="${escapeHtml(actions.contentKey)}">\u9884\u89c8</button>` : ''}
            <a data-generated-image-action="open" href="${escapeHtml(actions.imageUrl)}" target="_blank" rel="noreferrer">打开原图</a>
            <a data-generated-image-action="download" href="${escapeHtml(actions.downloadUrl)}" download>下载</a>
            <button type="button" data-generated-image-action="regenerate" data-node-id="${escapeHtml(node.id)}">再次生成</button>
            <button type="button" data-generated-image-action="create-video" data-node-id="${escapeHtml(node.id)}">生成视频</button>
        </div>`;
    }

    function closeGenerationPopover() {
        const state = canvasRuntime.generationPopover;
        if (!state) return;
        const restoreFocus = state.element?.contains(document.activeElement);
        state.anchor?.setAttribute('aria-expanded', 'false');
        state.element?.remove();
        canvasRuntime.generationPopover = null;
        if (restoreFocus) state.anchor?.focus({ preventScroll: true });
    }

    function positionGenerationPopover(state) {
        if (!state?.anchor?.isConnected || !state.element?.isConnected) return closeGenerationPopover();
        const gap = 6;
        const margin = 12;
        const headerBottom = document.getElementById?.('header-bar')?.getBoundingClientRect().bottom || 0;
        const safeTop = Math.max(margin, Math.ceil(headerBottom) + margin);
        const maxHeight = Math.max(80, Math.min(560, window.innerHeight - safeTop - margin));
        state.element.style.maxHeight = `${maxHeight}px`;
        const anchorRect = state.anchor.getBoundingClientRect();
        const popoverRect = state.element.getBoundingClientRect();
        const left = Math.min(Math.max(margin, anchorRect.left), window.innerWidth - popoverRect.width - margin);
        const below = anchorRect.bottom + gap;
        const top = below + popoverRect.height <= window.innerHeight - margin
            ? below
            : Math.max(safeTop, anchorRect.top - popoverRect.height - gap);
        state.element.style.left = `${left}px`;
        state.element.style.top = `${top}px`;
    }

    function openGenerationPopover(nodeId, kind, anchor) {
        const node = engine.nodes.get(nodeId);
        if (!node || !anchor || !['image', 'video'].includes(node.type)) return;
        if (['spec', 'mode', 'camera'].includes(kind)) {
            const locked = generationSettingsLockReason(node);
            if (locked) { showCanvasNotice(locked, 'warn'); return; }
        }
        if (canvasRuntime.generationPopover?.anchor === anchor && canvasRuntime.generationPopover.kind === kind) {
            closeGenerationPopover();
            return;
        }
        closeGenerationPopover();
        const element = document.createElement('div');
        element.className = 'generation-popover';
        element.setAttribute('role', 'dialog');
        element.setAttribute('aria-label', kind === 'spec' ? '生成模型与参数' : '生成设置');
        element.dataset.generationPopoverKind = kind;
        element.innerHTML = kind === 'mode' ? renderModePopover(node)
            : kind === 'spec' ? renderSpecPopover(node)
                : kind === 'camera' ? renderCameraPopover(node)
                    : kind === 'result-actions' ? renderImageResultActionsPopover(node, anchor._generationResultActions)
                        : kind === 'task-actions' ? renderVideoTaskActionsPopover(node, anchor._generationTaskActions)
                            : '';
        document.body.appendChild(element);
        anchor.setAttribute('aria-expanded', 'true');
        canvasRuntime.generationPopover = { nodeId, kind, anchor, element };
        positionGenerationPopover(canvasRuntime.generationPopover);
        if (anchor.hasAttribute?.('data-generation-model-trigger')) element.querySelector('[data-generation-setting-choice="model"]')?.focus({ preventScroll: true });
    }

    function activeTabText(nodeEl) {
        return nodeEl.querySelector('.video-props-tab.active')?.textContent.trim() || '';
    }

    function textFrom(nodeEl, selector) {
        return nodeEl.querySelector(selector)?.value?.trim() || '';
    }

    function nodeSourcePayloads(nodeId) {
        return engine.connections
            .filter(connection => connection.to === nodeId)
            .map(connection => engine.nodes.get(connection.from))
            .filter(Boolean)
            .map(node => ({
                id: node.id,
                type: node.type,
                data: node.type === 'video' && node.data?.selectedVideoResult ? {
                    ...node.data, taskId: node.data.selectedVideoResult.taskId,
                    libraryItemId: node.data.selectedVideoResult.libraryItemId,
                    assetId: node.data.selectedVideoResult.assetId,
                    source: 'video_task',
                    prompt: node.data.videoHistory?.find(item => item.taskId === node.data.selectedVideoResult.taskId)?.input?.prompt || node.data.prompt,
                    contentKey: node.data.selectedVideoResult.contentKey,
                    videoPreviewUrl: node.data.selectedVideoResult.playUrl,
                    videoDownloadUrl: node.data.selectedVideoResult.downloadUrl,
                    resultVideoUrl: node.data.selectedVideoResult.resultVideoUrl,
                    thumbnailUrl: node.data.selectedVideoResult.thumbnailUrl,
                    generationStatus: 'succeeded'
                } : node.data || {}
            }));
    }

    function collectNodePrompt(nodeEl, type) {
        if (type === 'video') return nodeEl.querySelector('.video-props-textarea')?.value ?? '';
        if (type === 'image') return textFrom(nodeEl, '.image-props-textarea');
        return nodeEl.querySelector('.node-text-content')?.innerText ?? nodeEl.querySelector('.node-text-content')?.textContent
            ?? textFrom(nodeEl, '.node-input-textarea');
    }

    function collectGenerationPayload(nodeEl) {
        const nodeId = nodeEl.dataset.nodeId;
        const node = engine.nodes.get(nodeId);
        if (!node) return null;

        const prompt = collectNodePrompt(nodeEl, node.type);
        const tabText = activeTabText(nodeEl);
        const isVideo = node.type === 'video';
        const isImage = node.type === 'image';
        const kind = node.data?.generationIntent?.kind || (isVideo ? 'video' : isImage ? 'image' : node.type);
        const mode = node.data?.mode || node.data?.generationIntent?.mode || (isVideo
            ? (generationModeMap[tabText] || 'text-to-video')
            : isImage ? 'text-to-image' : 'text');
        const contextRules = node._pendingTextRules ? (node._pendingTextRules.previous.contextRules ?? node._pendingTextRules.previous.context_rules ?? '') : contextRulesForNode(node);

        return {
            nodeId,
            kind,
            mode,
            videoBranchId: node.data?.videoBranchId || canvasRuntime.selectedVideoBranchId,
            modeLabel: tabText || mode,
            prompt: prompt || node.data?.prompt || node.data?.description || '',
            ...(node.data?.promptMentions ? { promptMentions: node.data.promptMentions } : {}),
            contextRules,
            context_rules: contextRules,
            ...(['text', 'script'].includes(kind) ? { textPurpose: (node._pendingTextRules ? node._pendingTextRules.previous.textPurpose : node.data?.textPurpose) || 'text' } : {}),
            model: ['text', 'script'].includes(kind) ? (node.data?.textModel || canvasRuntime.bootstrap?.capabilities?.text?.model || 'gpt-5.5')
                : nodeEl.querySelector('[data-generation-image-model] option:checked')?.textContent.trim() || nodeEl.querySelector('.video-model-info')?.textContent.trim() || '',
            spec: nodeEl.querySelector('[data-generation-spec]')?.textContent.trim() || '',
            sourceNodes: node.data?.planSource ? [] : nodeSourcePayloads(nodeId),
            referenceImageIds: generationReferenceImageIds(nodeId),
            settings: generationSettingsForNode(node),
            cameraPresets: node.data?.cameraPresets || [],
            referenceImage: node.data?.previewImage || node.data?.referenceImage || '',
            source: node.data?.source || '',
            title: node.data?.title || ''
        };
    }

    function promptWithConnectedText(payload) {
        const data = engine.nodes.get(payload.nodeId)?.data;
        if (data?.planSource || data?.storySource) return payload.prompt;
        const context = (payload.sourceNodes || []).filter(source => ['text', 'script'].includes(source.type))
            .map(source => source.data?.authoredText ?? (source.data?.generatedText || source.data?.prompt || source.data?.description || ''))
            .filter(value => typeof value === 'string' && value.trim());
        return [payload.prompt, ...context].filter(Boolean).join('\n\n');
    }

    function setSubmitLoading(button, loading) {
        button.disabled = loading;
        button.classList.toggle('is-loading', loading);
        button.classList.add('sd2-loading-surface');
        button.dataset.busy = String(loading);
        button.dataset.originalTitle ||= button.title || '';
        button.title = loading ? '接口调用中' : button.dataset.originalTitle;
    }

    function setNodeGenerationStatus(nodeEl, state, message) {
        if (!nodeEl) return;
        const card = nodeEl.querySelector('.node-card');
        if (!card) return;
        let status = card.querySelector(':scope > .node-generation-status');
        const placeholder = card.querySelector('.generated-result-placeholder');
        if (placeholder) {
            placeholder.classList.add('sd2-loading-surface');
            placeholder.dataset.busy = String(Boolean(message) && state === 'loading');
        }
        if (!message) {
            status?.remove();
            return;
        }
        if (!status) {
            status = document.createElement('div');
            card.append(status);
        }
        status.className = `node-generation-status sd2-loading-surface ${state || 'info'}`;
        status.dataset.busy = String(state === 'loading');
        status.textContent = message;
        status.title = message;
    }

    function generatedTextFromResult(result) {
        return (result?.text || result?.content || result?.message || '').trim();
    }

    function renderTextNodeBody(nodeEl, node) {
        const value = node.data?.authoredText ?? node.data?.generatedText ?? node.data?.prompt ?? '';
        const body = nodeEl.querySelector('.node-body');
        if (body) body.innerHTML = `<div class="node-text-content${typeof node.data?.authoredText !== 'string' && node.data?.generatedText ? ' generated-text-content' : ''}" contenteditable="true" style="white-space:pre-wrap"
            data-placeholder="在这里输入你的故事...">${escapeHtml(value)}</div>`;
    }

    function applyTextGenerationResult(nodeEl, payload, result) {
        const node = engine.nodes.get(payload.nodeId);
        const generatedText = generatedTextFromResult(result);
        if (!generatedText) {
            showCanvasNotice('LLM 已返回，但没有可展示的文本。', 'warn');
            return;
        }

        const title = result?.title || (payload.kind === 'script' ? '脚本草稿' : '文本草稿');
        const summary = result?.summary || generatedText.slice(0, 140);
        const body = nodeEl.querySelector('.node-body');
        if (body) {
            body.innerHTML = `<div class="node-text-content generated-text-content" contenteditable="true"
                data-placeholder="LLM 生成内容">${escapeHtml(generatedText)}</div>`;
        }

        if (node) {
            delete node.data.authoredText;
            node.data = {
                ...node.data,
                title,
                prompt: payload.prompt,
                description: generatedText,
                generatedText,
                generationSummary: summary,
                generationPayload: payload,
                generationResult: result,
                textRuleHistory: [...(node.data?.textRuleHistory || []), { requestId: result.id,
                    recordedAt: new Date().toISOString(), trace: result.rules_trace || null }].slice(-10),
                generationStatus: result?.status || 'succeeded'
            };
        }

        setNodeGenerationStatus(nodeEl, 'success', result?.message || '文本生成完成');
        renderStoryEntry(payload.nodeId);
        showCanvasNotice(result?.message || 'LLM 生成完成', 'info');
        scheduleCanvasSave('text_generation');
    }

    function videoPreviewForTask(task) {
        return window.UltimateCanvasGenerationNodes.normalizeVideoStatus(task).thumbnailUrl;
    }

    function videoTaskForNode(node) {
        const data = node?.data || {};
        const taskId = data.taskId || '';
        const result = data.generationResult || {};
        const resultId = result.task_id || result.id;
        const history = (data.videoHistory || []).find(item => item.taskId === taskId) || {};
        const snapshot = resultId === taskId ? result : {};
        return {
            ...history, ...snapshot, task_id: taskId,
            provider_task_id: data.providerTaskId || snapshot.provider_task_id || null,
            local_status: data.generationStatus || snapshot.local_status || history.status,
            play_url: snapshot.play_url ?? data.videoPreviewUrl ?? history.playUrl,
            download_url: snapshot.download_url ?? data.videoDownloadUrl ?? history.downloadUrl,
            thumbnail_url: snapshot.thumbnail_url || data.thumbnailUrl || history.thumbnailUrl || '',
            result_video_url: snapshot.result_video_url || data.resultVideoUrl || '',
            result_last_frame_url: snapshot.result_last_frame_url || data.resultLastFrameUrl || '',
            stable_download_ready: snapshot.stable_download_ready ?? data.stableDownloadReady ?? history.stableDownloadReady,
            preview_available: snapshot.preview_available ?? data.previewAvailable ?? history.previewAvailable,
            playable_available: snapshot.playable_available ?? data.playableAvailable ?? history.playableAvailable
        };
    }

    function prepareVideoSubmissionView(node) {
        const data = node.data;
        if (data.taskId) {
            const history = data.videoHistory ||= [];
            if (!history.some(item => item.taskId === data.taskId)) history.push({
                ...window.UltimateCanvasGenerationNodes.normalizeVideoStatus(videoTaskForNode(node)),
                contentKey: `video_task:${data.taskId}`,
                input: data.videoSubmission?.input || (data.generationPayload?.settings?.provider
                    ? { source_metadata: { provider: data.generationPayload.settings.provider } } : undefined),
                requestId: data.videoSubmission?.requestId
            });
        }
        releaseInlineVideos(node.id);
        Object.assign(data, { taskId: '', providerTaskId: null, generationResult: null,
            videoPreviewUrl: '', videoDownloadUrl: '', thumbnailUrl: '', resultVideoUrl: '', resultLastFrameUrl: '',
            stableDownloadReady: false, previewAvailable: false, playableAvailable: false, videoPlaybackPosition: null });
    }

    function taskDescription(task) {
        const status = task?.local_status || task?.status || 'submitted';
        if (status === 'succeeded') {
            const capability = window.UltimateCanvasGenerationNodes.normalizeVideoStatus(task);
            if (capability.stableDownloadReady) {
                return '视频已生成，稳定下载已就绪，可预览、下载并在任务记录中追溯。';
            }
            if (capability.playableAvailable) {
                return '视频已生成，可先预览，系统正在准备稳定下载。';
            }
            return '视频已生成，系统正在同步预览和下载资源。';
        }
        if (status === 'failed') return task?.error_message || '视频生成失败，冻结点数会按后端规则释放。';
        if (status === 'cancelled') return '视频任务已取消。';
        return videoStageLabel(status);
    }

    function videoStageLabel(status) {
        return ({ draft: '视频设置已保留，尚未生成', queued: '视频正在排队', submitted: '任务已提交，正在核对生成状态',
            running: '视频正在生成', processing: '视频正在生成', pending: '任务等待处理',
            unconfirmed: '提交结果待确认，请查询原请求；不会重复生成', uncertain: '提交结果待确认，请查询原请求；不会重复生成'
        })[status] || '任务状态尚未确认，请读取任务状态';
    }

    function applyImageGenerationResult(nodeEl, payload, result) {
        const node = engine.nodes.get(payload.nodeId);
        const normalized = window.UltimateCanvasGenerationNodes.normalizeImageResult(result);
        const imageUrl = normalized.imageUrl;
        const title = normalized.fileName || '图片生成结果';
        const desc = result?.message || `${payload.modeLabel || payload.mode} 已完成并写入资产库`;
        if (node) {
            node.data = {
                ...node.data,
                title,
                prompt: payload.prompt,
                previewImage: imageUrl,
                referenceImage: imageUrl,
                imageUrl,
                thumbnailUrl: normalized.thumbnailUrl || imageUrl,
                originalUrl: normalized.originalUrl || imageUrl,
                assetId: normalized.assetId,
                referenceImageId: normalized.referenceImageId,
                workspaceAssetId: normalized.workspaceAssetId,
                imageSettings: {
                    ...(node.data?.imageSettings || {}),
                    ratio: payload.settings?.requestedRatio || payload.settings?.ratio || node.data?.imageSettings?.ratio || 'auto',
                    resolution: payload.settings?.resolution || node.data?.imageSettings?.resolution || '1K',
                    size: result?.size || payload.settings?.size || node.data?.imageSettings?.size || '1024x1024',
                    resolvedRatio: result?.resolved_ratio || payload.settings?.ratio || null,
                },
                generationPayload: payload,
                generationResult: result,
                generationStatus: 'succeeded'
            };
        }
        decorateGeneratedNode(payload.nodeId, title, desc, imageUrl, {
            imageUrl: normalized.originalUrl || imageUrl,
            downloadUrl: normalized.originalUrl || imageUrl
        });
        renderGenerationNodeControls(payload.nodeId);
        if (node) {
            const sourceElement = document.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`);
            const stepX = Math.max(400, sourceElement?.offsetWidth || 0) + 40;
            const stepY = Math.max(400, sourceElement?.offsetHeight || 0) + 40;
            normalized.assets.slice(1).forEach((asset, index) => {
                const outputId = `image-result-${asset.assetId}`;
                if (engine.nodes.has(outputId)) return;
                let x = node.x + stepX * (1 + index % 2);
                let y = node.y + stepY * Math.floor(index / 2);
                while (Array.from(engine.nodes.values()).some(other => Math.abs(other.x - x) < stepX && Math.abs(other.y - y) < stepY)) y += stepY;
                const preview = asset.thumbnailUrl || asset.originalUrl || '';
                const id = engine.addNode('image', x, y, {
                    id: outputId, title: asset.fileName || `生成图片 ${index + 2}`,
                    prompt: payload.prompt, previewImage: preview, imageUrl: preview,
                    thumbnailUrl: preview, originalUrl: asset.originalUrl,
                    assetId: asset.assetId, referenceImageId: asset.referenceImageId,
                    workspaceAssetId: asset.workspaceAssetId, width: asset.width, height: asset.height,
                    imageSettings: { ...node.data.imageSettings, count: 1 },
                    generationStatus: 'succeeded', source: 'generation',
                });
                decorateGeneratedNode(id, asset.fileName || `生成图片 ${index + 2}`, desc, preview, {
                    imageUrl: asset.originalUrl || preview, downloadUrl: asset.originalUrl || preview
                });
                renderGenerationNodeControls(id);
            });
        }
        const message = result?.message || `已生成 ${normalized.assets.length || 1} 张图片，并保存到资产库。`;
        setNodeGenerationStatus(nodeEl, 'success', message);
        showCanvasNotice(message, result?.partial ? 'warn' : 'info');
        scheduleCanvasSave('image_generation');
        loadLibraryPanels(true);
    }

    function videoStatusUrl(taskId, nodeId) {
        const node = engine.nodes.get(nodeId);
        const input = node?.data?.videoHistory?.find(item => item.taskId === taskId)?.input
            || (node?.data?.taskId === taskId ? node.data.videoSubmission?.input : null);
        if (input?.source_metadata?.provider === 'volcengine_ip') return `/api/ip/video/status/${encodeURIComponent(taskId)}?refresh=true`;
        return window.UltimateCanvasBackendContract.resolveTaskStatusEndpoint(
            canvasRuntime.bootstrap?.capabilities?.video?.status_endpoint_template,
            taskId,
            window.location.origin
        );
    }

    function stopVideoPolling(taskId, nodeId) {
        canvasRuntime.pollingCoordinator.unregister(taskId, nodeId);
    }

    function stopAllVideoPolling() {
        canvasRuntime.pollingCoordinator.clear();
    }

    function beginVideoRead(nodeId, taskId) {
        const order = ++videoReadSequence;
        videoReadOrders.set(`${nodeId}:${taskId}`, order);
        return order;
    }

    async function recheckBoundVideoNodes() {
        if (!canvasRuntime.documentLoaded || canvasRuntime.documentRestoring) return;
        const epoch = canvasRuntime.contextEpoch;
        if (videoRecheck?.epoch === epoch) return videoRecheck.promise;
        lastVideoRecheck = Date.now();
        const nodes = Array.from(engine.nodes.values()).filter(node => node.type === 'video'
            && (node.data?.taskId || node.data?.videoHistory?.some(item => item.taskId)));
        const orders = new Map();
        nodes.forEach(node => [node.data.taskId, ...(node.data.videoHistory || []).slice(-20).map(item => item.taskId)]
            .filter(Boolean).forEach(id => orders.set(`${node.id}:${id}`, beginVideoRead(node.id, id))));
        const reads = new Map();
        const read = (taskId, nodeId) => {
            if (reads.size >= 64 && !reads.has(taskId)) throw Error('本轮查询数量已达上限，可稍后继续核对');
            if (!reads.has(taskId)) reads.set(taskId, requestJson(videoStatusUrl(taskId, nodeId), { cache: 'no-store', policy: 'video-status' }));
            return reads.get(taskId);
        };
        const promise = (async () => {
            // One read per existing card, then one status read only for bindings absent from that list.
            const cards = new Map();
            for (const node of nodes) {
                const cardId = node.data.videoCardId;
                if (cardId && cards.size < 32 && !cards.has(cardId)) cards.set(cardId, requestJson(`/api/video-cards/${encodeURIComponent(cardId)}/tasks`, { cache: 'no-store' })
                    .then(data => data.tasks || []).catch(() => []));
            }
            for (const node of nodes) {
                if (epoch !== canvasRuntime.contextEpoch) break;
                const taskId = node.data.taskId;
                const tasks = await (cards.get(node.data.videoCardId) || Promise.resolve([]));
                const bindings = [...new Set([taskId, ...(node.data.videoHistory || []).slice(-20).map(item => item.taskId)])].filter(Boolean);
                for (const id of bindings) {
                    if (epoch !== canvasRuntime.contextEpoch || engine.nodes.get(node.id) !== node || node.data.taskId !== taskId) break;
                    try {
                        const cached = tasks.find(task => (task.id || task.task_id) === id);
                        const response = cached || await read(id, node.id);
                        if (epoch !== canvasRuntime.contextEpoch || engine.nodes.get(node.id) !== node || node.data.taskId !== taskId) break;
                        const task = response.task || response;
                        if ((task.id || task.task_id) !== id) continue;
                        if (applyVideoTaskStatus(node.id, task, orders.get(`${node.id}:${id}`)) === false) continue;
                        const status = window.UltimateCanvasGenerationNodes.normalizeVideoStatus(task);
                        const delivery = task.delivery_stage?.key || task.delivery_stage;
                        const terminal = ['failed', 'cancelled'].includes(status.status)
                            || (status.status === 'succeeded' && (status.stableDownloadReady || ['ready', 'failed'].includes(delivery)));
                        if (terminal) stopVideoPolling(id, node.id);
                        else if (canvasRuntime.documentWritable) {
                            pollVideoTask(id, node.id);
                        }
                    } catch (error) {
                        if (epoch !== canvasRuntime.contextEpoch || engine.nodes.get(node.id) !== node) break;
                        if (videoReadOrders.get(`${node.id}:${id}`) !== orders.get(`${node.id}:${id}`)) continue;
                        if ([401, 403].includes(error?.status)) {
                            stopVideoPolling(id, node.id);
                            if (id === taskId) {
                                releaseInlineVideos(node.id);
                                applyVideoTaskStatus(node.id, { id, local_status: node.data.generationStatus,
                                    provider_task_id: node.data.providerTaskId, playable_available: false,
                                    stable_download_ready: false, preview_available: false });
                                setNodeGenerationStatus(document.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`), 'warn', '无权读取此视频，请确认登录和访问权限');
                            }
                        }
                        const item = node.data.videoHistory?.find(entry => entry.taskId === id);
                        if (item) item.lookupError = true;
                        renderVideoResultHistory(node.id);
                    }
                }
            }
        })();
        videoRecheck = { epoch, promise };
        try { await promise; } finally { if (videoRecheck?.promise === promise) videoRecheck = null; }
    }

    function pauseInlineVideos(except = null) {
        inlineVideoPlayers.forEach(({ video }) => { if (video !== except) video.pause(); });
    }

    function releaseInlineVideos(nodeId = '') {
        inlineVideoPlayers.forEach((state, id) => {
            if (nodeId && id !== nodeId) return;
            state.controller?.abort();
            window.clearTimeout(state.retryTimer);
            state.retryResolve?.();
            state.listeners?.abort();
            inlineVideoPlayers.delete(id);
            state.video.pause();
            state.video.removeAttribute('src');
            state.video.load();
        });
    }

    function bindInlineVideo(nodeId, taskId, playUrl) {
        const nodeEl = document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
        const video = nodeEl?.querySelector('[data-canvas-inline-video]');
        const node = engine.nodes.get(nodeId);
        if (!video || !node) return;
        if (inlineVideoPlayers.get(nodeId)?.video === video) {
            const label = nodeEl.querySelector('[data-video-read-state]');
            if (label) label.textContent = video.dataset.readState || '';
            return;
        }
        const state = { video, node, taskId, playUrl, epoch: canvasRuntime.contextEpoch, controller: null, listeners: new AbortController(), blocked: false };
        inlineVideoPlayers.set(nodeId, state);
        const current = () => inlineVideoPlayers.get(nodeId) === state && engine.nodes.get(nodeId) === node
            && state.epoch === canvasRuntime.contextEpoch && node.data.taskId === taskId && video.isConnected;
        const label = message => {
            if (!current()) return;
            const target = nodeEl.querySelector('[data-video-read-state]');
            if (target) target.textContent = message;
            video.dataset.readState = message;
        };
        const savePosition = () => {
            if (!current() || state.blocked || !canvasRuntime.documentWritable || canvasRuntime.documentRestoring
                || !Number.isFinite(video.currentTime) || video.currentTime < 0 || video.currentTime > 86400) return;
            if (node.data.videoPlaybackPosition?.taskId === taskId && node.data.videoPlaybackPosition.seconds === video.currentTime) return;
            node.data.videoPlaybackPosition = { taskId, seconds: video.currentTime };
            scheduleCanvasSave('video_view_position');
        };
        const started = () => {
            if (!current() || state.blocked) return;
            video.dataset.started = '1';
            nodeEl.querySelector('[data-video-play]')?.remove();
            label('');
        };
        const play = async () => {
            if (!current() || state.blocked) return;
            if (canvasRuntime.referenceSelection) { engine.onReferenceNodePick(nodeId); return; }
            pauseInlineVideos(video);
            label('正在读取视频');
            if (!video.getAttribute('src')) video.setAttribute('src', playUrl);
            try { await video.play(); if (current() && !video.paused) started(); }
            catch (error) { if (current() && !state.blocked) label(error?.name === 'NotAllowedError' ? '请点击播放按钮开始播放' : '视频读取失败，请重试'); }
        };
        video.addEventListener('play', () => { if (current()) pauseInlineVideos(video); });
        video.addEventListener('playing', started);
        video.addEventListener('pause', savePosition);
        video.addEventListener('seeked', savePosition);
        video.addEventListener('loadedmetadata', () => {
            const position = node.data.videoPlaybackPosition;
            if (!current() || position?.taskId !== taskId || typeof position.seconds !== 'number'
                || !Number.isFinite(position.seconds) || position.seconds < 0 || position.seconds > 86400) return;
            if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = Math.min(position.seconds, Math.max(0, video.duration - .1));
        });
        video.addEventListener('waiting', () => { if (!state.blocked) label('正在读取视频'); });
        video.addEventListener('canplay', () => { if (!state.blocked) label(''); });
        video.addEventListener('error', async () => {
            if (!current() || !video.getAttribute('src')) return;
            label('视频暂不可读，请重试');
            state.controller?.abort();
            window.clearTimeout(state.retryTimer); state.retryResolve?.();
            const run = state.probeRun = (state.probeRun || 0) + 1;
            for (let attempt = 0; attempt < 3 && current() && state.probeRun === run; attempt++) {
                const controller = new AbortController(); state.controller = controller;
                const timeout = window.setTimeout(() => controller.abort(), 10000);
                let retry = false;
                try {
                    const response = await fetch(playUrl, { method: 'HEAD', redirect: 'manual', credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
                    if (!current() || state.probeRun !== run) return;
                    if ([401, 403].includes(response.status)) {
                        stopVideoPolling(taskId, nodeId); beginVideoRead(nodeId, taskId);
                        state.blocked = true; video.pause(); video.removeAttribute('src'); video.load();
                        nodeEl.querySelector('[data-video-play]')?.remove();
                        const retryButton = nodeEl.querySelector('[data-video-read-retry]');
                        if (retryButton) retryButton.disabled = true;
                        label('无权读取此视频，请确认登录和访问权限');
                    } else if (response.status === 404) label('视频已不可用');
                    else if (response.status === 425) { label('视频文件尚未准备好，请稍后重试'); retry = true; }
                    else if (response.ok) label([3, 4].includes(video.error?.code) ? '浏览器无法播放此视频，可到任务详情查看' : '请点击重试重新读取视频');
                    else { label('视频读取失败，请重试或到任务详情查看'); retry = response.status >= 500; }
                } catch { if (current() && state.probeRun === run) { label('网络读取失败，请稍后重试'); retry = true; } }
                finally { window.clearTimeout(timeout); }
                if (!retry || attempt === 2 || !current() || state.probeRun !== run) break;
                await new Promise(resolve => { state.retryResolve = resolve; state.retryTimer = window.setTimeout(resolve, 2000 * 2 ** attempt); });
            }
        });
        nodeEl.addEventListener('click', event => {
            if (!event.target.closest('[data-video-play], [data-video-read-retry]')) return;
            event.stopPropagation();
            if (state.suppressNextClick) { state.suppressNextClick = false; event.preventDefault(); return; }
            if (!current() || state.blocked) return;
            if (event.target.closest('[data-video-read-retry]')) video.load();
            void play();
        }, { signal: state.listeners.signal });
        nodeEl.addEventListener('pointerdown', event => {
            if (!canvasRuntime.referenceSelection || !event.target.closest('[data-canvas-inline-video], [data-video-play]')) return;
            state.suppressNextClick = true;
            event.preventDefault(); event.stopPropagation(); engine.onReferenceNodePick(nodeId);
        }, { capture: true, signal: state.listeners.signal });
        nodeEl.addEventListener('keydown', event => {
            if (!event.target.closest('[data-canvas-inline-video], [data-video-play], [data-video-read-retry]')) return;
            if ([' ', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) event.stopPropagation();
            if (canvasRuntime.referenceSelection && [' ', 'Enter'].includes(event.key)) {
                event.preventDefault(); engine.onReferenceNodePick(nodeId);
            }
        }, { capture: true, signal: state.listeners.signal });
    }

    window.addEventListener('focus', () => { if (Date.now() - lastVideoRecheck > 60000) void recheckBoundVideoNodes(); });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) pauseInlineVideos();
        else if (Date.now() - lastVideoRecheck > 60000) void recheckBoundVideoNodes();
    });

    function clearAllVideoEstimates() {
        window.UltimateCanvasGenerationInteractions.clearVideoEstimateEntries(
            canvasRuntime.videoEstimates,
            timer => window.clearTimeout(timer)
        );
    }

    window.addEventListener('pagehide', () => {
        pauseInlineVideos();
        if (canvasRuntime.documentWritable && canvasRuntime.documentDirty) cacheCanvasDraft(canvasSaveSnapshot('video_view_exit'));
        releaseInlineVideos(); stopAllVideoPolling(); clearAllVideoEstimates();
    });

    function pollVideoTask(taskId, nodeId) {
        if (!taskId || !nodeId) return;
        canvasRuntime.pollingCoordinator.register(taskId, nodeId);
        void canvasRuntime.pollingCoordinator.runNow();
    }

    canvasRuntime.pollingCoordinator = window.UltimateCanvasGenerationTaskCoordinator.createGenerationTaskCoordinator({
        allowTaskHistory: true,
        fetchStatus: async (taskId, entry) => {
            entry.statusReadOrder = beginVideoRead(entry.nodeId, taskId);
            const nodeEl = document.querySelector(`[data-node-id="${CSS.escape(entry.nodeId)}"]`);
            const node = engine.nodes.get(entry.nodeId);
            if (node?.data.taskId === taskId && node.data.videoSubmission?.state !== 'unconfirmed') setNodeGenerationStatus(nodeEl, 'loading', '正在读取视频状态');
            const data = await requestJson(videoStatusUrl(taskId, entry.nodeId), {
                cache: 'no-store',
                policy: 'video-status'
            });
            const task = data?.task || data;
            return { ...task, local_status: window.UltimateCanvasGenerationNodes.videoReceptionStatus(task) };
        },
        onStatus: (nodeId, task, entry) => {
            if (applyVideoTaskStatus(nodeId, task, entry.statusReadOrder) === false) return;
            const status = task.local_status || task.status;
            if (['succeeded', 'failed', 'cancelled'].includes(status)) {
                loadLibraryPanels(true);
            }
            if (entry.attempt >= 120) {
                stopVideoPolling(entry.taskId, nodeId);
                const nodeEl = document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
                if (engine.nodes.get(nodeId)?.data.taskId === entry.taskId) setNodeGenerationStatus(nodeEl, 'warn', '轮询已暂停，可刷新页面继续查询任务状态');
            }
        },
        onError: (taskId, nodeId, errorCount, error, entry) => {
            const node = engine.nodes.get(nodeId);
            if (videoReadOrders.get(`${nodeId}:${taskId}`) !== entry.statusReadOrder) return;
            if ([401, 403].includes(error?.status)) {
                stopVideoPolling(taskId, nodeId);
                if (node?.data.taskId === taskId) {
                    releaseInlineVideos(nodeId);
                    applyVideoTaskStatus(nodeId, { id: taskId, local_status: node.data.generationStatus,
                        provider_task_id: node.data.providerTaskId, playable_available: false,
                        stable_download_ready: false, preview_available: false });
                    setNodeGenerationStatus(document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`), 'warn', '无权读取此视频，请重新登录或确认访问权限');
                }
                return;
            }
            if (node?.data.taskId !== taskId || node.data.videoSubmission?.state === 'unconfirmed') {
                const item = node?.data.videoHistory?.find(result => result.taskId === taskId);
                if (item) { item.lookupError = true; renderVideoResultHistory(nodeId); scheduleCanvasSave('video_history_query_error'); }
                if (entry.attempt >= 120) stopVideoPolling(taskId, nodeId);
                return;
            }
            const nodeEl = document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
            setNodeGenerationStatus(nodeEl, 'warn', `状态读取失败，正在自动重试（${errorCount}）`);
            if (errorCount === 3) {
                showCanvasNotice(error?.message || '视频状态轮询暂时失败，正在自动重试。', 'warn');
            }
            if (entry.attempt >= 120) {
                stopVideoPolling(taskId, nodeId);
                setNodeGenerationStatus(nodeEl, 'warn', '轮询已暂停，可刷新页面继续查询任务状态');
            }
        },
        isNodeAlive: nodeId => engine.nodes.has(nodeId),
        isHidden: () => document.hidden,
        setTimer: (poll, delay) => window.setTimeout(poll, delay),
        clearTimer: timer => window.clearTimeout(timer),
        delayFor: (entry, hidden) => {
            if (hidden) return 15000;
            if (entry.errorCount) return Math.min(20000, 5000 * entry.errorCount);
            if (entry.serverDelayMs) return Math.min(30000, Math.max(1000, entry.serverDelayMs));
            if (entry.attempt < 4) return 3000;
            if (entry.attempt < 20) return 5000;
            return 8000;
        }
    });

    function applyVideoTaskStatus(nodeId, task, readOrder = 0) {
        const node = engine.nodes.get(nodeId);
        const normalized = window.UltimateCanvasGenerationNodes.normalizeVideoStatus(task);
        if (!node || !normalized.taskId) return false;
        if (readOrder && videoReadOrders.get(`${nodeId}:${normalized.taskId}`) !== readOrder) return false;
        if (!readOrder) beginVideoRead(nodeId, normalized.taskId);
        const history = node.data.videoHistory || [];
        const previousResult = history.find(item => item.taskId === normalized.taskId);
        if (previousResult) {
            const before = JSON.stringify(previousResult);
            Object.assign(previousResult, normalized, { contentKey: `video_task:${normalized.taskId}`, lookupError: false });
            if (JSON.stringify(previousResult) !== before) scheduleCanvasSave('video_history_status');
            renderVideoResultHistory(nodeId);
        }
        if (node.data.taskId !== normalized.taskId) return true;
        if (node.data.videoSubmission?.taskId === normalized.taskId) node.data.videoSubmission.state = normalized.submissionUnconfirmed ? 'unconfirmed' : 'accepted';
        const previousStatus = node.data?.generationStatus;
        const nextStatus = normalized.status || previousStatus;
        const preview = normalized.previewAvailable ? normalized.thumbnailUrl || videoPreviewForTask(task) : '';
        node.data = {
            ...node.data,
            taskId: normalized.taskId,
            providerTaskId: task.provider_task_id || node.data.providerTaskId || null,
            generationStatus: nextStatus,
            videoPreviewUrl: normalized.playUrl,
            videoDownloadUrl: normalized.downloadUrl,
            stableDownloadReady: normalized.stableDownloadReady,
            previewAvailable: normalized.previewAvailable,
            playableAvailable: normalized.playableAvailable,
            retryAfterMs: normalized.retryAfterMs,
            resultVideoUrl: normalized.resultVideoUrl,
            resultLastFrameUrl: normalized.resultLastFrameUrl,
            thumbnailUrl: preview,
            generationResult: window.UltimateCanvasGenerationNodes.videoTaskSnapshot(task)
        };
        decorateGeneratedNode(
            nodeId,
            nextStatus === 'succeeded' ? '视频生成完成' : '视频生成任务',
            taskDescription(task),
            preview,
            {
                taskId: normalized.taskId,
                videoUrl: normalized.playUrl,
                downloadUrl: normalized.downloadUrl
            }
        );
        renderGenerationNodeControls(nodeId);
        const nodeEl = document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
        if (nextStatus === 'succeeded') {
            const deliveryFailed = (task?.delivery_stage?.key || task?.delivery_stage) === 'failed';
            setNodeGenerationStatus(
                nodeEl,
                deliveryFailed ? 'warn' : normalized.stableDownloadReady ? 'success' : 'loading',
                deliveryFailed ? '视频已生成，文件准备停止；请到任务详情重试准备文件' : normalized.stableDownloadReady ? '视频生成完成，稳定下载已就绪' : '视频生成完成，正在准备稳定下载'
            );
        }
        else if (nextStatus === 'failed') setNodeGenerationStatus(nodeEl, 'error', normalized.errorMessage || '视频生成失败');
        else if (nextStatus === 'cancelled') setNodeGenerationStatus(nodeEl, 'warn', '视频任务已取消');
        else setNodeGenerationStatus(nodeEl, ['queued', 'submitted', 'running', 'processing', 'pending'].includes(nextStatus) ? 'loading' : 'warn', videoStageLabel(nextStatus));
        if (nextStatus !== previousStatus || ['succeeded', 'failed', 'cancelled'].includes(nextStatus)) {
            scheduleCanvasSave('video_status');
        }
        return true;
    }

    function applyVideoGenerationResult(nodeEl, payload, result) {
        const node = engine.nodes.get(payload.nodeId);
        const normalized = window.UltimateCanvasGenerationNodes.normalizeVideoCreate(result);
        if (!node || !normalized.taskId) throw new Error('视频任务创建响应缺少任务 ID。');
        if (node.data.videoSubmission?.requestId !== payload.requestId) return;
        syncNodeDataFromDom(node.id, node);
        node.data.videoSubmission.state = normalized.submissionUnconfirmed ? 'unconfirmed' : 'accepted';
        node.data.videoSubmission.taskId = normalized.taskId;
        const history = node.data.videoHistory ||= [];
        if (!history.some(item => item.taskId === normalized.taskId)) history.push({ taskId: normalized.taskId,
            requestId: payload.requestId, input: node.data.videoSubmission.input, status: normalized.status,
            contentKey: `video_task:${normalized.taskId}` });
        node.data = {
            ...node.data,
            videoCardId: canvasRuntime.selectedVideoCardId,
            videoBranchId: payload.videoBranchId || canvasRuntime.selectedVideoBranchId,
            taskId: normalized.taskId,
            providerTaskId: normalized.providerTaskId || null,
            videoPreviewUrl: '', videoDownloadUrl: '', thumbnailUrl: '', resultVideoUrl: '', resultLastFrameUrl: '',
            stableDownloadReady: false, previewAvailable: false, playableAvailable: false, videoPlaybackPosition: null, previewVideoTaskId: null,
            frozenCost: normalized.frozenCost || null,
            generationPayload: payload,
            generationResult: result,
            generationStatus: normalized.status || 'submitted'
        };
        decorateGeneratedNode(
            payload.nodeId,
            '视频生成任务',
            result?.message || `任务已提交：${normalized.taskId || '等待返回任务 ID'}`,
            '',
            {
                taskId: normalized.taskId
            }
        );
        renderGenerationNodeControls(payload.nodeId);
        if (normalized.submissionUnconfirmed) {
            setNodeGenerationStatus(nodeEl, 'warn', '上游受理尚未确认，请查询原任务；不会重新生成');
            pollVideoTask(normalized.taskId, payload.nodeId);
            scheduleCanvasSave('video_submission_unconfirmed');
            return;
        }
        if (normalized.status === 'failed') {
            applyVideoTaskStatus(payload.nodeId, result);
            showCanvasNotice('原请求已确认：视频生成失败，输入已保留，不会重复生成。', 'error');
        } else {
            setNodeGenerationStatus(nodeEl, 'loading', '视频任务已提交，正在查询状态');
            showCanvasNotice(result?.message || '视频任务已提交。', 'info');
        }
        pollVideoTask(normalized.taskId, payload.nodeId);
        scheduleCanvasSave('video_generation');
    }

    async function recoverVideoSubmission(nodeId, expectedTaskId = '') {
        const node = engine.nodes.get(nodeId), submission = node?.data?.videoSubmission;
        if (!submission || submission.state !== 'unconfirmed') return;
        if (node._submissionQueryBusy) return;
        node._submissionQueryBusy = true;
        const captured = currentGenerationContext(nodeId);
        const el = document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
        setNodeGenerationStatus(el, 'loading', '正在查询原请求的受理结果');
        try {
            if (submission.userId !== canvasRuntime.bootstrap?.user?.id || submission.documentId !== canvasRuntime.documentId) throw Error('请在原账号、原画布中查询此请求。');
            // This GET checks the persisted binding itself. Saving first wrongly blocks
            // restore inside a document operation, and is unnecessary even during a CAS conflict.
            const query = new URLSearchParams({ document_id: submission.documentId, node_id: nodeId, request_id: submission.requestId });
            const result = await requestJson(`/api/tools/ultimate-canvas/video-submission?${query}`, { cache: 'no-store' });
            if (!window.UltimateCanvasGenerationInteractions.generationContextMatches(captured, currentGenerationContext(nodeId))
                || node.data.videoSubmission !== submission) return;
            if (!['accepted', 'unconfirmed'].includes(result.state) || !/^[a-zA-Z0-9_-]{1,160}$/.test(result.task?.id || '')
                || (expectedTaskId && result.task.id !== expectedTaskId)) {
                setNodeGenerationStatus(el, 'warn', '提交结果待确认：暂未找到任务，不代表未受理。可稍后再次查询，不会重复生成。');
                return;
            }
            applyVideoGenerationResult(el, submission.generationPayload, { ...result.task, submission_unconfirmed: result.state === 'unconfirmed' });
            if (!canvasRuntime.documentOperation) await flushCanvasSave('video_lookup_accepted').catch(() => {
                if (engine.nodes.get(nodeId) === node && node.data.videoSubmission === submission) {
                    showCanvasNotice('原请求结果已确认，但画布保存未确认；输入和任务编号已保留，请检查保存状态。', 'warn');
                }
            });
            return true;
        } catch (error) {
            if (engine.nodes.get(nodeId) === node) setNodeGenerationStatus(el, 'warn', error.message || '查询失败，请保留原请求后重试。');
        } finally {
            node._submissionQueryBusy = false;
            if (engine.nodes.get(nodeId) === node && node.data.videoSubmission === submission && submission.state === 'unconfirmed'
                && el?.querySelector('.node-generation-status')?.dataset.busy === 'true') {
                setNodeGenerationStatus(el, 'warn', '提交结果待确认，请稍后查询原请求；不会重复生成');
            }
        }
    }

    function renderVideoResultHistory(nodeId) {
        const node = engine.nodes.get(nodeId);
        const el = document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
        if (node?.type !== 'video' || !el) return;
        const history = node.data.videoHistory || [];
        const limit = node.data.videoHistoryVisible || 20;
        const visible = history.slice(-limit).map(item => ({ ...item,
            ...window.UltimateCanvasGenerationNodes.normalizeVideoStatus({ ...item, task_id: item.taskId }) }));
        const resultLabel = taskId => { const index = history.findIndex(item => item.taskId === taskId); return index < 0 ? '未选择' : '结果 ' + (index + 1); };
        const pending = node.data.videoSubmission?.state === 'unconfirmed' || node.data.videoSubmissionLegacy;
        let panel = el.querySelector('[data-video-result-history]');
        if (!pending && !history.length) { panel?.remove(); return; }
        if (!panel) { panel = document.createElement('section'); panel.dataset.videoResultHistory = ''; panel.className = 'canvas-video-history'; el.querySelector('[data-generation-editor]')?.append(panel); }
        panel.innerHTML = (pending ? node.data.videoSubmissionLegacy
            ? '<p>历史提交结果待确认，但旧记录缺少稳定请求编号。请先由管理员核对原任务；不会自动重发。</p>'
            : '<p>提交结果待确认。原请求保留，不会自动重新发送。</p><button type="button" data-video-request-lookup>查询原请求</button>'
                + (canvasRuntime.unsentVideoRequests.get(nodeId) === node.data.videoSubmission ? '<button type="button" data-video-request-send>保存并发送原请求</button>' : '')
                + '<details><summary>原请求输入</summary><p>' + escapeHtml([node.data.videoSubmission.input.model, node.data.videoSubmission.input.ratio, node.data.videoSubmission.input.duration + '秒'].join(' · ')) + '</p><pre>' + escapeHtml(node.data.videoSubmission.input.prompt) + '</pre></details>' : '')
            + (history.length ? '<details data-video-history-expanded ' + (node.data.videoHistoryOpen ? 'open' : '') + '><summary>生成记录 ' + history.length + ' · 预览：' + resultLabel(node.data.previewVideoTaskId || node.data.taskId) + ' · 选用：' + resultLabel(node.data.selectedVideoResult?.taskId) + '</summary>'
                + visible.map((item, index) => '<div class="canvas-video-history-row"><img alt="' + (item.thumbnailUrl ? '视频截图' : '暂无截图') + '" ' + (item.thumbnailUrl ? 'src="' + escapeHtml(item.thumbnailUrl) + '"' : '') + '><span>结果 ' + (history.length - visible.length + index + 1) + ' · ' + escapeHtml(item.status === 'succeeded' ? item.stableDownloadReady ? '文件就绪' : '文件准备中' : item.status || '查询中') + (item.lookupError ? ' · 查询暂时失败，刷新可继续' : '') + '</span><button type="button" data-video-history-preview="' + escapeHtml(item.taskId) + '" ' + (!item.playableAvailable ? 'disabled' : '') + '>预览</button>'
                    + (item.downloadUrl ? '<a download href="' + escapeHtml(item.downloadUrl) + '">下载</a>' : '')
                    + '<button type="button" data-video-history-select="' + escapeHtml(item.taskId) + '" ' + (!canvasRuntime.documentWritable || item.status !== 'succeeded' || !item.stableDownloadReady ? 'disabled' : '') + '>' + (node.data.selectedVideoResult?.taskId === item.taskId ? '已选用' : '选用此结果') + '</button></div>').join('')
                + (history.length > limit ? '<button type="button" data-video-history-more>更多记录</button>' : '') + '</details>' : '');
        const expanded = panel.querySelector('[data-video-history-expanded]');
        if (expanded) expanded.ontoggle = () => {
            if (expanded.isConnected && node.data.videoHistoryOpen !== expanded.open) {
                node.data.videoHistoryOpen = expanded.open;
                if (canvasRuntime.documentWritable) scheduleCanvasSave('video_history_view');
            }
        };
    }
    document.addEventListener('click', async event => {
        const target = event.target.closest('[data-video-request-lookup], [data-video-request-send], [data-video-history-preview], [data-video-history-select], [data-video-history-more]');
        const nodeId = target?.closest('.canvas-node')?.dataset.nodeId;
        if (!target || !nodeId) return;
        event.preventDefault();
        if (target.hasAttribute('data-video-request-lookup')) { void recoverVideoSubmission(nodeId); return; }
        const node = engine.nodes.get(nodeId);
        if (target.hasAttribute('data-video-history-more')) {
            node.data.videoHistoryVisible = (node.data.videoHistoryVisible || 20) + 20;
            if (canvasRuntime.documentWritable) scheduleCanvasSave('video_history_expand');
            renderVideoResultHistory(nodeId); return;
        }
        if (target.hasAttribute('data-video-request-send')) {
            if (canvasRuntime.unsentVideoRequests.get(nodeId) === node?.data?.videoSubmission) {
                await submitNodeGeneration(target.closest('.canvas-node'), target, structuredClone(node.data.videoSubmission.generationPayload));
            }
            return;
        }
        const taskId = target.dataset.videoHistoryPreview || target.dataset.videoHistorySelect;
        const result = node?.data?.videoHistory?.find(item => item.taskId === taskId);
        if (!result) return;
        const capability = window.UltimateCanvasGenerationNodes.normalizeVideoStatus({ ...result, task_id: taskId });
        if (target.dataset.videoHistoryPreview && capability.playableAvailable) {
            pauseInlineVideos();
            node.data.previewVideoTaskId = taskId;
            window.parent.postMessage({ type: 'sd2-canvas-preview-request', contentKey: `video_task:${taskId}` }, window.location.origin);
            scheduleCanvasSave('video_history_preview');
        } else if (target.dataset.videoHistorySelect && canvasRuntime.documentWritable && result.status === 'succeeded' && result.stableDownloadReady) {
            const captured = currentGenerationContext(nodeId);
            target.disabled = true;
            try {
                const key = `video_task:${taskId}`;
                const data = await requestJson(`/api/content-reactions/content?key=${encodeURIComponent(key)}`, { cache: 'no-store' });
                const content = data.content;
                if (content?.key !== key || content.category !== 'video'
                    || content.previewUrl !== `/api/video/play/${taskId}` || content.downloadUrl !== `/api/video/download/${taskId}`) throw Error('产出已不可用或无权选用。');
                if (!window.UltimateCanvasGenerationInteractions.generationContextMatches(captured, currentGenerationContext(nodeId))) return;
                node.data.selectedVideoResult = { taskId, libraryItemId: key, contentKey: key, assetId: null,
                    requestId: result.requestId, playUrl: content.previewUrl, downloadUrl: content.downloadUrl,
                    thumbnailUrl: content.thumbnailUrl || '', resultVideoUrl: result.resultVideoUrl || '' };
                scheduleCanvasSave('video_result_select');
                cacheCanvasDraft(canvasSaveSnapshot('video_result_select'));
                if (!await flushCanvasSave('video_result_select')) throw Error('选用已保存在本地，但服务器尚未同步，请重试保存。');
                showCanvasNotice('已选用此结果供现有下游输入使用；没有重新生成。');
            } catch (error) { showCanvasNotice(error.message || '选用失败，原结果保留。', 'warn'); }
            finally { if (engine.nodes.get(nodeId) === node) renderGenerationNodeControls(nodeId); }
        }
    });

    function applyGenerationResult(nodeEl, payload, result) {
        const node = engine.nodes.get(payload.nodeId);
        if (node && payload.kind !== 'video') {
            node.data = {
                ...node.data,
                generationPayload: payload,
                generationResult: result,
                generationStatus: result?.status || 'submitted'
            };
        }

        if (payload.kind === 'text' || payload.kind === 'script') {
            applyTextGenerationResult(nodeEl, payload, result);
            return;
        }

        if (payload.kind === 'image') {
            applyImageGenerationResult(nodeEl, payload, result);
            return;
        }

        if (payload.kind === 'video') {
            applyVideoGenerationResult(nodeEl, payload, result);
        }
    }

    function generationReadiness(payload) {
        if (!canvasRuntime.bootstrapLoaded) {
            const message = canvasRuntime.bootstrapError?.message
                || '正在读取后台能力状态，请稍后再试。';
            return { ready: false, message };
        }

        const capabilities = canvasRuntime.bootstrap?.capabilities || {};
        const generationNode = payload.nodeId ? engine.nodes.get(payload.nodeId) : null;
        if (payload.kind === 'video' && (generationNode?.data?.videoSubmissionLegacy || (generationNode?.data?.videoSubmission?.state === 'unconfirmed'
            && !(payload.requestId === generationNode.data.videoSubmission.requestId && canvasRuntime.unsentVideoRequests.get(payload.nodeId) === generationNode.data.videoSubmission)))) {
            return { ready: false, message: '提交结果待确认，请查询已有请求；不会重复生成。' };
        }
        if (payload.kind === 'video' && generationNode?.data?.planSource) {
            const meta = generationNode.data.planSource;
            const report = window.UltimateCanvasPlanSplit.inspect(payload.prompt, payload.settings, {
                boundary: meta.boundaryConfirmed, timeline: meta.timelineConfirmed });
            if (!meta.boundaryConfirmed) return { ready: false, message: '请先确认此方案的边界。' };
            if (report.errors.length) return { ready: false, message: report.errors[0] };
        }
        const selectedStyle = generationNode?.data?.canvasStyle;
        if (generationNode && !selectedStyle && ['image', 'video'].includes(generationNode.type)) {
            const capability = window.UltimateCanvasGenerationInteractions.normalizeCapabilities(
                generationNode.type,
                generationCapabilitiesForNode(generationNode)
            );
            const interactionReadiness = window.UltimateCanvasGenerationInteractions.generationInteractionReadiness(
                generationNode.type,
                capability,
                generationNode.data || {},
                (payload.referenceImageIds || []).length,
                payload.mode,
                { transientPending: hasCurrentGenerationSubmission(payload.nodeId) }
            );
            if (!interactionReadiness.ready) return interactionReadiness;
        }
        const project = selectedProject();
        const card = selectedVideoCard();
        if (!canvasRuntime.documentWritable || !canvasRuntime.documentId) {
            return { ready: false, message: '请先打开一张可编辑画布。' };
        }
        if (canvasRuntime.contextSwitching) {
            return { ready: false, message: '项目或视频卡正在切换，请稍后再生成。' };
        }
        const promptOptional = payload.kind === 'image' && payload.mode === 'upscale-image';
        if (!promptOptional && !payload.prompt?.trim()) {
            return { ready: false, message: '请先填写提示词，再提交生成。' };
        }
        if (!project?.id || !project.can_generate) {
            return { ready: false, message: '请先选择一个你有生成权限的项目。' };
        }
        if (!card?.id) {
            return { ready: false, message: '请先选择或新建视频卡，生成结果才能正确归档。' };
        }
        if (!card.can_generate) {
            return { ready: false, message: canvasRuntime.bootstrap?.context?.generation_blocked_reason || '当前视频卡不能继续生成，请切换或新建视频卡。' };
        }
        if (generationNode?.data?.planSource && generationNode.data.videoCardId && generationNode.data.videoCardId !== card.id) {
            return { ready: false, message: '此方案保留原视频卡归属，请切换到该视频卡后生成，不会自动改归属。' };
        }
        if (payload.kind === 'text' || payload.kind === 'script') {
            if (!capabilities.text?.enabled) {
                return {
                    ready: false,
                    message: capabilities.text?.message || '文本生成能力当前不可用。'
                };
            }
            return { ready: true };
        }

        if (payload.kind === 'image') {
            if (selectedStyle) {
                if (selectedStyle.appliedBy !== canvasRuntime.bootstrap?.user?.id) return { ready: false, message: '请为当前账号重新应用风格。' };
                if (hasCurrentGenerationSubmission(payload.nodeId)) return { ready: false, message: '当前风格任务正在处理中。' };
                if (generationNode.data.styleJob && generationNode.data.styleJob.state !== 'unconfirmed') return { ready: false, message: '请等待当前任务完成，或点击查看生成状态。' };
                return { ready: true };
            }
            if (!capabilities.image?.enabled) {
                return {
                    ready: false,
                    message: capabilities.image?.message
                        || window.UltimateCanvasBackendContract.SAFE_UNAVAILABLE_MESSAGE
                };
            }
            const validation = window.UltimateCanvasGenerationNodes.validateImage({
                mode: payload.mode,
                prompt: payload.prompt,
                projectId: project.id,
                cardId: card.id,
                referenceImageIds: payload.referenceImageIds || []
            });
            if (!validation.valid) return { ready: false, message: validation.message };
            return { ready: true };
        }

        if (payload.kind === 'video') {
            if (!capabilities.video?.enabled) {
                return {
                    ready: false,
                    message: capabilities.video?.message
                        || window.UltimateCanvasBackendContract.SAFE_UNAVAILABLE_MESSAGE
                };
            }
            const validation = window.UltimateCanvasGenerationNodes.validateVideo({
                mode: payload.mode,
                prompt: payload.prompt,
                projectId: project.id,
                cardId: card.id,
                referenceImageIds: payload.referenceImageIds || [],
                capabilities: capabilities.video,
                settings: payload.settings || {}
            });
            if (!validation.valid) return { ready: false, message: validation.message };
            return { ready: true };
        }

        return {
            ready: false,
            message: '当前节点类型还没有正式生成接口。'
        };
    }

    function currentGenerationContext(nodeId) {
        return {
            epoch: canvasRuntime.contextEpoch,
            projectId: canvasRuntime.selectedProjectId,
            videoCardId: canvasRuntime.selectedVideoCardId,
            documentId: canvasRuntime.documentId,
            nodeId,
            node: engine.nodes.get(nodeId)
        };
    }

    function hasCurrentGenerationSubmission(nodeId) {
        const entry = canvasRuntime.pendingGenerationSubmissions.get(nodeId);
        return Boolean(entry && window.UltimateCanvasGenerationInteractions.generationContextMatches(
            entry.captured,
            currentGenerationContext(nodeId)
        ));
    }

    async function submitNodeGeneration(nodeEl, button, savedPayload) {
        const api = window.CanvasGenerationAPI;
        const payload = savedPayload || collectGenerationPayload(nodeEl);
        if (!api || !payload) return;

        const readiness = generationReadiness(payload);
        if (!readiness.ready) {
            showCanvasNotice(readiness.message, 'warn');
            return;
        }

        const submittingNode = engine.nodes.get(payload.nodeId);
        if (hasCurrentGenerationSubmission(payload.nodeId)) return;
        const quotedContext = JSON.stringify(currentGenerationContext(payload.nodeId));
        if (payload.kind === 'video') {
            const settings = payload.settings || {};
            const quote = await requestJson(`/api/tasks/estimate?${new URLSearchParams({ provider: settings.provider || 'seedance', model: settings.model, resolution: settings.resolution, duration: String(settings.duration) })}`, { cache: 'no-store' }).catch(error => { showCanvasNotice(error.message || '报价失败，请重试；未提交。', 'warn'); return null; });
            if (!quote || typeof quote.estimatedCost !== 'number' || !Number.isFinite(quote.estimatedCost)) return;
            if (!await requestCanvasConfirmation({ title: '生成视频', message: `本次 1 个视频，预计 ${quote.estimatedCost} 点。`, detail: '失败或受理未知时先查询原任务，不会自动重新生成。', confirmLabel: `确认 ${quote.estimatedCost} 点` })) return;
            if (JSON.stringify(currentGenerationContext(payload.nodeId)) !== quotedContext || engine.nodes.get(payload.nodeId) !== submittingNode || videoEstimateSignature(generationSettingsForNode(submittingNode)) !== videoEstimateSignature(settings)) { showCanvasNotice('画布或参数已变化，请重新确认价格。', 'warn'); return; }
            payload.settings.maxEstimatedCost = quote.estimatedCost;
        }
        if (payload.kind === 'video') payload.requestId ||= crypto.randomUUID();
        const capturedContext = window.UltimateCanvasGenerationInteractions.captureGenerationContext(
            currentGenerationContext(payload.nodeId)
        );
        const transientEntry = ['image', 'video'].includes(payload.kind) ? {
            captured: capturedContext,
            release: (stale = true) => window.UltimateCanvasGenerationInteractions.cleanupGenerationSubmission({
                stale,
                preserveDurable: true,
                node: submittingNode,
                nodeElement: nodeEl,
                clearLoading: () => setSubmitLoading(button, false)
            })
        } : null;
        if (transientEntry && !canvasRuntime.pendingGenerationSubmissions.start(payload.nodeId, transientEntry)) {
            showCanvasNotice('当前视频请求正在提交，请等待返回后再试。', 'warn');
            return;
        }

        setSubmitLoading(button, true);
        setNodeGenerationStatus(nodeEl, 'loading', '正在提交生成请求');
        await window.UltimateCanvasGenerationInteractions.runGuardedGenerationResponse({
            response: Promise.resolve().then(() => api.generate(payload)),
            captured: capturedContext,
            current: () => currentGenerationContext(payload.nodeId),
            onSuccess: result => applyGenerationResult(nodeEl, result?.canvasStylePayload || payload, result),
            onError: async error => {
                const node = engine.nodes.get(payload.nodeId);
                if (payload.kind === 'video' && node?.data?.videoSubmission?.requestId === payload.requestId) {
                    const localTaskId = error?.response?.task_id;
                    if (typeof localTaskId === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(localTaskId)) {
                        const confirmed = await recoverVideoSubmission(payload.nodeId, localTaskId);
                        if (confirmed || engine.nodes.get(payload.nodeId) !== node
                            || node.data.videoSubmission?.requestId !== payload.requestId
                            || !window.UltimateCanvasGenerationInteractions.generationContextMatches(capturedContext, currentGenerationContext(payload.nodeId))) return;
                    }
                    setNodeGenerationStatus(nodeEl, 'warn', '提交结果待确认。请查询原请求；不会自动重复生成。');
                    scheduleCanvasSave('video_submission_unknown');
                    showCanvasNotice(error?.message || '提交结果待确认，请查询原请求。', 'warn');
                    return;
                }
                if (node?.data?.styleJob) {
                    setNodeGenerationStatus(nodeEl, 'warn', error?.message || '任务状态未确认，请查看生成状态；不会重新生成。');
                    scheduleCanvasSave('style_generation_status_unknown');
                    showCanvasNotice(error?.message || '任务状态未确认，请查看生成状态。', 'warn');
                    return;
                }
                if (node) {
                    node.data = {
                        ...node.data,
                        prompt: payload.prompt,
                        generationPayload: payload,
                        generationStatus: 'failed',
                        generationError: error?.message || '生成请求失败'
                    };
                }
                setNodeGenerationStatus(nodeEl, 'error', error?.message || '生成请求失败，输入和素材已保留');
                scheduleCanvasSave('generation_error');
                showCanvasNotice(error?.message || '生成请求失败，输入和已选素材已保留，可稍后重试。', 'error');
            },
            onFinally: ({ stale }) => {
                let ownsTransientEntry = !transientEntry;
                if (transientEntry) {
                    ownsTransientEntry = canvasRuntime.pendingGenerationSubmissions
                        .finish(payload.nodeId, transientEntry);
                    if (ownsTransientEntry) transientEntry.release(stale);
                }
                if (!transientEntry) {
                    window.UltimateCanvasGenerationInteractions.cleanupGenerationSubmission({
                        stale,
                        node: submittingNode,
                        nodeElement: nodeEl,
                        clearLoading: () => setSubmitLoading(button, false)
                    });
                }
                if (ownsTransientEntry && (!stale || engine.nodes.get(payload.nodeId) === submittingNode)) {
                    renderGenerationNodeControls(payload.nodeId);
                }
            }
        });
    }

    document.addEventListener('click', (e) => {
        const button = e.target.closest('.submit-btn');
        const nodeEl = button?.closest('.canvas-node');
        if (!button || !nodeEl) return;
        e.preventDefault();
        e.stopPropagation();
        submitNodeGeneration(nodeEl, button);
    });

    const imageModeMap = {
        '文生图': 'text-to-image',
        '图生图': 'image-to-image',
        '高清修复': 'upscale-image',
        '首帧草图': 'first-frame-draft',
        '尾帧草图': 'last-frame-draft'
    };

    function syncImageModeButtons(nodeEl, mode = 'text-to-image') {
        if (!nodeEl) return;
        nodeEl.querySelectorAll('.image-mode-btn').forEach(button => {
            button.classList.toggle('active', button.dataset.imageMode === mode);
        });
    }

    document.addEventListener('click', (event) => {
        const button = event.target.closest('.image-mode-btn');
        const nodeEl = button?.closest('.canvas-node');
        if (!button || !nodeEl) return;
        const node = engine.nodes.get(nodeEl.dataset.nodeId);
        if (!node) return;
        event.preventDefault();
        event.stopPropagation();
        node.data = {
            ...node.data,
            mode: button.dataset.imageMode || 'text-to-image'
        };
        syncImageModeButtons(nodeEl, node.data.mode);
        renderGenerationNodeControls(node.id);
        scheduleCanvasSave('image_mode_change');
    });

    const VIDEO_CAMERA_PRESETS = [
        { id: 'push-in', label: '推进', prompt: '镜头平稳向主体推进，逐步强化主体细节' },
        { id: 'pull-out', label: '拉远', prompt: '镜头从主体缓慢拉远，逐步揭示完整环境' },
        { id: 'pan-left', label: '左摇', prompt: '镜头从右向左平稳摇摄，保持主体运动连续' },
        { id: 'orbit', label: '环绕', prompt: '镜头围绕主体进行平滑半环绕运动，保持主体居中' },
        { id: 'tracking', label: '跟拍', prompt: '镜头与主体同步移动，保持稳定跟拍距离' },
        { id: 'handheld', label: '手持', prompt: '轻微手持呼吸感，运动自然但画面主体保持清晰' },
        { id: 'static', label: '固定', prompt: '固定机位，不移动镜头，仅表现画面内动作' }
    ];

    function renderCameraPresetMenu(nodeEl, node) {
        const menu = nodeEl?.querySelector('[data-generation-camera-menu]');
        if (!menu || !node) return;
        const selectedId = node.data?.cameraPresets?.[0]?.id || '';
        menu.innerHTML = VIDEO_CAMERA_PRESETS.map(preset => `
            <button type="button" class="generation-camera-preset ${selectedId === preset.id ? 'is-active' : ''}"
                    data-generation-camera-preset="${escapeHtml(preset.id)}">${escapeHtml(preset.label)}</button>
        `).join('');
    }

    function applyCameraPreset(nodeEl, node, presetId) {
        const preset = VIDEO_CAMERA_PRESETS.find(item => item.id === presetId);
        if (!nodeEl || !node || node.type !== 'video' || !preset) return;
        const input = nodeEl.querySelector('.video-props-textarea');
        if (!input) return;

        const wasSelected = node.data?.cameraPresets?.[0]?.id === preset.id;
        const cameraPromptLine = wasSelected ? '' : `运镜：${preset.prompt}`;
        const basePrompt = String(input.value || node.data?.prompt || '')
            .split('\n')
            .filter(line => !/^\s*运镜：/.test(line))
            .join('\n');
        const prompt = wasSelected ? basePrompt : window.UltimateCanvasGenerationInteractions.replaceCameraLine(basePrompt, preset.prompt);
        input.value = prompt;
        node.data = {
            ...node.data,
            prompt,
            cameraPromptLine,
            cameraPresets: wasSelected ? [] : [{
                id: preset.id,
                name: preset.label,
                tagLabel: preset.label,
                prompt: preset.prompt
            }]
        };
        if (canvasRuntime.generationPopover?.kind === 'camera') {
            canvasRuntime.generationPopover.element.innerHTML = renderCameraPopover(node);
        }
        renderGenerationNodeControls(node.id);
        scheduleCanvasSave('video_camera_preset');
    }

    async function optimizeVideoPrompt(nodeEl, node, command) {
        const input = nodeEl?.querySelector('.video-props-textarea');
        const prompt = input?.value?.trim() || node?.data?.prompt || '';
        if (!input || !node || node.type !== 'video') return;
        if (!prompt) {
            showCanvasNotice('请先填写视频提示词，再进行优化。', 'warn');
            return;
        }
        const originalLabel = command?.textContent || '优化提示词';
        if (command) {
            command.disabled = true;
            command.textContent = '优化中';
        }
        setNodeGenerationStatus(nodeEl, 'loading', '正在通过文本模型优化视频提示词');
        try {
            const result = await postJson(
                backendEndpoint(
                    canvasRuntime.bootstrap?.capabilities?.text?.endpoint,
                    '/api/tools/ultimate-canvas/generate',
                    'text'
                ),
                {
                    kind: 'text',
                    mode: 'video-prompt-enhance',
                    prompt: `请把下面内容优化成可直接用于视频生成的完整中文提示词，补充画面、动作、镜头、光线和节奏，不要解释：\n${prompt}`,
                    title: node.data?.title || '视频提示词',
                    nodeId: node.id,
                    sourceNodes: nodeSourcePayloads(node.id),
                    project_id: canvasRuntime.selectedProjectId,
                    video_card_id: canvasRuntime.selectedVideoCardId,
                    canvas_document_id: canvasRuntime.documentId
                },
                { policy: 'text' }
            );
            const optimized = generatedTextFromResult(result);
            if (!optimized) throw new Error('文本模型没有返回可用提示词。');
            input.value = optimized;
            node.data = {
                ...node.data,
                prompt: optimized,
                promptOptimizedAt: new Date().toISOString(),
                promptOptimizationResult: result
            };
            setNodeGenerationStatus(nodeEl, 'success', '视频提示词已优化，可继续编辑后生成');
            scheduleCanvasSave('video_prompt_optimize');
        } catch (error) {
            setNodeGenerationStatus(nodeEl, 'error', error?.message || '提示词优化失败，原内容已保留');
            showCanvasNotice(error?.message || '提示词优化失败，原内容已保留。', 'error');
        } finally {
            if (command) {
                command.disabled = false;
                command.textContent = originalLabel;
            }
        }
    }

    function disconnectGenerationReferences(nodeId) {
        const references = generationReferenceItems(nodeId);
        if (!references.length) return false;
        const node = engine.nodes.get(nodeId);
        if (node?.data?.planReferences) node.data.planReferences = [];
        references.forEach(item => engine.disconnectNodes(item.nodeId, nodeId));
        renderGenerationNodeControls(nodeId);
        scheduleCanvasSave('generation_references_clear');
        return true;
    }

    document.addEventListener('click', event => {
        const quickMode = event.target.closest('[data-generation-quick-mode]');
        const quickNode = quickMode?.closest('.canvas-node');
        if (quickMode && quickNode) {
            event.preventDefault();
            event.stopPropagation();
            applyGenerationQuickMode(quickNode.dataset.nodeId, quickMode.dataset.generationQuickMode);
            return;
        }
        const trigger = event.target.closest('[data-generation-popover]');
        const triggerNode = trigger?.closest('.canvas-node');
        if (trigger && triggerNode) {
            event.preventDefault();
            event.stopPropagation();
            openGenerationPopover(triggerNode.dataset.nodeId, trigger.dataset.generationPopover, trigger);
            return;
        }
        const command = event.target.closest('[data-generation-command]');
        const nodeEl = command?.closest('.canvas-node');
        if (!command || !nodeEl) return;
        const nodeId = nodeEl.dataset.nodeId;
        const node = engine.nodes.get(nodeId);
        if (!node || !['image', 'video'].includes(node.type)) return;

        const action = command.dataset.generationCommand;
        if (action === 'import-reference') { openReferenceImport(nodeId); return; }
        if (action === 'style-gallery') { closeGenerationPopover(); engine._hideAddMenu(); void canvasStyles.open(nodeId); return; }
        if (action === 'clear-style') { canvasStyles.clear(nodeId); return; }
        if (action === 'refresh-style') { void canvasStyles.resume(nodeId); return; }
        if (action === 'optimize-prompt' && node.type === 'video') {
            optimizeVideoPrompt(nodeEl, node, command);
            return;
        }
        if (action === 'select-reference') {
            startReferenceSelection(nodeId);
            return;
        }
        if (action === 'disconnect-references') {
            if (!disconnectGenerationReferences(nodeId)) {
                showCanvasNotice('当前节点没有已连接的图片参考。', 'info');
            }
        }
    });

    document.addEventListener('click', event => {
        const remove = event.target.closest('[data-generation-reference-remove]');
        const nodeEl = remove?.closest('.canvas-node');
        if (!remove || !nodeEl) return;
        event.preventDefault();
        event.stopPropagation();
        removeGenerationReference(nodeEl.dataset.nodeId, remove.dataset.generationReferenceRemove);
    });

    document.addEventListener('click', event => {
        const action = event.target.closest('[data-reference-selection-action]')?.dataset.referenceSelectionAction;
        const state = canvasRuntime.referenceSelection;
        if (!action || !state) return;
        if (action === 'library') {
            openReferenceImport(state.targetNodeId);
        }
        if (action === 'return') {
            finishReferenceSelection();
        }
        if (action === 'multiple') { canvasRuntime.referenceSelection = { ...state, multiple: true }; renderReferenceSelectionStatus(); }
        if (action === 'exit') finishReferenceSelection();
    });

    document.addEventListener('click', event => {
        const preset = event.target.closest('[data-generation-camera-preset]');
        const state = canvasRuntime.generationPopover;
        const nodeEl = state ? document.querySelector(`[data-node-id="${CSS.escape(state.nodeId)}"]`) : null;
        if (!preset || !nodeEl || !state?.element.contains(preset)) return;
        const node = engine.nodes.get(state.nodeId);
        if (!node || node.type !== 'video') return;
        event.preventDefault();
        event.stopPropagation();
        applyCameraPreset(nodeEl, node, preset.dataset.generationCameraPreset);
    });

    document.addEventListener('click', event => {
        const choice = event.target.closest('[data-generation-setting-choice]');
        const state = canvasRuntime.generationPopover;
        if (!choice || state?.kind !== 'spec' || !state.element?.contains(choice)) return;
        const node = engine.nodes.get(state.nodeId);
        const panel = choice.closest('[data-generation-settings]');
        if (!node || panel?.dataset.generationSettings !== node.type) return;
        event.preventDefault();
        event.stopPropagation();
        applyGenerationSettingChoice(
            node,
            choice.dataset.generationSettingChoice,
            choice.dataset.generationValue
        );
    });

    document.addEventListener('input', event => {
        const slider = event.target.closest?.('[data-generation-duration-slider]');
        const state = canvasRuntime.generationPopover;
        if (!slider || state?.kind !== 'spec' || !state.element?.contains(slider)) return;
        syncGenerationDurationSlider(slider);
    });

    document.addEventListener('change', event => {
        const imageModelSelect = event.target.closest?.('[data-generation-image-model]');
        if (imageModelSelect) {
            const node = engine.nodes.get(imageModelSelect.closest('[data-node-id]')?.dataset.nodeId);
            if (!node || node.type !== 'image') return;
            const option = canvasRuntime.bootstrap?.capabilities?.image?.model_options?.find(item => item.value === imageModelSelect.value);
            if (!option) return;
            node.data = { ...node.data, imageSettings: { ...node.data?.imageSettings, model: option.value, resolution: option.capabilities.default_resolution, size: '' } };
            renderGenerationNodeControls(node.id);
            scheduleCanvasSave('image_model_change');
            refreshOpenGenerationSpecPopover(node);
            return;
        }
        const slider = event.target.closest?.('[data-generation-duration-slider]');
        const state = canvasRuntime.generationPopover;
        if (!slider || state?.kind !== 'spec' || !state.element?.contains(slider)) return;
        const node = engine.nodes.get(state.nodeId);
        const panel = slider.closest('[data-generation-settings]');
        if (!node || node.type !== 'video' || panel?.dataset.generationSettings !== 'video') return;
        const duration = syncGenerationDurationSlider(slider);
        if (duration === null) return;
        applyGenerationSettingChoice(node, 'duration', String(duration));
    });

    document.addEventListener('click', event => {
        const modeButton = event.target.closest('[data-generation-mode]');
        const state = canvasRuntime.generationPopover;
        if (!modeButton || modeButton.disabled || !state?.element.contains(modeButton)) return;
        const node = engine.nodes.get(state.nodeId);
        if (!node) return;
        const locked = generationSettingsLockReason(node);
        if (locked) { showCanvasNotice(locked, 'warn'); return; }
        node.data = { ...node.data, mode: modeButton.dataset.generationMode };
        renderGenerationNodeControls(node.id);
        scheduleCanvasSave(`${node.type}_mode_change`);
        closeGenerationPopover();
    });

    document.addEventListener('pointerdown', event => {
        const state = canvasRuntime.generationPopover;
        if (!state || state.element.contains(event.target) || state.anchor.contains(event.target)) return;
        closeGenerationPopover();
    }, true);

    engine.container.addEventListener('wheel', closeGenerationPopover, { passive: true });
    let generationResizeFrame = 0;
    window.addEventListener('resize', () => {
        closeGenerationPopover();
        window.cancelAnimationFrame(generationResizeFrame);
        generationResizeFrame = window.requestAnimationFrame(renderAllGenerationNodeControls);
    });
    engine.onNodeSelected = nodeId => {
        updateGraphTools();
        closeGenerationPopover();
        if (engine.nodes.get(nodeId)?.type === 'text') updateGenerationLabels(canvasRuntime.bootstrap);
    };
    engine.onReferenceNodePick = nodeId => {
        if (!canvasRuntime.referenceSelection) return false;
        if (nodeId !== canvasRuntime.referenceSelection.targetNodeId) selectCanvasReference(nodeId);
        return true;
    };
    engine.onNodeDeselected = () => { closeGenerationPopover(); updateGraphTools(); };
    const minimapViewportChanged = engine.onViewportChanged;
    engine.onViewportChanged = (...args) => { minimapViewportChanged?.(...args); closeGenerationPopover(); };

    document.addEventListener('click', event => {
        const previewAction = event.target.closest('[data-canvas-media-preview]');
        if (previewAction) {
            event.preventDefault();
            event.stopPropagation();
            closeGenerationPopover();
            pauseInlineVideos();
            const contentKey = previewAction.dataset.contentKey || '';
            if (!/^(asset|reference_image|video_task):[a-zA-Z0-9_-]+$/.test(contentKey)) {
                showCanvasNotice('这条媒体没有可追溯的内容编号，暂不能在画布内预览。', 'warn');
                return;
            }
            window.parent.postMessage({ type: 'sd2-canvas-preview-request', contentKey }, window.location.origin);
            return;
        }
        const actionElement = event.target.closest('[data-generated-image-action]');
        if (!actionElement) return;
        const action = actionElement.dataset.generatedImageAction;
        if (action === 'open' || action === 'download') return;

        const nodeId = actionElement.dataset.nodeId;
        const node = engine.nodes.get(nodeId);
        const nodeEl = document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
        if (!node || node.type !== 'image' || !nodeEl) return;
        event.preventDefault();
        event.stopPropagation();

        if (action === 'regenerate') {
            const submit = nodeEl.querySelector('[data-generation-submit]');
            if (!submit) return;
            node.data = { ...node.data, generationStatus: 'idle', generationError: null };
            submitNodeGeneration(nodeEl, submit);
            return;
        }

        if (action === 'create-video') {
            const videoNodeId = window.UltimateCanvasGenerationInteractions.applyDownstreamVideoAction({
                createVideoNode: () => engine.addNode('video', node.x + 760, node.y, {
                    mode: 'image-to-video',
                    sourceNodeId: node.id,
                    prompt: node.data?.prompt || node.data?.description || '',
                    videoSettings: {
                        ratio: generationSettingsForNode(node).ratio || ratioFromContext(),
                        duration: durationFromContext(),
                        resolution: resolutionFromContext(),
                        generateAudio: false,
                        returnLastFrame: false,
                        watermark: false
                    }
                }),
                connectNodes: (fromId, toId) => engine.connectNodes(fromId, toId),
                rollbackVideoNode: nodeId => engine.deleteNode(nodeId)
            }, { sourceNodeId: node.id });
            if (!videoNodeId) return;
            renderGenerationNodeControls(videoNodeId);
            scheduleCanvasSave('image_create_video');
            showCanvasNotice('已创建并连接图生视频节点。', 'info');
        }
    });

    function promptInputFor(nodeEl, type) {
        if (type === 'video') return nodeEl.querySelector('.video-props-textarea');
        if (type === 'image') return nodeEl.querySelector('.image-props-textarea');
        return nodeEl.querySelector('.node-input-textarea')
            || nodeEl.querySelector('.node-text-content');
    }

    function promptValueFor(nodeEl, node) {
        const input = promptInputFor(nodeEl, node.type);
        const value = input?.value ?? input?.textContent ?? '';
        return value.trim() || node.data?.prompt || node.data?.description || '';
    }

    function promptTabsFor(nodeEl, node) {
        if (node.type === 'video') {
            return [...nodeEl.querySelectorAll('.video-props-tab')].map(tab => ({
                label: tab.textContent.trim(),
                active: tab.classList.contains('active')
            }));
        }
        if (node.type === 'image') {
            const mode = node.data?.mode || 'text-to-image';
            return ['文生图', '图生图', '高清修复', '首帧草图', '尾帧草图'].map(label => ({
                label,
                active: imageModeMap[label] === mode || (!mode && label === '文生图')
            }));
        }
        return [{ label: '文本提示', active: true }];
    }

    function promptContextFor(nodeEl) {
        const nodeId = nodeEl?.dataset.nodeId;
        const node = engine.nodes.get(nodeId);
        if (!node) return null;
        if (!['text', 'image', 'video'].includes(node.type)) return null;

        const label = nodeEl.querySelector('.node-label')?.textContent.trim()
            || node.data?.title
            || nodeId;
        const model = nodeEl.querySelector('[data-generation-image-model] option:checked')?.textContent.trim() || nodeEl.querySelector('.video-model-info, .model-selector')?.textContent.trim() || '';
        const spec = nodeEl.querySelector('.video-res-info')?.textContent.trim() || '';
        const sourceNodes = nodeSourcePayloads(nodeId);
        const prompt = promptValueFor(nodeEl, node);
        const tabs = promptTabsFor(nodeEl, node);
        const branches = node.type === 'video' ? selectedVideoBranches() : [];
        const videoBranchId = node.type === 'video'
            ? window.UltimateCanvasVideoCards.chooseBranch(
                branches,
                node.data?.videoBranchId || canvasRuntime.selectedVideoBranchId
            )
            : '';
        const kindLabel = node.type === 'video' ? 'VIDEO PROMPT'
            : node.type === 'image' ? 'IMAGE PROMPT'
                : 'TEXT PROMPT';

        return {
            node,
            nodeId,
            nodeEl,
            label,
            kindLabel,
            prompt,
            tabs,
            branches,
            videoBranchId,
            model,
            spec,
            sourceNodes,
            cameraPresets: node.data?.cameraPresets || [],
            referenceImage: node.data?.previewImage || node.data?.referenceImage || '',
            placeholder: node.type === 'video'
                ? '描述你想要生成的视频画面、镜头、动作、节奏和风格，@引用素材'
                : node.type === 'image'
                    ? '描述你想要生成的画面内容，构图、主体、光线、风格可以写完整。'
                    : '写下故事、场景、角色设定或要生成的文本内容。'
        };
    }

    function buildPromptTabs(tabs) {
        return tabs.map((tab, index) => `
            <button class="prompt-modal-tab ${tab.active || (!tabs.some(t => t.active) && index === 0) ? 'active' : ''}"
                    data-prompt-tab="${escapeHtml(tab.label)}">${escapeHtml(tab.label)}</button>
        `).join('');
    }

    function buildCameraPresetChips(presets) {
        if (!presets?.length) return '<span class="prompt-token muted">无运镜</span>';
        return presets.map((preset, index) => `
            <span class="prompt-token">{{CameraPreset ${index + 1}} ${escapeHtml(preset.tagLabel || preset.name || '')}</span>
        `).join('');
    }

    function buildPromptBranchSelector(ctx) {
        if (ctx.node.type !== 'video') return '';
        const branches = window.UltimateCanvasVideoCards.activeBranches(ctx.branches || []);
        const options = branches.map(branch => `
            <option value="${escapeHtml(branch.id)}" ${branch.id === ctx.videoBranchId ? 'selected' : ''}>
                ${escapeHtml(branch.is_primary ? `\u4e3b\u65b9\u5411 \u00b7 ${branch.title}` : branch.title)}
            </option>`).join('');
        return `
            <div class="prompt-side-card prompt-branch-card">
                <span>${escapeHtml(videoCardUiText.branches)}</span>
                <select data-video-branch-prompt-select ${branches.length ? '' : 'disabled'}>
                    ${options || `<option value="">${escapeHtml(videoCardUiText.emptyBranches)}</option>`}
                </select>
            </div>`;
    }

    function buildPromptModal(ctx) {
        const sourceLabel = ctx.sourceNodes.length ? `${ctx.sourceNodes.length} 个来源节点` : '无来源节点';
        return `
            <div class="prompt-modal-overlay" data-prompt-modal data-node-id="${escapeHtml(ctx.nodeId)}">
                <section class="prompt-modal-window" role="dialog" aria-modal="true" aria-label="完整提示词">
                    <header class="prompt-modal-header">
                        <div>
                            <span>${escapeHtml(ctx.kindLabel)}</span>
                            <strong>${escapeHtml(ctx.label)}</strong>
                        </div>
                        <button class="prompt-modal-close" data-prompt-close title="关闭">×</button>
                    </header>
                    <div class="prompt-modal-tabs">${buildPromptTabs(ctx.tabs)}</div>
                    <div class="prompt-modal-body">
                        <main class="prompt-modal-editor">
                            <textarea data-prompt-modal-textarea placeholder="${escapeHtml(ctx.placeholder)}">${escapeHtml(ctx.prompt)}</textarea>
                            <div class="prompt-token-row">
                                ${buildCameraPresetChips(ctx.cameraPresets)}
                            </div>
                        </main>
                        <aside class="prompt-modal-side">
                            <div class="prompt-side-card">
                                <span>模型</span>
                                <strong>${escapeHtml(ctx.model || '未指定')}</strong>
                            </div>
                            <div class="prompt-side-card">
                                <span>规格</span>
                                <strong>${escapeHtml(ctx.spec || '默认规格')}</strong>
                            </div>
                            <div class="prompt-side-card">
                                <span>引用</span>
                                <strong>${escapeHtml(sourceLabel)}</strong>
                            </div>
                            ${buildPromptBranchSelector(ctx)}
                            ${ctx.referenceImage ? `
                                <div class="prompt-side-card prompt-reference-preview">
                                    <span>参考图</span>
                                    <img src="${escapeHtml(ctx.referenceImage)}" alt="参考图">
                                </div>
                            ` : ''}
                        </aside>
                    </div>
                    <footer class="prompt-modal-footer">
                        <button class="prompt-secondary" data-prompt-cancel>取消</button>
                        <button class="prompt-secondary" data-prompt-save>保存</button>
                        <button class="prompt-primary" data-prompt-generate>生成</button>
                    </footer>
                </section>
            </div>
        `;
    }

    function contextRulesContextFor(nodeEl) {
        const nodeId = nodeEl?.dataset.nodeId;
        const node = engine.nodes.get(nodeId);
        if (!node || node.type !== 'text') return null;
        const label = nodeEl.querySelector('.node-label')?.textContent.trim()
            || node.data?.title
            || nodeId;
        return {
            node,
            nodeId,
            nodeEl,
            label,
            prompt: promptValueFor(nodeEl, node),
            rules: node._pendingTextRules ? (node._pendingTextRules.previous.contextRules ?? node._pendingTextRules.previous.context_rules ?? '') : contextRulesForNode(node),
            pendingRules: node._pendingTextRules
        };
    }

    const rulePurposeLabels = { basic: '全部画布文本', text: '普通文本', prompt: '提示词创作/优化', storyboard: '分镜提示词' };
    const ruleCopy = value => JSON.parse(JSON.stringify(value));
    const ruleSignature = rules => JSON.stringify((rules || []).filter(rule => rule.revision || rule.name.trim() || rule.body.trim()));
    function rulesOwnerMatches(modal) {
        return modal.isConnected && isCanvasAdmin() && modal._owner === canvasRuntime.bootstrap?.user?.id
            && modal._document === canvasRuntime.documentId && engine.nodes.get(modal.dataset.nodeId) === modal._node;
    }
    function rulesScopeDirty(modal, scope = modal._scope) {
        return scope === 'global' ? Boolean(modal._settings && (ruleSignature(modal._draft) !== ruleSignature(modal._settings.rules) || modal._mergeLegacy))
            : Boolean(modal._node?._pendingTextRules) || modal._nodeDraft !== modal._nodeInitial || modal._purpose !== modal._purposeInitial;
    }
    function rulesModalDirty(modal) {
        return Boolean(modal && (rulesScopeDirty(modal, 'node') || rulesScopeDirty(modal, 'global')));
    }
    function rulePurposeForModal(modal) {
        const kind = modal._node?.data?.generationIntent?.kind || modal._node?.type;
        const mode = modal._node?.data?.mode || modal._node?.data?.generationIntent?.mode;
        return mode === 'video-prompt-enhance' ? 'prompt' : kind === 'script' ? 'storyboard' : modal._purpose;
    }
    function rulesUiPreference(modal, read = false) {
        const key = 'sd2:canvas-rule-ui:' + modal._owner;
        try {
            if (read) return JSON.parse(localStorage.getItem(key) || 'null');
            localStorage.setItem(key, JSON.stringify({ scope: modal._scope, selected: modal._selected, deleted: modal._showDeleted }));
        } catch { /* Rule bodies and unsaved drafts are never put in this preference. */ }
    }
    function rulesTime(value) {
        if (!value || !Number.isFinite(Date.parse(value))) return '';
        const age = Math.max(0, Date.now() - Date.parse(value));
        const label = age < 45000 ? '刚刚' : age < 3600000 ? Math.floor(age / 60000) + '分钟前'
            : age < 86400000 ? Math.floor(age / 3600000) + '小时前' : age < 2592000000
                ? Math.floor(age / 86400000) + '天前' : age < 31536000000 ? Math.floor(age / 2592000000) + '个月前' : Math.floor(age / 31536000000) + '年前';
        return '<button type="button" class="rules-time" data-rules-time="' + escapeHtml(value) + '" aria-label="查看准确时间"><time datetime="' + escapeHtml(value) + '">' + label + '</time></button>';
    }
    function rulesTimeClose() {
        const bubble = document.querySelector('[data-rules-time-bubble]');
        bubble?._trigger?.removeAttribute('aria-describedby');
        bubble?.remove();
    }
    function rulesTimeOpen(button, pinned = false) {
        rulesTimeClose();
        const bubble = document.createElement('div');
        bubble.dataset.rulesTimeBubble = 'true';
        bubble.dataset.pinned = String(pinned);
        bubble.id = 'canvas-rules-exact-time';
        bubble.role = 'tooltip';
        bubble.className = 'rules-time-bubble';
        bubble.textContent = new Date(button.dataset.rulesTime).toLocaleString() + '（本地时间）';
        document.body.appendChild(bubble);
        const rect = button.getBoundingClientRect();
        bubble.style.left = Math.max(8, Math.min(rect.left, innerWidth - bubble.offsetWidth - 8)) + 'px';
        bubble.style.top = (rect.bottom + bubble.offsetHeight < innerHeight - 8 ? rect.bottom + 6 : rect.top - bubble.offsetHeight - 6) + 'px';
        button.setAttribute('aria-describedby', bubble.id);
        bubble._trigger = button;
    }
    function ruleIconButton(action, icon, label, disabled = false) {
        return '<button type="button" class="rules-icon" data-rule-action="' + action + '" title="' + label + '" aria-label="' + label + '"' + (disabled ? ' disabled' : '') + '>' + window.UltimateCanvasIcons(icon) + '</button>';
    }
    function buildContextRulesModal(ctx) {
        return '<div class="context-rules-modal-overlay" data-context-rules-modal data-node-id="' + escapeHtml(ctx.nodeId) + '">'
            + '<section class="context-rules-modal" role="dialog" aria-modal="true" aria-label="文本生成规则">'
            + '<header class="context-rules-modal-header"><div><span>文本生成规则</span><strong>' + escapeHtml(ctx.label) + '</strong></div>'
            + '<button type="button" class="context-rules-close" data-context-rules-close title="关闭" aria-label="关闭">' + window.UltimateCanvasIcons('X') + '</button></header>'
            + '<div class="context-rules-tabs" role="tablist" aria-label="规则范围"><button type="button" role="tab" data-rules-tab="node">节点专属</button>'
            + '<button type="button" role="tab" data-rules-tab="global">画布通用</button></div>'
            + '<div data-rules-switch-guard hidden class="rules-switch-guard">当前范围有未保存修改。'
            + '<button type="button" data-rules-switch="save">保存并切换</button><button type="button" data-rules-switch="discard">放弃并切换</button><button type="button" data-rules-switch="stay">留下</button></div>'
            + '<div class="context-rules-modal-body" data-rules-body></div>'
            + '<p class="context-rules-status" data-rules-status role="status">画布通用规则读取中</p>'
            + '<footer class="context-rules-modal-footer"><span data-rules-dirty></span><button type="button" class="context-rules-secondary" data-context-rules-cancel>取消</button>'
            + '<button type="button" class="context-rules-primary" data-context-rules-save>保存</button></footer></section></div>';
    }
    function rulesStatus(modal, message) {
        if (message !== undefined) modal.querySelector('[data-rules-status]').textContent = message;
        modal.querySelector('[data-rules-dirty]').textContent = rulesScopeDirty(modal) ? '未保存' : '';
        const save = modal.querySelector('[data-context-rules-save]');
        save.disabled = modal._saving || modal._loading || (modal._scope === 'global' && (!modal._settings || Boolean(modal._incoming)));
        save.textContent = modal._saving ? '保存中' : modal._scope === 'global' ? '保存通用规则' : '保存节点规则';
        save.classList.add('sd2-loading-surface');
        save.dataset.busy = String(Boolean(modal._saving));
    }
    function rulesPreview(modal) {
        const target = modal.querySelector('[data-rules-preview]');
        if (!target) return;
        const purpose = rulePurposeForModal(modal);
        const rules = modal._draft || [];
        const active = rules.filter(rule => !rule.deletedAt && rule.enabled && (rule.purpose === 'basic' || rule.purpose === purpose))
            .sort((a, b) => Number(b.purpose === 'basic') - Number(a.purpose === 'basic') || a.order - b.order || a.id.localeCompare(b.id));
        const total = active.reduce((count, rule) => count + rule.body.length, modal._nodeDraft.length);
        target.textContent = (rulesScopeDirty(modal) ? '草稿预览；' : '已保存；') + rulePurposeLabels[purpose]
            + '：基础' + active.filter(rule => rule.purpose === 'basic').length + '条，用途'
            + active.filter(rule => rule.purpose !== 'basic').length + '条，节点专属' + Number(Boolean(modal._nodeDraft.trim()))
            + '条；合计' + total + '/4000字。' + (total > 4000 ? '超过有效上限。' : '')
            + rules.filter(rule => !active.includes(rule)).map(rule => rule.name + '：' + (rule.deletedAt ? '已删除' : !rule.enabled ? '未启用' : '用途不匹配')).join('；');
        const effective = modal.querySelector('[data-rules-effective]');
        if (effective) effective.textContent = active.map(rule => rule.name + '（' + rulePurposeLabels[rule.purpose] + '）\n' + rule.body).join('\n\n')
            + (modal._nodeDraft ? '\n\n节点专属\n' + modal._nodeDraft : '');
    }
    function renderRuleList(modal) {
        const target = modal.querySelector('[data-rule-list]');
        if (!target) return;
        const query = (modal._search || '').toLowerCase();
        const list = modal._draft.filter(rule => Boolean(rule.deletedAt) === Boolean(modal._showDeleted) && (!query || rule.name.toLowerCase().includes(query)))
            .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        target.innerHTML = list.map(rule => '<button type="button" class="rules-list-item" data-rule-id="' + escapeHtml(rule.id)
            + '" aria-pressed="' + String(rule.id === modal._selected) + '"><span>' + escapeHtml(rule.name || '未命名规则') + '</span><small>'
            + (rule.deletedAt ? '已删除' : rule.enabled ? '已启用' : '未启用') + '</small></button>').join('')
            || '<p class="rules-empty">' + (query ? '没有匹配规则' : modal._showDeleted ? '没有已删除规则' : '暂无规则') + '</p>';
    }
    function renderRulesEditor(modal) {
        const global = modal._scope === 'global';
        modal.querySelectorAll('[data-rules-tab]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.rulesTab === modal._scope)));
        const body = modal.querySelector('[data-rules-body]');
        if (!global) {
            body.innerHTML = '<main class="context-rules-editor"><label>节点用途<select data-rules-node-purpose>'
                + ['text', 'prompt', 'storyboard'].map(value => '<option value="' + value + '"' + (modal._purpose === value ? ' selected' : '') + '>' + rulePurposeLabels[value] + '</option>').join('')
                + '</select></label><label><span>仅当前节点</span><textarea data-context-rules-textarea data-context-rules-editor maxlength="4000">'
                + escapeHtml(modal._nodeDraft) + '</textarea></label><details><summary>本次生效</summary><p data-rules-preview></p><pre data-rules-effective></pre></details>'
                + '<details><summary>最近请求的规则版本</summary>' + (modal._node.data?.textRuleHistory || []).map(item => '<div>' + rulesTime(item.recordedAt)
                    + '<pre>' + escapeHtml(JSON.stringify(item.trace, null, 2)) + '</pre></div>').join('') + '</details></main>';
        } else if (!modal._settings) {
            body.innerHTML = '<p>' + (modal._loading ? '读取中' : '读取失败，已生效规则未改变') + '</p><button type="button" data-rules-reload>重新读取</button>';
        } else {
            const selected = modal._draft.find(rule => rule.id === modal._selected && Boolean(rule.deletedAt) === Boolean(modal._showDeleted))
                || modal._draft.find(rule => Boolean(rule.deletedAt) === Boolean(modal._showDeleted));
            modal._selected = selected?.id;
            body.innerHTML = '<nav class="rules-list" aria-label="通用规则"><button type="button" class="context-rules-secondary" data-rule-action="new">'
                + window.UltimateCanvasIcons('Plus') + ' 新建规则</button><label class="rules-deleted-toggle"><input type="checkbox" data-rules-deleted'
                + (modal._showDeleted ? ' checked' : '') + '>已删除</label>'
                + (modal._draft.length > 8 ? '<input type="search" data-rules-search placeholder="搜索规则名" aria-label="搜索规则名" value="' + escapeHtml(modal._search || '') + '">' : '')
                + '<div data-rule-list></div><button type="button" data-rules-reload>读取最新版对照</button></nav><main class="context-rules-editor">'
                + (selected ? '<div class="rules-fields"><label>名称<input data-rule-field="name" maxlength="80" value="' + escapeHtml(selected.name) + '"' + (selected.deletedAt ? ' disabled' : '') + '></label>'
                    + '<label>适用用途<select data-rule-field="purpose"' + (selected.deletedAt ? ' disabled' : '') + '>'
                    + Object.entries(rulePurposeLabels).map(([value, label]) => '<option value="' + value + '"' + (selected.purpose === value ? ' selected' : '') + '>' + label + '</option>').join('') + '</select></label>'
                    + '<label class="rules-enabled"><input type="checkbox" data-rule-field="enabled"' + (selected.enabled && !selected.deletedAt ? ' checked' : '')
                    + (selected.deletedAt || (modal._mergeLegacy && selected.id === modal._mergeLegacyRuleId) ? ' disabled' : '') + '>启用</label></div>'
                    + '<label><span>正文</span><textarea data-rule-field="body" data-context-rules-editor maxlength="4000"' + (selected.deletedAt ? ' readonly' : '') + '>'
                    + escapeHtml(selected.body) + '</textarea></label><div class="rules-actions">' + rulesTime(selected.updatedAt)
                    + (selected.deletedAt ? ruleIconButton('restore', 'RotateCcw', '恢复为未启用')
                        : '<details class="rules-menu"><summary title="更多操作" aria-label="更多操作">' + window.UltimateCanvasIcons('SlidersHorizontal') + '</summary>'
                            + ruleIconButton('copy', 'Layers', '复制为未启用') + ruleIconButton('up', 'ArrowUp', '上移')
                            + ruleIconButton('down', 'ArrowDown', '下移') + ruleIconButton('delete', 'Trash2', '删除规则') + '</details>') + '</div>'
                    : '<p class="rules-empty">暂无规则</p>')
                + '<details><summary>本次生效</summary><p data-rules-preview></p><pre data-rules-effective></pre></details>'
                + (modal._settings.legacyChanged ? '<aside class="rules-conflict"><p>旧版规则已修改，当前规则库仍保留。需明确合并后保存。</p><textarea readonly aria-label="旧版最新正文">'
                    + escapeHtml(modal._settings.legacyCurrent.context) + '</textarea><button type="button" data-rules-legacy-merge'
                    + (modal._mergeLegacy ? ' disabled' : '') + '>保留两份，加入未启用规则</button></aside>' : '')
                + '<details><summary>版本存档</summary><label>最近版本<select data-rules-history><option value="">选择版本</option>'
                + modal._settings.history.map(item => '<option value="' + item.revision + '">版本 ' + item.revision + '</option>').join('')
                + '</select></label><button type="button" data-rule-action="history">恢复为未启用草稿</button><button type="button" data-rule-action="original">找回原始基础正文</button></details>'
                + '<div data-rules-conflicts></div></main>';
            renderRuleList(modal);
            renderRulesConflicts(modal);
        }
        if (modal._saving) body.querySelectorAll('input, select, textarea, button, summary').forEach(el => { el.disabled = true; });
        if (modal._incoming) body.querySelectorAll('[data-rule-field]').forEach(el => { el.disabled = true; });
        rulesStatus(modal);
        rulesPreview(modal);
        rulesUiPreference(modal);
    }
    function renderRulesConflicts(modal) {
        const target = modal.querySelector('[data-rules-conflicts]');
        if (!target || !modal._incoming) return;
        target.innerHTML = '<aside class="rules-conflict"><strong>新版对照，原草稿保留</strong>'
            + modal._conflicts.map(item => '<div><p>' + escapeHtml(item.mine?.name || item.theirs?.name || '规则') + '</p><div class="rules-compare">'
                + '<label>我的草稿<textarea readonly>' + escapeHtml(JSON.stringify(item.mine, null, 2)) + '</textarea></label><label>最新保存<textarea readonly>'
                + escapeHtml(JSON.stringify(item.theirs, null, 2)) + '</textarea></label></div>'
                + '<button type="button" data-rules-resolve="' + escapeHtml(item.id) + '" data-choice="mine">用我的草稿</button>'
                + '<button type="button" data-rules-resolve="' + escapeHtml(item.id) + '" data-choice="theirs">用最新版</button></div>').join('')
            + '<button type="button" data-rules-rebase' + (modal._conflicts.length ? ' disabled' : '') + '>采用对照结果，继续编辑</button></aside>';
    }
    async function readRulesLibrary(modal) {
        if (modal._loading || modal._saving) return;
        modal._loading = true; rulesStatus(modal);
        try {
            const settings = await requestJson('/api/tools/ultimate-canvas/text-settings', { cache: 'no-store' });
            if (!rulesOwnerMatches(modal)) return;
            if (!Array.isArray(settings.rules) || !settings.expected) throw Error('规则读取结果不完整');
            if (!modal._settings || !rulesScopeDirty(modal, 'global')) {
                modal._settings = settings; modal._draft = ruleCopy(settings.rules); modal._incoming = null; modal._mergeLegacy = false;
            } else {
                modal._incoming = settings; modal._conflicts = []; modal._rebase = ruleCopy(settings.rules);
                for (const mine of modal._draft) {
                    const before = modal._settings.rules.find(rule => rule.id === mine.id);
                    const theirs = settings.rules.find(rule => rule.id === mine.id);
                    const localChanged = JSON.stringify(mine) !== JSON.stringify(before);
                    const remoteChanged = JSON.stringify(theirs) !== JSON.stringify(before);
                    if (localChanged && remoteChanged && JSON.stringify(mine) !== JSON.stringify(theirs)) modal._conflicts.push({ id: mine.id, mine, theirs });
                    else if (localChanged) {
                        modal._rebase = modal._rebase.filter(rule => rule.id !== mine.id);
                        modal._rebase.push({ ...mine, revision: theirs?.revision || 0 });
                    }
                }
            }
            rulesStatus(modal, modal._incoming ? '草稿未覆盖；请完成新版对照。' : settings.legacyChanged ? '旧版正文有变化，需明确合并。' : '保存后，下次适用的文本生成生效。');
        } catch (error) { if (rulesOwnerMatches(modal)) rulesStatus(modal, error.message + '；草稿未改变。'); }
        finally {
            modal._loading = false;
            if (rulesOwnerMatches(modal)) renderRulesEditor(modal);
        }
    }
    async function closeContextRulesModal(force = false) {
        const modal = document.querySelector('[data-context-rules-modal]');
        if (!force && (modal?._saving || modal?._closing)) return false;
        if (!force && rulesModalDirty(modal)) {
            modal._closing = true;
            const accepted = await requestCanvasConfirmation({ title: '放弃修改', message: '规则有未保存修改，确定关闭吗？', confirmLabel: '放弃并关闭' });
            modal._closing = false;
            if (!accepted || !modal.isConnected) return false;
        }
        rulesTimeClose();
        if (modal?._timeRefresh) clearInterval(modal._timeRefresh);
        modal?.remove();
        document.body.classList.remove('context-rules-modal-open');
        window.parent.postMessage({ type: 'sd2-canvas-style-gallery', open: false }, window.location.origin);
        modal?._returnFocus?.focus?.();
        return true;
    }
    async function openContextRulesModal(nodeEl) {
        if (!isCanvasAdmin()) { showCanvasNotice('只有管理员可以编辑文本规则。', 'warn'); return; }
        const ctx = contextRulesContextFor(nodeEl);
        if (!ctx || !await closeContextRulesModal()) return;
        document.body.insertAdjacentHTML('beforeend', buildContextRulesModal(ctx));
        document.body.classList.add('context-rules-modal-open');
        const modal = document.querySelector('[data-context-rules-modal]');
        Object.assign(modal, { _node: ctx.node, _owner: canvasRuntime.bootstrap.user.id, _document: canvasRuntime.documentId,
            _nodeInitial: ctx.rules, _nodeDraft: ctx.pendingRules?.candidate.contextRules ?? ctx.rules,
            _purposeInitial: (ctx.pendingRules ? ctx.pendingRules.previous.textPurpose : ctx.node.data?.textPurpose) || 'text',
            _purpose: ctx.pendingRules?.candidate.textPurpose || ctx.node.data?.textPurpose || 'text', _scope: 'node', _draft: [], _restored: new Set(),
            _returnFocus: nodeEl.querySelector('[data-context-rules-open]') });
        const preference = rulesUiPreference(modal, true);
        if (preference?.scope === 'global') modal._scope = 'global';
        if (typeof preference?.selected === 'string') modal._selected = preference.selected;
        modal._showDeleted = preference?.deleted === true;
        renderRulesEditor(modal);
        window.parent.postMessage({ type: 'sd2-canvas-style-gallery', open: true }, window.location.origin);
        modal._timeRefresh = setInterval(() => {
            if (!rulesOwnerMatches(modal)) { closeContextRulesModal(true); return; }
            modal.querySelectorAll('[data-rules-time]').forEach(button => {
                const replacement = document.createElement('div'); replacement.innerHTML = rulesTime(button.dataset.rulesTime);
                button.querySelector('time').textContent = replacement.querySelector('time').textContent;
            });
        }, 60000);
        modal.querySelector('textarea, [data-rules-tab]')?.focus();
        await readRulesLibrary(modal);
    }
    async function saveContextRulesModal(modal, close = true) {
        if (modal._saving || modal._loading || !rulesOwnerMatches(modal)) return false;
        const global = modal._scope === 'global';
        if (global && (!modal._settings || modal._incoming)) { rulesStatus(modal, '请先完成读取或新版对照，草稿仍保留。'); return false; }
        if (!rulesScopeDirty(modal)) { if (close) await closeContextRulesModal(); return true; }
        modal._saving = true; renderRulesEditor(modal);
        let saved = false;
        try {
            if (global) {
                const result = await patchJson('/api/tools/ultimate-canvas/text-settings', {
                    rules: modal._draft.filter(rule => rule.revision || rule.name.trim() || rule.body.trim()),
                    expected: modal._settings.expected, mergeLegacy: modal._mergeLegacy === true
                });
                if (!rulesOwnerMatches(modal)) return false;
                modal._settings = result; modal._draft = ruleCopy(result.rules); modal._mergeLegacy = false; modal._restored.clear();
            } else {
                const node = modal._node;
                if (!canvasRuntime.documentWritable) throw Error('当前画布不可写，草稿仍保留。');
                const previous = node._pendingTextRules?.previous || { contextRules: node.data?.contextRules, context_rules: node.data?.context_rules, contextRulesUpdatedAt: node.data?.contextRulesUpdatedAt, textPurpose: node.data?.textPurpose };
                const candidate = { contextRules: modal._nodeDraft, contextRulesUpdatedAt: new Date().toISOString(), textPurpose: modal._purpose };
                node._pendingTextRules = { previous, candidate };
                node.data = { ...node.data, ...candidate };
                scheduleCanvasSave('context_rules_change');
                if (!await flushCanvasSave('context_rules_change', true) || node._pendingTextRules) throw Error('节点规则保存未确认，草稿仍保留；当前生成继续使用此前规则，请重试保存。');
                if (!rulesOwnerMatches(modal)) return false;
                modal._nodeInitial = modal._nodeDraft; modal._purposeInitial = modal._purpose;
                refreshContextRulesButtons();
            }
            saved = true;
            rulesStatus(modal, '已保存，下次适用的文本生成生效。');
        } catch (error) { if (rulesOwnerMatches(modal)) rulesStatus(modal, error.message || '保存失败，草稿仍保留。'); }
        finally {
            modal._saving = false;
            if (rulesOwnerMatches(modal)) renderRulesEditor(modal);
        }
        if (saved && close) await closeContextRulesModal();
        return saved;
    }
    async function switchRulesScope(modal, scope) {
        if (modal._saving || modal._loading || modal._scope === scope) return;
        if (rulesScopeDirty(modal)) {
            modal._pendingScope = scope;
            modal.querySelector('[data-rules-switch-guard]').hidden = false;
            return;
        }
        modal._scope = scope; renderRulesEditor(modal);
    }
    async function rulesAction(modal, action) {
        if (modal._saving || modal._loading || !rulesOwnerMatches(modal) || !modal._settings || modal._incoming) return;
        const selected = modal._draft.find(rule => rule.id === modal._selected);
        const add = (name = '', body = '', purpose = 'text') => {
            if (modal._draft.length >= 40) { rulesStatus(modal, '规则最多40条（含已删除）。'); return; }
            const rule = { id: crypto.randomUUID(), name, body, purpose, enabled: false, order: modal._draft.length,
                revision: 0, deletedAt: null, updatedAt: null };
            modal._draft.push(rule); modal._selected = rule.id; modal._showDeleted = false;
            return rule;
        };
        if (action === 'new') add();
        else if (action === 'copy' && selected) add((selected.name + ' 副本').slice(0, 80), selected.body, selected.purpose);
        else if (action === 'delete' && selected) {
            if (selected.revision && !await requestCanvasConfirmation({ title: '删除规则', message: '保存后不再用于后续生成，正文仍可在已删除中恢复。', confirmLabel: '删除规则' })) return;
            if (!rulesOwnerMatches(modal)) return;
            if (!selected.revision) modal._draft = modal._draft.filter(rule => rule.id !== selected.id);
            else { selected.deletedAt = new Date().toISOString(); selected.enabled = false; }
        } else if (action === 'restore' && selected) {
            selected.deletedAt = null; selected.enabled = false; modal._restored.add(selected.id); modal._showDeleted = false;
        } else if ((action === 'up' || action === 'down') && selected) {
            const list = modal._draft.filter(rule => !rule.deletedAt).sort((a, b) => a.order - b.order);
            const index = list.indexOf(selected), other = index + (action === 'up' ? -1 : 1);
            if (other >= 0 && other < list.length) { [list[index], list[other]] = [list[other], list[index]]; list.forEach((rule, order) => { rule.order = order; }); }
        } else if (action === 'original') add('原始基础正文', modal._settings.legacyOriginal.context, 'basic');
        else if (action === 'legacy') {
            const retained = add('旧版修改（待合并）', modal._settings.legacyCurrent.context, 'basic');
            if (retained) { modal._mergeLegacy = true; modal._mergeLegacyRuleId = retained.id; }
        } else if (action === 'history') {
            const snapshot = modal._settings.history.find(item => String(item.revision) === modal.querySelector('[data-rules-history]').value);
            if (!snapshot) return;
            if (!await requestCanvasConfirmation({ title: '恢复规则版本', message: '恢复为未启用草稿；当前规则仍保留，保存才生效。', confirmLabel: '恢复草稿' }) || !rulesOwnerMatches(modal)) return;
            for (const old of snapshot.rules) {
                const current = modal._draft.find(rule => rule.id === old.id);
                if (!current) continue;
                Object.assign(current, { name: old.name, purpose: old.purpose, body: old.body, order: old.order, deletedAt: old.deletedAt, enabled: false });
                modal._restored.add(current.id);
            }
        }
        renderRulesEditor(modal);
        if (action === 'new' || action === 'copy') modal.querySelector('[data-rule-field="name"]')?.focus();
    }

    function closePromptModal() {
        document.querySelector('[data-prompt-modal]')?.remove();
        document.body.classList.remove('prompt-modal-open');
    }

    async function openPromptModal(nodeEl) {
        const node = engine.nodes.get(nodeEl?.dataset.nodeId);
        if (node?.type === 'video'
            && canvasRuntime.selectedVideoCardId
            && !canvasRuntime.videoCardBranches.has(canvasRuntime.selectedVideoCardId)) {
            try {
                await loadVideoCardWorkspace(canvasRuntime.selectedVideoCardId);
            } catch (error) {
                showCanvasNotice(error?.message || '\u65b9\u5411\u5217\u8868\u8bfb\u53d6\u5931\u8d25\uff0c\u4ecd\u53ef\u7f16\u8f91\u63d0\u793a\u8bcd\u3002', 'warn');
            }
        }
        const ctx = promptContextFor(nodeEl);
        if (!ctx) return;
        closePromptModal();
        document.body.insertAdjacentHTML('beforeend', buildPromptModal(ctx));
        document.body.classList.add('prompt-modal-open');
        const textarea = document.querySelector('[data-prompt-modal-textarea]');
        textarea?.focus();
        textarea?.setSelectionRange?.(textarea.value.length, textarea.value.length);
    }

    function syncPromptTabToNode(modal, nodeEl, node) {
        const label = modal.querySelector('.prompt-modal-tab.active')?.dataset.promptTab || '';
        if (node.type === 'video' && label) {
            nodeEl.querySelectorAll('.video-props-tab').forEach(tab => {
                tab.classList.toggle('active', tab.textContent.trim() === label);
            });
            node.data.mode = generationModeMap[label] || node.data.mode || 'text-to-video';
        }
        if (node.type === 'image' && label) {
            node.data.mode = imageModeMap[label] || node.data.mode || 'text-to-image';
            syncImageModeButtons(nodeEl, node.data.mode);
        }
    }

    function savePromptModal(modal) {
        const nodeId = modal.dataset.nodeId;
        const nodeEl = document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
        const node = engine.nodes.get(nodeId);
        if (!nodeEl || !node) return null;

        const prompt = modal.querySelector('[data-prompt-modal-textarea]')?.value || '';
        const input = promptInputFor(nodeEl, node.type);
        if (input) {
            if ('value' in input) input.value = prompt;
            else input.textContent = prompt;
        }

        node.data = {
            ...node.data,
            prompt,
            description: node.data?.source === 'director' ? prompt : node.data?.description
        };
        if (node.type === 'video') {
            const branchSelect = modal.querySelector('[data-video-branch-prompt-select]');
            if (branchSelect && !branchSelect.disabled) selectVideoBranch(branchSelect.value);
            node.data = {
                ...node.data,
                videoCardId: canvasRuntime.selectedVideoCardId,
                videoBranchId: canvasRuntime.selectedVideoBranchId
            };
        }
        syncPromptTabToNode(modal, nodeEl, node);

        const generatedText = nodeEl.querySelector('.generated-reference-card p');
        if (generatedText && prompt) generatedText.textContent = prompt;
        scheduleCanvasSave('prompt_modal_save');
        return nodeEl;
    }

    document.addEventListener('click', async (e) => {
        const contextRulesButton = e.target.closest('[data-context-rules-open]');
        if (contextRulesButton) {
            const nodeEl = contextRulesButton.closest('.canvas-node');
            if (nodeEl) {
                e.preventDefault();
                e.stopPropagation();
                openContextRulesModal(nodeEl);
                return;
            }
        }

        const contextRulesModal = e.target.closest('[data-context-rules-modal]');
        if (contextRulesModal) {
            e.stopPropagation();
            if (contextRulesModal._saving || contextRulesModal._closing) return;
            if (!e.target.closest('.rules-menu')) contextRulesModal.querySelectorAll('.rules-menu[open]').forEach(menu => { menu.open = false; });
            if (e.target === contextRulesModal) { closeContextRulesModal(); return; }
            const tab = e.target.closest('[data-rules-tab]');
            if (tab) {
                await switchRulesScope(contextRulesModal, tab.dataset.rulesTab);
                return;
            }
            const switchButton = e.target.closest('[data-rules-switch]');
            if (switchButton) {
                const choice = switchButton.dataset.rulesSwitch;
                if (choice === 'save' && !await saveContextRulesModal(contextRulesModal, false)) return;
                if (choice === 'discard') {
                    if (contextRulesModal._scope === 'node' && contextRulesModal._node._pendingTextRules) {
                        rulesStatus(contextRulesModal, '上次保存结果尚未确认，请先重试保存；不会覆盖未知结果。'); return;
                    }
                    if (contextRulesModal._scope === 'node') { contextRulesModal._nodeDraft = contextRulesModal._nodeInitial; contextRulesModal._purpose = contextRulesModal._purposeInitial; }
                    else { contextRulesModal._draft = ruleCopy(contextRulesModal._settings.rules); contextRulesModal._mergeLegacy = false; contextRulesModal._incoming = null; contextRulesModal._restored.clear(); }
                }
                if (choice !== 'stay') contextRulesModal._scope = contextRulesModal._pendingScope;
                contextRulesModal.querySelector('[data-rules-switch-guard]').hidden = true;
                renderRulesEditor(contextRulesModal); return;
            }
            const item = e.target.closest('[data-rule-id]');
            if (item) { contextRulesModal._selected = item.dataset.ruleId; renderRulesEditor(contextRulesModal); return; }
            const action = e.target.closest('[data-rule-action]');
            if (action) { await rulesAction(contextRulesModal, action.dataset.ruleAction); return; }
            if (e.target.closest('[data-rules-reload]')) { await readRulesLibrary(contextRulesModal); return; }
            if (e.target.closest('[data-rules-legacy-merge]')) { await rulesAction(contextRulesModal, 'legacy'); return; }
            const resolve = e.target.closest('[data-rules-resolve]');
            if (resolve) {
                const conflict = contextRulesModal._conflicts.find(item => item.id === resolve.dataset.rulesResolve);
                if (!conflict) return;
                const chosen = resolve.dataset.choice === 'mine' ? conflict.mine : conflict.theirs;
                contextRulesModal._rebase = contextRulesModal._rebase.filter(item => item.id !== conflict.id);
                if (chosen) {
                    const restoring = conflict.theirs?.deletedAt && !chosen.deletedAt;
                    contextRulesModal._rebase.push({ ...chosen, enabled: restoring ? false : chosen.enabled, revision: conflict.theirs?.revision || 0 });
                    if (restoring) contextRulesModal._restored.add(chosen.id);
                }
                contextRulesModal._conflicts = contextRulesModal._conflicts.filter(item => item !== conflict);
                renderRulesConflicts(contextRulesModal); return;
            }
            if (e.target.closest('[data-rules-rebase]')) {
                if (contextRulesModal._conflicts.length) return;
                contextRulesModal._draft = contextRulesModal._rebase;
                contextRulesModal._settings = contextRulesModal._incoming;
                contextRulesModal._incoming = null; contextRulesModal._mergeLegacy = false;
                renderRulesEditor(contextRulesModal); return;
            }
            if (e.target.closest('[data-context-rules-close], [data-context-rules-cancel]')) {
                closeContextRulesModal();
                return;
            }
            if (e.target.closest('[data-context-rules-save]')) {
                await saveContextRulesModal(contextRulesModal);
                return;
            }
        }

        const promptExpand = e.target.closest('[data-prompt-expand], .prompt-card-expand');
        if (promptExpand) {
            const nodeEl = promptExpand.closest('.canvas-node');
            if (nodeEl && promptContextFor(nodeEl)) {
                e.preventDefault();
                e.stopPropagation();
                await openPromptModal(nodeEl);
                return;
            }
        }

        const modal = e.target.closest('[data-prompt-modal]');
        if (!modal) return;

        if (e.target.closest('[data-prompt-close], [data-prompt-cancel]')) {
            closePromptModal();
            return;
        }

        const tab = e.target.closest('.prompt-modal-tab');
        if (tab) {
            modal.querySelectorAll('.prompt-modal-tab').forEach(item => item.classList.remove('active'));
            tab.classList.add('active');
            return;
        }

        if (e.target.closest('[data-prompt-save]')) {
            savePromptModal(modal);
            closePromptModal();
            return;
        }

        const generateButton = e.target.closest('[data-prompt-generate]');
        if (generateButton) {
            const nodeEl = savePromptModal(modal);
            if (!nodeEl) return;
            await submitNodeGeneration(nodeEl, generateButton);
            closePromptModal();
        }
    });

    // =====================
    // Left Toolbar
    // =====================
    const toolbarBtns = document.querySelectorAll('.toolbar-btn[data-panel]');
    const sidePanels = document.querySelectorAll('.side-panel');
    let activePanel = null;

    function showPanel(panelId, roleOptions) {
        sidePanels.forEach(p => p.classList.remove('active'));
        toolbarBtns.forEach(b => b.classList.remove('active'));

        if (panelId && panelId !== activePanel) {
            const panel = document.getElementById(panelId);
            if (panel) {
                panel.classList.add('active');
                const btn = document.querySelector(`[data-panel="${panelId}"]`);
                if (btn) btn.classList.add('active');
                activePanel = panelId;
            }
        } else {
            activePanel = null;
        }
        if (activePanel === 'roles-panel') void roleCreator?.openLibrary(roleOptions || {});
    }

    toolbarBtns.forEach(btn => {
        btn.addEventListener('click', () => showPanel(btn.dataset.panel));
    });

    document.querySelectorAll('.panel-close').forEach(btn => {
        btn.addEventListener('click', () => showPanel(null));
    });

    function roleContext() {
        const userId = canvasRuntime.bootstrap?.user?.id || null;
        return { userId, projectId: canvasRuntime.selectedProjectId, documentId: canvasRuntime.documentId,
            documentRevision: canvasRuntime.documentRevision, contextEpoch: canvasRuntime.contextEpoch,
            writable: canvasRuntime.documentWritable && !canvasRuntime.contextSwitching && !canvasRuntime.documentOperation,
            textModels: (canvasRuntime.bootstrap?.capabilities?.text?.model_options || []).map(m => ({ ...m, id: m.value })),
            scopeKey: `sd2:roles:${userId || 'none'}:${canvasRuntime.selectedProjectId || 'none'}:${canvasRuntime.documentId || 'none'}` };
    }
    const roleJoinMemory = new Map();
    function roleJoinKey(ctx = roleContext()) {
        return ctx.userId && ctx.documentId ? `${ctx.scopeKey}:join-pending` : null;
    }
    function roleJoinPending(ctx = roleContext()) {
        const key = roleJoinKey(ctx);
        if (!key) return null;
        // Called during initial toolbar setup before the bridge Map is initialized.
        let memory;
        try { memory = roleJoinMemory.get(key); } catch { return null; }
        if (memory) return memory;
        try {
            const saved = JSON.parse(localStorage.getItem(key) || 'null');
            if (saved?.document_id === ctx.documentId && typeof saved.mutation_id === 'string'
                && typeof saved.definition_id === 'string' && Number.isInteger(saved.version) && Number.isInteger(saved.document_revision)) {
                roleJoinMemory.set(key, saved); return saved;
            }
        } catch { /* Memory still protects a request if local storage is unavailable. */ }
        return null;
    }
    function retainRoleJoin(ctx, payload) {
        const key = roleJoinKey(ctx);
        roleJoinMemory.set(key, payload);
        try { localStorage.setItem(key, JSON.stringify(payload)); }
        catch { showCanvasNotice('加入请求只保留在当前页，请保持页面打开并核对原回执。', 'warn'); }
    }
    function clearRoleJoin(ctx) {
        const key = roleJoinKey(ctx);
        roleJoinMemory.delete(key);
        try { localStorage.removeItem(key); } catch {}
    }
    function roleTime(value) {
        const wrapper = document.createElement('span');
        wrapper.innerHTML = rulesTime(value);
        const time = wrapper.querySelector('time');
        if (time?.textContent === '0分钟前') time.textContent = '刚刚';
        return wrapper.innerHTML;
    }
    const roleBridge = {
        engine, libraryRoot: document.getElementById('roles-panel-body'), workRoot: document.getElementById('role-work-panel'),
        formatUsdMicros: value => {
            const rate = canvasRuntime.bootstrap?.money_display?.usd_to_cny_rate;
            if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0
                || typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return '金额待核对';
            const converted = value * rate / 1000000;
            if (!Number.isFinite(converted)) return '金额待核对';
            return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY',
                minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(converted).replace('￥', '¥');
        },
        usdToCnyRateText: () => canvasRuntime.bootstrap?.money_display?.rate_text || '人民币换算汇率未确认',
        context: roleContext, icon: name => window.UltimateCanvasIcons(name)
            || window.UltimateCanvasIcons(String(name || '').split('-').map(part => part ? part[0].toUpperCase() + part.slice(1) : '').join(''))
            || window.UltimateCanvasIcons('CircleHelp'),
        escape: escapeHtml, renderTime: roleTime, dialog: openCanvasProductDialog,
        confirm: options => requestCanvasConfirmation({ ...options, confirmLabel: options.confirmText || options.confirmLabel }),
        notice: showCanvasNotice,
        request: async (url, options) => {
            try { return await requestJson(url, options); }
            catch (error) { error.data = error.response; throw error; }
        },
        saveDocument: async reason => {
            const before = roleContext();
            if (!before.writable || !before.documentId || !await flushCanvasSave(reason || 'role_operation')) throw new Error('请先创建并保存可编辑画布，角色库内容仍保留。');
            const after = roleContext();
            if (before.contextEpoch !== after.contextEpoch || before.documentId !== after.documentId) throw new Error('画布目标已变化，未继续角色操作');
            return after;
        },
        listRoleNodes: () => [...engine.nodes.values()].filter(n => n.type === 'role')
            .map(n => ({ id: n.id, title: n.data?.title, roleConfig: structuredClone(n.data?.roleConfig || {}) })),
        listMaterialNodes: () => [...engine.nodes.values()].filter(n => n.type !== 'role' && !n.type.startsWith('flow-'))
            .map(n => ({ id: n.id, title: n.data?.title || n.type, type: n.type })),
        openCreator: options => roleCreator?.openCreator(options),
        openLibrary: async options => {
            if (await roleWorkflow?.close() === false) return false;
            if (activePanel === 'roles-panel') await roleCreator?.openLibrary(options || {});
            else showPanel('roles-panel', options);
            return true;
        },
        closeLibrary: () => showPanel(null),
        onSaved: () => { void roleWorkflow?.refresh(); },
        onBillingSettled: () => {
            const userId = roleContext().userId;
            if (userId) window.parent.postMessage({ type: 'sd2-canvas-billing-settled', userId }, location.origin);
        },
        joinRole: async options => {
            let ctx = roleContext(), payload = roleJoinPending(ctx);
            if (payload && (payload.mutation_id !== options.mutationId || payload.definition_id !== options.definitionId || payload.version !== options.version)) {
                throw new Error('另一个角色加入结果尚未确认，请先恢复原加入请求。');
            }
            if (!payload) {
                if (!graphEditAllowed()) throw new Error('画布正在处理其他操作，请稍后加入；已保存的角色不会丢失。');
                ctx = await roleBridge.saveDocument('before_role_join');
                payload = { mutation_id: options.mutationId, document_id: ctx.documentId, document_revision: ctx.documentRevision,
                    definition_id: options.definitionId, version: options.version, position: options.position,
                    pending_connection: options.pendingConnection || null };
                retainRoleJoin(ctx, payload);
            }
            return withDocumentOperation(async () => {
                let result;
                try { result = await requestJson(`/api/tools/ultimate-canvas/role-receipts/${encodeURIComponent(payload.mutation_id)}`); }
                catch (error) { if (error.status !== 404) throw error; }
                if (!result) {
                    try { result = await postJson('/api/tools/ultimate-canvas/role-join', payload); }
                    catch (error) {
                        if (error.status >= 400 && error.status < 500 && error.response?.code === 'revision_conflict') clearRoleJoin(ctx);
                        throw error;
                    }
                }
                clearRoleJoin(ctx);
                if (ctx.contextEpoch !== canvasRuntime.contextEpoch || ctx.documentId !== canvasRuntime.documentId) throw new Error('角色已保存到原画布，当前目标已变化，请打开原画布核对加入回执。');
                if (canvasRuntime.documentRevision !== payload.document_revision
                    && !(canvasRuntime.documentRevision === result.document.revision && engine.nodes.has(result.nodeId))) {
                    throw new Error('加入已确认，但画布已继续更新；请重读该画布核对，不会重新插入旧节点。');
                }
                // Integrate only the confirmed node; existing video elements/tasks remain untouched.
                canvasRuntime.documentRestoring = true;
                try {
                    if (!engine.nodes.has(result.nodeId)) {
                        const token = graphCommands.begin('role_join');
                        engine.addNode('role', result.node.x, result.node.y, { ...result.node.data, id: result.nodeId });
                        if (payload.pending_connection) connectMenuNode(result.nodeId, payload.pending_connection);
                        graphCommands.commit(token);
                    }
                } finally { canvasRuntime.documentRestoring = false; }
                canvasRuntime.documentRevision = result.document.revision;
                canvasRuntime.documentSchemaVersion = 3;
                canvasRuntime.documentDirty = false; canvasRuntime.saveState = 'saved';
                const draftKey = draftStorageKey();
                try { if (draftKey) localStorage.removeItem(draftKey); } catch {}
                engine.selectNode(result.nodeId); updateSaveIndicator();
                return { nodeId: result.nodeId, documentId: ctx.documentId };
            });
        }
    };
    roleCreator = window.UltimateCanvasRoleCreator?.create(roleBridge);
    roleWorkflow = window.UltimateCanvasRoleWorkflow?.create(roleBridge);
    document.getElementById('tool-role-pending')?.addEventListener('click', async () => {
        if (await roleWorkflow?.openPending()) showPanel(null);
    });
    document.addEventListener('click', event => {
        const settings = event.target.closest('[data-role-instance-settings]');
        if (settings) {
            event.preventDefault(); event.stopPropagation();
            void openRoleInstanceSettings(settings.dataset.roleInstanceSettings);
            return;
        }
        const button = event.target.closest('[data-role-open]');
        if (!button) return;
        event.preventDefault(); event.stopPropagation();
        void roleWorkflow?.open(button.dataset.roleOpen);
    });
    let roleCardGesture = null;
    document.addEventListener('pointerdown', event => {
        const card = event.target.closest('.node-type-role');
        roleCardGesture = card && event.button === 0 && !event.target.closest('button,input,textarea,a,.node-port')
            ? { id: card.dataset.nodeId, x: event.clientX, y: event.clientY, pointerId: event.pointerId } : null;
    });
    document.addEventListener('pointerup', event => {
        const gesture = roleCardGesture; roleCardGesture = null;
        if (gesture && gesture.pointerId === event.pointerId && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 6
            && event.target.closest('.node-type-role')?.dataset.nodeId === gesture.id) void roleWorkflow?.open(gesture.id);
    });
    document.addEventListener('pointercancel', () => { roleCardGesture = null; });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.target.closest('button,input,textarea,a,[contenteditable="true"],dialog')) return;
        const card = event.target.closest('.node-type-role');
        if (card) { event.preventDefault(); void roleWorkflow?.open(card.dataset.nodeId); }
    });

    async function openRoleInstanceSettings(nodeId) {
        if (roleInstanceLayer) return;
        const node = engine.nodes.get(nodeId), ctx = roleContext();
        if (node?.type !== 'role' || !ctx.writable) return showCanvasNotice('当前角色只可查看。', 'warn');
        const original = structuredClone(node.data.roleConfig), heading = `role-instance-${crypto.randomUUID()}`;
        let definition;
        try { definition = await roleBridge.request(`/api/tools/ultimate-canvas/roles/${encodeURIComponent(original.definitionId)}`); }
        catch (error) { return showCanvasNotice(error.message, 'warn'); }
        if (ctx.contextEpoch !== roleContext().contextEpoch || engine.nodes.get(nodeId) !== node || roleInstanceLayer) return;
        let selected = original, busy = false, readOrder = 0, changedLocally = false;
        const current = () => ctx.contextEpoch === roleContext().contextEpoch && ctx.documentId === roleContext().documentId
            && engine.nodes.get(nodeId) === node && JSON.stringify(node.data.roleConfig) === JSON.stringify(original);
        const finish = () => { layer.close(); if (roleInstanceLayer === state) roleInstanceLayer = null; updateSaveIndicator(); };
        const dismiss = async () => {
            if (busy) return;
            if (state.dirty && !await roleBridge.confirm({ title: '放弃更改？', message: '当前实例版本选择尚未保存。', confirmText: '放弃更改' })) return;
            finish();
        };
        const layer = openCanvasProductDialog({ className: 'canvas-confirm-dialog', labelledBy: heading, onDismiss: dismiss,
            content: `<div class="canvas-confirm-head"><strong id="${heading}">角色实例</strong>
                <button type="button" class="context-command" data-instance-close aria-label="关闭">${roleBridge.icon('X')}</button></div>
                <p>${escapeHtml(original.snapshot?.name || node.data.title)} · 当前版本 ${original.version}</p>
                <label>角色版本 <input class="canvas-name-input" type="number" min="1" max="${Number(definition.role.current_version)}" step="1" value="${original.version}" data-instance-version></label>
                <p data-instance-preview></p><p role="status" data-instance-status></p>
                <div class="canvas-confirm-actions"><button type="button" class="context-command" data-instance-executor>更换执行者</button>
                <button type="button" class="context-command danger" data-instance-remove>移除角色</button>
                <button type="button" class="context-primary-command" data-instance-save disabled>保存实例</button></div>` });
        const state = { close: finish, dirty: false }; roleInstanceLayer = state;
        const input = layer.dialog.querySelector('[data-instance-version]'), save = layer.dialog.querySelector('[data-instance-save]');
        const status = layer.dialog.querySelector('[data-instance-status]'), preview = layer.dialog.querySelector('[data-instance-preview]');
        const render = () => {
            const executor = selected.snapshot?.executor;
            preview.textContent = `版本 ${selected.version} · ${executor?.kind === 'ai' ? 'AI · ' + executor.model : executor?.kind === 'person' ? '人员' : '稍后指定'}`;
            save.disabled = busy || !state.dirty || !selected || !current(); updateSaveIndicator();
        };
        render();
        input.addEventListener('input', () => { state.dirty = input.value !== String(original.version); selected = null; save.disabled = true; updateSaveIndicator(); });
        input.addEventListener('change', async () => {
            const version = Number(input.value), order = ++readOrder;
            if (!Number.isInteger(version) || version < 1 || version > definition.role.current_version) { status.textContent = '请选择已经保存的有效版本。'; return; }
            try {
                const result = await roleBridge.request(`/api/tools/ultimate-canvas/roles/${encodeURIComponent(original.definitionId)}?version=${version}`);
                if (roleInstanceLayer !== state || !current() || order !== readOrder) return;
                selected = { definitionId: original.definitionId, version: result.version.version, snapshot: result.version.snapshot };
                status.textContent = ''; render();
            } catch (error) { if (roleInstanceLayer === state && order === readOrder) status.textContent = error.message; }
        });
        layer.dialog.addEventListener('click', async event => {
            const button = event.target.closest('button');
            if (!button || busy) return;
            if (button.hasAttribute('data-instance-close')) return void dismiss();
            if (changedLocally) {
                if (!button.hasAttribute('data-instance-save')) return;
                if (ctx.contextEpoch !== roleContext().contextEpoch || ctx.documentId !== roleContext().documentId) return;
                busy = true; save.disabled = true;
                try {
                    if (!await flushCanvasSave('role_instance_recovery')) throw new Error('保存尚未确认，请保留当前页并处理画布保存提示。');
                    state.dirty = false; finish(); void roleWorkflow?.refresh();
                } catch (error) { if (roleInstanceLayer === state) status.textContent = error.message; }
                finally { busy = false; if (roleInstanceLayer === state) save.disabled = false; }
                return;
            }
            if (button.hasAttribute('data-instance-executor')) {
                if (state.dirty && !await roleBridge.confirm({ title: '放弃选择？', message: '先编辑角色库的新版本，当前实例不会自动升级。', confirmText: '继续编辑' })) return;
                finish();
                showCanvasNotice(`编辑库中当前版本 v${definition.role.current_version}，保存后再显式切换实例；旧任务不会自动切换。`);
                return void roleCreator?.openCreator({ roleId: original.definitionId, version: definition.role.current_version, mode: 'edit' });
            }
            const remove = button.hasAttribute('data-instance-remove');
            if (!remove && !button.hasAttribute('data-instance-save')) return;
            if (!current() || !graphEditAllowed() || (!remove && !selected)) { status.textContent = '画布或角色已变化，请关闭后重新读取。'; return; }
            if (!await roleBridge.confirm({ title: remove ? '移除角色？' : '切换版本？', confirmText: remove ? '移除角色' : '切换版本',
                message: remove ? '只移除画布实例，角色库、任务和费用历史保留。在途调用不会被取消。' : '原任务按旧版本保留，后续操作将停止，需要明确修改任务要求后继续。在途调用不会被取消。' })) return;
            if (!current() || !graphEditAllowed()) return;
            busy = true; save.disabled = true; status.textContent = '正在保存…';
            try {
                await roleBridge.saveDocument('before_role_instance_change');
                if (!current()) throw new Error('画布目标已变化，未更改实例。');
                await withDocumentOperation(async () => {
                    const token = graphCommands.begin(remove ? 'role_remove' : 'role_version');
                    if (remove) engine.deleteNode(nodeId);
                    else {
                        node.data.roleConfig = structuredClone(selected); node.data.title = selected.snapshot.name;
                        const element = document.querySelector(`.node-type-role[data-node-id="${CSS.escape(nodeId)}"]`);
                        const replacement = engine._buildNode(node); engine.nodeResizeObserver?.unobserve(element);
                        element?.replaceWith(replacement); engine.nodeResizeObserver?.observe(replacement);
                        engine.selectNode(nodeId); engine._updateConnections();
                    }
                    graphCommands.commit(token);
                    changedLocally = true; input.disabled = true;
                    scheduleCanvasSave('role_instance_change');
                    if (!await flushCanvasSave('role_instance_change', true)) throw new Error('实例更改尚未保存，请先处理画布保存状态。');
                });
                if (roleInstanceLayer !== state) return;
                state.dirty = false; finish(); void roleWorkflow?.refresh();
            } catch (error) { if (roleInstanceLayer === state) status.textContent = error.message; }
            finally {
                busy = false;
                if (roleInstanceLayer === state) {
                    if (changedLocally) { state.dirty = true; save.textContent = '重试画布保存'; }
                    save.disabled = changedLocally ? false : !state.dirty || !current();
                }
            }
        });
    }

    function connectMenuNode(newNodeId, pendingConnection) {
        if (!newNodeId || !pendingConnection?.nodeId) return;
        if (pendingConnection.role === 'input') {
            engine._createConnection(newNodeId, pendingConnection.nodeId);
        } else {
            engine._createConnection(pendingConnection.nodeId, newNodeId);
        }
    }

    engine.onAddMenuOpening = menu => {
        const connection = menu._pendingConnection;
        const owner = connection && engine.nodes.get(connection.nodeId);
        const incoming = connection?.role === 'input';
        const capabilities = canvasRuntime.bootstrap?.capabilities || {};
        const icon = window.UltimateCanvasIcons;
        const rows = [
            ['text', '文本', 'Text'], ['image', '图片', 'ImagePlus'], ['video', '视频', 'Video'],
            ['video-compose', '智能剪辑', 'Scissors'], ['director', '导演台', 'Clapperboard'],
            ['frame-analysis', '逐帧拉片', 'Film'], ['audio', '音频', 'AudioLines'], ['script', '脚本', 'ScrollText']
        ];
        function unavailable(type) {
            if (type === 'frame-analysis') return '逐帧拉片尚未接入';
            if (type === 'video-compose') return '智能剪辑尚未接入';
            if (connection && owner?.type.startsWith('flow-')) return '工具流节点只能连接工具流';
            if (connection && ['video-compose', 'audio'].includes(type)) return '当前尚无对应生成接口，可从素材库添加已有素材';
            if (connection && type === 'director') return '导演台请从画布加号独立添加';
            if (incoming && ['image', 'video'].includes(owner?.type) && !['image', 'text', 'script'].includes(type)) return '此节点目前仅接收图片或文字上下文';
            if (connection && !incoming && ['image', 'video'].includes(type) && !['image', 'text', 'script', 'director'].includes(owner?.type)) return '当前输出不能作为该节点的参考';
            if (!incoming && ['image', 'video', 'text', 'script'].includes(type)) {
                const capability = capabilities[type === 'script' ? 'text' : type];
                if (!capability?.enabled) return capability?.message || '当前生成能力不可用';
            }
            return '';
        }
        const buttons = rows.map(([type, label, glyph]) => {
            const reason = unavailable(type);
            return `<button type="button" role="menuitem" class="menu-item" data-node-type="${type}" ${reason ? `disabled title="${escapeHtml(reason)}"` : ''}>${icon(glyph)}<span>${label}</span></button>`;
        }).join('');
        const canReference = incoming && ['image', 'video'].includes(owner?.type);
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', connection ? incoming ? '添加上下文' : '引用该节点生成' : '添加节点');
        menu.innerHTML = `<div class="menu-section-title">${menu.getAttribute('aria-label')}</div>${buttons}
            ${!owner?.type.startsWith('flow-') ? `<button type="button" role="menuitem" class="menu-item" data-action="add-role">${icon('Users')}<span>角色</span></button>` : ''}
            ${connection ? `<button type="button" role="menuitem" class="menu-item" data-action="reference-node" ${canReference ? '' : 'disabled title="请从接收图片的节点左侧选择已有参考"'}>${icon('Link')}<span>参考节点</span></button>` : ''}
            ${!connection || owner?.type.startsWith('flow-') ? `<details><summary>工具流节点</summary>${[['flow-input', '输入'], ['flow-template', '图片模板'], ['flow-select', '结果筛选'], ['flow-confirm', '人工确认'], ['flow-output', '输出']].map(([type, label]) => `<button type="button" role="menuitem" class="menu-item" data-node-type="${type}">${icon('Layers')}<span>${label}</span></button>`).join('')}</details>` : ''}
            ${!connection || incoming ? `<div class="menu-divider"></div><button type="button" class="menu-item" role="menuitem" data-action="upload">${icon('Upload')}<span>上传素材</span></button>` : ''}
            ${!connection ? `<button type="button" class="menu-item" role="menuitem" data-action="from-history">${icon('History')}<span>生成历史</span></button>` : ''}`;
    };

    let addMenuOutsidePointer = null;
    document.addEventListener('pointerdown', event => {
        const menu = document.getElementById('add-node-menu');
        addMenuOutsidePointer = menu && !menu.classList.contains('hidden') && !menu.contains(event.target)
            && !event.target.closest('.node-connector') ? { x: event.clientX, y: event.clientY, id: event.pointerId } : null;
    });
    document.addEventListener('pointerup', event => {
        const start = addMenuOutsidePointer;
        addMenuOutsidePointer = null;
        const menu = document.getElementById('add-node-menu');
        if (start && start.id === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6
            && menu && !menu.contains(event.target) && !event.target.closest('.node-connector')) engine._hideAddMenu();
    });
    document.getElementById('add-node-menu')?.addEventListener('keydown', event => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        const options = [...event.currentTarget.querySelectorAll('button:not(:disabled)')].filter(item => item.getClientRects().length);
        const current = options.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        event.preventDefault();
        options[next]?.focus();
    });

    // =====================
    // Floating Add-Node Menu (from toolbar "+" or double-click)
    // =====================
    document.getElementById('tool-add')?.addEventListener('click', (e) => {
        const rect = e.target.closest('.toolbar-btn').getBoundingClientRect();
        engine._showAddMenu(rect.right + 8, rect.top);
        const menu = document.getElementById('add-node-menu');
        const container = document.getElementById('canvas-container');
        const cr = container.getBoundingClientRect();
        menu._canvasX = (cr.width / 2 - engine.offsetX) / engine.scale;
        menu._canvasY = (cr.height / 2 - engine.offsetY) / engine.scale;
    });

    document.querySelectorAll('[data-coming-soon]').forEach(el => {
        const handler = (event) => {
            event.preventDefault();
            event.stopPropagation();
            showCanvasNotice(el.dataset.comingSoon || '这个入口还没有接入后台。', 'warn');
        };
        el.addEventListener('click', handler);
        el.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            handler(event);
        });
    });

    document.getElementById('tool-help')?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const message = event.currentTarget.dataset.helpTip || '帮助入口已收到点击。';
        showCanvasNotice(message, 'info');
    });

    // Menu item clicks
    document.getElementById('add-node-menu')?.addEventListener('click', (e) => {
        const item = e.target.closest('.menu-item');
        if (!item || item.disabled) return;

        const type = item.dataset.nodeType;
        const action = item.dataset.action;
        const menu = document.getElementById('add-node-menu');
        const cx = menu._canvasX ?? 400;
        const cy = menu._canvasY ?? 300;
        const pendingConnection = menu._pendingConnection ? { ...menu._pendingConnection } : null;

        if (type) {
            const placement = {
                director: { x: 311, y: 420 },
                video: { x: 311, y: 175 },
                image: { x: 311, y: 175 },
                text: { x: 175, y: 175 },
                script: { x: 175, y: 120 },
                audio: { x: 175, y: 80 },
                'video-compose': { x: 175, y: 120 }
            }[type] || { x: 100, y: 60 };
            const source = pendingConnection && engine.nodes.get(pendingConnection.nodeId);
            const sourceEl = source && document.querySelector(`[data-node-id="${CSS.escape(source.id)}"] .node-card`);
            const x = source ? pendingConnection.role === 'input' ? source.x - placement.x * 2 - 120
                : source.x + (sourceEl?.offsetWidth || 624) + 120 : cx - placement.x;
            const y = source ? source.y : cy - placement.y;
            const newNodeId = engine.addNode(type, x, y);
            connectMenuNode(newNodeId, pendingConnection);
        } else if (action === 'add-role') {
            engine._hideAddMenu();
            void roleBridge.openLibrary({ position: { x: cx - 160, y: cy - 80 }, pendingConnection });
            return;
        } else if (action === 'reference-node') {
            engine._hideAddMenu();
            if (pendingConnection?.role === 'input') startReferenceSelection(pendingConnection.nodeId);
            return;
        } else if (action === 'upload') {
            triggerUpload(cx, cy, pendingConnection);
        } else if (action === 'from-history') {
            showPanel('history-panel');
            loadLibraryPanels(true);
        }

        engine._hideAddMenu();
    });

    function triggerUpload(cx, cy, pendingConnection = null) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*,video/*,audio/*';
        input.multiple = true;
        input.onchange = async (e) => {
            queueCanvasFiles(e.target.files, cx, cy, pendingConnection);
        };
        input.click();
    }
    ['dragover', 'drop'].forEach(type => window.addEventListener(type, event => {
        if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (type === 'dragover') { event.dataTransfer.dropEffect = canvasRuntime.documentWritable ? 'copy' : 'none'; return; }
        if (!event.target.closest?.('#canvas-workspace')) { showCanvasNotice('请把文件拖到画布中；不导入文件夹或外链。', 'warn'); return; }
        if (!event.dataTransfer.files.length) { showCanvasNotice('这里只接受实际文件，不导入文件夹或外链。', 'warn'); return; }
        if (!graphEditAllowed()) { showCanvasNotice('当前画布不可编辑，未上传文件。', 'warn'); return; }
        const point = canvasFilePosition(event.clientX, event.clientY);
        const referenceZone = event.target.closest?.('[data-generation-reference-list],.generation-reference-zone');
        const target = referenceZone?.closest('[data-node-id]')?.dataset.nodeId;
        queueCanvasFiles(event.dataTransfer.files, point.x, point.y, target ? { nodeId: target, role: 'input' } : null);
    }, true));
    document.addEventListener('paste', event => {
        if (event.target.closest?.('input,textarea,[contenteditable="true"]')) return;
        const files = Array.from(event.clipboardData?.items || []).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
        if (!files.length) return;
        event.preventDefault();
        const rect = document.getElementById('canvas-container').getBoundingClientRect();
        const point = canvasFilePosition(rect.left + rect.width / 2, rect.top + rect.height / 2);
        queueCanvasFiles(files, point.x, point.y);
    });

    // =====================
    // Quick Start Cards
    // =====================
    document.querySelectorAll('.quick-card').forEach(card => {
        card.addEventListener('click', () => {
            const type = card.dataset.type;
            const container = document.getElementById('canvas-container');
            const rect = container.getBoundingClientRect();
            const cx = (rect.width / 2 - engine.offsetX) / engine.scale;
            const cy = (rect.height / 2 - engine.offsetY) / engine.scale;

            switch (type) {
                case 'script-gen': {
                    const storyId = engine.addNode('script', cx - 100, cy - 80);
                    void openStoryStudio(storyId);
                    break;
                }
                case 'character': engine.addNode('image', cx - 100, cy - 80); break;
                case 'auto-video':
                    const tid = engine.addNode('text', cx - 360, cy - 60);
                    const vid = engine.addNode('video', cx + 120, cy - 60);
                    engine._createConnection(tid, vid);
                    break;
                case 'music':
                    engine.addNode('audio', cx - 100, cy - 40);
                    showCanvasNotice('已添加音频素材节点。音频生成服务尚未接通。', 'info');
                    break;
            }
        });
    });

    // =====================
    // Node Actions (inside text/image nodes)
    // =====================
    document.addEventListener('input', event => {
        const modal = event.target.closest('[data-context-rules-modal]');
        if (!modal || modal._saving || !rulesOwnerMatches(modal)) return;
        if (event.target.matches('[data-context-rules-textarea]')) modal._nodeDraft = event.target.value;
        if (event.target.matches('[data-rules-node-purpose]')) modal._purpose = event.target.value;
        if (event.target.matches('[data-rule-field]') && !modal._incoming) {
            const rule = modal._draft.find(item => item.id === modal._selected);
            if (rule && !rule.deletedAt) {
                const field = event.target.dataset.ruleField;
                rule[field] = field === 'enabled' ? event.target.checked : event.target.value;
                renderRuleList(modal);
            }
        }
        if (event.target.matches('[data-rules-search]')) { modal._search = event.target.value; renderRuleList(modal); }
        rulesStatus(modal); rulesPreview(modal);
    });
    document.addEventListener('change', event => {
        const modal = event.target.closest('[data-context-rules-modal]');
        if (modal && !modal._saving && event.target.matches('[data-rules-deleted]')) {
            modal._showDeleted = event.target.checked; renderRulesEditor(modal);
        }
    });
    document.addEventListener('click', event => {
        const trigger = event.target.closest('[data-rules-time]');
        const bubble = document.querySelector('[data-rules-time-bubble]');
        if (trigger) {
            event.stopPropagation();
            if (bubble?._trigger === trigger && bubble.dataset.pinned === 'true') rulesTimeClose();
            else rulesTimeOpen(trigger, true);
        } else if (!event.target.closest('[data-rules-time-bubble]')) rulesTimeClose();
    });
    document.addEventListener('mouseover', event => {
        const trigger = event.target.closest('[data-rules-time]');
        if (trigger && document.querySelector('[data-rules-time-bubble]')?.dataset.pinned !== 'true') rulesTimeOpen(trigger);
    });
    document.addEventListener('focusin', event => {
        if (event.target.matches('[data-rules-time]') && document.querySelector('[data-rules-time-bubble]')?.dataset.pinned !== 'true') rulesTimeOpen(event.target);
    });
    const closeUnpinnedRuleTime = () => {
        const bubble = document.querySelector('[data-rules-time-bubble]');
        if (bubble && bubble.dataset.pinned !== 'true' && document.activeElement !== bubble._trigger && !bubble._trigger.matches(':hover')) rulesTimeClose();
    };
    document.addEventListener('mouseout', closeUnpinnedRuleTime);
    document.addEventListener('focusout', closeUnpinnedRuleTime);
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && document.querySelector('[data-rules-time-bubble]')) {
            event.preventDefault(); event.stopImmediatePropagation(); rulesTimeClose();
        }
    }, true);
    document.addEventListener('change', event => {
        const select = event.target.closest('[data-text-model]');
        if (!select) return;
        const node = engine.nodes.get(select.closest('.canvas-node')?.dataset.nodeId);
        if (!node) return;
        node.data = { ...node.data, textModel: select.value };
        scheduleCanvasSave('text_model_change');
    });
    document.addEventListener('keydown', event => {
        const modal = document.querySelector('[data-context-rules-modal]');
        if (document.querySelector('dialog[open]')) return;
        if (!modal) return;
        if (event.key === 'Escape' && modal.querySelector('.rules-menu[open]')) {
            event.preventDefault(); event.stopImmediatePropagation(); modal.querySelector('.rules-menu[open]').open = false; return;
        }
        if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeContextRulesModal(); }
        if (event.key === 'Tab') {
            const focusable = [...modal.querySelectorAll('button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), summary')].filter(el => el.getClientRects().length);
            const first = focusable[0], last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
    }, true);
    document.addEventListener('click', (e) => {
        const quick = e.target.closest('[data-text-create]');
        if (quick) {
            const sourceEl = quick.closest('.canvas-node');
            const source = engine.nodes.get(sourceEl?.dataset.nodeId);
            if (!source || source.type !== 'text') return;
            e.preventDefault();
            if (quick.dataset.textCreate === 'write') { openPromptModal(sourceEl); return; }
            const sourceText = sourceEl.querySelector('.node-text-content')?.textContent?.trim()
                || source.data?.generatedText || promptValueFor(sourceEl, source);
            if (!sourceText) { showCanvasNotice('先写入角色、场景或故事内容，再创建图片或视频。', 'warn'); openPromptModal(sourceEl); return; }
            const video = quick.dataset.textCreate === 'video';
            const purpose = quick.dataset.textCreate === 'character' ? '角色设定图' : '场景概念图';
            const prompt = video ? '根据上游文本生成视频，保留故事中的角色、场景与动作。'
                : `根据上游文本创作${purpose}，保持描述中的外观、服装、时代和视觉特征一致。`;
            const id = engine.addNode(video ? 'video' : 'image', source.x + 680, source.y, {
                title: video ? '故事视频' : purpose, prompt,
                mode: video ? 'text-to-video' : 'text-to-image', sourceNodeId: source.id
            });
            engine._createConnection(source.id, id);
            engine.selectNode(id);
            scheduleCanvasSave('text_quick_create');
            return;
        }
        const action = e.target.closest('.node-action-row');
        if (!action) return;

        const nodeId = action.dataset.nid;
        const act = action.dataset.action;
        const nd = engine.nodes.get(nodeId);
        if (!nd) return;

        const nodeEl = document.querySelector(`[data-node-id="${nodeId}"]`);
        const body = nodeEl?.querySelector('.node-body');

        switch (act) {
            case 'write':
                nd.data.authoredText = nd.data.authoredText ?? nd.data.generatedText ?? nd.data.prompt ?? '';
                renderTextNodeBody(nodeEl, nd);
                body.querySelector('.node-text-content').focus();
                break;
            case 'txt2video':
                const vId = engine.addNode('video', nd.x + 450, nd.y, {
                    mode: 'text-to-video',
                    sourceNodeId: nodeId
                });
                engine._createConnection(nodeId, vId);
                break;
            case 'img-prompt':
                const iId = engine.addNode('image', nd.x + 450, nd.y, {
                    mode: 'text-to-image',
                    sourceNodeId: nodeId
                });
                engine._createConnection(nodeId, iId);
                break;
            case 'txt2music':
                const aId = engine.addNode('audio', nd.x + 450, nd.y);
                engine._createConnection(nodeId, aId);
                showCanvasNotice('已添加音频素材节点，未发起音频生成。', 'info');
                break;
            case 'vid-keyframe': {
                const outputId = engine.addNode('video', nd.x + 450, nd.y, {
                    mode: 'first-last-frame-video',
                    sourceNodeId: nodeId
                });
                engine._createConnection(nodeId, outputId);
                break;
            }
            case 'vid-firstframe': {
                const outputId = engine.addNode('video', nd.x + 450, nd.y, {
                    mode: 'first-frame-video',
                    sourceNodeId: nodeId
                });
                engine._createConnection(nodeId, outputId);
                break;
            }
            case 'img2img':
            case 'img-hd': {
                const outputId = engine.addNode('image', nd.x + 450, nd.y, {
                    mode: act === 'img-hd' ? 'upscale-image' : 'image-to-image',
                    sourceNodeId: nodeId
                });
                engine._createConnection(nodeId, outputId);
                break;
            }
        }
    });

    // =====================
    // Director Stage Controls
    // =====================
    function directorContext(target) {
        const nodeEl = target.closest('[data-director-studio-root], .canvas-node')
            || target.closest('[data-director-props]')?.closest('[data-director-studio-root], .canvas-node');
        if (!nodeEl) return {};
        const nodeId = nodeEl.dataset.nodeId;
        return {
            nodeEl,
            nodeId,
            nd: engine.nodes.get(nodeId),
            stage: nodeEl.querySelector('[data-director-stage]'),
            props: nodeEl.querySelector('[data-director-props]')
        };
    }

    function setDirectorStatus(nodeEl, text) {
        const status = nodeEl?.querySelector('[data-director-status]');
        if (status) status.textContent = text;
    }

    function liblibDirectorData() {
        return window.LIBLIB_DIRECTOR_DATA || { models: [], posePresets: [], assetBasePath: '' };
    }

    function getDirectorModel(type) {
        const models = liblibDirectorData().models || [];
        return models.find(model => model.type === type) || models[0] || {
            type: 'male-lowpoly',
            label: '男性-低模',
            color: '#4ecdc4',
            previewHeight: 78,
            file: ''
        };
    }

    function getDirectorPose(id) {
        const poses = liblibDirectorData().posePresets || [];
        return poses.find(pose => pose.id === id) || poses[0] || {
            id: 'stand',
            label: '站立',
            icon: '站',
            jointAngles: {}
        };
    }

    function selectedDirectorActor(nodeEl) {
        return nodeEl?.querySelector('.director-actor.active') || nodeEl?.querySelector('.director-actor');
    }

    function actorAnchorCss(actor) {
        const styles = getComputedStyle(actor);
        return {
            left: styles.getPropertyValue('--actor-screen-x').trim()
                || styles.getPropertyValue('--actor-x').trim()
                || '50%',
            top: styles.getPropertyValue('--actor-screen-y').trim()
                || styles.getPropertyValue('--actor-y').trim()
                || '58%'
        };
    }

    function positionStudioGizmo(root, actor = selectedDirectorActor(root)) {
        const gizmo = root?.querySelector?.('[data-director-gizmo]');
        if (!gizmo || !actor) return;
        const anchor = actorAnchorCss(actor);
        gizmo.style.left = anchor.left;
        gizmo.style.top = anchor.top;
        gizmo.classList.add('active');
    }

    function syncDirectorSelectionControls(nodeEl, actor) {
        if (!nodeEl || !actor) return;
        nodeEl.querySelectorAll('.director-model-chip').forEach(chip => {
            chip.classList.toggle('active', chip.dataset.directorModel === actor.dataset.modelType);
        });
        nodeEl.querySelectorAll('.director-pose-chip').forEach(chip => {
            chip.classList.toggle('active', chip.dataset.directorPosePreset === actor.dataset.poseId);
        });
    }

    function applyDirectorModelToActor(nodeEl, actor, model) {
        if (!actor || !model) return;
        actor.dataset.modelType = model.type;
        actor.dataset.modelLabel = model.label;
        actor.style.setProperty('--actor-color', model.color || '#4ecdc4');
        actor.style.setProperty('--actor-h', `${model.previewHeight || 74}px`);
        const modelLabel = actor.querySelector('.actor-model-label');
        if (modelLabel) modelLabel.textContent = model.label;
        syncDirectorSelectionControls(nodeEl, actor);
        setDirectorStatus(nodeEl, `${actor.querySelector('.actor-name')?.textContent || '角色'} 使用 ${model.label}`);
    }

    function applyDirectorPoseToActor(nodeEl, actor, pose) {
        if (!actor || !pose) return;
        const j = pose.jointAngles || {};
        const num = (part, key, fallback = 0) => {
            const value = j[part]?.[key];
            return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
        };

        const bodyTilt = num('body', 'tilt') + num('torso', 'tilt') * 0.45;
        const headTurn = num('head', 'turn') * 0.08;
        const lArm = 12 - num('l_arm', 'raise') * 0.62 - num('l_arm', 'straddle') * 0.18;
        const rArm = -12 + num('r_arm', 'raise') * 0.62 + num('r_arm', 'straddle') * 0.18;
        const lLeg = -4 + num('l_leg', 'raise') * 0.34 - num('l_leg', 'straddle') * 0.45;
        const rLeg = 4 - num('r_leg', 'raise') * 0.34 + num('r_leg', 'straddle') * 0.45;

        actor.dataset.poseId = pose.id;
        delete actor.dataset.poseOverride;
        actor.style.setProperty('--body-bend', `${bodyTilt}deg`);
        actor.style.setProperty('--head-offset', `${headTurn}px`);
        actor.style.setProperty('--l-arm-angle', `${lArm}deg`);
        actor.style.setProperty('--r-arm-angle', `${rArm}deg`);
        actor.style.setProperty('--l-leg-angle', `${lLeg}deg`);
        actor.style.setProperty('--r-leg-angle', `${rLeg}deg`);
        syncDirectorSelectionControls(nodeEl, actor);
        setDirectorStatus(nodeEl, `${actor.querySelector('.actor-name')?.textContent || '角色'}：${pose.label}`);
    }

    function directorSummary(nodeEl) {
        const actors = [...(nodeEl?.querySelectorAll('.director-actor') || [])].map(actor => {
            const pose = actor.dataset.poseId === 'custom'
                ? { label: '自定义姿势' }
                : getDirectorPose(actor.dataset.poseId || 'stand');
            return `${actor.querySelector('.actor-name')?.textContent || '角色'}=${actor.dataset.modelLabel || actor.dataset.modelType}/${pose.label}`;
        });
        const shot = nodeEl?.querySelector('.director-shot-chip.active')?.textContent || '全景';
        const panorama = nodeEl?.querySelector('[data-director-stage]')?.classList.contains('is-panorama') ? '720° 全景' : '普通场景';
        return `${shot} · ${panorama} · ${actors.join('，')}`;
    }

    function actorMarkup(count, model) {
        const name = typeof count === 'number' ? `角色 ${count}` : count;
        return `
            <span class="actor-shadow"></span>
            <span class="actor-leg left"></span><span class="actor-leg right"></span>
            <span class="actor-arm left"></span><span class="actor-arm right"></span>
            <span class="actor-body"></span><span class="actor-head"></span>
            <span class="actor-name">${name}</span>
            <span class="actor-model-label">${model.label}</span>`;
    }

    const directorStudioState = {
        root: null,
        shots: []
    };

    const studioActorLetters = 'ABCDEFGH'.split('');
    const studioActorLayout = [
        { x: 64, y: 55, pose: 'fight', rotY: -10, scale: 100 },
        { x: 32, y: 67, pose: 'stand', rotY: 8, scale: 100 },
        { x: 49, y: 44, pose: 'stand', rotY: 0, scale: 108 },
        { x: 48, y: 36, pose: 'stand', rotY: 0, scale: 104 },
        { x: 52, y: 45, pose: 'stand', rotY: 0, scale: 112 },
        { x: 52, y: 53, pose: 'hands_hips', rotY: 0, scale: 94 },
        { x: 51, y: 62, pose: 'wave', rotY: -4, scale: 96 },
        { x: 49, y: 72, pose: 'sit', rotY: 0, scale: 86 }
    ];

    const studioAddModelOrder = [
        'male-lowpoly',
        'female-lowpoly',
        'broad',
        'muscular',
        'slim',
        'teen',
        'child',
        'chibi'
    ];

    const studioAddModelLabels = {
        'male-lowpoly': '男性素体',
        'female-lowpoly': '女性素体',
        broad: '宽厚素体',
        muscular: '健壮素体',
        slim: '纤细素体',
        teen: '少年素体',
        child: '儿童素体',
        chibi: '二头身'
    };

    const studioJointSchema = [
        { title: '身体', items: [['body', 'bend', '前倾'], ['body', 'turn', '转身'], ['body', 'tilt', '侧倾']] },
        { title: '躯干', items: [['torso', 'bend', '前倾'], ['torso', 'turn', '扭转'], ['torso', 'tilt', '侧倾']] },
        { title: '头部', items: [['head', 'nod', '点头'], ['head', 'turn', '转头'], ['head', 'tilt', '歪头']] },
        { title: '左臂', items: [['l_arm', 'raise', '前举'], ['l_arm', 'straddle', '外展'], ['l_arm', 'turn', '扭转'], ['l_elbow', 'bend', '手肘']] },
        { title: '右臂', items: [['r_arm', 'raise', '前举'], ['r_arm', 'straddle', '外展'], ['r_arm', 'turn', '扭转'], ['r_elbow', 'bend', '手肘']] },
        { title: '左腿', items: [['l_leg', 'raise', '抬腿'], ['l_leg', 'straddle', '外展'], ['l_leg', 'turn', '扭转'], ['l_knee', 'bend', '膝盖']] },
        { title: '右腿', items: [['r_leg', 'raise', '抬腿'], ['r_leg', 'straddle', '外展'], ['r_leg', 'turn', '扭转'], ['r_knee', 'bend', '膝盖']] }
    ];

    const controlDefaults = {
        yaw: 18,
        pitch: 8,
        zoom: 52,
        light: 64,
        fov: 45,
        sceneScale: 300,
        sceneX: 0,
        sceneY: 0,
        sceneZ: 0,
        sceneRotX: 0,
        sceneRotY: 0,
        sceneRotZ: 0
    };

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function dataKey(name) {
        return `control${name[0].toUpperCase()}${name.slice(1)}`;
    }

    function directorControlValue(root, name, fallback = 0) {
        const liveValue = root?.querySelector(`[data-director-control="${name}"]`)?.value;
        const storedValue = root?.dataset?.[dataKey(name)];
        const value = liveValue ?? storedValue ?? fallback;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function clampNumber(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function setDirectorControlValue(root, name, value) {
        if (!root) return;
        root.dataset[dataKey(name)] = String(value);
        root.querySelectorAll(`[data-director-control="${name}"]`).forEach(input => {
            input.value = value;
        });
        root.querySelectorAll(`[data-director-readout="${name}"]`).forEach(readout => {
            if (name === 'zoom') readout.textContent = `${Math.round(value)}mm`;
            else if (name === 'light' || name === 'sceneScale') readout.textContent = `${Math.round(value)}%`;
            else readout.textContent = `${Math.round(value)}°`;
        });
    }

    function directorModelButtonsHtml(activeType) {
        const models = liblibDirectorData().models || [];
        return models.map(model => `
            <button class="director-model-chip ${model.type === activeType ? 'active' : ''}" data-director-model="${model.type}"
                    style="--model-color:${model.color || '#4ecdc4'}">
                <span class="director-model-swatch"></span>
                <strong>${escapeHtml(model.label)}</strong>
                <small>${escapeHtml(model.type)}</small>
            </button>`).join('');
    }

    function directorPoseButtonsHtml(activePose) {
        const poses = liblibDirectorData().posePresets || [];
        return poses.map(pose => `
            <button class="director-pose-chip ${pose.id === activePose ? 'active' : ''}" data-director-pose-preset="${pose.id}">
                <span>${pose.icon || '姿'}</span>${escapeHtml(pose.label)}
            </button>`).join('');
    }

    function studioAddRoleMenuHtml() {
        const models = liblibDirectorData().models || [];
        const ordered = [
            ...studioAddModelOrder.map(type => models.find(model => model.type === type)).filter(Boolean),
            ...models.filter(model => !studioAddModelOrder.includes(model.type))
        ];

        return `
            <div class="studio-add-role-menu" data-studio-add-role-menu>
                <button class="studio-add-role-item" data-director-action="local-upload-model">
                    <span class="studio-add-role-icon">⇧</span><span>本地上传</span>
                </button>
                <div class="studio-add-role-divider"></div>
                ${ordered.map(model => `
                    <button class="studio-add-role-item" data-director-add-model="${model.type}" style="--model-color:${model.color || '#4ecdc4'}">
                        <span class="studio-add-role-icon model"></span><span>${escapeHtml(studioAddModelLabels[model.type] || model.label)}</span>
                    </button>`).join('')}
                <button class="studio-add-role-item has-submenu" data-director-action="add-crowd">
                    <span class="studio-add-role-icon">♙</span><span>群众 (3x3)</span><b>›</b>
                </button>
                <div class="studio-add-role-divider"></div>
                <button class="studio-add-role-item has-submenu" data-director-action="add-geometry">
                    <span class="studio-add-role-icon">◇</span><span>几何模型</span><b>›</b>
                </button>
            </div>
            <input class="studio-local-model-input" data-director-local-model-input type="file" accept=".glb,.gltf,model/gltf-binary,model/gltf+json">`;
    }

    function defaultStudioActors() {
        const models = liblibDirectorData().models || [];
        return studioActorLayout.map((layout, index) => {
            const model = models[index % Math.max(models.length, 1)] || getDirectorModel();
            const letter = studioActorLetters[index] || String(index + 1);
            return {
                id: `role-${letter.toLowerCase()}`,
                name: `角色${letter}`,
                modelType: model.type,
                modelLabel: model.label,
                poseId: layout.pose,
                x: layout.x,
                y: layout.y,
                rotY: layout.rotY,
                scale: layout.scale,
                color: model.color || '#4ecdc4',
                active: index === 0
            };
        });
    }

    function actorDataFromElement(actor, index = 0) {
        const styles = getComputedStyle(actor);
        const model = getDirectorModel(actor.dataset.modelType);
        const letter = studioActorLetters[index] || String(index + 1);
        const readPercent = (name, fallback) => {
            const value = Number.parseFloat(styles.getPropertyValue(name));
            return Number.isFinite(value) ? value : fallback;
        };
        let poseOverride = null;
        if (actor.dataset.poseOverride) {
            try { poseOverride = JSON.parse(actor.dataset.poseOverride); } catch (_) { poseOverride = null; }
        }
        return {
            id: actor.dataset.actor || `role-${letter.toLowerCase()}`,
            name: actor.querySelector('.actor-name')?.textContent?.trim() || `角色${letter}`,
            modelType: actor.dataset.modelType || model.type,
            modelLabel: actor.dataset.modelLabel || model.label,
            poseId: actor.dataset.poseId || 'stand',
            poseOverride,
            x: readPercent('--actor-x', studioActorLayout[index]?.x ?? 50),
            y: readPercent('--actor-y', studioActorLayout[index]?.y ?? 58),
            rotY: Number(actor.dataset.rotY || studioActorLayout[index]?.rotY || 0),
            scale: Number(actor.dataset.scale || studioActorLayout[index]?.scale || 100),
            color: styles.getPropertyValue('--actor-color')?.trim() || model.color || '#4ecdc4',
            active: actor.classList.contains('active'),
            hidden: actor.classList.contains('is-hidden'),
            locked: actor.classList.contains('is-locked')
        };
    }

    function collectStudioActors(sourceNodeEl) {
        if (sourceNodeEl?.dataset.directorActors) {
            try {
                const stored = JSON.parse(sourceNodeEl.dataset.directorActors);
                if (Array.isArray(stored)) return stored;
            } catch (_) {
                delete sourceNodeEl.dataset.directorActors;
            }
        }
        return [];
    }

    function directorActorButtonHtml(actor) {
        const model = getDirectorModel(actor.modelType);
        const override = actor.poseOverride ? ` data-pose-override='${escapeHtml(JSON.stringify(actor.poseOverride))}'` : '';
        return `
            <button class="director-actor ${actor.active ? 'active' : ''} ${actor.hidden ? 'is-hidden' : ''} ${actor.locked ? 'is-locked' : ''}" data-actor="${escapeHtml(actor.id)}"
                    data-model-type="${escapeHtml(model.type)}" data-model-label="${escapeHtml(model.label)}"
                    data-pose-id="${escapeHtml(actor.poseId || 'stand')}" data-rot-y="${Number(actor.rotY || 0)}"
                    data-scale="${Number(actor.scale || 100)}" data-locked="${actor.locked ? 'true' : ''}"${override}
                    style="--actor-x:${Number(actor.x)}%;--actor-y:${Number(actor.y)}%;--actor-h:${model.previewHeight || 74}px;--actor-color:${actor.color || model.color || '#4ecdc4'};">
                ${actorMarkup(actor.name, model)}
            </button>`;
    }

    function studioObjectRowsHtml(rootOrActors, selected = 'scene') {
        const actors = Array.isArray(rootOrActors)
            ? rootOrActors
            : [...rootOrActors.querySelectorAll('.director-actor')].map(actorDataFromElement);
        const row = (id, label, type, hidden = false, locked = false) => `
            <button class="studio-object-row ${selected === id ? 'active' : ''} ${hidden ? 'is-muted' : ''}" data-director-object="${id}">
                <span class="studio-object-icon">${type === 'camera' ? '▣' : type === 'scene' ? '◎' : '♙'}</span>
                <span>${escapeHtml(label)}</span>
                <span class="studio-object-tools">
                    ${type === 'actor' ? `<span data-studio-toggle-visibility="${id}">${hidden ? '隐' : '显'}</span>` : ''}
                    ${type === 'actor' ? `<span data-studio-toggle-lock="${id}">${locked ? '锁' : '开'}</span>` : ''}
                    ${type === 'actor' ? `<span data-studio-delete-actor="${id}">删</span>` : ''}
                </span>
            </button>`;
        return [
            row('camera-main', '机位1', 'camera'),
            ...actors.map(actor => row(actor.id, actor.name, 'actor', actor.hidden, actor.locked))
        ].join('');
    }

    function studioShotListHtml() {
        if (!directorStudioState.shots.length) {
            return '<div class="studio-empty-shot">暂无摄像机截图</div>';
        }
        return directorStudioState.shots.map((shot, index) => `
            <button class="studio-shot-thumb ${index === directorStudioState.shots.length - 1 ? 'active' : ''}" data-studio-shot-index="${index}">
                <img src="${shot.image}" alt="${escapeHtml(shot.title)}">
                <span>${escapeHtml(shot.title)}</span>
            </button>`).join('');
    }

    function studioControl(label, name, min, max, step, fallback, unit = '') {
        const root = directorStudioState.root;
        const value = directorControlValue(root, name, fallback);
        return `
            <label class="director-control">
                <span>${label} <b data-director-readout="${name}">${value}${unit}</b></span>
                <input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-director-control="${name}">
            </label>`;
    }

    function renderSceneInspector(root) {
        return `
            <div class="studio-inspector-head">
                <div>
                    <span class="director-kicker">Scene</span>
                    <strong>3D场景</strong>
                </div>
            </div>
            <div class="director-control-grid studio-scene-controls">
                ${studioControl('场景缩放', 'sceneScale', 50, 500, 1, controlDefaults.sceneScale, '%')}
                ${studioControl('水平环绕', 'yaw', -180, 180, 1, controlDefaults.yaw, '°')}
                ${studioControl('俯仰机位', 'pitch', -35, 45, 1, controlDefaults.pitch, '°')}
                ${studioControl('景别缩放', 'zoom', 35, 120, 1, controlDefaults.zoom, 'mm')}
                ${studioControl('电影光比', 'light', 20, 100, 1, controlDefaults.light, '%')}
                ${studioControl('视野角度', 'fov', 24, 72, 1, controlDefaults.fov, '°')}
            </div>
            <div class="studio-switch-list">
                <label><span>角色标签</span><input type="checkbox" checked data-studio-toggle-labels></label>
                <label><span>网格吸附</span><input type="checkbox" data-studio-toggle-grid-snap></label>
                <label><span>地面</span><input type="checkbox" checked data-studio-toggle-ground></label>
            </div>
            <div class="studio-note">可在视口内拖动角色，右侧切到角色后可调模型、姿势和骨骼滑杆。</div>`;
    }

    function actorJointAngles(actor) {
        if (actor?.dataset.poseOverride) {
            try { return JSON.parse(actor.dataset.poseOverride); } catch (_) { /* fall through */ }
        }
        return JSON.parse(JSON.stringify(getDirectorPose(actor?.dataset.poseId || 'stand').jointAngles || {}));
    }

    function jointValue(actor, part, key) {
        const angles = actorJointAngles(actor);
        const value = angles?.[part]?.[key];
        return Number.isFinite(value) ? value : 0;
    }

    function jointSlidersHtml(actor) {
        return studioJointSchema.map(group => `
            <div class="studio-joint-group">
                <div class="studio-joint-title">${group.title}</div>
                ${group.items.map(([part, key, label]) => {
                    const value = jointValue(actor, part, key);
                    const isBend = key === 'bend' && (part.includes('elbow') || part.includes('knee'));
                    return `
                        <label class="studio-joint-control">
                            <span>${label}<b data-joint-readout="${part}.${key}">${value}</b></span>
                            <input type="range" min="${isBend ? -10 : -90}" max="${isBend ? 150 : 90}" step="1"
                                   value="${value}" data-director-joint-control data-joint-part="${part}" data-joint-key="${key}">
                        </label>`;
                }).join('')}
            </div>`).join('');
    }

    function actorPropertyPanel(actor) {
        const x = Number.parseFloat(getComputedStyle(actor).getPropertyValue('--actor-x')) || 50;
        const y = Number.parseFloat(getComputedStyle(actor).getPropertyValue('--actor-y')) || 58;
        const color = getComputedStyle(actor).getPropertyValue('--actor-color')?.trim() || '#4ecdc4';
        return `
            <label class="studio-field">
                <span>名称</span>
                <input data-director-actor-prop="name" value="${escapeHtml(actor.querySelector('.actor-name')?.textContent || '角色')}">
            </label>
            <div class="studio-field-grid">
                <label class="studio-field"><span>位置 X</span><input type="number" min="5" max="95" step="1" data-director-actor-prop="x" value="${x.toFixed(0)}"></label>
                <label class="studio-field"><span>位置 Y</span><input type="number" min="20" max="92" step="1" data-director-actor-prop="y" value="${y.toFixed(0)}"></label>
                <label class="studio-field"><span>旋转 Y</span><input type="number" min="-180" max="180" step="1" data-director-actor-prop="rotY" value="${Number(actor.dataset.rotY || 0)}"></label>
                <label class="studio-field"><span>统一缩放</span><input type="number" min="50" max="180" step="1" data-director-actor-prop="scale" value="${Number(actor.dataset.scale || 100)}"></label>
            </div>
            <label class="studio-field">
                <span>颜色</span>
                <input type="color" data-director-actor-prop="color" value="${color}">
            </label>
            <div class="director-liblib-section compact">
                <div class="director-section-head">
                    <span>角色素模</span>
                    <small>${(liblibDirectorData().models || []).length} models</small>
                </div>
                <div class="director-model-grid">
                    ${directorModelButtonsHtml(actor.dataset.modelType)}
                </div>
            </div>`;
    }

    function actorPosePanel(actor) {
        return `
            <div class="director-liblib-section compact">
                <div class="director-section-head">
                    <span>姿势预设</span>
                    <small>${(liblibDirectorData().posePresets || []).length} poses</small>
                </div>
                <div class="director-pose-grid">
                    ${directorPoseButtonsHtml(actor.dataset.poseId)}
                </div>
            </div>
            <div class="studio-joint-panel">
                ${jointSlidersHtml(actor)}
            </div>`;
    }

    function renderActorInspector(root, actor) {
        const tab = root.dataset.inspectorTab || 'props';
        return `
            <div class="studio-inspector-head">
                <div>
                    <span class="director-kicker">Character</span>
                    <strong>${escapeHtml(actor.querySelector('.actor-name')?.textContent || '角色')}</strong>
                </div>
            </div>
            <div class="studio-tabs">
                <button class="${tab === 'props' ? 'active' : ''}" data-studio-inspector-tab="props">属性</button>
                <button class="${tab === 'pose' ? 'active' : ''}" data-studio-inspector-tab="pose">姿势</button>
            </div>
            <div class="studio-inspector-scroll">
                ${tab === 'pose' ? actorPosePanel(actor) : actorPropertyPanel(actor)}
            </div>`;
    }

    function renderCameraInspector(root) {
        const tab = root.dataset.cameraTab || 'props';
        const latest = directorStudioState.shots.at(-1);
        return `
            <div class="studio-inspector-head">
                <div>
                    <span class="director-kicker">Camera</span>
                    <strong>摄像机</strong>
                </div>
            </div>
            <div class="studio-tabs">
                <button class="${tab === 'props' ? 'active' : ''}" data-studio-camera-tab="props">属性</button>
                <button class="${tab === 'shots' ? 'active' : ''}" data-studio-camera-tab="shots">摄像机截图</button>
            </div>
            ${tab === 'shots' ? `
                <div class="studio-shot-list" data-studio-shot-list>${studioShotListHtml()}</div>
                <div class="studio-shot-actions">
                    <button class="director-output-btn" data-director-action="clear-shots">全部清空</button>
                    <button class="director-output-btn primary" data-director-action="send-shots">发送到画布</button>
                </div>` : `
                <div class="studio-camera-preview">
                    ${latest ? `<img src="${latest.image}" alt="机位预览">` : '<span>FOV 45°</span>'}
                </div>
                <label class="studio-field"><span>名称</span><input value="机位1" readonly></label>
                <div class="director-control-grid">
                    ${studioControl('水平环绕', 'yaw', -180, 180, 1, controlDefaults.yaw, '°')}
                    ${studioControl('俯仰机位', 'pitch', -35, 45, 1, controlDefaults.pitch, '°')}
                    ${studioControl('景别缩放', 'zoom', 35, 120, 1, controlDefaults.zoom, 'mm')}
                    ${studioControl('视野角度', 'fov', 24, 72, 1, controlDefaults.fov, '°')}
                </div>`}`;
    }

    function renderStudioInspector(root) {
        const inspector = root.querySelector('[data-director-props]');
        if (!inspector) return;
        const selected = root.dataset.selectedObject || 'scene';
        if (selected === 'scene') {
            inspector.innerHTML = renderSceneInspector(root);
        } else if (selected === 'camera-main') {
            inspector.innerHTML = renderCameraInspector(root);
        } else {
            const actor = root.querySelector(`.director-actor[data-actor="${CSS.escape(selected)}"]`) || selectedDirectorActor(root);
            inspector.innerHTML = actor ? renderActorInspector(root, actor) : renderSceneInspector(root);
            if (actor) syncDirectorSelectionControls(root, actor);
        }
        updateDirectorStage(inspector);
    }

    function syncStudioSelection(root, objectId) {
        if (!root?.matches?.('[data-director-studio-root]')) return;
        const selected = objectId || root.dataset.selectedObject || 'scene';
        root.dataset.selectedObject = selected;

        root.querySelectorAll('.studio-object-row').forEach(row => {
            row.classList.toggle('active', row.dataset.directorObject === selected);
        });
        root.querySelectorAll('.director-actor').forEach(actor => {
            actor.classList.toggle('active', actor.dataset.actor === selected);
        });
        const actor = root.querySelector(`.director-actor[data-actor="${CSS.escape(selected)}"]`);
        const gizmo = root.querySelector('[data-director-gizmo]');
        if (gizmo && actor) {
            positionStudioGizmo(root, actor);
        } else if (gizmo) {
            gizmo.classList.toggle('active', selected === 'camera-main');
            if (selected === 'camera-main') {
                gizmo.style.left = '43%';
                gizmo.style.top = '55%';
            }
        }
        renderStudioInspector(root);
        window.Director3D?.syncAll();
    }

    function renderStudioObjectList(root) {
        const list = root.querySelector('[data-studio-object-list]');
        if (!list) return;
        list.innerHTML = studioObjectRowsHtml(root, root.dataset.selectedObject || 'scene');
    }

    function buildDirectorStudioHtml(sourceNodeEl) {
        const sourceNodeId = sourceNodeEl.dataset.nodeId;
        const actors = collectStudioActors(sourceNodeEl);
        return `
            <div class="director-studio-overlay" data-director-studio-overlay>
                <section class="director-studio node-type-director" data-director-studio-root
                         data-node-id="studio-${sourceNodeId}" data-source-node-id="${sourceNodeId}"
                         data-selected-object="scene" data-inspector-tab="props" data-camera-tab="props" data-view-mode="director">
                    <header class="director-studio-topbar">
                        <strong>3D导演台</strong>
                        <div class="director-view-tabs">
                            <button class="active" data-studio-view-mode="director">导演视角</button>
                            <button data-studio-view-mode="camera">机位视角</button>
                        </div>
                        <div class="director-top-actions">
                            <button title="帮助" data-director-action="studio-help">?</button>
                            <button title="关闭" data-director-action="close-studio">×</button>
                        </div>
                    </header>
                    <div class="director-studio-main">
                        <aside class="director-studio-scene">
                            <button class="director-studio-panel-title" data-director-object="scene">场景</button>
                            <label class="studio-search">
                                <input placeholder="搜索场景对象">
                                <span>⌕</span>
                            </label>
                            <div class="studio-object-list" data-studio-object-list>
                                ${studioObjectRowsHtml(actors, 'scene')}
                            </div>
                        </aside>
                        <div class="director-studio-center">
                            <div class="director-viewport director-studio-viewport" data-director-stage data-director-view-mode="director">
                                <div class="director-3d-stage" data-director-3d-stage>
                                    <div class="director-3d-loading" data-director-3d-loading>启动 3D 导演台</div>
                                </div>
                                <div class="director-panorama-ring"></div>
                                <div class="director-light-beam"></div>
                                <div class="director-camera-frame"></div>
                                <div class="director-floor-grid"></div>
                                <div class="director-axis x">X</div>
                                <div class="director-axis z">Z</div>
                                ${actors.map(directorActorButtonHtml).join('')}
                                <button class="director-camera-rig studio-camera-rig" data-director-object="camera-main">
                                    <span class="camera-dot"></span>
                                    <span class="camera-label">机位1</span>
                                </button>
                                <div class="director-transform-gizmo" data-director-gizmo>
                                    <span class="gizmo-axis gizmo-x"></span>
                                    <span class="gizmo-axis gizmo-y"></span>
                                    <span class="gizmo-axis gizmo-z"></span>
                                    <span class="gizmo-ring"></span>
                                </div>
                                <div class="director-orientation-cube">
                                    <span></span><i></i><b></b>
                                </div>
                                <button class="director-reset-view" data-director-action="reset-view">重置视角</button>
                            </div>
                            <div class="studio-bottom-toolbar">
                                <button class="active" title="移动视图/角色" aria-label="移动视图或角色" data-director-action="move-tool" data-toolbar-tip="移动视图 / 拖动角色"><span>⌁</span><small>移动</small></button>
                                <button data-director-action="add-actor" title="添加角色" aria-label="添加角色" data-toolbar-tip="添加角色 / 选择素体"><span>♙</span><small>角色</small></button>
                                <button data-director-action="panorama" title="全景图" aria-label="全景图" data-toolbar-tip="切换 720 全景图"><span>720</span><small>全景</small></button>
                                <button data-director-action="add-camera" title="选择机位" aria-label="选择机位" data-toolbar-tip="选择 / 管理机位"><span>▣</span><small>机位</small></button>
                                <button data-director-action="aspect" title="选择画幅比例" aria-label="选择画幅比例" data-toolbar-tip="切换横版 / 竖版画幅"><span>□</span><small>画幅</small></button>
                                <button data-director-action="take-screenshot" title="截图当前机位" aria-label="截图当前机位" data-toolbar-tip="截图当前机位"><span>▧</span><small>截图</small></button>
                                <button data-director-action="ai-import" title="AI 识图导入" aria-label="AI 识图导入" data-toolbar-tip="AI 识图导入场景"><span>AI</span><small>识图</small></button>
                                <button data-director-action="studio-fullscreen" title="全屏" aria-label="全屏" data-toolbar-tip="切换全屏显示"><span>↗</span><small>全屏</small></button>
                            </div>
                            ${studioAddRoleMenuHtml()}
                        </div>
                        <aside class="director-studio-inspector node-director-props" data-director-props></aside>
                    </div>
                </section>
            </div>`;
    }

    function seedStudioControls(root, sourceNodeEl) {
        Object.entries(controlDefaults).forEach(([name, value]) => {
            const sourceValue = sourceNodeEl.dataset[dataKey(name)] ?? sourceNodeEl.querySelector(`[data-director-control="${name}"]`)?.value;
            root.dataset[dataKey(name)] = sourceValue ?? value;
        });
    }

    function openDirectorStudio(sourceNodeEl) {
        const existingRoot = document.querySelector('[data-director-studio-root]');
        if (existingRoot) window.Director3D?.dispose?.(existingRoot);
        document.querySelector('[data-director-studio-overlay]')?.remove();
        directorStudioState.shots = [];
        document.body.insertAdjacentHTML('beforeend', buildDirectorStudioHtml(sourceNodeEl));
        const root = document.querySelector('[data-director-studio-root]');
        directorStudioState.root = root;
        seedStudioControls(root, sourceNodeEl);
        document.body.classList.add('director-studio-open');
        syncStudioSelection(root, 'scene');
        setDirectorStatus(sourceNodeEl, '导演台已打开');
        setTimeout(() => window.Director3D?.syncAll(), 0);
    }

    function copyActorState(from, to) {
        ['modelType', 'modelLabel', 'poseId', 'poseOverride', 'rotY', 'scale'].forEach(key => {
            if (from.dataset[key] !== undefined) to.dataset[key] = from.dataset[key];
            else delete to.dataset[key];
        });
        ['--actor-x', '--actor-y', '--actor-h', '--actor-color', '--body-bend', '--head-offset', '--l-arm-angle', '--r-arm-angle', '--l-leg-angle', '--r-leg-angle'].forEach(name => {
            const value = from.style.getPropertyValue(name);
            if (value) to.style.setProperty(name, value);
        });
        const name = from.querySelector('.actor-name')?.textContent || '';
        const modelLabel = from.querySelector('.actor-model-label')?.textContent || '';
        if (to.querySelector('.actor-name')) to.querySelector('.actor-name').textContent = name;
        if (to.querySelector('.actor-model-label')) to.querySelector('.actor-model-label').textContent = modelLabel;
    }

    function serializeStudioActors(root) {
        return [...(root?.querySelectorAll('.director-actor') || [])].map(actorDataFromElement);
    }

    function persistStudioActors(root) {
        if (!root?.matches?.('[data-director-studio-root]')) return;
        const sourceNodeEl = document.querySelector(`[data-node-id="${root.dataset.sourceNodeId}"]`);
        if (sourceNodeEl) sourceNodeEl.dataset.directorActors = JSON.stringify(serializeStudioActors(root));
    }

    function persistStudioControls(root) {
        if (!root?.matches?.('[data-director-studio-root]')) return;
        const sourceNodeEl = document.querySelector(`[data-node-id="${root.dataset.sourceNodeId}"]`);
        if (!sourceNodeEl) return;
        Object.keys(controlDefaults).forEach(name => {
            const value = root.dataset[dataKey(name)];
            if (value !== undefined) sourceNodeEl.dataset[dataKey(name)] = value;
        });
    }

    function closeDirectorStudio(root = directorStudioState.root) {
        if (!root) return;
        const sourceNodeEl = document.querySelector(`[data-node-id="${root.dataset.sourceNodeId}"]`);
        if (sourceNodeEl) {
            persistStudioActors(root);
            persistStudioControls(root);
            const studioActors = [...root.querySelectorAll('.director-actor:not(.is-hidden)')];
            sourceNodeEl.querySelectorAll('.director-actor').forEach((actor, index) => {
                if (studioActors[index]) copyActorState(studioActors[index], actor);
            });
            setDirectorStatus(sourceNodeEl, '导演台已同步');
        }
        window.Director3D?.dispose?.(root);
        root.closest('[data-director-studio-overlay]')?.remove();
        directorStudioState.root = null;
        document.body.classList.remove('director-studio-open');
        window.Director3D?.syncAll();
    }

    function updateStudioShotList(root) {
        root.querySelectorAll('[data-studio-shot-list]').forEach(list => {
            list.innerHTML = studioShotListHtml();
        });
    }

    function takeStudioScreenshot(root) {
        const image = window.Director3D?.capture(root);
        if (!image) return;
        const index = directorStudioState.shots.length + 1;
        directorStudioState.shots.push({
            image,
            title: `机位1-截图${String(index).padStart(2, '0')}`
        });
        root.dataset.selectedObject = 'camera-main';
        root.dataset.cameraTab = 'shots';
        renderStudioInspector(root);
        updateStudioShotList(root);
        setDirectorStatus(document.querySelector(`[data-node-id="${root.dataset.sourceNodeId}"]`), '已保存摄像机截图');
    }

    function createDirectorSnapshotOutput(sourceId, title, description, previewImage, index = 0) {
        const nd = engine.nodes.get(sourceId);
        if (!nd) return null;
        const x = nd.x + 760 + (index % 2) * 360;
        const y = nd.y + Math.floor(index / 2) * 430;
        const outputId = engine.addNode('image', x, y, { source: 'director', title });
        decorateGeneratedNode(outputId, title, description, previewImage);
        engine._createConnection(sourceId, outputId);
        return outputId;
    }

    function sendStudioShotsToCanvas(root) {
        if (!directorStudioState.shots.length) takeStudioScreenshot(root);
        const sourceId = root.dataset.sourceNodeId;
        directorStudioState.shots.forEach((shot, index) => {
            createDirectorSnapshotOutput(sourceId, `导演台 ${shot.title}`, `${directorSummary(root)}。来自当前机位截图。`, shot.image, index);
        });
        setDirectorStatus(document.querySelector(`[data-node-id="${sourceId}"]`), '摄像机截图已发送到画布');
    }

    function closeStudioAddRoleMenu(root) {
        root?.querySelector('[data-studio-add-role-menu]')?.classList.remove('is-open');
    }

    function toggleStudioAddRoleMenu(root) {
        const menu = root?.querySelector('[data-studio-add-role-menu]');
        if (!menu) return;
        menu.classList.toggle('is-open');
    }

    function nextStudioActorName(root) {
        const count = root.querySelectorAll('.director-actor').length + 1;
        const letter = studioActorLetters[count - 1];
        return {
            count,
            id: letter ? `role-${letter.toLowerCase()}` : `role-${count}`,
            name: letter ? `角色${letter}` : `角色${count}`
        };
    }

    function addDirectorActor(nodeEl, modelType, options = {}) {
        const stage = nodeEl.querySelector('[data-director-stage]');
        if (!stage) return null;

        const meta = nextStudioActorName(nodeEl);
        const model = getDirectorModel(modelType) || getDirectorModel();
        const actor = document.createElement('button');
        actor.className = 'director-actor';
        actor.dataset.actor = nodeEl.matches('[data-director-studio-root]') ? meta.id : `extra-${meta.count}`;
        actor.dataset.modelType = model.type;
        actor.dataset.modelLabel = model.label;
        actor.dataset.poseId = options.poseId || 'stand';
        actor.dataset.rotY = String(options.rotY ?? 0);
        actor.dataset.scale = String(options.scale ?? 100);
        actor.style.setProperty('--actor-x', `${options.x ?? (30 + (meta.count * 11) % 48)}%`);
        actor.style.setProperty('--actor-y', `${options.y ?? (49 + (meta.count * 7) % 19)}%`);
        actor.style.setProperty('--actor-h', `${model.previewHeight || 74}px`);
        actor.style.setProperty('--actor-color', model.color || '#4ecdc4');
        actor.innerHTML = actorMarkup(nodeEl.matches('[data-director-studio-root]') ? meta.name : meta.count, model);
        stage.appendChild(actor);

        nodeEl.querySelectorAll('.director-actor').forEach(a => a.classList.remove('active'));
        actor.classList.add('active');
        applyDirectorPoseToActor(nodeEl, actor, getDirectorPose(actor.dataset.poseId));
        syncDirectorSelectionControls(nodeEl, actor);

        if (nodeEl.matches('[data-director-studio-root]')) {
            renderStudioObjectList(nodeEl);
            syncStudioSelection(nodeEl, actor.dataset.actor);
            persistStudioActors(nodeEl);
        }

        setDirectorStatus(nodeEl, `${actor.querySelector('.actor-name')?.textContent || '角色'} 已加入：${model.label}`);
        window.Director3D?.syncAll();
        return actor;
    }

    function deleteDirectorActor(root, actorId) {
        const actor = root?.querySelector(`.director-actor[data-actor="${CSS.escape(actorId)}"]`);
        if (!root || !actor) return;

        const actorsBefore = [...root.querySelectorAll('.director-actor')];
        const deleteIndex = Math.max(0, actorsBefore.indexOf(actor));
        const deletedName = actor.querySelector('.actor-name')?.textContent || '角色';
        actor.remove();

        const remainingActors = [...root.querySelectorAll('.director-actor')];
        const nextActor = remainingActors[Math.min(deleteIndex, Math.max(remainingActors.length - 1, 0))];
        const nextSelection = nextActor?.dataset.actor || 'scene';
        root.dataset.selectedObject = nextSelection;
        renderStudioObjectList(root);
        syncStudioSelection(root, nextSelection);

        persistStudioActors(root);
        const sourceNodeEl = document.querySelector(`[data-node-id="${root.dataset.sourceNodeId}"]`);
        setDirectorStatus(sourceNodeEl || root, `${deletedName} 已删除`);
        window.Director3D?.syncAll();
    }

    function addDirectorCrowd(root) {
        const models = liblibDirectorData().models || [];
        const startCount = root.querySelectorAll('.director-actor').length;
        const baseX = 42;
        const baseY = 48;
        for (let row = 0; row < 3; row += 1) {
            for (let col = 0; col < 3; col += 1) {
                const model = models[(row + col) % Math.max(models.length, 1)] || getDirectorModel();
                addDirectorActor(root, model.type, {
                    x: baseX + col * 6,
                    y: baseY + row * 8,
                    scale: 78,
                    rotY: (col - 1) * 8
                });
            }
        }
        setDirectorStatus(root, `已加入群众 (3x3)，新增 ${root.querySelectorAll('.director-actor').length - startCount} 个角色`);
    }

    function addUploadedDirectorModel(root, file) {
        if (!file) return;
        const data = liblibDirectorData();
        const model = {
            order: (data.models || []).length + 1,
            roleHint: 'U',
            type: `upload-${Date.now()}`,
            label: file.name.replace(/\.(glb|gltf)$/i, '') || '本地模型',
            file: URL.createObjectURL(file),
            byteLength: file.size,
            nodes: 0,
            meshes: 0,
            skins: 0,
            animations: 0,
            color: '#4ecdc4',
            previewHeight: 78
        };
        data.models = data.models || [];
        data.models.push(model);
        addDirectorActor(root, model.type);
        renderStudioInspector(root);
    }

    function updateDirectorStage(props) {
        const { nodeEl, stage } = directorContext(props);
        if (!nodeEl || !stage) return;

        const yaw = directorControlValue(nodeEl, 'yaw', controlDefaults.yaw);
        const pitch = directorControlValue(nodeEl, 'pitch', controlDefaults.pitch);
        const zoom = directorControlValue(nodeEl, 'zoom', controlDefaults.zoom);
        const light = directorControlValue(nodeEl, 'light', controlDefaults.light);
        const fov = directorControlValue(nodeEl, 'fov', controlDefaults.fov);
        const sceneScale = directorControlValue(nodeEl, 'sceneScale', controlDefaults.sceneScale);

        Object.entries({ yaw, pitch, zoom, light, fov, sceneScale }).forEach(([key, value]) => {
            setDirectorControlValue(nodeEl, key, value);
        });

        stage.style.setProperty('--director-rotate', `${yaw / 4}deg`);
        stage.style.setProperty('--director-pitch', `${62 + pitch / 3}deg`);
        stage.style.setProperty('--director-scale', String(Math.max(0.78, Math.min(1.28, zoom / 72))));
        stage.style.setProperty('--director-light', String(light / 100));
        stage.style.setProperty('--director-scene-scale', String(sceneScale / 300));

        const readouts = {
            yaw: `${yaw}°`,
            pitch: `${pitch}°`,
            zoom: `${zoom}mm`,
            light: `${light}%`,
            fov: `${fov.toFixed(0)}°`,
            sceneScale: `${sceneScale}%`
        };
        Object.entries(readouts).forEach(([key, value]) => {
            const el = props.querySelector(`[data-director-readout="${key}"]`);
            if (el) el.textContent = value;
        });
    }

    function applyDirectorShot(nodeEl, shot) {
        const props = nodeEl.querySelector('[data-director-props]');
        if (!props) return;
        const presets = {
            wide: { yaw: 18, pitch: 8, zoom: 52, light: 64, label: '全景定位' },
            close: { yaw: -22, pitch: 2, zoom: 104, light: 72, label: '特写机位' },
            top: { yaw: 8, pitch: 42, zoom: 68, light: 58, label: '俯拍调度' },
            reverse: { yaw: 66, pitch: 6, zoom: 82, light: 76, label: '反打机位' }
        };
        const next = presets[shot] || presets.wide;

        Object.entries(next).forEach(([key, value]) => {
            const input = props.querySelector(`[data-director-control="${key}"]`);
            if (input) input.value = value;
        });

        nodeEl.querySelectorAll('.director-shot-chip').forEach(chip => {
            chip.classList.toggle('active', chip.dataset.directorShot === shot);
        });
        updateDirectorStage(props);
        setDirectorStatus(nodeEl, next.label);
    }

    function decorateGeneratedNode(nodeId, title, description, previewImage = '', options = {}) {
        const nodeEl = document.querySelector(`[data-node-id="${nodeId}"]`);
        const resultRegion = nodeEl?.querySelector('[data-generation-result-region]');
        if (!resultRegion) return;
        const node = engine.nodes.get(nodeId);
        if (node?.type === 'video' && (options.taskId || node.data?.videoSubmission)) {
            const taskId = options.taskId || node.data.taskId || '';
            const normalized = window.UltimateCanvasGenerationNodes.normalizeVideoStatus(videoTaskForNode(node));
            const playUrl = normalized.playableAvailable ? normalized.playUrl : '';
            const oldPlayer = inlineVideoPlayers.get(nodeId);
            if (oldPlayer && (oldPlayer.taskId !== taskId || oldPlayer.playUrl !== playUrl)) releaseInlineVideos(nodeId);
            else if (oldPlayer?.blocked && playUrl) {
                releaseInlineVideos(nodeId);
                window.UltimateCanvasGenerationInteractions.releaseVideoGenerationResultRegion(nodeEl);
            }
            const waiting = !['succeeded', 'failed', 'cancelled'].includes(node.data.generationStatus);
            const primary = waiting ? availableGenerationReferenceItems(nodeId)[0]?.preview || '' : '';
            const poster = previewImage || primary;
            const icon = name => window.UltimateCanvasIcons(name, 20);
            const html = `<div class="canvas-video-result" data-delivery-stage="${escapeHtml(normalized.deliveryStage?.key || '')}"
                data-playable-available="${Boolean(normalized.playableAvailable)}" data-preview-available="${Boolean(normalized.previewAvailable)}"
                data-stable-download-ready="${Boolean(normalized.stableDownloadReady)}">
                <div class="canvas-video-stage">
                    ${playUrl ? `<video class="generated-frame-preview" data-canvas-inline-video controls playsinline preload="none" ${poster ? `poster="${escapeHtml(poster)}"` : ''}></video>
                        <button type="button" class="canvas-video-cover" data-video-play aria-label="播放视频">${icon('Play')}</button>`
                        : poster ? `<img class="generated-frame-preview ${waiting ? 'canvas-video-pending-source' : ''}" src="${escapeHtml(poster)}" alt="${waiting ? '生成参考图' : '视频封面'}" draggable="false">`
                        : '<div class="generated-result-placeholder" aria-hidden="true"></div>'}
                </div>
                <div class="canvas-video-result-meta" data-video-result-meta>
                    <strong class="generated-result-title" title="${escapeHtml(title)}">${escapeHtml(title)}</strong>
                    <span data-video-summary title="${escapeHtml(description)}">${escapeHtml(description)}</span>
                    <span data-video-read-state role="status" aria-live="polite"></span>
                    ${playUrl ? `<button type="button" data-video-read-retry title="重新读取视频" aria-label="重新读取视频">${icon('RotateCcw')}</button>
                        <button type="button" data-canvas-media-preview data-content-key="${escapeHtml(`video_task:${taskId}`)}" title="放大视频" aria-label="放大视频">${icon('Maximize2')}</button>` : ''}
                </div>
            </div>`;
            window.UltimateCanvasGenerationInteractions.updateVideoGenerationResultRegion(nodeEl, html, { taskId, playUrl });
            if (playUrl) bindInlineVideo(nodeId, taskId, playUrl);
            syncVideoTaskActionsTrigger(nodeEl, node, options);
            return;
        }
        window.UltimateCanvasGenerationInteractions.updateGenerationResultRegion(nodeEl, `
            <div class="generated-reference-card">
                <strong class="generated-result-title">${escapeHtml(title)}</strong>
                ${['video', 'audio'].includes(options.mediaType) && options.mediaUrl
                    ? `<${options.mediaType} class="generated-frame-preview" controls preload="metadata" src="${escapeHtml(options.mediaUrl)}" ${options.mediaType === 'video' && previewImage ? `poster="${escapeHtml(previewImage)}"` : ''}></${options.mediaType}>`
                    : previewImage
                    ? `<img class="generated-frame-preview" src="${escapeHtml(previewImage)}" alt="${escapeHtml(title)}" draggable="false">`
                    : '<div class="generated-result-placeholder" aria-hidden="true"></div>'}
            </div>`);
        syncImageResultActionsTrigger(nodeEl, node, options);
        if (node?.type === 'image') renderCanvasBilling(nodeId);
        if (node?.type === 'video') syncVideoTaskActionsTrigger(nodeEl, node, options);
    }
    document.addEventListener('error', event => {
        const media = event.target;
        if (!media?.matches?.('.generated-frame-preview') || media.hasAttribute('data-canvas-inline-video') || !media.closest('.generated-reference-card')) return;
        const region = media.closest('.generated-reference-card');
        if (region.querySelector('[data-media-retry]')) return;
        const message = document.createElement('span'); message.textContent = '素材预览暂不可用'; message.className = 'canvas-media-error';
        const retry = document.createElement('button'); retry.type = 'button'; retry.dataset.mediaRetry = ''; retry.title = '重新读取素材预览'; retry.innerHTML = window.UltimateCanvasIcons('RotateCcw', 16);
        retry.addEventListener('click', () => { message.remove(); retry.remove(); if (media.load) media.load(); else media.src = media.src; });
        region.append(message, retry);
    }, true);

    function createDirectorOutput(sourceId, kind, title, description, index = 0) {
        const nd = engine.nodes.get(sourceId);
        if (!nd) return null;
        const col = index % 2;
        const row = Math.floor(index / 2);
        const x = nd.x + 760 + col * 360;
        const y = nd.y + row * 430;
        const sourceEl = document.querySelector(`[data-node-id="${sourceId}"]`);
        const previewImage = window.Director3D?.capture(sourceEl) || '';
        const outputId = engine.addNode(kind, x, y, {
            source: 'director',
            title,
            description,
            prompt: description,
            previewImage,
            referenceImage: previewImage,
            generationIntent: {
                kind,
                mode: kind === 'video' ? 'first-last-frame-video' : 'image-reference',
                sourceNodeId: sourceId
            }
        });
        decorateGeneratedNode(outputId, title, description, previewImage);
        engine._createConnection(sourceId, outputId);
        return outputId;
    }

    function updateStudioActorProp(input) {
        const { nodeEl } = directorContext(input);
        if (!nodeEl?.matches?.('[data-director-studio-root]')) return;
        const actor = selectedDirectorActor(nodeEl);
        if (!actor) return;
        const prop = input.dataset.directorActorProp;
        const value = input.value;
        const model = getDirectorModel(actor.dataset.modelType);

        if (prop === 'name') {
            actor.querySelector('.actor-name').textContent = value || '角色';
            renderStudioObjectList(nodeEl);
        } else if (prop === 'x') {
            actor.style.setProperty('--actor-x', `${Math.max(5, Math.min(95, Number(value) || 50))}%`);
        } else if (prop === 'y') {
            actor.style.setProperty('--actor-y', `${Math.max(20, Math.min(92, Number(value) || 58))}%`);
        } else if (prop === 'rotY') {
            actor.dataset.rotY = String(Number(value) || 0);
        } else if (prop === 'scale') {
            actor.dataset.scale = String(Math.max(50, Math.min(180, Number(value) || 100)));
        } else if (prop === 'color') {
            actor.style.setProperty('--actor-color', value || model.color || '#4ecdc4');
        }

        positionStudioGizmo(nodeEl, actor);
        window.Director3D?.syncAll();
    }

    function updateStudioJointControl(input) {
        const { nodeEl } = directorContext(input);
        if (!nodeEl?.matches?.('[data-director-studio-root]')) return;
        const actor = selectedDirectorActor(nodeEl);
        if (!actor) return;
        const part = input.dataset.jointPart;
        const key = input.dataset.jointKey;
        const value = Number(input.value) || 0;
        const angles = actorJointAngles(actor);
        angles[part] = angles[part] || {};
        angles[part][key] = value;
        actor.dataset.poseOverride = JSON.stringify(angles);
        actor.dataset.poseId = 'custom';
        const readout = nodeEl.querySelector(`[data-joint-readout="${part}.${key}"]`);
        if (readout) readout.textContent = String(value);
        setDirectorStatus(document.querySelector(`[data-node-id="${nodeEl.dataset.sourceNodeId}"]`), '姿势滑杆已应用');
        window.Director3D?.syncAll();
    }

    document.addEventListener('input', (e) => {
        const actorProp = e.target.closest('[data-director-actor-prop]');
        if (actorProp) {
            updateStudioActorProp(actorProp);
            return;
        }

        const jointControl = e.target.closest('[data-director-joint-control]');
        if (jointControl) {
            updateStudioJointControl(jointControl);
            return;
        }

        const control = e.target.closest('[data-director-control]');
        if (!control) return;
        const props = control.closest('[data-director-props]');
        const root = control.closest('[data-director-studio-root]');
        if (root) root.dataset[dataKey(control.dataset.directorControl)] = control.value;
        if (props) updateDirectorStage(props);
    });

    let studioDrag = null;
    let studioOrbit = null;

    function actorStagePoint(actor, stage) {
        const rect = stage.getBoundingClientRect();
        const styles = getComputedStyle(actor);
        const xPct = Number.parseFloat(styles.getPropertyValue('--actor-screen-x'))
            || Number.parseFloat(styles.getPropertyValue('--actor-x'))
            || 50;
        const yPct = Number.parseFloat(styles.getPropertyValue('--actor-screen-y'))
            || Number.parseFloat(styles.getPropertyValue('--actor-y'))
            || 58;
        return {
            x: rect.left + rect.width * xPct / 100,
            y: rect.top + rect.height * yPct / 100
        };
    }

    function actorFromStagePointer(root, stage, clientX, clientY) {
        const candidates = [...root.querySelectorAll('.director-actor:not(.is-hidden):not(.is-locked)')];
        let best = null;
        let bestScore = Infinity;
        candidates.forEach(actor => {
            const point = actorStagePoint(actor, stage);
            const dx = clientX - point.x;
            const dy = clientY - point.y;
            const inHitBox = Math.abs(dx) <= 125 && dy >= -265 && dy <= 120;
            if (!inHitBox) return;
            const score = Math.abs(dx) + Math.abs(dy) * 0.75;
            if (score < bestScore) {
                best = actor;
                bestScore = score;
            }
        });
        return best;
    }

    function beginStudioActorDrag(actor, root, stage, event) {
        const point = actorStagePoint(actor, stage);
        studioDrag = {
            actor,
            root,
            stage,
            offsetX: point.x - event.clientX,
            offsetY: point.y - event.clientY
        };
        actor.setPointerCapture?.(event.pointerId);
        stage.setPointerCapture?.(event.pointerId);
        root.querySelectorAll('.director-actor').forEach(a => a.classList.remove('active'));
        actor.classList.add('active');
        syncStudioSelection(root, actor.dataset.actor);
    }

    function moveStudioActorToPointer(actor, stage, clientX, clientY, offsetX = 0, offsetY = 0) {
        const root = stage.closest('[data-director-studio-root], .node-type-director');
        if (window.Director3D?.moveActorToScreen?.(root, actor, clientX, clientY, offsetX, offsetY)) {
            return;
        }
        const rect = stage.getBoundingClientRect();
        const x = Math.max(6, Math.min(94, ((clientX + offsetX - rect.left) / rect.width) * 100));
        const y = Math.max(24, Math.min(90, ((clientY + offsetY - rect.top) / rect.height) * 100));
        actor.style.setProperty('--actor-x', `${x.toFixed(1)}%`);
        actor.style.setProperty('--actor-y', `${y.toFixed(1)}%`);
    }

    function syncStudioCameraControls(root, values) {
        Object.entries(values).forEach(([name, value]) => {
            setDirectorControlValue(root, name, value);
        });
        updateDirectorStage(root.querySelector('[data-director-props]'));
        window.Director3D?.syncAll();
    }

    document.addEventListener('pointerdown', (e) => {
        const actor = e.target.closest?.('.director-actor');
        const root = actor?.closest?.('[data-director-studio-root]');
        if (actor && root && e.button === 0 && !actor.classList.contains('is-locked')) {
            beginStudioActorDrag(actor, root, root.querySelector('[data-director-stage]'), e);
            e.preventDefault();
            return;
        }

        const stage = e.target.closest?.('[data-director-studio-root] [data-director-stage]');
        const stageRoot = stage?.closest?.('[data-director-studio-root]');
        if (!stage || !stageRoot || e.button !== 0) return;

        if (e.target.closest('.director-transform-gizmo')) {
            const activeActor = selectedDirectorActor(stageRoot);
            if (activeActor && !activeActor.classList.contains('is-locked')) {
                beginStudioActorDrag(activeActor, stageRoot, stage, e);
                e.preventDefault();
            }
            return;
        }

        if (e.target.closest('.director-actor, .studio-camera-rig, .director-reset-view, .studio-bottom-toolbar, .studio-add-role-menu, .director-transform-gizmo')) return;

        const hitActor = actorFromStagePointer(stageRoot, stage, e.clientX, e.clientY);
        if (hitActor) {
            beginStudioActorDrag(hitActor, stageRoot, stage, e);
            e.preventDefault();
            return;
        }

        studioOrbit = {
            root: stageRoot,
            stage,
            startX: e.clientX,
            startY: e.clientY,
            startYaw: directorControlValue(stageRoot, 'yaw', controlDefaults.yaw),
            startPitch: directorControlValue(stageRoot, 'pitch', controlDefaults.pitch)
        };
        stage.classList.add('is-orbiting');
        stage.setPointerCapture?.(e.pointerId);
        e.preventDefault();
    });

    document.addEventListener('pointermove', (e) => {
        if (studioDrag?.stage) {
            moveStudioActorToPointer(studioDrag.actor, studioDrag.stage, e.clientX, e.clientY, studioDrag.offsetX, studioDrag.offsetY);
            const gizmo = studioDrag.root.querySelector('[data-director-gizmo]');
            if (gizmo) {
                positionStudioGizmo(studioDrag.root, studioDrag.actor);
            }
            window.Director3D?.syncAll();
            requestAnimationFrame(() => positionStudioGizmo(studioDrag.root, studioDrag.actor));
            return;
        }

        if (studioOrbit?.stage) {
            const dx = e.clientX - studioOrbit.startX;
            const dy = e.clientY - studioOrbit.startY;
            const yaw = clampNumber(studioOrbit.startYaw - dx * 0.28, -180, 180);
            const pitch = clampNumber(studioOrbit.startPitch - dy * 0.18, -35, 45);
            syncStudioCameraControls(studioOrbit.root, { yaw: Math.round(yaw), pitch: Math.round(pitch) });
            e.preventDefault();
        }
    });

    document.addEventListener('pointerup', () => {
        studioOrbit?.stage?.classList.remove('is-orbiting');
        if (studioDrag?.root) persistStudioActors(studioDrag.root);
        studioDrag = null;
        studioOrbit = null;
    });

    document.addEventListener('wheel', (e) => {
        const stage = e.target.closest?.('[data-director-studio-root] [data-director-stage]');
        const root = stage?.closest?.('[data-director-studio-root]');
        if (!stage || !root) return;
        if (e.target.closest('.studio-bottom-toolbar, .studio-add-role-menu, .director-studio-inspector, .director-studio-scene')) return;

        const currentZoom = directorControlValue(root, 'zoom', controlDefaults.zoom);
        const zoom = clampNumber(currentZoom - e.deltaY * 0.12, 35, 120);
        syncStudioCameraControls(root, { zoom: Math.round(zoom) });
        e.preventDefault();
    }, { passive: false });

    document.addEventListener('change', (e) => {
        const input = e.target.closest('[data-director-local-model-input]');
        if (!input) return;
        const root = input.closest('[data-director-studio-root]');
        addUploadedDirectorModel(root, input.files?.[0]);
        input.value = '';
        closeStudioAddRoleMenu(root);
    });

    document.addEventListener('click', (e) => {
        const studioRoot = e.target.closest('[data-director-studio-root]');
        if (studioRoot
            && !e.target.closest('[data-studio-add-role-menu]')
            && !e.target.closest('[data-director-action="add-actor"]')) {
            closeStudioAddRoleMenu(studioRoot);
        }

        const studioViewTab = e.target.closest('[data-studio-view-mode]');
        if (studioViewTab) {
            const root = studioViewTab.closest('[data-director-studio-root]');
            root.dataset.viewMode = studioViewTab.dataset.studioViewMode;
            root.querySelector('[data-director-stage]')?.classList.toggle('is-camera-view', root.dataset.viewMode === 'camera');
            root.querySelector('[data-director-stage]')?.setAttribute('data-director-view-mode', root.dataset.viewMode);
            root.querySelectorAll('[data-studio-view-mode]').forEach(tab => tab.classList.toggle('active', tab === studioViewTab));
            window.Director3D?.syncAll();
            return;
        }

        const inspectorTab = e.target.closest('[data-studio-inspector-tab]');
        if (inspectorTab) {
            const root = inspectorTab.closest('[data-director-studio-root]');
            root.dataset.inspectorTab = inspectorTab.dataset.studioInspectorTab;
            renderStudioInspector(root);
            return;
        }

        const cameraTab = e.target.closest('[data-studio-camera-tab]');
        if (cameraTab) {
            const root = cameraTab.closest('[data-director-studio-root]');
            root.dataset.cameraTab = cameraTab.dataset.studioCameraTab;
            renderStudioInspector(root);
            return;
        }

        const visibilityToggle = e.target.closest('[data-studio-toggle-visibility]');
        if (visibilityToggle) {
            e.preventDefault();
            e.stopPropagation();
            const root = visibilityToggle.closest('[data-director-studio-root]');
            const actor = root.querySelector(`.director-actor[data-actor="${CSS.escape(visibilityToggle.dataset.studioToggleVisibility)}"]`);
            actor?.classList.toggle('is-hidden');
            renderStudioObjectList(root);
            persistStudioActors(root);
            window.Director3D?.syncAll();
            return;
        }

        const lockToggle = e.target.closest('[data-studio-toggle-lock]');
        if (lockToggle) {
            e.preventDefault();
            e.stopPropagation();
            const root = lockToggle.closest('[data-director-studio-root]');
            const actor = root.querySelector(`.director-actor[data-actor="${CSS.escape(lockToggle.dataset.studioToggleLock)}"]`);
            if (!actor) return;
            actor.classList.toggle('is-locked');
            actor.dataset.locked = actor.classList.contains('is-locked') ? 'true' : '';
            renderStudioObjectList(root);
            persistStudioActors(root);
            return;
        }

        const deleteActor = e.target.closest('[data-studio-delete-actor]');
        if (deleteActor) {
            e.preventDefault();
            e.stopPropagation();
            const root = deleteActor.closest('[data-director-studio-root]');
            deleteDirectorActor(root, deleteActor.dataset.studioDeleteActor);
            return;
        }

        const objectRow = e.target.closest('[data-director-object]');
        if (objectRow && objectRow.closest('[data-director-studio-root]')) {
            const root = objectRow.closest('[data-director-studio-root]');
            syncStudioSelection(root, objectRow.dataset.directorObject);
            return;
        }

        const addModelItem = e.target.closest('[data-director-add-model]');
        if (addModelItem) {
            const root = addModelItem.closest('[data-director-studio-root]');
            addDirectorActor(root, addModelItem.dataset.directorAddModel);
            closeStudioAddRoleMenu(root);
            return;
        }

        const modelChip = e.target.closest('[data-director-model]');
        if (modelChip) {
            const { nodeEl } = directorContext(modelChip);
            const actor = selectedDirectorActor(nodeEl);
            applyDirectorModelToActor(nodeEl, actor, getDirectorModel(modelChip.dataset.directorModel));
            if (nodeEl?.matches?.('[data-director-studio-root]')) renderStudioInspector(nodeEl);
            return;
        }

        const poseChip = e.target.closest('[data-director-pose-preset]');
        if (poseChip) {
            const { nodeEl, stage } = directorContext(poseChip);
            const actor = selectedDirectorActor(nodeEl);
            stage?.classList.remove('pose-action', 'pose-cross');
            applyDirectorPoseToActor(nodeEl, actor, getDirectorPose(poseChip.dataset.directorPosePreset));
            if (nodeEl?.matches?.('[data-director-studio-root]')) renderStudioInspector(nodeEl);
            return;
        }

        const shot = e.target.closest('[data-director-shot]');
        if (shot) {
            const { nodeEl } = directorContext(shot);
            if (nodeEl) applyDirectorShot(nodeEl, shot.dataset.directorShot);
            return;
        }

        const actor = e.target.closest('.director-actor');
        if (actor) {
            const { nodeEl } = directorContext(actor);
            nodeEl?.querySelectorAll('.director-actor').forEach(a => a.classList.remove('active'));
            actor.classList.add('active');
            syncDirectorSelectionControls(nodeEl, actor);
            setDirectorStatus(nodeEl, `${actor.querySelector('.actor-name')?.textContent || '角色'} 已选中`);
            if (nodeEl?.matches?.('[data-director-studio-root]')) syncStudioSelection(nodeEl, actor.dataset.actor);
            return;
        }

        const pose = e.target.closest('[data-director-pose]');
        if (pose) {
            const { nodeEl, stage } = directorContext(pose);
            if (!nodeEl || !stage) return;
            nodeEl.querySelectorAll('[data-director-pose]').forEach(btn => btn.classList.remove('active'));
            pose.classList.add('active');
            stage.classList.remove('pose-action', 'pose-cross');
            if (pose.dataset.directorPose === 'action') stage.classList.add('pose-action');
            if (pose.dataset.directorPose === 'cross') stage.classList.add('pose-cross');
            const labels = { neutral: '比例已锁定', action: '动作姿势已应用', cross: '交叉走位已排好' };
            setDirectorStatus(nodeEl, labels[pose.dataset.directorPose] || '站位更新');
            return;
        }

        const action = e.target.closest('[data-director-action]');
        if (!action) return;

        const { nodeEl, nodeId, stage } = directorContext(action);
        if (!nodeEl || !nodeId || !stage) return;
        const sourceNodeId = nodeEl.dataset.sourceNodeId || nodeId;

        switch (action.dataset.directorAction) {
            case 'open-studio':
                openDirectorStudio(nodeEl);
                break;
            case 'close-studio':
                closeDirectorStudio(nodeEl);
                break;
            case 'studio-help':
                showCanvasNotice('导演台当前支持角色、机位、画幅、截图和参考图节点；AI 识图、几何模型和真实视频生成还在接入中。', 'info');
                break;
            case 'move-tool':
                setDirectorStatus(nodeEl, '移动工具已选中');
                showCanvasNotice('移动模式已选中，可以拖动画布视图或调整角色位置。', 'info');
                break;
            case 'take-screenshot':
                takeStudioScreenshot(nodeEl);
                break;
            case 'send-shots':
                sendStudioShotsToCanvas(nodeEl);
                break;
            case 'clear-shots':
                directorStudioState.shots = [];
                updateStudioShotList(nodeEl);
                renderStudioInspector(nodeEl);
                break;
            case 'reset-view':
                ['yaw', 'pitch', 'zoom', 'fov'].forEach(name => {
                    nodeEl.dataset[dataKey(name)] = controlDefaults[name];
                    const input = nodeEl.querySelector(`[data-director-control="${name}"]`);
                    if (input) input.value = controlDefaults[name];
                });
                updateDirectorStage(nodeEl.querySelector('[data-director-props]'));
                window.Director3D?.syncAll();
                break;
            case 'add-camera':
                syncStudioSelection(nodeEl, 'camera-main');
                setDirectorStatus(document.querySelector(`[data-node-id="${sourceNodeId}"]`), '已选中机位1');
                break;
            case 'aspect':
                stage.classList.toggle('is-portrait-frame');
                setDirectorStatus(document.querySelector(`[data-node-id="${sourceNodeId}"]`), stage.classList.contains('is-portrait-frame') ? '画幅切换为竖版' : '画幅切换为横版');
                break;
            case 'ai-import':
                setDirectorStatus(document.querySelector(`[data-node-id="${sourceNodeId}"]`), 'AI识图导入待接入');
                showCanvasNotice('AI 识图导入还没有接入图像理解接口，当前不会解析图片场景。', 'warn');
                break;
            case 'studio-fullscreen':
                nodeEl.classList.toggle('is-expanded');
                break;
            case 'add-actor':
                if (nodeEl.matches('[data-director-studio-root]')) {
                    toggleStudioAddRoleMenu(nodeEl);
                } else {
                    addDirectorActor(nodeEl);
                }
                break;
            case 'local-upload-model':
                nodeEl.querySelector('[data-director-local-model-input]')?.click();
                break;
            case 'add-crowd':
                addDirectorCrowd(nodeEl);
                closeStudioAddRoleMenu(nodeEl);
                break;
            case 'add-geometry':
                setDirectorStatus(document.querySelector(`[data-node-id="${sourceNodeId}"]`), '几何模型待接入');
                showCanvasNotice('几何模型库还没有接入，当前请先用角色、机位和截图能力搭建画面。', 'warn');
                closeStudioAddRoleMenu(nodeEl);
                break;
            case 'panorama':
                stage.classList.toggle('is-panorama');
                setDirectorStatus(nodeEl, stage.classList.contains('is-panorama') ? '720° 全景场景' : '普通场景');
                break;
            case 'storyboard':
                createDirectorOutput(sourceNodeId, 'image', '导演台分镜参考图', `保留角色比例、站位、机位和光比，可作为首帧或首尾帧参考。${directorSummary(nodeEl)}`);
                setDirectorStatus(nodeEl, '已创建参考图节点');
                break;
            case 'video':
                createDirectorOutput(sourceNodeId, 'video', '导演台首尾帧视频节点', `使用当前机位调度作为首尾帧参考，提交后会走 sd2 普通视频生成链路。${directorSummary(nodeEl)}`);
                setDirectorStatus(nodeEl, '已创建首尾帧视频节点');
                showCanvasNotice('已创建首尾帧视频节点，请确认提示词后提交生成。', 'info');
                break;
            case 'grid': {
                const shots = [
                    ['wide', '全景定位图', '交代空间关系与角色比例。'],
                    ['close', '人物特写图', '锁定表演、眼神和脸部朝向。'],
                    ['top', '俯拍走位图', '检查路径、交叉点和构图重心。'],
                    ['reverse', '反打参考图', '为多机位剪辑准备反向镜头。']
                ];
                shots.forEach(([shotKey, title, desc], index) => {
                    applyDirectorShot(nodeEl, shotKey);
                    createDirectorOutput(sourceNodeId, 'image', title, desc, index);
                });
                setDirectorStatus(nodeEl, '四宫格机位完成');
                break;
            }
        }
    });

    // =====================
    // Video props tab clicks
    // =====================
    document.addEventListener('click', (e) => {
        const button = e.target.closest('.video-props-tab');
        if (!button) return;
        const parent = button.closest('.video-props-tabs');
        parent?.querySelectorAll('.video-props-tab').forEach(t => t.classList.remove('active'));
        button.classList.add('active');
        const nodeEl = button.closest('.canvas-node');
        const node = engine.nodes.get(nodeEl?.dataset.nodeId);
        if (node?.type === 'video' && button.dataset.videoMode) {
            node.data = {
                ...node.data,
                mode: button.dataset.videoMode
            };
            renderGenerationNodeControls(node.id);
            scheduleCanvasSave('video_mode_change');
        }
    });

    // =====================
    // Panel tab clicks
    // =====================
    document.addEventListener('click', (e) => {
        const tab = e.target.closest('.panel-tab');
        if (!tab) return;
        const parent = tab.closest('.panel-tabs') || tab.closest('.panel-header');
        parent?.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
    });

    document.addEventListener('click', (e) => {
        const cat = e.target.closest('.asset-cat');
        if (!cat) return;
        cat.closest('.asset-categories')?.querySelectorAll('.asset-cat')
            .forEach(c => c.classList.remove('active'));
        cat.classList.add('active');
    });

    // =====================
    // Toolbox Population
    // =====================
    const toolboxItems = [
        { name: '【预设】左弧推行', g: 'linear-gradient(135deg, #1a1a2e, #16213e)' },
        { name: '【预设】电商手机弹出效果', g: 'linear-gradient(135deg, #2d1b3d, #1a1a2e)' },
        { name: '【预设】咖啡杯出场', g: 'linear-gradient(135deg, #3d2b1b, #1a1a2e)' },
        { name: '【预设】360旋转展示', g: 'linear-gradient(135deg, #1b3d2d, #1a1a2e)' },
        { name: '【预设】机械臂视角', g: 'linear-gradient(135deg, #1a2e3d, #1a1a2e)' },
        { name: '【预设】Live 2D', g: 'linear-gradient(135deg, #3d1b2d, #1a1a2e)' },
        { name: '【预设】商品特写', g: 'linear-gradient(135deg, #2e3d1a, #1a1a2e)' },
        { name: '【预设】电影感开场', g: 'linear-gradient(135deg, #1a2e3d, #3d1a2e)' },
        { name: '【预设】慢动作', g: 'linear-gradient(135deg, #1b2d3d, #1a1a2e)' },
    ];

    const toolboxGrid = document.getElementById('toolbox-grid');
    toolboxItems.forEach(item => {
        const card = document.createElement('div');
        card.className = 'toolbox-card';
        card.innerHTML = `
            <div style="width:100%;height:100%;background:${item.g};display:flex;align-items:center;justify-content:center;">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="1.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </div>
            <div class="toolbox-card-label">${item.name}</div>`;
        card.addEventListener('click', () => {
            const rect = document.getElementById('canvas-container').getBoundingClientRect();
            const x = (rect.width/2 - engine.offsetX)/engine.scale - 140;
            const y = (rect.height/2 - engine.offsetY)/engine.scale - 80;
            engine.addNode('video', x, y, { preset: item.name });
            showPanel(null);
        });
        toolboxGrid.appendChild(card);
    });

    // =====================
    // Zoom and Bottom Toolbar Controls
    // =====================
    document.getElementById('zoom-in')?.addEventListener('click', () => engine.setZoom(engine.scale + 0.1));
    document.getElementById('zoom-out')?.addEventListener('click', () => engine.setZoom(engine.scale - 0.1));

    // Arrange canvas (整理画布): put the tool-flow main path on one lane,
    // keep branches stacked beside it, then fit the result into the viewport.
    document.getElementById('btn-fit')?.addEventListener('click', () => {
        if (!graphEditAllowed()) return;
        const token = graphCommands.begin('整理画布');
        const arranged = engine.arrangeToolflowNodes?.();
        engine.fitView();
        graphCommands.commit(token);
        if (arranged) {
            scheduleCanvasSave('toolflow_layout');
            showCanvasNotice('工具流主路径已整理，分支已并列排开。', 'success');
        }
    });

    // Snapping toggle (吸附)
    document.getElementById('btn-snap')?.addEventListener('click', (e) => {
        const btn = e.currentTarget;
        btn.classList.toggle('active');
        engine.isSnapEnabled = btn.classList.contains('active');
    });

    // Minimap toggle (小地图)
    document.getElementById('btn-minimap')?.addEventListener('click', (e) => {
        const minimap = document.getElementById('canvas-minimap');
        minimap.hidden = !minimap.hidden;
        e.currentTarget.classList.toggle('active', !minimap.hidden);
        e.currentTarget.setAttribute('aria-pressed', String(!minimap.hidden));
        try { localStorage.setItem(minimapKey(), minimap.hidden ? '0' : '1'); } catch {}
        canvasMinimap.render();
    });

    // =====================
    // Keyboard Shortcuts
    // =====================
    document.addEventListener('keydown', (e) => {
        switch (e.key) {
            case 'Escape':
                if (canvasRuntime.referenceSelection) {
                    e.preventDefault();
                    finishReferenceSelection({ restorePrevious: true, returnToTarget: false });
                    return;
                }
                if (canvasRuntime.generationPopover) {
                    e.preventDefault();
                    closeGenerationPopover();
                    return;
                }
                break;
        }
        if (e.key === 'Escape' && document.querySelector('[data-prompt-modal]')) {
            e.preventDefault();
            closePromptModal();
            return;
        }
        if ((e.ctrlKey||e.metaKey) && (e.key==='='||e.key==='+')) { e.preventDefault(); engine.setZoom(engine.scale+0.1); }
        if ((e.ctrlKey||e.metaKey) && e.key==='-') { e.preventDefault(); engine.setZoom(engine.scale-0.1); }
        if ((e.ctrlKey||e.metaKey) && e.key==='0') { e.preventDefault(); engine.setZoom(1); }
        if ((e.ctrlKey||e.metaKey) && e.shiftKey && e.key==='F') { e.preventDefault(); engine.fitView(); }
    });

    // =====================
    // Logo
    // =====================
    document.getElementById('logo')?.addEventListener('click', async () => {
        try { await showManagedLibrary(); }
        catch (error) { showCanvasNotice(error.message || '画布列表打开失败。', 'warn'); }
    });

    // =====================
    // Intro Animation
    // =====================
    setTimeout(() => {
        document.querySelectorAll('.quick-card').forEach((card, i) => {
            card.style.opacity = '0';
            card.style.transform = 'translateY(8px)';
            setTimeout(() => {
                card.style.transition = 'opacity 0.35s ease, transform 0.35s ease';
                card.style.opacity = '1';
                card.style.transform = 'translateY(0)';
            }, 150 + i * 80);
        });
    }, 80);

    console.log('🎬 无限画布 initialized');
})();
