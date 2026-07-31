// SPDX-License-Identifier: AGPL-3.0-only OR MIT
// Copyright (c) 2026 bimini-dev
//
// This file is dual-licensed by its copyright holder. Unlike the rest of this AGPL-3.0 application,
// the boundary contract may also be used under the MIT license (see LICENSE-MIT), so that a host
// application can implement the protocol without taking on AGPL obligations.

/**
 * postMessage boundary contract between a host application and this xeokit viewer (iframe).
 *
 * This file is the authoritative definition of the protocol. It is deliberately not distributed as a
 * shared package — a host implements the contract independently, so no code crosses the licensing
 * boundary in either direction.
 *
 * Every message carries `channel: 'xeokit-viewer'` and `protocolVersion` so both sides can reject
 * foreign / mismatched messages. Origins are validated separately by the transport (see bridge.ts).
 */

// ─── Protocol contract ───

export const PROTOCOL_CHANNEL = 'xeokit-viewer' as const;
/**
 * Incremented only when a change below breaks compatibility between host and viewer — `isEnvelope`
 * rejects a mismatched version outright, so a bump means both sides must ship together. Additive
 * messages and optional fields do not qualify, and note that this number is the only capability
 * signal a host ever receives: the package version never crosses the boundary.
 *
 * The package version is independent, and follows ordinary semver over user-visible change. The two
 * answer different questions — whether these two can talk, versus what is in this build. Neither
 * identifies a build exactly; the commit stamped into the about dialog does.
 */
export const PROTOCOL_VERSION = 1 as const;

/** Supported model container formats the viewer can decode from raw bytes. */
export type ModelFormat = 'xkt' | 'json';

/** Camera pose, xeokit world coordinates. */
export interface CameraState {
	eye: [number, number, number];
	look: [number, number, number];
	up: [number, number, number];
}

/** A comment marker the host asks the viewer to render. */
export interface CommentMarker {
	/**
	 * Stable identity of this marker, echoed back on click. Defaults to `elementId` when omitted.
	 * Supply it whenever several markers can share one element, or when there is no element at all.
	 */
	id?: string;
	/**
	 * Stable element id (xeokit object / IFC GUID) the marker is pinned to. Omit for a marker
	 * anchored purely in space, which requires `anchor`.
	 */
	elementId?: string;
	/** Optional explicit world anchor; when omitted the viewer uses the element's AABB centre. */
	anchor?: [number, number, number];
}

/** Minimal element descriptor surfaced back to the host after a model loads. */
export interface ElementDescriptor {
	id: string;
	label: string;
	/** Parent element id in the model's structure hierarchy; absent for root nodes. */
	parentId?: string;
	/** Whether this node has its own geometry (a leaf) vs. a pure structural group. */
	hasGeometry?: boolean;
	/** The element's type (often an IFC product type, e.g. `IfcFooting`); absent when unknown. */
	type?: string;
}

// ── Host → Viewer ────────────────────────────────────────────────────────────

export interface InitMessage {
	type: 'init';
	/** Feature flags reserved for future use. */
	readonly?: boolean;
}

export interface LoadModelMessage {
	type: 'loadModel';
	format: ModelFormat;
	name: string;
	/**
	 * The model bytes. Sent as a transferable so it arrives zero-copy. The host is responsible
	 * for passing a COPY (e.g. `bytes.slice(0)`) so its own cached buffer is not detached.
	 */
	bytes: ArrayBuffer;
}

export interface SetCommentMarkersMessage {
	type: 'setCommentMarkers';
	markers: CommentMarker[];
}

/**
 * Mark one comment marker as current; `null` clears it. Keyed on the marker, not its element:
 * several markers can share an element, and a point-anchored one has no element at all.
 */
export interface SetSelectedMarkerMessage {
	type: 'setSelectedMarker';
	id: string | null;
}

export interface FocusElementMessage {
	type: 'focusElement';
	elementId: string;
	/** For a group node, the geometric descendants to frame together; absent for a leaf. */
	memberIds?: string[];
}

export interface SetCameraMessage {
	type: 'setCamera';
	camera: CameraState;
}

export interface SelectElementMessage {
	type: 'selectElement';
	/** null clears the current selection. */
	elementId: string | null;
	/** For a group node, the geometric descendants to highlight together; absent for a leaf. */
	memberIds?: string[];
}

export interface ClearModelMessage {
	type: 'clearModel';
}

/** Zoom in, out (progressive — a fraction of the current level), or reset to the 100% fit view. */
export type ZoomDirection = 'in' | 'out' | 'reset';

/**
 * Step the zoom. The viewer owns the level and dollies the camera to match, so toolbar and wheel stay
 * in sync; it replies with `zoomChanged`.
 */
export interface ZoomMessage {
	type: 'zoom';
	direction: ZoomDirection;
	/** Take a much smaller step (the host sends this when Ctrl is held). Ignored by `reset`. */
	fine?: boolean;
}

/** Which world axis points up. Models are rotated to match; `y` is the default. */
export type UpAxis = 'y' | 'z';

export interface SetUpAxisMessage {
	type: 'setUpAxis';
	axis: UpAxis;
}

