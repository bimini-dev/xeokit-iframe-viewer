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
import { DEFAULT_VIEW_MODE } from '../protocol';
import type {
	CameraState,
	CommentMarker,
	ElementDescriptor,
	ModelFormat,
	ModelUnit,
	ViewMode,
	ViewerTool,
	ZoomDirection
} from '../protocol';
import { t } from '../i18n';
import { HoverHighlight } from './hover';
import { buildJsonModel, buildXktEntityList } from './loaders';
import { CommentMarkers, type ResolvedMarker } from './markers';
import { DistanceMeasure } from './measure';
import type { EntityRecord, ModelData, ModelRecord } from './types';

// Progressive zoom: each toolbar click / wheel notch scales the camera distance by this factor
// (≈10% of the current zoom level, so it moves fast at high magnification). MIN is the zoom-out floor.
const ZOOM_STEP_FACTOR = 1.1;
// Ctrl-modified step (≈1% per notch/click), for creeping up on a framing the normal step overshoots.
const FINE_ZOOM_STEP_FACTOR = 1.01;
const MIN_ZOOM_PCT = 10;
// Angle (deg) the target should subtend when framing an element, matching xeokit's default fitFOV.
const FIT_FOV_DEG = 45;
// Fraction of the viewport a freshly framed model spans. Just under 1 so it fills the view without
// touching the edges. Measured against the model's projected extents, not its bounding sphere — a
// sphere circumscribes a wide flat drawing with a lot of empty space, leaving it small on screen.
const FIT_SCREEN_FILL = 0.92;
// far/near ratio for the clip planes. xeokit defaults to near 0.1 / far 10000 and never adapts them,
// which silently clips any large model — a site map tens of km across sits entirely beyond the far
// plane and renders blank. Sized from the framing instead, keeping the ratio modest enough that the
// depth buffer does not z-fight.
const DEPTH_RANGE = 10000;

// A model counts as 2D when its thinnest axis is this negligible against its largest — a drawing
// exported to XKT collapses to (near) zero thickness on one axis. Such models open in 2D mode.
const FLAT_AXIS_RATIO = 0.01;
// Index of the world up-axis, and the fallback lock axis for a model that is not flat (top view).
const WORLD_UP_AXIS = 1;
// Screen-up for a plan view. A drawing carries no page orientation through XKT, so this is a
// convention rather than a fact: our exports put the sheet's up along source +X (world +X under
// ZMAT). A drawing from an exporter that disagrees opens rotated, and 2D mode cannot rotate it.
const PLAN_SCREEN_UP: [number, number, number] = [1, 0, 0];
// The 3/4 iso direction the 3D modes frame from, pre-normalised (it never varies).
const ISO_DIR = normalize3([1, 0.75, 1]);
// Seconds for a deliberate camera move. A load cuts instead — see flyToFit.
const FLIGHT_SECONDS = 0.5;
// MouseEvent.buttons bit flags (which buttons are held, as opposed to which one fired the event).
const MOUSE_LEFT = 1;
const MOUSE_RIGHT = 2;

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
	onModelLoaded: (
		name: string,
		elements: ElementDescriptor[],
		aabb: number[],
		mode: ViewMode
	) => void;
	onLoadError: (message: string) => void;
	onElementSelected: (
		elementId: string | null,
		label?: string,
		worldPos?: [number, number, number],
		camera?: CameraState,
		properties?: Record<string, string>
	) => void;
	onCommentMarkerClicked: (id: string, elementId: string | null, camera: CameraState) => void;
	onNotePlaced: (
		mode: 'element' | 'point',
		elementId: string | null,
		label: string | undefined,
		worldPos: [number, number, number] | undefined,
		camera: CameraState
	) => void;
	onCameraChanged: (camera: CameraState) => void;
	onZoomChanged: (percent: number) => void;
}

/** An explicit camera pose, in xeokit world coordinates. */
interface CameraPose {
	eye: [number, number, number];
	look: [number, number, number];
	up: [number, number, number];
}

export interface ViewerAppElements {
	// The in-iframe tree/info/stat panel was removed — the host renders an equivalent outside the
	// iframe. The viewer runs headless: canvas + postMessage only.
	canvas: HTMLCanvasElement;
	// The navigation hint overlay, retitled when the view lock takes rotation away.
	hint?: HTMLElement | null;
}

export class ViewerApp {
	private viewer: Viewer;
	private xktLoader: XKTLoaderPlugin;
	private markers: CommentMarkers;
	private measure: DistanceMeasure;
	private hover: HoverHighlight;
	// What a click does. While measuring, element picking (and the comment pins) stay out of the way
	// so a measurement click never doubles as a selection.
	private tool: ViewerTool = 'select';

