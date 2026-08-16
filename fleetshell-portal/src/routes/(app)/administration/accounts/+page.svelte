<script lang="ts">
	import { base } from '$app/paths';
	import { page as pageState } from '$app/state';
	import { enhance } from '$app/forms';
	import SplitPane from '$lib/components/SplitPane.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';

	let { data, form } = $props();
	let confirmDelete = $state(false);

	// Create-form: default persona mode + existing-persona picker.
	let defaultMode = $state<'new' | 'existing'>('new');
	let defQuery = $state('');
	let defResults = $state<{ user_id: string; firstname: string; lastname: string; role_label: string | null }[]>([]);
	let defChosen = $state<{ user_id: string; label: string } | null>(null);

	// Detail: link-existing persona picker.
	let linkQuery = $state('');
	let linkResults = $state<{ user_id: string; firstname: string; lastname: string; role_label: string | null }[]>([]);

	async function searchPersonas(q: string) {
		if (q.trim().length < 2) return [];
		const res = await fetch(`${base}/api/administration/personas?q=${encodeURIComponent(q.trim())}`);
		return res.ok ? (await res.json()).personas : [];
	}
	async function searchDef() { defResults = await searchPersonas(defQuery); }
	async function searchLink() { linkResults = await searchPersonas(linkQuery); }

	function withParams(changes: Record<string, string | null>): string {
		const u = new URLSearchParams(pageState.url.searchParams);
		for (const [k, v] of Object.entries(changes)) v === null ? u.delete(k) : u.set(k, v);
		return `${base}/administration/accounts?${u}`;
	}
	const prevHref = $derived(withParams({ page: String(data.page - 1), before: data.prevCursor, after: null }));
	const nextHref = $derived(withParams({ page: String(data.page + 1), after: data.nextCursor, before: null }));
	const newHref = $derived(withParams({ new: '1', account: null }));
	const cancelHref = $derived(withParams({ new: null, account: null }));
	const selHref = (id: string) => withParams({ account: id, new: null });

	function personaHref(uid: string): string {
		return `${base}/administration/personas?sel=${encodeURIComponent(uid)}`;
	}

	const primary = $derived(data.linked.find((p) => p.is_primary) ?? null);
	const others = $derived(data.linked.filter((p) => !p.is_primary));
</script>

