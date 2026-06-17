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

    if (window.CanvasGenerationAPI?.configure) {
        window.CanvasGenerationAPI.configure({
            endpoints: {
                text: '/api/tools/ultimate-canvas/generate',
                script: '/api/tools/ultimate-canvas/generate'
            }
        });
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

        return {
            nodeId,
            kind,
            mode,
            modeLabel: tabText || mode,
            prompt: prompt || node.data?.prompt || node.data?.description || '',
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

        showCanvasNotice(result?.message || 'LLM 生成完成', 'info');
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

        if (payload.kind === 'image' || payload.kind === 'video') {
            const isMock = result?.provider === 'mock';
            const title = isMock
                ? (payload.kind === 'video' ? '视频生成占位' : '图片生成占位')
                : (payload.kind === 'video' ? '视频生成接口' : '图片生成接口');
            const desc = isMock
                ? `${payload.modeLabel || payload.mode} · 尚未接入真实生成、点数扣减和任务轮询。`
                : `${payload.modeLabel || payload.mode} · ${result?.message || '请求已提交'}`;
            const preview = result?.previewImage || result?.imageUrl || result?.coverUrl || payload.referenceImage || '';
            decorateGeneratedNode(payload.nodeId, title, desc, preview);
            if (isMock) {
                showCanvasNotice('当前是无线画布占位结果，还没有创建真实 sd2 生成任务。', 'warn');
            }
        }
    }

    async function submitNodeGeneration(nodeEl, button) {
        const api = window.CanvasGenerationAPI;
        const payload = collectGenerationPayload(nodeEl);
        if (!api || !payload) return;

        setSubmitLoading(button, true);
        try {
            const result = await api.generate(payload);
            applyGenerationResult(nodeEl, payload, result);
        } catch (error) {
            showCanvasNotice(error?.message || '生成请求失败，请检查接口配置。', 'error');
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
        '高清修复': 'upscale-image'
    };

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
            return ['文生图', '图生图', '高清修复'].map(label => ({
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
            showCanvasNotice(item.dataset.comingSoon || '生成历史还没有接入后台任务记录。', 'warn');
        }

        engine._hideAddMenu();
    });

    function triggerUpload(cx, cy, pendingConnection = null) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*,video/*,audio/*';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            let newNodeId = null;
            if (file.type.startsWith('image/')) newNodeId = engine.addNode('image', cx, cy);
            else if (file.type.startsWith('video/')) newNodeId = engine.addNode('video', cx, cy);
            else if (file.type.startsWith('audio/')) newNodeId = engine.addNode('audio', cx, cy);
            connectMenuNode(newNodeId, pendingConnection);
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

    function decorateGeneratedNode(nodeId, title, description, previewImage = '') {
        const nodeEl = document.querySelector(`[data-node-id="${nodeId}"]`);
        const body = nodeEl?.querySelector('.node-body');
        if (!body) return;
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
                createDirectorOutput(sourceNodeId, 'video', '导演台首尾帧视频节点', `使用当前机位调度作为首尾帧参考，当前只创建视频节点，真实 first_last_frame 生成接口待接入。${directorSummary(nodeEl)}`);
                setDirectorStatus(nodeEl, '已创建视频节点，生成待接入');
                showCanvasNotice('已创建首尾帧视频节点，但还没有提交真实 sd2 生成任务。', 'warn');
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
