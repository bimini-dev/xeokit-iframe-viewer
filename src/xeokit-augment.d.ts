// xeokit-sdk ships incomplete type definitions: several real runtime members of `Scene` are absent
// from its `.d.ts`. We add just the ones this viewer uses so the typed `Viewer`/`Scene` chain
// compiles without scattering `as` casts through the code. Extend this as more gaps surface.
import '@xeokit/xeokit-sdk';

declare module '@xeokit/xeokit-sdk' {
	interface Scene {
		/** When true, renders both faces of every surface. */
		backfaces: boolean;
		/** Forces an immediate re-render of the scene. */
		glRedraw(): void;
	}
}
