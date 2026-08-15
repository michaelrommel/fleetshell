<script lang="ts">
	import { base } from '$app/paths';
	import { page as pageState } from '$app/state';
	import { goto } from '$app/navigation';
	import { enhance } from '$app/forms';
	import SplitPane from '$lib/components/SplitPane.svelte';
	import IpsecEditor from '$lib/components/IpsecEditor.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';

	let { data, form } = $props();
	let confirmDelete = $state(false);

	function withParams(changes: Record<string, string | null>): string {
		const u = new URLSearchParams(pageState.url.searchParams);
		for (const [k, v] of Object.entries(changes)) v === null ? u.delete(k) : u.set(k, v);
		return `${base}/gateways?${u}`;
	}
	const selHref = (id: string) => withParams({ sel: id, new: null });
	const newHref = $derived(withParams({ new: '1', sel: null }));
	const cancelHref = $derived(withParams({ new: null, sel: null }));
	function pageLink(dir: 'prev' | 'next'): string {
		return dir === 'next'
			? withParams({ after: data.nextCursor, before: null, page: String(data.page + 1) })
			: withParams({ before: data.prevCursor, after: null, page: String(Math.max(1, data.page - 1)) });
	}
	let searchInput: HTMLInputElement;
	function doSearch() {
		goto(withParams({ q: searchInput.value.trim() || null, after: null, before: null, page: null }), { keepFocus: true, noScroll: true });
	}
	function clearSearch() {
		searchInput.value = ''; searchInput.focus();
		goto(withParams({ q: null, after: null, before: null, page: null }), { keepFocus: true, noScroll: true });
	}

	const canEdit = $derived(data.isAdmin);
	const g = $derived(data.detail as Record<string, string | null> | null);
	const deviceHref = (id: string) => `${base}/devices?${data.isAdmin ? 'mode=all&' : ''}sel=${encodeURIComponent(id)}`;
</script>

