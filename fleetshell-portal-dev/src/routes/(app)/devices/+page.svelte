<script lang="ts">
	import { base } from '$app/paths';
	import { page as pageState } from '$app/state';
	import { goto } from '$app/navigation';
	import { enhance } from '$app/forms';
	import SplitPane from '$lib/components/SplitPane.svelte';
	import EntityPicker from '$lib/components/EntityPicker.svelte';

	let { data, form } = $props();

	// local search box seeded from the URL; submitted via the form (stage 1).
	let q = $state(data.q);
	$effect(() => { q = data.q; });

	// Count (approach A): carried in the URL while paging (data.total is a number);
	// when the filter changes (data.total === null) the client fetches it once.
	let fetchedCount = $state<number | null>(null);
	let countLoading = $state(false);
	const effectiveTotal = $derived(data.total ?? fetchedCount);
	$effect(() => {
		const qq = data.q, mm = data.mode;
		if (data.total !== null) { fetchedCount = null; countLoading = false; return; }
		countLoading = true; fetchedCount = null;
		const p = new URLSearchParams({ q: qq });
		if (mm === 'all') p.set('mode', 'all');
		fetch(`${base}/devices/count?${p}`)
			.then((r) => (r.ok ? r.json() : { total: null }))
			.then((j) => { fetchedCount = j.total ?? null; countLoading = false; })
			.catch(() => { countLoading = false; });
	});
	function pageLink(dir: 'prev' | 'next'): string {
		const ch: Record<string, string | null> = dir === 'next'
			? { after: data.nextCursor, before: null, page: String(data.page + 1) }
			: { before: data.prevCursor, after: null, page: String(Math.max(1, data.page - 1)) };
		if (effectiveTotal !== null) ch.n = String(effectiveTotal);
		return withParams(ch);
	}

	function withParams(changes: Record<string, string | null>): string {
		const u = new URLSearchParams(pageState.url.searchParams);
		for (const [k, v] of Object.entries(changes)) v === null ? u.delete(k) : u.set(k, v);
		return `${base}/devices?${u}`;
	}
	const selHref = (id: string) => withParams({ sel: id, new: null });
	const newHref = $derived(withParams({ new: '1', sel: null }));
	function setMode(m: string) { return withParams({ mode: m, after: null, before: null, page: null, sel: null }); }
	function confirmSubmit(e: SubmitEvent, msg: string) { if (!confirm(msg)) e.preventDefault(); }

	const canEdit = $derived(data.isAdmin);
	const d = $derived(data.detail as Record<string, string | null> | null);
</script>

