<!--
	Data Classification (Products > Data Classification).

	Modality-scoped. Three inner views:
	  - Rule Sets  : master list of reusable sets + an Excel-like grid editor
	                 (regex column + one checkbox per data class).
	  - Assignments: matrix of products (grouped by family, with a modality-wide
	                 row and tickable family headers) x rule sets.
	  - Preview    : the effective merged /regex/ -> CODES per product exactly as
	                 written to Valkey, plus a Sync to Valkey action.

	See docs/data_classification.md.
-->
<script lang="ts">
	import { base } from '$app/paths';
	import { page as pageState } from '$app/state';
	import { enhance } from '$app/forms';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';

	let { data, form } = $props();

	type Code = string;
	type GridRow = { regex: string; codes: Set<Code> };

	const codes = $derived(data.dataClasses.map((c) => c.code));

	// --- url helpers ---------------------------------------------------------
	function href(changes: Record<string, string | null>): string {
		const u = new URLSearchParams(pageState.url.searchParams);
		for (const [k, v] of Object.entries(changes)) v === null ? u.delete(k) : u.set(k, v);
		return `${base}/products/classification?${u}`;
	}
	const views = [
		{ id: 'sets', label: 'Rule Sets' },
		{ id: 'assign', label: 'Assignments' },
		{ id: 'preview', label: 'Preview' },
	];

	const selectedSet = $derived(data.sets.find((s) => s.id === data.selSet) ?? null);
	const canEdit = $derived(data.isAdmin);

	// --- rule grid (local, remounted per set via {#key}) ---------------------
	let rows = $state<GridRow[]>([]);
	$effect(() => {
		// reseed when the selected set / its rules change
		void data.selSet;
		rows = data.rules.map((r) => ({ regex: r.regex, codes: new Set(r.codes) }));
	});
	function toggleCode(row: GridRow, code: Code) {
		if (row.codes.has(code)) row.codes.delete(code);
		else row.codes.add(code);
		rows = [...rows]; // nudge reactivity (Set mutation)
	}
	function addRow() { rows = [...rows, { regex: '', codes: new Set() }]; }
	function removeRow(i: number) { rows = rows.filter((_, idx) => idx !== i); }
	const rulesJson = $derived(
		JSON.stringify(rows.map((r) => ({ regex: r.regex, codes: [...r.codes] })))
	);

	// --- assignments lookups -------------------------------------------------
	const assignedProduct = $derived(new Set(
		data.assignments.filter((a) => a.product_id).map((a) => `${a.set_id}|${a.product_id}`)
	));
	const assignedFamily = $derived(new Set(
		data.assignments.filter((a) => a.family).map((a) => `${a.set_id}|${a.family}`)
	));
	const assignedModality = $derived(new Set(
		data.assignments.filter((a) => !a.product_id && !a.family).map((a) => a.set_id)
	));

	// products grouped by family; families sorted, (no family) last.
	type Group = { family: string | null; products: { id: string; name: string }[] };
	const groups = $derived.by<Group[]>(() => {
		const byFam = new Map<string | null, { id: string; name: string }[]>();
		for (const p of data.products) {
			const key = p.family && p.family.trim() ? p.family : null;
			const arr = byFam.get(key) ?? [];
			arr.push({ id: p.id, name: p.name });
			byFam.set(key, arr);
		}
		const named = [...byFam.entries()].filter(([f]) => f !== null).sort((a, b) => a[0]!.localeCompare(b[0]!));
		const none = byFam.has(null) ? [[null, byFam.get(null)!] as [null, { id: string; name: string }[]]] : [];
		return [...named, ...none].map(([family, products]) => ({ family, products }));
	});

	const previewProducts = $derived(data.preview.filter((p) => p.fields.length > 0));

	let confirmDeleteSet = $state(false);
</script>

