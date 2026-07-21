<!--
	Shared application shell: top bar + left sidebar.
	Used by src/routes/(app)/+layout.svelte  AND  src/routes/welcome/+page.svelte.
	Keeping it as a component avoids duplicating markup and ensures the sidebar
	stays in sync no matter which route renders it.
-->
<script lang="ts">
	import { page }         from '$app/state';
	import type { Snippet } from 'svelte';

	let { user, children }: { user: string; children: Snippet } = $props();

	function active(href: string): boolean {
		return page.url.pathname === href || page.url.pathname.startsWith(href + '/');
	}
</script>

<div class="shell">

	<!-- ── Top bar ─────────────────────────────────────────────────────── -->
	<header class="topbar">
		<div class="brand">
			<span class="brand-fleet">Fleet</span><span class="brand-shell">Shell</span>
			<span class="brand-sub">Portal</span>
		</div>

		<div class="user-area">
			<span class="username">{user}</span>
			<form method="POST" action="/logout">
				<button type="submit" class="btn-secondary">Sign Out</button>
			</form>
		</div>
	</header>

	<!-- ── Body ──────────────────────────────────────────────────────────  -->
	<div class="body">

		<nav class="sidebar" aria-label="Main navigation">

			<div class="nav-top">
				<a href="/devices" class="nav-item" class:nav-active={active('/devices')}>
					<!-- Server / rack icon -->
					<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
					     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<rect x="2" y="2" width="20" height="8" rx="2"/>
						<rect x="2" y="14" width="20" height="8" rx="2"/>
						<line x1="6" y1="6"  x2="6.01" y2="6"/>
						<line x1="6" y1="18" x2="6.01" y2="18"/>
					</svg>
					<span>Devices</span>
				</a>

				<a href="/administration" class="nav-item" class:nav-active={active('/administration')}>
					<!-- Users / group icon -->
					<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
					     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
						<circle cx="9" cy="7" r="4"/>
						<path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
						<path d="M16 3.13a4 4 0 0 1 0 7.75"/>
					</svg>
					<span>Administration</span>
				</a>
			</div>

			<div class="nav-bottom">
				<a href="/support" class="nav-item" class:nav-active={active('/support')}>
					<!-- Download / tray icon -->
					<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
					     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
						<polyline points="7 10 12 15 17 10"/>
						<line x1="12" y1="15" x2="12" y2="3"/>
					</svg>
					<span>Support</span>
				</a>

				<a href="/settings" class="nav-item" class:nav-active={active('/settings')}>
					<!-- Gear icon -->
					<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
					     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<circle cx="12" cy="12" r="3"/>
						<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83
						         2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1
						         1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65
						         0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65
						         0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65
						         1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1
						         2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0
						         1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65
						         0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65
						         0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65
						         1.65 0 0 0-1.51 1z"/>
					</svg>
					<span>Settings</span>
				</a>
			</div>

		</nav>

		<!-- ── Page content ──────────────────────────────────────────── -->
		<main class="main">
			{@render children()}
		</main>

	</div>
</div>

<style>
	/* ── Shell ──────────────────────────────────────────────────────── */
	.shell {
		display        : flex;
		flex-direction : column;
		height         : 100vh;
		overflow       : hidden;
		background     : var(--bg-hard);
	}

	/* ── Top bar ────────────────────────────────────────────────────── */
	.topbar {
		display         : flex;
		align-items     : center;
		justify-content : space-between;
		padding         : 0 20px;
		height          : 48px;
		background      : var(--bg0);
		border-bottom   : 1px solid var(--bg2);
		flex-shrink     : 0;
		z-index         : 10;
	}

	.brand {
		font-size      : 1.1rem;
		font-weight    : 700;
		letter-spacing : -0.01em;
		display        : flex;
		align-items    : baseline;
		gap            : 5px;
	}
	.brand-fleet { color: var(--fg1); }
	.brand-shell { color: var(--bright-aqua); }
	.brand-sub   {
		font-size      : 0.65rem;
		text-transform : uppercase;
		letter-spacing : 0.18em;
		color          : var(--fg4);
		font-weight    : 400;
	}

	.user-area {
		display     : flex;
		align-items : center;
		gap         : 14px;
	}
	.username {
		font-size : 0.85rem;
		color     : var(--fg4);
	}

	/* ── Body row ───────────────────────────────────────────────────── */
	.body {
		display  : flex;
		flex     : 1;
		overflow : hidden;
	}

	/* ── Sidebar ────────────────────────────────────────────────────── */
	.sidebar {
		width           : 196px;
		flex-shrink     : 0;
		display         : flex;
		flex-direction  : column;
		justify-content : space-between;
		background      : var(--bg0);
		border-right    : 1px solid var(--bg2);
		overflow-y      : auto;
		padding         : 8px 0;
	}

	.nav-top, .nav-bottom {
		display        : flex;
		flex-direction : column;
	}

	.nav-item {
		display        : flex;
		align-items    : center;
		gap            : 10px;
		padding        : 9px 16px;
		color          : var(--fg3);
		text-decoration: none;
		font-size      : 0.9rem;
		border-left    : 3px solid transparent;
		transition     : background 0.1s, color 0.1s, border-color 0.1s;
		user-select    : none;
	}
	.nav-item:hover {
		background     : var(--bg1);
		color          : var(--fg1);
		text-decoration: none;
	}
	.nav-item.nav-active {
		background        : color-mix(in srgb, var(--bright-aqua) 12%, var(--bg0));
		color             : var(--bright-aqua);
		border-left-color : var(--bright-aqua);
	}

	.nav-icon {
		width      : 16px;
		height     : 16px;
		flex-shrink: 0;
	}

	/* ── Main content ───────────────────────────────────────────────── */
	.main {
		flex       : 1;
		overflow-y : auto;
		padding    : 32px 36px;
	}
</style>
