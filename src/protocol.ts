// SPDX-License-Identifier: AGPL-3.0-only OR MIT
// Copyright (c) 2026 bimini-dev
//
// This file is dual-licensed by its copyright holder. Unlike the rest of this AGPL-3.0 application,
// the boundary contract may also be used under the MIT license (see LICENSE-MIT), so that a host
// application can implement the protocol without taking on AGPL obligations.

/**
 * postMessage boundary contract between a host application and this xeokit viewer (iframe).
 *
 * This file is the single source of truth for the protocol. The host application keeps its own copy;
 * the two MUST be kept in sync by hand — they are intentionally NOT a shared package, so that no code
 * crosses the AGPL boundary between the (typically proprietary) host and this (AGPL-3.0) viewer.
 *
 * Only the header above the marker below differs between the copies; the contract itself is compared
 * byte-for-byte in CI by `scripts/check-protocol-sync.mjs`.
 *
 * Every message carries `channel: 'xeokit-viewer'` and `protocolVersion` so both sides can reject
 * foreign / mismatched messages. Origins are validated separately by the transport (see bridge.ts).
 */

// ─── SHARED CONTRACT: everything below this line MUST be byte-identical in both copies ───

export const PROTOCOL_CHANNEL = 'xeokit-viewer' as const;
export const PROTOCOL_VERSION = 1 as const;

/** Supported model container formats the viewer can decode from raw bytes. */
export type ModelFormat = 'xkt' | 'json';

/** Camera pose, xeokit world coordinates. */
export interface CameraState {
	eye: [number, number, number];
	look: [number, number, number];
	up: [number, number, number];
}

/** A comment marker the host asks the viewer to render on an element. */
export interface CommentMarker {
	/** Stable element id (xeokit object / IFC GUID) the marker is pinned to. */
	elementId: string;
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

export type HostToViewerMessage =
	| InitMessage
	| LoadModelMessage
	| SetCommentMarkersMessage
	| FocusElementMessage
	| SetCameraMessage
	| SelectElementMessage
	| ClearModelMessage
	| ZoomMessage
	| SetUpAxisMessage
	| IsolateElementMessage;

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
	elementId: string;
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
