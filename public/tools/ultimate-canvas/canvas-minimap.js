(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.UltimateCanvasMinimap = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const DEFAULT_COLORS = Object.freeze({
        background: '#f5f7f8',
        border: '#9aa7ad',
        connection: '#a5b4b8',
        node: '#5b8790',
        flow: '#4f7d70',
        selected: '#d18442',
        viewport: '#245b69'
    });

    function computeMinimapModel(input = {}) {
        const width = Math.max(1, Number(input.width) || 1);
        const height = Math.max(1, Number(input.height) || 1);
        const padding = Math.max(4, Number(input.padding) || 10);
        const nodes = Array.isArray(input.nodes) ? input.nodes : [];
        const scale = Math.max(0.01, Number(input.viewport?.scale) || 1);
        const viewportWidth = Math.max(0, Number(input.viewportSize?.width) || 0) / scale;
        const viewportHeight = Math.max(0, Number(input.viewportSize?.height) || 0) / scale;
        const viewportLeft = -(Number(input.viewport?.offsetX) || 0) / scale;
        const viewportTop = -(Number(input.viewport?.offsetY) || 0) / scale;

        let minX = viewportLeft;
        let minY = viewportTop;
        let maxX = viewportLeft + viewportWidth;
        let maxY = viewportTop + viewportHeight;
        const measuredNodes = nodes.map(node => ({
            id: node.id,
            type: node.type,
            x: Number(node.x) || 0,
            y: Number(node.y) || 0,
            width: Math.max(24, Number(node.width) || 320),
            height: Math.max(18, Number(node.height) || 220)
        }));
        measuredNodes.forEach(node => {
            minX = Math.min(minX, node.x);
            minY = Math.min(minY, node.y);
            maxX = Math.max(maxX, node.x + node.width);
            maxY = Math.max(maxY, node.y + node.height);
        });
        if (maxX - minX < 1) maxX = minX + 1;
        if (maxY - minY < 1) maxY = minY + 1;
        const availableWidth = Math.max(1, width - padding * 2);
        const availableHeight = Math.max(1, height - padding * 2);
        const mapScale = Math.min(availableWidth / (maxX - minX), availableHeight / (maxY - minY));
        const drawnWidth = (maxX - minX) * mapScale;
        const drawnHeight = (maxY - minY) * mapScale;
        const mapLeft = (width - drawnWidth) / 2;
        const mapTop = (height - drawnHeight) / 2;
        const point = (x, y) => ({ x: mapLeft + (x - minX) * mapScale, y: mapTop + (y - minY) * mapScale });
        const mappedNodes = measuredNodes.map(node => {
            const mapped = point(node.x, node.y);
            return { ...node, left: mapped.x, top: mapped.y, drawWidth: Math.max(2, node.width * mapScale), drawHeight: Math.max(2, node.height * mapScale) };
        });
        const mappedById = new Map(mappedNodes.map(node => [node.id, node]));
        const connections = (Array.isArray(input.connections) ? input.connections : []).flatMap(edge => {
            const from = mappedById.get(edge.from);
            const to = mappedById.get(edge.to);
            if (!from || !to) return [];
            return [{
                from: edge.from, to: edge.to,
                x1: from.left + from.drawWidth / 2, y1: from.top + from.drawHeight / 2,
                x2: to.left + to.drawWidth / 2, y2: to.top + to.drawHeight / 2
            }];
        });
        return {
            width, height, padding, mapScale, mapLeft, mapTop,
            worldBounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
            nodes: mappedNodes,
            connections,
            viewport: {
                ...point(viewportLeft, viewportTop),
                width: Math.max(2, viewportWidth * mapScale),
                height: Math.max(2, viewportHeight * mapScale)
            }
        };
    }

    function createCanvasMinimap(engine, canvas, options = {}) {
        if (!engine || !canvas?.getContext) throw new TypeError('createCanvasMinimap requires an engine and canvas element');
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas 2D is unavailable');
        const colors = { ...DEFAULT_COLORS, ...(options.colors || {}) };
        const dpr = Math.max(1, Number(options.devicePixelRatio) || (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1);
        let frame = null;
        let activePointerId = null;
        let destroyed = false;
        let lastModel = null;
        const originalViewportHandler = engine.onViewportChanged;
        const originalGeometryHandler = engine.onCanvasGeometryChanged;

        canvas.tabIndex = canvas.tabIndex >= 0 ? canvas.tabIndex : 0;
        canvas.setAttribute('role', 'group');
        canvas.setAttribute('aria-label', options.label || '画布小地图，可拖动定位视口');
        canvas.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown ArrowLeft ArrowRight');
        canvas.style.touchAction = 'none';

        function dimensions() {
            const rect = canvas.getBoundingClientRect();
            return {
                width: Math.max(1, rect.width || Number(options.width) || 240),
                height: Math.max(1, rect.height || Number(options.height) || 160)
            };
        }

        function readNodes() {
            return [...engine.nodes.values()].map(node => {
                const element = engine.canvas?.querySelector?.(`[data-node-id="${CSS.escape(node.id)}"]`);
                const card = element?.querySelector?.('.node-card');
                return { ...node, width: element?.offsetWidth || card?.offsetWidth || 320, height: element?.offsetHeight || card?.offsetHeight || 220 };
            });
        }

        function draw() {
            if (destroyed) return null;
            const size = dimensions();
            const pixelWidth = Math.max(1, Math.round(size.width * dpr));
            const pixelHeight = Math.max(1, Math.round(size.height * dpr));
            if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
                canvas.width = pixelWidth;
                canvas.height = pixelHeight;
            }
            context.setTransform(dpr, 0, 0, dpr, 0, 0);
            context.clearRect(0, 0, size.width, size.height);
            context.fillStyle = colors.background;
            context.fillRect(0, 0, size.width, size.height);
            context.strokeStyle = colors.border;
            context.lineWidth = 1;
            context.strokeRect(0.5, 0.5, size.width - 1, size.height - 1);

            const containerSize = {
                width: engine.container?.clientWidth || 0,
                height: engine.container?.clientHeight || 0
            };
            lastModel = computeMinimapModel({
                width: size.width,
                height: size.height,
                padding: options.padding,
                nodes: readNodes(),
                viewport: { scale: engine.scale, offsetX: engine.offsetX, offsetY: engine.offsetY },
                viewportSize: containerSize,
                connections: engine.connections
            });
            const selected = new Set(engine.getSelectedNodeIds?.() || [engine.selectedNodeId].filter(Boolean));
            context.beginPath();
            context.strokeStyle = colors.connection;
            context.lineWidth = 1;
            lastModel.connections.forEach(edge => {
                context.moveTo(edge.x1, edge.y1);
                context.lineTo(edge.x2, edge.y2);
            });
            context.stroke();
            lastModel.nodes.forEach(node => {
                context.fillStyle = selected.has(node.id) ? colors.selected : String(node.type || '').startsWith('flow-') ? colors.flow : colors.node;
                context.fillRect(node.left, node.top, node.drawWidth, node.drawHeight);
            });
            context.strokeStyle = colors.viewport;
            context.lineWidth = 2;
            context.strokeRect(lastModel.viewport.x, lastModel.viewport.y, lastModel.viewport.width, lastModel.viewport.height);
            return lastModel;
        }

        function scheduleRender() {
            if (destroyed || frame !== null) return;
            const requestFrame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : callback => setTimeout(callback, 16);
            frame = requestFrame(() => { frame = null; draw(); });
        }

        function toWorld(clientX, clientY) {
            if (!lastModel) draw();
            const rect = canvas.getBoundingClientRect();
            const x = clientX - rect.left;
            const y = clientY - rect.top;
            return {
                x: lastModel.worldBounds.x + (x - lastModel.mapLeft) / lastModel.mapScale,
                y: lastModel.worldBounds.y + (y - lastModel.mapTop) / lastModel.mapScale
            };
        }

        function centerAtPointer(event) {
            const point = toWorld(event.clientX, event.clientY);
            if (typeof engine.centerAt === 'function') engine.centerAt(point.x, point.y);
            else {
                engine.offsetX = (engine.container.clientWidth / 2) - point.x * engine.scale;
                engine.offsetY = (engine.container.clientHeight / 2) - point.y * engine.scale;
                engine._applyTransform?.();
                engine._updateConnections?.();
            }
            scheduleRender();
        }

        function onPointerDown(event) {
            if (event.button !== undefined && event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            activePointerId = event.pointerId;
            canvas.setPointerCapture?.(event.pointerId);
            centerAtPointer(event);
        }

        function onPointerMove(event) {
            if (activePointerId === null || event.pointerId !== activePointerId) return;
            event.preventDefault();
            centerAtPointer(event);
        }

        function onPointerUp(event) {
            if (activePointerId !== event.pointerId) return;
            canvas.releasePointerCapture?.(event.pointerId);
            activePointerId = null;
        }

        function onKeyDown(event) {
            const directions = {
                ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]
            };
            const direction = directions[event.key];
            if (!direction) return;
            event.preventDefault();
            const scale = Math.max(0.15, Number(engine.scale) || 1);
            const stepX = (engine.container?.clientWidth || 320) / scale * 0.2;
            const stepY = (engine.container?.clientHeight || 220) / scale * 0.2;
            const center = {
                x: -(Number(engine.offsetX) || 0) / scale + stepX * 2.5,
                y: -(Number(engine.offsetY) || 0) / scale + stepY * 2.5
            };
            const x = center.x + direction[0] * stepX;
            const y = center.y + direction[1] * stepY;
            if (typeof engine.centerAt === 'function') engine.centerAt(x, y);
            scheduleRender();
        }

        const viewportHandler = function (value) {
            originalViewportHandler?.call(this, value);
            scheduleRender();
        };
        const geometryHandler = function (value) {
            originalGeometryHandler?.call(this, value);
            scheduleRender();
        };
        engine.onViewportChanged = viewportHandler;
        engine.onCanvasGeometryChanged = geometryHandler;
        canvas.addEventListener('pointerdown', onPointerDown);
        canvas.addEventListener('pointermove', onPointerMove);
        canvas.addEventListener('pointerup', onPointerUp);
        canvas.addEventListener('pointercancel', onPointerUp);
        canvas.addEventListener('keydown', onKeyDown);

        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleRender) : null;
        observer?.observe(canvas);
        draw();

        return {
            render: draw,
            getModel: () => lastModel,
            centerAt(x, y) {
                if (typeof engine.centerAt !== 'function') return false;
                engine.centerAt(x, y);
                return true;
            },
            destroy() {
                destroyed = true;
                observer?.disconnect();
                if (engine.onViewportChanged === viewportHandler) engine.onViewportChanged = originalViewportHandler;
                if (engine.onCanvasGeometryChanged === geometryHandler) engine.onCanvasGeometryChanged = originalGeometryHandler;
                canvas.removeEventListener('pointerdown', onPointerDown);
                canvas.removeEventListener('pointermove', onPointerMove);
                canvas.removeEventListener('pointerup', onPointerUp);
                canvas.removeEventListener('pointercancel', onPointerUp);
                canvas.removeEventListener('keydown', onKeyDown);
            }
        };
    }

    return { createCanvasMinimap, computeMinimapModel };
});