/** Isolate the given elements (X-ray everything else); `null` clears the isolation. */
export interface IsolateElementMessage {
	type: 'isolateElement';
	elementIds: string[] | null;
}

/**
 * What a click in the 3D view does: pick an element (`select`), place the two ends of a distance
 * measurement (`measure`), or anchor a note to the clicked element (`noteElement`) / to the exact
 * clicked surface point (`notePoint`). Only one is active at a time — the viewer suppresses element
 * picking and comment-marker clicks for every tool other than `select`.
 *
 * The note tools are one-shot in intent: the viewer reports `notePlaced` and stays armed, leaving
 * the host to switch back to `select` once it has consumed the anchor.
 */
export type ViewerTool = 'select' | 'measure' | 'noteElement' | 'notePoint';

/** Switch the active pointer tool. Leaving `measure` discards the measurement on screen. */
export interface SetToolMessage {
	type: 'setTool';
	tool: ViewerTool;
}

/**
 * The unit a model's world coordinates are authored in. Like the up-axis, this describes the model
 * rather than the presentation: it tells the viewer how to read the geometry, so measurements come
 * out as real lengths. The label's own unit is chosen per measurement from its magnitude.
 */
export type ModelUnit = 'mm' | 'cm' | 'm';

/** Set how the model's coordinates are interpreted. Re-labels the measurement already on screen. */
export interface SetModelUnitMessage {
	type: 'setModelUnit';
	unit: ModelUnit;
}

export type HostToViewerMessage =
	| InitMessage
	| LoadModelMessage
	| SetCommentMarkersMessage
	| SetSelectedMarkerMessage
	| FocusElementMessage
	| SetCameraMessage
	| SelectElementMessage
	| ClearModelMessage
	| ZoomMessage
	| SetUpAxisMessage
	| IsolateElementMessage
	| SetToolMessage
	| SetModelUnitMessage;

// ── Viewer → Host ────────────────────────────────────────────────────────────

export interface ReadyMessage {
	type: 'ready';
	protocolVersion: number;
}

export interface ModelLoadedMessage {
	type: 'modelLoaded';
	name: string;
	elements: ElementDescriptor[];
	/** World-space AABB [xMin,yMin,zMin, xMax,yMax,zMax]. */
	aabb: number[];
}

export interface LoadErrorMessage {
	type: 'loadError';
	message: string;
}

export interface ElementSelectedMessage {
	type: 'elementSelected';
	/** null means the selection was cleared. */
	elementId: string | null;
	label?: string;
	worldPos?: [number, number, number];
	camera?: CameraState;
	/** The element's properties (IFC/metadata), stringified key→value; absent when cleared. */
	properties?: Record<string, string>;
}

export interface CommentMarkerClickedMessage {
	type: 'commentMarkerClicked';
	/** Marker identity as supplied in `CommentMarker.id` (falls back to the element id). */
	id: string;
	/** The element the marker is pinned to; null for a marker anchored purely in space. */
	elementId: string | null;
	camera: CameraState;
}

/**
 * The user placed a note anchor while `noteElement` / `notePoint` was the active tool. The host is
 * expected to open its own create dialog and switch the tool back to `select`.
 */
export interface NotePlacedMessage {
	type: 'notePlaced';
	/** Which note tool produced this: anchored to the element, or to the exact clicked point. */
	mode: 'element' | 'point';
	/** The element under the click; null when the click missed all geometry. */
	elementId: string | null;
	label?: string;
	/** The exact clicked surface point, in canonical coordinates. Only sent for `mode: 'point'`. */
	worldPos?: [number, number, number];
	camera: CameraState;
}

export interface CameraChangedMessage {
	type: 'cameraChanged';
	camera: CameraState;
}

/** The current magnification percentage after a zoom step (wheel or toolbar). */
export interface ZoomChangedMessage {
	type: 'zoomChanged';
	percent: number;
}

export type ViewerToHostMessage =
	| ReadyMessage
	| ModelLoadedMessage
	| LoadErrorMessage
	| ElementSelectedMessage
	| CommentMarkerClickedMessage
	| NotePlacedMessage
	| CameraChangedMessage
	| ZoomChangedMessage;

// ── Envelope ─────────────────────────────────────────────────────────────────

export type ProtocolPayload = HostToViewerMessage | ViewerToHostMessage;

export interface Envelope<T extends ProtocolPayload = ProtocolPayload> {
	channel: typeof PROTOCOL_CHANNEL;
	protocolVersion: number;
	payload: T;
}

/** Type guard: is this an envelope belonging to our channel and protocol version? */
export function isEnvelope(data: unknown): data is Envelope {
	if (typeof data !== 'object' || data === null) return false;
	const e = data as Partial<Envelope>;
	return (
		e.channel === PROTOCOL_CHANNEL &&
		e.protocolVersion === PROTOCOL_VERSION &&
		typeof e.payload === 'object' &&
		e.payload !== null &&
		typeof (e.payload as ProtocolPayload).type === 'string'
	);
}

export function wrap<T extends ProtocolPayload>(payload: T): Envelope<T> {
	return { channel: PROTOCOL_CHANNEL, protocolVersion: PROTOCOL_VERSION, payload };
}
