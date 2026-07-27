// Core viewer: xeokit scene + model management + selection + camera + comment markers.
// Ported and consolidated from the V7 reference; the file-input path is gone — models arrive as
// in-memory bytes and the host drives everything else over postMessage (see bridge.ts).

import {
	Viewer,
	DirLight,
	AmbientLight,
	XKTLoaderPlugin,
	type SceneModel
} from '@xeokit/xeokit-sdk';
import type {
	CameraState,
	CommentMarker,
	ElementDescriptor,
	ModelFormat,
	UpAxis,
	ZoomDirection
} from '../protocol';
import { buildJsonModel, buildXktEntityList } from './loaders';
import { CommentMarkers, type ResolvedMarker } from './markers';
import type { EntityRecord, ModelData, ModelRecord } from './types';

// Progressive zoom: each toolbar click / wheel notch scales the camera distance by this factor
// (≈10% of the current zoom level, so it moves fast at high magnification). MIN is the zoom-out floor.
const ZOOM_STEP_FACTOR = 1.1;
const MIN_ZOOM_PCT = 10;
// Angle (deg) the target should subtend when framing an element, matching xeokit's default fitFOV.
const FIT_FOV_DEG = 45;

// Z-up transform (column-major): source (x,y,z) → world (x, z, -y). See V7.
const ZMAT = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
const YMAT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const FILE_COLORS: number[][] = [
	[0.22, 0.53, 0.99],
	[0.25, 0.71, 0.31],
	[0.98, 0.55, 0.14],
	[0.86, 0.2, 0.27],
	[0.61, 0.35, 0.91],
	[0.15, 0.79, 0.82],
	[0.95, 0.85, 0.12],
	[0.94, 0.37, 0.62]
];

export interface ViewerAppCallbacks {
	onModelLoaded: (name: string, elements: ElementDescriptor[], aabb: number[]) => void;
	onLoadError: (message: string) => void;
	onElementSelected: (
		elementId: string | null,
		label?: string,
		worldPos?: [number, number, number],
		camera?: CameraState,
		properties?: Record<string, string>
	) => void;
	onCommentMarkerClicked: (elementId: string, camera: CameraState) => void;
	onCameraChanged: (camera: CameraState) => void;
	onZoomChanged: (percent: number) => void;
}

export interface ViewerAppElements {
	// The in-iframe tree/info/stat panel was removed — the host renders an equivalent outside the
	// iframe. The viewer runs headless: canvas + postMessage only.
	canvas: HTMLCanvasElement;
}

export class ViewerApp {
	private viewer: Viewer;
	private xktLoader: XKTLoaderPlugin;
	private markers: CommentMarkers;

