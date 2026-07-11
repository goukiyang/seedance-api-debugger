/**
 * Canvas Engine – Panning, zooming, node drag, connections
 * Nodes rendered with label OUTSIDE card, connectors always visible
 */
const CanvasReferenceSelection = Object.freeze({
    start({ targetNodeId, previousSelectedNodeId = null, maximumReferences, references = [] }) {
        const maximum = Math.max(0, Number(maximumReferences) || 0);
        const durableReferences = references
            .filter(item => item?.nodeId && item?.referenceImageId)
            .slice(0, maximum);
        return {
            active: durableReferences.length < maximum,
            targetNodeId,
            previousSelectedNodeId,
            maximumReferences: maximum,
            references: durableReferences,
            startedAt: Date.now()
        };
    },

    add(session, candidate) {
        if (!session?.active || !candidate?.nodeId || !candidate?.referenceImageId) {
            return { session, accepted: false, finished: !session?.active };
        }
        if (session.references.some(item => item.referenceImageId === candidate.referenceImageId)) {
            return { session, accepted: false, finished: false };
        }
        if (session.references.length >= session.maximumReferences) {
            return { session: { ...session, active: false }, accepted: false, finished: true };
        }
        const references = [...session.references, {
            nodeId: candidate.nodeId,
            referenceImageId: candidate.referenceImageId
        }];
        const finished = references.length >= session.maximumReferences;
        return {
            session: { ...session, active: !finished, references },
            accepted: true,
            finished
        };
    },

    sync(session, references = []) {
        if (!session) return null;
        const durableReferences = references.filter(item => item?.nodeId && item?.referenceImageId);
        return { ...session, references: durableReferences };
    },

    transition(session, action) {
        if (!session) return { session: null, selectedNodeId: null };
        if (action === 'return') return { session, selectedNodeId: session.targetNodeId };
        if (action === 'exit') return { session: { ...session, active: false }, selectedNodeId: session.targetNodeId };
        return { session, selectedNodeId: null };
    },

    deleteNode(session, nodeId) {
        if (!session) return null;
        if (nodeId === session.targetNodeId) return { ...session, active: false };
        return {
            ...session,
            references: session.references.filter(item => item.nodeId !== nodeId)
        };
    },

    pendingTargetId(session) {
        return session?.active ? session.targetNodeId : null;
    }
});

class CanvasEngine {
    constructor(containerId, canvasId, svgId) {
        this.container = document.getElementById(containerId);
        this.canvas = document.getElementById(canvasId);
        this.svg = document.getElementById(svgId);
        this.svg.setAttribute('overflow', 'visible');
        this.svg.style.overflow = 'visible';

        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;

        this.isPanning = false;
        this.panStartX = 0;
        this.panStartY = 0;

        this.isDraggingNode = false;
        this.dragNode = null;
        this.dragStartX = 0;
        this.dragStartY = 0;
        this.nodeStartX = 0;
        this.nodeStartY = 0;

        this.isDrawingConnection = false;
        this.connectionStartConnector = null;
        this.tempConnectionLine = null;

        this.nodes = new Map();
        this.connections = [];
        this.selectedNodeId = null;
        this.nextNodeId = 1;

        this.onNodeSelected = null;
        this.onNodeDeselected = null;
        this.onConnectionCreated = null;
        this.onConnectionDeleted = null;
        this.onNodeDeleted = null;
        this.onViewportChanged = null;

        this.connectionResizeFrame = null;
        this.nodeResizeObserver = typeof ResizeObserver === 'function'
            ? new ResizeObserver(() => {
                if (this.connectionResizeFrame !== null) return;
                this.connectionResizeFrame = requestAnimationFrame(() => {
                    this.connectionResizeFrame = null;
                    this._updateConnections();
                });
            })
            : null;

        this.isSnapEnabled = true; // Snap to grid by default
        this.isSpacePressed = false;
        this.isSelecting = false;
        this.selectionStartX = 0;
        this.selectionStartY = 0;
        this.hasPannedDuringRightClick = false;

        this._initEvents();
    }

    _initEvents() {
        this.container.addEventListener('mousedown', (e) => this._onMouseDown(e));
        window.addEventListener('mousemove', (e) => this._onMouseMove(e));
        window.addEventListener('mouseup', (e) => this._onMouseUp(e));
        this.container.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
        this.container.addEventListener('dblclick', (e) => this._onDoubleClick(e));
        this.container.addEventListener('contextmenu', (e) => this._onContextMenu(e));

        this.container.addEventListener('click', (e) => {
            if (e.target === this.container || e.target === this.canvas) {
                this._deselectAll();
                this._hideContextMenu();
                this._hideAddMenu();
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this._hideContextMenu();
                this._hideAddMenu();
                if (this.isDrawingConnection) this._cancelConnection();
            }
            if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedNodeId
                && !['TEXTAREA','INPUT'].includes(document.activeElement.tagName)
                && !document.activeElement.isContentEditable) {
                this.deleteNode(this.selectedNodeId);
            }
        });

