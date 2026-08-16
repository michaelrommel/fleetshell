<!--
	src/lib/components/AppShell.svelte

	The portal chrome: a brand top-bar and an icon-rail left sidebar, styled to
	the Siemens Healthineers "Remote Service" look
	(theme-reference/nucleus_transfer_history.png). All colours come from the
	design tokens in src/app.css, so the whole shell re-themes by flipping
	<html data-theme>.

	Layout:
	  top-bar : [ logo | FleetShell Portal ] .............. [ theme | bell | user/role | logout ]
	  body    : [ icon rail ] [ routed page content ]

	Props:
	  user       display name, e.g. "Rommel, Michael"
	  role       role/label under the name, e.g. "SuperUser / CSE"
	  newsCount  unread news items -> red dot on the bell (0 = none)
	  children   routed page content
-->
<script lang="ts">
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { browser } from '$app/environment';
	import type { Snippet } from 'svelte';
	import { THEMES, type Theme } from '$lib/theme';
	import { viewLayout, setViewOverlay } from '$lib/viewLayout.svelte';
	import Toast from '$lib/components/Toast.svelte';
	import { PRIMARY_NAV, UTILITY_NAV, type NavIcon } from '$lib/nav';
	import Logo from './Logo.svelte';

	let {
		user,
		role,
		newsCount = 0,
		canSwitch = false,
		isAdmin = false,
		children,
	}: {
		user: string;
		role: string;
		newsCount?: number;
		canSwitch?: boolean;
		isAdmin?: boolean;
		children: Snippet;
	} = $props();

	let theme = $state<Theme>('nucleus');

	$effect(() => {
		if (browser) {
			theme = (document.documentElement.getAttribute('data-theme') as Theme) ?? 'nucleus';
		}
	});

	function toggleTheme(): void {
		const idx = THEMES.indexOf(theme);
		const next = THEMES[(idx + 1) % THEMES.length];
		theme = next;
		document.documentElement.setAttribute('data-theme', next); // instant, no reload
		fetch(`${base}/theme?value=${next}`, { method: 'POST' }); // persist (cookie + DB)
	}

	function active(href: string): boolean {
		const full = `${base}${href}`;
		return page.url.pathname === full || page.url.pathname.startsWith(full + '/');
	}
</script>

<!-- Inline icon sprite: <use href="#i-<key>"> in the rail. -->
<svg style="display:none" aria-hidden="true">
	<defs>
		<g id="i-devices">
			<rect x="2" y="3" width="20" height="14" rx="2" />
			<line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
		</g>
		<g id="i-gateways">
			<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
			<path d="M9 12l2 2 4-4" />
		</g>
		<g id="i-products">
			<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
			<polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" />
		</g>
		<g id="i-customers">
			<path d="M3 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16" />
			<path d="M13 9h6a2 2 0 0 1 2 2v10" />
			<line x1="6" y1="7" x2="6.01" y2="7" /><line x1="9" y1="7" x2="9.01" y2="7" />
			<line x1="6" y1="11" x2="6.01" y2="11" /><line x1="9" y1="11" x2="9.01" y2="11" />
			<line x1="16" y1="13" x2="16.01" y2="13" /><line x1="16" y1="17" x2="16.01" y2="17" />
		</g>
		<g id="i-countries">
			<circle cx="12" cy="12" r="9.5" />
			<path d="M8 3.5c1.2.6 1.3 1.8 2.6 2.1 1.3.3 2.2-.9 3.4-.3 1.1.6.7 2.1 1.7 2.8 1 .7 2.6.2 3.1 1.4M20.8 10.8c-1.2.2-1.6 1.5-2.8 1.7-1.3.2-2-1.1-3.2-.6-1.1.5-.8 2-1.9 2.6-1.1.6-2.4-.4-3.3.5-.8.8-.2 2.2-1 3.1-.7.8-1.9.5-2.5 1.5" />
		</g>
		<g id="i-services">
			<circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
			<line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
		</g>
		<g id="i-administration">
			<line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" />
			<line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" />
			<line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" />
			<line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
		</g>
		<g id="i-support">
			<circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="4" />
			<line x1="4.93" y1="4.93" x2="9.17" y2="9.17" /><line x1="14.83" y1="14.83" x2="19.07" y2="19.07" />
			<line x1="14.83" y1="9.17" x2="19.07" y2="4.93" /><line x1="4.93" y1="19.07" x2="9.17" y2="14.83" />
		</g>
		<g id="i-settings">
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
		</g>
	</defs>
