<script lang="ts">
	import { base } from '$app/paths';
	import { page as pageState } from '$app/state';
	import { enhance } from '$app/forms';
	import SplitPane from '$lib/components/SplitPane.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import ContactsEditor from '$lib/components/ContactsEditor.svelte';
	import SiteMembershipEditor from '$lib/components/SiteMembershipEditor.svelte';

	let { data, form } = $props();
	let confirmDelCust = $state(false);
	let confirmDelSite = $state(false);

	// Seeded from the URL once; search triggers a full navigation (remount).
	// svelte-ignore state_referenced_locally
	let search = $state(data.q);
	function doSearch() {
		const u = new URLSearchParams();
		if (search.trim()) u.set('q', search.trim());
		window.location.href = `${base}/customers?${u}`;
	}

	const canEdit = $derived(data.isAdmin);
	const custHref = (id: string) => `${base}/customers?sel=${encodeURIComponent(id)}`;
	const siteHref = (sid: string) => `${base}/customers?sel=${encodeURIComponent(data.sel ?? '')}&site=${encodeURIComponent(sid)}`;
	const newCustHref = $derived(`${base}/customers?new=1${data.q ? `&q=${encodeURIComponent(data.q)}` : ''}`);
	const newSiteHref = $derived(`${base}/customers?sel=${encodeURIComponent(data.sel ?? '')}&newsite=1`);
	const backToCustHref = $derived(custHref(data.sel ?? ''));
	const cancelHref = $derived(`${base}/customers${data.q ? `?q=${encodeURIComponent(data.q)}` : ''}`);
</script>

<div class="page-head">
	<h1>Customers / Sites</h1>
	<p class="sub">Customers, their sites, and how devices are assigned to a site.</p>
</div>

