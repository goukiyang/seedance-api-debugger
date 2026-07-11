/**
 * 无线画布 App – Application logic
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

    const canvasRuntime = {
        bootstrap: null,
        bootstrapLoaded: false,
        bootstrapError: null,
        documentId: null,
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
        bootstrapRequestId: 0,
        documentRequestId: 0,
        activeSavePromise: null,
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
        videoCardView: { mode: 'list', section: 'info', cardId: null, search: '' },
        pollingTasks: new Map()
    };

    function configureGenerationEndpoints() {
        if (!window.CanvasGenerationAPI?.configure) return;
        const capabilities = canvasRuntime.bootstrap?.capabilities || {};
        window.CanvasGenerationAPI.configure({
            endpoints: {
                text: capabilities.text?.endpoint || '/api/tools/ultimate-canvas/generate',
                script: capabilities.text?.endpoint || '/api/tools/ultimate-canvas/generate',
                image: capabilities.image?.endpoint || '/api/assets/generate',
                video: capabilities.video?.endpoint || '/api/tasks/create'
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
        const res = await fetch(url, {
            method,
            credentials: 'same-origin',
            headers: {
                ...(options.payload === undefined ? {} : { 'Content-Type': 'application/json' }),
                ...workspaceHeaders(),
                ...(options.headers || {})
            },
            body: options.payload === undefined ? undefined : JSON.stringify(options.payload),
            cache: options.cache
        });
        const text = await res.text();
        let data = {};
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            data = { raw: text };
        }
        if (!res.ok) {
            const message = data?.message || data?.error || `请求失败：${res.status}`;
            const error = new Error(message);
            error.response = data;
            error.status = res.status;
            throw error;
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
            canvasRuntime.videoCardLoadErrors.set(cardId, error);
            throw error;
        }).finally(() => {
            canvasRuntime.videoCardLoads.delete(cardId);
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
        const ids = [];
        if (data.referenceImageId) ids.push(data.referenceImageId);
        if (data.reference_image_id) ids.push(data.reference_image_id);
        if (data.generationResult?.reference_image_id) ids.push(data.generationResult.reference_image_id);
        if (Array.isArray(data.generationResult?.assets)) {
            data.generationResult.assets.forEach(asset => {
                if (asset?.referenceImageId) ids.push(asset.referenceImageId);
                if (asset?.reference_image_id) ids.push(asset.reference_image_id);
            });
        }
        if (Array.isArray(data.referenceImageIds)) ids.push(...data.referenceImageIds);
        if (Array.isArray(data.reference_image_ids)) ids.push(...data.reference_image_ids);
        return ids;
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
        return Number.isFinite(duration) ? Math.max(4, Math.min(15, duration)) : 5;
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
                branchId: canvasRuntime.selectedVideoBranchId,
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
                    return postJson(capabilities.text?.endpoint || '/api/tools/ultimate-canvas/generate', {
                        ...payload,
                        ...baseContextPayload(payload)
                    });
                }

                if (payload.kind === 'image') {
                    const action = imageActionForMode(payload.mode);
                    const data = await postJson(capabilities.image?.endpoint || '/api/assets/generate', {
                        ...baseContextPayload(payload),
                        action,
                        input: {
                            prompt: payload.prompt,
                            ratio: ratioFromContext(),
                            reference_image_ids: collectReferenceImageIds(payload),
                            reference_image_urls: collectReferenceImageUrls(payload),
                            source_nodes: payload.sourceNodes || [],
                            mode: payload.mode,
                            title: payload.title || ''
                        }
                    });
                    const first = data.assets?.[0] || {};
                    return {
                        ...data,
                        status: 'succeeded',
                        message: '图片生成完成，已进入资产库',
                        imageUrl: first.thumbnailUrl || first.originalUrl || data.thumbnail_url || '',
                        previewImage: first.thumbnailUrl || first.originalUrl || '',
                        asset_id: data.asset_id || first.assetId || null,
                        reference_image_id: data.reference_image_id || first.referenceImageId || null,
                        workspace_asset_id: data.workspace_asset_id || first.workspaceAssetId || null
                    };
                }

                if (payload.kind === 'video') {
                    const referenceImageIds = collectReferenceImageIds(payload);
                    const referenceImageUrls = collectReferenceImageUrls(payload);
                    const generationMode = videoModeForCanvasMode(payload.mode);
                    const data = await postJson(capabilities.video?.endpoint || '/api/tasks/create', {
                        ...baseContextPayload(payload),
                        prompt: payload.prompt,
                        generation_mode: generationMode,
                        ratio: ratioFromContext(),
                        duration: durationFromContext(),
                        resolution: resolutionFromContext(),
                        reference_image_ids: referenceImageIds,
                        reference_image_urls: referenceImageIds.length ? [] : referenceImageUrls,
                        idempotency_key: `${payload.nodeId}:${payload.requestId}`,
                        final_prompt_snapshot: payload.prompt,
                        source_metadata: {
                            source: 'ultimate_canvas',
                            canvas_document_id: canvasRuntime.documentId,
                            canvas_node_id: payload.nodeId,
                            mode: payload.mode,
                            workspace_key: canvasWorkspaceKey()
                        }
                    });
                    return {
                        ...data,
                        status: data.status || 'submitted',
                        task_id: data.id,
                        message: '视频任务已提交，正在轮询状态',
                        statusEndpoint: `/api/video/status/${data.id}?refresh=true`
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
        return typeof value === 'string' ? value.trim().slice(0, 4000) : '';
    }

    function contextRulesForNode(node) {
        return normalizeContextRules(node?.data?.contextRules || node?.data?.context_rules);
    }

    function refreshContextRulesButtons(root = document) {
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
                body = branches.length
                    ? `<div class="video-card-branch-list">${branches.map(branch => `
                        <div class="video-card-branch-row ${branch.id === canvasRuntime.selectedVideoBranchId ? 'is-selected' : ''}">
                            <span><strong>${escapeHtml(branch.title || branch.id)}</strong><small>${escapeHtml(branch.status || '')}</small></span>
                            <small>${escapeHtml(branch.summary?.task_count || 0)}</small>
                        </div>`).join('')}</div>`
                    : `<div class="context-menu-empty">${escapeHtml(videoCardUiText.emptyBranches)}</div>`;
            } else if (section === 'tasks') {
                body = tasks.length
                    ? `<div class="video-card-task-list">${tasks.map(task => `
                        <div class="video-card-task-row">
                            <span><strong>${escapeHtml(task.prompt || task.id)}</strong><small>${escapeHtml(task.local_status || task.status || '')}</small></span>
                            <small>${escapeHtml(task.version_role || '')}</small>
                        </div>`).join('')}</div>`
                    : `<div class="context-menu-empty">${escapeHtml(videoCardUiText.emptyTasks)}</div>`;
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
        const previousVideoCardId = canvasRuntime.selectedVideoCardId;
        canvasRuntime.selectedProjectId = project?.id || null;
        canvasRuntime.selectedVideoCardId = videoCard?.id || null;
        if (previousVideoCardId !== canvasRuntime.selectedVideoCardId) {
            canvasRuntime.selectedVideoBranchId = null;
        }
        const documentMeta = data?.context?.canvas_document || null;
        if (canvasRuntime.documentProjectId !== project?.id) {
            canvasRuntime.documentId = documentMeta?.id || null;
            canvasRuntime.documentProjectId = project?.id || null;
            canvasRuntime.documentVideoCardId = null;
            canvasRuntime.documentLoaded = false;
        } else if (!canvasRuntime.documentId && documentMeta?.id) {
            canvasRuntime.documentId = documentMeta.id;
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
        renderContextControls(data);
        configureGenerationEndpoints();
        installGenerationAdapter();
        updateGenerationLabels(data);
        refreshContextRulesButtons();
    }

    function renderContextControls(data) {
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
        const credits = data?.context?.credits || {};
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
        wrap.innerHTML = `
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
            <span class="context-status ${contextReady ? 'ok' : 'warn'}" title="${escapeHtml(contextStatus)}">
                ${escapeHtml(contextStatus)}
            </span>
            <span class="context-status credits" title="可用点数 / 冻结点数">
                可用 ${escapeHtml(formatCredits(credits.available))} 点 · 冻结 ${escapeHtml(formatCredits(credits.frozen_credits))} 点
            </span>
            <button type="button" id="canvas-save-state" data-save-now class="context-status save ${canvasRuntime.saveState}" title="点击立即保存" ${canvasRuntime.contextSwitching ? 'disabled' : ''}>
                ${canvasRuntime.saveState === 'saved' ? '已保存' : canvasRuntime.saveState === 'saving' ? '保存中' : canvasRuntime.saveState === 'error' ? '保存失败' : '未保存'}
            </button>
        `;
    }

    function updateGenerationLabels(data) {
        const caps = data?.capabilities || {};
        document.querySelectorAll('.model-selector span:nth-child(2)').forEach(el => {
            el.textContent = caps.text?.model || 'gpt5.4';
        });
        document.querySelectorAll('.node-type-image .video-model-info span:nth-child(2)').forEach(el => {
            el.textContent = caps.image?.model || caps.image?.label || '图形生成';
        });
        document.querySelectorAll('.node-type-video .video-model-info span:nth-child(2)').forEach(el => {
            el.textContent = caps.video?.model || caps.video?.label || '默认视频 API';
        });
    }

    async function loadCanvasBootstrap(
        projectId = canvasRuntime.selectedProjectId,
        videoCardId = canvasRuntime.selectedVideoCardId,
        options = {}
    ) {
        const requestId = ++canvasRuntime.bootstrapRequestId;
        try {
            const url = new URL('/api/tools/ultimate-canvas/bootstrap', window.location.origin);
            if (projectId) url.searchParams.set('project_id', projectId);
            if (videoCardId) url.searchParams.set('video_card_id', videoCardId);
            const res = await fetch(url.toString(), {
                credentials: 'same-origin',
                cache: 'no-store'
            });
            const text = await res.text();
            let data = {};
            try {
                data = text ? JSON.parse(text) : {};
            } catch {
                data = { raw: text };
            }
            if (!res.ok) {
                throw new Error(data?.error || data?.message || `后台能力读取失败：${res.status}`);
            }
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

    function renderRuntimeContextControls() {
        if (canvasRuntime.bootstrap) renderContextControls(canvasRuntime.bootstrap);
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
    }

    function requestCanvasConfirmation(options = {}) {
        return new Promise(resolve => {
            document.querySelector('[data-canvas-confirm]')?.remove();
            const overlay = document.createElement('div');
            overlay.className = 'canvas-confirm-overlay';
            overlay.dataset.canvasConfirm = 'true';
            overlay.innerHTML = `
                <div class="canvas-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="canvas-confirm-title">
                    <div class="canvas-confirm-head">
                        <strong id="canvas-confirm-title">${escapeHtml(options.title || '确认操作')}</strong>
                        <button type="button" class="canvas-confirm-close" data-confirm-value="false" aria-label="关闭">×</button>
                    </div>
                    <p>${escapeHtml(options.message || '请确认是否继续。')}</p>
                    ${options.detail ? `<div class="canvas-confirm-detail">${escapeHtml(options.detail)}</div>` : ''}
                    <div class="canvas-confirm-actions">
                        <button type="button" class="context-command" data-confirm-value="false">取消</button>
                        <button type="button" class="context-primary-command ${options.danger ? 'danger' : ''}" data-confirm-value="true">${escapeHtml(options.confirmLabel || '确认')}</button>
                    </div>
                </div>`;
            const finish = value => {
                overlay.remove();
                document.removeEventListener('keydown', onKeyDown);
                resolve(value);
            };
            const onKeyDown = event => {
                if (event.key === 'Escape') finish(false);
            };
            overlay.addEventListener('click', event => {
                const value = event.target.closest('[data-confirm-value]')?.dataset.confirmValue;
                if (value) finish(value === 'true');
                else if (event.target === overlay) finish(false);
            });
            document.addEventListener('keydown', onKeyDown);
            document.body.appendChild(overlay);
            overlay.querySelector('[data-confirm-value="true"]')?.focus();
        });
    }

    function clearCanvasForContext() {
        canvasRuntime.documentRestoring = true;
        try {
            engine.restore({ nodes: [], connections: [], viewport: {} });
        } finally {
            canvasRuntime.documentRestoring = false;
        }
    }

    function resetProjectScopedRuntime(projectId) {
        stopAllVideoPolling();
        canvasRuntime.selectedProjectId = projectId || null;
        canvasRuntime.selectedVideoCardId = null;
        canvasRuntime.selectedVideoBranchId = null;
        canvasRuntime.documentId = null;
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
        canvasRuntime.videoCardView = { mode: 'list', section: 'info', cardId: null, search: '' };
    }

    async function switchProjectContext(projectId) {
        if (!projectId || projectId === canvasRuntime.selectedProjectId || canvasRuntime.contextSwitching) {
            closeContextMenus();
            return;
        }
        if (engine.nodes.size > 0 || canvasRuntime.documentId) {
            const confirmed = await requestCanvasConfirmation({
                title: '切换项目',
                message: '当前画布会先保存到原项目，再加载目标项目最近的画布。两个项目的节点和素材不会混用。',
                detail: `当前：${projectDisplayNameFor(selectedProject())}`,
                confirmLabel: '保存并切换'
            });
            if (!confirmed) return;
        }
        canvasRuntime.openContextMenu = null;
        canvasRuntime.projectCreateOpen = false;
        setContextSwitching(true);
        try {
            const saved = await flushCanvasSave('before_project_change');
            if (!saved) throw new Error('当前画布保存失败，已取消切换项目，避免内容错存。');
            resetProjectScopedRuntime(projectId);
            clearCanvasForContext();
            canvasRuntime.bootstrapLoaded = false;
            const data = await loadCanvasBootstrap(projectId, null, { restoreDocument: true, clearWhenMissing: true });
            if (!data) throw new Error('项目切换失败，请稍后重试。');
            showCanvasNotice(`已切换到「${projectDisplayNameFor(selectedProject())}」`, 'info');
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
        canvasRuntime.videoCardCreateOpen = false;
        setContextSwitching(true);
        try {
            const saved = await flushCanvasSave('before_video_card_change');
            if (!saved) throw new Error('当前画布保存失败，已取消切换视频卡。');
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
            resetProjectScopedRuntime(data.project.id);
            clearCanvasForContext();
            canvasRuntime.bootstrapLoaded = false;
            await loadCanvasBootstrap(data.project.id, null, { restoreDocument: true, clearWhenMissing: true });
            showCanvasNotice(`已新建并切换到「${data.project.name}」`, 'info');
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
    loadCanvasBootstrap();

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
        const el = document.getElementById('canvas-save-state');
        if (!el) return;
        const labels = {
            idle: '未保存',
            saving: '保存中',
            saved: '已保存',
            error: '保存失败'
        };
        el.textContent = labels[canvasRuntime.saveState] || '未保存';
        el.className = `context-status save ${canvasRuntime.saveState}`;
        if (canvasRuntime.saveError) el.title = canvasRuntime.saveError;
    }

    function syncNodeDataFromDom(nodeId, node) {
        const nodeEl = document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
        if (!nodeEl || !node) return;
        const prompt = collectNodePrompt(nodeEl, node.type);
        const label = nodeEl.querySelector('.node-label')?.textContent?.trim() || '';
        const tabText = activeTabText(nodeEl);
        const contextRules = contextRulesForNode(node);
        node.data = {
            ...node.data,
            title: node.data?.title || label,
            prompt: prompt || node.data?.prompt || '',
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
            savedAt: new Date().toISOString(),
            context: {
                project_id: context.projectId ?? canvasRuntime.selectedProjectId,
                video_card_id: context.videoCardId ?? canvasRuntime.selectedVideoCardId,
                video_branch_id: canvasRuntime.selectedVideoBranchId || null
            },
            canvas: engine.serialize()
        };
    }

    async function saveCanvasDocument(reason = 'autosave') {
        if (canvasRuntime.documentRestoring) return true;
        if (!canvasRuntime.bootstrapLoaded || !canvasRuntime.selectedProjectId) return true;
        const projectId = canvasRuntime.selectedProjectId;
        const videoCardId = canvasRuntime.selectedVideoCardId;
        const videoBranchId = canvasRuntime.selectedVideoBranchId;
        const contextKey = `${projectId}:${videoCardId || ''}:${videoBranchId || ''}`;
        const documentId = canvasRuntime.documentProjectId === projectId ? canvasRuntime.documentId : null;
        if (!engine.nodes.size && !documentId) return true;
        canvasRuntime.saveState = 'saving';
        canvasRuntime.saveError = null;
        updateSaveIndicator();
        const payload = canvasDocumentPayload({ projectId, videoCardId });
        const savePromise = postJson('/api/tools/ultimate-canvas/document', {
            document_id: documentId,
            project_id: projectId,
            title: selectedVideoCard()?.title ? `无线画布 / ${selectedVideoCard().title}` : '无线画布',
            active_generation_node_id: engine.selectedNodeId,
            document_json: JSON.stringify(payload),
            save_reason: reason
        });
        canvasRuntime.activeSavePromise = savePromise;
        try {
            const result = await savePromise;
            const currentContextKey = `${canvasRuntime.selectedProjectId || ''}:${canvasRuntime.selectedVideoCardId || ''}:${canvasRuntime.selectedVideoBranchId || ''}`;
            if (currentContextKey === contextKey) {
                canvasRuntime.documentId = result.document?.id || documentId || canvasRuntime.documentId;
                canvasRuntime.documentProjectId = projectId;
                canvasRuntime.documentVideoCardId = videoCardId;
                canvasRuntime.saveState = 'saved';
                canvasRuntime.saveError = null;
            }
            return true;
        } catch (error) {
            if (canvasRuntime.selectedProjectId === projectId) {
                canvasRuntime.saveState = 'error';
                canvasRuntime.saveError = error?.message || '保存失败';
                showCanvasNotice(canvasRuntime.saveError, 'warn');
            }
            return false;
        } finally {
            if (canvasRuntime.activeSavePromise === savePromise) canvasRuntime.activeSavePromise = null;
            updateSaveIndicator();
        }
    }

    async function flushCanvasSave(reason = 'flush') {
        window.clearTimeout(canvasRuntime.saveTimer);
        canvasRuntime.saveTimer = null;
        if (canvasRuntime.activeSavePromise) {
            try {
                await canvasRuntime.activeSavePromise;
            } catch {
                // saveCanvasDocument 会统一呈现错误；继续补一次最终保存。
            }
        }
        return saveCanvasDocument(reason);
    }

    function scheduleCanvasSave(reason = 'change') {
        if (canvasRuntime.documentRestoring) return;
        window.clearTimeout(canvasRuntime.saveTimer);
        if (canvasRuntime.saveState === 'saved') {
            canvasRuntime.saveState = 'idle';
            updateSaveIndicator();
        }
        canvasRuntime.saveTimer = window.setTimeout(() => saveCanvasDocument(reason), 900);
    }

    function hydrateNodeViews() {
        engine.nodes.forEach((node) => {
            const nodeEl = document.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`);
            if (!nodeEl) return;
            if (node.data?.generationStatus === 'failed') {
                setNodeGenerationStatus(nodeEl, 'error', node.data.generationError || '上次生成失败，输入和素材已保留');
            } else if (node.data?.generationStatus === 'succeeded') {
                setNodeGenerationStatus(nodeEl, 'success', '生成已完成');
            } else if (node.data?.generationStatus && node.data.generationStatus !== 'idle') {
                setNodeGenerationStatus(nodeEl, 'loading', `任务${node.data.generationStatus}`);
            }
            if (node.type === 'image') {
                syncImageModeButtons(nodeEl, node.data?.mode || 'text-to-image');
            }
            if ((node.type === 'text' || node.type === 'script') && node.data?.generatedText) {
                applyTextGenerationResult(nodeEl, {
                    nodeId: node.id,
                    kind: node.type,
                    prompt: node.data.prompt || ''
                }, {
                    title: node.data.title,
                    text: node.data.generatedText,
                    summary: node.data.generationSummary,
                    status: node.data.generationStatus || 'succeeded'
                });
                return;
            }
            if (node.type === 'image' && (node.data?.previewImage || node.data?.thumbnailUrl)) {
                decorateGeneratedNode(
                    node.id,
                    node.data.title || '图片生成结果',
                    node.data.description || node.data.prompt || '已恢复图片节点',
                    node.data.previewImage || node.data.thumbnailUrl || ''
                );
                return;
            }
            if (node.type === 'video' && node.data?.taskId) {
                decorateGeneratedNode(
                    node.id,
                    node.data.generationStatus === 'succeeded' ? '视频生成完成' : '视频生成任务',
                    node.data.description || `任务状态：${node.data.generationStatus || 'submitted'}`,
                    node.data.thumbnailUrl || '',
                    {
                        taskId: node.data.taskId,
                        videoUrl: node.data.videoPreviewUrl || '',
                        downloadUrl: node.data.videoDownloadUrl || `/api/video/download/${node.data.taskId}`
                    }
                );
                if (!['succeeded', 'failed', 'cancelled'].includes(node.data.generationStatus)) {
                    pollVideoTask(node.data.taskId, node.id);
                }
            }
        });
    }

    async function loadCanvasDocument(options = {}) {
        if (!canvasRuntime.selectedProjectId || canvasRuntime.documentLoaded) return;
        const projectId = canvasRuntime.selectedProjectId;
        const requestId = ++canvasRuntime.documentRequestId;
        try {
            const url = new URL('/api/tools/ultimate-canvas/document', window.location.origin);
            url.searchParams.set('project_id', projectId);
            const res = await fetch(url.toString(), { credentials: 'same-origin', cache: 'no-store' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || data?.message || `画布读取失败：${res.status}`);
            if (requestId !== canvasRuntime.documentRequestId || projectId !== canvasRuntime.selectedProjectId) return;
            canvasRuntime.documentLoaded = true;
            if (!data.document?.document_json) {
                if (options.clearWhenMissing !== false) {
                    stopAllVideoPolling();
                    clearCanvasForContext();
                }
                canvasRuntime.documentId = null;
                canvasRuntime.documentProjectId = projectId;
                canvasRuntime.documentVideoCardId = canvasRuntime.selectedVideoCardId;
                canvasRuntime.saveState = 'idle';
                updateSaveIndicator();
                return;
            }
            const parsed = JSON.parse(data.document.document_json);
            const savedProjectId = parsed?.context?.project_id || data.document.project_id;
            if (savedProjectId && savedProjectId !== projectId) {
                throw new Error('画布文档归属与当前项目不一致，已停止恢复。');
            }
            canvasRuntime.documentId = data.document.id;
            canvasRuntime.documentProjectId = projectId;
            canvasRuntime.documentVideoCardId = parsed?.context?.video_card_id || canvasRuntime.selectedVideoCardId;
            const savedVideoBranchId = parsed?.context?.video_branch_id || null;
            canvasRuntime.selectedVideoBranchId = savedVideoBranchId;
            if (savedVideoBranchId && canvasRuntime.selectedVideoCardId) {
                try {
                    const workspace = await loadVideoCardWorkspace(canvasRuntime.selectedVideoCardId);
                    canvasRuntime.selectedVideoBranchId = window.UltimateCanvasVideoCards.chooseBranch(
                        workspace?.branches || [],
                        savedVideoBranchId
                    ) || null;
                } catch (error) {
                    canvasRuntime.selectedVideoBranchId = null;
                    showCanvasNotice(error?.message || '\u89c6\u9891\u65b9\u5411\u6062\u590d\u5931\u8d25\uff0c\u5df2\u56de\u9000\u5230\u9ed8\u8ba4\u65b9\u5411\u3002', 'warn');
                }
            }
            canvasRuntime.documentRestoring = true;
            stopAllVideoPolling();
            engine.restore(parsed.canvas || parsed);
            hydrateNodeViews();
            refreshContextRulesButtons();
            canvasRuntime.saveState = 'saved';
            canvasRuntime.saveError = null;
        } catch (error) {
            if (requestId !== canvasRuntime.documentRequestId || projectId !== canvasRuntime.selectedProjectId) return;
            canvasRuntime.saveState = 'error';
            canvasRuntime.saveError = error?.message || '画布恢复失败';
            showCanvasNotice(canvasRuntime.saveError, 'warn');
        } finally {
            if (requestId === canvasRuntime.documentRequestId) {
                canvasRuntime.documentRestoring = false;
                updateSaveIndicator();
            }
        }
    }

    function installAutosaveHooks() {
        const originalAddNode = engine.addNode.bind(engine);
        engine.addNode = (...args) => {
            const nodeId = originalAddNode(...args);
            refreshContextRulesButtons();
            scheduleCanvasSave('node_add');
            return nodeId;
        };
        const originalDeleteNode = engine.deleteNode.bind(engine);
        engine.deleteNode = (...args) => {
            const result = originalDeleteNode(...args);
            scheduleCanvasSave('node_delete');
            return result;
        };
        const originalCreateConnection = engine._createConnection.bind(engine);
        engine._createConnection = (...args) => {
            const result = originalCreateConnection(...args);
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
    }

    document.addEventListener('input', (event) => {
        if (event.target.closest('.canvas-node')) scheduleCanvasSave('node_input');
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
            <button class="canvas-library-item" data-library-id="${escapeHtml(item.id)}">
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
        const res = await fetch(url.toString(), { credentials: 'same-origin', cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.message || data?.error || `资产加载失败：${res.status}`);
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
        const nodeId = engine.addNode(isVideo ? 'video' : 'image', center.x, center.y, {
            title: item.title,
            prompt: item.prompt || item.title,
            description: item.prompt || item.title,
            assetId: item.assetId || null,
            referenceImageId: item.referenceImageId || null,
            workspaceAssetId: item.workspaceAssetId || item.workspace_asset_id || null,
            taskId: item.taskId || null,
            previewImage: itemPreview(item),
            thumbnailUrl: item.thumbnailUrl || itemPreview(item),
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
            } : {}
        );
        showPanel(null);
        scheduleCanvasSave('library_item_add');
    }

    document.addEventListener('click', (event) => {
        const libraryItem = event.target.closest('.canvas-library-item');
        if (!libraryItem) return;
        const itemId = libraryItem.dataset.libraryId;
        const item = [...(canvasRuntime.libraryItems || []), ...(canvasRuntime.historyItems || [])]
            .find(entry => entry.id === itemId);
        createNodeFromLibraryItem(item);
    });

    async function uploadCanvasFile(file, role = '', canvasNodeId = '') {
        if (!canvasRuntime.selectedProjectId || !canvasRuntime.selectedVideoCardId) {
            throw new Error('请先选择项目和视频卡，再上传素材。');
        }
        const formData = new FormData();
        formData.set('file', file);
        formData.set('project_id', canvasRuntime.selectedProjectId);
        formData.set('video_card_id', canvasRuntime.selectedVideoCardId);
        if (canvasRuntime.documentId) formData.set('canvas_document_id', canvasRuntime.documentId);
        if (canvasNodeId) formData.set('canvas_node_id', canvasNodeId);
        if (role) formData.set('role', role);
        const res = await fetch('/api/tools/ultimate-canvas/upload', {
            method: 'POST',
            credentials: 'same-origin',
            body: formData
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.message || data?.error || `上传失败：${res.status}`);
        return data;
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
            videoPreviewUrl: type === 'video' ? asset.originalUrl || '' : '',
            source: 'upload'
        });
        decorateGeneratedNode(
            nodeId,
            asset.fileName || '上传素材',
            uploadResult.reference_image_id ? '已上传并可作为生成参考图。' : '已上传到站内资产库。',
            imagePreview
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
                data: node.data || {}
            }));
    }

    function collectNodePrompt(nodeEl, type) {
        if (type === 'video') return textFrom(nodeEl, '.video-props-textarea');
        if (type === 'image') return textFrom(nodeEl, '.image-props-textarea');
        return nodeEl.querySelector('.node-text-content')?.textContent.trim()
            || textFrom(nodeEl, '.node-input-textarea');
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
        const mode = node.data?.generationIntent?.mode || node.data?.mode || (isVideo
            ? (generationModeMap[tabText] || 'text-to-video')
            : isImage ? 'text-to-image' : 'text');
        const contextRules = contextRulesForNode(node);

        return {
            nodeId,
            kind,
            mode,
            modeLabel: tabText || mode,
            prompt: prompt || node.data?.prompt || node.data?.description || '',
            contextRules,
            context_rules: contextRules,
            model: nodeEl.querySelector('.video-model-info, .model-selector')?.textContent.trim() || '',
            spec: nodeEl.querySelector('.video-res-info')?.textContent.trim() || '',
            sourceNodes: nodeSourcePayloads(nodeId),
            cameraPresets: node.data?.cameraPresets || [],
            referenceImage: node.data?.previewImage || node.data?.referenceImage || '',
            source: node.data?.source || '',
            title: node.data?.title || ''
        };
    }

    function setSubmitLoading(button, loading) {
        button.disabled = loading;
        button.classList.toggle('is-loading', loading);
        button.dataset.originalTitle ||= button.title || '';
        button.title = loading ? '接口调用中' : button.dataset.originalTitle;
    }

    function setNodeGenerationStatus(nodeEl, state, message) {
        if (!nodeEl) return;
        const panel = nodeEl.querySelector('.node-input-bar, .node-video-props, .node-image-props');
        if (!panel) return;
        let status = panel.querySelector('.node-generation-status');
        if (!message) {
            status?.remove();
            return;
        }
        if (!status) {
            status = document.createElement('div');
            panel.prepend(status);
        }
        status.className = `node-generation-status ${state || 'info'}`;
        status.textContent = message;
        status.title = message;
    }

    function generatedTextFromResult(result) {
        return (result?.text || result?.content || result?.message || '').trim();
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
            body.innerHTML = `
                <div class="node-text-content generated-text-content" contenteditable="true"
                     data-placeholder="LLM 生成内容">
                    ${escapeHtml(generatedText)}
                </div>`;
        }

        if (node) {
            node.data = {
                ...node.data,
                title,
                prompt: payload.prompt,
                description: generatedText,
                generatedText,
                generationSummary: summary,
                generationPayload: payload,
                generationResult: result,
                generationStatus: result?.status || 'succeeded'
            };
        }

        setNodeGenerationStatus(nodeEl, 'success', result?.message || '文本生成完成');
        showCanvasNotice(result?.message || 'LLM 生成完成', 'info');
        scheduleCanvasSave('text_generation');
    }

    function videoPreviewForTask(task) {
        if (!task?.id) return '';
        if (task.local_status === 'succeeded' || task.result_video_url || task.local_video_path || task.result_last_frame_url) {
            return `/api/video/thumbnail/${task.id}`;
        }
        return '';
    }

    function taskDescription(task) {
        const status = task?.local_status || task?.status || 'submitted';
        if (status === 'succeeded') return '视频已生成，可预览、下载并在任务记录中追溯。';
        if (status === 'failed') return task?.error_message || '视频生成失败，冻结点数会按后端规则释放。';
        if (status === 'cancelled') return '视频任务已取消。';
        return `任务状态：${status}，正在等待生成结果。`;
    }

    function applyImageGenerationResult(nodeEl, payload, result) {
        const node = engine.nodes.get(payload.nodeId);
        const imageUrl = result?.previewImage || result?.imageUrl || result?.assets?.[0]?.thumbnailUrl || result?.assets?.[0]?.originalUrl || '';
        const title = result?.assets?.[0]?.fileName || '图片生成结果';
        const desc = result?.message || `${payload.modeLabel || payload.mode} 已完成并写入资产库`;
        if (node) {
            node.data = {
                ...node.data,
                title,
                prompt: payload.prompt,
                previewImage: imageUrl,
                referenceImage: imageUrl,
                assetId: result?.asset_id || result?.assets?.[0]?.assetId || null,
                referenceImageId: result?.reference_image_id || result?.assets?.[0]?.referenceImageId || null,
                workspaceAssetId: result?.workspace_asset_id || result?.assets?.[0]?.workspaceAssetId || null,
                generationPayload: payload,
                generationResult: result,
                generationStatus: 'succeeded'
            };
        }
        decorateGeneratedNode(payload.nodeId, title, desc, imageUrl);
        setNodeGenerationStatus(nodeEl, 'success', '图片生成完成并已入库');
        showCanvasNotice('图片生成完成，已进入资产库。', 'info');
        scheduleCanvasSave('image_generation');
        loadLibraryPanels(true);
    }

    function videoStatusUrl(taskId) {
        const template = canvasRuntime.bootstrap?.capabilities?.video?.status_endpoint_template
            || '/api/video/status/:taskId?refresh=true';
        return template.replace(':taskId', encodeURIComponent(taskId));
    }

    function stopVideoPolling(taskId) {
        const state = canvasRuntime.pollingTasks.get(taskId);
        if (!state) return;
        state.stopped = true;
        window.clearTimeout(state.timer);
        canvasRuntime.pollingTasks.delete(taskId);
    }

    function stopAllVideoPolling() {
        Array.from(canvasRuntime.pollingTasks.keys()).forEach(stopVideoPolling);
    }

    async function pollVideoTask(taskId, nodeId) {
        if (!taskId || canvasRuntime.pollingTasks.has(taskId)) return;
        const state = {
            attempt: 0,
            errorCount: 0,
            timer: null,
            stopped: false
        };
        canvasRuntime.pollingTasks.set(taskId, state);
        const maxAttempts = 120;

        const schedule = delay => {
            if (state.stopped) return;
            state.timer = window.setTimeout(poll, delay);
        };

        const poll = async () => {
            if (state.stopped) return;
            if (!engine.nodes.has(nodeId)) {
                stopVideoPolling(taskId);
                return;
            }
            state.attempt += 1;
            const nodeEl = document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
            setNodeGenerationStatus(nodeEl, 'loading', `视频生成中 · 第 ${state.attempt} 次状态检查`);
            try {
                const res = await fetch(videoStatusUrl(taskId), {
                    credentials: 'same-origin',
                    cache: 'no-store'
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data?.message || data?.error || `状态读取失败：${res.status}`);
                state.errorCount = 0;
                const task = data?.task || data;
                applyVideoTaskStatus(nodeId, task);
                const status = task.local_status || task.status;
                if (['succeeded', 'failed', 'cancelled'].includes(status)) {
                    stopVideoPolling(taskId);
                    loadLibraryPanels(true);
                    return;
                }
                if (state.attempt >= maxAttempts) {
                    stopVideoPolling(taskId);
                    setNodeGenerationStatus(nodeEl, 'warn', '轮询已暂停，可刷新页面继续查询任务状态');
                    return;
                }
                const delay = document.hidden ? 15000 : state.attempt < 4 ? 3000 : state.attempt < 20 ? 5000 : 8000;
                schedule(delay);
            } catch (error) {
                state.errorCount += 1;
                setNodeGenerationStatus(nodeEl, 'warn', `状态读取失败，正在自动重试（${state.errorCount}）`);
                if (state.errorCount === 3) {
                    showCanvasNotice(error?.message || '视频状态轮询暂时失败，正在自动重试。', 'warn');
                }
                if (state.attempt >= maxAttempts) {
                    stopVideoPolling(taskId);
                    setNodeGenerationStatus(nodeEl, 'warn', '轮询已暂停，可刷新页面继续查询任务状态');
                    return;
                }
                schedule(Math.min(20000, 5000 * state.errorCount));
            }
        };

        await poll();
    }

    function applyVideoTaskStatus(nodeId, task) {
        const node = engine.nodes.get(nodeId);
        if (!node || !task?.id) return;
        const previousStatus = node.data?.generationStatus;
        const nextStatus = task.local_status || task.status || previousStatus;
        const preview = videoPreviewForTask(task);
        node.data = {
            ...node.data,
            taskId: task.id,
            providerTaskId: task.provider_task_id || node.data.providerTaskId || null,
            generationStatus: nextStatus,
            videoPreviewUrl: task.result_video_url ? `/api/video/play/${task.id}` : node.data.videoPreviewUrl,
            videoDownloadUrl: `/api/video/download/${task.id}`,
            thumbnailUrl: preview || node.data.thumbnailUrl,
            generationResult: {
                ...(node.data.generationResult || {}),
                ...task
            }
        };
        decorateGeneratedNode(
            nodeId,
            task.local_status === 'succeeded' ? '视频生成完成' : '视频生成任务',
            taskDescription(task),
            preview,
            {
                taskId: task.id,
                videoUrl: task.local_status === 'succeeded' || task.result_video_url ? `/api/video/play/${task.id}` : '',
                downloadUrl: `/api/video/download/${task.id}`
            }
        );
        const nodeEl = document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
        if (nextStatus === 'succeeded') setNodeGenerationStatus(nodeEl, 'success', '视频生成完成');
        else if (nextStatus === 'failed') setNodeGenerationStatus(nodeEl, 'error', task.error_message || '视频生成失败');
        else if (nextStatus === 'cancelled') setNodeGenerationStatus(nodeEl, 'warn', '视频任务已取消');
        else setNodeGenerationStatus(nodeEl, 'loading', `视频任务${nextStatus || '处理中'}`);
        if (nextStatus !== previousStatus || ['succeeded', 'failed', 'cancelled'].includes(nextStatus)) {
            scheduleCanvasSave('video_status');
        }
    }

    function applyVideoGenerationResult(nodeEl, payload, result) {
        const node = engine.nodes.get(payload.nodeId);
        if (node) {
            node.data = {
                ...node.data,
                prompt: payload.prompt,
                taskId: result?.task_id || result?.id || null,
                providerTaskId: result?.provider_task_id || null,
                frozenCost: result?.frozen_cost || null,
                generationPayload: payload,
                generationResult: result,
                generationStatus: result?.status || 'submitted'
            };
        }
        decorateGeneratedNode(
            payload.nodeId,
            '视频生成任务',
            result?.message || `任务已提交：${result?.task_id || result?.id || '等待返回任务 ID'}`,
            '',
            {
                taskId: result?.task_id || result?.id || null
            }
        );
        setNodeGenerationStatus(nodeEl, 'loading', '视频任务已提交，正在查询状态');
        showCanvasNotice(result?.message || '视频任务已提交。', 'info');
        scheduleCanvasSave('video_generation');
        if (result?.task_id || result?.id) pollVideoTask(result.task_id || result.id, payload.nodeId);
    }

    function applyGenerationResult(nodeEl, payload, result) {
        const node = engine.nodes.get(payload.nodeId);
        if (node) {
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
        const project = selectedProject();
        const card = selectedVideoCard();
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
            if (!capabilities.image?.enabled) {
                return {
                    ready: false,
                    message: capabilities.image?.message || '图形生成能力未配置，请先到后台 API 设置完成配置。'
                };
            }
            if (payload.mode === 'upscale-image'
                && collectReferenceImageIds(payload).length === 0
                && collectReferenceImageUrls(payload).length === 0) {
                return { ready: false, message: '高清修复需要先连接一张已上传或已生成的图片。' };
            }
            return { ready: true };
        }

        if (payload.kind === 'video') {
            if (!capabilities.video?.enabled) {
                return {
                    ready: false,
                    message: capabilities.video?.message || '默认视频 API 未配置，暂不能创建视频任务。'
                };
            }
            if (payload.mode === 'first-last-frame-video' && collectReferenceImageIds(payload).length === 0 && collectReferenceImageUrls(payload).length === 0) {
                return {
                    ready: false,
                    message: '首尾帧视频至少需要连接一张图片作为首帧；连接第二张图片会作为尾帧。'
                };
            }
            return { ready: true };
        }

        return {
            ready: false,
            message: '当前节点类型还没有正式生成接口。'
        };
    }

    async function submitNodeGeneration(nodeEl, button) {
        const api = window.CanvasGenerationAPI;
        const payload = collectGenerationPayload(nodeEl);
        if (!api || !payload) return;

        const readiness = generationReadiness(payload);
        if (!readiness.ready) {
            showCanvasNotice(readiness.message, 'warn');
            return;
        }

        setSubmitLoading(button, true);
        setNodeGenerationStatus(nodeEl, 'loading', '正在提交生成请求');
        try {
            const result = await api.generate(payload);
            applyGenerationResult(nodeEl, payload, result);
        } catch (error) {
            const node = engine.nodes.get(payload.nodeId);
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
        } finally {
            setSubmitLoading(button, false);
        }
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
        scheduleCanvasSave('image_mode_change');
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
        const model = nodeEl.querySelector('.video-model-info, .model-selector')?.textContent.trim() || '';
        const spec = nodeEl.querySelector('.video-res-info')?.textContent.trim() || '';
        const sourceNodes = nodeSourcePayloads(nodeId);
        const prompt = promptValueFor(nodeEl, node);
        const tabs = promptTabsFor(nodeEl, node);
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
            rules: contextRulesForNode(node)
        };
    }

    function buildContextRulesModal(ctx) {
        return `
            <div class="context-rules-modal-overlay" data-context-rules-modal data-node-id="${escapeHtml(ctx.nodeId)}">
                <section class="context-rules-modal" role="dialog" aria-modal="true" aria-label="LLM 上下文规则">
                    <header class="context-rules-modal-header">
                        <div>
                            <span>LLM 上下文规则</span>
                            <strong>${escapeHtml(ctx.label)}</strong>
                        </div>
                        <button class="context-rules-close" data-context-rules-close title="关闭">×</button>
                    </header>
                    <div class="context-rules-modal-body">
                        <main class="context-rules-editor">
                            <label>
                                <span>影响本节点 LLM 的规则文本</span>
                                <textarea data-context-rules-textarea placeholder="写清这条文本节点生成时必须遵守的上下文规则，例如品牌语气、禁用表达、输出格式、角色设定或必须保留的信息。">${escapeHtml(ctx.rules)}</textarea>
                            </label>
                            <div class="context-rules-preview">
                                <span>当前用户输入</span>
                                <p>${escapeHtml(ctx.prompt || '还没有输入内容')}</p>
                            </div>
                        </main>
                        <aside class="context-rules-side">
                            <div>
                                <span>权限</span>
                                <strong>仅管理员可编辑</strong>
                            </div>
                            <div>
                                <span>保存</span>
                                <strong>随画布自动保存</strong>
                            </div>
                            <div>
                                <span>生效</span>
                                <strong>生成时写入 LLM 上下文</strong>
                            </div>
                        </aside>
                    </div>
                    <footer class="context-rules-modal-footer">
                        <button class="context-rules-secondary" data-context-rules-clear>清空规则</button>
                        <button class="context-rules-secondary" data-context-rules-cancel>取消</button>
                        <button class="context-rules-primary" data-context-rules-save>保存规则</button>
                    </footer>
                </section>
            </div>
        `;
    }

    function closeContextRulesModal() {
        document.querySelector('[data-context-rules-modal]')?.remove();
        document.body.classList.remove('context-rules-modal-open');
    }

    function openContextRulesModal(nodeEl) {
        if (!isCanvasAdmin()) {
            showCanvasNotice('只有管理员可以编辑 LLM 上下文规则。', 'warn');
            return;
        }
        const ctx = contextRulesContextFor(nodeEl);
        if (!ctx) return;
        closeContextRulesModal();
        document.body.insertAdjacentHTML('beforeend', buildContextRulesModal(ctx));
        document.body.classList.add('context-rules-modal-open');
        const textarea = document.querySelector('[data-context-rules-textarea]');
        textarea?.focus();
        textarea?.setSelectionRange?.(textarea.value.length, textarea.value.length);
    }

    function saveContextRulesModal(modal) {
        const nodeId = modal.dataset.nodeId;
        const nodeEl = document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
        const node = engine.nodes.get(nodeId);
        if (!nodeEl || !node) return;
        const rules = normalizeContextRules(modal.querySelector('[data-context-rules-textarea]')?.value || '');
        node.data = {
            ...node.data,
            contextRules: rules,
            contextRulesUpdatedAt: rules ? new Date().toISOString() : null
        };
        refreshContextRulesButtons();
        scheduleCanvasSave('context_rules_change');
        showCanvasNotice(rules ? '上下文规则已保存' : '上下文规则已清空', 'info');
    }

    function closePromptModal() {
        document.querySelector('[data-prompt-modal]')?.remove();
        document.body.classList.remove('prompt-modal-open');
    }

    function openPromptModal(nodeEl) {
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
        syncPromptTabToNode(modal, nodeEl, node);

        const generatedText = nodeEl.querySelector('.generated-reference-card p');
        if (generatedText && prompt) generatedText.textContent = prompt;
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
            if (e.target.closest('[data-context-rules-close], [data-context-rules-cancel]')) {
                closeContextRulesModal();
                return;
            }
            if (e.target.closest('[data-context-rules-clear]')) {
                const textarea = contextRulesModal.querySelector('[data-context-rules-textarea]');
                if (textarea) textarea.value = '';
                return;
            }
            if (e.target.closest('[data-context-rules-save]')) {
                saveContextRulesModal(contextRulesModal);
                closeContextRulesModal();
                return;
            }
        }

        const promptExpand = e.target.closest('[data-prompt-expand], .prompt-card-expand');
        if (promptExpand) {
            const nodeEl = promptExpand.closest('.canvas-node');
            if (nodeEl && promptContextFor(nodeEl)) {
                e.preventDefault();
                e.stopPropagation();
                openPromptModal(nodeEl);
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

    function showPanel(panelId) {
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
    }

    toolbarBtns.forEach(btn => {
        btn.addEventListener('click', () => showPanel(btn.dataset.panel));
    });

    document.querySelectorAll('.panel-close').forEach(btn => {
        btn.addEventListener('click', () => showPanel(null));
    });

    function connectMenuNode(newNodeId, pendingConnection) {
        if (!newNodeId || !pendingConnection?.nodeId) return;
        if (pendingConnection.role === 'input') {
            engine._createConnection(newNodeId, pendingConnection.nodeId);
        } else {
            engine._createConnection(pendingConnection.nodeId, newNodeId);
        }
    }

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
        if (!item) return;

        const type = item.dataset.nodeType;
        const action = item.dataset.action;
        const menu = document.getElementById('add-node-menu');
        const cx = menu._canvasX || 400;
        const cy = menu._canvasY || 300;
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
            const newNodeId = engine.addNode(type, cx - placement.x, cy - placement.y);
            connectMenuNode(newNodeId, pendingConnection);
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
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const requestedNodeId = `node-upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
            try {
                showCanvasNotice('正在上传素材...', 'info');
                const result = await uploadCanvasFile(file, '', requestedNodeId);
                createUploadedNode(result, cx, cy, pendingConnection, requestedNodeId);
                showCanvasNotice(result.asset?.warning || '素材上传完成，已加入画布。', result.asset?.warning ? 'warn' : 'info');
            } catch (error) {
                showCanvasNotice(error?.message || '上传失败。', 'error');
            }
        };
        input.click();
    }

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
                case 'script-gen': engine.addNode('script', cx - 100, cy - 80); break;
                case 'character': engine.addNode('image', cx - 100, cy - 80); break;
                case 'auto-video':
                    const tid = engine.addNode('text', cx - 360, cy - 60);
                    const vid = engine.addNode('video', cx + 120, cy - 60);
                    engine._createConnection(tid, vid);
                    break;
                case 'music': engine.addNode('audio', cx - 100, cy - 40); break;
            }
        });
    });

    // =====================
    // Node Actions (inside text/image nodes)
    // =====================
    document.addEventListener('click', (e) => {
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
                // Replace body with editable text area
                body.innerHTML = `
                    <div class="node-text-content" contenteditable="true"
                         style="outline:none; min-height:80px; cursor:text; padding:4px;"
                         data-placeholder="在这里输入你的故事...">
                    </div>`;
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
        const body = nodeEl?.querySelector('.node-body');
        if (!body) return;
        const taskActions = options.taskId ? `
            <div class="generated-action-row">
                <a href="/tasks?task=${encodeURIComponent(options.taskId)}" target="_blank" rel="noreferrer">任务详情</a>
                ${options.videoUrl ? `<a href="${escapeHtml(options.videoUrl)}" target="_blank" rel="noreferrer">预览</a>` : ''}
                ${options.downloadUrl ? `<a href="${escapeHtml(options.downloadUrl)}" target="_blank" rel="noreferrer">下载</a>` : ''}
            </div>
        ` : '';
        body.innerHTML = `
            <div class="generated-reference-card">
                <button class="prompt-card-expand" data-prompt-expand title="展开提示词">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/></svg>
                </button>
                <div>
                    <strong>${escapeHtml(title)}</strong>
                    <p>${escapeHtml(description)}</p>
                </div>
                ${previewImage
                    ? `<img class="generated-frame-preview" src="${escapeHtml(previewImage)}" alt="${escapeHtml(title)}">`
                    : '<div class="generated-frame-lines"></div>'}
                ${taskActions}
            </div>`;
    }

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
        const tab = e.target.closest('.video-props-tab');
        if (!tab) return;
        const parent = tab.closest('.video-props-tabs');
        parent?.querySelectorAll('.video-props-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
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

    // Arrange canvas (整理画布)
    document.getElementById('btn-fit')?.addEventListener('click', () => engine.fitView());

    // Snapping toggle (吸附)
    document.getElementById('btn-snap')?.addEventListener('click', (e) => {
        const btn = e.currentTarget;
        btn.classList.toggle('active');
        engine.isSnapEnabled = btn.classList.contains('active');
    });

    // Minimap toggle (小地图)
    document.getElementById('btn-minimap')?.addEventListener('click', (e) => {
        e.currentTarget.classList.remove('active');
        showCanvasNotice('画布小地图还没有接入，当前不会显示缩略导航。', 'warn');
    });

    // =====================
    // Keyboard Shortcuts
    // =====================
    document.addEventListener('keydown', (e) => {
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
    document.getElementById('logo')?.addEventListener('click', () => {
        if (engine.nodes.size > 0 && confirm('确定要返回首页吗？未保存的更改将丢失。'))
            window.location.reload();
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

    console.log('🎬 无线画布 initialized');
})();
