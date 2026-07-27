import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// Standalone static build. The viewer is embedded by a host application through an <iframe>
// and talks to it only over postMessage, so it is served from its own origin.
//
// VIEWER_PORT lets an external orchestrator pin the dev port. Defaults to 5273.
const port: number = Number(process.env.VIEWER_PORT ?? 5273);

// AGPL-3.0 §13 offers the source *corresponding to the running version*, so the about dialog prints the
// build's version and commit. VIEWER_COMMIT is injected by the image build (docker/Dockerfile);
// local builds fall back to 'dev'. The commit is the upstream revision recorded in the matching
// "Sync viewer source @ ..." commit of the published repository.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
	version: string;
};
const viewerCommit: string = process.env.VIEWER_COMMIT ?? 'dev';

// frame-ancestors must be an HTTP header to take effect (browsers ignore it on <meta>). Allow any
// http/https host to embed in dev; production tightens this to the concrete SPA origin at the proxy.
const cspHeaders: Record<string, string> = {
	'Content-Security-Policy': "frame-ancestors 'self' http: https:;"
};

// Serve the AGPL license at /LICENSE.txt from the single source of truth (the repo LICENSE file),
// instead of keeping a duplicate copy under public/. The viewer's about dialog links to /LICENSE.txt.
function serveLicense(): Plugin {
	let licensePath = 'LICENSE';
	const read = (): string => readFileSync(licensePath, 'utf8');
	const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
		if (req.url?.split('?')[0] === '/LICENSE.txt') {
			res.setHeader('Content-Type', 'text/plain; charset=utf-8');
			res.end(read());
			return;
		}
		next();
	};
	return {
		name: 'serve-license',
		configResolved(config): void {
			licensePath = resolve(config.root, 'LICENSE');
		},
		// Build: emit dist/LICENSE.txt from the root LICENSE.
		generateBundle(): void {
			this.emitFile({ type: 'asset', fileName: 'LICENSE.txt', source: read() });
		},
		// Dev / preview: serve /LICENSE.txt from the root LICENSE.
		configureServer(server): void {
			server.middlewares.use(middleware);
		},
		configurePreviewServer(server): void {
			server.middlewares.use(middleware);
		}
	};
}

export default defineConfig({
	base: './',
	plugins: [serveLicense()],
	define: {
		__VIEWER_VERSION__: JSON.stringify(pkg.version),
		__VIEWER_COMMIT__: JSON.stringify(viewerCommit)
	},
	server: {
		port,
		host: true,
		strictPort: true,
		headers: cspHeaders
	},
	preview: {
		port,
		host: true,
		strictPort: true,
		headers: cspHeaders
	},
	build: {
		target: 'es2022',
		outDir: 'dist',
		sourcemap: true
	}
});