<div class="dc">
	{#if form?.error}<p class="msg error">{form.error}</p>{/if}
	{#if form?.synced}<p class="msg ok">{form.synced}</p>{/if}

	<!-- modality selector + inner view tabs -->
	<div class="bar">
		<label class="mod-pick">
			<span>Modality</span>
			<select onchange={(e) => location.assign(href({ mod: (e.currentTarget as HTMLSelectElement).value, set: null }))}>
				{#each data.modalities as m (m.id)}
					<option value={m.id} selected={m.id === data.modId}>{m.name}</option>
				{/each}
			</select>
		</label>
		<nav class="subtabs">
			{#each views as v (v.id)}
				<a href={href({ view: v.id })} class:active={data.view === v.id}>{v.label}</a>
			{/each}
		</nav>
	</div>

	{#if !data.modId}
		<p class="empty">No modalities defined.</p>

	<!-- ========================= RULE SETS ============================= -->
	{:else if data.view === 'sets'}
		<div class="cols">
			<aside class="set-list">
				<div class="col-head">
					<h3>Rule Sets <span class="count">{data.sets.length}</span></h3>
				</div>
				<div class="set-scroll">
					{#each data.sets as s (s.id)}
						<a class="set-item" class:active={s.id === data.selSet} href={href({ set: s.id })}>
							<span class="set-name">{s.name}</span>
							<span class="set-meta">{s.rule_count} rule{s.rule_count === 1 ? '' : 's'} - {s.assign_count} use{s.assign_count === 1 ? '' : 's'}</span>
						</a>
					{/each}
				</div>
				{#if canEdit}
					<form class="new-set" method="POST" action="?/createSet" use:enhance>
						<input type="hidden" name="mod" value={data.modId} />
						<input type="text" name="name" placeholder="New set name" autocomplete="off" required />
						<button type="submit">+ Add</button>
					</form>
				{/if}
			</aside>

			<section class="set-detail">
				{#if !selectedSet}
					<p class="empty">Select a rule set, or create one.</p>
				{:else}
					{#key selectedSet.id}
						<form class="set-head" method="POST" action="?/updateSet" use:enhance>
							<input type="hidden" name="mod" value={data.modId} />
							<input type="hidden" name="id" value={selectedSet.id} />
							<input class="set-title" type="text" name="name" value={selectedSet.name} disabled={!canEdit} autocomplete="off" />
							<input class="set-desc" type="text" name="description" value={selectedSet.description ?? ''} placeholder="Description (optional)" disabled={!canEdit} autocomplete="off" />
							{#if canEdit}<button type="submit" class="mini">Save</button>{/if}
						</form>

						<form method="POST" action="?/saveRules" use:enhance>
							<input type="hidden" name="mod" value={data.modId} />
							<input type="hidden" name="set_id" value={selectedSet.id} />
							<input type="hidden" name="rules" value={rulesJson} />
							<div class="grid">
								<div class="grid-head">
									<span class="gh-regex">Filename regular expression</span>
									{#each data.dataClasses as c (c.code)}
										<span class="gh-code" title={c.label}>{c.code}</span>
									{/each}
									<span class="gh-x"></span>
								</div>
								{#each rows as row, i}
									<div class="grid-row">
										<input class="g-regex" type="text" bind:value={row.regex} placeholder=".*_Eventlog_.*\.zip" disabled={!canEdit} autocomplete="off" spellcheck="false" />
										{#each codes as code (code)}
											<label class="g-cell" title={code}>
												<input type="checkbox" checked={row.codes.has(code)} onchange={() => toggleCode(row, code)} disabled={!canEdit} />
											</label>
										{/each}
										<button type="button" class="g-remove" onclick={() => removeRow(i)} disabled={!canEdit} title="Remove rule" aria-label="Remove rule">✕</button>
									</div>
								{/each}
								{#if canEdit}
									<button type="button" class="g-add" onclick={addRow}>+ Add rule</button>
								{/if}
							</div>
							{#if canEdit}
								<div class="actions-bar">
									<button type="button" class="act-delete" onclick={() => (confirmDeleteSet = true)}>Delete set</button>
									<button type="submit" class="act-save">Save rules</button>
								</div>
							{/if}
						</form>

						<ConfirmDialog bind:open={confirmDeleteSet} title="Delete rule set?"
							message={`Delete "${selectedSet.name}" and all its rules and assignments? This cannot be undone.`}>
							<form method="POST" action="?/deleteSet" use:enhance={() => async ({ update }) => { confirmDeleteSet = false; await update(); }}>
								<input type="hidden" name="mod" value={data.modId} />
								<input type="hidden" name="id" value={selectedSet.id} />
								<button type="submit" class="act-delete">Delete</button>
							</form>
						</ConfirmDialog>
					{/key}
				{/if}
			</section>
		</div>

	<!-- ========================= ASSIGNMENTS =========================== -->
	{:else if data.view === 'assign'}
		{#if data.sets.length === 0}
			<p class="empty">No rule sets yet. Create some under Rule Sets first.</p>
		{:else}
			<div class="matrix-wrap">
				<table class="matrix">
					<thead>
						<tr>
							<th class="mx-row-head">Product / family</th>
							{#each data.sets as s (s.id)}<th class="mx-col" title={s.name}><span>{s.name}</span></th>{/each}
						</tr>
					</thead>
					<tbody>
						<tr class="mx-modality">
							<th class="mx-row-head">All products (modality-wide)</th>
							{#each data.sets as s (s.id)}
								<td>
									<form method="POST" action="?/toggleAssign" use:enhance>
										<input type="hidden" name="mod" value={data.modId} />
										<input type="hidden" name="set_id" value={s.id} />
										<input type="hidden" name="target" value="modality" />
										<button type="submit" class="cell" class:on={assignedModality.has(s.id)} disabled={!canEdit} aria-label="Toggle modality-wide assignment"></button>
									</form>
								</td>
							{/each}
						</tr>
						{#each groups as g (g.family ?? '__none__')}
							{#if g.family}
								<tr class="mx-family">
									<th class="mx-row-head">Family: {g.family}</th>
									{#each data.sets as s (s.id)}
										<td>
											<form method="POST" action="?/toggleAssign" use:enhance>
												<input type="hidden" name="mod" value={data.modId} />
												<input type="hidden" name="set_id" value={s.id} />
												<input type="hidden" name="target" value={`family:${g.family}`} />
												<button type="submit" class="cell" class:on={assignedFamily.has(`${s.id}|${g.family}`)} disabled={!canEdit} aria-label="Toggle family assignment"></button>
											</form>
										</td>
									{/each}
								</tr>
							{/if}
							{#each g.products as p (p.id)}
								<tr>
									<th class="mx-row-head mx-product" class:indent={g.family}>{p.name}</th>
									{#each data.sets as s (s.id)}
										<td>
											<form method="POST" action="?/toggleAssign" use:enhance>
												<input type="hidden" name="mod" value={data.modId} />
												<input type="hidden" name="set_id" value={s.id} />
												<input type="hidden" name="target" value={`product:${p.id}`} />
												<button type="submit" class="cell" class:on={assignedProduct.has(`${s.id}|${p.id}`)} disabled={!canEdit} aria-label="Toggle product assignment"></button>
											</form>
										</td>
									{/each}
								</tr>
							{/each}
						{/each}
					</tbody>
				</table>
			</div>
			<p class="hint">A filled cell = the set applies. Modality-wide and family rows fan out to every product beneath them; the effective per-product result (the union) is shown under Preview.</p>
		{/if}

	<!-- ========================= PREVIEW =============================== -->
	{:else if data.view === 'preview'}
		<div class="preview-head">
			<p class="hint">Effective classification per product - exactly what is written to Valkey (<code>data_classes:{data.modalities.find((m) => m.id === data.modId)?.name}:&lt;product&gt;</code>).</p>
			{#if canEdit}
				<form method="POST" action="?/syncValkey" use:enhance>
					<input type="hidden" name="mod" value={data.modId} />
					<button type="submit" class="act-save">Sync to Valkey</button>
				</form>
			{/if}
		</div>
		{#if previewProducts.length === 0}
			<p class="empty">No products in this modality resolve to any classification yet.</p>
		{:else}
			<div class="preview-list">
				{#each previewProducts as p (p.productId)}
					<div class="pv-card">
						<h4>{p.productName}{#if p.family}<span class="pv-fam">{p.family}</span>{/if}</h4>
						<table class="pv-table">
							<tbody>
								{#each p.fields as f (f.regex)}
									<tr>
										<td class="pv-regex">/{f.regex}/</td>
										<td class="pv-codes">{f.codes.join(', ')}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/each}
			</div>
		{/if}
	{/if}
</div>

<style>
	.dc { display: flex; flex-direction: column; min-height: 0; flex: 1; gap: 0.9rem; }
	.msg { margin: 0; padding: 0.5rem 0.75rem; border-radius: var(--radius); font-size: 0.85rem; }
	.msg.error { background: color-mix(in srgb, var(--danger) 14%, transparent); color: var(--danger); }
	.msg.ok { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
	.empty { color: var(--text-subtle); font-size: 0.9rem; padding: 1rem 0; }
	.hint { color: var(--text-subtle); font-size: 0.78rem; margin: 0.6rem 0 0; }
	code { font-family: monospace; font-size: 0.82em; color: var(--text-muted); }

	.bar { display: flex; align-items: flex-end; gap: 1.6rem; flex-wrap: wrap; }
	.mod-pick { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-subtle); }
	.mod-pick select {
		background: var(--surface); color: var(--text); border: 1px solid var(--border);
		border-radius: var(--radius); padding: 0.4rem 0.6rem; font: inherit; font-size: 0.9rem; min-width: 12rem;
	}
	.subtabs { display: flex; gap: 1.2rem; border-bottom: 1px solid var(--border); flex: 1; }
	.subtabs a { padding: 0.5rem 0.1rem; color: var(--text-muted); text-decoration: none; font-size: 0.88rem; border-bottom: 2px solid transparent; margin-bottom: -1px; }
	.subtabs a:hover { color: var(--text); }
	.subtabs a.active { color: var(--text); border-bottom-color: var(--accent); }

	/* rule sets */
	.cols { display: grid; grid-template-columns: 17rem 1fr; gap: 1.2rem; min-height: 0; flex: 1; }
	.col-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 0.5rem; }
	h3 { font-size: 1rem; margin: 0; }
	.count { color: var(--text-subtle); font-weight: 400; font-size: 0.82rem; }
	.set-list { display: flex; flex-direction: column; gap: 0.2rem; min-height: 0; }
	.set-scroll { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 0.2rem; padding-right: 2px; }
	.set-detail { min-height: 0; overflow-y: auto; padding-right: 4px; }
	.set-item { display: flex; flex-direction: column; gap: 0.1rem; padding: 0.5rem 0.6rem; border: 1px solid var(--border); border-radius: var(--radius); text-decoration: none; color: var(--text); }
	.set-item:hover { background: var(--surface-2); }
	.set-item.active { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
	.set-name { font-size: 0.9rem; }
	.set-meta { font-size: 0.72rem; color: var(--text-subtle); }
	.new-set { display: flex; gap: 0.4rem; margin-top: 0.4rem; }
	.new-set input { flex: 1; min-width: 0; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.4rem 0.5rem; font: inherit; font-size: 0.85rem; }
	.new-set button { background: var(--surface-2); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0 0.7rem; font: inherit; font-size: 0.85rem; cursor: pointer; }

	.set-head { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.9rem; flex-wrap: wrap; }
	.set-title { font-size: 1rem; font-weight: 600; background: transparent; color: var(--text); border: none; border-bottom: 1px solid var(--border); padding: 0.2rem 0; outline: none; }
	.set-title:focus { border-bottom-color: var(--accent); }
	.set-desc { flex: 1; min-width: 12rem; background: transparent; color: var(--text-muted); border: none; border-bottom: 1px solid var(--border); padding: 0.2rem 0; font: inherit; font-size: 0.85rem; outline: none; }
	.set-desc:focus { border-bottom-color: var(--accent); }
	.mini { background: var(--surface-2); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.3rem 0.7rem; font: inherit; font-size: 0.8rem; cursor: pointer; }

	/* grid editor */
	.grid { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
	.grid-head, .grid-row {
		display: grid;
		grid-template-columns: minmax(200px, 1fr) repeat(8, 34px) 30px;
		align-items: stretch;
	}
	.grid-head { background: var(--surface-2); font-size: 0.66rem; font-weight: 600; color: var(--text-subtle); text-transform: uppercase; letter-spacing: 0.04em; }
	.grid-head > span { padding: 6px 4px; text-align: center; border-right: 1px solid var(--border); }
	.gh-regex { text-align: left !important; padding-left: 10px !important; }
	.gh-x { border-right: none !important; }
	.grid-row { border-top: 1px solid var(--border); }
	.g-regex { background: transparent; color: var(--text); border: none; border-right: 1px solid var(--border); padding: 7px 10px; font-family: monospace; font-size: 0.84rem; outline: none; width: 100%; min-width: 0; }
	.g-regex:focus { background: var(--bg-app); box-shadow: inset 0 0 0 2px var(--focus); }
	.g-cell { display: flex; align-items: center; justify-content: center; border-right: 1px solid var(--border); cursor: pointer; }
	.g-cell:has(input:disabled) { cursor: default; }
	.g-remove { background: transparent; color: var(--text-subtle); border: none; cursor: pointer; font-size: 0.8rem; }
	.g-remove:hover:not(:disabled) { color: var(--danger); }
	.g-add { display: block; width: 100%; background: transparent; color: var(--accent); border: none; border-top: 1px solid var(--border); padding: 8px 14px; font-size: 0.83rem; cursor: pointer; text-align: left; }
	.g-add:hover { background: var(--surface-2); }

	.actions-bar { display: flex; align-items: center; gap: 0.6rem; margin-top: 1rem; }
	.act-save { margin-left: auto; background: var(--accent); color: var(--on-accent); border: none; border-radius: var(--radius); padding: 0.45rem 0.9rem; font: inherit; font-weight: 600; font-size: 0.85rem; cursor: pointer; }
	.act-save:hover { background: var(--accent-hover); }
	.act-delete { background: transparent; color: var(--danger); border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--border)); border-radius: var(--radius); padding: 0.45rem 0.9rem; font: inherit; font-size: 0.85rem; cursor: pointer; }
	.act-delete:hover { background: color-mix(in srgb, var(--danger) 12%, transparent); }

	/* assignment matrix */
	.matrix-wrap { overflow: auto; border: 1px solid var(--border); border-radius: var(--radius); }
	.matrix { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
	.matrix th, .matrix td { border-bottom: 1px solid var(--border); }
	.matrix thead th { position: sticky; top: 0; background: var(--surface-2); z-index: 2; }
	/* Top-left corner: sticky in both axes, so it must sit above the column
	   headers (z 2) and the row headers (z 1) as they scroll underneath. */
	.matrix thead .mx-row-head { z-index: 3; background: var(--surface-2); }
	.mx-col { padding: 0.5rem 0.4rem; text-align: center; vertical-align: bottom; min-width: 40px; max-width: 90px; }
	.mx-col span { display: inline-block; font-size: 0.72rem; line-height: 1.1; word-break: break-word; }
	.mx-row-head { text-align: left; padding: 0.45rem 0.7rem; font-weight: 500; white-space: nowrap; position: sticky; left: 0; background: var(--surface); z-index: 1; }
	.mx-product.indent { padding-left: 1.6rem; font-weight: 400; color: var(--text-muted); }
	.mx-modality .mx-row-head, .mx-family .mx-row-head { font-weight: 600; background: var(--surface-2); }
	.mx-modality td, .mx-family td { background: color-mix(in srgb, var(--accent) 5%, transparent); }
	.matrix td { text-align: center; padding: 0.2rem; }
	.matrix td form { margin: 0; display: flex; justify-content: center; }
	.cell { width: 15px; height: 15px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); cursor: pointer; padding: 0; }
	.cell:hover:not(:disabled) { border-color: var(--check-on); }
	.cell.on { background: var(--check-on); border-color: var(--check-on); }
	.cell:disabled { cursor: default; opacity: 0.7; }

	/* preview */
	.preview-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
	.preview-head .hint { margin: 0; }
	.preview-list { display: flex; flex-direction: column; gap: 0.9rem; margin-top: 0.4rem; }
	.pv-card { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
	.pv-card h4 { margin: 0; padding: 0.5rem 0.75rem; background: var(--surface-2); font-size: 0.9rem; display: flex; align-items: center; gap: 0.6rem; }
	.pv-fam { font-size: 0.72rem; color: var(--text-subtle); font-weight: 400; }
	.pv-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
	.pv-table td { padding: 0.35rem 0.75rem; border-top: 1px solid var(--border); }
	.pv-regex { font-family: monospace; color: var(--text); width: 70%; word-break: break-all; }
	.pv-codes { color: var(--accent); font-weight: 600; white-space: nowrap; }
</style>