<SplitPane storageKey="gateways" defaultLeft={52}>
	{#snippet left()}
		<div class="col-head">
			<h2>Gateways <span class="count">{data.total.toLocaleString()}</span></h2>
			{#if data.isAdmin}<a class="new-btn" href={newHref}>+ New</a>{/if}
		</div>

		<form method="GET" action={`${base}/gateways`} class="searchbar" onsubmit={(e) => { e.preventDefault(); doSearch(); }}>
			<div class="search-wrap">
				<input name="q" value={data.q} bind:this={searchInput} placeholder="name / hospital / city / IP  ·  name: hosp: city: ip:" autocomplete="off" spellcheck="false" />
				{#if data.q}<button type="button" class="in-clear" onclick={clearSearch} aria-label="Clear search">✕</button>{/if}
			</div>
			<button type="submit">Search</button>
		</form>

		<div class="card list">
			<table>
				<thead>
					<tr><th>name</th><th>hospital / city</th><th>region</th><th>model / link</th><th>public IP</th><th class="num">dev</th></tr>
				</thead>
				<tbody>
					{#each data.rows as gw (gw.id)}
						<tr class:sel={gw.id === data.sel} onclick={() => goto(selHref(gw.id), { keepFocus: true, noScroll: true })}>
							<td class="mono">{gw.name ?? ''}</td>
							<td><div>{gw.hospital}</div>{#if gw.city}<div class="sub">{gw.city}</div>{/if}</td>
							<td>{gw.region}</td>
							<td><div>{gw.gateway_model ?? ''}</div>{#if gw.connection_type}<div class="sub">{gw.connection_type}</div>{/if}</td>
							<td class="mono">{gw.public_ip ?? ''}</td>
							<td class="num">{gw.device_count}</td>
						</tr>
					{:else}
						<tr><td colspan="6" class="empty">No gateways{data.q ? ' match' : ''}.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>

		<div class="pager">
			<a class="pg" class:disabled={!data.hasPrev} href={data.hasPrev ? pageLink('prev') : '#'}>‹ Prev</a>
			<span class="range">{data.from}–{data.to} of {data.total.toLocaleString()}</span>
			<a class="pg" class:disabled={!data.hasNext} href={data.hasNext ? pageLink('next') : '#'}>Next ›</a>
		</div>
	{/snippet}

	{#snippet right()}
		{#if form?.error}<p class="error">{form.error}</p>{/if}

		{#if data.isNew}
			<div class="card detail">
				<h3>New gateway</h3>
				<form method="POST" action="?/createGateway" use:enhance>
					{@render editFields(null, true)}
					<h4>Tunnel / IPsec</h4>
					<IpsecEditor disabled={false} isCreate={true} />
					<div class="actions-bar">
						<a class="act-cancel" href={cancelHref}>Cancel</a>
						<button type="submit" class="act-primary">Create gateway</button>
					</div>
				</form>
			</div>
		{:else if g}
			<div class="card detail">
				<div class="dhead">
					<h3>{g.name || g.hostname || 'gateway'}</h3>
					{#if g.gateway_model}<span class="model">{g.gateway_model}</span>{/if}
				</div>

				<form method="POST" action="?/updateGateway" use:enhance>
					<input type="hidden" name="id" value={g.id} />
					{@render editFields(g, canEdit)}
					<h4>Tunnel / IPsec</h4>
					{#key g.id}
						<IpsecEditor publicIp={g.public_ip} psk={g.psk}
							ipsec={data.detail?.ipsec ?? null} disabled={!canEdit} />
					{/key}
					{#if canEdit}
						<div class="actions-bar">
							<button type="button" class="act-delete" onclick={() => (confirmDelete = true)}>Delete gateway</button>
							<button type="submit" class="act-primary">Save gateway</button>
						</div>
					{/if}
				</form>

				<h4>Devices on this interface <span class="count">{data.deviceTotal.toLocaleString()}</span></h4>
				{#if data.devices.length}
					<ul class="devs">
						{#each data.devices as dev (dev.id)}
							<li>
								<a href={deviceHref(dev.id)}><span class="mono">{dev.serial ?? '(no serial)'}</span></a>
								<span class="dmeta">{dev.model ?? ''}{#if dev.hospital} · {dev.hospital}{/if}{#if dev.city} · {dev.city}{/if}</span>
							</li>
						{/each}
					</ul>
					{#if data.deviceTotal > data.devices.length}
						<p class="muted">Showing first {data.devices.length} of {data.deviceTotal.toLocaleString()}.</p>
					{/if}
				{:else}
					<p class="muted">No devices reference this interface.</p>
				{/if}
			</div>
		{:else}
			<div class="card placeholder">Select a gateway, or search.</div>
		{/if}
	{/snippet}
</SplitPane>

{#if g}
	<ConfirmDialog bind:open={confirmDelete} title="Delete gateway?" message={`Delete "${g.name || g.hostname || 'gateway'}"? This cannot be undone.`}>
		<form method="POST" action="?/deleteGateway" use:enhance={() => async ({ update }) => { confirmDelete = false; await update(); }}>
			<input type="hidden" name="id" value={g.id} />
			<button type="submit" class="act-delete">Delete</button>
		</form>
	</ConfirmDialog>
{/if}

{#snippet editFields(x: Record<string, string | null> | null, edit: boolean)}
	<div class="grid2">
		<label>Router name<input name="name" value={x?.name ?? ''} disabled={!edit} /></label>
		<label>Hostname (dynamic IP)<input name="hostname" value={x?.hostname ?? ''} disabled={!edit} placeholder="gw.customer.example.com" /></label>
		<label>Hospital<input name="hospital" value={x?.hospital ?? ''} disabled={!edit} /></label>
		<label>City<input name="city" value={x?.city ?? ''} disabled={!edit} /></label>
		<label>Region<input name="region" value={x?.region ?? ''} disabled={!edit} required /></label>
		<label>Country<input name="country" value={x?.country ?? ''} disabled={!edit} /></label>
		<label>Gateway model<input name="gateway_model" value={x?.gateway_model ?? ''} disabled={!edit} /></label>
		<label>Connection type<input name="connection_type" value={x?.connection_type ?? ''} disabled={!edit} /></label>
		<label>Operational state<input name="operational_state" value={x?.operational_state ?? ''} disabled={!edit} /></label>
		<label>NAT type<input name="nat_type" value={x?.nat_type ?? ''} disabled={!edit} /></label>
		<label>Admin IP<input name="admin_ip" value={x?.admin_ip ?? ''} disabled={!edit} /></label>
		<label>Admin IP 2<input name="admin_ip2" value={x?.admin_ip2 ?? ''} disabled={!edit} /></label>
	</div>
{/snippet}

<style>
	.col-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.6rem; gap: 0.6rem; flex: none; }
	h2 { font-size: 1rem; margin: 0; }
	.count { color: var(--text-subtle); font-weight: 400; font-size: 0.85rem; }
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
	th.num, td.num { text-align: right; }
	td { font-size: 0.83rem; }
	.mono { font-variant-numeric: tabular-nums; }
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

	.detail { padding: 0.9rem; }
	.placeholder { padding: 2rem; text-align: center; color: var(--text-subtle); }
	.dhead { display: flex; align-items: baseline; gap: 0.6rem; margin-bottom: 0.9rem; }
	h3 { font-size: 0.98rem; margin: 0; }
	.model { color: var(--text-muted); font-size: 0.85rem; }
	h4 { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-subtle); margin: 1.3rem 0 0.5rem; }

	.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem 0.9rem; }
	label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.76rem; color: var(--text-muted); }
	input { background: var(--bg-app); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.4rem 0.55rem; font: inherit; font-size: 0.84rem; }
	input:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	input:disabled { color: var(--text-muted); opacity: 0.85; }

	.devs { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.25rem; }
	.devs li { display: flex; align-items: baseline; gap: 0.6rem; font-size: 0.83rem; }
	.devs a { color: var(--accent); text-decoration: none; }
	.devs a:hover { text-decoration: underline; }
	.dmeta { color: var(--text-subtle); font-size: 0.78rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.muted { color: var(--text-subtle); font-size: 0.78rem; margin: 0.4rem 0 0; }

	.error { color: var(--danger); font-size: 0.85rem; margin: 0 0 0.8rem; }
</style>
