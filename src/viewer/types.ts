// Internal viewer data model. Ported from the V7 reference's per-model / per-entity records.

import type { SceneModel } from '@xeokit/xeokit-sdk';

export type SrcKind = 'json' | 'xkt';

export interface EntityRecord {
	id: string;
	label: string;
	meshIds?: string[];
	properties?: Record<string, unknown>;
	/** Element type (often an IFC product type, e.g. `IfcFooting`); absent when unknown. */
	type?: string;
	/** Parent element id in the model's structure hierarchy; absent for root nodes. */
	parentId?: string;
	/** Whether this node carries its own geometry (a leaf) vs. a pure structural group. */
	hasGeometry: boolean;
	/** Scene-object id actually registered in xeokit (prefixed per model). */
	_sceneId: string;
	_dotColor: number[];
}

/** CPU-pickable line segments for thin 2D geometry (see V7 pick2DLine). */
export interface PickLine {
	sceneId: string;
	wp: number[];
	idx: number[];
}

export interface ModelRecord {
	uid: number;
	source: string;
	// xeokit model handle. XKTLoaderPlugin returns a VBOSceneModel (a SceneModel subclass), so
	// SceneModel covers both the JSON (SceneModel) and XKT (VBOSceneModel) load paths.
	sm: SceneModel;
	entities: EntityRecord[];
	triCount: number;
	color: number[];
	pickLines?: PickLine[];
	_visible?: boolean;
	_opacity?: number;
	_srcKind: SrcKind;
}

export interface BuiltModel {
	sm: SceneModel;
	entities: EntityRecord[];
	triCount: number;
	pickLines?: PickLine[];
}

/** A mesh in a plain-JSON model payload. */
export interface JsonMesh {
	id: string;
	primitive?: string;
	positions?: number[];
	indices?: number[];
	normals?: number[];
	color?: number[];
	opacity?: number;
}

/** An entity (object) in a plain-JSON model payload. */
export interface JsonEntity {
	id: string;
	label?: string;
	meshIds?: string[];
	properties?: Record<string, unknown>;
}

/** Parsed plain-JSON / buffered-2D model payload. */
export interface ModelData {
	source?: string;
	meshes?: JsonMesh[];
	entities?: JsonEntity[];
	images?: unknown[];
}
