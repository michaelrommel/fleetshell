<script lang="ts">
	import { base } from '$app/paths';
	import { page as pageState } from '$app/state';
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	let groupQuery = $state('');
	let groupResults = $state<{ group_id: string; label: string }[]>([]);
	let searching = $state(false);

	async function searchGroups() {
		if (groupQuery.trim().length < 2) { groupResults = []; return; }
		searching = true;
		try {
			const res = await fetch(`${base}/api/administration/groups?q=${encodeURIComponent(groupQuery.trim())}`);
			groupResults = res.ok ? (await res.json()).groups : [];
		} finally {
			searching = false;
		}
	}

	// Build a URL preserving the current list state, overriding given params.
	function withParams(changes: Record<string, string | null>): string {
		const u = new URLSearchParams(pageState.url.searchParams);
		for (const [k, v] of Object.entries(changes)) v === null ? u.delete(k) : u.set(k, v);
		return `${base}/administration/personas?${u}`;
	}
	const prevHref = $derived(withParams({ page: String(data.page - 1), before: data.prevCursor, after: null }));
	const nextHref = $derived(withParams({ page: String(data.page + 1), after: data.nextCursor, before: null }));
	const newHref = $derived(withParams({ new: '1', sel: null }));
	const selHref = (uid: string) => withParams({ sel: uid, new: null });
	function confirmSubmit(e: SubmitEvent, msg: string) {
		if (!confirm(msg)) e.preventDefault();
	}
</script>