<SplitPane storageKey="devices" defaultLeft={52}>
	{#snippet left()}
		<div class="col-head">
			<h2>Devices <span class="count">{data.total}</span></h2>
			<div class="head-actions">
				{#if data.isAdmin}
					<div class="modes">
						<a class:active={data.mode === 'scope'} href={setMode('scope')}>My scope</a>
						<a class:active={data.mode === 'all'} href={setMode('all')}>All devices</a>
					</div>
					<a class="new-btn" href={newHref}>+ New</a>
				{/if}
			</div>
		</div>

		<form method="GET" action={`${base}/devices`} class="searchbar">
			{#if data.mode === 'all'}<input type="hidden" name="mode" value="all" />{/if}
			<input name="q" bind:value={q} placeholder="serial / functional location / IP  ·  sn: fl: ip: tid: host: ord:" autocomplete="off" spellcheck="false" />
			<button type="submit">Search</button>
			{#if data.q}<a class="clear" href={setMode(data.mode)}>Clear</a>{/if}
		</form>

		<div class="card list">
			<table>
				<thead>
					<tr><th>serial</th><th>func. loc.</th><th>model</th><th>IP</th><th>customer / hospital</th></tr>
				</thead>
				<tbody>
					{#each data.devices as dev (dev.id)}
						<tr class:sel={dev.id === data.sel} onclick={() => goto(selHref(dev.id), { keepFocus: true, noScroll: true })}>
							<td class="mono">{dev.serial ?? ''}</td>
							<td class="mono">{dev.functional_location ?? ''}</td>
							<td><div class="model-cell">{dev.model_name ?? ''}</div>{#if dev.product_name}<div class="sub">{dev.product_name}</div>{/if}</td>
							<td class="mono">{dev.ip_address ?? ''}</td>
							<td>{dev.customer_name ?? dev.hospital_name ?? ''}</td>
						</tr>
					{:else}
						<tr><td colspan="5" class="empty">No devices{data.q ? ' match' : ' in scope'}.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>

		<div class="pager">
			<a class="pg" class:disabled={!data.hasPrev} href={data.hasPrev ? pageLink('prev') : '#'}>‹ Prev</a>
			<span class="range">
				{data.from}–{data.to} of
				{#if effectiveTotal !== null}{effectiveTotal.toLocaleString()}{:else}<span class="spin" title="counting…">⟳</span>{/if}
			</span>
			<a class="pg" class:disabled={!data.hasNext} href={data.hasNext ? pageLink('next') : '#'}>Next ›</a>
		</div>
	{/snippet}

	{#snippet right()}
		{#if form?.error}<p class="error">{form.error}</p>{/if}

		{#if data.isNew}
			<div class="card detail">
				<h3>New device</h3>
				<form method="POST" action="?/createDevice" use:enhance>
					{@render fields(null, true)}
					<button type="submit" class="save">Create device</button>
				</form>
			</div>
		{:else if d}
			<div class="card detail">
				<div class="dhead">
					<h3>{d.serial || '(no serial)'}</h3>
					<span class="model">{d.model_name ?? ''}</span>
				</div>
				<p class="path">{d.modality_name ?? '?'} / {d.product_name ?? '?'} / {d.model_name ?? '?'}</p>

				<form method="POST" action="?/updateDevice" use:enhance>
					<input type="hidden" name="id" value={d.id} />
					{@render fields(d, canEdit)}
					{#if canEdit}
						<button type="submit" class="save">Save device</button>
					{/if}
				</form>

				{#if canEdit}
					<div class="danger-zone">
						<form method="POST" action="?/deleteDevice" use:enhance
						      onsubmit={(e) => confirmSubmit(e, `Delete device "${d?.serial || d?.id}"? This cannot be undone.`)}>
							<input type="hidden" name="id" value={d.id} />
							<button type="submit" class="danger-btn">Delete device</button>
						</form>
					</div>
				{/if}
			</div>
		{:else}
			<div class="card placeholder">Select a device, or search.</div>
		{/if}
	{/snippet}
</SplitPane>

{#snippet fields(x: Record<string, string | null> | null, edit: boolean)}
	<div class="grid2">
		<label>Serial<input name="serial" value={x?.serial ?? ''} disabled={!edit} /></label>
		<label>Functional location<input name="functional_location" value={x?.functional_location ?? ''} disabled={!edit} /></label>
		<label>Technical ident<input name="technical_ident" value={x?.technical_ident ?? ''} disabled={!edit} /></label>
		<label>Host / hardware ID<input name="host_hw_id" value={x?.host_hw_id ?? ''} disabled={!edit} /></label>
		<label>Order number<input name="order_number" value={x?.order_number ?? ''} disabled={!edit} /></label>
		<label>Software version<input name="software_version" value={x?.software_version ?? ''} disabled={!edit} /></label>
		<label>IP address<input name="ip_address" value={x?.ip_address ?? ''} disabled={!edit} /></label>
		<label>IP (real)<input name="ip_real" value={x?.ip_real ?? ''} disabled={!edit} /></label>
		<label class="wide">Hospital<input name="hospital_name" value={x?.hospital_name ?? ''} disabled={!edit} /></label>
		<label class="wide">Contact<input name="contact" value={x?.contact ?? ''} disabled={!edit} /></label>
		<label>Access requirement
			<select name="access_requirement" value={x?.access_requirement ?? 'open'} disabled={!edit}>
				<option value="open">open</option><option value="device">device</option>
				<option value="customer">customer</option><option value="site">site</option>
			</select>
		</label>
	</div>

	<h4>Relations</h4>
	<div class="rel">
		<span class="rlabel">Product model</span>
		<EntityPicker api="/api/administration/models" name="product_path" idField="path" labelField="display"
			value={x?.product_path ?? null} label={x?.model_name ?? null} disabled={!edit} placeholder="search model..." />
		<span class="rlabel">Region</span>
		<EntityPicker api="/api/administration/regions" name="region_path" idField="path" labelField="name"
			value={x?.region_path ?? null} label={x?.region_name ?? null} disabled={!edit} placeholder="search region..." />
		<span class="rlabel">Customer</span>
		<EntityPicker api="/api/administration/customers" name="customer_id" idField="id" labelField="name"
			value={x?.customer_id ?? null} label={x?.customer_name ?? null} disabled={!edit} placeholder="search customer..." />
		<span class="rlabel">Site</span>
		<EntityPicker api="/api/administration/sites" name="site_id" idField="id" labelField="name"
			value={x?.site_id ?? null} label={x?.site_name ?? null} disabled={!edit} placeholder="search site..." />
		<span class="rlabel">Gateway</span>
		<EntityPicker api="/api/administration/gateways" name="gateway_id" idField="id" labelField="dns_name"
			value={x?.gateway_id ?? null} label={x?.gateway_dns ?? null} disabled={!edit} placeholder="search gateway..." />
	</div>
{/snippet}

<style>
	.col-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.6rem; gap: 0.6rem; flex: none; }
	h2 { font-size: 1rem; margin: 0; }
	.count { color: var(--text-subtle); font-weight: 400; font-size: 0.85rem; }
	.head-actions { display: flex; align-items: center; gap: 0.6rem; }
	.modes { display: flex; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
	.modes a { padding: 0.25rem 0.6rem; font-size: 0.78rem; color: var(--text-muted); text-decoration: none; }
	.modes a.active { background: var(--surface-active); color: var(--text); box-shadow: inset 0 -2px 0 var(--accent); }
	.new-btn { background: var(--accent); color: var(--on-accent); text-decoration: none; border-radius: var(--radius); padding: 0.3rem 0.6rem; font-size: 0.8rem; font-weight: 600; }
	.new-btn:hover { background: var(--accent-hover); }

	.searchbar { display: flex; gap: 0.4rem; margin-bottom: 0.6rem; flex: none; align-items: center; }
	.searchbar input { flex: 1; background: var(--bg-app); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.45rem 0.6rem; font: inherit; font-size: 0.85rem; }
	.searchbar input:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	.searchbar button { background: var(--accent); color: var(--on-accent); border: none; border-radius: var(--radius); padding: 0.45rem 0.8rem; font: inherit; font-weight: 600; font-size: 0.83rem; cursor: pointer; }
	.searchbar .clear { color: var(--text-subtle); font-size: 0.8rem; text-decoration: none; }
	.searchbar .clear:hover { text-decoration: underline; }

	.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
	.list { flex: 1; min-height: 0; overflow-y: auto; padding: 0.2rem 0.3rem; }
	table { width: 100%; border-collapse: collapse; }
	th, td { text-align: left; padding: 0.4rem 0.55rem; border-bottom: 1px solid var(--divider); vertical-align: top; }
	th { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-subtle); position: sticky; top: 0; background: var(--surface); }
	td { font-size: 0.83rem; }
	.mono { font-variant-numeric: tabular-nums; }
	.model-cell { line-height: 1.2; }
	.sub { color: var(--text-subtle); font-size: 0.72rem; line-height: 1.2; }
	tbody tr { cursor: pointer; }
	tbody tr:hover td { background: var(--surface-2); }
	tbody tr.sel td { background: var(--surface-active); }
	tbody tr:last-child td { border-bottom: none; }
	.empty { color: var(--text-subtle); text-align: center; padding: 1.4rem; cursor: default; }

	.pager { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; padding: 0.5rem 0.2rem 0; flex: none; }
	.pg { color: var(--accent); text-decoration: none; font-size: 0.82rem; }
	.pg.disabled { color: var(--text-subtle); pointer-events: none; }
	.range { color: var(--text-subtle); font-size: 0.78rem; }
	.spin { display: inline-block; animation: spin 0.9s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }

	.detail { padding: 0.9rem; }
	.placeholder { padding: 2rem; text-align: center; color: var(--text-subtle); }
	.dhead { display: flex; align-items: baseline; gap: 0.6rem; }
	h3 { font-size: 0.98rem; margin: 0; }
	.model { color: var(--text-muted); font-size: 0.85rem; }
	.path { font-size: 0.76rem; color: var(--text-subtle); margin: 0.2rem 0 0.9rem; }
	h4 { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-subtle); margin: 1.2rem 0 0.5rem; }

	.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem 0.9rem; }
	.grid2 .wide { grid-column: 1 / -1; }
	label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.76rem; color: var(--text-muted); }
	input, select { background: var(--bg-app); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.4rem 0.55rem; font: inherit; font-size: 0.84rem; }
	input:focus-visible, select:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	input:disabled, select:disabled { color: var(--text-muted); opacity: 0.85; }

	.rel { display: grid; grid-template-columns: 8rem 1fr; gap: 0.5rem 0.8rem; align-items: start; }
	.rlabel { align-self: center; font-size: 0.76rem; color: var(--text-muted); }

	.save { margin-top: 1rem; background: var(--accent); color: var(--on-accent); border: none; border-radius: var(--radius); padding: 0.5rem 0.9rem; font: inherit; font-weight: 600; font-size: 0.85rem; cursor: pointer; }
	.save:hover { background: var(--accent-hover); }
	.danger-zone { margin-top: 1.3rem; padding-top: 0.8rem; border-top: 1px solid var(--divider); }
	.danger-btn { background: var(--danger); color: #fff; border: none; border-radius: var(--radius); padding: 0.4rem 0.8rem; font: inherit; font-size: 0.82rem; font-weight: 600; cursor: pointer; }
	.danger-btn:hover { background: color-mix(in srgb, var(--danger) 82%, #000); }
	.error { color: var(--danger); font-size: 0.85rem; margin: 0 0 0.8rem; }
</style>
