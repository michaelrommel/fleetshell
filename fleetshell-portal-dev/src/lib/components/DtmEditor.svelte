<script lang="ts">
	import { enhance } from '$app/forms';
	import type { DataClass, Country } from '$lib/server/dtm';

	type MatrixData = {
		classes: DataClass[];
		countries: Country[];
		from: string;
		variant: string;
		matrix: { defined: boolean; deny: Record<string, string[]> } | null;
		isAdmin: boolean;
	};
	let { data }: { data: MatrixData } = $props();

	const canEdit = $derived(data.isAdmin);

	// Column groups: data classes grouped by kind (file / connection / distribution).
	const KIND_ORDER = ['file', 'connection', 'distribution'];
	const groups = KIND_ORDER
		.map((kind) => ({ kind, classes: data.classes.filter((c) => c.kind === kind) }))
		.filter((g) => g.classes.length);

	// Editable denial state: to_iso -> Set(class_code). Initialised ONCE at mount
	// from props; the parent remounts this component (via {#key}) when the FROM
	// country or variant changes, so there is no reactive re-init loop. Reading
	// data.matrix once here is intentional (the {#key} handles re-init).
	// svelte-ignore state_referenced_locally
	let deny = $state<Map<string, Set<string>>>(
		new Map(Object.entries(data.matrix?.deny ?? {}).map(([to, codes]) => [to, new Set(codes)])),
	);
	let dirty = $state(false);

	const isDenied = (to: string, code: string) => deny.get(to)?.has(code) ?? false;

	function setCell(to: string, code: string, denied: boolean) {
		const s = new Set(deny.get(to) ?? []);
		denied ? s.add(code) : s.delete(code);
		const m = new Map(deny);
		s.size ? m.set(to, s) : m.delete(to);
		deny = m;
		dirty = true;
	}
	const toggle = (to: string, code: string) => setCell(to, code, !isDenied(to, code));

	function setRow(to: string, denied: boolean) {
		const m = new Map(deny);
		if (denied) m.set(to, new Set(data.classes.map((c) => c.code)));
		else m.delete(to);
		deny = m;
		dirty = true;
	}
	function setColumn(code: string, denied: boolean) {
		const m = new Map(deny);
		for (const c of visibleRows) {
			const s = new Set(m.get(c.iso) ?? []);
			denied ? s.add(code) : s.delete(code);
			s.size ? m.set(c.iso, s) : m.delete(c.iso);
		}
		deny = m;
		dirty = true;
	}

	// Row visibility: a filter overrides the exceptions-only view.
	let filter = $state('');
	let exceptionsOnly = $state(true);
	const visibleRows = $derived.by(() => {
		const f = filter.trim().toLowerCase();
		return data.countries.filter((c) => {
			if (f) return c.name.toLowerCase().includes(f) || c.iso.toLowerCase().includes(f);
			if (exceptionsOnly) return (deny.get(c.iso)?.size ?? 0) > 0;
			return true;
		});
	});

	const denyCells = $derived([...deny.values()].reduce((n, s) => n + s.size, 0));
	const denyDests = $derived([...deny.values()].filter((s) => s.size).length);
	const denyJson = $derived(JSON.stringify(Object.fromEntries([...deny].map(([to, s]) => [to, [...s]]))));
</script>

