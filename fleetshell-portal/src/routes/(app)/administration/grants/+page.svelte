<script lang="ts">
	import { base } from '$app/paths';
	import { page as pageState } from '$app/state';
	import { enhance } from '$app/forms';
	import SplitPane from '$lib/components/SplitPane.svelte';
	import GroupTree from '$lib/components/GroupTree.svelte';
	import ScopePicker from '$lib/components/ScopePicker.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';

	let { data, form } = $props();

	type Chip = { key: string; label: string };

	// Delete confirmation.
	let confirmOpen = $state(false);
	let pendingGrant = $state<{ grant_id: string; group_id: string } | null>(null);

	function withParams(changes: Record<string, string | null>): string {
		const u = new URLSearchParams(pageState.url.searchParams);
		for (const [k, v] of Object.entries(changes)) v === null ? u.delete(k) : u.set(k, v);
		return `${base}/administration/grants?${u}`;
	}
	const selHref = (id: string) => withParams({ sel: id });

	// Add-grant form state.
	let roleId = $state('');
	let resourceType = $state<'device' | 'group'>('device');
	let regions = $state<Chip[]>([]);
	let products = $state<Chip[]>([]);
	let customers = $state<Chip[]>([]);
	let sites = $state<Chip[]>([]);
	let groups = $state<Chip[]>([]);

	function resetForm() {
		roleId = ''; resourceType = 'device';
		regions = []; products = []; customers = []; sites = []; groups = [];
	}
</script>

