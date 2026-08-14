<script lang="ts">
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();

	const tabs = [
		{ href: '/administration/users',  label: 'Users' },
		{ href: '/administration/roles',  label: 'Roles' },
		{ href: '/administration/groups', label: 'Groups' },
		{ href: '/administration/grants', label: 'Grants' },
	];

	function active(href: string): boolean {
		const full = `${base}${href}`;
		return page.url.pathname === full || page.url.pathname.startsWith(full + '/');
	}
</script>

<div class="admin">
	<div class="page-head">
		<h1>Administration</h1>
		<p class="sub">Users, groups, roles and grants.</p>
	</div>

	<nav class="tabs" aria-label="Administration sections">
		{#each tabs as t (t.href)}
			<a href="{base}{t.href}" class:active={active(t.href)}
			   aria-current={active(t.href) ? 'page' : undefined}>{t.label}</a>
		{/each}
	</nav>

	<div class="tab-body">
		{@render children()}
	</div>
</div>

<style>
	.admin { max-width: 80rem; }
	.page-head { margin-bottom: 1rem; }
	h1 { font-size: 1.3rem; margin: 0 0 0.2rem; }
	.sub { margin: 0; color: var(--text-muted); font-size: 0.9rem; }

	.tabs {
		display: flex;
		gap: 1.4rem;
		border-bottom: 1px solid var(--border);
		margin-bottom: 1.2rem;
	}
	.tabs a {
		padding: 0.6rem 0.1rem;
		color: var(--text-muted);
		text-decoration: none;
		font-size: 0.9rem;
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
	}
	.tabs a:hover { color: var(--text); }
	.tabs a.active { color: var(--text); border-bottom-color: var(--accent); }
</style>
