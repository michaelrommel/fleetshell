<script lang="ts">
	import { base } from '$app/paths';
	import { page as pageState } from '$app/state';
	import { goto } from '$app/navigation';
	import { enhance } from '$app/forms';
	import SplitPane from '$lib/components/SplitPane.svelte';
	import EntityPicker from '$lib/components/EntityPicker.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';

	let { data, form } = $props();
	let confirmDelete = $state(false);

	// local search box seeded from the URL; submitted via the form (stage 1).
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
	const cancelHref = $derived(withParams({ new: null, sel: null }));
	function setMode(m: string) { return withParams({ mode: m, after: null, before: null, page: null, sel: null }); }
	let searchInput: HTMLInputElement;
	function doSearch() {
		goto(withParams({ q: searchInput.value.trim() || null, after: null, before: null, page: null, n: null }), { keepFocus: true, noScroll: true });
	}
	function clearSearch() {
		searchInput.value = ''; searchInput.focus();
		goto(withParams({ q: null, after: null, before: null, page: null, n: null }), { keepFocus: true, noScroll: true });
	}

	const canEdit = $derived(data.isAdmin);
	const d = $derived(data.detail as Record<string, string | null> | null);
	type App = { name: string; application: string; ports: string; guac: boolean; e2ecrypt: boolean; sni: string; path: string; drive: boolean; record: boolean };
	const apps = $derived((data.detail?.apps ?? []) as App[]);
</script>

