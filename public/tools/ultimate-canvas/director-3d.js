import * as THREE from 'https://esm.sh/three@0.160.0';
import { GLTFLoader } from 'https://esm.sh/three@0.160.0/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinnedScene } from 'https://esm.sh/three@0.160.0/examples/jsm/utils/SkeletonUtils.js';
import {
    applyLiblibJointAnglesToRig,
    buildLiblibGlbRig,
    normalizeLiblibGlbCharacter
} from './assets/director/liblib/liblib-pose-conversion-logic.js';

const data = window.LIBLIB_DIRECTOR_DATA || { models: [], posePresets: [], assetBasePath: '' };
const modelCache = new Map();
const stages = new Map();

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function parsePercent(value, fallback) {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
}

function actorPosition(actor) {
    const styles = getComputedStyle(actor);
    const xPct = parsePercent(styles.getPropertyValue('--actor-x'), 50);
    const yPct = parsePercent(styles.getPropertyValue('--actor-y'), 56);
    return {
        x: (xPct - 50) / 14,
        z: (yPct - 58) / 8
    };
}

function getModel(type) {
    return data.models.find(model => model.type === type) || data.models[0] || null;
}

function getPose(id) {
    return data.posePresets.find(pose => pose.id === id) || data.posePresets[0] || null;
}

async function loadModel(model) {
    if (!model) throw new Error('Missing director model metadata.');
    if (modelCache.has(model.type)) return modelCache.get(model.type);

    const loader = new GLTFLoader();
    const isAbsoluteAsset = /^(blob:|data:|https?:)/.test(model.file || '');
    const url = model.localUrl || (isAbsoluteAsset ? model.file : `${data.assetBasePath || 'assets/director/liblib/'}${model.file}`);
    const promise = loader.loadAsync(url).then(gltf => gltf.scene);
    modelCache.set(model.type, promise);
    return promise;
}

function tintModel(root, color) {
    const tint = new THREE.Color(color || '#4ecdc4');
    root.traverse(node => {
        if (!node.isMesh) return;
        node.castShadow = true;
        node.receiveShadow = true;
        if (node.material) {
            node.material = node.material.clone();
            if (node.material.color) node.material.color.lerp(tint, 0.28);
            node.material.roughness = Math.min(0.92, node.material.roughness ?? 0.72);
            node.material.metalness = Math.min(0.1, node.material.metalness ?? 0);
        }
    });
}

class Director3DStage {
    constructor(nodeEl) {
        this.nodeEl = nodeEl;
        this.viewport = nodeEl.querySelector('[data-director-stage]');
        this.mount = nodeEl.querySelector('[data-director-3d-stage]');
        this.loading = nodeEl.querySelector('[data-director-3d-loading]');
        this.actorEntries = new Map();
        this.loadingEntries = new Map();
        this.disposed = false;
        this.syncScheduled = false;

        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.Fog(0x111111, 8, 18);

        this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 100);
        this.camera.position.set(2.4, 2.2, 5.2);

        this.renderer = new THREE.WebGLRenderer({
            alpha: true,
            antialias: true,
            preserveDrawingBuffer: true
        });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.mount.appendChild(this.renderer.domElement);

        this.clock = new THREE.Clock();
        this.raycaster = new THREE.Raycaster();
        this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        this.pointerNdc = new THREE.Vector2();
        this.anchorPoint = new THREE.Vector3();
        this.dragHitPoint = new THREE.Vector3();
        this.root = new THREE.Group();
        this.scene.add(this.root);

        this.keyLight = new THREE.DirectionalLight(0xffe2ad, 1.6);
        this.keyLight.position.set(3.2, 5.5, 2.6);
        this.keyLight.castShadow = true;
        this.scene.add(this.keyLight);
        this.scene.add(new THREE.HemisphereLight(0x78d9ff, 0x111111, 1.25));

