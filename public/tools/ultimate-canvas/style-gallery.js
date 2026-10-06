(function () {
    'use strict';

    const STORAGE_PREFIX = 'ultimate-canvas:style-gallery:v1';
    const MAX_RECENT = 60;
    const MAX_RESTORE_PAGES = 3;
    const TABS = [
        { id: 'gallery', label: '风格广场' },
        { id: 'favorites', label: '我的喜欢' },
        { id: 'recent', label: '最近使用' }
    ];
    const FALLBACKS = {
        Search: '⌕', Maximize2: '⤢', Minimize2: '↙', X: '×', Heart: '♡',
        RotateCcw: '↺', Sparkles: '✦', ChevronDown: '▾', ArrowUpRight: '↗',
        LoaderCircle: '…', RefreshCw: '↻', Info: 'i'
    };
    const layerSelector = '[aria-modal="true"]';
    let root = null;
    let dialog = null;
    let options = null;
    let ui = null;
    let state = null;

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function iconMarkup(name) {
        let markup = '';
        try {
            const sharedIcons = window.UltimateCanvasIcons;
            if (typeof options?.icon === 'function') markup = options.icon(name);
            else if (typeof sharedIcons === 'function') markup = sharedIcons(name);
            else if (sharedIcons && typeof sharedIcons[name] === 'string') markup = sharedIcons[name];
        } catch { /* Icon rendering must not prevent the gallery from opening. */ }
        return markup;
    }

    function setIcon(node, name, providedMarkup) {
        const markup = arguments.length > 2 ? providedMarkup : iconMarkup(name);
        node.replaceChildren();
        const icon = element('span', 'uc-sg-icon');
        icon.setAttribute('aria-hidden', 'true');
        if (typeof markup === 'string' && /^<svg(?:\s|>)/i.test(markup.trim())) {
            icon.innerHTML = markup;
        } else {
            icon.textContent = FALLBACKS[name] || '·';
        }
        node.append(icon);
    }

    function iconButton(name, fallback, label, className) {
        const button = element('button', className || 'uc-sg-icon-button');
        button.type = 'button';
        button.setAttribute('aria-label', label);
        button.title = label;
        const markup = iconMarkup(name);
        setIcon(button, name, markup);
        if (!(typeof markup === 'string' && /^<svg(?:\s|>)/i.test(markup.trim()))) {
            button.querySelector('.uc-sg-icon').textContent = fallback || FALLBACKS[name] || '·';
        }
        return button;
    }

    function notifyParentLayer(open) {
        if (!state || window.parent === window || state.parentLayerActive === open) return;
        state.parentLayerActive = open;
        try {
            window.parent.postMessage({ type: 'sd2-canvas-style-gallery', open: Boolean(open) }, window.location.origin);
        } catch { /* The gallery remains usable if the host frame cannot receive the notice. */ }
    }

    function imageUrl(value) {
        if (typeof value !== 'string' || !value.trim()) return '';
        try {
            const url = new URL(value, window.location.href);
            return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
        } catch { return ''; }
    }

    function displayName(item) {
        return typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : '未命名风格';
    }

    function authorName(item) {
        return typeof item?.author?.name === 'string' && item.author.name.trim() ? item.author.name.trim() : '未知作者';
    }

    function identity(item) {
        return String(item?.id || item?.key || '');
    }

    function recentKey(item) {
        return typeof item?.key === 'string' && item.key.trim() ? item.key.trim().slice(0, 128) : '';
    }

    function hashHue(value) {
        let hash = 0;
        for (const char of String(value || '')) hash = ((hash * 31) + char.codePointAt(0)) | 0;
        return Math.abs(hash) % 360;
    }

    function avatar(name, url) {
        const face = element('span', 'uc-sg-avatar', Array.from(name || '?')[0] || '?');
        face.setAttribute('aria-hidden', 'true');
        face.style.setProperty('--uc-sg-avatar-hue', String(hashHue(name)));
        const safeUrl = imageUrl(url);
        if (safeUrl) {
            const image = element('img');
            image.alt = '';
            image.referrerPolicy = 'no-referrer';
            image.addEventListener('error', function () { image.remove(); }, { once: true });
            image.src = safeUrl;
            face.append(image);
        }
        return face;
    }

    function getStorageKey() {
        const userId = typeof options?.userId === 'string' ? options.userId.trim() : '';
        const projectId = typeof options?.projectId === 'string' ? options.projectId.trim() : '';
        if (!userId || !projectId) return '';
        return STORAGE_PREFIX + ':' + encodeURIComponent(userId.slice(0, 128)) + ':' + encodeURIComponent(projectId.slice(0, 128));
    }

    function defaults() {
        return { tab: 'gallery', query: '', category: '', model: '', commercialOnly: false, scrollTop: 0, recentIds: [] };
    }

    function readPreferences() {
        const prefs = defaults();
        const key = getStorageKey();
        if (!key) return prefs;
        try {
            const saved = JSON.parse(localStorage.getItem(key) || 'null');
            if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return prefs;
            if (TABS.some(tab => tab.id === saved.tab)) prefs.tab = saved.tab;
            if (typeof saved.query === 'string') prefs.query = saved.query.slice(0, 120);
            if (typeof saved.category === 'string') prefs.category = saved.category.slice(0, 100);
            if (typeof saved.model === 'string') prefs.model = saved.model.slice(0, 100);
            if (typeof saved.commercialOnly === 'boolean') prefs.commercialOnly = saved.commercialOnly;
            if (Number.isFinite(saved.scrollTop)) prefs.scrollTop = Math.max(0, Math.min(500000, saved.scrollTop));
            if (Array.isArray(saved.recentIds)) {
                prefs.recentIds = [...new Set(saved.recentIds.filter(value => typeof value === 'string' && value.length > 0 && value.length <= 128))].slice(0, MAX_RECENT);
            }
        } catch { /* Corrupt or unavailable browser storage falls back to defaults. */ }
        return prefs;
    }

    function savePreferences() {
        const key = getStorageKey();
        if (!key || !state || !ui) return false;
        try {
            localStorage.setItem(key, JSON.stringify({
                tab: state.tab,
                query: state.query.slice(0, 120),
                category: state.category.slice(0, 100),
                model: state.model.slice(0, 100),
                commercialOnly: state.commercialOnly,
                scrollTop: Math.max(0, Math.min(500000, ui.content.scrollTop || 0)),
                recentIds: state.recentIds.slice(0, MAX_RECENT)
            }));
            return true;
        } catch {
            if (!state.storageWarningShown) {
                state.storageWarningShown = true;
                showNotice('本次偏好未能保存。');
            }
            return false;
        }
    }

    function clearNoticeLater() {
        if (state?.noticeTimer) window.clearTimeout(state.noticeTimer);
        if (state) state.noticeTimer = window.setTimeout(function () {
            if (ui?.notice) ui.notice.hidden = true;
        }, 5000);
    }

    function showNotice(message, notifyParent) {
        if (!ui?.notice) return;
        ui.notice.textContent = message;
        ui.notice.hidden = false;
        clearNoticeLater();
        if (notifyParent !== false) {
            try { options?.notice?.(message); } catch { /* A toast must not change the operation result. */ }
        }
    }

    function setStatus(message) {
        if (!ui?.status) return;
        ui.status.textContent = message || '';
    }

    function updateTabButtons() {
        ui.tabs.querySelectorAll('[data-sg-tab]').forEach(function (button) {
            const selected = button.dataset.sgTab === state.tab;
            button.setAttribute('aria-selected', String(selected));
            button.tabIndex = selected ? 0 : -1;
        });
    }

    function selectCard(id) {
        state.selectedId = id;
        state.applyError = '';
        root.querySelectorAll('[data-sg-select]').forEach(function (button) {
            const selected = button.dataset.sgSelect === id;
            button.setAttribute('aria-pressed', String(selected));
            button.closest('.uc-sg-card')?.classList.toggle('is-selected', selected);
        });
        renderDetails();
    }

    function renderCategories(categories, validate = true) {
        const list = Array.isArray(categories) ? categories.filter(item => item && typeof item.id === 'string' && typeof item.label === 'string') : [];
        state.categories = list;
        const valid = list.some(item => item.id === state.category);
        if (validate && state.category && !valid) state.category = '';
        ui.categories.replaceChildren();
        const all = [{ id: '', label: '全部' }].concat(list);
        all.forEach(function (category) {
            const button = element('button', 'uc-sg-chip', category.label);
            button.type = 'button';
            button.dataset.sgCategory = category.id;
            button.setAttribute('aria-pressed', String(category.id === state.category));
            ui.categories.append(button);
        });
    }

    function renderModels(models, validate = true) {
        const list = Array.isArray(models) ? models.filter(item => item && typeof item.id === 'string' && typeof item.label === 'string') : [];
        state.models = list;
        const valid = list.some(item => item.id === state.model);
        if (validate && state.model && !valid) state.model = '';
        ui.model.replaceChildren();
        const all = element('option', '', '全部模型');
        all.value = '';
        ui.model.append(all);
        list.forEach(function (model) {
            const option = element('option', '', model.label);
            option.value = model.id;
            ui.model.append(option);
        });
        ui.model.value = state.model;
    }

    function renderCommercialAvailability(available) {
        state.commercialAvailable = available === true;
        ui.commercial.disabled = !state.commercialAvailable;
        ui.commercial.checked = state.commercialOnly && state.commercialAvailable;
        const reason = state.commercialAvailable ? '' : '可商用信息尚未登记，暂时不能筛选';
        ui.commercial.title = reason;
        ui.commercialLabel.title = reason;
        ui.commercialHelp.textContent = state.commercialAvailable ? '' : '未登记';
        if (!state.commercialAvailable && state.commercialOnly) {
            state.commercialOnly = false;
            savePreferences();
        }
    }

    function categoryLabel(id) {
        return state.categories.find(item => item.id === id)?.label || '';
    }

    function modelLabel(id) {
        return state.models.find(item => item.id === id)?.label || '';
    }

    function isFavorited(item) {
        const key = identity(item);
        return Object.prototype.hasOwnProperty.call(state.favoriteStates, key)
            ? state.favoriteStates[key]
            : item?.favorited === true;
    }

    function syncFavoriteButton(button, item, active, pending) {
        if (!button.querySelector('.lk-heart')) {
            const heart = element('span', 'lk-heart');
            const glyph = element('span', 'lk-glyph');
            setIcon(glyph, 'Heart');
            heart.append(glyph);
            button.replaceChildren(heart);
        }
        button.classList.toggle('is-favorited', active);
        button.setAttribute('aria-pressed', String(active));
        button.setAttribute('aria-label', active ? '取消喜欢' : '喜欢');
        button.title = active ? '取消喜欢' : '喜欢';
        button.disabled = Boolean(pending || typeof options?.onFavorite !== 'function');
        if (typeof options?.onFavorite !== 'function') button.title = '喜欢暂不可用';
    }

    // Bencho Like, MIT (c) 2026 Lorenzo Cabra; geometry matches shared like-button.css.
    function bloomFavorite(button) {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const heart = button.querySelector('.lk-heart');
        if (!heart) return;
        const colors = ['#f48ea7', '#cc8ef5', '#8ce8c3', '#91d2fa', '#f5a524', '#e5484d', '#9fc7fa'];
        const burst = element('span', 'lk-burst');
        burst.setAttribute('aria-hidden', 'true');
        burst.append(element('span', 'lk-bloom'));
        colors.forEach(function (color, index) {
            const spoke = element('span', 'lk-spoke');
            spoke.style.setProperty('--a', `${index * (360 / 7) - 90}deg`);
            [color, colors[(index + 3) % colors.length]].forEach(function (dotColor) {
                const dot = element('i'); dot.style.setProperty('--c', dotColor); spoke.append(dot);
            });
            burst.append(spoke);
        });
        heart.append(burst);
        button.dataset.bloom = 'true';
        setTimeout(function () { burst.remove(); delete button.dataset.bloom; }, 900);
    }

    function buildCard(item) {
        const id = identity(item);
        const card = element('article', 'uc-sg-card' + (state.selectedId === id ? ' is-selected' : ''));
        card.setAttribute('role', 'listitem');
        const previewButton = element('button', 'uc-sg-image-button');
        previewButton.type = 'button';
        previewButton.dataset.sgSelect = id;
        previewButton.setAttribute('aria-label', '查看“' + displayName(item) + '”详情');
        previewButton.setAttribute('aria-pressed', String(state.selectedId === id));
        const media = element('span', 'uc-sg-media');
        const placeholder = element('span', 'uc-sg-placeholder', '暂无预览');
        const cover = imageUrl(item.coverUrl);
        if (cover) {
            const image = element('img');
            image.alt = '';
            image.loading = 'lazy';
            image.decoding = 'async';
            image.referrerPolicy = 'no-referrer';
            image.addEventListener('error', function () {
                image.remove();
                placeholder.hidden = false;
            }, { once: true });
            image.src = cover;
            placeholder.hidden = true;
            media.append(image, placeholder);
        } else {
            media.append(placeholder);
        }
        previewButton.append(media);
        const info = element('div', 'uc-sg-card-info');
        const titleRow = element('div', 'uc-sg-title-row');
        const title = element('button', 'uc-sg-card-title', displayName(item));
        title.type = 'button';
        title.dataset.sgSelect = id;
        title.title = displayName(item);
        title.setAttribute('aria-label', '查看“' + displayName(item) + '”详情');
        const favorite = element('button', 'uc-sg-favorite sd2-like');
        favorite.type = 'button';
        favorite.dataset.sgFavorite = id;
        syncFavoriteButton(favorite, item, isFavorited(item), state.favoritePending.has(id));
        titleRow.append(title, favorite);
        const owner = element('div', 'uc-sg-author');
        owner.append(avatar(authorName(item), item.author?.avatarUrl));
        owner.append(element('span', 'uc-sg-author-name', authorName(item)));
        info.append(titleRow, owner);
        card.append(previewButton, info);
        return card;
    }

    function updateFavoriteButtons(id) {
        const item = state.items.find(entry => identity(entry) === id);
        if (!item) return;
        const active = isFavorited(item);
        root.querySelectorAll('[data-sg-favorite]').forEach(function (button) {
            if (button.dataset.sgFavorite === id) syncFavoriteButton(button, item, active, state.favoritePending.has(id));
        });
    }

    function renderItems() {
        ui.grid.replaceChildren();
        state.items.forEach(item => ui.grid.append(buildCard(item)));
        const hasItems = state.items.length > 0;
        ui.empty.textContent = state.query
            ? '没有找到匹配的风格，试试缩短名称或作者关键词。'
            : state.tab === 'favorites'
                ? '还没有喜欢的风格。'
                : state.tab === 'recent'
                    ? '最近用过的风格会显示在这里。'
                    : '当前类别还没有可用风格。';
        ui.empty.hidden = hasItems || state.loading || state.loadingMore;
        ui.grid.hidden = !hasItems;
        ui.moreRow.hidden = !state.hasMore && !state.loadingMore && !state.loadMoreError;
        ui.moreButton.disabled = state.loadingMore || state.applying;
        ui.moreButton.textContent = state.loadingMore ? '正在加载…' : state.loadMoreError ? '重试加载' : '加载更多';
        ui.moreStatus.textContent = state.loadMoreError ? '暂时没能加载下一批。' : '';
        ui.moreButton.hidden = !state.hasMore && !state.loadingMore && !state.loadMoreError;
        ui.grid.setAttribute('aria-busy', String(state.loading || state.loadingMore));
        renderDetails();
        applyScrollRestore();
    }

    function renderDetails() {
        const item = state.items.find(entry => identity(entry) === state.selectedId);
        ui.detail.hidden = !item;
        if (!item) {
            ui.detail.replaceChildren();
            return;
        }
        ui.detail.replaceChildren();
        const text = element('div', 'uc-sg-detail-copy');
        text.append(element('strong', 'uc-sg-detail-name', displayName(item)));
        const meta = [];
        const category = categoryLabel(item.category);
        const model = modelLabel(item.model);
        if (category) meta.push(category);
        if (model) meta.push(model);
        if (Number.isFinite(item.referenceCount) && item.referenceCount >= 0) meta.push('参考图 ' + item.referenceCount + ' 张');
        if (meta.length) text.append(element('span', 'uc-sg-detail-meta', meta.join(' · ')));
        if (typeof item.description === 'string' && item.description.trim()) {
            text.append(element('p', 'uc-sg-detail-description', item.description.trim()));
        }
        const owner = element('div', 'uc-sg-detail-author');
        owner.append(avatar(authorName(item), item.author?.avatarUrl));
        owner.append(element('span', '', authorName(item)));
        const apply = element('button', 'uc-sg-apply', state.applying ? '正在应用…' : '应用');
        apply.type = 'button';
        apply.dataset.sgApply = state.selectedId;
        apply.disabled = state.applying || typeof options?.onApply !== 'function';
        if (typeof options?.onApply !== 'function') apply.title = '应用功能暂不可用';
        const close = iconButton('X', '×', '收起详情', 'uc-sg-detail-close');
        close.dataset.sgClearSelection = 'true';
        close.disabled = state.applying;
        ui.detail.append(text, owner, apply, close);
        if (state.applyError) {
            const error = element('p', 'uc-sg-apply-error', state.applyError);
            error.setAttribute('role', 'alert');
            ui.detail.append(error);
        }
    }

    function renderSkeletons() {
        ui.grid.replaceChildren();
        for (let index = 0; index < 8; index += 1) {
            const card = element('div', 'uc-sg-skeleton');
            card.setAttribute('aria-hidden', 'true');
            card.append(element('span', 'uc-sg-skeleton-image'));
            card.append(element('span', 'uc-sg-skeleton-line'));
            card.append(element('span', 'uc-sg-skeleton-owner'));
            ui.grid.append(card);
        }
        ui.grid.hidden = false;
        ui.empty.hidden = true;
        ui.grid.setAttribute('aria-busy', 'true');
        ui.moreRow.hidden = true;
    }

    function showError(message) {
        ui.grid.replaceChildren();
        ui.grid.hidden = true;
        ui.empty.hidden = true;
        ui.error.hidden = false;
        ui.errorText.textContent = message;
        ui.retry.hidden = false;
        ui.detail.hidden = true;
        ui.moreRow.hidden = true;
    }

    function clearError() {
        ui.error.hidden = true;
        ui.retry.hidden = true;
    }

    function invalidateRequest() {
        if (state.controller) state.controller.abort();
        state.controller = null;
        state.requestId += 1;
        state.loading = false;
        state.loadingMore = false;
    }

    function requestArgs(cursor, signal) {
        return {
            cursor: cursor,
            query: state.query,
            category: state.category,
            model: state.model,
            commercialOnly: state.commercialOnly,
            tab: state.tab,
            recentIds: state.recentIds.slice(0, MAX_RECENT),
            signal: signal
        };
    }

    function hasNextCursor(cursor) {
        return cursor !== null && cursor !== undefined && cursor !== '';
    }

    function mergeItems(previous, incoming) {
        const merged = new Map();
        previous.forEach(item => {
            const key = identity(item);
            if (key) merged.set(key, item);
        });
        incoming.forEach(item => {
            const key = identity(item);
            if (key) merged.set(key, item);
        });
        return Array.from(merged.values());
    }

    async function loadPage(append, restoring) {
        if (!root || typeof options?.loadPage !== 'function') {
            if (root) showError('风格列表暂不可用，请稍后重试。');
            return;
        }
        if (append && (!state.hasMore || state.loading || state.loadingMore)) return;
        invalidateRequest();
        const requestId = state.requestId;
        const controller = new AbortController();
        state.controller = controller;
        state.loadMoreError = false;
        if (append) {
            state.loadingMore = true;
        } else {
            state.loading = true;
            state.hasMore = false;
            state.nextCursor = null;
            state.items = [];
            state.selectedId = '';
            state.applyError = '';
            state.restoreScroll = restoring ? state.restoreScroll : null;
            state.restoreHops = 0;
            clearError();
            renderSkeletons();
        }
        setStatus(append ? '正在加载更多风格' : '正在加载风格');
        try {
            const cursor = append ? state.nextCursor : null;
            const result = await options.loadPage(requestArgs(cursor, controller.signal));
            if (!root || requestId !== state.requestId || controller.signal.aborted) return;
            if (!result || !Array.isArray(result.items)) throw new Error('Invalid style page');

            const categoryChanged = Boolean(state.category && Array.isArray(result.categories)
                && !result.categories.some(item => item && item.id === state.category));
            const modelChanged = Boolean(state.model && Array.isArray(result.models)
                && !result.models.some(item => item && item.id === state.model));
            if (state.commercialOnly && result.commercialFilterAvailable !== true) {
                state.commercialOnly = false;
                renderCommercialAvailability(result.commercialFilterAvailable);
                savePreferences();
                invalidateRequest();
                return loadPage(false, restoring);
            }
            if (!append && (categoryChanged || modelChanged)) {
                if (categoryChanged) state.category = '';
                if (modelChanged) state.model = '';
                if (Array.isArray(result.categories)) renderCategories(result.categories);
                if (Array.isArray(result.models)) renderModels(result.models);
                savePreferences();
                invalidateRequest();
                return loadPage(false, restoring);
            }

            if (Array.isArray(result.categories)) renderCategories(result.categories);
            if (Array.isArray(result.models)) renderModels(result.models);
            renderCommercialAvailability(result.commercialFilterAvailable);
            state.items = append ? mergeItems(state.items, result.items) : mergeItems([], result.items);
            state.nextCursor = result.nextCursor;
            state.hasMore = hasNextCursor(state.nextCursor);
            state.loading = false;
            state.loadingMore = false;
            state.loadMoreError = false;
            state.controller = null;
            clearError();
            renderItems();
            setStatus('');
            savePreferences();
        } catch (error) {
            if (!root || requestId !== state.requestId || controller.signal.aborted) return;
            state.loading = false;
            state.loadingMore = false;
            state.controller = null;
            if (append) {
                state.loadMoreError = true;
                renderItems();
                setStatus('');
            } else {
                showError(error?.message || '暂时无法读取风格，请检查网络后重试。');
                setStatus('');
            }
        }
    }

    function applyScrollRestore() {
        if (!root || !Number.isFinite(state.restoreScroll) || state.loading || state.loadingMore) return;
        const target = state.restoreScroll;
        const maxScroll = Math.max(0, ui.content.scrollHeight - ui.content.clientHeight);
        if (target <= maxScroll) {
            ui.content.scrollTop = target;
            state.restoreScroll = null;
            return;
        }
        ui.content.scrollTop = maxScroll;
        if (state.hasMore && state.restoreHops < MAX_RESTORE_PAGES) {
            state.restoreHops += 1;
            window.setTimeout(function () {
                if (root && state.restoreScroll !== null && !state.loading && !state.loadingMore) loadPage(true, true);
            }, 0);
        } else {
            state.restoreScroll = null;
        }
    }

    function setFilterAndLoad() {
        if (!root) return;
        state.restoreScroll = null;
        ui.content.scrollTop = 0;
        state.loadMoreError = false;
        savePreferences();
        loadPage(false);
    }

    function scheduleSearch(value) {
        state.query = String(value || '').slice(0, 120);
        state.restoreScroll = null;
        savePreferences();
        if (state.searchTimer) window.clearTimeout(state.searchTimer);
        invalidateRequest();
        setStatus('正在准备搜索');
        state.searchTimer = window.setTimeout(function () {
            if (!root) return;
            ui.content.scrollTop = 0;
            loadPage(false);
        }, 220);
    }

    function rememberRecent(item) {
        const key = recentKey(item);
        if (!key) return;
        state.recentIds = [key].concat(state.recentIds.filter(value => value !== key)).slice(0, MAX_RECENT);
        savePreferences();
    }

    async function applySelected(id) {
        if (state.applying || typeof options?.onApply !== 'function') return;
        const item = state.items.find(entry => identity(entry) === id);
        if (!item) return;
        state.applying = true;
        state.applyError = '';
        ui.search.disabled = true;
        ui.model.disabled = true;
        ui.commercial.disabled = true;
        const applyButton = ui.detail.querySelector('[data-sg-apply]');
        if (applyButton) {
            applyButton.disabled = true;
            applyButton.textContent = '正在应用…';
        }
        ui.closeButton.disabled = true;
        ui.closeButton.title = '应用完成前不能关闭';
        try {
            const result = await options.onApply(item);
            if (!root) return;
            if (result === false || result?.ok === false) throw new Error('Apply was not completed');
            rememberRecent(item);
            state.applying = false;
            ui.closeButton.disabled = false;
            ui.closeButton.title = '关闭风格广场';
            close();
        } catch (error) {
            if (!root) return;
            state.applying = false;
            ui.closeButton.disabled = false;
            ui.closeButton.title = '关闭风格广场';
            state.applyError = error?.message || '风格未能应用，请检查画布后重试。';
            ui.search.disabled = false;
            ui.model.disabled = false;
            ui.commercial.disabled = !state.commercialAvailable;
            renderDetails();
            ui.detail.querySelector('[data-sg-apply]')?.focus({ preventScroll: true });
        } finally {
            if (root && state.applying) {
                state.applying = false;
                renderDetails();
            }
        }
    }

    async function toggleFavorite(id, button) {
        if (!root || state.favoritePending.has(id) || typeof options?.onFavorite !== 'function') return;
        const capturedState = state;
        const item = state.items.find(entry => identity(entry) === id);
        if (!item) return;
        const previous = isFavorited(item);
        const desired = !previous;
        state.favoritePending.add(id);
        syncFavoriteButton(button, item, previous, true);
        try {
            const result = await options.onFavorite(item, desired);
            if (!root || state !== capturedState) return;
            let confirmed = desired;
            if (typeof result === 'boolean') confirmed = result;
            else if (result && typeof result.favorited === 'boolean') confirmed = Boolean(result.liked || result.favorited);
            else if (result && typeof result.active === 'boolean') confirmed = result.active;
            else if (result && typeof result.state === 'boolean') confirmed = result.state;
            state.favoriteStates[id] = confirmed;
            syncFavoriteButton(button, item, confirmed, true);
            if (desired && confirmed && !previous) bloomFavorite(button);
            if (!confirmed && state.tab === 'favorites') {
                state.items = state.items.filter(entry => identity(entry) !== id);
                if (state.selectedId === id) state.selectedId = '';
                renderItems();
            }
        } catch (error) {
            if (!root || state !== capturedState) return;
            state.favoriteStates[id] = previous;
            showNotice(error?.message || '喜欢没有保存，请重试。');
        } finally {
            if (root && state === capturedState) {
                state.favoritePending.delete(id);
                updateFavoriteButtons(id);
            }
        }
    }

    function handleClick(event) {
        if (state.applying) { event.preventDefault(); return; }
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        const tab = target.closest('[data-sg-tab]');
        if (tab) {
            state.tab = tab.dataset.sgTab;
            updateTabButtons();
            setFilterAndLoad();
            return;
        }
        const category = target.closest('[data-sg-category]');
        if (category) {
            state.category = category.dataset.sgCategory || '';
            ui.categories.querySelectorAll('[data-sg-category]').forEach(button => {
                button.setAttribute('aria-pressed', String(button.dataset.sgCategory === state.category));
            });
            setFilterAndLoad();
            return;
        }
        const select = target.closest('[data-sg-select]');
        if (select) {
            selectCard(select.dataset.sgSelect);
            return;
        }
        const favorite = target.closest('[data-sg-favorite]');
        if (favorite) {
            toggleFavorite(favorite.dataset.sgFavorite, favorite);
            return;
        }
        if (target.closest('[data-sg-maximize]')) {
            const maximized = dialog.classList.toggle('is-maximized');
            ui.maximize.setAttribute('aria-pressed', String(maximized));
            ui.maximize.setAttribute('aria-label', maximized ? '还原窗口大小' : '最大化窗口');
            ui.maximize.title = maximized ? '还原窗口大小' : '最大化窗口';
            setIcon(ui.maximize, maximized ? 'Minimize2' : 'Maximize2');
            return;
        }
        if (target.closest('[data-sg-close]')) {
            close();
            return;
        }
        if (target.closest('[data-sg-clear-selection]')) {
            state.selectedId = '';
            state.applyError = '';
            renderItems();
            return;
        }
        const apply = target.closest('[data-sg-apply]');
        if (apply) {
            applySelected(apply.dataset.sgApply);
            return;
        }
        if (target.closest('[data-sg-more]')) {
            state.loadMoreError = false;
            loadPage(true);
            return;
        }
        if (target.closest('[data-sg-retry]')) {
            if (state.items.length && state.hasMore) loadPage(true);
            else loadPage(false);
            return;
        }
        if (target.closest('[data-sg-reset]')) resetPreferences();
    }

    function resetPreferences() {
        if (!root || state.applying) return;
        if (state.searchTimer) window.clearTimeout(state.searchTimer);
        invalidateRequest();
        state.query = '';
        state.category = '';
        state.model = '';
        state.commercialOnly = false;
        state.restoreScroll = null;
        ui.search.value = '';
        ui.commercial.checked = false;
        ui.model.value = '';
        renderCategories(state.categories);
        ui.content.scrollTop = 0;
        const preferencesSaved = savePreferences();
        showNotice(preferencesSaved ? '已恢复默认筛选。' : '本窗口已恢复默认筛选，偏好未能保存。', false);
        state.loadMoreError = false;
        loadPage(false);
        ui.search.focus({ preventScroll: true });
    }

    function visibleFocusables() {
        return Array.from(dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'))
            .filter(node => !node.closest('[hidden]') && node.getClientRects().length > 0);
    }

    function effectiveZIndex(node) {
        let current = node;
        let highest = 0;
        while (current && current !== document.body) {
            const value = Number.parseInt(window.getComputedStyle(current).zIndex, 10);
            if (Number.isFinite(value)) highest = Math.max(highest, value);
            current = current.parentElement;
        }
        return highest;
    }

    function isTopLayer() {
        if (!root || !dialog) return false;
        const ownZ = effectiveZIndex(root);
        const layers = Array.from(document.querySelectorAll(layerSelector)).filter(function (layer) {
            return layer !== dialog && layer.isConnected && !layer.closest('[hidden]') && window.getComputedStyle(layer).display !== 'none';
        });
        for (const layer of layers) {
            if (layer instanceof HTMLDialogElement && layer.open) {
                const isAfter = Boolean(root.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING);
                if (isAfter || effectiveZIndex(layer) >= ownZ) return false;
            }
            const otherZ = effectiveZIndex(layer);
            if (otherZ > ownZ) return false;
            if (otherZ === ownZ && (root.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
        }
        return true;
    }

    function handleKeydown(event) {
        if (!root || !isTopLayer()) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            close();
            return;
        }
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            const currentTab = event.target instanceof Element ? event.target.closest('[data-sg-tab]') : null;
            if (currentTab) {
                event.preventDefault();
                const tabs = Array.from(ui.tabs.querySelectorAll('[data-sg-tab]'));
                const currentIndex = tabs.indexOf(currentTab);
                const direction = event.key === 'ArrowRight' ? 1 : -1;
                const next = tabs[(currentIndex + direction + tabs.length) % tabs.length];
                next.focus();
                next.click();
            }
            return;
        }
        if (event.key !== 'Tab') return;
        const focusables = visibleFocusables();
        if (!focusables.length) {
            event.preventDefault();
            dialog.focus();
            return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
            event.preventDefault();
            first.focus();
        }
    }

    function handlePointerDown(event) {
        if (!root || event.target !== root || !isTopLayer()) {
            if (state) state.outsidePointer = null;
            return;
        }
        state.outsidePointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    }

    function handlePointerUp(event) {
        if (!root || !state.outsidePointer) return;
        const start = state.outsidePointer;
        state.outsidePointer = null;
        if (event.pointerId !== start.id || event.target !== root || !isTopLayer()) return;
        const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
        if (distance <= 8) close();
    }

    function handleScroll() {
        if (!root) return;
        if (state.restoreScroll !== null) return;
        if (state.scrollTimer) window.clearTimeout(state.scrollTimer);
        state.scrollTimer = window.setTimeout(savePreferences, 140);
        if (ui.content.scrollHeight - ui.content.scrollTop - ui.content.clientHeight > 240) state.autoLoadArmed = true;
        if (state.autoLoadArmed && ui.content.scrollHeight - ui.content.scrollTop - ui.content.clientHeight <= 240
            && state.hasMore && !state.loading && !state.loadingMore) {
            state.autoLoadArmed = false;
            loadPage(true);
        }
    }

    function createUI() {
        root = element('div', 'uc-style-gallery');
        root.dataset.styleGalleryLayer = 'true';
        dialog = element('section', 'uc-sg-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'uc-sg-title');
        dialog.tabIndex = -1;
        root.append(dialog);

        const heading = element('h1', 'uc-sg-sr-only', '风格广场');
        heading.id = 'uc-sg-title';
        const header = element('header', 'uc-sg-header');
        const tabs = element('div', 'uc-sg-tabs');
        tabs.setAttribute('role', 'tablist');
        tabs.setAttribute('aria-label', '风格来源');
        TABS.forEach(function (tab, index) {
            const button = element('button', 'uc-sg-tab', tab.label);
            button.type = 'button';
            button.dataset.sgTab = tab.id;
            button.id = 'uc-sg-tab-' + tab.id;
            button.setAttribute('role', 'tab');
            button.setAttribute('aria-controls', 'uc-sg-results');
            button.setAttribute('aria-selected', String(index === 0));
            button.tabIndex = index === 0 ? 0 : -1;
            tabs.append(button);
        });
        const search = element('label', 'uc-sg-search');
        const searchIcon = element('span', 'uc-sg-search-icon');
        searchIcon.setAttribute('aria-hidden', 'true');
        setIcon(searchIcon, 'Search');
        const input = element('input', 'uc-sg-search-input');
        input.type = 'search';
        input.maxLength = 120;
        input.placeholder = '搜索名称或作者';
        input.setAttribute('aria-label', '搜索风格名称或作者');
        search.append(searchIcon, input);
        const actions = element('div', 'uc-sg-header-actions');
        const maximize = iconButton('Maximize2', '⤢', '最大化窗口', 'uc-sg-icon-button');
        maximize.dataset.sgMaximize = 'true';
        maximize.setAttribute('aria-pressed', 'false');
        const closeButton = iconButton('X', '×', '关闭风格广场', 'uc-sg-icon-button');
        closeButton.dataset.sgClose = 'true';
        actions.append(maximize, closeButton);
        header.append(tabs, search, actions);

        const filters = element('section', 'uc-sg-filters');
        filters.setAttribute('aria-label', '筛选风格');
        const categories = element('div', 'uc-sg-categories');
        categories.setAttribute('role', 'group');
        categories.setAttribute('aria-label', '风格类别');
        const categoryRail = element('div', 'uc-sg-category-rail');
        categoryRail.append(categories);
        const filterActions = element('div', 'uc-sg-filter-actions');
        const commercialLabel = element('label', 'uc-sg-commercial');
        const commercial = element('input');
        commercial.type = 'checkbox';
        commercial.disabled = true;
        commercial.title = '正在读取商用授权信息';
        commercial.setAttribute('aria-label', '仅看可商用');
        const commercialText = element('span', '', '仅看可商用');
        const commercialHelp = element('span', 'uc-sg-commercial-help');
        commercialHelp.id = 'uc-sg-commercial-help';
        commercial.setAttribute('aria-describedby', commercialHelp.id);
        commercialLabel.append(commercial, commercialText, commercialHelp);
        const modelLabel = element('label', 'uc-sg-model');
        const modelLabelText = element('span', 'uc-sg-sr-only', '模型筛选');
        const model = element('select');
        model.setAttribute('aria-label', '模型筛选');
        modelLabel.append(modelLabelText, model);
        const reset = iconButton('RotateCcw', '↺', '恢复默认筛选', 'uc-sg-reset');
        reset.dataset.sgReset = 'true';
        filterActions.append(commercialLabel, modelLabel, reset);
        filters.append(categoryRail, filterActions);

        const notice = element('div', 'uc-sg-notice');
        notice.setAttribute('role', 'status');
        notice.setAttribute('aria-live', 'polite');
        notice.hidden = true;
        const detail = element('section', 'uc-sg-detail');
        detail.setAttribute('aria-label', '风格详情');
        detail.hidden = true;
        const content = element('main', 'uc-sg-content');
        content.id = 'uc-sg-results';
        content.setAttribute('role', 'region');
        content.setAttribute('aria-label', '风格列表');
        content.tabIndex = 0;
        const grid = element('div', 'uc-sg-grid');
        grid.setAttribute('role', 'list');
        grid.setAttribute('aria-busy', 'true');
        const empty = element('div', 'uc-sg-empty', '没有找到符合条件的风格。');
        empty.setAttribute('role', 'status');
        empty.hidden = true;
        const error = element('div', 'uc-sg-error');
        error.setAttribute('role', 'alert');
        const errorText = element('p', '', '暂时无法读取风格，请检查网络后重试。');
        const retry = element('button', 'uc-sg-secondary-button', '重试');
        retry.type = 'button';
        retry.dataset.sgRetry = 'true';
        error.append(errorText, retry);
        error.hidden = true;
        const moreRow = element('div', 'uc-sg-more-row');
        const moreStatus = element('span', 'uc-sg-more-status');
        const moreButton = element('button', 'uc-sg-secondary-button', '加载更多');
        moreButton.type = 'button';
        moreButton.dataset.sgMore = 'true';
        moreRow.append(moreStatus, moreButton);
        moreRow.hidden = true;
        content.append(detail, grid, empty, error, moreRow);
        const status = element('span', 'uc-sg-sr-only');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        dialog.append(heading, header, filters, notice, content, status);
        ui = {
            tabs: tabs,
            search: input,
            maximize: maximize,
            closeButton: closeButton,
            categories: categories,
            commercial: commercial,
            commercialLabel: commercialLabel,
            commercialHelp: commercialHelp,
            model: model,
            detail: detail,
            content: content,
            grid: grid,
            empty: empty,
            error: error,
            errorText: errorText,
            retry: retry,
            moreRow: moreRow,
            moreButton: moreButton,
            moreStatus: moreStatus,
            notice: notice,
            status: status
        };
        return root;
    }

    function bindUI() {
        root.addEventListener('click', handleClick);
        ui.search.addEventListener('input', function () { scheduleSearch(ui.search.value); });
        ui.model.addEventListener('change', function () {
            state.model = ui.model.value;
            setFilterAndLoad();
        });
        ui.commercial.addEventListener('change', function () {
            state.commercialOnly = ui.commercial.checked && state.commercialAvailable;
            setFilterAndLoad();
        });
        ui.content.addEventListener('scroll', handleScroll, { passive: true });
        state.onKeydown = handleKeydown;
        state.onPointerDown = handlePointerDown;
        state.onPointerUp = handlePointerUp;
        state.onPagehide = function () { savePreferences(); notifyParentLayer(false); };
        window.addEventListener('keydown', state.onKeydown, true);
        window.addEventListener('pagehide', state.onPagehide, { once: true });
        document.addEventListener('pointerdown', state.onPointerDown, true);
        document.addEventListener('pointerup', state.onPointerUp, true);
    }

    function open(nextOptions) {
        if (root || !document.body) return false;
        options = nextOptions && typeof nextOptions === 'object' ? nextOptions : {};
        const prefs = readPreferences();
        state = Object.assign(prefs, {
            items: [],
            categories: [],
            models: [],
            commercialAvailable: false,
            selectedId: '',
            favoriteStates: Object.create(null),
            favoritePending: new Set(),
            applying: false,
            applyError: '',
            controller: null,
            requestId: 0,
            loading: false,
            loadingMore: false,
            loadMoreError: false,
            nextCursor: null,
            hasMore: false,
            searchTimer: null,
            scrollTimer: null,
            noticeTimer: null,
            storageWarningShown: false,
            storageResetFailed: false,
            restoreScroll: prefs.scrollTop,
            restoreHops: 0,
            autoLoadArmed: true,
            outsidePointer: null,
            previousFocus: document.activeElement,
            parentLayerActive: false
        });
        const node = createUI();
        document.body.append(node);
        notifyParentLayer(true);
        updateTabButtons();
        ui.search.value = state.query;
        ui.commercial.checked = state.commercialOnly;
        renderCategories([], false);
        renderModels([], false);
        bindUI();
        try { ui.search.focus({ preventScroll: true }); } catch { ui.search.focus(); }
        loadPage(false, true);
        return true;
    }

    function close() {
        if (!root || !isTopLayer() || state.applying) return false;
        const previousFocus = state.previousFocus;
        savePreferences();
        invalidateRequest();
        [state.searchTimer, state.scrollTimer, state.noticeTimer].forEach(timer => {
            if (timer) window.clearTimeout(timer);
        });
        window.removeEventListener('keydown', state.onKeydown, true);
        window.removeEventListener('pagehide', state.onPagehide);
        document.removeEventListener('pointerdown', state.onPointerDown, true);
        document.removeEventListener('pointerup', state.onPointerUp, true);
        root.remove();
        notifyParentLayer(false);
        root = null;
        dialog = null;
        ui = null;
        options = null;
        state = null;
        if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === 'function') {
            try { previousFocus.focus({ preventScroll: true }); } catch { previousFocus.focus(); }
        }
        return true;
    }

    window.UltimateCanvasStyleGallery = {
        open: open,
        close: close,
        isOpen: function () { return Boolean(root); }
    };
}());