<SplitPane storageKey="accounts" defaultLeft={40}>
	{#snippet left()}
		<div class="col-head">
			<h2>Accounts <span class="count">{data.total}</span></h2>
			<a class="new-btn" href={newHref}>+ New account</a>
		</div>

		<form method="GET" class="search">
			<input name="q" placeholder="Search username / email" value={data.q} />
		</form>

		<div class="card list">
			{#each data.accounts as a (a.account_id)}
				<a class="row" class:sel={a.account_id === data.sel} href={selHref(a.account_id)}>
					<span class="row-main">{a.username}</span>
					<span class="row-meta">
						<span class="muted">{a.email}</span>
						{#if a.persona_count === 0}
							<span class="chip warn" title="No linked persona: cannot sign in">no login</span>
						{:else}
							<span class="chip" title="linked personas">{a.persona_count} pers</span>
						{/if}
					</span>
				</a>
			{:else}
				<p class="empty">No accounts found.</p>
			{/each}
		</div>

		{#if data.total > data.accounts.length || data.page > 1}
			<div class="pager">
				<a class="pg" class:disabled={!data.hasPrev} href={prevHref}>Prev</a>
				<span class="muted">{data.from}-{data.to} of {data.total}</span>
				<a class="pg" class:disabled={!data.hasNext} href={nextHref}>Next</a>
			</div>
		{/if}
	{/snippet}

	{#snippet right()}
		{#if data.detail}
			<div class="card detail">
				<h3>{data.detail.username} <code>{data.detail.account_id}</code></h3>
				<form id="accountEdit" method="POST" action="?/updateAccount" use:enhance>
					<input type="hidden" name="account_id" value={data.detail.account_id} />
					<div class="two">
						<label>Email<input name="email" type="email" value={data.detail.email} required /></label>
						<label>Display name<input name="display_name" value={data.detail.display_name ?? ''} /></label>
					</div>
					<label>Reset password<input name="password" type="password" autocomplete="new-password" placeholder="leave blank to keep" /></label>
				</form>

				<h4>Default persona</h4>
				{#if primary}
					<ul class="members">
						<li>
							<span>{primary.firstname} {primary.lastname}{#if primary.role_label} &middot; {primary.role_label}{/if}
								{#if primary.is_admin}<span class="chip admin">admin</span>{/if}</span>
							<a class="link-btn" href={personaHref(primary.user_id)}>View</a>
						</li>
					</ul>
				{:else}
					<p class="warn-box">This account has no default persona and cannot sign in.</p>
				{/if}

				<h4>Additional personas</h4>
				<ul class="members">
					{#each others as p (p.user_id)}
						<li>
							<span>{p.firstname} {p.lastname}{#if p.role_label} &middot; {p.role_label}{/if}</span>
							<span class="actions">
								<a class="link-btn" href={personaHref(p.user_id)}>View</a>
								<form method="POST" action="?/makeDefault" use:enhance>
									<input type="hidden" name="account_id" value={data.detail.account_id} />
									<input type="hidden" name="user_id" value={p.user_id} />
									<button type="submit" class="link-btn">Make default</button>
								</form>
								<form method="POST" action="?/unlinkPersona" use:enhance>
									<input type="hidden" name="account_id" value={data.detail.account_id} />
									<input type="hidden" name="user_id" value={p.user_id} />
									<button type="submit" class="link-btn danger">Unlink</button>
								</form>
							</span>
						</li>
					{:else}
						<li class="muted">None. Link or create more personas below.</li>
					{/each}
				</ul>

				<h4>Add a persona</h4>
				<input placeholder="Search existing persona" bind:value={linkQuery} oninput={searchLink} />
				{#if linkResults.length}
					<ul class="results">
						{#each linkResults as p (p.user_id)}
							<li>
								<span>{p.firstname} {p.lastname}{#if p.role_label} &middot; {p.role_label}{/if} <span class="muted">{p.user_id}</span></span>
								<form method="POST" action="?/linkPersona" use:enhance>
									<input type="hidden" name="account_id" value={data.detail.account_id} />
									<input type="hidden" name="user_id" value={p.user_id} />
									<button type="submit" class="link-btn">Link</button>
								</form>
							</li>
						{/each}
					</ul>
				{/if}

				<details class="sub-form">
					<summary>+ Create &amp; link a new persona</summary>
					<form method="POST" action="?/createAndLinkPersona" use:enhance>
						<input type="hidden" name="account_id" value={data.detail.account_id} />
						<div class="two">
							<label>First name<input name="firstname" required /></label>
							<label>Last name<input name="lastname" required /></label>
						</div>
						<div class="two">
							<label>Role label<input name="role_label" /></label>
							<label>Home region<input name="home_region" value="eu-west-2" /></label>
						</div>
						<label class="check"><input type="checkbox" name="is_admin" /> Administration access</label>
						<div class="actions-bar"><button type="submit" class="act-primary">Create &amp; link</button></div>
					</form>
				</details>

				<div class="actions-bar">
					<button type="button" class="act-delete" onclick={() => (confirmDelete = true)}>Delete account</button>
					<button type="submit" form="accountEdit" class="act-primary">Save</button>
				</div>
			</div>
		{:else if data.isNew}
			<div class="card detail">
				<h3>New account</h3>
				<form method="POST" action="?/createAccount" use:enhance>
					<div class="two">
						<label>Username<input name="username" autocomplete="off" required /></label>
						<label>Display name<input name="display_name" /></label>
					</div>
					<label>Email<input name="email" type="email" required /></label>
					<label>Password<input name="password" type="password" autocomplete="new-password" required /></label>

					<h4>Default persona</h4>
					<div class="modes">
						<label class="radio"><input type="radio" name="default_mode" value="new" bind:group={defaultMode} /> Create a new persona</label>
						<label class="radio"><input type="radio" name="default_mode" value="existing" bind:group={defaultMode} /> Link an existing persona</label>
					</div>

					{#if defaultMode === 'new'}
						<div class="nested">
							<div class="two">
								<label>First name<input name="firstname" /></label>
								<label>Last name<input name="lastname" /></label>
							</div>
							<div class="two">
								<label>Role label<input name="role_label" placeholder="e.g. User" /></label>
								<label>Home region<input name="home_region" value="eu-west-2" /></label>
							</div>
							<label class="check"><input type="checkbox" name="is_admin" /> Administration access</label>
						</div>
					{:else}
						<div class="nested">
							<input type="hidden" name="default_user_id" value={defChosen?.user_id ?? ''} />
							{#if defChosen}
								<p class="chosen">Default: <strong>{defChosen.label}</strong> <button type="button" class="link-btn" onclick={() => (defChosen = null)}>Change</button></p>
							{:else}
								<input placeholder="Search existing persona" bind:value={defQuery} oninput={searchDef} />
								{#if defResults.length}
									<ul class="results">
										{#each defResults as p (p.user_id)}
											<li>
												<span>{p.firstname} {p.lastname}{#if p.role_label} &middot; {p.role_label}{/if} <span class="muted">{p.user_id}</span></span>
												<button type="button" class="link-btn" onclick={() => { defChosen = { user_id: p.user_id, label: `${p.firstname} ${p.lastname}` }; defResults = []; }}>Choose</button>
											</li>
										{/each}
									</ul>
								{/if}
							{/if}
						</div>
					{/if}

					<div class="actions-bar">
						<a class="act-cancel" href={cancelHref}>Cancel</a>
						<button type="submit" class="act-primary">Create account</button>
					</div>
				</form>
			</div>
		{:else}
			<div class="card placeholder">Select an account, or click <strong>+ New Account</strong>.</div>
		{/if}
		{#if form?.error}<p class="error">{form.error}</p>{/if}
	{/snippet}
</SplitPane>

{#if data.detail}
	<ConfirmDialog bind:open={confirmDelete} title="Delete account?" message={`Delete "${data.detail.username}"? Its personas are kept.`}>
		<form method="POST" action="?/deleteAccount" use:enhance={() => async ({ update }) => { confirmDelete = false; await update(); }}>
			<input type="hidden" name="account_id" value={data.detail.account_id} />
			<button type="submit" class="act-delete">Delete</button>
		</form>
	</ConfirmDialog>
{/if}

<style>
	.col-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.6rem; gap: 0.6rem; flex: none; }
	h2 { font-size: 1rem; margin: 0; }
	.count { color: var(--text-subtle); font-weight: 400; font-size: 0.85rem; }
	h3 { font-size: 0.95rem; margin: 0 0 0.6rem; }
	h4 { font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-subtle); margin: 1rem 0 0.4rem; }
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
	.chip.admin { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
	.chip.warn { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, transparent); }
	.muted { color: var(--text-subtle); font-size: 0.78rem; }
	.empty { color: var(--text-subtle); padding: 0.8rem; margin: 0; text-align: center; }

	.pager { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; padding: 0.6rem 0.2rem 0; flex: none; border-top: 1px solid var(--divider); }
	.pg { color: var(--accent); text-decoration: none; font-size: 0.82rem; }
	.pg.disabled { color: var(--text-subtle); pointer-events: none; }

	.detail { padding: 0.9rem; }
	form { display: flex; flex-direction: column; gap: 0.6rem; }
	.two { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; }
	label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8rem; color: var(--text-muted); }
	.check, .radio { flex-direction: row; align-items: center; gap: 0.4rem; }
	.modes { display: flex; gap: 1rem; flex-wrap: wrap; }
	.nested { border-left: 2px solid var(--border); padding-left: 0.8rem; display: flex; flex-direction: column; gap: 0.6rem; }
	input:not([type='checkbox']) { background: var(--bg-app); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.4rem 0.55rem; font: inherit; font-size: 0.85rem; }
	input[type='radio'] { width: auto; }
	input:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	button[type='submit']:not(.link-btn) { align-self: flex-start; background: var(--accent); color: var(--on-accent); border: none; border-radius: var(--radius); padding: 0.45rem 0.8rem; font: inherit; font-weight: 600; font-size: 0.85rem; cursor: pointer; }
	button[type='submit']:not(.link-btn):hover { background: var(--accent-hover); }

	.members { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.3rem; }
	.members li { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; font-size: 0.85rem; }
	.members .actions { display: flex; align-items: center; gap: 0.6rem; }
	.link-btn { background: none; border: none; color: var(--accent); cursor: pointer; font: inherit; font-size: 0.8rem; padding: 0; text-decoration: none; }
	.link-btn:hover { text-decoration: underline; }
	.link-btn.danger { color: var(--danger); }
	.results { list-style: none; padding: 0; margin: 0.4rem 0 0; display: flex; flex-direction: column; gap: 0.2rem; }
	.results li { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; font-size: 0.82rem; }
	.chosen { font-size: 0.84rem; margin: 0; }
	.sub-form { margin-top: 0.8rem; }
	.sub-form summary { cursor: pointer; font-size: 0.82rem; color: var(--text-muted); }
	.sub-form[open] summary { color: var(--text); margin-bottom: 0.5rem; }
	.warn-box { color: var(--danger); font-size: 0.82rem; margin: 0; background: color-mix(in srgb, var(--danger) 10%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent); border-radius: var(--radius); padding: 0.45rem 0.6rem; }
	.error { color: var(--danger); font-size: 0.85rem; margin: 0.4rem 0 0; }
	code { background: var(--surface-2); padding: 0 0.3rem; border-radius: 3px; font-size: 0.78rem; color: var(--text-muted); }

</style>
