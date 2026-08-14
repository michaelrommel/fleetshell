<script lang="ts">
	import { base } from '$app/paths';
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	// Group type-ahead for the membership editor.
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
</script>

<div class="grid">
	<!-- Personas column -->
	<section>
		<div class="col-head">
			<h2>Personas</h2>
			<form method="GET" class="search">
				<input name="q" placeholder="Search name / id / role" value={data.q} />
			</form>
		</div>

		<div class="card list">
			{#each data.personas as p (p.user_id)}
				<a class="row" class:sel={p.user_id === data.selPersona}
				   href="{base}/administration/users?persona={encodeURIComponent(p.user_id)}">
					<span class="row-main">{p.firstname} {p.lastname}</span>
					<span class="row-meta">
						{#if p.role_label}<span class="chip">{p.role_label}</span>{/if}
						{#if p.is_admin}<span class="chip admin">admin</span>{/if}
						<span class="muted">{p.group_count} grp</span>
					</span>
				</a>
			{:else}
				<p class="empty">No personas. Create one below.</p>
			{/each}
		</div>

		<details class="card form-card">
			<summary>+ New persona</summary>
			<form method="POST" action="?/createPersona" use:enhance>
				<div class="two">
					<label>First name<input name="firstname" required /></label>
					<label>Last name<input name="lastname" required /></label>
				</div>
				<div class="two">
					<label>Role label<input name="role_label" placeholder="e.g. BURepresentative" /></label>
					<label>Home region<input name="home_region" value="eu-west-2" /></label>
				</div>
				<label class="check"><input type="checkbox" name="is_admin" /> Administration access (is_admin)</label>
				<button type="submit">Create persona</button>
			</form>
		</details>

		{#if data.personaDetail}
			<div class="card detail">
				<h3>Edit persona <code>{data.personaDetail.user_id}</code></h3>
				<form method="POST" action="?/updatePersona" use:enhance>
					<input type="hidden" name="user_id" value={data.personaDetail.user_id} />
					<div class="two">
						<label>First name<input name="firstname" value={data.personaDetail.firstname} required /></label>
						<label>Last name<input name="lastname" value={data.personaDetail.lastname} required /></label>
					</div>
					<label>Role label<input name="role_label" value={data.personaDetail.role_label ?? ''} /></label>
					<label class="check">
						<input type="checkbox" name="is_admin" checked={data.personaDetail.is_admin} /> Administration access
					</label>
					<button type="submit">Save</button>
				</form>

				<h4>Group memberships</h4>
				<ul class="members">
					{#each data.memberships as m (m.group_id)}
						<li>
							<span>{m.label}</span>
							<form method="POST" action="?/removeMembership" use:enhance>
								<input type="hidden" name="user_id" value={data.personaDetail.user_id} />
								<input type="hidden" name="group_id" value={m.group_id} />
								<button type="submit" class="link-btn">remove</button>
							</form>
						</li>
					{:else}
						<li class="muted">No memberships.</li>
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
										<input type="hidden" name="user_id" value={data.personaDetail.user_id} />
										<input type="hidden" name="group_id" value={g.group_id} />
										<button type="submit" class="link-btn">add</button>
									</form>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			</div>
		{/if}
	</section>

	<!-- Accounts column -->
	<section>
		<div class="col-head"><h2>Login accounts</h2></div>

		<div class="card list">
			{#each data.accounts as a (a.account_id)}
				<a class="row" class:sel={a.account_id === data.selAccount}
				   href="{base}/administration/users?account={encodeURIComponent(a.account_id)}">
					<span class="row-main">{a.username}</span>
					<span class="row-meta">
						<span class="muted">{a.email}</span>
						<span class="chip">{a.identity_count} id</span>
					</span>
				</a>
			{:else}
				<p class="empty">No accounts yet.</p>
			{/each}
		</div>

		<details class="card form-card">
			<summary>+ New account</summary>
			<form method="POST" action="?/createAccount" use:enhance>
				<div class="two">
					<label>Username<input name="username" autocomplete="off" required /></label>
					<label>Display name<input name="display_name" /></label>
				</div>
				<label>Email<input name="email" type="email" required /></label>
				<label>Password<input name="password" type="password" autocomplete="new-password" required /></label>
				<button type="submit">Create account</button>
			</form>
		</details>

		{#if data.accountDetail}
			<div class="card detail">
				<h3>{data.accountDetail.username} <code>{data.accountDetail.account_id}</code></h3>
				<h4>Linked identities</h4>
				<ul class="members">
					{#each data.linked as p (p.user_id)}
						<li>
							<span>{p.firstname} {p.lastname}{#if p.role_label} &middot; {p.role_label}{/if}</span>
							<form method="POST" action="?/unlinkIdentity" use:enhance>
								<input type="hidden" name="account_id" value={data.accountDetail.account_id} />
								<input type="hidden" name="user_id" value={p.user_id} />
								<button type="submit" class="link-btn">unlink</button>
							</form>
						</li>
					{:else}
						<li class="muted">No linked identities. Add one below.</li>
					{/each}
				</ul>

				<form method="POST" action="?/linkIdentity" use:enhance class="link-form">
					<input type="hidden" name="account_id" value={data.accountDetail.account_id} />
					<input name="user_id" placeholder="persona user_id (e.g. eu:123)" required />
					<button type="submit">Link identity</button>
				</form>
				<p class="hint">Tip: select a persona on the left to copy its user_id.</p>
			</div>
		{/if}
	</section>
</div>

{#if form?.error}<p class="error">{form.error}</p>{/if}

<style>
	.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.4rem; align-items: start; }
	section { min-width: 0; }
	.col-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.6rem; gap: 0.6rem; }
	h2 { font-size: 1rem; margin: 0; }
	h3 { font-size: 0.95rem; margin: 0 0 0.6rem; }
	h4 { font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-subtle); margin: 1rem 0 0.4rem; }
	.search input { width: 14rem; }

	.card {
		background: var(--surface); border: 1px solid var(--border);
		border-radius: var(--radius); padding: 0.5rem 0.6rem; margin-bottom: 0.8rem;
	}
	.list { padding: 0.25rem; max-height: 22rem; overflow-y: auto; }
	.row {
		display: flex; align-items: center; justify-content: space-between; gap: 0.6rem;
		padding: 0.45rem 0.55rem; border-radius: var(--radius);
		text-decoration: none; color: var(--text); font-size: 0.88rem;
	}
	.row:hover { background: var(--surface-2); }
	.row.sel { background: var(--surface-active); box-shadow: inset 2px 0 0 var(--accent); }
	.row-main { font-weight: 600; }
	.row-meta { display: flex; align-items: center; gap: 0.4rem; }
	.chip {
		font-size: 0.68rem; color: var(--text-muted);
		border: 1px solid var(--border); border-radius: 999px; padding: 0.05rem 0.45rem;
	}
	.chip.admin { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
	.muted { color: var(--text-subtle); font-size: 0.78rem; }
	.empty { color: var(--text-subtle); padding: 0.8rem; margin: 0; text-align: center; }

	.form-card summary { cursor: pointer; font-size: 0.88rem; padding: 0.3rem 0.3rem; color: var(--text-muted); }
	.form-card[open] summary { color: var(--text); margin-bottom: 0.6rem; }
	.detail { padding: 0.9rem; }

	form { display: flex; flex-direction: column; gap: 0.6rem; }
	.two { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; }
	label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8rem; color: var(--text-muted); }
	.check { flex-direction: row; align-items: center; gap: 0.4rem; }
	input {
		background: var(--bg-app); color: var(--text);
		border: 1px solid var(--border); border-radius: var(--radius);
		padding: 0.4rem 0.55rem; font: inherit; font-size: 0.85rem;
	}
	input:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	button[type='submit'] {
		align-self: flex-start; background: var(--accent); color: var(--on-accent);
		border: none; border-radius: var(--radius); padding: 0.45rem 0.8rem;
		font: inherit; font-weight: 600; font-size: 0.85rem; cursor: pointer;
	}
	button[type='submit']:hover { background: var(--accent-hover); }

	.members { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.3rem; }
	.members li { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; font-size: 0.85rem; }
	.link-btn { background: none; border: none; color: var(--accent); cursor: pointer; font: inherit; font-size: 0.8rem; padding: 0; text-decoration: underline; }
	.add-member { margin-top: 0.6rem; }
	.add-member > input { width: 100%; }
	.results { list-style: none; padding: 0; margin: 0.4rem 0 0; display: flex; flex-direction: column; gap: 0.2rem; }
	.results li { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; font-size: 0.82rem; }
	.link-form { flex-direction: row; align-items: center; gap: 0.5rem; margin-top: 0.6rem; }
	.link-form input { flex: 1; }
	.hint { color: var(--text-subtle); font-size: 0.78rem; margin: 0.4rem 0 0; }
	.error {
		color: var(--danger); font-size: 0.85rem; margin: 1rem 0 0;
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
		border-radius: var(--radius); padding: 0.5rem 0.7rem;
	}
	code { background: var(--surface-2); padding: 0 0.3rem; border-radius: 3px; font-size: 0.78rem; color: var(--text-muted); }

	@media (max-width: 60rem) { .grid { grid-template-columns: 1fr; } }
</style>
