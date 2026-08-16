<script lang="ts">
	import AppShell          from '$lib/components/AppShell.svelte';
	import type { Snippet }  from 'svelte';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();
</script>

<AppShell user={data.user}>
	{@render children()}
</AppShell>
