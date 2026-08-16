<script lang="ts">
	import { base } from '$app/paths';
	import { browser } from '$app/environment';
	import type { Snippet } from 'svelte';
	import type { LayoutData } from './$types';
	import AppShell from '$lib/components/AppShell.svelte';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();

	// Live channel (device status, news, etc.). Skeleton for now; the shell does
	// not depend on it, so a closed socket degrades gracefully.
	$effect(() => {
		if (!browser) return;
		const proto = location.protocol === 'https:' ? 'wss' : 'ws';
		const ws = new WebSocket(`${proto}://${location.host}${base}/ws`);
		return () => ws.close();
	});
</script>

<AppShell
	user={data.displayName}
	role={data.role}
	newsCount={data.newsCount}
	canSwitch={data.canSwitch}
	isAdmin={data.isAdmin}
>
	{@render children()}
</AppShell>