<div class="grid">
	<!-- List column -->
	<section>
		<div class="col-head">
			<h2>Personas <span class="count">{data.total}</span></h2>
			<a class="new-btn" href={newHref}>+ New persona</a>
		</div>

		<form method="GET" class="search">
			<input name="q" placeholder="Search name / id / role" value={data.q} />
		</form>

		<div class="card list">
			{#each data.personas as p (p.user_id)}
				<a class="row" class:sel={p.user_id === data.sel} href={selHref(p.user_id)}>
					<span class="row-main">{p.firstname} {p.lastname}</span>
					<span class="row-meta">
						{#if p.role_label}<span class="chip">{p.role_label}</span>{/if}
						{#if p.is_admin}<span class="chip admin">admin</span>{/if}
						<span class="muted">{p.group_count} grp</span>
					</span>
				</a>
			{:else}
				<p class="empty">No personas found.</p>
			{/each}
		</div>

		{#if data.total > data.personas.length || data.page > 1}
			<div class="pager">
				<a class="pg" class:disabled={!data.hasPrev} href={prevHref}>Prev</a>
				<span class="muted">{data.from}-{data.to} of {data.total}</span>
				<a class="pg" class:disabled={!data.hasNext} href={nextHref}>Next</a>
			</div>
		{/if}
	</section>

	<!-- Detail column -->
	<section>
		{#if data.detail}
			<div class="card detail">
				<h3>Edit persona <code>{data.detail.user_id}</code></h3>
				<form method="POST" action="?/updatePersona" use:enhance>
					<input type="hidden" name="user_id" value={data.detail.user_id} />
					<div class="two">
						<label>First name<input name="firstname" value={data.detail.firstname} required /></label>
						<label>Last name<input name="lastname" value={data.detail.lastname} required /></label>
					</div>
					<label>Role label<input name="role_label" value={data.detail.role_label ?? ''} /></label>
					<label class="check">
						<input type="checkbox" name="is_admin" checked={data.detail.is_admin} /> Administration access
					</label>
					<button type="submit">Save</button>
				</form>

				<h4>Group memberships</h4>
				<ul class="members">
					{#each data.memberships as m (m.group_id)}
						<li>
							<span>{m.label}</span>
							<form method="POST" action="?/removeMembership" use:enhance>
								<input type="hidden" name="user_id" value={data.detail.user_id} />
								<input type="hidden" name="group_id" value={m.group_id} />
								<button type="submit" class="link-btn">Remove</button>
							</form>
						</li>
					{:else}
						<li class="muted">No memberships. Add a group to grant rights.</li>
					{/each}
				</ul>

				<div class="add-member">
					<input placeholder="Search group by label" bind:value={groupQuery} oninput={searchGroups} />
					{#if searching}<span class="muted">...</span>{/if}
					{#if groupResults.length}
						<ul class="results">
							{#each groupResults as g (g.group_id)}
								<li>
									<span>{g.label}</span>
									<form method="POST" action="?/addMembership" use:enhance>
										<input type="hidden" name="user_id" value={data.detail.user_id} />
										<input type="hidden" name="group_id" value={g.group_id} />
										<button type="submit" class="link-btn">Add</button>
									</form>
								</li>
							{/each}
						</ul>
					{/if}
				</div>

				<div class="danger-zone">
					<form method="POST" action="?/deletePersona"
					      onsubmit={(e) => confirmSubmit(e, `Delete persona "${data.detail?.firstname} ${data.detail?.lastname}"?`)}>
						<input type="hidden" name="user_id" value={data.detail.user_id} />
						<button type="submit" class="danger-btn">Delete persona</button>
					</form>
				</div>
			</div>
		{:else if data.isNew}
			<div class="card detail">
				<h3>New persona</h3>
				<form method="POST" action="?/createPersona" use:enhance>
					<div class="two">
						<label>First name<input name="firstname" required /></label>
						<label>Last name<input name="lastname" required /></label>
					</div>
					<div class="two">
						<label>Role label<input name="role_label" placeholder="e.g. User" /></label>
						<label>Home region<input name="home_region" value="eu-west-2" /></label>
					</div>
					<label class="check"><input type="checkbox" name="is_admin" /> Administration access</label>
					<button type="submit">Create persona</button>
				</form>
				<p class="hint">Add group memberships after creating to grant rights.</p>
			</div>
		{:else}
			<div class="card placeholder">Select a persona, or click <strong>+ New</strong>.</div>
		{/if}
		{#if form?.error}<p class="error">{form.error}</p>{/if}
	</section>
</div>

<style>
	.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.4rem; flex: 1; min-height: 0; }
	section { min-width: 0; display: flex; flex-direction: column; min-height: 0; }
	.col-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.6rem; gap: 0.6rem; flex: none; }
	h2 { font-size: 1rem; margin: 0; }
	.count { color: var(--text-subtle); font-weight: 400; font-size: 0.85rem; }
	h3 { font-size: 0.95rem; margin: 0 0 0.6rem; }
	h4 { font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-subtle); margin: 1rem 0 0.4rem; }
	.new-btn {
		background: var(--accent); color: var(--on-accent); text-decoration: none;
		border-radius: var(--radius); padding: 0.35rem 0.7rem; font-size: 0.82rem; font-weight: 600;
	}
	.new-btn:hover { background: var(--accent-hover); }
	.search { margin-bottom: 0.6rem; flex: none; }
	.search input { width: 100%; }

	.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.5rem 0.6rem; margin-bottom: 0.8rem; }
	.list { padding: 0.25rem; flex: 1; min-height: 0; overflow-y: auto; }
	section:last-child { overflow-y: auto; }
	.placeholder { padding: 2rem; text-align: center; color: var(--text-subtle); }
	.row { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; padding: 0.45rem 0.55rem; border-radius: var(--radius); text-decoration: none; color: var(--text); font-size: 0.88rem; }
	.row:hover { background: var(--surface-2); }
	.row.sel { background: var(--surface-active); box-shadow: inset 2px 0 0 var(--accent); }
	.row-main { font-weight: 600; }
	.row-meta { display: flex; align-items: center; gap: 0.4rem; }
	.chip { font-size: 0.68rem; color: var(--text-muted); border: 1px solid var(--border); border-radius: 999px; padding: 0.05rem 0.45rem; }
	.chip.admin { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
	.muted { color: var(--text-subtle); font-size: 0.78rem; }
	.empty { color: var(--text-subtle); padding: 0.8rem; margin: 0; text-align: center; }

	.pager { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; padding: 0.6rem 0.2rem 0; flex: none; border-top: 1px solid var(--divider); }
	.pg { color: var(--accent); text-decoration: none; font-size: 0.82rem; }
	.pg.disabled { color: var(--text-subtle); pointer-events: none; }

	.detail { padding: 0.9rem; }
	form { display: flex; flex-direction: column; gap: 0.6rem; }
	.two { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; }
	label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8rem; color: var(--text-muted); }
	.check { flex-direction: row; align-items: center; gap: 0.4rem; }
	input { background: var(--bg-app); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.4rem 0.55rem; font: inherit; font-size: 0.85rem; }
	input:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	button[type='submit'] { align-self: flex-start; background: var(--accent); color: var(--on-accent); border: none; border-radius: var(--radius); padding: 0.45rem 0.8rem; font: inherit; font-weight: 600; font-size: 0.85rem; cursor: pointer; }
	button[type='submit']:hover { background: var(--accent-hover); }

	.members { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.3rem; }
	.members li { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; font-size: 0.85rem; }
	.link-btn { background: none; border: none; color: var(--accent); cursor: pointer; font: inherit; font-size: 0.8rem; padding: 0; text-decoration: none; }
	.link-btn:hover { text-decoration: underline; }
	.add-member { margin-top: 0.6rem; }
	.add-member > input { width: 100%; }
	.results { list-style: none; padding: 0; margin: 0.4rem 0 0; display: flex; flex-direction: column; gap: 0.2rem; }
	.results li { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; font-size: 0.82rem; }
	.hint { color: var(--text-subtle); font-size: 0.78rem; margin: 0.4rem 0 0; }
	.error { color: var(--danger); font-size: 0.85rem; margin: 0.4rem 0 0; }
	.danger-zone { margin-top: 1.2rem; padding-top: 0.8rem; border-top: 1px solid var(--divider); }
	button[type='submit'].danger-btn { background: var(--danger); color: #fff; border: none; border-radius: var(--radius); padding: 0.4rem 0.8rem; font: inherit; font-size: 0.82rem; font-weight: 600; cursor: pointer; }
	button[type='submit'].danger-btn:hover { background: color-mix(in srgb, var(--danger) 82%, #000); }
	code { background: var(--surface-2); padding: 0 0.3rem; border-radius: 3px; font-size: 0.78rem; color: var(--text-muted); }

	@media (max-width: 60rem) { .grid { grid-template-columns: 1fr; } }
</style>
