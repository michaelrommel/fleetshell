<!--
	Single-select type-ahead over a search API (device edit: model / region /
	customer / site / gateway). Emits the chosen value through a hidden input so
	it posts with the surrounding form. Clear sets it back to empty (NULL).
-->
<script lang="ts">
	import { base } from '$app/paths';

	type Item = Record<string, string>;
	let {
		api, name, idField, labelField,
		value = null, label = null, disabled = false, placeholder = 'search...',
	}: {
		api: string; name: string; idField: string; labelField: string;
		value?: string | null; label?: string | null; disabled?: boolean; placeholder?: string;
	} = $props();

	let curValue = $state(value);
	let curLabel = $state(label);
	let query = $state('');
	let results = $state<Item[]>([]);
	let open = $state(false);

	async function search() {
		if (query.trim().length < 2) { results = []; return; }
		const res = await fetch(`${base}${api}?q=${encodeURIComponent(query.trim())}`);
		results = res.ok ? (await res.json()).items : [];
		open = true;
	}
	function pick(it: Item) {
		curValue = it[idField];
		curLabel = it[labelField] ?? it[idField];
		query = ''; results = []; open = false;
	}
	function clear() { curValue = null; curLabel = null; }
</script>

<div class="picker">
	<input type="hidden" {name} value={curValue ?? ''} />
	<div class="current">
		{#if curValue}
			<span class="chosen" title={curValue}>{curLabel ?? curValue}</span>
			{#if !disabled}<button type="button" class="clear" onclick={clear} aria-label="Clear">✕</button>{/if}
		{:else}
			<span class="none">— none —</span>
		{/if}
	</div>
	{#if !disabled}
		<input class="search" {placeholder} bind:value={query} oninput={search}
		       onfocus={() => (open = results.length > 0)} autocomplete="off" spellcheck="false" />
		{#if open && results.length}
			<ul class="results">
				{#each results as it}
					<li><button type="button" onclick={() => pick(it)}>{it[labelField] ?? it[idField]}</button></li>
				{/each}
			</ul>
		{/if}
	{/if}
</div>

<style>
	.picker { position: relative; }
	.current { display: flex; align-items: center; gap: 0.4rem; min-height: 1.5rem; }
	.chosen { font-size: 0.85rem; color: var(--text); }
	.none { font-size: 0.82rem; color: var(--text-subtle); }
	.clear { background: none; border: none; color: var(--text-subtle); cursor: pointer; font-size: 0.72rem; padding: 0 0.2rem; }
	.clear:hover { color: var(--danger); }
	.search { width: 100%; margin-top: 0.25rem; background: var(--bg-app); color: var(--text);
		border: 1px solid var(--border); border-radius: var(--radius); padding: 0.35rem 0.5rem; font: inherit; font-size: 0.82rem; }
	.search:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	.results { position: absolute; z-index: 5; left: 0; right: 0; margin: 0.15rem 0 0; padding: 0.2rem; list-style: none;
		background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow, 0 4px 14px rgba(0,0,0,0.25)); max-height: 240px; overflow-y: auto; }
	.results li button { display: block; width: 100%; text-align: left; background: none; border: none; color: var(--text);
		font: inherit; font-size: 0.82rem; padding: 0.35rem 0.5rem; border-radius: var(--radius); cursor: pointer; }
	.results li button:hover { background: var(--surface-2); }
</style>
