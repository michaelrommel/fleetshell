<script lang="ts">
	import { base } from '$app/paths';
	import { page as pageState } from '$app/state';
	import { enhance } from '$app/forms';
	import SplitPane from '$lib/components/SplitPane.svelte';
	import GroupTree from '$lib/components/GroupTree.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';

	let { data, form } = $props();
	let confirmDelete = $state(false);

	function withParams(changes: Record<string, string | null>): string {
		const u = new URLSearchParams(pageState.url.searchParams);
		for (const [k, v] of Object.entries(changes)) v === null ? u.delete(k) : u.set(k, v);
		return `${base}/administration/groups?${u}`;
	}
	const newHref = $derived(withParams({ new: '1', sel: null, mq: null }));
	const cancelHref = $derived(withParams({ new: null, sel: null, mq: null }));
	const selHref = (id: string) => withParams({ sel: id, new: null, mq: null });
	function displayLabel(label: string): string {
		return label.startsWith('user:') ? `Single User Grants (${label})` : label;
	}

	let memberQuery = $state('');
	let memberResults = $state<{ user_id: string; firstname: string; lastname: string; role_label: string | null }[]>([]);
	async function searchPersonas() {
		if (memberQuery.trim().length < 2) { memberResults = []; return; }
		const res = await fetch(`${base}/api/administration/personas?q=${encodeURIComponent(memberQuery.trim())}`);
		memberResults = res.ok ? (await res.json()).personas : [];
	}
</script>

