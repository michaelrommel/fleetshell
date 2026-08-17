<script lang="ts">
	import { base } from '$app/paths';
	import { page as pageState } from '$app/state';
	import { enhance } from '$app/forms';
	import ServiceTree from '$lib/components/ServiceTree.svelte';
	import SplitPane from '$lib/components/SplitPane.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import { toastEnhance } from '$lib/toast.svelte';

	let { data, form } = $props();
	let confirmDelete = $state(false);

	function withParams(changes: Record<string, string | null>): string {
		const u = new URLSearchParams(pageState.url.searchParams);
		for (const [k, v] of Object.entries(changes)) v === null ? u.delete(k) : u.set(k, v);
		return `${base}/services/catalog?${u}`;
	}
	const selHref = (id: string) => withParams({ sel: id, new: null });
	const newCategoryHref = $derived(withParams({ new: 'category', sel: null }));
	const cancelHref = $derived(withParams({ new: null, sel: null }));

	const childKind = (kind: string) => (kind === 'root' ? 'category' : kind === 'category' ? 'service' : null);
	const canEdit = $derived(data.isAdmin);
</script>

<SplitPane storageKey="services-catalog" defaultLeft={30}>
	{#snippet left()}
		<div class="col-head">
			<h2>Service catalog <span class="count">{data.nodes.length}</span></h2>
			{#if canEdit}<a class="new-btn" href={newCategoryHref}>+ New category</a>{/if}
		</div>
		<ServiceTree nodes={data.nodes} selectedId={data.sel} hrefFor={selHref} />
	{/snippet}

	{#snippet right()}
		{#if form?.error}<p class="error">{form.error}</p>{/if}

		{#if data.isNew === 'category'}
			<div class="card detail">
				<h3>New category</h3>
				<form method="POST" action="?/createNode" use:enhance={toastEnhance('Category created')}>
					<input type="hidden" name="parent_id" value="" />
					<label>Category name<input name="name" required /></label>
					<div class="actions-bar">
						<a class="act-cancel" href={cancelHref}>Cancel</a>
						<button type="submit" class="act-primary">Create category</button>
					</div>
				</form>
			</div>
		{:else if data.detail}
			{@const detail = data.detail}
			<div class="card detail">
				<div class="dhead">
					<h3>{detail.name.trim() || '(unnamed)'}</h3>
					<span class="kind kind-{detail.kind}">{detail.kind}</span>
					{#if detail.key}<span class="skey"><code>{detail.key}</code></span>{/if}
				</div>
				<p class="path"><code>{detail.path}</code></p>

				{#if detail.kind !== 'root'}
					<form method="POST" action="?/rename" use:enhance={toastEnhance('Name saved')} class="inline">
						<input type="hidden" name="id" value={detail.id} />
						<label class="grow">Name<input name="name" value={detail.name} required disabled={!canEdit} /></label>
						{#if canEdit}<button type="submit">Save</button>{/if}
					</form>
				{/if}

				<h4>Grants scoped here</h4>
				{#if data.grants.length}
					<table class="grants">
						<thead><tr><th>Group</th><th>Role</th><th>Scope</th></tr></thead>
						<tbody>
							{#each data.grants as g (g.group_label + g.role_name + g.scope_label)}
								<tr><td>{g.group_label}</td><td>{g.role_name}</td><td>{g.scope_label || '\u2014'}</td></tr>
							{/each}
						</tbody>
					</table>
				{:else}
					<p class="muted">No grants reference this function (or an ancestor).</p>
				{/if}

				{#if canEdit && childKind(detail.kind)}
					<details class="addchild">
						<summary>Add {childKind(detail.kind)}</summary>
						<form method="POST" action="?/createNode" use:enhance={toastEnhance(`${childKind(detail.kind)} added`)} class="inline">
							<input type="hidden" name="parent_id" value={detail.id} />
							<label class="grow">{childKind(detail.kind)} name<input name="name" required /></label>
							<button type="submit">Add</button>
						</form>
					</details>
				{/if}

				{#if canEdit && detail.kind !== 'root'}
					<div class="actions-bar">
						<button type="button" class="act-delete" onclick={() => (confirmDelete = true)}>Delete {detail.kind}</button>
					</div>
				{/if}
			</div>
		{:else}
			<div class="card placeholder">Select a category or service from the tree.</div>
		{/if}
	{/snippet}
</SplitPane>

{#if data.detail && data.detail.kind !== 'root'}
	<ConfirmDialog bind:open={confirmDelete} title={`Delete ${data.detail.kind}?`} message={`Delete "${data.detail.name || 'this node'}"? This cannot be undone.`}>
		<form method="POST" action="?/deleteNode" use:enhance={toastEnhance('Deleted', () => (confirmDelete = false))}>
			<input type="hidden" name="id" value={data.detail.id} />
			<button type="submit" class="act-delete">Delete</button>
		</form>
	</ConfirmDialog>
{/if}

<style>
	.col-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.6rem; gap: 0.6rem; flex: none; }
	h2 { font-size: 1rem; margin: 0; }
	h3 { font-size: 0.95rem; margin: 0; }
	h4 { font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-subtle); margin: 1.3rem 0 0.4rem; }
	.count { color: var(--text-subtle); font-weight: 400; font-size: 0.85rem; }
	.new-btn { background: var(--accent); color: var(--on-accent); text-decoration: none; border-radius: var(--radius); padding: 0.35rem 0.7rem; font-size: 0.82rem; font-weight: 600; }
	.new-btn:hover { background: var(--accent-hover); }

	.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.5rem 0.6rem; }
	.placeholder { padding: 2rem; text-align: center; color: var(--text-subtle); }
	.detail { padding: 0.9rem; }
	.dhead { display: flex; align-items: center; gap: 0.6rem; }
	.kind { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.03em; padding: 0.1rem 0.35rem; border-radius: 3px; color: var(--text-subtle); background: var(--surface-2); }
	.kind-category { color: var(--accent); }
	.skey { margin-left: auto; }
	.path { font-size: 0.72rem; color: var(--text-subtle); margin: 0.3rem 0 0.9rem; }

	form { display: flex; flex-direction: column; gap: 0.6rem; }
	form.inline { flex-direction: row; align-items: flex-end; gap: 0.6rem; margin-bottom: 0.7rem; }
	.grow { flex: 1; }
	label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8rem; color: var(--text-muted); }
	.muted { color: var(--text-subtle); font-size: 0.82rem; }
	input:not([type='checkbox']) { background: var(--bg-app); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.4rem 0.55rem; font: inherit; font-size: 0.85rem; }
	input:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	button[type='submit'] { align-self: flex-start; background: var(--accent); color: var(--on-accent); border: none; border-radius: var(--radius); padding: 0.45rem 0.8rem; font: inherit; font-weight: 600; font-size: 0.85rem; cursor: pointer; }
	button[type='submit']:hover { background: var(--accent-hover); }
	.inline button[type='submit'] { align-self: flex-end; }
	code { background: var(--surface-2); padding: 0 0.3rem; border-radius: 3px; font-size: 0.72rem; color: var(--text-muted); }

	.grants { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
	.grants th { text-align: left; color: var(--text-subtle); font-weight: 500; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.03em; padding: 0.25rem 0.4rem; border-bottom: 1px solid var(--border); }
	.grants td { padding: 0.3rem 0.4rem; border-bottom: 1px solid var(--border); }

	.addchild { margin-top: 1.2rem; }
	.addchild > summary { cursor: pointer; font-size: 0.82rem; color: var(--accent); user-select: none; }
	.addchild > summary::-webkit-details-marker { display: none; }
	.addchild[open] > summary { margin-bottom: 0.5rem; }

	.error { color: var(--danger); font-size: 0.85rem; margin: 0 0 0.8rem; }
</style>
