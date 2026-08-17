<!--
	Chip multi-select backed by a search API. Used by the Grants scope builder for
	region / product / customer / site / group / service pickers. The parent owns
	the `selected` array (each item = { key, label }) and renders the hidden form
	inputs from it; this component only handles search + add/remove.

	Browsing: focusing the field (with an empty query) fetches a "browse" set --
	the endpoints return the TOP of their tree (modalities / categories / root
	groups / continents) so a user with no idea what to type still gets an entry
	point. Typing filters. The dropdown closes on select, Escape, or outside-click.
-->
<script lang="ts">
	import { base } from '$app/paths';

	type Item = { key: string; label: string };
	let {
		label,
		endpoint,
		toItem,
		resultsKey = 'items',
		placeholder = 'Search, or click to browse',
		selected = $bindable<Item[]>([]),
		onSelect = undefined,
		excludeKeys = [],
	}: {
		label: string;
		endpoint: string;
		toItem: (raw: any) => Item;
		resultsKey?: string;
		placeholder?: string;
		selected?: Item[];
		/** Action mode: called on pick instead of accumulating a chip (e.g. an
		 *  immediate add-membership POST). When set, no chips are rendered. */
		onSelect?: (item: Item) => void;
		/** Extra keys to hide from results (e.g. already-joined groups). */
		excludeKeys?: string[];
	} = $props();

	let q = $state('');
	let results = $state<Item[]>([]);
	let open = $state(false);
	let container: HTMLDivElement;
	let inputEl: HTMLInputElement;

	async function fetchResults() {
		const res = await fetch(`${base}${endpoint}?q=${encodeURIComponent(q.trim())}`);
		if (!res.ok) { results = []; return; }
		const raw = (await res.json())[resultsKey] ?? [];
		const have = new Set([...selected.map((s) => s.key), ...excludeKeys]);
		results = raw.map(toItem).filter((it: Item) => !have.has(it.key));
	}

	function onFocus() { open = true; fetchResults(); }
	function onInput() { open = true; fetchResults(); }
	function add(it: Item) {
		if (onSelect) {
			// Action mode: hand off (an immediate POST), drop the row locally, and
			// stay in the field for fast multi-add. Query is kept so the user can
			// keep picking from the same search.
			onSelect(it);
			results = results.filter((r) => r.key !== it.key);
			inputEl?.focus();
			return;
		}
		selected = [...selected, it];
		q = '';
		// Stay in the field for fast multi-add: refocus + refresh the browse list
		// (which now excludes what was just picked). Esc / outside-click dismiss.
		fetchResults();
		inputEl?.focus();
	}
	function remove(key: string) { selected = selected.filter((s) => s.key !== key); }
	function onKeydown(e: KeyboardEvent) { if (e.key === 'Escape') { open = false; inputEl?.blur(); } }

	// Close the dropdown on any click outside this picker.
	$effect(() => {
		function onDoc(e: MouseEvent) {
			if (open && container && !container.contains(e.target as Node)) open = false;
		}
		document.addEventListener('click', onDoc);
		return () => document.removeEventListener('click', onDoc);
	});
</script>

<div class="picker" bind:this={container}>
	<div class="plabel">{label}</div>
	{#if selected.length}
		<div class="chips">
			{#each selected as it (it.key)}
				<span class="chip">{it.label}<button type="button" onclick={() => remove(it.key)} aria-label="Remove">&times;</button></span>
			{/each}
		</div>
	{/if}
	<input
		{placeholder}
		bind:this={inputEl}
		bind:value={q}
		onfocus={onFocus}
		oninput={onInput}
		onkeydown={onKeydown} />
	{#if open}
		<ul class="results">
			{#if q.trim() === ''}
				<li class="browse-hint">Top of the tree &middot; type to filter</li>
			{/if}
			{#each results as it (it.key)}
				<li><button type="button" onclick={() => add(it)}>{it.label}</button></li>
			{:else}
				<li class="empty">{q.trim() === '' ? 'Nothing to browse.' : 'No matches.'}</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.picker { display: flex; flex-direction: column; gap: 0.3rem; position: relative; }
	.plabel { font-size: 0.78rem; color: var(--text-muted); }
	.chips { display: flex; flex-wrap: wrap; gap: 0.3rem; }
	.chip { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.78rem;
		background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; padding: 0.1rem 0.2rem 0.1rem 0.5rem; color: var(--text); }
	.chip button { background: none; border: none; color: var(--text-subtle); cursor: pointer; font-size: 0.95rem; line-height: 1; padding: 0 0.15rem; }
	.chip button:hover { color: var(--danger); }
	input { width: 100%; background: var(--bg-app); color: var(--text); border: 1px solid var(--border);
		border-radius: var(--radius); padding: 0.35rem 0.55rem; font: inherit; font-size: 0.84rem; }
	input:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	.results { list-style: none; padding: 0.25rem; margin: 0; border: 1px solid var(--border); border-radius: var(--radius);
		background: var(--surface); max-height: 14rem; overflow-y: auto;
		position: absolute; top: 100%; left: 0; right: 0; z-index: 20; margin-top: 0.2rem;
		box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28); }
	.results button { width: 100%; text-align: left; background: none; border: none; color: var(--text);
		font: inherit; font-size: 0.83rem; padding: 0.3rem 0.55rem; cursor: pointer; border-radius: var(--radius); }
	.results button:hover { background: var(--surface-2); }
	.results button:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
	.browse-hint { padding: 0.3rem 0.55rem 0.4rem; font-size: 0.72rem; color: var(--text-subtle); border-bottom: 1px solid var(--border); margin-bottom: 0.25rem; }
	.empty { padding: 0.4rem 0.55rem; font-size: 0.78rem; color: var(--text-subtle); }
</style>