<SplitPane storageKey="groups" defaultLeft={30}>
	{#snippet left()}
		<div class="col-head">
			<h2>Groups <span class="count">{data.nodes.length}</span></h2>
			<a class="new-btn" href={newHref}>+ New group</a>
		</div>
		<GroupTree nodes={data.nodes} selectedId={data.sel} hrefFor={selHref} />
	{/snippet}

	{#snippet right()}
		{#if data.detail}
			<div class="card detail">
				<h3>{displayLabel(data.detail.label)}</h3>

				{#if data.detail.label.startsWith('user:')}
					<p class="region">Legacy personal grant holder. Home region: <code>{data.detail.home_region}</code></p>
				{:else}
					<form method="POST" action="?/renameGroup" use:enhance class="rename">
						<input type="hidden" name="group_id" value={data.detail.group_id} />
						<label>Group label<input name="label" value={data.detail.label} required /></label>
						<button type="submit">Save label</button>
					</form>
					<p class="region">Home region: <code>{data.detail.home_region}</code></p>
				{/if}

				<details class="grants-box">
					<summary>Grants on this group <span class="count">{data.grants.length}</span></summary>
					<ul class="grants">
						{#each data.grants as g (g.grant_id)}
							<li>
								<span class="role">{g.role_name}</span>
								{#if g.scope_kind === 'single_system'}
									<span class="scope"><span class="kind">system</span> {g.single_label}</span>
								{:else}
									<span class="scope">{g.region} <span class="sep">|</span> {g.product} <span class="sep">|</span> {g.site === 'ANY' ? g.customer : `${g.customer} / ${g.site}`}</span>
								{/if}
							</li>
						{:else}
							<li class="muted">No grants. Add them in the Grants tab.</li>
						{/each}
					</ul>
				</details>

				<h4>Members <span class="count">{data.memberTotal}</span></h4>
				<form method="GET" class="mfilter">
					<input type="hidden" name="sel" value={data.detail.group_id} />
					<input name="mq" value={data.mq} placeholder="Filter members by name" />
				</form>
				<ul class="members">
					{#each data.members as p (p.user_id)}
						<li>
							<span>{p.firstname} {p.lastname}{#if p.role_label} &middot; {p.role_label}{/if}</span>
							<form method="POST" action="?/removeMember" use:enhance>
								<input type="hidden" name="group_id" value={data.detail.group_id} />
								<input type="hidden" name="user_id" value={p.user_id} />
								<button type="submit" class="link-btn">Remove</button>
							</form>
						</li>
					{:else}
						<li class="muted">{data.mq ? 'No members match.' : 'No members.'}</li>
					{/each}
				</ul>
				{#if !data.mq && data.memberTotal > data.members.length}
					<p class="hint">Showing first {data.members.length} of {data.memberTotal}. Use the filter to find a member.</p>
				{/if}

				<h4>Add a member</h4>
				<input class="wide" placeholder="Search persona" bind:value={memberQuery} oninput={searchPersonas} />
				{#if memberResults.length}
					<ul class="results">
						{#each memberResults as p (p.user_id)}
							<li>
								<span>{p.firstname} {p.lastname}{#if p.role_label} &middot; {p.role_label}{/if} <span class="muted">{p.user_id}</span></span>
								<form method="POST" action="?/addMember" use:enhance>
									<input type="hidden" name="group_id" value={data.detail.group_id} />
									<input type="hidden" name="user_id" value={p.user_id} />
									<button type="submit" class="link-btn">Add</button>
								</form>
							</li>
						{/each}
					</ul>
				{/if}

				<div class="actions-bar">
					<button type="button" class="act-delete" onclick={() => (confirmDelete = true)}>Delete group</button>
				</div>
			</div>
		{:else if data.isNew}
			<div class="card detail">
				<h3>New group</h3>
				<form method="POST" action="?/createGroup" use:enhance>
					<label>Group label<input name="label" required /></label>
					<label>Home region<input name="home_region" value="eu-west-2" /></label>
					<div class="actions-bar">
						<a class="act-cancel" href={cancelHref}>Cancel</a>
						<button type="submit" class="act-primary">Create group</button>
					</div>
				</form>
				<p class="hint">Add members and grants after creating.</p>
			</div>
		{:else}
			<div class="card placeholder">Select a group in the tree, or click <strong>+ New group</strong>.</div>
		{/if}
		{#if form?.error}<p class="error">{form.error}</p>{/if}
	{/snippet}
</SplitPane>

{#if data.detail}
	<ConfirmDialog bind:open={confirmDelete} title="Delete group?" message={`Delete "${displayLabel(data.detail.label)}"? Its grants and memberships are removed.`}>
		<form method="POST" action="?/deleteGroup" use:enhance={() => async ({ update }) => { confirmDelete = false; await update(); }}>
			<input type="hidden" name="group_id" value={data.detail.group_id} />
			<button type="submit" class="act-delete">Delete</button>
		</form>
	</ConfirmDialog>
{/if}

<style>
	.col-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.6rem; gap: 0.6rem; flex: none; }
	h2 { font-size: 1rem; margin: 0; }
	.count { color: var(--text-subtle); font-weight: 400; font-size: 0.85rem; }
	h3 { font-size: 0.95rem; margin: 0 0 0.6rem; }
	h4 { font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-subtle); margin: 1.1rem 0 0.4rem; }
	.new-btn { background: var(--accent); color: var(--on-accent); text-decoration: none; border-radius: var(--radius); padding: 0.35rem 0.7rem; font-size: 0.82rem; font-weight: 600; }
	.new-btn:hover { background: var(--accent-hover); }
	.mfilter { margin-bottom: 0.5rem; }
	.mfilter input, .wide { width: 100%; }

	.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.5rem 0.6rem; margin-bottom: 0.8rem; }
	.placeholder { padding: 2rem; text-align: center; color: var(--text-subtle); }

	.detail { padding: 0.9rem; }
	form { display: flex; flex-direction: column; gap: 0.6rem; }
	.rename { flex-direction: row; align-items: flex-end; gap: 0.6rem; }
	.rename label { flex: 1; }
	form.rename button[type='submit'] { align-self: flex-end; }
	.region { font-size: 0.8rem; color: var(--text-muted); margin: 0.3rem 0 0; }
	label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8rem; color: var(--text-muted); }
	input { background: var(--bg-app); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.4rem 0.55rem; font: inherit; font-size: 0.85rem; }
	input:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	button[type='submit']:not(.link-btn) { align-self: flex-start; background: var(--accent); color: var(--on-accent); border: none; border-radius: var(--radius); padding: 0.45rem 0.8rem; font: inherit; font-weight: 600; font-size: 0.85rem; cursor: pointer; }
	button[type='submit']:not(.link-btn):hover { background: var(--accent-hover); }

	.grants-box { margin-top: 1.1rem; }
	.grants-box > summary {
		cursor: pointer; list-style: none;
		font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.03em;
		color: var(--text-subtle); margin-bottom: 0.4rem; user-select: none;
	}
	.grants-box > summary::-webkit-details-marker { display: none; }
	.grants-box > summary::before {
		content: ''; display: inline-block; width: 0; height: 0; margin-right: 0.5rem;
		border-left: 7px solid var(--text-muted);
		border-top: 5px solid transparent; border-bottom: 5px solid transparent;
		vertical-align: middle; transition: transform 0.12s;
	}
	.grants-box[open] > summary::before { transform: rotate(90deg); }
	.grants-box .count { color: var(--text-subtle); }
	.grants { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.25rem; }
	.grants li { display: flex; align-items: baseline; gap: 0.6rem; font-size: 0.84rem; }
	.grants .role { flex: none; min-width: 3.5rem; font-weight: 600; color: var(--text-muted); font-size: 0.78rem; }
	.grants .scope { color: var(--text); font-variant-numeric: tabular-nums; }
	.grants .sep { color: var(--text-subtle); margin: 0 0.15rem; }
	.grants .kind { color: var(--accent); font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.03em; margin-right: 0.2rem; }

	.members { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.3rem; }
	.members li { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; font-size: 0.85rem; }
	.link-btn { background: none; border: none; color: var(--accent); cursor: pointer; font: inherit; font-size: 0.8rem; padding: 0; text-decoration: none; }
	.link-btn:hover { text-decoration: underline; }
	.results { list-style: none; padding: 0; margin: 0.4rem 0 0; display: flex; flex-direction: column; gap: 0.2rem; }
	.results li { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; font-size: 0.82rem; }
	.muted { color: var(--text-subtle); font-size: 0.78rem; }
	.hint { color: var(--text-subtle); font-size: 0.78rem; margin: 0.4rem 0 0; }
	.error { color: var(--danger); font-size: 0.85rem; margin: 0.4rem 0 0; }
	code { background: var(--surface-2); padding: 0 0.3rem; border-radius: 3px; font-size: 0.76rem; color: var(--text-muted); }


</style>