	private models: ModelRecord[] = [];
	private index = new Map<string, { e: EntityRecord; m: ModelRecord }>(); // sceneId → …
	private elemToScene = new Map<string, string>(); // elementId → sceneId
	private selectedId: string | null = null;
	// Scene objects currently highlighted for the selection. One for a leaf; the whole geometric
	// subtree for a group selection driven from the host's model tree.
	private highlightedSceneIds: string[] = [];
	private seq = 0;
	// Default to Z-up: most of our CAD/IFC source data is Z-up, so the model loads upright without a
	// manual axis switch. Models are loaded with ZMAT applied and fit on load (see loadModel).
	private zUp = true;
	// Magnification shown in the host toolbar is derived from the live camera distance: the eye→look
	// distance at the fit view is 100%, and percent = fitDistance / currentDistance * 100. This keeps
	// the toolbar honest through wheel, buttons, fly-to and camera restores alike.
	private fitDistance = 0;
	private fitReady = false;
	private lastZoomPercent = 100;
	private cameraThrottle = 0;
	private cameraTrailTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private els: ViewerAppElements,
		private cb: ViewerAppCallbacks
	) {
		this.viewer = new Viewer({
			canvasElement: els.canvas,
			transparent: true,
			dtxEnabled: true,
			saoEnabled: true,
			backgroundColor: [1, 1, 1]
		});

		this.viewer.scene.clearLights();
		new AmbientLight(this.viewer.scene, { color: [1, 1, 1], intensity: 0.3 });
		// xeokit's DirLightConfiguration.d.ts wrongly restricts `space` to 'view' | 'space'; the SDK
		// actually honours 'view' | 'world' (see DirLight.js and the DirLight class docs). We build the
		// configs with the correct type and assert past the upstream mistake at the constructor.
		type DirLightCfg = {
			dir: number[];
			color: number[];
			intensity: number;
			space: 'view' | 'world';
		};
		type DirLightArg = ConstructorParameters<typeof DirLight>[1];
		const dirLights: DirLightCfg[] = [
			{ dir: [-0.6, -1, -0.5], color: [1.0, 0.95, 0.88], intensity: 0.9, space: 'world' },
			{ dir: [0.8, -0.4, 0.7], color: [0.4, 0.5, 0.7], intensity: 0.5, space: 'world' }
		];
		for (const cfg of dirLights) new DirLight(this.viewer.scene, cfg as unknown as DirLightArg);

		this.viewer.cameraControl.mouseWheelDollyRate = 0; // custom wheel zoom below
		this.viewer.scene.backfaces = true;
		this.viewer.scene.linesMaterial.lineWidth = 1.5;
		this.viewer.scene.edgeMaterial.edgeWidth = 1.5;

		// "Isolate" ghosts the rest of the model via X-ray: a faint fill, no edges — barely visible.
		this.viewer.scene.xrayMaterial.fill = true;
		this.viewer.scene.xrayMaterial.fillColor = [0.72, 0.72, 0.78];
		this.viewer.scene.xrayMaterial.fillAlpha = 0.05;
		this.viewer.scene.xrayMaterial.edges = false;

		this.xktLoader = new XKTLoaderPlugin(this.viewer);

		this.viewer.camera.eye = [20, 15, 20];
		this.viewer.camera.look = [0, 0, 0];
		// Always Y-up: ZMAT maps Z-up source data into xeokit's Y-up world (matches camera.worldUp).
		this.viewer.camera.up = [0, 1, 0];

		this.markers = new CommentMarkers(this.viewer, (elementId) => {
			this.cb.onCommentMarkerClicked(elementId, this.cameraState());
		});

		this.initCanvas();
		this.initPicking();
		this.initCameraEvents();
	}

	// ── Public API (called by the bridge) ──────────────────────────────────────

	async loadModel(bytes: ArrayBuffer, format: ModelFormat, name: string): Promise<void> {
		try {
			// This embedded viewer shows a single model per document, so each host loadModel replaces the
			// previous scene. Without this, a re-sent loadModel (e.g. the host refetching the file and
			// handing us a new `src` buffer) would stack a duplicate model in the tree.
			this.clearModel();
			if (format === 'xkt') await this.loadXkt(bytes, name);
			else await this.loadJson(bytes, name);

			this.reindex();
			// Rotate the model into the current up-axis, then fit it. The fit view defines 100% zoom.
			if (this.zUp) for (const m of this.models) m.sm.matrix = ZMAT;
			this.fitReady = false;
			const fit = aabbSphere(this.viewer.scene.aabb);
			this.flyToFit(fit.center, fit.radius);
			this.cb.onModelLoaded(name, this.elementDescriptors(), this.viewer.scene.aabb);
		} catch (e: unknown) {
			this.cb.onLoadError(e instanceof Error ? e.message : String(e));
		}
	}

	clearModel(): void {
		this.select(null);
		this.markers.clear();
		for (const m of this.models) m.sm.destroy();
		this.models = [];
		this.reindex();
	}

	selectElement(elementId: string | null, memberIds?: string[]): void {
		if (!elementId) {
			this.select(null);
			return;
		}
		const sceneId = this.elemToScene.get(elementId) ?? elementId;
		// For a group the host passes its geometric descendants; a leaf omits it (highlights itself).
		const members = memberIds?.length ? this.resolveSceneObjects(memberIds) : undefined;
		this.select(sceneId, undefined, members);
	}

	focusElement(elementId: string, memberIds?: string[]): void {
		const ids = memberIds?.length ? memberIds : [elementId];
		const objs = this.resolveSceneObjects(ids).map((sid) => this.viewer.scene.objects[sid]);
		const aabb = combineAabbs(objs);
		if (aabb) this.flyToAabb(aabb);
	}

	/** Fly to frame an AABB, keeping the current view direction. */
	private flyToAabb(aabb: number[]): void {
		const center = aabbCenter3(aabb);
		if (!center) return;
		// Bounding-sphere radius of the AABB, and the distance at which it subtends FIT_FOV_DEG.
		const rx = (aabb[3] - aabb[0]) / 2;
		const ry = (aabb[4] - aabb[1]) / 2;
		const rz = (aabb[5] - aabb[2]) / 2;
		const radius = Math.sqrt(rx * rx + ry * ry + rz * rz);
		const dist =
			radius > 0 ? radius / Math.sin((FIT_FOV_DEG / 2) * (Math.PI / 180)) : this.fitDistance;

		// Keep the current eye→look direction.
		const eye = this.viewer.camera.eye;
		const look = this.viewer.camera.look;
		let dx = eye[0] - look[0];
		let dy = eye[1] - look[1];
		let dz = eye[2] - look[2];
		const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
		if (len < 1e-6) {
			dx = 0;
			dy = 0;
			dz = 1;
		} else {
			dx /= len;
			dy /= len;
			dz /= len;
		}
		const up = this.viewer.camera.up;
		this.viewer.cameraFlight.flyTo({
			eye: [center[0] + dx * dist, center[1] + dy * dist, center[2] + dz * dist],
			look: [center[0], center[1], center[2]],
			up: [up[0], up[1], up[2]]
		});
	}

	/** Map host element ids to the scene-object ids that actually carry geometry. */
	private resolveSceneObjects(elementIds: string[]): string[] {
		const out: string[] = [];
		for (const id of elementIds) {
			const sceneId = this.elemToScene.get(id) ?? id;
			if (this.viewer.scene.objects[sceneId]) out.push(sceneId);
		}
		return out;
	}

	setCamera(camera: CameraState): void {
		// The host stores camera state canonical; rotate into the current world space before flying.
		// Brief animated travel to the target view (keeps spatial context) rather than a hard cut.
		this.viewer.cameraFlight.flyTo({
			eye: toWorldVec(camera.eye, this.zUp),
			look: toWorldVec(camera.look, this.zUp),
			up: toWorldVec(camera.up, this.zUp),
			duration: 0.5
		});
	}

	/**
	 * Zoom progressively: `in`/`out` scale the camera distance by a fixed factor (≈10% of the current
	 * level per step, so it moves quickly at high magnification), `reset` returns to the 100% fit
	 * distance. The new percentage is reported to the host by the camera-move handler. Used by both the
	 * toolbar buttons and the mouse wheel.
	 */
	zoomStep(direction: ZoomDirection): void {
		if (this.fitDistance <= 0) return;
		if (direction === 'reset') {
			this.setCameraDistance(this.fitDistance);
			return;
		}
		const dist = this.cameraDistance();
		if (dist <= 0) return;
		const next = dist * (direction === 'in' ? 1 / ZOOM_STEP_FACTOR : ZOOM_STEP_FACTOR);
		// Never zoom out past the floor (largest allowed distance = fitDistance / (MIN%/100)).
		this.setCameraDistance(Math.min(next, (this.fitDistance * 100) / MIN_ZOOM_PCT));
	}

	/** Live eye→look distance. */
	private cameraDistance(): number {
		const eye = this.viewer.camera.eye;
		const look = this.viewer.camera.look;
		const dx = eye[0] - look[0];
		const dy = eye[1] - look[1];
		const dz = eye[2] - look[2];
		return Math.sqrt(dx * dx + dy * dy + dz * dz);
	}

	/** Magnification derived from the live camera distance (100% = the fit view). */
	private currentZoomPercent(): number {
		const dist = this.cameraDistance();
		if (this.fitDistance <= 0 || dist <= 0) return 100;
		return Math.max(MIN_ZOOM_PCT, Math.round((this.fitDistance / dist) * 100));
	}

	/** Move the eye along the eye→look axis so the distance becomes `dist`. */
	private setCameraDistance(dist: number): void {
		const cur = this.cameraDistance();
		if (cur <= 1e-6 || dist <= 0) return;
		const factor = dist / cur;
		const eye = this.viewer.camera.eye;
		const look = this.viewer.camera.look;
		this.viewer.camera.eye = [
			look[0] + (eye[0] - look[0]) * factor,
			look[1] + (eye[1] - look[1]) * factor,
			look[2] + (eye[2] - look[2]) * factor
		];
	}

	/** Capture the current distance as the 100% baseline (called once the fit flight settles). */
	private captureFit(): void {
		this.fitDistance = this.cameraDistance();
		this.fitReady = true;
		this.lastZoomPercent = 100;
		this.cb.onZoomChanged(100);
	}

	/** Emit the derived magnification to the host whenever it changes (any camera move). */
	private maybeEmitZoom(): void {
		if (!this.fitReady) return;
		const percent = this.currentZoomPercent();
		if (percent === this.lastZoomPercent) return;
		this.lastZoomPercent = percent;
		this.cb.onZoomChanged(percent);
	}

	setCommentMarkers(markers: CommentMarker[]): void {
		const resolved: ResolvedMarker[] = [];
		for (const marker of markers) {
			if (marker.anchor) {
				// The host stores anchors canonical; rotate into the current world space to place them.
				resolved.push({
					elementId: marker.elementId,
					worldPos: toWorldVec(marker.anchor, this.zUp)
				});
				continue;
			}
			// No stored anchor: fall back to the object's current-world AABB centre (already world space).
			const sceneId = this.elemToScene.get(marker.elementId);
			const obj = sceneId ? this.viewer.scene.objects[sceneId] : null;
			const center = aabbCenter(obj);
			if (center) resolved.push({ elementId: marker.elementId, worldPos: center });
		}
		this.markers.set(resolved);
	}

	/**
	 * Isolate the given elements (and their resolved geometry) by X-raying everything else to
	 * barely-visible; pass `null`/empty to clear the isolation and reveal all objects again.
	 */
	isolateElements(elementIds: string[] | null): void {
		const scene = this.viewer.scene;
		const keep = elementIds && elementIds.length ? this.resolveSceneObjects(elementIds) : [];
		if (!keep.length) {
			// Nothing to keep (clear request, or a group with no resolvable geometry) — reveal all
			// rather than X-raying the whole scene.
			if (scene.xrayedObjectIds.length) scene.setObjectsXRayed(scene.xrayedObjectIds, false);
			return;
		}
		scene.setObjectsXRayed(scene.objectIds, true);
		scene.setObjectsXRayed(keep, false);
	}

	showAll(): void {
		Object.values(this.viewer.scene.objects).forEach((o) => (o.visible = true));
	}

	fitAll(): void {
		this.viewer.cameraFlight.flyTo(this.viewer.scene);
	}

	resetCamera(): void {
		this.viewer.camera.eye = [20, 15, 20];
		this.viewer.camera.look = [0, 0, 0];
		// Always Y-up: ZMAT maps Z-up source data into xeokit's Y-up world (matches camera.worldUp).
		this.viewer.camera.up = [0, 1, 0];
	}

	/** Set which world axis points up (`z` = Z-up, else Y-up). Rotates loaded models to match. */
	setUpAxis(axis: UpAxis): void {
		const zUp = axis === 'z';
		if (zUp === this.zUp) return;
		this.zUp = zUp;
		for (const m of this.models) m.sm.matrix = zUp ? ZMAT : YMAT;
		if (!this.models.length) return;
		// Re-frame the model in the new orientation (re-establishing the 100% zoom baseline). The host
		// re-sends comment markers, whose anchors move with the model.
		this.fitReady = false;
		const fit = aabbSphere(this.viewer.scene.aabb);
		this.flyToFit(fit.center, fit.radius);
	}

	/**
	 * Fly the camera to a 3/4 iso view fitting a sphere (`center`, `radius`) for the current up-axis,
	 * with a properly orthonormalised up. Routed through `cameraFlight.flyTo` with explicit eye/look/up
	 * — the same channel comment-restore uses, which keeps xeokit's camera controller in sync. Setting
	 * `camera.eye/look/up` directly, or flying to a boundary, leaves the controller out of sync, so the
	 * view is subtly off and snaps ("needs a nudge") on the first interaction.
	 */
	private flyToFit(center: number[], radius: number): void {
		const dist = radius / Math.sin((FIT_FOV_DEG / 2) * (Math.PI / 180));
		// The world is always Y-up here: ZMAT maps Z-up source data into xeokit's Y-up world, so the
		// camera basis, iso direction and worldUp must all be Y-based (matching camera.worldUp, which the
		// orbit controller levels against — a mismatch is what made the roll snap on the first nudge).
		const d = [1, 0.75, 1]; // 3/4 iso
		const dl = Math.hypot(d[0], d[1], d[2]);
		const eye: [number, number, number] = [
			center[0] + (d[0] / dl) * dist,
			center[1] + (d[1] / dl) * dist,
			center[2] + (d[2] / dl) * dist
		];
		const look: [number, number, number] = [center[0], center[1], center[2]];
		// Orthonormal up: perpendicular to the view direction, aligned to the world up-axis.
		const forward: [number, number, number] = [-d[0] / dl, -d[1] / dl, -d[2] / dl];
		const worldUp = [0, 1, 0];
		const up = cross3(normalize3(cross3(forward, worldUp)), forward);
		this.viewer.cameraFlight.flyTo({ eye, look, up, duration: 0.5 }, () => this.captureFit());
	}

	// ── Loading ─────────────────────────────────────────────────────────────────

	private async loadJson(bytes: ArrayBuffer, name: string): Promise<void> {
		const data = JSON.parse(new TextDecoder().decode(bytes)) as ModelData;
		const uid = ++this.seq;
		const color = this.nextColor();
		const built = buildJsonModel(this.viewer.scene, data, uid, color);
		// Up-axis rotation is applied centrally in loadModel (after reading the un-rotated bounds).
		this.models.push({
			uid,
			source: data.source || name,
			sm: built.sm,
			entities: built.entities,
			triCount: built.triCount,
			color,
			_opacity: 1,
			_srcKind: 'json'
		});
	}

	private loadXkt(bytes: ArrayBuffer, name: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const uid = ++this.seq;
			const color = this.nextColor();
			const modelId = 'm' + uid;
			let sm: SceneModel;
			try {
				sm = this.xktLoader.load({ id: modelId, xkt: bytes, edges: false });
			} catch (e) {
				reject(e);
				return;
			}
			sm.on('loaded', () => {
				// Up-axis rotation is applied centrally in loadModel (after reading the un-rotated bounds).
				const entities = buildXktEntityList(this.viewer.metaScene, this.viewer.scene, sm.id, color);
				this.models.push({
					uid,
					source: name,
					sm,
					entities,
					triCount: sm.numTriangles || 0,
					color,
					_opacity: 1,
					_srcKind: 'xkt'
				});
				resolve();
			});
			sm.on('error', (msg: string) => reject(new Error(msg)));
		});
	}

	private nextColor(): number[] {
		return FILE_COLORS[this.models.length % FILE_COLORS.length];
	}

	// ── Indexing ────────────────────────────────────────────────────────────────

	private reindex(): void {
		this.index = new Map();
		this.elemToScene = new Map();
		for (const m of this.models) {
			for (const e of m.entities) {
				this.index.set(e._sceneId, { e, m });
				this.elemToScene.set(e.id, e._sceneId);
			}
		}
	}

	private elementDescriptors(): ElementDescriptor[] {
		const out: ElementDescriptor[] = [];
		for (const m of this.models)
			for (const e of m.entities)
				out.push({
					id: e.id,
					label: e.label,
					parentId: e.parentId,
					hasGeometry: e.hasGeometry,
					type: e.type
				});
		return out;
	}

	private removeModel(uid: number): void {
		const i = this.models.findIndex((m) => m.uid === uid);
		if (i < 0) return;
		const m = this.models[i];
		if (this.selectedId && this.index.get(this.selectedId)?.m === m) this.select(null);
		m.sm.destroy();
		this.models.splice(i, 1);
		this.reindex();
	}

	private setModelVisible(uid: number, vis: boolean): void {
		const m = this.models.find((x) => x.uid === uid);
		if (!m) return;
		m._visible = vis;
		for (const e of m.entities) {
			const o = this.viewer.scene.objects[e._sceneId];
			if (o) o.visible = vis;
		}
	}

	private setModelOpacity(uid: number, val: number): void {
		const m = this.models.find((x) => x.uid === uid);
		if (!m) return;
		m._opacity = val;
		for (const e of m.entities) {
			const o = this.viewer.scene.objects[e._sceneId];
			if (o) o.opacity = val;
		}
	}

	// ── Selection & picking ──────────────────────────────────────────────────────

	private initPicking(): void {
		this.viewer.scene.input.on('mouseclicked', (coords: number[]) => {
			const hit = this.viewer.scene.pick({ canvasPos: coords });
			if (hit?.entity) {
				this.select(String(hit.entity.id), hit.worldPos);
				return;
			}
			this.select(this.pick2DLine(coords, 10));
		});
	}

	private select(sceneId: string | null, worldPos?: number[], memberSceneIds?: string[]): void {
		// Clear the previous highlight set (a single object, or a whole subtree for a group).
		for (const id of this.highlightedSceneIds) {
			const prev = this.viewer.scene.objects[id];
			if (prev) prev.highlighted = false;
		}
		this.highlightedSceneIds = [];
		this.selectedId = sceneId;
		if (!sceneId) {
			this.markers.setSelected(null);
			this.cb.onElementSelected(null);
			return;
		}
		// A group selection highlights its members; a leaf highlights just itself.
		const targets =
			memberSceneIds && memberSceneIds.length
				? memberSceneIds
				: this.viewer.scene.objects[sceneId]
					? [sceneId]
					: [];
		for (const id of targets) {
			const o = this.viewer.scene.objects[id];
			if (o) o.highlighted = true;
		}
		this.highlightedSceneIds = targets;

		const hit = this.index.get(sceneId);
		const e = hit?.e;
		this.markers.setSelected(e?.id ?? sceneId);
		// World anchor: the pick point when picking a leaf, else the centre of the highlighted bounds.
		const wp =
			worldPos ??
			aabbCenter3(combineAabbs(targets.map((id) => this.viewer.scene.objects[id]))) ??
			undefined;
		this.cb.onElementSelected(
			e?.id ?? sceneId,
			e?.label,
			// Anchor in canonical space, so the comment dot stays put across axis switches.
			wp ? toCanonicalVec(wp, this.zUp) : undefined,
			this.cameraState(),
			e ? stringifyProperties(e.properties) : undefined
		);
	}

	private flyToScene(sceneId: string): void {
		const obj = this.viewer.scene.objects[sceneId];
		if (obj) this.viewer.cameraFlight.flyTo(obj);
	}

	// ── Camera ───────────────────────────────────────────────────────────────────

	private cameraState(): CameraState {
		// Report in canonical (axis-invariant) space so saved views survive an up-axis switch.
		const c = this.viewer.camera;
		return {
			eye: toCanonicalVec(c.eye, this.zUp),
			look: toCanonicalVec(c.look, this.zUp),
			up: toCanonicalVec(c.up, this.zUp)
		};
	}

	private initCameraEvents(): void {
		this.viewer.camera.on('viewMatrix', () => {
			// Report magnification changes immediately (deduped), so fly-to / restore update the toolbar.
			this.maybeEmitZoom();
			const now = performance.now();
			const elapsed = now - this.cameraThrottle;
			if (elapsed >= 120) {
				this.cameraThrottle = now;
				this.cb.onCameraChanged(this.cameraState());
				return;
			}
			// Trailing edge: make sure the final resting position is delivered even when the last move
			// lands inside the throttle window — otherwise a saved-view/camera capture can be slightly off.
			if (this.cameraTrailTimer !== null) clearTimeout(this.cameraTrailTimer);
			this.cameraTrailTimer = setTimeout(() => {
				this.cameraTrailTimer = null;
				this.cameraThrottle = performance.now();
				this.cb.onCameraChanged(this.cameraState());
			}, 120 - elapsed);
		});
	}

	private initCanvas(): void {
		const canvas = this.els.canvas;
		const resize = () => {
			const dpr = window.devicePixelRatio || 1;
			canvas.width = Math.round(canvas.clientWidth * dpr);
			canvas.height = Math.round(canvas.clientHeight * dpr);
			this.viewer.scene.glRedraw();
		};
		new ResizeObserver(resize).observe(canvas);
		window.addEventListener('resize', resize);
		resize();

		canvas.addEventListener(
			'wheel',
			(e) => {
				e.preventDefault();
				// One step per notch, matching the toolbar buttons (scroll up = zoom in).
				this.zoomStep(e.deltaY < 0 ? 'in' : 'out');
			},
			{ passive: false }
		);
	}

	// ── 2D CPU line pick (ported from V7) ────────────────────────────────────────

	private pick2DLine(coords: number[], tol: number): string | null {
		const canvas = this.els.canvas;
		const W = canvas.clientWidth,
			H = canvas.clientHeight;
		const view = this.viewer.camera.viewMatrix,
			proj = this.viewer.camera.projMatrix;
		let best: string | null = null;
		let bestD = tol;
		for (const m of this.models) {
			if (m._visible === false || !m.pickLines) continue;
			for (const pl of m.pickLines) {
				const { wp, idx } = pl;
				for (let k = 0; k + 1 < idx.length; k += 2) {
					const a = idx[k] * 3,
						b = idx[k + 1] * 3;
					const A = worldToCanvas([wp[a], wp[a + 1], wp[a + 2]], view, proj, W, H);
					const B = worldToCanvas([wp[b], wp[b + 1], wp[b + 2]], view, proj, W, H);
					if (!A || !B) continue;
					const d = distToSeg(coords[0], coords[1], A[0], A[1], B[0], B[1]);
					if (d < bestD) {
						bestD = d;
						best = pl.sceneId;
					}
				}
			}
		}
		return best;
	}
}