{#if form?.error}<p class="msg error">{form.error}</p>{/if}

<SplitPane storageKey="customers" defaultLeft={40}>
	{#snippet left()}
		<form class="searchbar" onsubmit={(e) => { e.preventDefault(); doSearch(); }}>
			<input placeholder="Search customers (name, country, city)" bind:value={search} />
			<button type="submit">Search</button>
			{#if canEdit}<a class="new-btn" href={newCustHref}>+ New</a>{/if}
		</form>
		<div class="count-line">{data.total.toLocaleString()} customer(s){#if data.total > data.rows.length} · showing {data.rows.length}{/if}</div>
		<div class="card list">
			{#each data.rows as c (c.id)}
				<a class="row" class:sel={c.id === data.sel} href={custHref(c.id)}>
					<span class="row-left">
						<span class="row-main">{c.name}</span>
						<span class="row-sub">{c.country}{#if c.city} · {c.city}{/if}</span>
					</span>
					<span class="row-meta">
						<span class="chip">{c.site_count} site{c.site_count === 1 ? '' : 's'}</span>
						<span class="row-count">{c.device_count.toLocaleString()} system{c.device_count === 1 ? '' : 's'}</span>
					</span>
				</a>
			{:else}
				<p class="empty">No customers.</p>
			{/each}
		</div>
	{/snippet}

	{#snippet right()}
		{#if data.isNew}
			<div class="card detail">
				<h3>New customer</h3>
				<form method="POST" action="?/createCustomer" use:enhance>
					{@render custFields(null)}
					<div class="actions-bar">
						<a class="act-cancel" href={cancelHref}>Cancel</a>
						<button type="submit" class="act-primary">Create customer</button>
					</div>
				</form>
			</div>

		{:else if data.site}
			{@const s = data.site}
			<div class="card detail">
				<a class="back" href={backToCustHref}>← {data.customer?.name ?? 'customer'}</a>
				<div class="dhead"><h3>{s.name || '(unnamed site)'}</h3><span class="tag">site</span></div>

				<form method="POST" action="?/updateSite" use:enhance>
					<input type="hidden" name="id" value={s.id} />
					<input type="hidden" name="customer_id" value={s.customer_id} />
					{@render siteFields(s)}
					{#if canEdit}
						<div class="actions-bar">
							<button type="button" class="act-delete" onclick={() => (confirmDelSite = true)}>Delete site</button>
							<button type="submit" class="act-primary">Save site</button>
						</div>
					{/if}
				</form>

				<hr />
				{#key s.id}
					<SiteMembershipEditor siteId={String(s.id)} customerId={String(s.customer_id)}
						gatewayChips={data.gatewayChips} hospitalNames={data.hospitalNames}
						members={data.members} memberTotal={data.memberTotal}
						effectiveCount={data.effectiveCount} {canEdit} />
				{/key}

				<hr />
				{#key s.id}
					<ContactsEditor siteId={String(s.id)} customerId={String(s.customer_id)} contacts={data.contacts} {canEdit} />
				{/key}
			</div>

		{:else if data.newSite && data.customer}
			<div class="card detail">
				<a class="back" href={backToCustHref}>← {data.customer.name}</a>
				<h3>New site</h3>
				<form method="POST" action="?/createSite" use:enhance>
					<input type="hidden" name="customer_id" value={data.sel} />
					{@render siteFields({ country: data.customer.country })}
					<div class="actions-bar">
						<a class="act-cancel" href={backToCustHref}>Cancel</a>
						<button type="submit" class="act-primary">Create site</button>
					</div>
				</form>
			</div>

		{:else if data.customer}
			{@const c = data.customer}
			<div class="card detail">
				<div class="dhead"><h3>{c.name}</h3><span class="tag cust">customer</span></div>
				<form method="POST" action="?/updateCustomer" use:enhance>
					<input type="hidden" name="id" value={c.id} />
					{@render custFields(c)}
					{#if canEdit}
						<div class="actions-bar">
							<button type="button" class="act-delete" onclick={() => (confirmDelCust = true)}>Delete customer</button>
							<button type="submit" class="act-primary">Save customer</button>
						</div>
					{/if}
				</form>

				<hr />
				<div class="sites-head">
					<h4>Sites <span class="count">{data.sites.length}</span></h4>
					{#if canEdit}<a class="mini" href={newSiteHref}>+ New site</a>{/if}
				</div>
				{#if data.sites.length}
					<div class="site-list">
						{#each data.sites as st (st.id)}
							<a class="site-row" href={siteHref(st.id)}>
								<span class="sname">{st.name}</span>
								<span class="smeta">{st.country}{#if st.city} · {st.city}{/if}</span>
								<span class="scount">{st.device_count} device(s)</span>
							</a>
						{/each}
					</div>
				{:else}
					<p class="muted">No sites yet.</p>
				{/if}
			</div>

		{:else}
			<div class="card placeholder">Select a customer, or create one.</div>
		{/if}
	{/snippet}
</SplitPane>

{#snippet custFields(c: Record<string, unknown> | null)}
	<div class="grid2">
		<label class="wide">Name<input name="name" value={c?.name ?? ''} required disabled={!canEdit && !!c} /></label>
		{@render countrySelect(String(c?.country ?? ''))}
		<label>City<input name="city" value={c?.city ?? ''} disabled={!canEdit && !!c} /></label>
		<label>Postcode<input name="postcode" value={c?.postcode ?? ''} disabled={!canEdit && !!c} /></label>
		<label class="wide">Street <span class="opt">(optional)</span><input name="street" value={c?.street ?? ''} disabled={!canEdit && !!c} /></label>
		<label>DTM variant
			<select name="dtm_variant" disabled={!canEdit && !!c}>
				<option value="">Standard (default)</option>
				{#each data.variants as v (v.code)}<option value={v.code} selected={c?.dtm_variant === v.code}>{v.label}</option>{/each}
			</select>
		</label>
		<label class="chk"><input type="checkbox" name="requires_explicit_grant" checked={!!c?.requires_explicit_grant} disabled={!canEdit && !!c} /> Requires explicit grant</label>
	</div>
{/snippet}

{#snippet siteFields(s: Record<string, unknown> | null)}
	<div class="grid2">
		<label class="wide">Name<input name="name" value={s?.name ?? ''} required disabled={!canEdit && !!s?.id} /></label>
		{@render countrySelect(String(s?.country ?? ''))}
		<label>City<input name="city" value={s?.city ?? ''} disabled={!canEdit && !!s?.id} /></label>
		<label>Postcode<input name="postcode" value={s?.postcode ?? ''} disabled={!canEdit && !!s?.id} /></label>
		<label class="wide">Street<input name="street" value={s?.street ?? ''} disabled={!canEdit && !!s?.id} /></label>
		<label class="chk"><input type="checkbox" name="requires_explicit_grant" checked={!!s?.requires_explicit_grant} disabled={!canEdit && !!s?.id} /> Requires explicit grant</label>
	</div>
{/snippet}

{#snippet countrySelect(value: string)}
	<label>Country
		<select name="country" required disabled={!canEdit && !!data.sel}>
			<option value="" disabled selected={!value}>Select…</option>
			{#each data.countries as co (co.iso)}<option value={co.iso} selected={co.iso === value}>{co.name} ({co.iso})</option>{/each}
		</select>
	</label>
{/snippet}

{#if data.customer}
	<ConfirmDialog bind:open={confirmDelCust} title="Delete customer?" message={`Delete "${data.customer.name}" and all its sites? This cannot be undone.`}>
		<form method="POST" action="?/deleteCustomer" use:enhance={() => async ({ update }) => { confirmDelCust = false; await update(); }}>
			<input type="hidden" name="id" value={data.customer.id} />
			<button type="submit" class="act-delete">Delete</button>
		</form>
	</ConfirmDialog>
{/if}
{#if data.site}
	<ConfirmDialog bind:open={confirmDelSite} title="Delete site?" message={`Delete "${data.site.name}"? Devices lose this site on recompute.`}>
		<form method="POST" action="?/deleteSite" use:enhance={() => async ({ update }) => { confirmDelSite = false; await update(); }}>
			<input type="hidden" name="id" value={data.site.id} />
			<input type="hidden" name="customer_id" value={data.site.customer_id} />
			<button type="submit" class="act-delete">Delete</button>
		</form>
	</ConfirmDialog>
{/if}

<style>
	.page-head { margin-bottom: 1rem; }
	h1 { font-size: 1.3rem; margin: 0 0 0.2rem; }
	.sub { margin: 0; color: var(--text-muted); font-size: 0.9rem; }
	.msg { font-size: 0.85rem; margin: 0 0 0.6rem; padding: 0.4rem 0.6rem; border-radius: var(--radius); }
	.msg.error { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }

	.searchbar { display: flex; gap: 0.4rem; margin-bottom: 0.5rem; flex: none; }
	.searchbar input { flex: 1; min-width: 0; background: var(--bg-app); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.45rem 0.6rem; font: inherit; font-size: 0.85rem; }
	.searchbar button, .new-btn { background: var(--surface-2); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.45rem 0.7rem; font: inherit; font-size: 0.82rem; cursor: pointer; text-decoration: none; }
	.new-btn { background: var(--accent); color: var(--on-accent); border: none; font-weight: 600; display: inline-flex; align-items: center; }
	.count-line { font-size: 0.76rem; color: var(--text-subtle); margin-bottom: 0.4rem; flex: none; }

	.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
	.list { flex: 1; min-height: 0; overflow-y: auto; padding: 0.25rem; }
	.row { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; padding: 0.45rem 0.55rem; border-radius: var(--radius); text-decoration: none; color: var(--text); font-size: 0.88rem; }
	.row:hover { background: var(--surface-2); }
	.row.sel { background: var(--surface-active); box-shadow: inset 2px 0 0 var(--accent); }
	.row-left { display: flex; align-items: baseline; gap: 0.5rem; min-width: 0; }
	.row-main { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.row-sub { color: var(--text-subtle); font-size: 0.78rem; white-space: nowrap; }
	.row-meta { display: flex; align-items: center; gap: 0.5rem; white-space: nowrap; flex: none; }
	.chip { font-size: 0.68rem; color: var(--text-muted); border: 1px solid var(--border); border-radius: 999px; padding: 0.05rem 0.45rem; }
	.row-count { color: var(--text-subtle); font-size: 0.78rem; font-variant-numeric: tabular-nums; }
	.empty, .muted { color: var(--text-subtle); padding: 0.6rem; margin: 0; font-size: 0.85rem; }

	.detail { padding: 0.9rem; }
	.placeholder { padding: 2rem; text-align: center; color: var(--text-subtle); }
	.dhead { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.8rem; }
	h3 { font-size: 1rem; margin: 0; }
	.tag { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.03em; padding: 0.1rem 0.4rem; border-radius: 3px; color: var(--text-subtle); background: var(--surface-2); }
	.tag.cust { color: var(--accent); }
	.back { display: inline-block; font-size: 0.8rem; color: var(--accent); text-decoration: none; margin-bottom: 0.5rem; }
	.back:hover { text-decoration: underline; }

	.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem 0.9rem; }
	label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.78rem; color: var(--text-muted); }
	label.wide { grid-column: 1 / -1; }
	.opt { color: var(--text-subtle); }
	.chk { flex-direction: row; align-items: center; gap: 0.4rem; font-size: 0.83rem; color: var(--text); grid-column: 1 / -1; }
	input:not([type='checkbox']), select { background: var(--bg-app); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.4rem 0.55rem; font: inherit; font-size: 0.85rem; }
	input:focus-visible, select:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }

	hr { border: none; border-top: 1px solid var(--border); margin: 1.1rem 0; }
	.sites-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem; }
	h4 { font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-subtle); margin: 0; }
	.count { color: var(--text-subtle); font-weight: 400; }
	.mini { background: none; border: 1px solid var(--border); color: var(--text-muted); border-radius: var(--radius); padding: 0.2rem 0.6rem; font-size: 0.78rem; cursor: pointer; text-decoration: none; }
	.mini:hover { color: var(--text); border-color: var(--text-subtle); }
	.site-list { display: flex; flex-direction: column; gap: 0.3rem; }
	.site-row { display: grid; grid-template-columns: 1fr auto auto; gap: 0.6rem; align-items: center; padding: 0.4rem 0.55rem; border: 1px solid var(--border); border-radius: var(--radius); text-decoration: none; color: var(--text); }
	.site-row:hover { background: var(--surface-2); }
	.sname { font-size: 0.86rem; font-weight: 500; }
	.smeta { font-size: 0.74rem; color: var(--text-subtle); }
	.scount { font-size: 0.72rem; color: var(--text-subtle); }
</style>
