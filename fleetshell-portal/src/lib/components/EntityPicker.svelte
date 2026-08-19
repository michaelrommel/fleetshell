<!--
	Single-select relation picker: shows the current value as a label with a
	"Change" button; clicking reveals a type-ahead over a search API. Emits the
	chosen id through a hidden input so it posts with the surrounding form.
	Remount via {#key} in the host when the underlying record changes (the
	internal state is seeded from props once).
-->
<script lang="ts">
	import { base } from '$app/paths';

	type Item = Record<string, string>;
	let {
		api, name, idField, labelField,
		value = null, label = null, disabled = false, placeholder = 'search...', extraParams = {}, onPick, trailing,
	}: {
		api: string; name: string; idField: string; labelField: string;
		value?: string | null; label?: string | null; disabled?: boolean; placeholder?: string;
		extraParams?: Record<string, string>;
		/** Notified with the full chosen item (or null on clear) for host-side reactions. */
		onPick?: (item: Item | null) => void;
		/** Optional trailing content (e.g. a jump link) shown after Change; gets the current id. */
		trailing?: import('svelte').Snippet<[string | null]>;
	} = $props();

	// Seeded ONCE from props; the host remounts via {#key} when the underlying
	// record changes (see header), so a snapshot here is intentional.
	// svelte-ignore state_referenced_locally
	let curValue = $state(value);
	// svelte-ignore state_referenced_locally
	let curLabel = $state(label);
	let editing = $state(false);
	let query = $state('');
	let results = $state<Item[]>([]);

	async function search() {
		if (query.trim().length < 2) { results = []; return; }
		const params = new URLSearchParams({ q: query.trim() });
		for (const [k, v] of Object.entries(extraParams)) if (v) params.set(k, v);
		const res = await fetch(`${base}${api}?${params}`);
		results = res.ok ? (await res.json()).items : [];
	}
	function pick(it: Item) {
		curValue = it[idField];
		curLabel = it[labelField] ?? it[idField];
		editing = false; query = ''; results = [];
		onPick?.(it);
	}
	function startEdit() { editing = true; query = ''; results = []; }
	function cancel() { editing = false; query = ''; results = []; }
	function clear() { curValue = null; curLabel = null; onPick?.(null); }
	// Esc closes the open dropdown list first; a second Esc leaves edit mode.
	// stopPropagation so it does not also bubble to any host-level Esc handler
	// (e.g. the SplitPane detail overlay).
	function onSearchKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			if (results.length) results = [];
			else cancel();
		}
	}
</script>

<div class="picker">
	<input type="hidden" {name} value={curValue ?? ''} />

	{#if editing}
		<div class="edit">
			<input class="search" {placeholder} bind:value={query} oninput={search}
			       onkeydown={onSearchKeydown} autocomplete="off" spellcheck="false" />
			<button type="button" class="mini" onclick={cancel} aria-label="Cancel">✕</button>
			{#if results.length}
				<ul class="results">
					{#each results as it}
						<li><button type="button" onclick={() => pick(it)}>{it[labelField] ?? it[idField]}</button></li>
					{/each}
				</ul>
			{/if}
		</div>
	{:else}
		<div class="current">
			{#if curValue}
				<span class="chosen" title={curValue}>{curLabel ?? curValue}</span>
			{:else}
				<span class="none">— none —</span>
			{/if}
			{#if !disabled}
				{#if curValue}<button type="button" class="mini clear" onclick={clear} aria-label="Clear">✕</button>{/if}
				<button type="button" class="mini" onclick={startEdit}>Change</button>
			{/if}
			{@render trailing?.(curValue)}
		</div>
	{/if}
</div>

<style>
	.picker { position: relative; min-width: 0; }
	.current { display: flex; align-items: center; gap: 0.5rem; min-height: 1.9rem; }
	.chosen { font-size: 0.85rem; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.none { font-size: 0.82rem; color: var(--text-subtle); }
	.mini { flex: none; background: none; border: 1px solid var(--border); color: var(--text-muted);
		border-radius: var(--radius); padding: 0.15rem 0.5rem; font: inherit; font-size: 0.74rem; cursor: pointer; }
	.mini:hover { color: var(--text); border-color: var(--text-subtle); }
	.mini.clear { color: var(--text-subtle); padding: 0.15rem 0.4rem; }
	.mini.clear:hover { color: var(--text); border-color: var(--text-subtle); }

	.edit { display: flex; align-items: center; gap: 0.35rem; }
	.search { flex: 1; min-width: 0; background: var(--bg-app); color: var(--text);
		border: 1px solid var(--border); border-radius: var(--radius); padding: 0.35rem 0.5rem; font: inherit; font-size: 0.82rem; }
	.search:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	.results { position: absolute; z-index: 5; left: 0; right: 0; top: 100%; margin: 0.15rem 0 0; padding: 0.2rem; list-style: none;
		background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow, 0 4px 14px rgba(0,0,0,0.25)); max-height: 240px; overflow-y: auto; }
	.results li button { display: block; width: 100%; text-align: left; background: none; border: none; color: var(--text);
		font: inherit; font-size: 0.82rem; padding: 0.35rem 0.5rem; border-radius: var(--radius); cursor: pointer; }
	.results li button:hover { background: var(--surface-2); }
</style>