        const floor = new THREE.Mesh(
            new THREE.PlaneGeometry(7.6, 5.2),
            new THREE.MeshStandardMaterial({
                color: 0x141818,
                roughness: 0.9,
                metalness: 0.02,
                transparent: true,
                opacity: 0.78
            })
        );
        floor.rotation.x = -Math.PI / 2;
        floor.receiveShadow = true;
        this.scene.add(floor);

        const grid = new THREE.GridHelper(7.6, 14, 0x4ecdc4, 0x2b4f50);
        grid.material.transparent = true;
        grid.material.opacity = 0.36;
        grid.position.y = 0.006;
        this.scene.add(grid);

        this.selectionRing = new THREE.Mesh(
            new THREE.RingGeometry(0.34, 0.38, 44),
            new THREE.MeshBasicMaterial({
                color: 0x4ecdc4,
                transparent: true,
                opacity: 0.72,
                side: THREE.DoubleSide
            })
        );
        this.selectionRing.rotation.x = -Math.PI / 2;
        this.selectionRing.visible = false;
        this.scene.add(this.selectionRing);

        this.cameraRig = this.createCameraRig();
        this.scene.add(this.cameraRig);

        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.mount);
        this.resize();
        this.animate();
        this.sync();
    }

    createCameraRig() {
        const rig = new THREE.Group();
        const body = new THREE.Mesh(
            new THREE.BoxGeometry(0.34, 0.22, 0.2),
            new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.62 })
        );
        const lens = new THREE.Mesh(
            new THREE.CylinderGeometry(0.07, 0.1, 0.18, 18),
            new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5 })
        );
        lens.rotation.x = Math.PI / 2;
        lens.position.z = -0.18;
        const stand = new THREE.Mesh(
            new THREE.CylinderGeometry(0.025, 0.025, 0.56, 10),
            new THREE.MeshBasicMaterial({ color: 0xf59e0b })
        );
        stand.position.y = -0.35;
        rig.add(body, lens, stand);
        rig.position.set(-1.05, 0.72, 2.15);
        rig.rotation.y = -0.22;
        return rig;
    }

    setLoading(text, isError = false) {
        if (!this.loading) return;
        this.loading.textContent = text;
        this.loading.classList.toggle('error', isError);
    }

    resize() {
        if (this.disposed) return;
        const rect = this.mount.getBoundingClientRect();
        const width = Math.max(1, Math.floor(rect.width));
        const height = Math.max(1, Math.floor(rect.height));
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height, false);
        this.renderer.render(this.scene, this.camera);
        this.updateActorScreenAnchors();
    }

    scheduleSync() {
        if (this.syncScheduled || this.disposed) return;
        this.syncScheduled = true;
        requestAnimationFrame(() => {
            this.syncScheduled = false;
            this.sync();
        });
    }

    async sync() {
        if (this.disposed) return;
        try {
            await this.syncActors();
            this.syncCameraAndLight();
            this.updateActorScreenAnchors();
            this.viewport?.classList.add('is-3d-ready');
        } catch (error) {
            this.setLoading(`3D 预览需要通过本地服务器打开。${error.message || error}`, true);
            console.warn('[Director3D] sync failed', error);
        }
    }

    async syncActors() {
        const actorEls = [...this.nodeEl.querySelectorAll('.director-actor:not(.is-hidden)')];
        const actorIds = new Set(actorEls.map(actor => actor.dataset.actor));

        for (const [actorId, entry] of this.actorEntries.entries()) {
            if (actorIds.has(actorId)) continue;
            this.root.remove(entry.group);
            this.actorEntries.delete(actorId);
        }

        await Promise.all(actorEls.map(actor => this.syncActor(actor)));

        const activeActor = this.nodeEl.querySelector('.director-actor.active');
        if (activeActor && this.actorEntries.has(activeActor.dataset.actor)) {
            const entry = this.actorEntries.get(activeActor.dataset.actor);
            this.selectionRing.position.set(entry.group.position.x, 0.018, entry.group.position.z);
            this.selectionRing.visible = true;
        } else {
            this.selectionRing.visible = false;
        }
    }

    async syncActor(actor) {
        const actorId = actor.dataset.actor;
        const modelType = actor.dataset.modelType;
        const poseId = actor.dataset.poseId || 'stand';
        const poseOverride = actor.dataset.poseOverride || '';
        const model = getModel(modelType);
        if (!actorId || !model) return;
        const isCurrentActor = () => {
            const liveActor = this.nodeEl.querySelector(`.director-actor[data-actor="${CSS.escape(actorId)}"]:not(.is-hidden)`);
            return liveActor === actor;
        };
        if (!isCurrentActor()) return;

        let entry = this.actorEntries.get(actorId);
        if (!entry || entry.modelType !== model.type) {
            if (entry) this.root.remove(entry.group);
            this.setLoading(`加载 ${model.label}...`);
            const loadKey = `${actorId}:${model.type}`;
            if (!this.loadingEntries.has(loadKey)) {
                this.loadingEntries.set(loadKey, this.createActorEntry(model));
            }
            entry = await this.loadingEntries.get(loadKey);
            this.loadingEntries.delete(loadKey);
            if (this.disposed || !isCurrentActor()) {
                return;
            }

            const liveModelType = actor.dataset.modelType;
            if (liveModelType !== model.type) return;

            const existing = this.actorEntries.get(actorId);
            if (existing && existing.modelType === model.type) {
                entry = existing;
            } else {
                if (existing) this.root.remove(existing.group);
                entry.modelType = model.type;
                entry.group.userData.actorId = actorId;
                this.actorEntries.set(actorId, entry);
                if (!entry.group.parent) this.root.add(entry.group);
            }
        }

        const pos = actorPosition(actor);
        entry.group.position.set(pos.x, 0, pos.z);
        entry.group.rotation.y = this.actorRotation(actor);
        const actorScale = clamp(Number(actor.dataset.scale || 100), 50, 180) / 100;
        entry.group.scale.setScalar(actorScale * (actor.classList.contains('active') ? 1.06 : 1));

        const actorColor = getComputedStyle(actor).getPropertyValue('--actor-color').trim();
        if (actorColor && entry.color !== actorColor) {
            tintModel(entry.root, actorColor);
            entry.color = actorColor;
        }

        const poseKey = poseOverride || poseId;
        if (entry.poseId !== poseKey) {
            let jointAngles = null;
            if (poseOverride) {
                try { jointAngles = JSON.parse(poseOverride); } catch (_) { jointAngles = null; }
            }
            if (!jointAngles) {
                const pose = getPose(poseId);
                jointAngles = pose?.jointAngles || null;
            }
            if (jointAngles) {
                applyLiblibJointAnglesToRig(THREE, entry.rig, jointAngles);
                entry.poseId = poseKey;
            }
        }
    }

    async createActorEntry(model) {
        const source = await loadModel(model);
        const root = cloneSkinnedScene(source);
        normalizeLiblibGlbCharacter(THREE, root, {
            targetHeight: model.type === 'chibi' ? 1.15 : model.type === 'child' ? 1.32 : 1.72
        });
        tintModel(root, model.color);

        const group = new THREE.Group();
        group.add(root);
        const rig = buildLiblibGlbRig(root);

        return { group, root, rig, modelType: model.type, poseId: null, color: model.color };
    }

    actorRotation(actor) {
        const explicit = Number(actor.dataset.rotY);
        if (Number.isFinite(explicit)) return explicit * Math.PI / 180;
        const id = actor.dataset.actor || '';
        if (id.includes('rival')) return -0.32;
        if (id.includes('support')) return 0.18;
        return 0;
    }

    updateActorScreenAnchors() {
        if (this.disposed || !this.mount || !this.camera) return;
        this.root.updateMatrixWorld(true);
        this.camera.updateMatrixWorld(true);

        for (const [actorId, entry] of this.actorEntries.entries()) {
            const actor = this.nodeEl.querySelector(`.director-actor[data-actor="${CSS.escape(actorId)}"]`);
            if (!actor || actor.classList.contains('is-hidden')) continue;

            this.anchorPoint.set(0, 0.04, 0);
            entry.group.localToWorld(this.anchorPoint);
            this.anchorPoint.project(this.camera);

            const xPct = (this.anchorPoint.x + 1) * 50;
            const yPct = (1 - this.anchorPoint.y) * 50;
            const screenX = `${xPct.toFixed(2)}%`;
            const screenY = `${yPct.toFixed(2)}%`;

            if (actor.style.getPropertyValue('--actor-screen-x') !== screenX) {
                actor.style.setProperty('--actor-screen-x', screenX);
            }
            if (actor.style.getPropertyValue('--actor-screen-y') !== screenY) {
                actor.style.setProperty('--actor-screen-y', screenY);
            }

            const offscreen = this.anchorPoint.z < -1 || this.anchorPoint.z > 1
                || xPct < -12 || xPct > 112 || yPct < -12 || yPct > 112;
            actor.classList.toggle('is-offscreen', offscreen);
        }

        this.updateStudioGizmoAnchor();
    }

    updateStudioGizmoAnchor() {
        const gizmo = this.nodeEl.querySelector('[data-director-gizmo]');
        const actor = this.nodeEl.querySelector('.director-actor.active:not(.is-hidden)');
        if (!gizmo || !actor) return;

        const styles = getComputedStyle(actor);
        const left = styles.getPropertyValue('--actor-screen-x').trim()
            || styles.getPropertyValue('--actor-x').trim()
            || '50%';
        const top = styles.getPropertyValue('--actor-screen-y').trim()
            || styles.getPropertyValue('--actor-y').trim()
            || '58%';

        if (gizmo.style.left !== left) gizmo.style.left = left;
        if (gizmo.style.top !== top) gizmo.style.top = top;
    }

    moveActorToScreen(actor, clientX, clientY, offsetX = 0, offsetY = 0) {
        if (this.disposed || !actor || !this.mount) return false;
        const rect = this.mount.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;

        this.root.updateMatrixWorld(true);
        this.camera.updateMatrixWorld(true);
        this.pointerNdc.set(
            ((clientX + offsetX - rect.left) / rect.width) * 2 - 1,
            -(((clientY + offsetY - rect.top) / rect.height) * 2 - 1)
        );
        this.raycaster.setFromCamera(this.pointerNdc, this.camera);
        if (!this.raycaster.ray.intersectPlane(this.groundPlane, this.dragHitPoint)) return false;

        const localPoint = this.root.worldToLocal(this.dragHitPoint.clone());
        const xPct = clamp(localPoint.x * 14 + 50, 6, 94);
        const yPct = clamp(localPoint.z * 8 + 58, 24, 90);
        actor.style.setProperty('--actor-x', `${xPct.toFixed(1)}%`);
        actor.style.setProperty('--actor-y', `${yPct.toFixed(1)}%`);
        return true;
    }

    syncCameraAndLight() {
        const props = this.nodeEl.querySelector('[data-director-props]');
        const datasetKey = (name) => `control${name[0].toUpperCase()}${name.slice(1)}`;
        const read = (name, fallback) => {
            const live = props?.querySelector(`[data-director-control="${name}"]`)?.value;
            const stored = this.nodeEl.dataset?.[datasetKey(name)];
            const value = Number(live ?? stored ?? fallback);
            return Number.isFinite(value) ? value : fallback;
        };
        const yaw = read('yaw', 18) * Math.PI / 180;
        const pitch = clamp(read('pitch', 8), -30, 45);
        const focal = clamp(read('zoom', 72), 35, 120);
        const light = clamp(read('light', 64), 20, 100) / 100;
        const fovControl = clamp(read('fov', 45), 24, 72);
        const sceneScale = clamp(read('sceneScale', 300), 50, 500) / 300;
        const isCameraView = this.viewport?.classList.contains('is-camera-view') || this.nodeEl.dataset.viewMode === 'camera';

        this.root.scale.setScalar(sceneScale);

        const radius = (isCameraView ? 5.0 : 7.2) - (focal - 35) / 85 * (isCameraView ? 2.4 : 2.0);
        const height = (isCameraView ? 1.15 : 2.0) + pitch / 45 * (isCameraView ? 1.15 : 1.35);
        this.camera.fov = isCameraView ? fovControl : Math.max(42, fovControl + 10);
        this.camera.position.set(Math.sin(yaw) * radius, height, Math.cos(yaw) * radius);
        this.camera.lookAt(0, 0.9, 0);
        this.camera.updateProjectionMatrix();

        this.keyLight.intensity = 0.9 + light * 1.9;
        this.keyLight.position.set(2.8 + Math.sin(yaw) * 1.2, 5.4, 2.4 + Math.cos(yaw) * 1.2);
        this.cameraRig.visible = !isCameraView;
        this.cameraRig.position.set(Math.sin(yaw) * 2.2, 0.72, Math.cos(yaw) * 2.2);
        this.cameraRig.rotation.y = yaw + Math.PI;
    }

    animate() {
        if (this.disposed) return;
        const t = this.clock.getElapsedTime();
        this.selectionRing.material.opacity = 0.54 + Math.sin(t * 4) * 0.12;
        this.renderer.render(this.scene, this.camera);
        requestAnimationFrame(() => this.animate());
    }

    capture() {
        this.renderer.render(this.scene, this.camera);
        return this.renderer.domElement.toDataURL('image/png');
    }

    dispose() {
        this.disposed = true;
        this.resizeObserver?.disconnect();
        this.renderer?.dispose();
        this.mount?.querySelector('canvas')?.remove();
    }
}