        window.addEventListener('keydown', (e) => {
            if (e.key === ' ' && !['TEXTAREA', 'INPUT'].includes(document.activeElement.tagName) && !document.activeElement.isContentEditable) {
                this.isSpacePressed = true;
                this.container.style.cursor = 'grab';
                if (document.activeElement === document.body) {
                    e.preventDefault();
                }
            }
        });
        window.addEventListener('keyup', (e) => {
            if (e.key === ' ') {
                this.isSpacePressed = false;
                this.container.style.cursor = 'default';
            }
        });
    }

    // --- Mouse Handlers ---
    _onMouseDown(e) {
        const isSpace = this.isSpacePressed;
        // Panning: Middle click (1), Right click (2), or Space + Left click (0)
        if (e.button === 1 || e.button === 2 || (e.button === 0 && isSpace)) {
            this.isPanning = true;
            this.panStartX = e.clientX - this.offsetX;
            this.panStartY = e.clientY - this.offsetY;
            this.container.style.cursor = 'grabbing';
            if (e.button === 2) {
                this.hasPannedDuringRightClick = false;
            }
            e.preventDefault();
        } else if (e.button === 0 && (e.target === this.container || e.target === this.canvas)) {
            // Box selection on left click on empty space!
            this.isSelecting = true;
            this.selectionStartX = e.clientX;
            this.selectionStartY = e.clientY;
            this._deselectAll();
            e.preventDefault();
        }
    }

    _onMouseMove(e) {
        if (this.isPanning) {
            // Track if we actually moved the mouse during right-click panning
            this.hasPannedDuringRightClick = true;
            this.offsetX = e.clientX - this.panStartX;
            this.offsetY = e.clientY - this.panStartY;
            this._applyTransform();
            this._updateConnections();
        }
        if (this.isSelecting) {
            const rect = this.container.getBoundingClientRect();
            const x1 = Math.min(this.selectionStartX, e.clientX) - rect.left;
            const y1 = Math.min(this.selectionStartY, e.clientY) - rect.top;
            const w = Math.abs(this.selectionStartX - e.clientX);
            const h = Math.abs(this.selectionStartY - e.clientY);

            const marquee = document.getElementById('selection-marquee');
            if (marquee) {
                marquee.style.left = x1 + 'px';
                marquee.style.top = y1 + 'px';
                marquee.style.width = w + 'px';
                marquee.style.height = h + 'px';
                marquee.classList.remove('hidden');

                // Select overlapping nodes
                const mRect = marquee.getBoundingClientRect();
                let selectedAny = false;
                this.nodes.forEach((nd, id) => {
                    const el = document.querySelector(`[data-node-id="${id}"]`);
                    if (el) {
                        const card = el.querySelector('.node-card');
                        const cRect = card.getBoundingClientRect();
                        const overlap = !(cRect.right < mRect.left ||
                                          cRect.left > mRect.right ||
                                          cRect.bottom < mRect.top ||
                                          cRect.top > mRect.bottom);
                        if (overlap) {
                            el.classList.add('selected');
                            this.selectedNodeId = id;
                            selectedAny = true;
                        } else {
                            el.classList.remove('selected');
                        }
                    }
                });

                if (!selectedAny) {
                    this.selectedNodeId = null;
                }
            }
        }
        if (this.isDraggingNode && this.dragNode) {
            const dx = (e.clientX - this.dragStartX) / this.scale;
            const dy = (e.clientY - this.dragStartY) / this.scale;
            let newX = this.nodeStartX + dx;
            let newY = this.nodeStartY + dy;

            if (this.isSnapEnabled) {
                const gridSize = 20;
                newX = Math.round(newX / gridSize) * gridSize;
                newY = Math.round(newY / gridSize) * gridSize;
            }

            this.dragNode.style.left = newX + 'px';
            this.dragNode.style.top = newY + 'px';
            const nd = this.nodes.get(this.dragNode.dataset.nodeId);
            if (nd) { nd.x = newX; nd.y = newY; }
            this._updateConnections();
        }
        if (this.isDrawingConnection && this.tempConnectionLine) {
            const cr = this.container.getBoundingClientRect();
            const mx = (e.clientX - cr.left - this.offsetX) / this.scale;
            const my = (e.clientY - cr.top - this.offsetY) / this.scale;
            const sp = this._getConnectorPos(this.connectionStartConnector);
            this._setPath(this.tempConnectionLine, sp.x, sp.y, mx, my);
        }
    }

    _onMouseUp(e) {
        if (this.isPanning) {
            this.isPanning = false;
            this.container.style.cursor = this.isSpacePressed ? 'grab' : 'default';
        }
        if (this.isSelecting) {
            this.isSelecting = false;
            document.getElementById('selection-marquee')?.classList.add('hidden');
        }
        if (this.isDraggingNode) {
            this.isDraggingNode = false;
            if (this.dragNode) this.dragNode.classList.remove('dragging');
            this.dragNode = null;
        }
        if (this.isDrawingConnection) {
            const target = document.elementFromPoint(e.clientX, e.clientY);
            const conn = target?.closest('.node-connector');
            const startConnector = this.connectionStartConnector;
            if (conn && conn !== startConnector) {
                const pair = this._connectionPair(startConnector, conn);
                if (pair && pair.fromId !== pair.toId) this._createConnection(pair.fromId, pair.toId);
            } else if (!target?.closest('.canvas-node')) {
                const startId = startConnector?.closest('.canvas-node')?.dataset.nodeId;
                if (startId) {
                    this._showAddMenu(e.clientX, e.clientY, {
                        connectNodeId: startId,
                        connectRole: startConnector.classList.contains('input') ? 'input' : 'output'
                    });
                }
            }
            this._cancelConnection();
        }
    }

    _onWheel(e) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.06 : 0.06;
        const newScale = Math.max(0.15, Math.min(3, this.scale + delta));
        const rect = this.container.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        this.offsetX = mx - (mx - this.offsetX) * (newScale / this.scale);
        this.offsetY = my - (my - this.offsetY) * (newScale / this.scale);
        this.scale = newScale;
        this._applyTransform();
        this._updateZoom();
        this._updateConnections();
    }

    _onDoubleClick(e) {
        if (e.target.closest('.canvas-node') || e.target.closest('.canvas-welcome')
            || e.target.closest('.add-node-menu') || e.target.closest('.side-panel')) return;
        this._showAddMenu(e.clientX, e.clientY);
    }

    _onContextMenu(e) {
        e.preventDefault();
        const nodeEl = e.target.closest('.canvas-node');
        this._showContextMenu(e.clientX, e.clientY, nodeEl ? nodeEl.dataset.nodeId : null);
    }

    // --- Transform ---
    _applyTransform() {
        const t = `translate(${this.offsetX}px, ${this.offsetY}px) scale(${this.scale})`;
        this.canvas.style.transform = t;
        this.svg.style.transform = t;
        this.onViewportChanged?.({ scale: this.scale, offsetX: this.offsetX, offsetY: this.offsetY });
    }
    _updateZoom() {
        const el = document.getElementById('zoom-level');
        if (el) el.textContent = Math.round(this.scale * 100) + '%';
    }
    setZoom(v) {
        const rect = this.container.getBoundingClientRect();
        const cx = rect.width / 2, cy = rect.height / 2;
        const nv = Math.max(0.15, Math.min(3, v));
        this.offsetX = cx - (cx - this.offsetX) * (nv / this.scale);
        this.offsetY = cy - (cy - this.offsetY) * (nv / this.scale);
        this.scale = nv;
        this._applyTransform();
        this._updateZoom();
        this._updateConnections();
    }

    // --- Add-node Menu ---
    _showAddMenu(clientX, clientY, options = {}) {
        this._hideAddMenu();
        const menu = document.getElementById('add-node-menu');
        menu.style.left = clientX + 'px';
        menu.style.top = clientY + 'px';
        menu.classList.remove('hidden');
        // Store canvas coords for node placement
        const rect = this.container.getBoundingClientRect();
        menu._canvasX = (clientX - rect.left - this.offsetX) / this.scale;
        menu._canvasY = (clientY - rect.top - this.offsetY) / this.scale;
        menu._pendingConnection = options.connectNodeId ? {
            nodeId: options.connectNodeId,
            role: options.connectRole || 'output'
        } : null;
        menu.classList.toggle('connection-mode', Boolean(menu._pendingConnection));
    }
    _hideAddMenu() {
        const menu = document.getElementById('add-node-menu');
        if (!menu) return;
        menu.classList.add('hidden');
        menu.classList.remove('connection-mode');
        menu._pendingConnection = null;
    }

    // --- Nodes ---
    addNode(type, x, y, data = {}) {
        const requestedId = typeof data?.id === 'string' && data.id.trim() ? data.id.trim() : '';
        const id = requestedId || 'node-' + this.nextNodeId++;
        const match = id.match(/^node-(\d+)$/);
        if (match) this.nextNodeId = Math.max(this.nextNodeId, Number(match[1]) + 1);
        const cleanData = { ...(data || {}) };
        delete cleanData.id;
        const nodeData = { id, type, x, y, data: cleanData };
        this.nodes.set(id, nodeData);
        const el = this._buildNode(nodeData);
        this.canvas.appendChild(el);
        this.nodeResizeObserver?.observe(el);
        document.getElementById('canvas-welcome')?.classList.add('hidden');
        this._selectNode(id);
        return id;
    }

    serialize() {
        return {
            version: 1,
            viewport: {
                scale: this.scale,
                offsetX: this.offsetX,
                offsetY: this.offsetY,
                nextNodeId: this.nextNodeId
            },
            selectedNodeId: this.selectedNodeId,
            nodes: Array.from(this.nodes.values()).map(node => ({
                id: node.id,
                type: node.type,
                x: node.x,
                y: node.y,
                data: node.data || {}
            })),
            connections: this.connections.map(connection => ({
                from: connection.from,
                to: connection.to
            }))
        };
    }

    restore(snapshot = {}) {
        this.canvas.querySelectorAll('.canvas-node').forEach(node => {
            this.nodeResizeObserver?.unobserve(node);
            node.remove();
        });
        this.svg.querySelectorAll('.connection-line').forEach(line => line.remove());
        this.nodes.clear();
        this.connections = [];
        this.selectedNodeId = null;
        this.nextNodeId = 1;

        const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
        nodes.forEach(node => {
            if (!node?.type || !node?.id) return;
            this.addNode(node.type, Number(node.x) || 0, Number(node.y) || 0, {
                ...(node.data || {}),
                id: node.id
            });
        });

        const connections = Array.isArray(snapshot.connections) ? snapshot.connections : [];
        connections.forEach(connection => {
            if (connection?.from && connection?.to) this._createConnection(connection.from, connection.to);
        });

        const viewport = snapshot.viewport || {};
        this.scale = Number.isFinite(Number(viewport.scale)) ? Number(viewport.scale) : 1;
        this.offsetX = Number.isFinite(Number(viewport.offsetX)) ? Number(viewport.offsetX) : 0;
        this.offsetY = Number.isFinite(Number(viewport.offsetY)) ? Number(viewport.offsetY) : 0;
        if (Number.isFinite(Number(viewport.nextNodeId))) {
            this.nextNodeId = Math.max(this.nextNodeId, Number(viewport.nextNodeId));
        }
        this._applyTransform();
        this._updateZoom();
        this._updateConnections();
        document.getElementById('canvas-welcome')?.classList.toggle('hidden', this.nodes.size > 0);
    }

    deleteNode(nodeId) {
        const nodeEl = document.querySelector(`[data-node-id="${nodeId}"]`);
        if (nodeEl) {
            this.nodeResizeObserver?.unobserve(nodeEl);
            nodeEl.remove();
        }
        this.connections = this.connections.filter(c => {
            if (c.from === nodeId || c.to === nodeId) {
                document.getElementById(c.lineId)?.remove();
                this.onConnectionDeleted?.(c.from, c.to);
                return false;
            }
            return true;
        });
        const deleted = this.nodes.delete(nodeId);
        if (this.selectedNodeId === nodeId) {
            this.selectedNodeId = null;
            this.onNodeDeselected?.();
        }
        if (this.nodes.size === 0)
            document.getElementById('canvas-welcome')?.classList.remove('hidden');
        if (deleted) this.onNodeDeleted?.(nodeId);
    }

    _buildNode(nd) {
        const { id, type, x, y } = nd;
        const wrap = document.createElement('div');
        wrap.className = `canvas-node node-type-${type}`;
        wrap.dataset.nodeId = id;
        wrap.style.left = x + 'px';
        wrap.style.top = y + 'px';

        const labelIcon = this._icon(type);
        const label = this._label(type, id);
        const body = this._body(type, id);

        wrap.innerHTML = `
            <div class="node-label">${labelIcon} ${label}</div>
            <div class="node-card">
                <div class="node-body">${body}</div>
                <div class="node-connector input"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></div>
                <div class="node-connector output"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></div>
            </div>
            ${this._propsPanel(type, id)}
        `;

        // Drag via label
        const lbl = wrap.querySelector('.node-label');
        lbl.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            this.isDraggingNode = true;
            this.dragNode = wrap;
            this.dragStartX = e.clientX;
            this.dragStartY = e.clientY;
            this.nodeStartX = parseFloat(wrap.style.left);
            this.nodeStartY = parseFloat(wrap.style.top);
            wrap.classList.add('dragging');
            this._selectNode(id);
        });

        // Also drag via card header area (but not inputs/buttons inside)
        wrap.querySelector('.node-card').addEventListener('mousedown', (e) => {
            if (e.target.closest('.node-connector') || e.target.closest('textarea')
                || e.target.closest('button') || e.target.closest('.node-action-row')
                || e.target.closest('[contenteditable]') || e.target.closest('.video-props-tab')
                || e.target.closest('.video-tool-btn') || e.target.closest('.image-props-tools')
                || e.target.closest('.model-selector') || e.target.closest('.director-actor')
                || e.target.closest('.director-shot-chip')) return;
            e.stopPropagation();
            this.isDraggingNode = true;
            this.dragNode = wrap;
            this.dragStartX = e.clientX;
            this.dragStartY = e.clientY;
            this.nodeStartX = parseFloat(wrap.style.left);
            this.nodeStartY = parseFloat(wrap.style.top);
            wrap.classList.add('dragging');
            this._selectNode(id);
        });

        // Select
        wrap.addEventListener('mousedown', (e) => {
            if (!e.target.closest('.node-connector')) this._selectNode(id);
        });

        // Connectors
        wrap.querySelectorAll('.node-connector').forEach(c => {
            c.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                this.isDrawingConnection = true;
                this.connectionStartConnector = c;
                const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                line.classList.add('connection-line', 'temp');
                this.svg.appendChild(line);
                this.tempConnectionLine = line;
            });
        });

        return wrap;
    }

    _label(type, id) {
        const n = { text:'文本节点', image:'图片节点', video:'视频', audio:'音频',
                    'video-compose':'视频合成', director:'导演台', script:'脚本' }[type] || '节点';
        const num = id.replace('node-','');
        return `${n} ${num}`;
    }
    _icon(type) {
        const map = {
            text: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="14" y2="18"/></svg>`,
            image: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
            video: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
            audio: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/></svg>`,
            'video-compose': `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/></svg>`,
            director: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>`,
            script: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`
        };
        return map[type] || '';
    }

    _directorData() {
        return window.LIBLIB_DIRECTOR_DATA || { models: [], posePresets: [], assetBasePath: '' };
    }

    _directorModelFallback(index = 0) {
        const fallbacks = [
            { type: 'male-lowpoly', label: '男性-低模', color: '#4ecdc4', previewHeight: 78, file: '' },
            { type: 'female-lowpoly', label: '女性-低模', color: '#f472b6', previewHeight: 74, file: '' },
            { type: 'muscular', label: '健硕', color: '#f59e0b', previewHeight: 88, file: '' }
        ];
        return fallbacks[index % fallbacks.length];
    }

    _directorActorMarkup(actorId, roleName, model, x, y, active = false) {
        const m = model || this._directorModelFallback(0);
        return `
            <button class="director-actor ${active ? 'active' : ''}" data-actor="${actorId}"
                    data-model-type="${m.type}" data-model-label="${m.label}" data-pose-id="stand"
                    style="--actor-x:${x};--actor-y:${y};--actor-h:${m.previewHeight || 74}px;--actor-color:${m.color || '#4ecdc4'};">
                <span class="actor-shadow"></span>
                <span class="actor-leg left"></span><span class="actor-leg right"></span>
                <span class="actor-arm left"></span><span class="actor-arm right"></span>
                <span class="actor-body"></span><span class="actor-head"></span>
                <span class="actor-name">${roleName}</span>
                <span class="actor-model-label">${m.label}</span>
            </button>`;
    }

    _directorModelButtons() {
        const models = this._directorData().models || [];
        const source = models.length ? models : [0, 1, 2].map(i => this._directorModelFallback(i));
        return source.map((m, i) => `
            <button class="director-model-chip ${i === 0 ? 'active' : ''}" data-director-model="${m.type}"
                    style="--model-color:${m.color || '#4ecdc4'};">
                <span class="director-model-swatch"></span>
                <strong>${m.label}</strong>
                <small>${m.file || m.type}</small>
            </button>`).join('');
    }

    _directorPoseButtons() {
        const poses = this._directorData().posePresets || [];
        const fallback = [
            { id: 'stand', label: '站立', icon: '站' },
            { id: 'walk', label: '行走', icon: '走' },
            { id: 'run', label: '跑步', icon: '跑' }
        ];
        return (poses.length ? poses : fallback).map((p, i) => `
            <button class="director-pose-chip ${i === 0 ? 'active' : ''}" data-director-pose-preset="${p.id}">
                <span>${p.icon || '姿'}</span>${p.label}
            </button>`).join('');
    }

    _body(type, id) {
        switch (type) {
            case 'text': return `
                <div class="node-text-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="14" y2="18"/>
                    </svg>
                </div>
                <div class="node-text-actions">
                    <div class="node-try-label">尝试:</div>
                    <div class="node-action-row" data-action="write" data-nid="${id}">
                        <span class="action-icon">📝</span>自己编写内容
                    </div>
                    <div class="node-action-row accent" data-action="txt2video" data-nid="${id}">
                        <span class="action-icon">▶</span>文生视频
                    </div>
                    <div class="node-action-row accent" data-action="img-prompt" data-nid="${id}">
                        <span class="action-icon">🖼</span>图片及推理提示词
                    </div>
                    <div class="node-action-row" data-action="txt2music" data-nid="${id}">
                        <span class="action-icon">🔊</span>文字生音乐
                    </div>
                </div>
                <div class="node-context-rules-row">
                    <button class="context-rules-button context-rules-card-button" data-context-rules-open title="编辑影响本节点 LLM 上下文的规则">
                        <span>规则</span>
                    </button>
                </div>`;
            case 'video': return `
                <div class="card-preview-placeholder">
                    <svg width="54" height="54" viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="6 3 20 12 6 21 6 3"/>
                    </svg>
                </div>
                <div class="node-try-section">
                    <div class="node-try-label">尝试:</div>
                    <div class="node-try-list">
                        <div class="node-action-item node-action-row accent" data-action="vid-keyframe" data-nid="${id}">
                            <span class="action-icon">🥞</span>首尾帧生成视频
                        </div>
                        <div class="node-action-item node-action-row accent" data-action="vid-firstframe" data-nid="${id}">
                            <span class="action-icon">✦</span>首帧生成视频
                        </div>
                    </div>
                </div>`;
            case 'image': return `
                <div class="card-preview-placeholder">
                    <svg width="54" height="54" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
                        <rect x="3" y="3" width="18" height="18" rx="2"/>
                        <circle cx="8.5" cy="8.5" r="1.5"/>
                        <polyline points="21 15 16 10 5 21"/>
                    </svg>
                </div>
                <div class="node-try-section">
                    <div class="node-try-label">尝试:</div>
                    <div class="node-try-list">
                        <div class="node-action-item node-action-row accent" data-action="img2img" data-nid="${id}">
                            <span class="action-icon">📤</span>图生图
                        </div>
                        <div class="node-action-item node-action-row accent" data-action="img-hd" data-nid="${id}">
                            <span class="action-icon">HD</span>图片高清
                        </div>
                    </div>
                </div>`;
            case 'audio': return `
                <div class="audio-waveform">
                    <div class="audio-bar"></div><div class="audio-bar"></div>
                    <div class="audio-bar"></div><div class="audio-bar"></div>
                    <div class="audio-bar"></div><div class="audio-bar"></div>
                    <div class="audio-bar"></div><div class="audio-bar"></div>
                </div>`;
            case 'director': {
                return `
                <div class="director-node-shell">
                    <div class="director-card-header">
                        <div>
                            <span class="director-kicker">3D Director Stage</span>
                            <strong>导演台</strong>
                        </div>
                        <span class="director-status" data-director-status>在3D空间中搭建场景</span>
                    </div>
                    <div class="director-viewport" data-director-stage>
                        <div class="director-3d-stage" data-director-3d-stage>
                            <div class="director-3d-loading" data-director-3d-loading>启动 3D 导演台</div>
                        </div>
                        <div class="director-panorama-ring"></div>
                        <div class="director-light-beam"></div>
                        <div class="director-camera-frame"></div>
                        <div class="director-floor-grid"></div>
                        <div class="director-axis x">X</div>
                        <div class="director-axis z">Z</div>
                        <div class="director-empty-stage">打开导演台后添加角色模型</div>
                        <div class="director-camera-rig">
                            <span class="camera-dot"></span>
                            <span class="camera-label">A Cam</span>
                        </div>
                    </div>
                    <div class="director-shot-strip">
                        <button class="director-open-btn" data-director-action="open-studio">打开导演台</button>
                        <button class="director-shot-chip active" data-director-shot="wide">全景</button>
                        <button class="director-shot-chip" data-director-shot="close">特写</button>
                        <button class="director-shot-chip" data-director-shot="top">俯拍</button>
                        <button class="director-shot-chip" data-director-shot="reverse">反打</button>
                    </div>
                </div>`;
            }
            default: return `<div class="image-placeholder"><span>${this._label(type, id)}</span></div>`;
        }
    }

    _propsPanel(type, id) {
        if (type === 'text') return `
            <div class="node-input-bar">
                <button class="video-props-expand" data-prompt-expand title="展开提示词">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/></svg>
                </button>
                <textarea class="node-input-textarea" placeholder="写下你想讲的故事、场景或角色设定。例如：一个来自未来的机器人，在城市屋顶看星星。"></textarea>
                <div class="node-input-footer">
                    <div class="node-input-left">
                        <div class="model-selector">
                            <span class="model-icon">🧠</span>
                            <span>gpt5.4</span>
                            <span class="chevron">▾</span>
                        </div>
                        <button class="context-rules-button" data-context-rules-open title="编辑影响本节点 LLM 上下文的规则">
                            <span>规则</span>
                        </button>
                    </div>
                    <div class="input-footer-right">
                        <button class="footer-icon-btn" title="翻译">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 8l6 6"/><path d="M4 14l6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/></svg>
                        </button>
                        <span class="cost-label">LLM</span>
                        <button class="submit-btn" title="生成">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
                        </button>
                    </div>
                </div>
            </div>`;

        if (type === 'video') return `
            <div class="node-video-props node-generation-expanded">
                <button class="video-props-expand" data-prompt-expand title="展开提示词">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/></svg>
                </button>
                <div class="generation-summary-row">
                    <button type="button" class="generation-summary-button" data-generation-popover="mode" aria-expanded="false">
                        <span data-generation-mode-label>文生视频</span>
                    </button>
                    <button type="button" class="generation-summary-button" data-generation-command="toggle-settings" data-generation-settings="video" data-generation-popover="spec" aria-expanded="false">
                        <span data-generation-spec>16:9 · 720p · 5s</span>
                    </button>
                </div>
                <div class="generation-node-toolbar">
                    <button type="button" class="generation-command" data-generation-command="optimize-prompt">优化提示词</button>
                    <button type="button" class="generation-command" data-generation-command="camera-presets" data-generation-popover="camera" aria-expanded="false">运镜</button>
                    <button type="button" class="generation-command" data-generation-command="select-reference">选择参考</button>
                    <button type="button" class="generation-command" data-generation-command="disconnect-references">清空参考</button>
                </div>
                <div class="generation-reference-list" data-generation-reference-list>
                    <span class="generation-reference-empty">未连接参考图</span>
                </div>
                <textarea class="video-props-textarea" placeholder="根据文字描述生成视频。"></textarea>
                <div class="video-props-footer">
                    <div class="video-model-info">
                        <span class="model-icon">📊</span>
                        <span>默认视频 API</span>
                    </div>
                    <div class="video-footer-right">
                        <span class="cost-label" data-generation-cost>后台计费</span>
                        <button class="submit-btn" data-generation-submit title="生成视频">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
                        </button>
                    </div>
                </div>
            </div>`;

        if (type === 'image') return `
            <div class="node-image-props node-generation-expanded">
                <button class="video-props-expand" data-prompt-expand title="展开提示词">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/></svg>
                </button>
                <div class="generation-summary-row">
                    <button type="button" class="generation-summary-button" data-generation-popover="mode" aria-expanded="false">
                        <span data-generation-mode-label>文生图</span>
                    </button>
                    <button type="button" class="generation-summary-button" data-generation-command="toggle-settings" data-generation-settings="image" data-generation-popover="spec" aria-expanded="false">
                        <span data-generation-spec>16:9 · 1K · 1张</span>
                    </button>
                </div>
                <div class="generation-node-toolbar image-generation-toolbar">
                    <button type="button" class="generation-command" data-generation-command="select-reference">选择参考</button>
                    <button type="button" class="generation-command" data-generation-command="disconnect-references">清空参考</button>
                </div>
                <div class="generation-reference-list" data-generation-reference-list>
                    <span class="generation-reference-empty">未连接参考图</span>
                </div>
                <textarea class="image-props-textarea" placeholder="描述你想要生成的画面内容。描述越详细,效果越好。"></textarea>
                <div class="image-props-footer">
                    <div class="video-model-info">
                        <span class="model-icon">✨</span>
                        <span>gmini 图形生成</span>
                        <span class="chevron" style="color:var(--text-dim)">▾</span>
                    </div>
                    <div class="video-footer-right">
                        <span class="cost-label" data-generation-cost>后台计费</span>
                        <button class="submit-btn" data-generation-submit title="生成图片">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
                        </button>
                    </div>
                </div>
            </div>`;

        if (type === 'director') return `
            <div class="node-director-props" data-director-props data-nid="${id}">
                <div class="director-props-top">
                    <div class="video-props-tabs">
                        <div class="video-props-tab active">机位</div>
                        <div class="video-props-tab">角色站位</div>
                        <div class="video-props-tab">灯光</div>
                        <div class="video-props-tab">分镜输出</div>
                    </div>
                    <button class="video-props-expand" title="展开">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/></svg>
                    </button>
                </div>
                <div class="director-control-grid">
                    <label class="director-control">
                        <span>水平环绕 <b data-director-readout="yaw">18°</b></span>
                        <input type="range" min="-180" max="180" value="18" data-director-control="yaw">
                    </label>
                    <label class="director-control">
                        <span>俯仰机位 <b data-director-readout="pitch">8°</b></span>
                        <input type="range" min="-35" max="45" value="8" data-director-control="pitch">
                    </label>
                    <label class="director-control">
                        <span>景别缩放 <b data-director-readout="zoom">72mm</b></span>
                        <input type="range" min="35" max="120" value="72" data-director-control="zoom">
                    </label>
                    <label class="director-control">
                        <span>电影光比 <b data-director-readout="light">64%</b></span>
                        <input type="range" min="20" max="100" value="64" data-director-control="light">
                    </label>
                </div>
                <div class="director-liblib-section">
                    <div class="director-section-head">
                        <span>角色素模</span>
                        <small>LiblibTV 3D characters · ${this._directorData().models?.length || 0} models</small>
                    </div>
                    <div class="director-model-grid">
                        ${this._directorModelButtons()}
                    </div>
                </div>
                <div class="director-liblib-section">
                    <div class="director-section-head">
                        <span>动作姿势</span>
                        <small>semantic jointAngles · ${this._directorData().posePresets?.length || 0} presets</small>
                    </div>
                    <div class="director-pose-grid">
                        ${this._directorPoseButtons()}
                    </div>
                </div>
                <div class="director-tools-row">
                    <button class="video-tool-btn active" data-director-pose="neutral"><span class="tool-icon-text">站</span><span>锁定比例</span></button>
                    <button class="video-tool-btn" data-director-pose="action"><span class="tool-icon-text">动</span><span>动作姿势</span></button>
                    <button class="video-tool-btn" data-director-pose="cross"><span class="tool-icon-text">线</span><span>交叉走位</span></button>
                    <button class="video-tool-btn" data-director-action="add-actor"><span class="tool-icon-text">+</span><span>添加人物素模</span></button>
                    <button class="video-tool-btn" data-director-action="panorama"><span class="tool-icon-text">720</span><span>全景场景</span></button>
                </div>
                <textarea class="director-prompt" placeholder="描述镜头调度，例如：主角从左前景进入，反派保持 1.7 倍身高在右后方压迫，镜头低机位缓慢推近，冷暖对比光。"></textarea>
                <div class="director-output-row">
                    <button class="director-output-btn" data-director-action="storyboard">
                        <span>生成分镜参考图</span><small>输出定位截图节点</small>
                    </button>
                    <button class="director-output-btn primary" data-director-action="video">
                        <span>接入首尾帧视频</span><small>创建视频节点并连线</small>
                    </button>
                    <button class="director-output-btn" data-director-action="grid">
                        <span>四宫格机位</span><small>全景/特写/俯拍/反打</small>
                    </button>
                </div>
            </div>`;

        return '';
    }

    // --- Selection ---
    selectNode(nodeId) {
        if (!this.nodes.has(nodeId)) return false;
        this._selectNode(nodeId);
        return true;
    }

    _selectNode(id) {
        this._deselectAll();
        this.selectedNodeId = id;
        document.querySelector(`[data-node-id="${id}"]`)?.classList.add('selected');
        this.onNodeSelected?.(id, this.nodes.get(id));
    }
    _deselectAll() {
        document.querySelectorAll('.canvas-node.selected').forEach(n => n.classList.remove('selected'));
        if (this.selectedNodeId) this.onNodeDeselected?.();
        this.selectedNodeId = null;
    }

    // --- Connections ---
    connectNodes(fromId, toId) {
        if (!this.nodes.has(fromId) || !this.nodes.has(toId) || fromId === toId) return false;
        const before = this.connections.length;
        this._createConnection(fromId, toId);
        return this.connections.length > before;
    }

    disconnectNodes(fromId, toId) {
        const removed = this.connections.filter(item => item.from === fromId && item.to === toId);
        if (!removed.length) return false;
        removed.forEach(item => document.getElementById(item.lineId)?.remove());
        this.connections = this.connections.filter(item => !(item.from === fromId && item.to === toId));
        removed.forEach(item => this.onConnectionDeleted?.(item.from, item.to));
        this._updateConnections();
        return true;
    }

    disconnectIncoming(nodeId) {
        const incoming = this.connections.filter(item => item.to === nodeId);
        incoming.forEach(item => this.disconnectNodes(item.from, item.to));
        return incoming.length;
    }

    _getConnectorPos(el) {
        let x = 0;
        let y = 0;
        let curr = el;
        // Traverse up the offsetParent chain to get stable local coordinates inside the canvas
        // This is 100% immune to CSS transforms (zoom/pan), timing issues, or viewport layout latency.
        while (curr && curr !== this.canvas && curr !== document.body) {
            x += curr.offsetLeft || 0;
            y += curr.offsetTop || 0;
            curr = curr.offsetParent;
        }
        return {
            x: x + (el.offsetWidth || 0) / 2,
            // Since .node-connector has 'top: 50%' and 'transform: translateY(-50%)',
            // its visual center Y is exactly at its layout top coordinate (el.offsetTop relative to card),
            // meaning accumulated y is exactly the visual center of the connector.
            y: y
        };
    }
    _createConnection(fromId, toId) {
        if (this.connections.find(c => c.from === fromId && c.to === toId)) return;
        const lineId = `conn-${fromId}-${toId}`;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        line.id = lineId;
        line.classList.add('connection-line');
        this.svg.appendChild(line);

        this.connections.push({ from: fromId, to: toId, lineId });
        this._updateConnections();
        // Deferred updates: CSS nodeAppear animation takes 0.3s,
        // getBoundingClientRect() returns intermediate values during animation
        requestAnimationFrame(() => this._updateConnections());
        setTimeout(() => this._updateConnections(), 350);
        this.onConnectionCreated?.(fromId, toId);
    }
    _connectionPair(startConnector, endConnector) {
        const startId = startConnector?.closest('.canvas-node')?.dataset.nodeId;
        const endId = endConnector?.closest('.canvas-node')?.dataset.nodeId;
        if (!startId || !endId) return null;

        const startRole = startConnector.classList.contains('input') ? 'input' : 'output';
        const endRole = endConnector.classList.contains('input') ? 'input' : 'output';
        if (startRole === 'output' && endRole === 'input') return { fromId: startId, toId: endId };
        if (startRole === 'input' && endRole === 'output') return { fromId: endId, toId: startId };
        return { fromId: startId, toId: endId };
    }
    _updateConnections() {
        this.connections.forEach(c => {
            const fEl = document.querySelector(`[data-node-id="${c.from}"] .node-connector.output`);
            const tEl = document.querySelector(`[data-node-id="${c.to}"] .node-connector.input`);
            const line = document.getElementById(c.lineId);
            if (fEl && tEl && line) {
                const f = this._getConnectorPos(fEl);
                const t = this._getConnectorPos(tEl);
                const d = this._bezier(f.x, f.y, t.x, t.y);
                line.setAttribute('d', d);
            }
        });
    }
    _setPath(el, x1, y1, x2, y2) { el.setAttribute('d', this._bezier(x1, y1, x2, y2)); }
    _cancelConnection() {
        this.isDrawingConnection = false;
        this.connectionStartConnector = null;
        this.tempConnectionLine?.remove();
        this.tempConnectionLine = null;
    }
    _bezier(x1, y1, x2, y2) {
        const dx = Math.abs(x2 - x1) * 0.5;
        return `M${x1},${y1} C${x1+dx},${y1} ${x2-dx},${y2} ${x2},${y2}`;
    }

    // --- Context Menu ---
    _showContextMenu(x, y, nodeId) {
        this._hideContextMenu();
        const m = document.createElement('div');
        m.className = 'context-menu'; m.id = 'context-menu';
        m.style.left = x+'px'; m.style.top = y+'px';
        if (nodeId) {
            m.innerHTML = `
                <div class="context-menu-item" data-action="dup" data-nid="${nodeId}">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    复制节点</div>
                <div class="context-menu-divider"></div>
                <div class="context-menu-item danger" data-action="del" data-nid="${nodeId}">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    删除节点</div>`;
        } else {
            m.innerHTML = `
                <div class="context-menu-item" data-action="add-text">添加文本节点</div>
                <div class="context-menu-item" data-action="add-image">添加图片节点</div>
                <div class="context-menu-item" data-action="add-video">添加视频节点</div>
                <div class="context-menu-item" data-action="add-audio">添加音频节点</div>`;
        }
        document.body.appendChild(m);
        m.addEventListener('click', (e) => {
            const item = e.target.closest('.context-menu-item');
            if (!item) return;
            const a = item.dataset.action, nid = item.dataset.nid;
            const rect = this.container.getBoundingClientRect();
            const cx = (x - rect.left - this.offsetX)/this.scale;
            const cy = (y - rect.top - this.offsetY)/this.scale;
            if (a==='del') this.deleteNode(nid);
            else if (a==='dup') { const d = this.nodes.get(nid); if(d) this.addNode(d.type,d.x+30,d.y+30); }
            else if (a==='add-text') this.addNode('text',cx,cy);
            else if (a==='add-image') this.addNode('image',cx,cy);
            else if (a==='add-video') this.addNode('video',cx,cy);
            else if (a==='add-audio') this.addNode('audio',cx,cy);
            this._hideContextMenu();
        });
    }
    _hideContextMenu() { document.getElementById('context-menu')?.remove(); }

    fitView() {
        if (!this.nodes.size) { this.scale=1; this.offsetX=0; this.offsetY=0; this._applyTransform(); this._updateZoom(); this._updateConnections(); return; }
        let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
        this.nodes.forEach(n => { minX=Math.min(minX,n.x); minY=Math.min(minY,n.y); maxX=Math.max(maxX,n.x+640); maxY=Math.max(maxY,n.y+500); });
        const r = this.container.getBoundingClientRect(), p = 80;
        const w = maxX-minX+p*2, h = maxY-minY+p*2;
        this.scale = Math.min(r.width/w, r.height/h, 1.5);
        this.offsetX = (r.width - w*this.scale)/2 - minX*this.scale + p*this.scale;
        this.offsetY = (r.height - h*this.scale)/2 - minY*this.scale + p*this.scale;
        this._applyTransform(); this._updateZoom(); this._updateConnections();
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CanvasEngine, CanvasReferenceSelection };
}
