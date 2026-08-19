// Hover preview for the note tools: while `noteElement`/`notePoint` is armed, the element under the
// pointer is emphasized so the user can see what a click would anchor the note to before committing.
// Uses `entity.selected` — a channel `ViewerApp.select()` never touches — so it never fights the
// yellow `.highlighted` confirmation applied once a note is actually placed (see viewer-app.ts).

import type { Viewer } from '@xeokit/xeokit-sdk';

// Matches --primary (#0c30a3, see styles.css / measure.ts's MEASURE_COLOR), so a hovered element
// reads as "about to attach a note" rather than as a selection (yellow) or an isolate ghost (gray).
const HOVER_COLOR = [0.047, 0.188, 0.639];

export class HoverHighlight {
	private hoveredId: string | null = null;
	private active = false;

	constructor(
		private viewer: Viewer,
		canvas: HTMLCanvasElement
	) {
		viewer.scene.selectedMaterial.fill = true;
		viewer.scene.selectedMaterial.fillColor = HOVER_COLOR;
		viewer.scene.selectedMaterial.fillAlpha = 0.3;
		viewer.scene.selectedMaterial.edges = true;
		viewer.scene.selectedMaterial.edgeColor = HOVER_COLOR;
		viewer.scene.selectedMaterial.edgeAlpha = 0.9;

		viewer.scene.input.on('mousemove', (coords: number[]) => {
			if (!this.active) return;
			const hit = viewer.scene.pick({ canvasPos: coords });
			this.setHovered(hit?.entity ? String(hit.entity.id) : null);
		});
		// xeokit's input bus does not expose a typed 'mouseleave', so the canvas's own DOM event is used
		// instead (the same source measure.ts drives its own listeners from).
		canvas.addEventListener('mouseleave', () => this.clear());
	}

	/** Arm/disarm the hover preview. Disarming clears whatever is currently emphasized. */
	setActive(active: boolean): void {
		if (active === this.active) return;
		this.active = active;
		if (!active) this.clear();
	}

	clear(): void {
		this.setHovered(null);
	}

	private setHovered(sceneId: string | null): void {
		if (sceneId === this.hoveredId) return;
		if (this.hoveredId) {
			const prev = this.viewer.scene.objects[this.hoveredId];
			if (prev) prev.selected = false;
		}
		this.hoveredId = sceneId;
		if (sceneId) {
			const obj = this.viewer.scene.objects[sceneId];
			if (obj) obj.selected = true;
		}
	}
}
