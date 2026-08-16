<!--
	Reusable horizontal split view with a draggable gutter. Left + right are
	snippets; the divider position is clamped and persisted to localStorage under
	`storageKey`, so a user can size it once and it sticks. Both panes are
	full-height flex columns (min-height:0) so internal scroll regions work.

	Overlay mode (opt-in via `overlay`): on narrow viewports (below the breakpoint)
	OR when the user consciously flips the top-bar toggle, the right pane is lifted
	out of the flow and drawn as a full-width panel over the left list, with a
	Back bar (navigates to `closeHref`). The list stays mounted underneath so the
	user keeps their place. `overlayActive` tells us whether the right pane
	currently holds a selection/new-item worth overlaying.

	The split-vs-overlay control does NOT live here -- it lives in the top bar
	(AppShell) via the shared `viewLayout` store, which this component registers
	with while mounted. That keeps the control at a fixed, predictable spot
	instead of floating over the panes.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { browser } from '$app/environment';
	import { viewLayout } from '$lib/viewLayout.svelte';

	let {
		left,
		right,
		storageKey,
		defaultLeft = 30,
		min = 15,
		max = 60,
		overlay = false,
		overlayActive = false,
		closeHref = '',
	}: {
		left: Snippet;
		right: Snippet;
		storageKey: string;
		defaultLeft?: number;
		min?: number;
		max?: number;
		overlay?: boolean;
		overlayActive?: boolean;
		closeHref?: string;
	} = $props();

	const initial = (() => {
		if (!browser) return defaultLeft;
		const v = Number(localStorage.getItem(`split:${storageKey}`));
		return Number.isFinite(v) && v >= min && v <= max ? v : defaultLeft;
	})();

	let leftPct = $state(initial);
	let root: HTMLDivElement;
	let dragging = $state(false);

	// Register with the shared store while mounted: seed the user's persisted
	// mode, track the breakpoint, and expose `active` so the navbar shows its
	// toggle. Tear it all down on unmount.
	$effect(() => {
		if (!overlay) return;
		viewLayout.overlay = localStorage.getItem(`splitmode:${storageKey}`) === 'overlay';
		viewLayout.active = true;
		const mq = window.matchMedia('(max-width: 73.5rem)');
		viewLayout.narrow = mq.matches;
		const on = (e: MediaQueryListEvent) => (viewLayout.narrow = e.matches);
		mq.addEventListener('change', on);
		return () => {
			mq.removeEventListener('change', on);
			viewLayout.active = false;
			viewLayout.narrow = false;
		};
	});

	// Persist the user's choice whenever it flips (navbar drives viewLayout.overlay).
	$effect(() => {
		if (!overlay || !browser) return;
		localStorage.setItem(`splitmode:${storageKey}`, viewLayout.overlay ? 'overlay' : 'split');
	});

	// Compact = draw the right pane as an overlay rather than a side-by-side column.
	const compact = $derived(overlay && (viewLayout.overlay || viewLayout.narrow));
	const overlayShown = $derived(compact && overlayActive);

	function onDown(e: PointerEvent) {
		dragging = true;
		(e.target as HTMLElement).setPointerCapture(e.pointerId);
	}
	function onMove(e: PointerEvent) {
		if (!dragging || !root) return;
		const r = root.getBoundingClientRect();
		const pct = ((e.clientX - r.left) / r.width) * 100;
		leftPct = Math.min(max, Math.max(min, pct));
	}
	function onUp(e: PointerEvent) {
		if (!dragging) return;
		dragging = false;
		(e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
		if (browser) localStorage.setItem(`split:${storageKey}`, String(Math.round(leftPct)));
	}
</script>

<div class="split" bind:this={root} class:dragging class:compact class:overlay-shown={overlayShown}>
	<div class="pane" style="flex: 0 0 {leftPct}%">{@render left()}</div>
	{#if !compact}
		<div
			class="gutter"
			role="separator"
			aria-orientation="vertical"
			aria-valuenow={Math.round(leftPct)}
			tabindex="-1"
			onpointerdown={onDown}
			onpointermove={onMove}
			onpointerup={onUp}
		></div>
	{/if}
	<div class="pane right">
		{#if overlayShown}
			<div class="overlay-head">
				<a class="ohd-back" href={closeHref}>&lsaquo; Back</a>
			</div>
		{/if}
		{@render right()}
	</div>
</div>

<style>
	.split { display: flex; flex: 1; min-height: 0; align-items: stretch; position: relative; }
	.pane { min-width: 0; display: flex; flex-direction: column; min-height: 0; }
	.pane.right { flex: 1 1 0; overflow-y: auto; padding: 3px 6px; }
	.gutter {
		flex: 0 0 auto; width: 11px; margin: 0 0.3rem; cursor: col-resize;
		position: relative; touch-action: none; align-self: stretch;
	}
	.gutter::before {
		content: ''; position: absolute; top: 0; bottom: 0; left: 50%; transform: translateX(-50%);
		width: 1px; background: var(--divider); transition: background 0.1s, width 0.1s;
	}
	.gutter:hover::before, .split.dragging .gutter::before { width: 3px; background: var(--accent); }
	.split.dragging { user-select: none; cursor: col-resize; }

	/* Overlay mode: left list goes full-width; right pane is hidden until active. */
	.split.compact .pane { flex: 1 1 100% !important; }
	.split.compact:not(.overlay-shown) .pane.right { display: none; }
	.split.overlay-shown .pane.right {
		position: absolute; inset: 0; z-index: 3; width: 100%;
		background: var(--bg-app); overflow-y: auto;
	}
	.overlay-head {
		position: sticky; top: 0; z-index: 1;
		display: flex; align-items: center; padding: 0 0 0.6rem;
		background: var(--bg-app);
	}
	.ohd-back {
		color: var(--accent); text-decoration: none; font-size: 0.86rem; font-weight: 600;
		padding: 0.35rem 0.55rem; border-radius: var(--radius); background: var(--surface);
		border: 1px solid var(--border);
	}
	.ohd-back:hover { background: var(--surface-2); }

	/* Fallback for browsers without JS-driven `compact`: still collapse below the
	   breakpoint. When `overlay` is used this rule is superseded by `.compact`. */
	@media (max-width: 73.5rem) {
		.split:not(.compact) { flex-direction: column; }
		.split:not(.compact) .pane { flex: none !important; }
		.split:not(.compact) .gutter { display: none; }
		/* Stacked: the right pane sits below the list -- give a clear divider + gap
		   so the two do not flow into each other (the gutter is hidden here). */
		.split:not(.compact) .pane.right {
			margin-top: 0.9rem; padding-top: 0.9rem;
			border-top: 4px solid color-mix(in srgb, var(--border) 50%, transparent);
		}
	}
</style>
