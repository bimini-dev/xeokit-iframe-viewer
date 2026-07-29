// Comment markers: colored, clickable pins the host asks us to render on elements that have
// comments. Implemented with xeokit's AnnotationsPlugin (DOM markers pinned to world positions,
// with occlusion culling). A marker click is reported back to the host, which opens the comment
// in its own (out-of-iframe) sidepanel.

import { AnnotationsPlugin, type Viewer } from '@xeokit/xeokit-sdk';
import { t } from '../i18n';

/** A marker whose world anchor has already been resolved by ViewerApp. */
export interface ResolvedMarker {
	/** Identity of this marker, reported back on click. Several markers may share one element. */
	id: string;
	/** The element the marker is pinned to; null for a marker anchored purely in space. */
	elementId: string | null;
	worldPos: [number, number, number];
}

// `{{markerId}}` / `{{elementId}}` are filled per-annotation from `values` (AnnotationsPlugin uses
// {{...}} templating). The marker id identifies the clicked pin; the element id is what the selected
// state is toggled by, so selecting an element lights up every pin sitting on it.
function buildMarkerHtml(): string {
	return (
		'<div class="comment-marker" data-comment-id="{{markerId}}" data-comment-el="{{elementId}}" ' +
		`title="${t('marker.showComment')}">` +
		'<div class="comment-marker-dot"></div>' +
		'</div>'
	);
}

export class CommentMarkers {
	private plugin: AnnotationsPlugin;
	// annotationId → the marker's identity and the element it belongs to (null when purely spatial)
	private byAnnotationId = new Map<string, { id: string; elementId: string | null }>();
	private selectedElementId: string | null = null;

	constructor(viewer: Viewer, onMarkerClicked: (id: string, elementId: string | null) => void) {
		this.plugin = new AnnotationsPlugin(viewer, {
			markerHTML: buildMarkerHtml(),
			values: {}
		});
		this.plugin.on('markerClicked', (annotation) => {
			const marker = this.byAnnotationId.get(annotation.id);
			if (marker) onMarkerClicked(marker.id, marker.elementId);
		});
	}

	/** Replace all current markers with the supplied, pre-resolved set. */
	set(markers: ResolvedMarker[]): void {
		this.clear();
		for (const marker of markers) {
			const annotationId = 'comment-' + marker.id;
			this.plugin.createAnnotation({
				id: annotationId,
				worldPos: marker.worldPos,
				// Always visible: an anchor sitting on a surface (or at the AABB centre) is otherwise judged
				// occluded by that very geometry and culled, so the "has a comment" dot would never show.
				occludable: false,
				markerShown: true,
				labelShown: false,
				values: { markerId: marker.id, elementId: marker.elementId ?? '' }
			});
			this.byAnnotationId.set(annotationId, { id: marker.id, elementId: marker.elementId });
		}
		// Recreated markers lost their selected class — reapply the current selection.
		this.applySelection();
	}

	/** Colour the marker for `elementId` as selected (primary); pass null to clear. */
	setSelected(elementId: string | null): void {
		this.selectedElementId = elementId;
		this.applySelection();
	}

	private applySelection(): void {
		document.querySelectorAll<HTMLElement>('.comment-marker').forEach((el: HTMLElement) => {
			const selected =
				this.selectedElementId !== null && el.dataset.commentEl === this.selectedElementId;
			el.classList.toggle('selected', selected);
		});
	}

	clear(): void {
		for (const annotationId of this.byAnnotationId.keys()) {
			try {
				this.plugin.destroyAnnotation(annotationId);
			} catch {
				/* already gone */
			}
		}
		this.byAnnotationId.clear();
	}
}
