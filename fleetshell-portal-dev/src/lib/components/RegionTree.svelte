<!--
	Region tree (left column of /countries). Loads the whole geography hierarchy
	(country > region > sub-region, parent_id derived from the ltree path) and
	renders it with client-side expand/collapse + a filter that reveals matches
	with their ancestors. Selection is a link, so the host page controls the URL
	via hrefFor(id). Mirrors ProductTree.svelte; the node shape differs only in
	the meaning of the kind badge (geographic level instead of product level).
-->
<script lang="ts">
	import { untrack } from 'svelte';

	type Node = { id: string; name: string; parent_id: string | null; kind: string; iso: string | null; child_count: number };
	let {
		nodes,
		selectedId = null,
		hrefFor,
	}: { nodes: Node[]; selectedId?: string | null; hrefFor: (id: string) => string } = $props();

	let filter = $state('');
	let expanded = $state<Set<string>>(new Set());

	const byId = $derived(new Map(nodes.map((n) => [n.id, n])));
	const childrenByParent = $derived.by(() => {
		const m = new Map<string, Node[]>();
		for (const n of nodes) {
			const k = n.parent_id ?? '__root__';
			(m.get(k) ?? m.set(k, []).get(k)!).push(n);
		}
		return m;
	});
	const roots = $derived(childrenByParent.get('__root__') ?? []);
	const visibleIds = $derived.by(() => {
		const f = filter.trim().toLowerCase();
		if (!f) return null;
		const s = new Set<string>();
		for (const n of nodes) {
			if (n.name.toLowerCase().includes(f) || (n.iso ?? '').toLowerCase() === f) {
				let cur: string | null = n.id;
				while (cur && !s.has(cur)) { s.add(cur); cur = byId.get(cur)?.parent_id ?? null; }
			}
		}
		return s;
	});

	function childrenOf(id: string) { return childrenByParent.get(id) ?? []; }
	function hasChildren(id: string) { return (childrenByParent.get(id)?.length ?? 0) > 0; }
	function shown(id: string) { return !visibleIds || visibleIds.has(id); }
	function isOpen(id: string) { return visibleIds ? visibleIds.has(id) : expanded.has(id); }
	function toggle(id: string) {
		const s = new Set(expanded);
		s.has(id) ? s.delete(id) : s.add(id);
		expanded = s;
	}
	function label(n: Node) { return n.name.trim() || '(unnamed)'; }

	$effect(() => {
		const sel = selectedId;
		const _n = nodes;
		untrack(() => {
			// Collapsed by default (overview of countries); only reveal the path
			// down to a selected node.
			const s = new Set(expanded);
			let cur = sel ? (byId.get(sel)?.parent_id ?? null) : null;
			while (cur) { s.add(cur); cur = byId.get(cur)?.parent_id ?? null; }
			expanded = s;
			void _n;
		});
	});
</script>

<input class="search" placeholder="Filter countries / regions" bind:value={filter} />
<div class="card tree">
	{#each roots as r (r.id)}
		{@render treeNode(r, 0)}
	{:else}
		<p class="empty">No regions.</p>
	{/each}
</div>

{#snippet treeNode(n: Node, depth: number)}
	{#if shown(n.id)}
		<div class="tnode" class:sel={n.id === selectedId} style="padding-left:{depth * 16 + 4}px">
			{#if hasChildren(n.id)}
				<button class="twist" class:open={isOpen(n.id)} onclick={() => toggle(n.id)} aria-label="Expand"></button>
			{:else}
				<span class="twist-none"></span>
			{/if}
			<a class="tlabel" href={hrefFor(n.id)}>{label(n)}</a>
			{#if n.iso}<span class="iso">{n.iso}</span>{/if}
			<span class="kind kind-{n.kind}">{n.kind}</span>
			{#if n.child_count}<span class="tmeta">{n.child_count}</span>{/if}
		</div>
		{#if isOpen(n.id)}
			{#each childrenOf(n.id) as ch (ch.id)}
				{@render treeNode(ch, depth + 1)}
			{/each}
		{/if}
	{/if}
{/snippet}

<style>
	.search { width: 100%; margin-bottom: 0.6rem; flex: none;
		background: var(--bg-app); color: var(--text); border: 1px solid var(--border);
		border-radius: var(--radius); padding: 0.4rem 0.55rem; font: inherit; font-size: 0.85rem; }
	.search:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
	.tree { flex: 1; min-height: 0; overflow-y: auto; padding: 0.25rem; }
	.empty { color: var(--text-subtle); padding: 0.8rem; margin: 0; text-align: center; }
	.tnode { display: flex; align-items: center; gap: 0.3rem; height: 26px; border-radius: var(--radius); }
	.tnode:hover { background: var(--surface-2); }
	.tnode.sel { background: var(--surface-active); box-shadow: inset 2px 0 0 var(--accent); }
	.twist { position: relative; width: 16px; height: 16px; flex: none; border: none; background: none; padding: 0; cursor: pointer; }
	.twist::before {
		content: ''; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
		width: 0; height: 0; border-left: 6px solid var(--text-muted);
		border-top: 5px solid transparent; border-bottom: 5px solid transparent; transition: transform 0.1s;
	}
	.twist.open::before { transform: translate(-50%, -50%) rotate(90deg); }
	.twist-none { display: inline-block; width: 16px; flex: none; }
	.tlabel { flex: 1; min-width: 0; color: var(--text); text-decoration: none; font-size: 0.86rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.tnode.sel .tlabel { font-weight: 600; }
	.iso { flex: none; font-size: 0.62rem; letter-spacing: 0.04em; color: var(--text-subtle); font-variant-numeric: tabular-nums; }
	.kind { flex: none; font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.03em; padding: 0.05rem 0.3rem; border-radius: 3px; color: var(--text-subtle); background: var(--surface-2); }
	.kind-country { color: var(--accent); }
	.kind-subregion { color: var(--text-muted); }
	.tmeta { color: var(--text-subtle); font-size: 0.68rem; padding-right: 0.4rem; flex: none; }
</style>