<SplitPane storageKey="grants" defaultLeft={30}>
	{#snippet left()}
		<div class="col-head"><h2>Grants <span class="count">by group</span></h2></div>
		<GroupTree nodes={data.nodes} selectedId={data.sel} hrefFor={selHref} />
	{/snippet}

	{#snippet right()}
		{#if data.detail}
			<div class="card detail">
				<h3>{data.detail.label}</h3>

				<h4>Grants ({data.grants.length})</h4>
				<ul class="grants">
					{#each data.grants as g (g.grant_id)}
						<li>
							<span class="role">{g.role_name}</span>
							<span class="scope">
								{#if g.scope_kind === 'single_system'}
									<span class="kind">system</span> {g.single_label}
								{:else if g.resource_type === 'group'}
									<span class="kind">group</span> {g.group_scope}
								{:else}
									{g.region} <span class="sep">|</span> {g.product} <span class="sep">|</span> {g.site === 'ANY' ? g.customer : `${g.customer} / ${g.site}`}
								{/if}
							</span>
							<button type="button" class="del"
							        onclick={() => { pendingGrant = { grant_id: g.grant_id, group_id: data.detail?.group_id ?? '' }; confirmOpen = true; }}>Delete</button>
						</li>
					{:else}
						<li class="muted">No grants on this group yet.</li>
					{/each}
				</ul>

				<h4>Add grant</h4>
				<form method="POST" action="?/createGrant"
				      use:enhance={() => async ({ result, update }) => { if (result.type === 'redirect') resetForm(); await update(); }}>
					<input type="hidden" name="group_id" value={data.detail.group_id} />

					<label>Role
						<select name="role_id" bind:value={roleId} required>
							<option value="" disabled>Choose a role…</option>
							{#each data.roles as r (r.id)}<option value={r.id}>{r.name}</option>{/each}
						</select>
					</label>

					<div class="modes">
						<span class="plabel">Applies to</span>
						<label class="radio"><input type="radio" name="resource_type" value="device" bind:group={resourceType} /> Devices</label>
						<label class="radio"><input type="radio" name="resource_type" value="group" bind:group={resourceType} /> Groups</label>
					</div>

					{#if resourceType === 'device'}
						<div class="scope-grid">
							<ScopePicker label="Region (subtree)" endpoint="/api/administration/regions"
								toItem={(r) => ({ key: r.path, label: r.iso ? `${r.name} (${r.iso})` : r.name })} bind:selected={regions} />
							<ScopePicker label="Product (subtree)" endpoint="/api/administration/products"
								toItem={(p) => ({ key: p.path, label: p.display })} bind:selected={products} />
							<ScopePicker label="Customer" endpoint="/api/administration/customers"
								toItem={(c) => ({ key: c.id, label: c.name })} bind:selected={customers} />
							<ScopePicker label="Site" endpoint="/api/administration/sites"
								toItem={(s) => ({ key: s.id, label: `${s.customer_name} / ${s.name}` })} bind:selected={sites} />
						</div>
						{#each regions as r (r.key)}<input type="hidden" name="region" value={r.key} />{/each}
						{#each products as p (p.key)}<input type="hidden" name="product" value={p.key} />{/each}
						{#each customers as c (c.key)}<input type="hidden" name="customer" value={c.key} />{/each}
						{#each sites as s (s.key)}<input type="hidden" name="site" value={s.key} />{/each}
						<p class="hint">Empty dimension = ANY. Multiple picks create one grant per combination (e.g. 2 regions x 2 products = 4 grants). An attribute scope reaches only open devices unless it names a customer/site.</p>
					{:else}
						<ScopePicker label="Groups (subtree)" endpoint="/api/administration/groups" resultsKey="groups"
							toItem={(g) => ({ key: g.path, label: g.label })} bind:selected={groups} />
						{#each groups as g (g.key)}<input type="hidden" name="grouppath" value={g.key} />{/each}
						<p class="hint">Empty = all groups. Each picked group becomes its own grant, covering that group and everything under it.</p>
					{/if}

					<div class="actions-bar"><button type="submit" class="act-primary">Create grant</button></div>
				</form>
			</div>
		{:else}
			<div class="card placeholder">Select a group in the tree to view and add its grants.</div>
		{/if}
		{#if form?.error}<p class="error">{form.error}</p>{/if}
	{/snippet}
</SplitPane>

<ConfirmDialog bind:open={confirmOpen} title="Delete grant?" message="This removes the grant and its scope.">
	<form class="modal-form" method="POST" action="?/deleteGrant"
	      use:enhance={() => async ({ update }) => { confirmOpen = false; await update(); }}>
		<input type="hidden" name="grant_id" value={pendingGrant?.grant_id ?? ''} />
		<input type="hidden" name="group_id" value={pendingGrant?.group_id ?? ''} />
		<button type="submit" class="act-delete">Delete</button>
	</form>
</ConfirmDialog>

<style>
	.col-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.6rem; gap: 0.6rem; flex: none; }
	h2 { font-size: 1rem; margin: 0; }
	.count { color: var(--text-subtle); font-weight: 400; font-size: 0.85rem; }
	h3 { font-size: 0.95rem; margin: 0 0 0.6rem; }
	h4 { font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-subtle); margin: 1.1rem 0 0.4rem; }

	.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.5rem 0.6rem; margin-bottom: 0.8rem; }
	.placeholder { padding: 2rem; text-align: center; color: var(--text-subtle); }
	.detail { padding: 0.9rem; }

	.grants { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.3rem; }
	.grants li { display: flex; align-items: baseline; gap: 0.6rem; font-size: 0.84rem; }
	.grants .role { flex: none; min-width: 3.5rem; font-weight: 600; color: var(--text-muted); font-size: 0.78rem; }
	.grants .scope { flex: 1; color: var(--text); }
	.grants .sep { color: var(--text-subtle); margin: 0 0.15rem; }
	.grants .kind { color: var(--accent); font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.03em; margin-right: 0.2rem; }
	.del { flex: none; background: none; border: none; color: var(--danger); cursor: pointer; font: inherit; font-size: 0.78rem; padding: 0; }
	.del:hover { color: color-mix(in srgb, var(--danger) 78%, #fff); }
	.modal-form { display: contents; }
	.muted { color: var(--text-subtle); font-size: 0.8rem; }

	form { display: flex; flex-direction: column; gap: 0.7rem; }
	label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8rem; color: var(--text-muted); }
	select, input { background: var(--bg-app); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.4rem 0.55rem; font: inherit; font-size: 0.85rem; }
	select:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	.modes { display: flex; align-items: center; gap: 0.9rem; flex-wrap: wrap; }
	.plabel { font-size: 0.78rem; color: var(--text-muted); }
	.radio { flex-direction: row; align-items: center; gap: 0.35rem; }
	.radio input { width: auto; }
	.scope-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.8rem; }
	.hint { color: var(--text-subtle); font-size: 0.76rem; margin: 0; }
	button[type='submit'] { align-self: flex-start; background: var(--accent); color: var(--on-accent); border: none; border-radius: var(--radius); padding: 0.45rem 0.8rem; font: inherit; font-weight: 600; font-size: 0.85rem; cursor: pointer; }
	button[type='submit']:hover { background: var(--accent-hover); }
	.error { color: var(--danger); font-size: 0.85rem; margin: 0.4rem 0 0; }

	@media (max-width: 75rem) { .scope-grid { grid-template-columns: 1fr; } }
</style>
