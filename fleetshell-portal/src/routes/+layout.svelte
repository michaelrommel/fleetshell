<script lang="ts">
	import '../app.css';
	import { navigating } from '$app/state';
	let { children } = $props();

	// Global navigation progress bar. Lives in the ROOT layout so it is mounted on
	// every page (login, select-persona, and the whole (app) group), which is why
	// it can cover a persona switch -> /devices navigation even though those pages
	// are in different layout groups. Any client-side navigation (links, or an
	// enhanced form that follows a redirect) sets `navigating.to`; a 150ms delay
	// suppresses the flash on fast (warm-cache) navigations.
	let showNav = $state(false);
	$effect(() => {
		if (!navigating.to) { showNav = false; return; }
		const t = setTimeout(() => (showNav = true), 150);
		return () => clearTimeout(t);
	});
</script>

{#if showNav}
	<div class="nav-progress" role="progressbar" aria-label="Loading" aria-busy="true"></div>
{/if}

{@render children()}

<style>
	/* Indeterminate top progress bar (GitHub/YouTube style): a segment sweeps
	   left-to-right while a navigation's server load is in flight. z-index sits
	   above app overlays/modals so it stays visible during a slow load. */
	.nav-progress {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		height: 3px;
		z-index: 100000;
		overflow: hidden;
		background: color-mix(in srgb, var(--accent) 22%, transparent);
	}
	.nav-progress::before {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		width: 35%;
		background: var(--accent);
		animation: nav-sweep 0.9s ease-in-out infinite;
	}
	@keyframes nav-sweep {
		0%   { left: -35%; }
		100% { left: 100%; }
	}
</style>
