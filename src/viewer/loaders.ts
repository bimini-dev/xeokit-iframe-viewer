// Geometry loaders ported from the V7 reference (buildJsonModel / XKT metadata). Input is an
// in-memory ArrayBuffer/text received over postMessage instead of a File from an <input>.

import { SceneModel, type MetaScene, type Scene } from '@xeokit/xeokit-sdk';
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
			properties: entity.properties,
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
export function buildXktEntityList(
	metaScene: MetaScene,
	scene: Scene,
	smId: string,
	color: number[]
): EntityRecord[] {
	const metaModel = metaScene.metaModels[smId];
	const metaObjs = metaModel ? Object.values(metaModel.metaObjects) : [];
	const entities: EntityRecord[] = [];
	for (const mo of metaObjs) {
		// Keep structural/group metaobjects (no geometry of their own) so the host can render the
		// full model hierarchy; they're flagged hasGeometry:false and carry no meshIds.
		const hasGeometry = !!scene.objects[mo.id];
		const properties: Record<string, unknown> = {};
		for (const ps of mo.propertySets ?? []) {
			for (const p of ps.properties ?? []) {
				// xeokit types Property.value as `any`; narrow it to unknown for our typed record.
				if (p && p.name !== undefined) properties[p.name] = p.value as unknown;
			}
		}
		entities.push({
			id: mo.id,
			label: mo.name || mo.id,
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
