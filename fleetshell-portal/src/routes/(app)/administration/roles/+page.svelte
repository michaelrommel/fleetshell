<script lang="ts">
	import { base } from '$app/paths';
	import { page as pageState } from '$app/state';
	import { enhance } from '$app/forms';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';

	let { data, form } = $props();
	let confirmDelete = $state(false);

	function withParams(changes: Record<string, string | null>): string {
		const u = new URLSearchParams(pageState.url.searchParams);
		for (const [k, v] of Object.entries(changes)) v === null ? u.delete(k) : u.set(k, v);
		return `${base}/administration/roles?${u}`;
	}
	const newHref = $derived(withParams({ new: '1', sel: null }));
	const cancelHref = $derived(withParams({ new: null, sel: null }));
	const selHref = (id: string) => withParams({ sel: id, new: null });
</script>

<div class="grid">
	<!-- List column -->
	<section>
		<div class="col-head">
			<h2>Roles <span class="count">{data.total}</span></h2>
			<a class="new-btn" href={newHref}>+ New role</a>
		</div>

		<form method="GET" class="search">
			<input name="q" placeholder="Search role name" value={data.q} />
		</form>

		<div class="card list">
			{#each data.roles as r (r.id)}
				<a class="row" class:sel={r.id === data.sel} href={selHref(r.id)}>
					<span class="row-main">{r.name}</span>
					<span class="row-meta">
						<span class="chip">{r.priv_count} priv</span>
						<span class="muted">{r.grant_count} grants</span>
					</span>
				</a>
			{:else}
				<p class="empty">No roles found.</p>
			{/each}
		</div>
	</section>

	<!-- Detail column -->
	<section>
		{#if data.detail}
			<div class="card detail">
				<h3>{data.detail.name} <code>{data.detail.key}</code></h3>

				<form method="POST" action="?/renameRole" use:enhance class="rename">
					<input type="hidden" name="id" value={data.detail.id} />
					<label>Role name<input name="name" value={data.detail.name} required /></label>
					<button type="submit">Save name</button>
				</form>

				<h4>Privileges</h4>
				<form id="roleEdit" method="POST" action="?/setPrivileges" use:enhance>
					<input type="hidden" name="id" value={data.detail.id} />
					<table class="matrix">
						<thead>
							<tr><th class="corner">Type</th>{#each data.verbs as v (v)}<th>{v}</th>{/each}</tr>
						</thead>
						<tbody>
							{#each data.matrix as row (row.type)}
								<tr>
									<td class="type">{row.type}</td>
									{#each row.cells as c (c.verb)}
										<td>
											{#if c.id}
												<input type="checkbox" name="priv" value={c.id} checked={c.checked} />
											{:else}
												<span class="na">&middot;</span>
											{/if}
										</td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</form>

				<h4>Usage</h4>
				<p class="usage">Used in <strong>{data.usage.grants}</strong> grant(s) across
					<strong>{data.usage.groups}</strong> group(s).</p>

				<div class="actions-bar">
					<button type="button" class="act-delete" onclick={() => (confirmDelete = true)}>Delete role</button>
					<button type="submit" form="roleEdit" class="act-primary">Save privileges</button>
				</div>
			</div>
		{:else if data.isNew}
			<div class="card detail">
				<h3>New role</h3>
				<form method="POST" action="?/createRole" use:enhance>
					<label>Role name<input name="name" required /></label>
					<div class="actions-bar">
						<a class="act-cancel" href={cancelHref}>Cancel</a>
						<button type="submit" class="act-primary">Create role</button>
					</div>
				</form>
				<p class="hint">Assign privileges after creating.</p>
			</div>
		{:else}
			<div class="card placeholder">Select a role, or click <strong>+ New role</strong>.</div>
		{/if}
		{#if form?.error}<p class="error">{form.error}</p>{/if}
	</section>
</div>

{#if data.detail}
	<ConfirmDialog bind:open={confirmDelete} title="Delete role?" message={`Delete "${data.detail.name}"? This cannot be undone.`}>
		<form method="POST" action="?/deleteRole" use:enhance={() => async ({ update }) => { confirmDelete = false; await update(); }}>
			<input type="hidden" name="id" value={data.detail.id} />
			<button type="submit" class="act-delete">Delete</button>
		</form>
	</ConfirmDialog>
{/if}

<style>
	.grid { display: grid; grid-template-columns: 1fr 1.3fr; gap: 1.4rem; flex: 1; min-height: 0; }
	section { min-width: 0; display: flex; flex-direction: column; min-height: 0; }
	section:last-child { overflow-y: auto; }
	.col-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.6rem; gap: 0.6rem; flex: none; }
	h2 { font-size: 1rem; margin: 0; }
	.count { color: var(--text-subtle); font-weight: 400; font-size: 0.85rem; }
	h3 { font-size: 0.95rem; margin: 0 0 0.6rem; }
	h4 { font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-subtle); margin: 1.1rem 0 0.4rem; }
	.new-btn { background: var(--accent); color: var(--on-accent); text-decoration: none; border-radius: var(--radius); padding: 0.35rem 0.7rem; font-size: 0.82rem; font-weight: 600; }
	.new-btn:hover { background: var(--accent-hover); }
	.search { margin-bottom: 0.6rem; flex: none; }
	.search input { width: 100%; }

	.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.5rem 0.6rem; margin-bottom: 0.8rem; }
	.list { padding: 0.25rem; flex: 1; min-height: 0; overflow-y: auto; }
	.placeholder { padding: 2rem; text-align: center; color: var(--text-subtle); }
	.row { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; padding: 0.45rem 0.55rem; border-radius: var(--radius); text-decoration: none; color: var(--text); font-size: 0.88rem; }
	.row:hover { background: var(--surface-2); }
	.row.sel { background: var(--surface-active); box-shadow: inset 2px 0 0 var(--accent); }
	.row-main { font-weight: 600; }
	.row-meta { display: flex; align-items: center; gap: 0.4rem; }
	.chip { font-size: 0.68rem; color: var(--text-muted); border: 1px solid var(--border); border-radius: 999px; padding: 0.05rem 0.45rem; }
	.muted { color: var(--text-subtle); font-size: 0.78rem; }
	.empty { color: var(--text-subtle); padding: 0.8rem; margin: 0; text-align: center; }

	.detail { padding: 0.9rem; }
	form { display: flex; flex-direction: column; gap: 0.6rem; }
	.rename { flex-direction: row; align-items: flex-end; gap: 0.6rem; }
	.rename label { flex: 1; }
	.rename button[type='submit'] { align-self: flex-end; }
	label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8rem; color: var(--text-muted); }
	input:not([type='checkbox']) { background: var(--bg-app); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.4rem 0.55rem; font: inherit; font-size: 0.85rem; }
	input:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	button[type='submit'] { align-self: flex-start; background: var(--accent); color: var(--on-accent); border: none; border-radius: var(--radius); padding: 0.45rem 0.8rem; font: inherit; font-weight: 600; font-size: 0.85rem; cursor: pointer; }
	button[type='submit']:hover { background: var(--accent-hover); }

	.matrix { border-collapse: collapse; width: 100%; font-size: 0.82rem; }
	.matrix th, .matrix td { border: 1px solid var(--divider); padding: 0.3rem 0.4rem; text-align: center; }
	.matrix thead th { text-transform: capitalize; color: var(--text-subtle); font-weight: 600; font-size: 0.76rem; }
	.matrix .corner, .matrix .type { text-align: left; }
	.matrix .type { font-weight: 600; color: var(--text); }
	.matrix .na { color: var(--text-subtle); opacity: 0.5; }

	.usage { font-size: 0.85rem; color: var(--text-muted); margin: 0; }
	.usage strong { color: var(--text); }
	.hint { color: var(--text-subtle); font-size: 0.78rem; margin: 0.4rem 0 0; }
	.error { color: var(--danger); font-size: 0.85rem; margin: 0.4rem 0 0; }
	code { background: var(--surface-2); padding: 0 0.3rem; border-radius: 3px; font-size: 0.72rem; color: var(--text-muted); }


	@media (max-width: 75rem) { .grid { grid-template-columns: 1fr; } }
</style>
