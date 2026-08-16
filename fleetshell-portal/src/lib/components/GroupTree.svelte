<!--
	Reusable group-tree (left column of the Groups + Grants tabs). Loads the whole
	tree (parent_id links) and renders it with client-side expand/collapse + a
	filter that reveals matches with their ancestors. Selection is a link, so the
	host page controls the URL via hrefFor(group_id).
-->
<script lang="ts">
	import { untrack } from 'svelte';

	type Node = { group_id: string; label: string; parent_id: string | null; grant_count: number; member_count: number };
	let {
		nodes,
		selectedId = null,
		hrefFor,
	}: { nodes: Node[]; selectedId?: string | null; hrefFor: (id: string) => string } = $props();

	let filter = $state('');
	let expanded = $state<Set<string>>(new Set());

	const byId = $derived(new Map(nodes.map((n) => [n.group_id, n])));
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
			if (n.label.toLowerCase().includes(f)) {
				let cur: string | null = n.group_id;
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

	$effect(() => {
		const sel = selectedId;
		const _n = nodes;
		untrack(() => {
			const s = new Set(expanded);
			for (const r of childrenByParent.get('__root__') ?? []) s.add(r.group_id);
			let cur = sel ? (byId.get(sel)?.parent_id ?? null) : null;
			while (cur) { s.add(cur); cur = byId.get(cur)?.parent_id ?? null; }
			expanded = s;
			void _n;
		});
	});
</script>

<input class="search" placeholder="Filter groups" bind:value={filter} />
<div class="card tree">
	{#each roots as r (r.group_id)}
		{@render treeNode(r, 0)}
	{:else}
		<p class="empty">No groups.</p>
	{/each}
</div>

{#snippet treeNode(n: Node, depth: number)}
	{#if shown(n.group_id)}
		<div class="tnode" class:sel={n.group_id === selectedId} style="padding-left:{depth * 16 + 4}px">
			{#if hasChildren(n.group_id)}
				<button class="twist" class:open={isOpen(n.group_id)} onclick={() => toggle(n.group_id)} aria-label="Expand"></button>
			{:else}
				<span class="twist-none"></span>
			{/if}
			<a class="tlabel" href={hrefFor(n.group_id)}>{n.label}</a>
			<span class="tmeta">{#if n.grant_count && n.member_count}{n.grant_count} gra / {n.member_count} mem{:else if n.grant_count}{n.grant_count} gra{:else if n.member_count}{n.member_count} mem{/if}</span>
		</div>
		{#if isOpen(n.group_id)}
			{#each childrenOf(n.group_id) as ch (ch.group_id)}
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
	.tmeta { color: var(--text-subtle); font-size: 0.68rem; padding-right: 0.4rem; flex: none; }
</style>
