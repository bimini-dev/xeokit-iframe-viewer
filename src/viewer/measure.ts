// Distance measuring: the user clicks a start point, then a target point. The length is shown live
// while the target follows the pointer, and the finished segment stays on screen until the next
// click clears it (that click starts nothing — the model is left clean).
//
// Built on xeokit's DistanceMeasurementsPlugin, whose mouse control snaps the pointer to the nearest
// vertex/edge: a raw surface pick lands wherever the ray happens to cross a triangle, which is far
// too imprecise to measure a building element with.

import {
	DistanceMeasurementsPlugin,
	DistanceMeasurementsMouseControl,
	type DistanceMeasurement,
	type Viewer
} from '@xeokit/xeokit-sdk';
import type { ModelUnit } from '../protocol';

// Matches --primary in styles.css, so the segment reads as an app affordance, not as geometry.
const MEASURE_COLOR = '#0c30a3';
// Pointer travel (px) above which a mouse-up is a camera drag rather than a click. Mirrors the
// tolerance the SDK's mouse control applies to its own point placement, so orbiting the model never
// counts as the click that clears a finished measurement.
const CLICK_TOLERANCE_PX = 20;

// Metres per world unit for each model unit — how a raw world-space length becomes a real length.
const METRES_PER_WORLD_UNIT: Record<ModelUnit, number> = {
	mm: 0.001,
	cm: 0.01,
	m: 1
};

// The label picks its own unit from the magnitude, so a door reveal and a site boundary are both
// readable: below 10 mm show millimetres, below 100 cm show centimetres, otherwise metres. Every
// unit is written to the same number of decimals, so the label's width stays predictable.
const MM_LABEL_LIMIT = 10;
const CM_LABEL_LIMIT = 100;
const LABEL_DECIMALS = 2;

export class DistanceMeasure {
	private plugin: DistanceMeasurementsPlugin;
	private control: DistanceMeasurementsMouseControl;
	/** The finished segment on screen, if any. Only ever one — the next click clears it. */
	private completed: DistanceMeasurement | null = null;
	/** True for the duration of the click that finished a measurement, so it isn't cleared at once. */
	private justCompleted = false;
	private active = false;
	/** How to read the model's coordinates. Metres matches the usual convention for our formats. */
	private modelUnit: ModelUnit = 'm';
	private downX = 0;
	private downY = 0;

	constructor(
		viewer: Viewer,
		private canvas: HTMLCanvasElement
	) {
		this.plugin = new DistanceMeasurementsPlugin(viewer, {
			defaultColor: MEASURE_COLOR,
			// Only the direct point-to-point segment and its length label — the axis-aligned wires and
			// their X/Y/Z component labels are noise for a plain "distance between two points".
			defaultAxisVisible: false
		});
		this.control = new DistanceMeasurementsMouseControl(this.plugin, { snapping: true });

		this.plugin.on('measurementStart', (measurement: DistanceMeasurement): void => {
			measurement.labelStringFormat = this.formatLength;
			// The click after a finished measurement only clears it. The control has no such mode, so it
			// has already begun a new measurement on this click — cancel that along with the old one.
			if (this.completed) this.clear();
		});
		this.plugin.on('measurementEnd', (measurement: DistanceMeasurement): void => {
			this.completed = measurement;
			this.justCompleted = true;
		});
	}

	/** Enter/leave measuring. Leaving discards the segment and any measurement in progress. */
	setActive(active: boolean): void {
		if (active === this.active) return;
		this.active = active;
		if (active) {
			this.control.activate();
			this.canvas.addEventListener('mousedown', this.onMouseDown);
			this.canvas.addEventListener('click', this.onClick);
			return;
		}
		this.canvas.removeEventListener('mousedown', this.onMouseDown);
		this.canvas.removeEventListener('click', this.onClick);
		this.control.deactivate(); // also destroys a measurement under construction
		this.clear();
		// The control switches the cursor to a pointer while hovering pickable surfaces; hand the
		// canvas back in its default state.
		this.canvas.style.cursor = '';
	}

	/**
	 * Set how the model's coordinates are read. Re-assigning the formatter on the measurement already
	 * on screen re-runs its label with the new interpretation (the setter triggers a redraw), so the
	 * user sees the corrected distance without re-measuring.
	 */
	setModelUnit(unit: ModelUnit): void {
		if (unit === this.modelUnit) return;
		this.modelUnit = unit;
		const live = this.control.currentMeasurement ?? this.completed;
		if (live) live.labelStringFormat = this.formatLength;
	}

	/** Remove the finished segment and anything under construction (model reload, axis switch, …). */
	clear(): void {
		this.justCompleted = false;
		if (this.control.currentMeasurement) this.control.reset();
		if (!this.completed) return;
		this.plugin.destroyMeasurement(this.completed.id);
		this.completed = null;
	}

	/**
	 * Bare length label, e.g. `3.79 m` — no `~`/`=` prefix, unlike the SDK's own format, which flags
	 * every measurement as approximate even when both ends snapped exactly to the geometry. The world
	 * length is converted to a real length via the model unit, then labelled in whichever unit reads
	 * best at that magnitude.
	 */
	private formatLength = (length: number): string => {
		const metres = length * METRES_PER_WORLD_UNIT[this.modelUnit];
		const mm = metres * 1000;
		if (mm < MM_LABEL_LIMIT) return `${mm.toFixed(LABEL_DECIMALS)} mm`;
		const cm = metres * 100;
		if (cm < CM_LABEL_LIMIT) return `${cm.toFixed(LABEL_DECIMALS)} cm`;
		return `${metres.toFixed(LABEL_DECIMALS)} m`;
	};

	private onMouseDown = (event: MouseEvent): void => {
		if (event.button !== 0) return;
		this.downX = event.clientX;
		this.downY = event.clientY;
		// Scope the flag to this one press→release→click cycle: `measurementEnd` can only fire later in
		// the same cycle, so it can never leak into a subsequent click and swallow its clear.
		this.justCompleted = false;
	};

	// Clearing the finished segment is handled here rather than in `measurementStart` alone, because
	// the SDK's control ignores a click that lands on empty space — and that click must clear too.
	private onClick = (event: MouseEvent): void => {
		if (event.button !== 0) return;
		if (
			Math.abs(event.clientX - this.downX) > CLICK_TOLERANCE_PX ||
			Math.abs(event.clientY - this.downY) > CLICK_TOLERANCE_PX
		) {
			return; // a camera drag, not a click
		}
		// The click that placed the second point must not also clear what it just created.
		if (this.justCompleted) {
			this.justCompleted = false;
			return;
		}
		if (this.completed && !this.control.currentMeasurement) this.clear();
	};
}
