<script lang="ts">
	import { base } from '$app/paths';
</script>

<svelte:head><title>Welcome -- FleetShell Portal</title></svelte:head>

<div class="welcome-root">
	<article class="message-card">
		<h1 class="greeting">Hi there!</h1>
		<div class="body-text">
			<p>
				It looks like you are here for the first time. Please download and install the
				FleetShell client from the <a href={`${base}/support`}>Support</a> section, then
				follow the enrollment steps shown there.
			</p>
			<p>Install any additional app you might need to connect to devices.</p>
			<p class="sign-off">Your FleetShell team!</p>
		</div>
		<div class="actions">
			<a href={`${base}/support`} class="ghost-btn">Go to Support</a>
			<a href={`${base}/devices`} class="continue-btn">Continue to Devices</a>
		</div>
	</article>

	<div class="pointer-wrap" aria-hidden="true">
		<p class="pointer-text">Get started here by downloading the FleetShell client.</p>
		<svg class="pointer-svg" viewBox="0 0 200 160" xmlns="http://www.w3.org/2000/svg">
			<path d="M 185,10 C 185,90 90,148 22,148" stroke="currentColor" stroke-width="4" stroke-linecap="round" fill="none" />
			<polygon points="0,148 20,143 20,153" fill="currentColor" />
		</svg>
	</div>
</div>

<style>
	.welcome-root { max-width: 620px; }
	.message-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 32px 36px 28px; }
	.greeting { font-size: 1.5rem; font-weight: 700; color: var(--text); margin: 0 0 20px; }
	.body-text { display: flex; flex-direction: column; gap: 14px; font-size: 0.95rem; color: var(--text-muted); line-height: 1.65; margin-bottom: 28px; }
	.body-text a { color: var(--accent); text-decoration: none; }
	.body-text a:hover { text-decoration: underline; }
	.sign-off { color: var(--text-subtle); font-style: italic; }
	.actions { display: flex; gap: 10px; flex-wrap: wrap; }
	.continue-btn { display: inline-block; background: var(--accent); color: var(--on-accent); border-radius: var(--radius); padding: 9px 22px; font-size: 0.9rem; text-decoration: none; }
	.continue-btn:hover { background: var(--accent-hover); }
	.ghost-btn { display: inline-block; background: var(--surface-2); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 9px 22px; font-size: 0.9rem; text-decoration: none; }
	.ghost-btn:hover { background: var(--surface-active); }

	/* Fixed curved pointer aimed at the Support icon in the left rail. The
	   arrowhead tip is at the SVG's left edge (x=0); tweak bottom/left to align. */
	.pointer-wrap {
		position: fixed;
		bottom: 100px;
		left: 90px;
		color: var(--accent);
		pointer-events: none;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
	}
	.pointer-text { font-size: 1rem; font-weight: 500; margin: 0; white-space: nowrap; }
	.pointer-svg { width: 80px; height: 80px; display: block; }
</style>