	private models: ModelRecord[] = [];
	private index = new Map<string, { e: EntityRecord; m: ModelRecord }>(); // sceneId → …
	private elemToScene = new Map<string, string>(); // elementId → sceneId
	private selectedId: string | null = null;
	// Scene objects currently highlighted for the selection. One for a leaf; the whole geometric
	// subtree for a group selection driven from the host's model tree.
	private highlightedSceneIds: string[] = [];
	private seq = 0;
	// How the model is presented, and the single source of truth for orientation and rotation locking.
	// Re-derived on every load — a document opens 2D or 3D on its own geometry, so a mode chosen for
	// the previous one never carries over. Defaults to Z-up: most of our CAD/IFC source data is Z-up,
	// so a model loads upright without a manual switch.
	private mode: ViewMode = DEFAULT_VIEW_MODE;

	/** Rotation disabled (the fixed 2D view). */
	private get viewLocked(): boolean {
		return this.mode === '2d';
	}

	/** Whether source data is Z-up, and so needs ZMAT to reach xeokit's Y-up world. 2D is Z-up too. */
	private get zUp(): boolean {
		return this.mode !== '3d-y-up';
	}
	// Magnification shown in the host toolbar is derived from the live camera distance: the eye→look
	// distance at the fit view is 100%, and percent = fitDistance / currentDistance * 100. This keeps
	// the toolbar honest through wheel, buttons, fly-to and camera restores alike.
	private fitDistance = 0;
	private fitReady = false;
	// Bounding-sphere radius of the framed model, and the camera distance the clip planes were last
	// sized for. The frustum follows the zoom (see updateClipPlanes); 0 forces the next update.
	private modelRadius = 0;
	private clipDistance = 0;
	// Quarter turns clockwise applied to the fixed view's screen-up, 0–3. Which way is up on a drawing
	// is a convention the viewer guesses (PLAN_SCREEN_UP), so the user can turn it. Reset per model.
	private planTurns = 0;
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

		this.markers = new CommentMarkers(this.viewer, (id, elementId) => {
			// Only the select tool opens a pin: while measuring or placing a note, a click on a pin is
			// meant for that tool, not for the thread behind the pin.
			if (this.tool !== 'select') return;
			this.cb.onCommentMarkerClicked(id, elementId, this.cameraState());
		});
		this.measure = new DistanceMeasure(this.viewer, els.canvas);
		this.hover = new HoverHighlight(this.viewer, els.canvas);

