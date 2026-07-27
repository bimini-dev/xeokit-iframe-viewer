import './styles.css';
import { ViewerApp } from './viewer/viewer-app';
import { ViewerBridge } from './bridge';
import { applyStaticI18n } from './i18n';
import type { ModelFormat } from './protocol';

applyStaticI18n();

const canvas = document.getElementById('xeoCanvas') as HTMLCanvasElement;

const bridge: { ref?: ViewerBridge } = {};

const app = new ViewerApp(
	{ canvas },
	{
		onModelLoaded: (name, elements, aabb) =>
			bridge.ref?.emit({ type: 'modelLoaded', name, elements, aabb }),
		onLoadError: (message) => bridge.ref?.emit({ type: 'loadError', message }),
		onElementSelected: (elementId, label, worldPos, camera, properties) =>
			bridge.ref?.emit({ type: 'elementSelected', elementId, label, worldPos, camera, properties }),
		onCommentMarkerClicked: (elementId, camera) =>
			bridge.ref?.emit({ type: 'commentMarkerClicked', elementId, camera }),
		onCameraChanged: (camera) => bridge.ref?.emit({ type: 'cameraChanged', camera }),
		onZoomChanged: (percent) => bridge.ref?.emit({ type: 'zoomChanged', percent })
	}
);

bridge.ref = new ViewerBridge(app);
bridge.ref.start();

// ── About / license dialog (AGPL notices) ──────────────────────────────────────
const aboutVersion = document.getElementById('aboutVersion');
if (aboutVersion) {
	aboutVersion.textContent = `v${__VIEWER_VERSION__} · build ${__VIEWER_COMMIT__.slice(0, 12)}`;
}

const aboutOverlay = document.getElementById('aboutOverlay');
document.getElementById('btnAbout')?.addEventListener('click', () => {
	if (aboutOverlay) aboutOverlay.hidden = false;
});
document.getElementById('btnAboutClose')?.addEventListener('click', () => {
	if (aboutOverlay) aboutOverlay.hidden = true;
});
aboutOverlay?.addEventListener('click', (e) => {
	if (e.target === aboutOverlay) aboutOverlay.hidden = true;
});

// ── Dev-only local file fallback (?dev) ─────────────────────────────────────────
if (new URLSearchParams(location.search).has('dev')) {
	const detectFormat = (name: string): ModelFormat | null => {
		const n = name.toLowerCase();
		if (n.endsWith('.xkt')) return 'xkt';
		if (n.endsWith('.json')) return 'json';
		return null;
	};
	const loadLocal = async (file: File): Promise<void> => {
		const format = detectFormat(file.name);
		if (!format) return;
		await app.loadModel(await file.arrayBuffer(), format, file.name);
	};
	const input = document.getElementById('devFileInput') as HTMLInputElement | null;
	input?.addEventListener('change', async (e) => {
		const files = Array.from((e.target as HTMLInputElement).files ?? []);
		for (const f of files) await loadLocal(f);
		(e.target as HTMLInputElement).value = '';
	});
	document.body.addEventListener('dragover', (e) => e.preventDefault());
	document.body.addEventListener('drop', async (e) => {
		e.preventDefault();
		for (const f of Array.from(e.dataTransfer?.files ?? [])) await loadLocal(f);
	});
	document.getElementById('devBar')?.classList.remove('hidden');
}
