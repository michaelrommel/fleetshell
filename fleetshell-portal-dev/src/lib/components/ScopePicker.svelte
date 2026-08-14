<!--
	Chip multi-select backed by a search API. Used by the Grants scope builder for
	region / product / customer / site / group pickers. The parent owns the
	`selected` array (each item = { key, label }) and renders the hidden form
	inputs from it; this component only handles search + add/remove.
-->
<script lang="ts">
	import { base } from '$app/paths';

	type Item = { key: string; label: string };
	let {
		label,
		endpoint,
		toItem,
		resultsKey = 'items',
		placeholder = 'Search',
		selected = $bindable<Item[]>([]),
	}: {
		label: string;
		endpoint: string;
		toItem: (raw: any) => Item;
		resultsKey?: string;
		placeholder?: string;
		selected?: Item[];
	} = $props();

	let q = $state('');
	let results = $state<Item[]>([]);

	async function search() {
		if (q.trim().length < 2) { results = []; return; }
		const res = await fetch(`${base}${endpoint}?q=${encodeURIComponent(q.trim())}`);
		if (!res.ok) { results = []; return; }
		const raw = (await res.json())[resultsKey] ?? [];
		const have = new Set(selected.map((s) => s.key));
		results = raw.map(toItem).filter((it: Item) => !have.has(it.key));
	}
	function add(it: Item) { selected = [...selected, it]; results = results.filter((r) => r.key !== it.key); q = ''; }
	function remove(key: string) { selected = selected.filter((s) => s.key !== key); }
</script>

<div class="picker">
	<div class="plabel">{label}</div>
	{#if selected.length}
		<div class="chips">
			{#each selected as it (it.key)}
				<span class="chip">{it.label}<button type="button" onclick={() => remove(it.key)} aria-label="Remove">&times;</button></span>
			{/each}
		</div>
	{/if}
	<input {placeholder} bind:value={q} oninput={search} />
	{#if results.length}
		<ul class="results">
			{#each results as it (it.key)}
				<li><button type="button" onclick={() => add(it)}>{it.label}</button></li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.picker { display: flex; flex-direction: column; gap: 0.3rem; }
	.plabel { font-size: 0.78rem; color: var(--text-muted); }
	.chips { display: flex; flex-wrap: wrap; gap: 0.3rem; }
	.chip { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.78rem;
		background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; padding: 0.1rem 0.2rem 0.1rem 0.5rem; color: var(--text); }
	.chip button { background: none; border: none; color: var(--text-subtle); cursor: pointer; font-size: 0.95rem; line-height: 1; padding: 0 0.15rem; }
	.chip button:hover { color: var(--danger); }
	input { width: 100%; background: var(--bg-app); color: var(--text); border: 1px solid var(--border);
		border-radius: var(--radius); padding: 0.35rem 0.55rem; font: inherit; font-size: 0.84rem; }
	input:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	.results { list-style: none; padding: 0; margin: 0; border: 1px solid var(--border); border-radius: var(--radius);
		background: var(--surface); max-height: 12rem; overflow-y: auto; }
	.results button { width: 100%; text-align: left; background: none; border: none; color: var(--text);
		font: inherit; font-size: 0.83rem; padding: 0.3rem 0.55rem; cursor: pointer; }
	.results button:hover { background: var(--surface-2); }
</style>