		this.initCanvas();
		this.initPan();
		this.initPicking();
		this.initCameraEvents();
	}

	// ── Public API (called by the bridge) ──────────────────────────────────────

	async loadModel(bytes: ArrayBuffer, format: ModelFormat, name: string): Promise<void> {
		// A model paints progressively as it streams, under whatever camera is current — so it would show
		// up at the wrong size and jump once framing arrives. Hold the canvas back until it is framed.
		// `visibility` rather than `display`, so the canvas keeps its layout box and the ResizeObserver
		// is not woken for nothing.
		this.els.canvas.style.visibility = 'hidden';
		try {
			// This embedded viewer shows a single model per document, so each host loadModel replaces the
			// previous scene. Without this, a re-sent loadModel (e.g. the host refetching the file and
			// handing us a new `src` buffer) would stack a duplicate model in the tree.
			this.clearModel();
			if (format === 'xkt') await this.loadXkt(bytes, name);
			else await this.loadJson(bytes, name);

			this.reindex();
			// Rotate the model into the current up-axis, then fit it. The fit view defines 100% zoom.
			this.applyUpAxis();
			// A flat model is a 2D drawing: open it face-on and locked, so a stray drag cannot tip it
			// edge-on. Flatness survives the up-axis rotation (a permutation), so measuring it here holds
			// whichever mode we came in with — but adopting `2d` anchors to Z-up, which can re-orient.
			const flat = detectFlatAxis(this.viewer.scene.aabb);
			// A turn corrects one drawing's sheet orientation; it should not follow the next document.
			this.planTurns = 0;
			const wasZUp = this.zUp;
			this.applyMode(flat >= 0 ? '2d' : this.zUp ? '3d-z-up' : '3d-y-up');
			// Only when the axis actually flipped: assigning `matrix` re-transforms every entity's AABB
			// even when the value is unchanged.
			if (this.zUp !== wasZUp) this.applyUpAxis();
			// Cut straight to the fit view: the model appears already framed, rather than swinging in
			// from the camera's start pose.
			this.reframe(false);
			// Draw the framed view into the canvas before uncovering it. The buffer still holds the last
			// frame drawn while streaming — at the old camera — and 'loaded' can fire from inside the
			// viewer's own tick, so the redraw for this frame may already be behind us. Unforced: the
			// forced form also drains xeokit's deferred-task queue with no time budget, which right after
			// a large model streams in is an unbounded stall.
			this.viewer.scene.render();
			this.cb.onModelLoaded(name, this.elementDescriptors(), this.viewer.scene.aabb, this.mode);
		} catch (e: unknown) {
			this.cb.onLoadError(e instanceof Error ? e.message : String(e));
		} finally {
			this.els.canvas.style.visibility = '';
		}
	}

	clearModel(): void {
		this.select(null);
		this.hover.clear();
		this.markers.clear();
		// A measurement is anchored in world space; it would hang in the void without its geometry.
		this.measure.clear();
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
		const eye = toWorldVec(camera.eye, this.zUp);
		const look = toWorldVec(camera.look, this.zUp);
		if (this.viewLocked) {
			// A saved view carries whatever orientation it was captured at, which may predate the lock.
			// Keep its target and distance but square the camera up with the lock axis: with rotation
			// disabled, a tilted restore would leave the user stuck. Not a fit, so the baseline stands.
			this.moveCamera(this.axisPose(look, dist3(eye, look) || this.fitDistance), true);
			return;
		}
		// Brief animated travel to the target view (keeps spatial context) rather than a hard cut.
		this.moveCamera({ eye, look, up: toWorldVec(camera.up, this.zUp) }, true);
	}

	/**
	 * Zoom progressively: `in`/`out` scale the camera distance by a fixed factor (≈10% of the current
	 * level per step, so it moves quickly at high magnification), `reset` returns to the 100% fit
	 * distance. `fine` (Ctrl held) uses a much smaller factor for precise framing. The new percentage
	 * is reported to the host by the camera-move handler. Used by both the toolbar buttons and the
	 * mouse wheel.
	 *
	 * `canvasPos` (the wheel does, the toolbar buttons do not) anchors the zoom under the pointer
	 * instead of the view centre, so magnifying walks towards what is being pointed at. Without it,
	 * deep zoom on a model whose content sits off-centre closes in on empty space, and panning out to
	 * find the geometry takes an impractical drag — pan speed shrinks with the camera distance.
	 */
	zoomStep(direction: ZoomDirection, fine: boolean = false, canvasPos?: number[]): void {
		if (this.fitDistance <= 0) return;
		if (direction === 'reset') {
			this.setCameraDistance(this.fitDistance);
			return;
		}
		const dist = this.cameraDistance();
		if (dist <= 0) return;
		const factor = fine ? FINE_ZOOM_STEP_FACTOR : ZOOM_STEP_FACTOR;
		const next = dist * (direction === 'in' ? 1 / factor : factor);
		// Never zoom out past the floor (largest allowed distance = fitDistance / (MIN%/100)).
		this.setCameraDistance(
			Math.min(next, (this.fitDistance * 100) / MIN_ZOOM_PCT),
			canvasPos ? this.pointerTarget(canvasPos) : undefined
		);
	}

	/** Live eye→look distance. */
	private cameraDistance(): number {
		return dist3(this.viewer.camera.eye, this.viewer.camera.look);
	}

	/** Magnification derived from the live camera distance (100% = the fit view). */
	private currentZoomPercent(): number {
		const dist = this.cameraDistance();
		if (this.fitDistance <= 0 || dist <= 0) return 100;
		return Math.max(MIN_ZOOM_PCT, Math.round((this.fitDistance / dist) * 100));
	}

	/**
	 * Scale the camera in or out so the eye→look distance becomes `dist`, about `anchor` (defaulting to
	 * the target). Moving eye and look together about the anchor leaves the view direction untouched —
	 * so this is safe under the 2D lock — and keeps the anchor fixed on screen, because its offset from
	 * the view axis and its depth scale by the same factor.
	 */
	private setCameraDistance(dist: number, anchor?: number[]): void {
		const cur = this.cameraDistance();
		if (cur <= 1e-6 || dist <= 0) return;
		const factor = dist / cur;
		const camera = this.viewer.camera;
		// Snapshot: assigning `eye` writes through the same array the getter handed us.
		const eye = [camera.eye[0], camera.eye[1], camera.eye[2]];
		const look = [camera.look[0], camera.look[1], camera.look[2]];
		const pivot = anchor ?? look;
		camera.eye = [
			pivot[0] + (eye[0] - pivot[0]) * factor,
			pivot[1] + (eye[1] - pivot[1]) * factor,
			pivot[2] + (eye[2] - pivot[2]) * factor
		];
		// Only when anchored off-axis does the target actually move; skip the redundant write otherwise.
		if (anchor) {
			camera.look = [
				pivot[0] + (look[0] - pivot[0]) * factor,
				pivot[1] + (look[1] - pivot[1]) * factor,
				pivot[2] + (look[2] - pivot[2]) * factor
			];
		}
	}

	/**
	 * The world point under a canvas position, taken on the plane through the current target — which in
	 * the 2D view is the drawing's own plane. Deliberately not a surface pick: zooming happens over
	 * empty space at least as often as over geometry (that is the case this exists for, and a pick
	 * returns nothing there), and picking on every wheel notch is far more expensive.
	 */
	private pointerTarget(canvasPos: number[]): [number, number, number] | undefined {
		const canvas = this.els.canvas;
		const width = canvas.clientWidth;
		const height = canvas.clientHeight;
		if (width <= 0 || height <= 0) return undefined;
		const look = this.viewer.camera.look;
		const { right, up } = this.viewAxes();
		const { tanHalfFov, aspect } = this.viewportFov();
		// Half the view's world extent at the target plane, then the pointer's offset within it.
		const halfHeight = this.cameraDistance() * tanHalfFov;
		const dx = ((canvasPos[0] / width) * 2 - 1) * halfHeight * aspect;
		const dy = (1 - (canvasPos[1] / height) * 2) * halfHeight;
		return [
			look[0] + right[0] * dx + up[0] * dy,
			look[1] + right[1] * dx + up[1] * dy,
			look[2] + right[2] * dx + up[2] * dy
		];
	}

	/**
	 * Record the framing distance as the 100% baseline. Taken from the distance the fit was computed
	 * for, not from the camera on arrival: xeokit's `flyTo`/`jumpTo` both call `stop()` on entry, and
	 * `stop()` fires the pending arrival callback wherever the camera currently is — so a fit flight
	 * interrupted by a pin click or an element zoom would otherwise bake a mid-flight pose in as 100%.
	 */
	private setFitBaseline(dist: number): void {
		this.fitDistance = dist;
		this.fitReady = true;
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
			const elementId = marker.elementId ?? null;
			// A marker must have an identity to be reported back on click; the element id is the fallback
			// for hosts that pin at most one marker per element.
			const id = marker.id ?? elementId;
			if (!id) continue;
			if (marker.anchor) {
				// The host stores anchors canonical; rotate into the current world space to place them.
				// Nothing is looked up here, so a purely spatial marker renders even with no element.
				resolved.push({ id, elementId, worldPos: toWorldVec(marker.anchor, this.zUp) });
				continue;
			}
			// No stored anchor: fall back to the object's current-world AABB centre (already world space).
			const sceneId = elementId ? this.elemToScene.get(elementId) : undefined;
			const obj = sceneId ? this.viewer.scene.objects[sceneId] : null;
			const center = aabbCenter(obj);
			if (center) resolved.push({ id, elementId, worldPos: center });
		}
		this.markers.set(resolved);
	}

	/** Mark one comment marker as current; `null` clears it. */
	setSelectedMarker(id: string | null): void {
		this.markers.setSelected(id);
	}

	/** Mark one comment marker as transiently hovered; `null` clears the hover pulse. */
	setHoveredMarker(id: string | null): void {
		this.markers.setHovered(id);
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

	/**
	 * Switch what a click does: pick elements, measure a distance between two picked points, or
	 * anchor a note. Leaving the measure tool discards the segment on screen.
	 */
	setTool(tool: ViewerTool): void {
		if (tool === this.tool) return;
		this.tool = tool;
		this.measure.setActive(tool === 'measure');
		this.hover.setActive(this.isNoteTool(tool));
		// A crosshair is the only affordance the user gets that the next click will drop a note.
		this.els.canvas.style.cursor = this.isNoteTool(tool) ? 'crosshair' : '';
	}

	private isNoteTool(tool: ViewerTool): boolean {
		return tool === 'noteElement' || tool === 'notePoint';
	}

	/** Set the unit the model's coordinates are authored in (drives real measured lengths). */
	setModelUnit(unit: ModelUnit): void {
		this.measure.setModelUnit(unit);
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

	/**
	 * Switch how the model is presented: the fixed 2D view, or 3D orbiting with Y or Z up. Rotates the
	 * loaded models when the up-axis changes, and re-frames for the new mode either way.
	 *
	 * `2d` is anchored to Z-up, and has to be: the two orientations put different source axes on
	 * screen-up (Z-up leaves the flat axis as world Y, whose screen-up is +X; Y-up leaves it as world Z,
	 * whose screen-up is world +Y), so without anchoring, the same drawing would face two different ways
	 * depending on which 3D mode preceded it.
	 */
	setViewMode(mode: ViewMode): void {
		if (mode === this.mode) return;
		const reorients = this.zUp !== (mode !== '3d-y-up');
		this.applyMode(mode);
		if (reorients) {
			this.applyUpAxis();
			// The measured points are world-space and do not travel with the rotated model — drop the
			// segment rather than leaving it pointing at the wrong place.
			this.measure.clear();
		}
		// Re-frame for the new mode. The host re-sends comment markers, whose anchors move with the model.
		this.reframe();
	}

	/**
	 * Adopt a mode: `2d` disables camera rotation while leaving panning and zooming live, the 3D modes
	 * restore orbiting. Does not move the camera — callers re-frame.
	 */
	private applyMode(mode: ViewMode): void {
		this.mode = mode;
		// xeokit's planView nav mode is precisely "rotation disabled" — pan and dolly keep working.
		this.viewer.cameraControl.navMode = this.viewLocked ? 'planView' : 'orbit';
		// Keep `data-i18n` truthful, so a later re-run of applyStaticI18n cannot revert the wording.
		const key = this.viewLocked ? 'hintLocked' : 'hint';
		if (this.els.hint) {
			this.els.hint.dataset.i18n = key;
			this.els.hint.textContent = t(key);
		}
	}

	/** Rotate loaded models into the current mode's up-axis. */
	private applyUpAxis(): void {
		const matrix = this.zUp ? ZMAT : YMAT;
		for (const m of this.models) m.sm.matrix = matrix;
	}

	/**
	 * World axis the locked camera looks down: the model's flat axis, or the up-axis (a top view) when
	 * it has none. Derived on demand rather than stored — it moves with the model whenever the up-axis
	 * rotation is re-applied, and a stale copy would frame a drawing edge-on.
	 */
	private lockAxis(): number {
		const flat = detectFlatAxis(this.viewer.scene.aabb);
		return flat >= 0 ? flat : WORLD_UP_AXIS;
	}

	/** Re-frame the whole model for the current mode, re-establishing the 100% zoom baseline. */
	private reframe(animate: boolean = true): void {
		if (!this.models.length) return;
		this.fitReady = false;
		this.flyToFit(this.viewer.scene.aabb, animate);
	}

	/** Eye direction and screen-up for a view looking straight down the given world axis. */
	private axisBasis(axis: number): {
		dir: [number, number, number];
		up: [number, number, number];
	} {
		const dir: [number, number, number] = [0, 0, 0];
		dir[axis] = 1;
		// Looking down the world up-axis leaves the usual up derivation undefined, so a plan takes the
		// sheet convention; an elevation keeps the world up.
		const base = axis === WORLD_UP_AXIS ? PLAN_SCREEN_UP : ([0, 1, 0] as [number, number, number]);
		let up: [number, number, number] = [base[0], base[1], base[2]];
		// Turning the picture clockwise turns the camera's up onto the negated right — the old top ends
		// up on the right. Exact for these axis-aligned bases, so repeated turns cannot drift.
		const forward: [number, number, number] = [-dir[0], -dir[1], -dir[2]];
		for (let turn = 0; turn < this.planTurns; turn++) {
			const right = cross3(forward, up);
			up = [-right[0], -right[1], -right[2]];
		}
		return { dir, up };
	}

	/**
	 * Turn the fixed view a quarter turn clockwise, keeping the target and the zoom — what is on screen
	 * stays there, rotated about the centre. Snaps rather than flies: eye and look do not move, so
	 * there is no travel to convey, and interpolating only the up vector reads as a wobble.
	 */
	rotateView(): void {
		if (!this.viewLocked || !this.models.length) return;
		this.planTurns = (this.planTurns + 1) % 4;
		const look = this.viewer.camera.look;
		this.moveCamera(this.axisPose([look[0], look[1], look[2]], this.cameraDistance()), false);
	}

	/** Camera pose looking at `target` from `dist` away along `dir`, with the given screen-up. */
	private poseFrom(target: number[], dir: number[], up: number[], dist: number): CameraPose {
		return {
			eye: [target[0] + dir[0] * dist, target[1] + dir[1] * dist, target[2] + dir[2] * dist],
			look: [target[0], target[1], target[2]],
			up: [up[0], up[1], up[2]]
		};
	}

	/** Face-on view of `look` down the lock axis, from `dist` away. */
	private axisPose(look: number[], dist: number): CameraPose {
		const { dir, up } = this.axisBasis(this.lockAxis());
		return this.poseFrom(look, dir, up, dist);
	}

	/**
	 * Shift the camera by a pointer delta in pixels, moving eye and look together so the view direction
	 * — and with it the 2D lock — is untouched. Ours rather than `CameraControl`'s: xeokit discards any
	 * pan step below a fixed 0.001 world units (`CameraUpdater`'s EPSILON), and since a step scales with
	 * the camera distance, at high magnification every step falls under it and panning simply stops.
	 * The threshold is absolute while zoom is relative to the model, so where that bites depends
	 * entirely on the size of the model's coordinates.
	 */
	private panByPixels(dx: number, dy: number): void {
		const height = this.els.canvas.clientHeight;
		if (height <= 0) return;
		const { tanHalfFov } = this.viewportFov();
		// World units per pixel at the target plane — the same in both axes, since aspect scales the
		// visible width and the pixel width together.
		const perPixel = (2 * this.cameraDistance() * tanHalfFov) / height;
		const { right, up } = this.viewAxes();
		// Content follows the pointer, so the camera travels against it.
		const alongRight = -dx * perPixel;
		const alongUp = dy * perPixel;
		const shift = [
			right[0] * alongRight + up[0] * alongUp,
			right[1] * alongRight + up[1] * alongUp,
			right[2] * alongRight + up[2] * alongUp
		];
		const camera = this.viewer.camera;
		const eye = camera.eye;
		const look = [camera.look[0], camera.look[1], camera.look[2]];
		camera.eye = [eye[0] + shift[0], eye[1] + shift[1], eye[2] + shift[2]];
		camera.look = [look[0] + shift[0], look[1] + shift[1], look[2] + shift[2]];
	}

	/**
	 * Right-drag panning for the locked 2D view, replacing the one in `CameraControl` (see
	 * panByPixels). The mousedown is caught in the capture phase on `document` and stopped there:
	 * xeokit's own listener sits on the canvas and was registered first, so that is the only point at
	 * which it can be kept from arming its pan too. Only the right button is taken, and only while
	 * locked — hover, picking and the measurement tool keep seeing every event they need.
	 */
	private initPan(): void {
		const canvas = this.els.canvas;
		let panning = false;
		let leftDown = false;
		let lastX = 0;
		let lastY = 0;

		document.addEventListener(
			'mousedown',
			(e: MouseEvent) => {
				if (e.target !== canvas) return;
				// Tracked only to suppress the left-drag pan below; the button itself is left alone,
				// because `Input` builds its `mouseclicked` from this very mousedown and its mouseup
				// (Input.js), and swallowing it would take selection and note placement with it.
				if (e.button === 0) {
					leftDown = true;
					return;
				}
				if (!this.viewLocked || e.button !== 2) return;
				e.stopPropagation();
				panning = true;
				lastX = e.clientX;
				lastY = e.clientY;
			},
			true
		);

		// Plan view pans on any drag (`isPanning()` is `configs.planView || …`), so left-drag would pan
		// through CameraControl and hit the EPSILON floor that right-drag no longer does. Stopping the
		// move in the capture phase keeps it from reaching xeokit at all: its own mousemove listener
		// sits on `document` in the bubble phase, so this runs first. Pan is the right button, as the
		// on-screen hint says. Hover pauses for the duration of the drag, which is not a hover anyway.
		document.addEventListener(
			'mousemove',
			(e: MouseEvent) => {
				// A button released outside the iframe never reaches our mouseup, so trust the live
				// button state over the flag — otherwise the drag would carry on after the release.
				if ((e.buttons & MOUSE_LEFT) === 0) leftDown = false;
				if (leftDown && this.viewLocked) e.stopPropagation();
			},
			true
		);

		document.addEventListener('mousemove', (e: MouseEvent) => {
			if (!panning) return;
			if ((e.buttons & MOUSE_RIGHT) === 0) {
				panning = false;
				return;
			}
			this.panByPixels(e.clientX - lastX, e.clientY - lastY);
			lastX = e.clientX;
			lastY = e.clientY;
		});

		document.addEventListener('mouseup', (e: MouseEvent) => {
			if (e.button === 0) leftDown = false;
			panning = false;
		});

		// Right-drag would otherwise raise the browser menu when the button comes up.
		canvas.addEventListener('contextmenu', (e: MouseEvent) => {
			if (this.viewLocked) e.preventDefault();
		});
	}

	/** Orthonormal screen axes of the current camera. `up` is re-derived, since `camera.up` need not be
	 * exactly perpendicular to the view direction. */
	private viewAxes(): { right: [number, number, number]; up: [number, number, number] } {
		const camera = this.viewer.camera;
		const eye = camera.eye;
		const look = camera.look;
		const forward = normalize3([look[0] - eye[0], look[1] - eye[1], look[2] - eye[2]]);
		const right = normalize3(cross3(forward, camera.up));
		return { right, up: cross3(right, forward) };
	}

	/**
	 * Half-FOV tangent and aspect for the current canvas, mirroring how xeokit builds the projection
	 * (`Perspective._update` applies `fov` to the narrower axis by default).
	 */
	private viewportFov(): { tanHalfFov: number; aspect: number } {
		const canvas = this.els.canvas;
		const aspect = canvas.clientHeight > 0 ? canvas.clientWidth / canvas.clientHeight : 1;
		const perspective = this.viewer.camera.perspective;
		const axis = perspective.fovAxis;
		let fov = perspective.fov;
		if (axis === 'x' || (axis === 'min' && aspect < 1) || (axis === 'max' && aspect > 1)) {
			fov /= aspect;
		}
		return { tanHalfFov: Math.tan((Math.min(fov, 120) * Math.PI) / 360), aspect };
	}

	/**
	 * Size the clip planes for the camera's current distance. Runs on every camera move, because the
	 * frustum has to follow the zoom: planes fixed at the fit distance clip the model away once you
	 * dolly far enough either way — which is what xeokit's own defaults (near 0.1 / far 10000) do to
	 * any large model. `far` clears the whole model so it survives zooming out; `near` is additionally
	 * held below the camera distance, so zooming in can never clip the very thing being approached.
	 */
	private updateClipPlanes(): void {
		const dist = this.cameraDistance();
		if (dist <= 0) return;
		// Writing these rebuilds the projection matrix, so skip while the distance is materially
		// unchanged — orbiting and panning hold it constant, and only zooming moves it.
		if (this.clipDistance > 0 && dist > this.clipDistance * 0.9 && dist < this.clipDistance * 1.1) {
			return;
		}
		this.clipDistance = dist;
		const perspective = this.viewer.camera.perspective;
		const far = (dist + this.modelRadius) * 2;
		perspective.far = far;
		perspective.near = Math.min(far / DEPTH_RANGE, dist / 2);
	}

	/**
	 * Frame `aabb` for the current mode: face-on down the lock axis when locked, otherwise a 3/4 iso
	 * view with a properly orthonormalised up. The model is sized to span `FIT_SCREEN_FILL` of the
	 * viewport, measured from its extents projected onto the view plane against the canvas's real
	 * aspect. `animate` false cuts straight there, which is what a freshly loaded model wants — it has
	 * no previous view to keep continuity with, so a flight just reads as the picture lurching in.
	 */
	private flyToFit(aabb: number[], animate: boolean = true): void {
		const center = aabbCenter3(aabb) ?? [0, 0, 0];
		const ext = [aabb[3] - aabb[0], aabb[4] - aabb[1], aabb[5] - aabb[2]];

		let dir: [number, number, number];
		let up: [number, number, number];
		if (this.viewLocked) {
			({ dir, up } = this.axisBasis(this.lockAxis()));
		} else {
			// The world is always Y-up here: ZMAT maps Z-up source data into xeokit's Y-up world, so the
			// camera basis, iso direction and worldUp must all be Y-based (matching camera.worldUp, which
			// the orbit controller levels against — a mismatch made the roll snap on the first nudge).
			dir = ISO_DIR;
			// Orthonormal up: perpendicular to the view direction, aligned to the world up-axis.
			up = cross3(normalize3(cross3([-dir[0], -dir[1], -dir[2]], [0, 1, 0])), [
				-dir[0],
				-dir[1],
				-dir[2]
			]);
		}

		// How far back the eye must sit for the model's on-screen half-extents to fill the viewport.
		// Whichever of width/height is the binding constraint wins; depth pushes the eye clear of the
		// near face. Falls back to the bounding sphere for geometry with no measurable extent.
		const forward: [number, number, number] = [-dir[0], -dir[1], -dir[2]];
		const halfWidth = halfExtentAlong(ext, cross3(forward, up));
		const halfHeight = halfExtentAlong(ext, up);
		const halfDepth = halfExtentAlong(ext, forward);
		const { tanHalfFov, aspect } = this.viewportFov();
		const needed = Math.max(halfHeight / tanHalfFov, halfWidth / (tanHalfFov * aspect));
		const sphere = aabbSphere(aabb);
		const dist = (needed > 0 ? needed : sphere.radius) / FIT_SCREEN_FILL + halfDepth;

		// The clip planes are sized around this radius from here on; 0 makes the move below re-derive
		// them even when the camera happens to land at its previous distance.
		this.modelRadius = sphere.radius;
		this.clipDistance = 0;
		// The eye lands exactly `dist` from the target, so the baseline is known up front; set before
		// moving, so the magnification reported during the move is measured against it.
		this.setFitBaseline(dist);
		this.moveCamera(this.poseFrom(center, dir, up, dist), animate);
	}

	/**
	 * Move the camera to an explicit pose, flying or cutting. Always routed through `cameraFlight` —
	 * the same channel comment-restore uses, which keeps xeokit's camera controller in sync. Setting
	 * `camera.eye/look/up` directly, or flying to a boundary, leaves the controller out of sync, so the
	 * view is subtly off and snaps ("needs a nudge") on the first interaction.
	 */
	private moveCamera(pose: CameraPose, animate: boolean): void {
		if (animate) this.viewer.cameraFlight.flyTo({ ...pose, duration: FLIGHT_SECONDS });
		else this.viewer.cameraFlight.jumpTo(pose);
		this.maybeEmitZoom();
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
				// Set before streaming starts, or a big model flashes Y-up until 'loaded' fires.
				if (this.zUp) sm.matrix = ZMAT;
			} catch (e) {
				reject(e);
				return;
			}
			sm.on('loaded', () => {
				// Up-axis rotation is applied on creation above, not here.
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
			// An armed note tool takes the click outright: it anchors a note rather than changing the
			// selection, so the host's create dialog opens against exactly what the user aimed at.
			if (this.isNoteTool(this.tool)) {
				this.placeNote(coords, this.tool === 'notePoint');
				return;
			}
			// While measuring, a click places a measurement point — it must not also select whatever is
			// under it (which would highlight the element and open its detail in the host).
			if (this.tool === 'measure') return;
			const hit = this.viewer.scene.pick({ canvasPos: coords });
			if (hit?.entity) {
				this.select(String(hit.entity.id), hit.worldPos);
				return;
			}
			this.select(this.pick2DLine(coords, 10));
		});
	}

	/**
	 * Anchor a note to the clicked element, or to the exact point where the click met its surface.
	 * A click that misses geometry reports nothing, so the tool stays armed and the user just clicks
	 * again rather than having the mode silently fall away under them.
	 */
	private placeNote(coords: number[], wantPoint: boolean): void {
		// `pickSurface` is what makes xeokit compute the ray/triangle intersection; without it the pick
		// result carries no worldPos at all and the anchor would silently collapse to the AABB centre.
		const hit = this.viewer.scene.pick({ canvasPos: coords, pickSurface: wantPoint });
		if (!hit?.entity) return;
		const worldPos = wantPoint ? hit.worldPos : null;
		if (wantPoint && !worldPos) return;
		const sceneId = String(hit.entity.id);
		const e = this.index.get(sceneId)?.e;
		this.cb.onNotePlaced(
			wantPoint ? 'point' : 'element',
			e?.id ?? null,
			e?.label,
			// Canonical space, so a pin survives an up-axis switch exactly like a saved camera does.
			worldPos ? toCanonicalVec(worldPos, this.zUp) : undefined,
			this.cameraState()
		);
		// Which element a clicked surface belongs to is not obvious — a wall, its cladding and the
		// room all sit under the same pixel — so highlight what we understood before the host opens
		// its create dialog. A point anchor is exactly where the user clicked and needs no such
		// confirmation. Emitted after onNotePlaced so the host can suppress the selection echo.
		if (!wantPoint) {
			this.select(sceneId);
			// select() already highlights this same entity via `.highlighted` — drop the hover overlay
			// so the two don't visually stack on top of each other.
			this.hover.clear();
		}
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
		// Marker selection is not derived from the element — the host pushes it with setSelectedMarker.
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
			// Keep the frustum around the camera wherever the zoom takes it.
			this.updateClipPlanes();
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
				// Also swallows the browser's own Ctrl+wheel page zoom, which would otherwise fight the
				// fine-zoom gesture below.
				e.preventDefault();
				// One step per notch, matching the toolbar buttons (scroll up = zoom in); Ctrl = fine step.
				// Anchored under the pointer, so magnifying moves towards what is being pointed at.
				const rect = canvas.getBoundingClientRect();
				this.zoomStep(e.deltaY < 0 ? 'in' : 'out', e.ctrlKey, [
					e.clientX - rect.left,
					e.clientY - rect.top
				]);
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

/**
 * Half-extent of a box (given as full extents per world axis) projected onto a unit vector — the
 * standard AABB support function, equivalent to taking the widest of the eight corners.
 */
function halfExtentAlong(ext: number[], v: number[]): number {
	return 0.5 * (Math.abs(ext[0] * v[0]) + Math.abs(ext[1] * v[1]) + Math.abs(ext[2] * v[2]));
}

/** Distance between two points. */
function dist3(a: number[], b: number[]): number {
	return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function cross3(a: number[], b: number[]): [number, number, number] {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize3(v: number[]): [number, number, number] {
	const len = Math.hypot(v[0], v[1], v[2]) || 1;
	return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * Index of the world axis a model is flat along, or -1 when it has real extent in all three. This is
 * how a 2D-only model is told apart from a 3D one: both arrive as ordinary XKT, but a drawing has
 * (near) zero thickness on one axis. Only the opening mode rides on this — the host can switch modes,
 * so a misjudged model is always recoverable.
 */
function detectFlatAxis(aabb: number[]): number {
	const ext = [aabb[3] - aabb[0], aabb[4] - aabb[1], aabb[5] - aabb[2]];
	const span = Math.max(ext[0], ext[1], ext[2]);
	if (!(span > 0)) return -1;
	let thin = 0;
	for (let i = 1; i < ext.length; i++) if (ext[i] < ext[thin]) thin = i;
	return ext[thin] <= FLAT_AXIS_RATIO * span ? thin : -1;
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