// ── module-local helpers ───────────────────────────────────────────────────────

function stringifyProperties(props?: Record<string, unknown>): Record<string, string> | undefined {
	if (!props) return undefined;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(props)) out[k] = String(v);
	return out;
}

function aabbCenter(obj: { aabb?: number[] } | null | undefined): [number, number, number] | null {
	if (!obj?.aabb) return null;
	const a = obj.aabb;
	return [(a[0] + a[3]) / 2, (a[1] + a[4]) / 2, (a[2] + a[5]) / 2];
}

/** Union of the AABBs of the given scene objects, as `[xmin,ymin,zmin,xmax,ymax,zmax]`. */
function combineAabbs(objs: ({ aabb?: number[] } | null | undefined)[]): number[] | null {
	let out: number[] | null = null;
	for (const o of objs) {
		const a = o?.aabb;
		if (!a) continue;
		if (!out) {
			out = [a[0], a[1], a[2], a[3], a[4], a[5]];
		} else {
			out[0] = Math.min(out[0], a[0]);
			out[1] = Math.min(out[1], a[1]);
			out[2] = Math.min(out[2], a[2]);
			out[3] = Math.max(out[3], a[3]);
			out[4] = Math.max(out[4], a[4]);
			out[5] = Math.max(out[5], a[5]);
		}
	}
	return out;
}

