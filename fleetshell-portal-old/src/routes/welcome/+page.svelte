<script lang="ts">
	import AppShell        from '$lib/components/AppShell.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Welcome — FleetShell Portal</title></svelte:head>

<AppShell user={data.user}>
	<div class="welcome-root">

		<!-- ── Message card ─────────────────────────────────────────── -->
		<article class="message-card">
			<h1 class="greeting">Hi there!</h1>
			<div class="body-text">
				<p>
					It seems you are here for the first time. Please make sure
					to download and install the FleetShell client app from the
					<a href="/support"><strong>Support</strong></a> section of the sidebar.
				</p>
				<p>
					Install any additional app that you might need to connect
					to devices.
				</p>
				<p class="sign-off">Your FleetShell team!</p>
			</div>
			<a href="/devices" class="continue-btn">Continue to Devices →</a>
		</article>

	</div>
</AppShell>

<!--
	Fixed pointer: always visible at the bottom-left regardless of scroll.
	Tip offset from viewport bottom:
	  sidebar bottom-pad 8 + Settings 34 + Support-bottom-pad 9
	  + Support half-height 8 − arrowhead centre 5  =  54 px

	SVG viewBox 0 0 200 160 — tip at y=148, bottom of SVG at y=160
	  → tip is 12 px above SVG bottom
	  → wrapper bottom = 54 − 12 = 42 px

	left: 196 px places the SVG's left edge (x=0 = arrowhead tip)
	exactly at the sidebar/main boundary.
-->
<div class="pointer-wrap" aria-hidden="true">
	<p class="pointer-text">Get started here by downloading the FleetShell client.</p>

	<svg class="pointer-svg"
	     viewBox="0 0 200 160"
	     xmlns="http://www.w3.org/2000/svg">

		<!--
			Cubic Bézier:
			  start   (185, 10)  — top-right; tangent initially straight DOWN
			  CP1     (185, 90)  — pulls the first half downward
			  CP2     ( 90,148)  — pulls the second half from the right so the
			                       curve arrives at the endpoint going LEFT
			  end     ( 22,148)  — where the round cap meets the arrowhead base
		-->
		<path
			d="M 185,10 C 185,90 90,148 22,148"
			stroke="currentColor"
			stroke-width="4"
			stroke-linecap="round"
			fill="none"
		/>

		<!--
			Left-pointing arrowhead (10 px tall, centred on y=148).
			Tip at x=0, base at x=20.  The round stroke-cap on the path
			(4 px → 2 px radius) bridges the 2 px gap to the base.
		-->
		<polygon points="0,148 20,143 20,153" fill="currentColor"/>

	</svg>
</div>

<style>
	/* ── Welcome content ────────────────────────────────────────────── */
	.welcome-root {
		max-width : 560px;
	}

	.message-card {
		background    : var(--bg0);
		border        : 1px solid var(--bg2);
		border-radius : 4px;
		padding       : 32px 36px 28px;
	}

	.greeting {
		font-size     : 1.5rem;
		font-weight   : 700;
		color         : var(--fg1);
		margin-bottom : 20px;
	}

	.body-text {
		display        : flex;
		flex-direction : column;
		gap            : 14px;
		font-size      : 0.95rem;
		color          : var(--fg2);
		line-height    : 1.65;
		margin-bottom  : 28px;
	}
	.body-text a             { color: var(--bright-aqua); text-decoration: none; }
	.body-text a:hover       { text-decoration: underline; }

	.sign-off {
		color      : var(--fg3);
		font-style : italic;
	}

	.continue-btn {
		display         : inline-block;
		background      : var(--blue);
		color           : var(--fg0);
		border-radius   : 3px;
		padding         : 9px 22px;
		font-family     : inherit;
		font-size       : 0.9rem;
		text-decoration : none;
		transition      : background 0.15s;
	}
	.continue-btn:hover { background: var(--bright-blue); text-decoration: none; }

	/* ── Fixed curved-arrow pointer ─────────────────────────────────── */
	.pointer-wrap {
		position       : fixed;
		bottom         : 56px;
		left           : 120px;
		color          : var(--bright-yellow);
		pointer-events : none;
		display        : flex;
		flex-direction : column;
		align-items    : flex-start;
		gap            : 2px;
	}

	.pointer-text {
		font-size   : 1rem;
		font-weight : 500;
		margin      : 0;
		white-space : nowrap;
	}

	.pointer-svg {
		width  : 80px;
		height : 80px;
		display: block;
	}
</style>
