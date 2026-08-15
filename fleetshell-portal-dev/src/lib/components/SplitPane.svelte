<!--
	Reusable horizontal split view with a draggable gutter. Left + right are
	snippets; the divider position is clamped and persisted to localStorage under
	`storageKey`, so a user can size it once and it sticks. Both panes are
	full-height flex columns (min-height:0) so internal scroll regions work.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { browser } from '$app/environment';

	let {
		left,
		right,
		storageKey,
		defaultLeft = 30,
		min = 15,
		max = 60,
	}: {
		left: Snippet;
		right: Snippet;
		storageKey: string;
		defaultLeft?: number;
		min?: number;
		max?: number;
	} = $props();

	const initial = (() => {
		if (!browser) return defaultLeft;
		const v = Number(localStorage.getItem(`split:${storageKey}`));
		return Number.isFinite(v) && v >= min && v <= max ? v : defaultLeft;
	})();

	let leftPct = $state(initial);
	let root: HTMLDivElement;
	let dragging = $state(false);

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

<div class="split" bind:this={root} class:dragging>
	<div class="pane" style="flex: 0 0 {leftPct}%">{@render left()}</div>
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
	<div class="pane right">{@render right()}</div>
</div>

<style>
	.split { display: flex; flex: 1; min-height: 0; align-items: stretch; }
	.pane { min-width: 0; display: flex; flex-direction: column; min-height: 0; }
	.pane.right { flex: 1 1 0; overflow-y: auto; }
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

	@media (max-width: 75rem) {
		.split { flex-direction: column; }
		.pane { flex: none !important; }
		.gutter { display: none; }
	}
</style>