function aabbCenter3(aabb: number[] | null): [number, number, number] | null {
	if (!aabb) return null;
	return [(aabb[0] + aabb[3]) / 2, (aabb[1] + aabb[4]) / 2, (aabb[2] + aabb[5]) / 2];
}

function cross3(a: number[], b: number[]): [number, number, number] {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize3(v: number[]): [number, number, number] {
	const len = Math.hypot(v[0], v[1], v[2]) || 1;
	return [v[0] / len, v[1] / len, v[2] / len];
}

/** Bounding sphere (centre + radius) of an AABB `[xMin,yMin,zMin, xMax,yMax,zMax]`. */
function aabbSphere(aabb: number[]): { center: [number, number, number]; radius: number } {
	return {
		center: [(aabb[0] + aabb[3]) / 2, (aabb[1] + aabb[4]) / 2, (aabb[2] + aabb[5]) / 2],
		radius:
			Math.hypot((aabb[3] - aabb[0]) / 2, (aabb[4] - aabb[1]) / 2, (aabb[5] - aabb[2]) / 2) || 1
	};
}

// Canonical ↔ world conversion for the up-axis. Comment anchors and cameras are stored by the host
// in canonical (model-local, Y-up) space so they stay valid across axis switches; the viewer rotates
// them to/from the current world space here. ZMAT rotates canonical→world as (x,y,z)→(x,z,-y); Y-up
// is the identity, so both are a no-op then. Pure permutation — points and directions transform alike.
function toWorldVec(v: number[], zUp: boolean): [number, number, number] {
	return zUp ? [v[0], v[2], -v[1]] : [v[0], v[1], v[2]];
}

function toCanonicalVec(v: number[], zUp: boolean): [number, number, number] {
	return zUp ? [v[0], -v[2], v[1]] : [v[0], v[1], v[2]];
}

function worldToCanvas(
	p: number[],
	view: number[],
	proj: number[],
	W: number,
	H: number
): [number, number] | null {
	const ex = view[0] * p[0] + view[4] * p[1] + view[8] * p[2] + view[12];
	const ey = view[1] * p[0] + view[5] * p[1] + view[9] * p[2] + view[13];
	const ez = view[2] * p[0] + view[6] * p[1] + view[10] * p[2] + view[14];
	const ew = view[3] * p[0] + view[7] * p[1] + view[11] * p[2] + view[15];
	const cx = proj[0] * ex + proj[4] * ey + proj[8] * ez + proj[12] * ew;
	const cy = proj[1] * ex + proj[5] * ey + proj[9] * ez + proj[13] * ew;
	const cw = proj[3] * ex + proj[7] * ey + proj[11] * ez + proj[15] * ew;
	if (cw <= 1e-6) return null;
	return [((cx / cw) * 0.5 + 0.5) * W, (1 - ((cy / cw) * 0.5 + 0.5)) * H];
}

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax,
		dy = by - ay;
	const len2 = dx * dx + dy * dy;
	const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