<SplitPane storageKey="devices" defaultLeft={52} overlay overlayActive={!!(data.sel || data.isNew)} closeHref={cancelHref}>
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

		<form method="GET" action={`${base}/devices`} class="searchbar" onsubmit={(e) => { e.preventDefault(); doSearch(); }}>
			{#if data.mode === 'all'}<input type="hidden" name="mode" value="all" />{/if}
			<div class="search-wrap">
				<input name="q" value={data.q} bind:this={searchInput} placeholder="serial / functional location / IP  ·  sn: fl: ip: tid: host: ord:" autocomplete="off" spellcheck="false" />
				{#if data.q}<button type="button" class="in-clear" onclick={clearSearch} aria-label="Clear search">✕</button>{/if}
			</div>
			<button type="submit">Search</button>
		</form>

		<div class="card list">
			<table>
				<thead>
					<tr><th>serial</th><th>func. loc.</th><th>model</th><th>IP</th><th>customer / hospital</th></tr>
				</thead>
				<tbody>
					{#each data.devices as dev (dev.id)}
						<tr class:sel={dev.id === data.sel} onclick={() => goto(selHref(dev.id), { keepFocus: true, noScroll: true })}>
							<td class="mono"><div>{dev.serial ?? ''}</div>{#if dev.partno}<div class="sub">{dev.partno}</div>{/if}</td>
							<td class="mono">{dev.functional_location ?? ''}</td>
							<td><div class="model-cell">{dev.model_name ?? ''}</div>{#if dev.product_name}<div class="sub">{dev.product_name}</div>{/if}</td>
							<td class="mono">{dev.ip_address ?? ''}</td>
							<td><div>{dev.customer_name ?? dev.hospital_name ?? ''}</div>{#if dev.city}<div class="sub">{dev.city}</div>{/if}</td>
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
					<div class="actions-bar">
						<a class="act-cancel" href={cancelHref}>Cancel</a>
						<button type="submit" class="act-primary">Create device</button>
					</div>
				</form>
			</div>
		{:else if d}
			<div class="card detail">
				<div class="dhead">
					<h3>{d.serial || '(no serial)'}</h3>
					<span class="model">{d.model_name ?? ''}</span>
				</div>
				<p class="path">{d.modality_name ?? '?'} / {d.product_name ?? '?'} / {d.model_name ?? '?'}</p>

				<h4 class="apps-head">Applications <span class="muted">· inherited from {d.model_name ?? 'model'}</span></h4>
				{#if apps.length}
					<div class="app-list">
						{#each apps as a}
							<div class="app-row">
								<span class="app-name">{a.name || '(unnamed)'}</span>
								<span class="app-proto">{a.application}</span>
								{#if a.ports}<span class="mono app-ports">{a.ports}</span>{/if}
								{#if a.guac}<span class="badge">guac</span>{/if}
								{#if a.e2ecrypt}<span class="badge">e2e</span>{/if}
								{#if a.record}<span class="badge rec">rec</span>{/if}
								{#if a.drive}<span class="badge">drive</span>{/if}
								{#if a.sni}<span class="app-extra">SNI {a.sni}</span>{/if}
								{#if a.path && a.path !== '/'}<span class="app-extra">{a.path}</span>{/if}
							</div>
						{/each}
					</div>
					<p class="muted apps-note">Defined on the product model. Per-device override is not enabled yet.</p>
				{:else}
					<p class="muted">No applications defined on this device's model.</p>
				{/if}

				<form method="POST" action="?/updateDevice" use:enhance>
					<input type="hidden" name="id" value={d.id} />
					{#key d.id}
						{@render fields(d, canEdit)}
					{/key}
					{#if canEdit}
						<div class="actions-bar">
							<button type="button" class="act-delete" onclick={() => (confirmDelete = true)}>Delete device</button>
							<button type="submit" class="act-primary">Save device</button>
						</div>
					{/if}
				</form>
			</div>
		{:else}
			<div class="card placeholder">Select a device, or search.</div>
		{/if}
	{/snippet}
</SplitPane>

{#if d}
	<ConfirmDialog bind:open={confirmDelete} title="Delete device?" message={`Delete "${d.serial || d.id}"? This cannot be undone.`}>
		<form method="POST" action="?/deleteDevice" use:enhance={() => async ({ update }) => { confirmDelete = false; await update(); }}>
			<input type="hidden" name="id" value={d.id} />
			<button type="submit" class="act-delete">Delete</button>
		</form>
	</ConfirmDialog>
{/if}

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
		<label>Access requirement
			<select name="access_requirement" value={x?.access_requirement ?? 'open'} disabled={!edit}>
				<option value="open">open</option><option value="device">device</option>
				<option value="customer">customer</option><option value="site">site</option>
			</select>
		</label>
		<label>Contact<input name="contact" value={x?.contact ?? ''} disabled={!edit} /></label>
		<label>Hospital<input name="hospital_name" value={x?.hospital_name ?? ''} disabled={!edit} /></label>
		<label>City<input name="city" value={x?.city ?? ''} disabled={!edit} /></label>
	</div>

	<h4>Relations</h4>
	<div class="rel-cols">
		<div class="rel">
			<span class="rlabel">Region</span>
			<EntityPicker api="/api/administration/regions" name="region_path" idField="path" labelField="name"
				value={x?.region_path ?? null} label={x?.region_name ?? null} disabled={!edit} placeholder="search region..." />
			<span class="rlabel">Product model</span>
			<EntityPicker api="/api/administration/models" name="product_path" idField="path" labelField="display"
				value={x?.product_path ?? null} label={x?.model_name ?? null} disabled={!edit} placeholder="search model..." />
			{#if x?.model_partno}
				<span class="rlabel"></span>
				<span class="partno-note">Part no <span class="mono">{x.model_partno}</span></span>
			{/if}
			<span class="rlabel">Gateway</span>
			<EntityPicker api="/api/administration/gateways" name="gateway_id" idField="id" labelField="name"
				value={x?.gateway_id ?? null} label={x?.gateway_name ?? null} disabled={!edit} placeholder="search gateway..." />
		</div>
		<div class="rel">
			<span class="rlabel">Customer</span>
			<span class="rval" class:unset={!x?.customer_name}>{x?.customer_name ?? 'not assigned'}</span>
			<span class="rlabel">Site</span>
			<span class="rval" class:unset={!x?.site_name}>{x?.site_name ?? 'not assigned'}</span>
			<span class="rlabel"></span>
			<span class="rel-note">Derived from site membership · manage in <a href={`${base}/customers`}>Customers / Sites</a></span>
		</div>
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
	.search-wrap { position: relative; flex: 1; display: flex; }
	.searchbar input { width: 100%; background: var(--bg-app); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.45rem 1.9rem 0.45rem 0.6rem; font: inherit; font-size: 0.85rem; }
	.searchbar input:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	.in-clear { position: absolute; right: 0.35rem; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--text-subtle); cursor: pointer; font-size: 0.8rem; line-height: 1; padding: 0.2rem; border-radius: var(--radius); }
	.in-clear:hover { color: var(--text); }
	.searchbar > button { background: var(--accent); color: var(--on-accent); border: none; border-radius: var(--radius); padding: 0.45rem 0.8rem; font: inherit; font-weight: 600; font-size: 0.83rem; cursor: pointer; }

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

	.rel-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem 1.4rem; align-items: start; }
	.rel { display: grid; grid-template-columns: 7rem 1fr; gap: 0.5rem 0.8rem; align-items: start; align-content: start; }
	.rlabel { align-self: center; font-size: 0.76rem; color: var(--text-muted); }
	.rval { align-self: center; font-size: 0.84rem; color: var(--text); padding: 0.4rem 0; }
	.rval.unset { color: var(--text-subtle); font-style: italic; }
	.rel-note { grid-column: 1 / -1; font-size: 0.72rem; color: var(--text-subtle); }
	.rel-note a { color: var(--accent); }
	.partno-note { align-self: center; font-size: 0.76rem; color: var(--text-subtle); }

	.apps-head { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-subtle); margin: 0.4rem 0 0.5rem; }
	.apps-head .muted { text-transform: none; letter-spacing: 0; }
	.app-list { display: flex; flex-direction: column; gap: 0.3rem; }
	.app-row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; font-size: 0.83rem; padding: 0.35rem 0.5rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); }
	.app-name { font-weight: 600; color: var(--text); }
	.app-proto { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--accent); }
	.app-ports { color: var(--text-muted); }
	.badge { font-size: 0.64rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-subtle); border: 1px solid var(--border); border-radius: 999px; padding: 0.02rem 0.4rem; }
	.badge.rec { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, transparent); }
	.app-extra { font-size: 0.74rem; color: var(--text-subtle); }
	.apps-note { margin: 0.5rem 0 0; }

	.error { color: var(--danger); font-size: 0.85rem; margin: 0 0 0.8rem; }
</style>