<div class="dtm-editor">
<div class="controls">
	<input class="search" placeholder="Filter destinations" bind:value={filter} />
	<label class="chk"><input type="checkbox" bind:checked={exceptionsOnly} disabled={!!filter.trim()} /> Show only exceptions</label>
	<span class="stat">{denyCells} denied · {denyDests} dest.{#if dirty} · <b class="dirty">unsaved</b>{/if}</span>
	<div class="spacer"></div>
	{#if canEdit}
		<form method="POST" action="?/save" use:enhance={() => async ({ result, update }) => { if (result.type === 'success') dirty = false; await update({ reset: false }); }}>
			<input type="hidden" name="from" value={data.from} />
			<input type="hidden" name="variant" value={data.variant} />
			<input type="hidden" name="deny" value={denyJson} />
			<button type="submit" class="act-save" disabled={!dirty}>Save</button>
		</form>
		<form method="POST" action="?/export" use:enhance>
			<input type="hidden" name="from" value={data.from} />
			<button type="submit" class="act-export" disabled={dirty} title={dirty ? 'Save first' : 'Spool this country to Valkey'}>Sync to Valkey</button>
		</form>
	{/if}
</div>

<div class="legend">
	<span><i class="sw permit"></i> permitted (default)</span>
	<span><i class="sw deny"></i> denied</span>
	<span class="hint">Click a cell to toggle · click a class header or a row's ✓/✗ to bulk-set the visible rows.</span>
</div>

<div class="grid-wrap">
	<table class="grid">
		<thead>
			<tr class="grp">
				<th class="corner" rowspan="2">Destination <span class="iso">↓ / class →</span></th>
				{#each groups as g (g.kind)}
					<th class="grp-h" colspan={g.classes.length}>{g.kind}</th>
				{/each}
			</tr>
			<tr>
				{#each groups as g (g.kind)}
					{#each g.classes as c (c.code)}
						<th class="cls" title={c.label}>
							<button class="clsbtn" onclick={() => canEdit && setColumn(c.code, true)} disabled={!canEdit} title={`Deny "${c.label}" for all visible`}>{c.code}</button>
						</th>
					{/each}
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each visibleRows as c (c.iso)}
				<tr>
					<th class="dest">
						<span class="dn" title={c.name}>{c.name}</span>
						<span class="iso">{c.iso}</span>
						{#if canEdit}
							<span class="rowbulk">
								<button title="Permit all" onclick={() => setRow(c.iso, false)}>✓</button>
								<button title="Deny all" onclick={() => setRow(c.iso, true)}>✗</button>
							</span>
						{/if}
					</th>
					{#each groups as g (g.kind)}
						{#each g.classes as cl (cl.code)}
							<td>
								<button
									class="cell"
									class:deny={isDenied(c.iso, cl.code)}
									disabled={!canEdit}
									aria-label={`${c.name} ${cl.code}: ${isDenied(c.iso, cl.code) ? 'denied' : 'permitted'}`}
									onclick={() => toggle(c.iso, cl.code)}
								></button>
							</td>
						{/each}
					{/each}
				</tr>
			{:else}
				<tr><td class="empty" colspan={data.classes.length + 1}>
					{filter.trim() ? 'No destinations match.' : 'No exceptions — every destination is fully permitted. Untick “Show only exceptions” or search to add one.'}
				</td></tr>
			{/each}
		</tbody>
	</table>
</div>
</div>

<style>
	/* Cell mark colours (dark green = permitted, dark red = denied). display:contents
	   keeps the children in the parent's flex layout while carrying the vars. */
	.dtm-editor { display: contents; --dtm-permit: #2b7a44; --dtm-deny: #973a3a; }
	.controls { display: flex; align-items: center; gap: 0.8rem; margin-bottom: 0.5rem; }
	.search { background: var(--bg-app); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.4rem 0.55rem; font: inherit; font-size: 0.85rem; width: 14rem; }
	.chk { display: flex; align-items: center; gap: 0.35rem; font-size: 0.82rem; color: var(--text-muted); white-space: nowrap; }
	.stat { font-size: 0.78rem; color: var(--text-subtle); white-space: nowrap; }
	.stat .dirty { color: var(--warning, #d79921); }
	.spacer { flex: 1; }
	.act-save, .act-export { border: none; border-radius: var(--radius); padding: 0.45rem 0.9rem; font: inherit; font-weight: 600; font-size: 0.85rem; cursor: pointer; }
	.act-save { background: var(--accent); color: var(--on-accent); }
	.act-export { background: var(--accent); color: var(--on-accent); }
	.act-save:hover:not(:disabled), .act-export:hover:not(:disabled) { background: var(--accent-hover); }
	.act-save:disabled, .act-export:disabled { opacity: 0.45; cursor: not-allowed; }

	.legend { display: flex; gap: 1rem; align-items: center; font-size: 0.75rem; color: var(--text-subtle); margin-bottom: 0.5rem; flex-wrap: wrap; }
	.legend .sw { position: relative; display: inline-block; width: 12px; height: 12px; border-radius: 3px; vertical-align: -2px; margin-right: 3px; border: 1px solid var(--border); }
	.sw.permit { background: var(--dtm-permit); }
	.sw.deny { background: var(--dtm-deny); }
	.sw.deny::after { content: '✕'; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: rgba(255, 255, 255, 0.6); font-size: 8px; font-weight: 700; line-height: 1; }

	.grid-wrap { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius); }
	table.grid { border-collapse: separate; border-spacing: 0; font-size: 0.78rem; }
	.grid th, .grid td { border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); }
	.grid thead th { position: sticky; top: 0; z-index: 2; background: var(--bg-header); }
	.grid thead tr:nth-child(2) th { top: 26px; }
	.grp-h { text-transform: capitalize; font-size: 0.7rem; letter-spacing: 0.03em; color: var(--text-subtle); text-align: center; padding: 0.2rem 0.3rem; font-weight: 600; }
	.cls { padding: 0; height: 88px; vertical-align: bottom; }
	.clsbtn { writing-mode: vertical-rl; transform: rotate(180deg); background: none; border: none; color: var(--text-muted); font: inherit; font-size: 0.72rem; padding: 0.4rem 0.1rem; cursor: pointer; height: 100%; }
	.clsbtn:hover:not(:disabled) { color: var(--text); }

	.corner, .dest { position: sticky; left: 0; background: var(--bg-header); text-align: left; white-space: nowrap; }
	.corner { z-index: 3; padding: 0.4rem 0.6rem; font-size: 0.82rem; }
	.dest { z-index: 1; padding: 0.25rem 0.6rem; background: var(--surface); display: flex; align-items: center; gap: 0.4rem; }
	.dest .dn { flex: none; }
	.iso { color: var(--text-subtle); font-size: 0.68rem; }
	.rowbulk { margin-left: auto; display: inline-flex; gap: 2px; padding-left: 0.6rem; }
	.rowbulk button { width: 18px; height: 18px; line-height: 1; padding: 0; border: 1px solid var(--border); background: var(--surface-2); color: var(--text-muted); border-radius: 3px; cursor: pointer; font-size: 0.7rem; }
	.rowbulk button:hover { color: var(--text); }

	.grid td { padding: 2px 4px; text-align: center; }
	.cell { width: 100%; height: 22px; border: none; background: none; padding: 0; cursor: pointer; display: grid; place-items: center; }
	.cell::before { content: ''; grid-area: 1 / 1; width: 20px; height: 12px; border-radius: 4px; background: var(--dtm-permit); box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.22); transition: background 0.08s; }
	.cell.deny::before { background: var(--dtm-deny); }
	/* Colour-blind aid: denied pills also carry an explicit mark, not colour alone. */
	.cell.deny::after { content: '✕'; grid-area: 1 / 1; color: rgba(255, 255, 255, 0.6); font-size: 9px; font-weight: 700; line-height: 1; pointer-events: none; }
	.cell:hover:not(:disabled)::before { outline: 2px solid var(--focus); outline-offset: 1px; }
	.cell:disabled { cursor: default; }

	.empty { padding: 1.5rem; text-align: center; color: var(--text-subtle); position: static; }
</style>
