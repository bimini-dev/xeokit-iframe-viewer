// postMessage transport for the viewer side of the boundary. Validates origin + envelope,
// dispatches host→viewer messages into the ViewerApp, and emits viewer→host messages.

import {
	isEnvelope,
	wrap,
	PROTOCOL_VERSION,
	type HostToViewerMessage,
	type ViewerToHostMessage
} from './protocol';
import type { ViewerApp } from './viewer/viewer-app';

/**
 * The host origin the viewer trusts. The host app appends `?host=<its-origin>` to the iframe src.
 * When absent (standalone dev), we fall back to '*' with a console warning — never do that in
 * production, which is why the host always sets it.
 */
function resolveHostOrigin(): string {
	const param = new URLSearchParams(location.search).get('host');
	if (param) {
		try {
			return new URL(param).origin;
		} catch {
			/* fall through */
		}
	}
	// Fail closed in production builds: a deployed viewer is always framed by a host that sets ?host
	// origin, so a missing one means a misconfiguration (or an attempt to drive the viewer directly).
	// Return a sentinel that can never equal a real event.origin, so onMessage rejects every message.
	if (import.meta.env.PROD) {
		console.error(
			'[viewer] ?host origin missing — refusing all messages (misconfigured deployment).'
		);
		return '\0no-host';
	}
	console.warn(
		'[viewer] No ?host origin supplied — accepting messages from any origin (dev only).'
	);
	return '*';
}

export class ViewerBridge {
	private hostOrigin = resolveHostOrigin();
	private target: Window = window.parent;

	constructor(private app: ViewerApp) {
		window.addEventListener('message', this.onMessage);
	}

	/** Announce readiness; the host waits for this before sending loadModel. */
	start(): void {
		this.emit({ type: 'ready', protocolVersion: PROTOCOL_VERSION });
	}

	emit(payload: ViewerToHostMessage): void {
		if (!this.target || this.target === window) return;
		this.target.postMessage(wrap(payload), this.hostOrigin);
	}

	private onMessage = (event: MessageEvent): void => {
		if (this.hostOrigin !== '*' && event.origin !== this.hostOrigin) return;
		if (!isEnvelope(event.data)) return;
		const payload = event.data.payload as HostToViewerMessage;
		// Lock onto the exact window/origin that greeted us (defends against multiple embedders).
		if (event.source && this.target !== event.source) this.target = event.source as Window;
		if (this.hostOrigin === '*') this.hostOrigin = event.origin;
		this.dispatch(payload);
	};

	private dispatch(msg: HostToViewerMessage): void {
		switch (msg.type) {
			case 'init':
				// The host sends this on iframe load. Re-announce readiness so a 'ready' that raced ahead
				// of the host attaching its listener is not lost.
				this.emit({ type: 'ready', protocolVersion: PROTOCOL_VERSION });
				break;
			case 'loadModel':
				void this.app.loadModel(msg.bytes, msg.format, msg.name);
				break;
			case 'setCommentMarkers':
				this.app.setCommentMarkers(msg.markers);
				break;
			case 'focusElement':
				this.app.focusElement(msg.elementId, msg.memberIds);
				break;
			case 'setCamera':
				this.app.setCamera(msg.camera);
				break;
			case 'selectElement':
				this.app.selectElement(msg.elementId, msg.memberIds);
				break;
			case 'clearModel':
				this.app.clearModel();
				break;
			case 'zoom':
				this.app.zoomStep(msg.direction);
				break;
			case 'setUpAxis':
				this.app.setUpAxis(msg.axis);
				break;
			case 'isolateElement':
				this.app.isolateElements(msg.elementIds);
				break;
			default: {
				const _exhaustive: never = msg;
				void _exhaustive;
			}
		}
	}
}
