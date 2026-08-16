<script lang="ts">
	import { base } from '$app/paths';
	import { page as pageState } from '$app/state';
	import { enhance } from '$app/forms';
	import RegionTree from '$lib/components/RegionTree.svelte';
	import SplitPane from '$lib/components/SplitPane.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';

	let { data, form } = $props();
	let confirmDelete = $state(false);

	function withParams(changes: Record<string, string | null>): string {
		const u = new URLSearchParams(pageState.url.searchParams);
		for (const [k, v] of Object.entries(changes)) v === null ? u.delete(k) : u.set(k, v);
		return `${base}/countries/region-tree?${u}`;
	}
	const selHref = (id: string) => withParams({ sel: id, new: null });
	const newCountryHref = $derived(withParams({ new: 'country', sel: null }));
	const cancelHref = $derived(withParams({ new: null, sel: null }));

	// A country's child is a region; a region's child is a sub-region.
	const childLabel = (kind: string) => (kind === 'country' ? 'region' : 'sub-region');
	const canEdit = $derived(data.isAdmin);
</script>

<SplitPane storageKey="countries" defaultLeft={32}>
	{#snippet left()}
		<div class="col-head">
			<h2>Regions <span class="count">{data.nodes.length}</span></h2>
			{#if canEdit}<a class="new-btn" href={newCountryHref}>+ New country</a>{/if}
		</div>
		<RegionTree nodes={data.nodes} selectedId={data.sel} hrefFor={selHref} />
	{/snippet}

	{#snippet right()}
		{#if form?.error}<p class="error">{form.error}</p>{/if}

		{#if data.isNew === 'country'}
			<div class="card detail">
				<h3>New country</h3>
				<form method="POST" action="?/createNode" use:enhance>
					<input type="hidden" name="parent_id" value="" />
					<label>Country name<input name="name" required /></label>
					<label>ISO code <span class="muted">(e.g. US, CA, DE)</span><input name="iso" maxlength="3" /></label>
					<div class="actions-bar">
						<a class="act-cancel" href={cancelHref}>Cancel</a>
						<button type="submit" class="act-primary">Create country</button>
					</div>
				</form>
			</div>
		{:else if data.detail}
			{@const detail = data.detail}
			<div class="card detail">
				<div class="dhead">
					<h3>{detail.name.trim() || '(unnamed)'}</h3>
					<span class="kind kind-{detail.kind}">{detail.kind}</span>
				</div>
				<p class="path"><code>{detail.path}</code></p>

				<form id="nodeEdit" method="POST" action="?/saveNode" use:enhance class="node">
					<input type="hidden" name="id" value={detail.id} />
					<label>Name<input name="name" value={detail.name} required disabled={!canEdit} /></label>
					<label>ISO code <span class="muted">(country code; inherited by sub-regions)</span>
						<input name="iso" value={detail.iso ?? ''} maxlength="3" disabled={!canEdit} /></label>
				</form>

				<p class="stats">
					<span>{detail.child_count} direct sub-region{detail.child_count === 1 ? '' : 's'}</span>
					<span>·</span>
					<span>{detail.device_count} device{detail.device_count === 1 ? '' : 's'} here</span>
				</p>

				<!-- Add child sub-region -->
				{#if canEdit}
					<details class="addchild">
						<summary>Add {childLabel(detail.kind)}</summary>
						<form method="POST" action="?/createNode" use:enhance class="inline">
							<input type="hidden" name="parent_id" value={detail.id} />
							<label class="grow">{childLabel(detail.kind)} name<input name="name" required /></label>
							<button type="submit">Add</button>
						</form>
					</details>
				{/if}

				{#if canEdit}
					<div class="actions-bar">
						<button type="button" class="act-delete" onclick={() => (confirmDelete = true)}>Delete {detail.kind}</button>
						<button type="submit" form="nodeEdit" class="act-primary">Save {detail.kind}</button>
					</div>
				{/if}
			</div>
		{:else}
			<div class="card placeholder">Select a country or region from the tree.</div>
		{/if}
	{/snippet}
</SplitPane>

{#if data.detail}
	<ConfirmDialog bind:open={confirmDelete} title={`Delete ${data.detail.kind}?`} message={`Delete "${data.detail.name || 'this node'}"? This cannot be undone.`}>
		<form method="POST" action="?/deleteNode" use:enhance={() => async ({ update }) => { confirmDelete = false; await update(); }}>
			<input type="hidden" name="id" value={data.detail.id} />
			<button type="submit" class="act-delete">Delete</button>
		</form>
	</ConfirmDialog>
{/if}

<style>
	.col-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.6rem; gap: 0.6rem; flex: none; }
	h2 { font-size: 1rem; margin: 0; }
	h3 { font-size: 0.95rem; margin: 0; }
	.count { color: var(--text-subtle); font-weight: 400; font-size: 0.85rem; }
	.new-btn { background: var(--accent); color: var(--on-accent); text-decoration: none; border-radius: var(--radius); padding: 0.35rem 0.7rem; font-size: 0.82rem; font-weight: 600; }
	.new-btn:hover { background: var(--accent-hover); }

	.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.5rem 0.6rem; }
	.placeholder { padding: 2rem; text-align: center; color: var(--text-subtle); }
	.detail { padding: 0.9rem; }
	.dhead { display: flex; align-items: center; gap: 0.6rem; }
	.kind { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.03em; padding: 0.1rem 0.35rem; border-radius: 3px; color: var(--text-subtle); background: var(--surface-2); }
	.kind-country { color: var(--accent); }
	.path { font-size: 0.72rem; color: var(--text-subtle); margin: 0.3rem 0 0.9rem; }

	form { display: flex; flex-direction: column; gap: 0.6rem; }
	form.inline { flex-direction: row; align-items: flex-end; gap: 0.6rem; margin-bottom: 0.7rem; }
	form.node { gap: 0.6rem; margin-bottom: 0.7rem; }
	.grow { flex: 1; }
	label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8rem; color: var(--text-muted); }
	.muted { color: var(--text-subtle); font-size: 0.78rem; }
	.stats { display: flex; gap: 0.5rem; font-size: 0.78rem; color: var(--text-subtle); margin: 0 0 0.6rem; }
	input:not([type='checkbox']) { background: var(--bg-app); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.4rem 0.55rem; font: inherit; font-size: 0.85rem; }
	input:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	button[type='submit'] { align-self: flex-start; background: var(--accent); color: var(--on-accent); border: none; border-radius: var(--radius); padding: 0.45rem 0.8rem; font: inherit; font-weight: 600; font-size: 0.85rem; cursor: pointer; }
	button[type='submit']:hover { background: var(--accent-hover); }
	.inline button[type='submit'] { align-self: flex-end; }
	code { background: var(--surface-2); padding: 0 0.3rem; border-radius: 3px; font-size: 0.72rem; color: var(--text-muted); }

	.addchild { margin-top: 1.2rem; }
	.addchild > summary { cursor: pointer; font-size: 0.82rem; color: var(--accent); user-select: none; }
	.addchild > summary::-webkit-details-marker { display: none; }
	.addchild[open] > summary { margin-bottom: 0.5rem; }

	.error { color: var(--danger); font-size: 0.85rem; margin: 0 0 0.8rem; }
</style>