function mountDirector(nodeEl) {
    const nodeId = nodeEl.dataset.nodeId;
    if (!nodeId || stages.has(nodeId)) return stages.get(nodeId);
    const mount = nodeEl.querySelector('[data-director-3d-stage]');
    if (!mount) return null;
    const stage = new Director3DStage(nodeEl);
    stages.set(nodeId, stage);
    return stage;
}

function syncAll() {
    document.querySelectorAll('.node-type-director').forEach(nodeEl => {
        mountDirector(nodeEl)?.scheduleSync();
    });
}

const observer = new MutationObserver(mutations => {
    let shouldSync = false;
    for (const mutation of mutations) {
        if (mutation.type === 'childList') {
            mutation.addedNodes.forEach(node => {
                if (!(node instanceof HTMLElement)) return;
                if (node.matches?.('.node-type-director')) mountDirector(node);
                node.querySelectorAll?.('.node-type-director').forEach(mountDirector);
            });
            shouldSync = true;
        } else if (mutation.type === 'attributes') {
            shouldSync = true;
        }
    }
    if (shouldSync) syncAll();
});

observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'data-model-type', 'data-model-label', 'data-pose-id']
});

document.addEventListener('input', event => {
    if (event.target.closest?.('.node-type-director')) syncAll();
});

document.addEventListener('click', event => {
    if (event.target.closest?.('.node-type-director')) setTimeout(syncAll, 0);
});

window.Director3D = {
    syncAll,
    capture(nodeEl) {
        const id = nodeEl?.dataset?.nodeId;
        return id && stages.has(id) ? stages.get(id).capture() : null;
    },
    moveActorToScreen(nodeEl, actor, clientX, clientY, offsetX = 0, offsetY = 0) {
        const id = nodeEl?.dataset?.nodeId;
        return Boolean(id && stages.has(id)
            && stages.get(id).moveActorToScreen(actor, clientX, clientY, offsetX, offsetY));
    },
    dispose(nodeEl) {
        const id = nodeEl?.dataset?.nodeId;
        if (!id || !stages.has(id)) return;
        stages.get(id).dispose();
        stages.delete(id);
    }
};

syncAll();