</svg>

<div class="shell">
	<!-- Top bar -->
	<header class="topbar">
		<a class="brand" href="{base}/devices" aria-label="FleetShell Portal home">
			<Logo />
			<span class="brand-sep"></span>
			<span class="brand-name">FleetShell&nbsp;Portal</span>
		</a>

		<div class="actions">
			{#if viewLayout.active && !viewLayout.narrow}
				<div class="viewtoggle" role="group" aria-label="Editor layout">
					<button
						class:active={!viewLayout.overlay}
						onclick={() => setViewOverlay(false)}
						title="Side-by-side view"
						aria-label="Side-by-side view"
					>&#9707;</button>
					<button
						class:active={viewLayout.overlay}
						onclick={() => setViewOverlay(true)}
						title="Full-width overlay editor"
						aria-label="Full-width overlay editor"
					>&#9634;</button>
				</div>
			{/if}
			<button class="icon-btn" onclick={toggleTheme} title="Toggle theme" aria-label="Toggle theme">
				<!-- broad flat brush, held vertically: thick handle on top, wide bristle block at bottom -->
				<svg viewBox="0 0 24 24" class="glyph" fill="none" stroke="currentColor"
				     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<!-- handle (thicker + taller) -->
					<path d="M12 2v9" stroke-width="3.5" />
					<!-- ferrule (metal band) -->
					<path d="M6 11h12v3H6z" />
					<!-- bristle block, flaring wider toward the bottom -->
					<path d="M6.5 14h11l2.5 8H4z" />
				</svg>
			</button>

			<button class="icon-btn bell" title="News" aria-label="News feed">
				<svg viewBox="0 0 24 24" class="glyph" fill="none" stroke="currentColor"
				     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
					<path d="M13.73 21a2 2 0 0 1-3.46 0" />
				</svg>
				{#if newsCount > 0}<span class="dot" aria-label="{newsCount} unread"></span>{/if}
			</button>

			<a
				class="who"
				class:switchable={canSwitch}
				href={canSwitch ? `${base}/select-persona` : undefined}
				title={canSwitch ? 'Switch persona' : undefined}
				aria-label={canSwitch ? 'Switch persona' : undefined}
			>
				<span class="who-name">
					{user}{#if canSwitch}<span class="caret">▾</span>{/if}
				</span>
				<span class="who-role">{role}</span>
			</a>

			<form method="POST" action="{base}/logout" class="logout-form">
				<button type="submit" class="icon-btn" title="Sign out" aria-label="Sign out">
					<svg viewBox="0 0 24 24" class="glyph" fill="none" stroke="currentColor"
					     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
						<polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
					</svg>
				</button>
			</form>
		</div>
	</header>

	<!-- Body -->
	<div class="body">
		<nav class="rail" aria-label="Main navigation">
			<div class="rail-group">
				{#each PRIMARY_NAV as item (item.href)}
					{@render railItem(item.href, item.icon, item.label, item.requiresAdmin ?? false)}
				{/each}
			</div>
			<div class="rail-group">
				<div class="rail-divider"></div>
				{#each UTILITY_NAV as item (item.href)}
					{@render railItem(item.href, item.icon, item.label, item.requiresAdmin ?? false)}
				{/each}
			</div>
		</nav>

		<main class="content">
			{@render children()}
		</main>
	</div>
</div>

<Toast />

{#snippet railItem(href: string, icon: NavIcon, label: string, requiresAdmin: boolean)}
	{#if requiresAdmin && !isAdmin}
		<span class="rail-item disabled" aria-disabled="true" title="Requires additional rights">
			<svg class="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
			     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<use href="#i-{icon}" />
			</svg>
			<span class="rail-label">{label}</span>
		</span>
	{:else}
		<a
			class="rail-item"
			class:active={active(href)}
			href="{base}{href}"
			aria-current={active(href) ? 'page' : undefined}
		>
			<svg class="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
			     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<use href="#i-{icon}" />
			</svg>
			<span class="rail-label">{label}</span>
		</a>
	{/if}
{/snippet}

<style>
	.shell {
		display: flex;
		flex-direction: column;
		height: 100vh;
		overflow: hidden;
		background: var(--bg-app);
	}

	/* Top bar */
	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		height: 56px;
		padding: 0 18px 0 20px;
		background: var(--bg-header);
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
		z-index: 10;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 14px;
		text-decoration: none;
		color: var(--text);
	}
	.brand-sep {
		width: 1px;
		height: 22px;
		background: var(--border);
	}
	.brand-name {
		font-size: 1rem;
		font-weight: 700;
		letter-spacing: 0.01em;
		color: var(--text);
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.viewtoggle {
		display: inline-flex;
		gap: 1px;
		padding: 2px;
		margin-right: 2px;
		background: var(--bg-app);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.viewtoggle button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		padding: 0;
		background: none;
		border: none;
		border-radius: calc(var(--radius) - 1px);
		color: var(--text-muted);
		font-size: 0.9rem;
		line-height: 1;
		cursor: pointer;
	}
	.viewtoggle button:hover { color: var(--text); background: var(--surface); }
	.viewtoggle button.active { color: var(--text); background: var(--surface-active); }
	.viewtoggle button:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--focus); }

	.icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		padding: 0;
		background: none;
		border: none;
		border-radius: var(--radius);
		color: var(--text-muted);
		cursor: pointer;
		position: relative;
	}
	.icon-btn:hover {
		background: var(--surface-2);
		color: var(--text);
	}
	.glyph {
		width: 19px;
		height: 19px;
	}

	.bell .dot {
		position: absolute;
		top: 7px;
		right: 8px;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--accent);
		border: 1px solid var(--bg-header);
	}

	.who {
		display: flex;
		flex-direction: column;
		line-height: 1.15;
		margin: 0 6px 0 8px;
		text-align: right;
		text-decoration: none;
		color: inherit;
		border-radius: var(--radius);
		padding: 4px 6px;
	}
	.who.switchable { cursor: pointer; }
	.who.switchable:hover { background: var(--surface-2); }
	.who-name {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text);
	}
	.caret { margin-left: 4px; font-size: 0.7rem; color: var(--text-subtle); }
	.who-role {
		font-size: 0.72rem;
		color: var(--text-subtle);
	}

	.logout-form {
		display: inline-flex;
		margin: 0;
	}

	/* Body */
	.body {
		display: flex;
		flex: 1;
		overflow: hidden;
	}

	/* Icon rail */
	.rail {
		width: 84px;
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		background: var(--bg-header);
		border-right: 1px solid var(--border);
		padding: 12px 8px;
		overflow-y: auto;
	}
	.rail-group {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.rail-divider {
		height: 1px;
		background: var(--border);
		margin: 6px 6px 8px;
	}

	.rail-item {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 5px;
		min-height: 60px;
		padding: 8px 4px;
		border-radius: var(--radius);
		color: var(--text-muted);
		text-decoration: none;
		text-align: center;
		border: 1px solid transparent;
		transition: background 0.1s, color 0.1s, border-color 0.1s;
		user-select: none;
	}
	.rail-item:hover {
		background: var(--surface-2);
		color: var(--text);
	}
	.rail-item.active {
		background: var(--surface-active);
		color: var(--text);
		border-color: var(--border);
		box-shadow: inset 2px 0 0 var(--accent);
	}
	.rail-icon {
		width: 22px;
		height: 22px;
		flex-shrink: 0;
	}
	.rail-item.disabled {
		color: var(--text-subtle);
		opacity: 0.4;
		cursor: not-allowed;
	}
	.rail-item.disabled:hover {
		background: none;
		color: var(--text-subtle);
	}
	.rail-label {
		font-size: 0.66rem;
		line-height: 1.15;
		letter-spacing: 0.01em;
		white-space: pre-line;
	}

	/* Routed content */
	.content {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 28px 32px;
		display: flex;
		flex-direction: column;
	}
</style>
