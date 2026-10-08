(function () {
    'use strict';

    const endpoint = '/api/tools/ultimate-canvas/styles';

    function create(hooks) {
        const polling = new Map();
        const pendingFavorites = new Map();
        const sameContext = (a, b) => ['userId', 'projectId', 'cardId', 'documentId'].every(key => a?.[key] === b?.[key]);
        const current = (node, context) => hooks.getNode(node.id) === node && sameContext(context, hooks.context());
        const json = (url, payload, signal) => hooks.request(url, {
            ...(payload ? { method: 'POST', payload } : {}), cache: 'no-store', signal: signal || AbortSignal.timeout(30000)
        });

        async function open(nodeId) {
            const node = hooks.getNode(nodeId);
            const context = hooks.context();
            if (!node || node.type !== 'image') return;
            if (!context.writable || !context.projectId || !context.documentId || !context.cardId) {
                hooks.notice('请先打开可编辑画布，并选择项目和视频卡。', 'warn');
                return;
            }
            if (node.data?.styleJob) {
                hooks.notice('请先等待当前风格任务完成，再切换风格。', 'warn');
                return;
            }
            window.UltimateCanvasStyleGallery.open({
                ...context, nodeId, icon: window.UltimateCanvasIcons, notice: hooks.notice,
                loadPage: async ({ cursor, query, category, model, tab, recentIds, signal }) => {
                    const params = new URLSearchParams({ query: query || '', category: category || '', model: model || '', tab: tab === 'gallery' ? 'all' : tab });
                    if (cursor) params.set('cursor', cursor);
                    params.set('recentIds', JSON.stringify(recentIds || []));
                    const result = await json(`${endpoint}?${params}`, null, signal);
                    for (const item of result.items || []) item.favoriteUnconfirmed = pendingFavorites.has(`${context.userId}/${item.key}`);
                    return result;
                },
                onFavorite: async (item, active) => {
                    if (!sameContext(context, hooks.context())) throw new Error('画布已切换，请重新打开风格广场。');
                    const id = `${context.userId}/${item.key}`;
                    let payload = pendingFavorites.get(id);
                    if (!payload) {
                        payload = { key: item.key, action: 'like', active, expectedVersion: item.reactionVersion || 0, requestId: crypto.randomUUID() };
                        pendingFavorites.set(id, payload);
                    }
                    try {
                        const result = await hooks.request('/api/content-reactions', {
                            method: 'PUT', signal: AbortSignal.timeout(15000), payload
                        });
                        pendingFavorites.delete(id);
                        item.favoriteUnconfirmed = false;
                        item.reactionVersion = result.state.version;
                        item.favorited = Boolean(result.state.liked || result.state.favorited);
                        window.parent.postMessage({ type: 'sd2-canvas-reactions-changed', userId: context.userId, key: result.state.key }, location.origin);
                        return Boolean(result.state.liked || result.state.favorited);
                    } catch (error) {
                        if (Number.isInteger(error.status) && error.status < 500) pendingFavorites.delete(id);
                        item.favoriteUnconfirmed = pendingFavorites.has(id);
                        if (error.status === 409) {
                            const result = await json('/api/content-reactions/state', { keys: [item.key] });
                            const state = result.states?.[item.key];
                            if (state) { item.reactionVersion = state.version; item.favorited = Boolean(state.liked || state.favorited); }
                        }
                        throw error;
                    }
                },
                onRefreshFavorite: async item => {
                    if (!sameContext(context, hooks.context())) throw new Error('画布已切换，请重新打开风格广场。');
                    const result = await json('/api/content-reactions/state', { keys: [item.key] });
                    if (!sameContext(context, hooks.context())) throw new Error('画布已切换，请重新打开风格广场。');
                    const state = result.states?.[item.key];
                    if (!state) throw new Error('喜欢状态暂时无法读取');
                    return { ...state, unconfirmed: pendingFavorites.has(`${context.userId}/${item.key}`) };
                },
                onApply: async item => {
                    if (!current(node, context)) throw new Error('画布已切换，请重新打开风格广场。');
                    if (!await hooks.flush('before_canvas_style_apply')) throw new Error('画布尚未保存，未应用风格。请恢复连接后重试。');
                    if (!current(node, context)) throw new Error('画布已切换，请重新打开风格广场。');
                    const applied = await json(`${endpoint}/apply`, { ...context, nodeId, presetId: item.id });
                    if (!current(node, context)) throw new Error('画布已切换，模板已保存到个人模块，未改动新画布。');
                    const previous = node.data?.canvasStyle?.previous || {
                        prompt: node.data?.prompt || '', imageSettings: { ...node.data?.imageSettings }, mode: node.data?.mode || 'text-to-image'
                    };
                    const oldPrompt = node.data?.prompt || '';
                    const replacing = node.data?.canvasStyle;
                    const userPrompt = replacing && oldPrompt === replacing.appliedPrompt ? previous.prompt : oldPrompt;
                    const prompt = [applied.prompt, userPrompt && userPrompt !== applied.prompt ? userPrompt : ''].filter(Boolean).join('\n\n');
                    node.data = { ...node.data, prompt, mode: 'text-to-image',
                        canvasStyle: { ...applied, key: item.key, name: item.name, appliedBy: context.userId, previous, appliedPrompt: prompt },
                        imageSettings: { ...node.data?.imageSettings, model: applied.model, quality: applied.quality,
                            resolution: applied.resolution, ratio: applied.aspectRatio, count: applied.count, size: '' }
                    };
                    hooks.setPrompt(nodeId, prompt);
                    hooks.render(nodeId);
                    hooks.save('canvas_style_apply');
                    hooks.notice(`已应用「${item.name}」，尚未开始生成。`, 'info');
                }
            });
        }

        function clear(nodeId) {
            const node = hooks.getNode(nodeId);
            const style = node?.data?.canvasStyle;
            if (!style) return;
            if (node.data.styleJob) { hooks.notice('当前风格任务尚未结束，暂不能移除。', 'warn'); return; }
            if (node.data.prompt === style.appliedPrompt) node.data.prompt = style.previous?.prompt || '';
            node.data.imageSettings = { ...(style.previous?.imageSettings || {}) };
            node.data.mode = style.previous?.mode || 'text-to-image';
            delete node.data.canvasStyle;
            hooks.setPrompt(nodeId, node.data.prompt);
            hooks.render(nodeId);
            hooks.save('canvas_style_remove');
        }

        function contextError() {
            const error = new Error('画布已切换，任务保留在原画布中。');
            error.name = 'AbortError';
            return error;
        }

        async function waitForResult(node, job) {
            if (polling.has(node)) return polling.get(node);
            const operation = (async () => {
                let failures = 0;
                for (let attempt = 0; attempt < 100; attempt++) {
                    if (!current(node, job.context)) throw contextError();
                    let result;
                    try {
                        result = await json(`${endpoint}/results`, { ...job.context, nodeId: node.id,
                            moduleId: job.moduleId, batchId: job.batchId, requestId: job.requestId, count: job.count });
                        failures = 0;
                    } catch (error) {
                        if ([401, 403, 404].includes(error.status) || ++failures >= 3) throw error;
                        hooks.status(node.id, 'warn', '结果暂时读取失败，正在重试；不会重新生成。');
                        await new Promise(resolve => window.setTimeout(resolve, 4000 * failures));
                        continue;
                    }
                    if (!current(node, job.context)) throw contextError();
                    if (result.status === 'not_found') {
                        job.state = 'unconfirmed';
                        hooks.save('canvas_style_submission_unknown');
                        throw new Error(job.kind === 'ordinary' ? '提交尚未确认，请查看生成状态；不会重新发送或扣点。' : '提交尚未确认。点击生成可安全重试原请求，不会重复扣费。');
                    }
                    if (!result.pending) {
                        delete node.data.styleJob;
                        hooks.save('canvas_style_finished');
                        if (!result.assets?.length) throw new Error(result.error || '风格生成失败，输入和参考已保留。');
                        return { ...result, partial: result.status !== 'succeeded' || Boolean(result.error),
                            message: result.error ? `已保存 ${result.assets.length} 张图片；${result.error}` : `已生成 ${result.assets.length} 张图片，并保存到资产库。` };
                    }
                    job.state = 'running';
                    hooks.status(node.id, 'loading', `${job.kind === 'ordinary' ? '图片' : '风格'}生成中 · 已完成 ${Number(result.completedCount) || 0}/${Number(result.totalCount) || job.count} 张`);
                    await new Promise(resolve => window.setTimeout(resolve, document.hidden ? 15000 : attempt < 5 ? 3000 : 6000));
                }
                throw new Error('任务仍在处理中，状态检查已暂停。点击“查看生成状态”继续，不会重新生成。');
            })();
            polling.set(node, operation);
            try { return await operation; }
            finally { if (polling.get(node) === operation) polling.delete(node); if (current(node, job.context)) hooks.render(node.id); }
        }

        async function generate(payload, resolvedPrompt = payload.prompt) {
            const node = hooks.getNode(payload.nodeId);
            const style = node?.data?.canvasStyle;
            const context = hooks.context();
            if (!style || style.appliedBy !== context.userId) throw new Error('请重新应用此风格后生成。');
            let job = node.data.styleJob;
            if (job && !sameContext(job.context, context)) throw new Error('此任务属于原项目或视频卡，请返回原画布查看。');
            if (!job) {
                job = { requestId: payload.requestId || crypto.randomUUID(), moduleId: style.moduleId,
                    context: { userId: context.userId, projectId: context.projectId, cardId: context.cardId, documentId: context.documentId },
                    count: style.count, payload, state: 'submitting',
                    input: { ...context, nodeId: node.id, moduleId: style.moduleId,
                        settingsRevision: style.settingsRevision, moduleRevision: style.moduleRevision,
                        prompt: resolvedPrompt, referenceImageIds: payload.referenceImageIds || [],
                        settings: { model: style.model, quality: style.quality, resolution: style.resolution,
                            count: style.count, ratio: style.aspectRatio } }
                };
                job.input.requestId = job.requestId;
                node.data.styleJob = job;
                hooks.render(node.id);
                hooks.save('canvas_style_submit_prepare');
                if (!await hooks.flush('canvas_style_submit_prepare')) {
                    delete node.data.styleJob;
                    throw new Error('画布尚未保存，未提交生成。请恢复连接后再试。');
                }
            }
            if (!current(node, job.context)) throw contextError();
            if (!job.batchId) {
                try {
                    const accepted = await json(`${endpoint}/generate`, job.input);
                    job.batchId = accepted.batchId;
                    job.state = 'running';
                    if (current(node, job.context)) hooks.save('canvas_style_submitted');
                } catch (error) {
                    if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
                        delete node.data.styleJob;
                    } else job.state = 'unconfirmed';
                    if (current(node, job.context)) hooks.save('canvas_style_submission_error');
                    throw error;
                }
            }
            const result = await waitForResult(node, job);
            return { ...result, canvasStylePayload: job.payload };
        }

        async function generateOrdinary(payload, resolvedPrompt) {
            const node = hooks.getNode(payload.nodeId), context = hooks.context();
            if (!node || node.type !== 'image') throw new Error('图片节点不存在');
            let job = node.data.styleJob;
            if (job) {
                if (job.kind !== 'ordinary' || !sameContext(job.context, context)) throw new Error('请先查询原图片任务');
                return { ...await waitForResult(node, job), canvasStylePayload: job.payload };
            }
            let legacyRequired = false;
            if (payload.referenceImageIds?.length) {
                const params = new URLSearchParams({ projectId: context.projectId, cardId: context.cardId, documentId: context.documentId, nodeId: node.id });
                payload.referenceImageIds.forEach(id => params.append('referenceImageId', id));
                const eligibility = await json(`/api/tools/ultimate-canvas/images/generate?${params}`);
                if (!current(node, context)) throw contextError();
                if (!eligibility.durable) {
                    hooks.notice('共享参考图沿用原生成路径；当前持久图片队列仅支持本人原件。', 'info');
                    legacyRequired = true;
                }
            }
            const settings = structuredClone(payload.settings);
            const quote = await json('/api/tools/ultimate-canvas/quote', { kind: 'image', project_id: context.projectId,
                model: settings.model, count: settings.count, quality: settings.quality, resolution: settings.resolution,
                size: settings.size || '1K', ratio: settings.requestedRatio || settings.ratio });
            if (quote.status !== 'estimate' || !Number.isSafeInteger(quote.estimatedCredits) || quote.estimatedCredits < 0) throw new Error('当前模型报价不可用，请选择已配置模型或重试');
            if (!await hooks.confirm({ title: '生成图片', message: `本次 ${settings.count} 张图片，预计 ${quote.estimatedCredits} 点。`, confirmLabel: `确认 ${quote.estimatedCredits} 点` })) throw new Error('已取消，未提交图片生成');
            if (!current(node, context)) throw contextError();
            if (legacyRequired) return { legacyRequired: true };
            job = { kind: 'ordinary', requestId: crypto.randomUUID(), moduleId: crypto.randomUUID(), count: settings.count,
                context: { userId: context.userId, projectId: context.projectId, cardId: context.cardId, documentId: context.documentId },
                payload, state: 'unconfirmed' };
            job.input = { projectId: context.projectId, cardId: context.cardId, documentId: context.documentId,
                nodeId: node.id, requestId: job.requestId, moduleId: job.moduleId, prompt: resolvedPrompt,
                settingsRevision: quote.revision, maxEstimatedCost: quote.estimatedCredits,
                referenceImageIds: payload.referenceImageIds || [], settings: { model: settings.model,
                    quality: settings.quality, resolution: settings.resolution, ratio: settings.requestedRatio || settings.ratio, count: settings.count } };
            node.data.styleJob = job;
            hooks.save('ordinary_image_before_submit');
            if (!await hooks.flush('ordinary_image_before_submit')) {
                delete node.data.styleJob;
                hooks.save('ordinary_image_not_sent');
                throw new Error('图片请求未发出，画布尚未保存；请先重试保存');
            }
            if (!current(node, context)) throw contextError();
            let accepted;
            try { accepted = await json('/api/tools/ultimate-canvas/images/generate', job.input); }
            catch (error) {
                if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
                    delete node.data.styleJob;
                    if (current(node, context)) hooks.save('ordinary_image_rejected');
                }
                throw error;
            }
            job.batchId = accepted.batchId; job.state = 'running';
            if (current(node, context)) hooks.save('ordinary_image_submitted');
            return { ...await waitForResult(node, job), canvasStylePayload: job.payload };
        }

        async function resume(nodeId) {
            const node = hooks.getNode(nodeId);
            const job = node?.data?.styleJob;
            if (!job || polling.has(node)) return;
            if (!sameContext(job.context, hooks.context())) {
                hooks.status(nodeId, 'warn', '此任务属于原项目、视频卡或账号，请回到原画布查看。');
                return;
            }
            try {
                const result = await waitForResult(node, job);
                if (current(node, job.context)) hooks.apply(nodeId, job.payload, result);
            } catch (error) {
                if (current(node, job.context)) {
                    hooks.status(nodeId, 'warn', error.message || '结果读取失败，可点击查看生成状态重试。');
                    hooks.render(nodeId);
                }
            }
        }

        return { open, clear, generate, generateOrdinary, resume };
    }

    window.UltimateCanvasStyles = { create };
}());
