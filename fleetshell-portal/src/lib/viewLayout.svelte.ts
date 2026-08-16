// Shared "editor layout" state so the split-vs-overlay toggle can live in the
// top bar (rendered by AppShell, a parent of the routed page) while the actual
// split behaviour lives in SplitPane (a child, deep in the page). A page's
// SplitPane registers here on mount; the navbar reads `active` to decide whether
// to show the toggle and `overlay` to reflect/drive the current mode.
//
// Only pages that pass `overlay` to SplitPane light this up; everything else
// leaves `active` false and the navbar control stays hidden.

export const viewLayout = $state({
	active: false, // an overlay-capable SplitPane is currently mounted
	narrow: false, // viewport is below the breakpoint (overlay is forced)
	overlay: false, // user-chosen mode: false = side-by-side, true = overlay
});

export function setViewOverlay(on: boolean): void {
	viewLayout.overlay = on;
}
