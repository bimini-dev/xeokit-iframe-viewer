// Geometry loaders ported from the V7 reference (buildJsonModel / XKT metadata). Input is an
// in-memory ArrayBuffer/text received over postMessage instead of a File from an <input>.

import { SceneModel, type MetaScene, type Scene } from '@xeokit/xeokit-sdk';
import type { ElementProperty } from '../protocol';
import type { BuiltModel, EntityRecord, ModelData } from './types';

// ── Plain JSON model ─────────────────────────────────────────────────────────
export function buildJsonModel(
	scene: Scene,
	data: ModelData,
	uid: number,
	color: number[]
): BuiltModel {
	const prefix = 'm' + uid + '::';
	const sm = new SceneModel(scene, { id: 'm' + uid, isModel: true, dtxEnabled: false });

	let triCount = 0;
	for (const mesh of data.meshes ?? []) {
		const isLines = mesh.primitive === 'lines';
		const meshColor =
			Array.isArray(mesh.color) && mesh.color.length >= 3
				? [mesh.color[0], mesh.color[1], mesh.color[2]]
				: color;
		const opacity = typeof mesh.opacity === 'number' ? mesh.opacity : 1.0;
		const cfg = {
			id: prefix + mesh.id + '_m',
			primitive: isLines ? 'lines' : 'triangles',
			positions: mesh.positions,
			indices: mesh.indices,
			color: meshColor,
			opacity,
			...(!isLines && Array.isArray(mesh.normals) && mesh.normals.length > 0
				? { normals: mesh.normals }
				: {})
		};
		// xeokit types createMesh's config with ~15 required fields (positions/normals/colors/…),
		// though in practice most are optional; assert past that over-strict signature.
		sm.createMesh(cfg as unknown as Parameters<typeof sm.createMesh>[0]);
		if (!isLines) triCount += (mesh.indices?.length ?? 0) / 3;
	}

	const meshById = new Map((data.meshes ?? []).map((m) => [m.id, m] as const));
	const entities: EntityRecord[] = [];
	for (const entity of data.entities ?? []) {
		const sceneId = prefix + entity.id;
		let dot = color;
		if (entity.meshIds?.length) {
			const md = meshById.get(entity.meshIds[0]);
			if (md && Array.isArray(md.color) && md.color.length >= 3) dot = md.color;
		}
		entities.push({
			id: entity.id,
			label: entity.label ?? entity.id,
			meshIds: entity.meshIds,
			properties: entity.properties
				? Object.entries(entity.properties).map(([name, value]) => ({ name, value }))
				: undefined,
			// Plain-JSON models are flat — no structure hierarchy to expose.
			hasGeometry: !!entity.meshIds?.length,
			_sceneId: sceneId,
			_dotColor: dot
		});
		if (entity.meshIds?.length) {
			sm.createEntity({
				id: sceneId,
				meshIds: entity.meshIds.map((id: string) => prefix + id + '_m'),
				isObject: true
			});
		}
	}

	sm.finalize();
	return { sm, entities, triCount };
}

// ── XKT metadata → entity list ────────────────────────────────────────────────
type XktPropertyMetadata = Readonly<Record<string, unknown>>;

interface XktMetadata {
	properties?: readonly XktPropertyMetadata[];
	propertySets?: readonly {
		id?: string | number;
		properties?: readonly (XktPropertyMetadata | number)[];
	}[];
}

/** Capture the requested field before xeokit converts the embedded records to Property instances. */
export function readXktPropertyIdentifiers(
	metadata: unknown,
	field: string
): ReadonlyMap<string, ReadonlyMap<number, string>> {
	const bySet = new Map<string, ReadonlyMap<number, string>>();
	if (!metadata || typeof metadata !== 'object') return bySet;

	const data = metadata as XktMetadata;
	for (const set of data.propertySets ?? []) {
		if (set.id === undefined) continue;
		const identifiers = new Map<number, string>();
		for (const [index, entry] of (set.properties ?? []).entries()) {
			// XKT can reference a shared property by its index instead of storing it inline.
			const property = typeof entry === 'number' ? data.properties?.[entry] : entry;
			const value = property && Object.hasOwn(property, field) ? property[field] : undefined;
			if (typeof value === 'string' && value.trim()) identifiers.set(index, value.trim());
		}
		if (identifiers.size > 0) bySet.set(String(set.id), identifiers);
	}
	return bySet;
}

export function buildXktEntityList(
	metaScene: MetaScene,
	scene: Scene,
	smId: string,
	color: number[],
	modelName: string,
	identifiersBySet?: ReadonlyMap<string, ReadonlyMap<number, string>>
): EntityRecord[] {
	const metaModel = metaScene.metaModels[smId];
	const metaObjs = metaModel ? Object.values(metaModel.metaObjects) : [];
	// The XKT root keeps the source CAD name, often a generic converter name such as
	// "autocad_3d_model". The host name is the document these elements belong to.
	const modelLabel: string = modelName.trim();
	const rootIds = new Set<string>((metaModel?.rootMetaObjects ?? []).map((root) => root.id));
	const entities: EntityRecord[] = [];
	for (const mo of metaObjs) {
		// Keep structural/group metaobjects (no geometry of their own) so the host can render the
		// full model hierarchy; they're flagged hasGeometry:false and carry no meshIds.
		const hasGeometry = !!scene.objects[mo.id];
		const properties: ElementProperty[] = [];
		for (const ps of mo.propertySets ?? []) {
			// The original set ID is stable even when xeokit prefixes IDs for federation.
			const identifiers = ps && identifiersBySet?.get(String(ps.originalSystemId));
			for (const [index, p] of (ps?.properties ?? []).entries()) {
				if (typeof p?.name !== 'string') continue;
				// xeokit types Property.value as `any`; narrow it to unknown for our typed record.
				const identifier = identifiers?.get(index);
				properties.push({
					name: p.name,
					value: p.value as unknown,
					...(identifier ? { identifier } : {})
				});
			}
		}
		entities.push({
			id: mo.id,
			label: rootIds.has(mo.id) && modelLabel ? modelLabel : mo.name || mo.id,
			meshIds: hasGeometry ? [mo.id] : undefined,
			properties,
			type: mo.type,
			parentId: mo.parent?.id,
			hasGeometry,
			_sceneId: mo.id,
			_dotColor: color
		});
	}
	return entities;
}
