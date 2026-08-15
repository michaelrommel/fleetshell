<script lang="ts">
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';
	import { page as pageState } from '$app/state';
	import DtmEditor from '$lib/components/DtmEditor.svelte';

	let { data, form } = $props();

	// FROM country + variant drive the server load via the URL.
	function navTo(changes: Record<string, string | null>) {
		const u = new URLSearchParams(pageState.url.searchParams);
		for (const [k, v] of Object.entries(changes)) v === null ? u.delete(k) : u.set(k, v);
		goto(`${base}/countries/data-transfer-matrix?${u}`, { keepFocus: true, noScroll: true });
	}
</script>

<div class="dtm">
	<div class="toolbar">
		<label class="pick">
			<span>Origin country</span>
			<select value={data.from ?? ''} onchange={(e) => navTo({ from: e.currentTarget.value || null })}>
				<option value="">Select a country…</option>
				{#each data.countries as c (c.iso)}
					<option value={c.iso}>{c.name} ({c.iso})</option>
				{/each}
			</select>
		</label>

		{#if data.from}
			<div class="variants" role="tablist" aria-label="Variant">
				{#each data.variants as v (v.code)}
					<button
						role="tab"
						aria-selected={v.code === data.variant}
						class:active={v.code === data.variant}
						onclick={() => navTo({ variant: v.code })}
					>{v.label}</button>
				{/each}
			</div>
		{/if}
	</div>

	{#if form?.error}<p class="msg error">{form.error}</p>{/if}
	{#if form?.exported}<p class="msg ok">{form.exported}</p>{/if}
	{#if form?.saved !== undefined}<p class="msg ok">Saved {form.saved} denied cell(s).</p>{/if}

	{#if !data.from}
		<div class="card placeholder">
			Choose an origin country to edit where its data may flow.
			Each cell is <b>permitted</b> by default; mark the exceptions you want to <b>deny</b>.
		</div>
	{:else}
		{#key `${data.from}:${data.variant}`}
			<DtmEditor data={{ ...data, from: data.from }} />
		{/key}
	{/if}
</div>

<style>
	.dtm { display: flex; flex-direction: column; min-height: 0; flex: 1; }
	.toolbar { display: flex; align-items: flex-end; gap: 1rem; margin-bottom: 0.8rem; flex-wrap: wrap; }
	.pick { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.78rem; color: var(--text-muted); }
	.pick select { background: var(--bg-app); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.4rem 0.55rem; font: inherit; font-size: 0.85rem; min-width: 16rem; }
	.variants { display: flex; gap: 0.3rem; }
	.variants button { background: var(--surface-2); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.4rem 0.8rem; font: inherit; font-size: 0.82rem; cursor: pointer; }
	.variants button.active { background: var(--surface-active); color: var(--text); box-shadow: inset 0 -2px 0 var(--accent); }

	.msg { font-size: 0.85rem; margin: 0 0 0.6rem; padding: 0.4rem 0.6rem; border-radius: var(--radius); }
	.msg.error { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }
	.msg.ok { color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }

	.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
	.placeholder { padding: 2rem; text-align: center; color: var(--text-subtle); }
</style>
