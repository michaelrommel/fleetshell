<!--
	File Subscriptions (Services > File Subscriptions).

	Two inner views, bidirectionally editing the same attachment:
	  - Subscriber Servers : delivery targets (ADLS / S3 / SCP) master-detail CRUD.
	                         Secrets are stored plaintext in the `auth` jsonb. Its
	                         detail also lists the attached subscriptions (with
	                         remove + search-add).
	  - Subscriptions      : file matchers (modality/product filter + PCRE pattern
	                         + negate) master-detail CRUD. Its detail attaches the
	                         subscription to servers via a tickable server grid.
-->
<script lang="ts">
	import { base } from '$app/paths';
	import { page as pageState } from '$app/state';
	import { enhance } from '$app/forms';
	import EntityPicker from '$lib/components/EntityPicker.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import SplitPane from '$lib/components/SplitPane.svelte';

	let { data, form } = $props();

	const canEdit = $derived(data.isAdmin);

	const views = [
		{ id: 'servers',       label: 'Subscriber Servers' },
		{ id: 'subscriptions', label: 'Subscriptions' },
	];

	function href(changes: Record<string, string | null>): string {
		const u = new URLSearchParams(pageState.url.searchParams);
		for (const [k, v] of Object.entries(changes)) v === null ? u.delete(k) : u.set(k, v);
		return `${base}/services/subscriptions?${u}`;
	}

	// ---- selected records ---------------------------------------------------
	const server = $derived(data.server as Record<string, any> | null);
	const subscription = $derived(data.subscription as Record<string, any> | null);
	// Boolean form fields need seeded $state + bind:checked -- a one-way
	// checked={expr} makes the checkbox controlled/read-only in Svelte 5.
	let activated = $state(false);
	let usePartnoFolder = $state(false);
	let negate = $state(false);
	const showServerForm = $derived(canEdit && (data.isNew || !!server));
	const showSubForm = $derived(canEdit && (data.isNew || !!subscription));

	// ---- server form: delivery + auth method (reseeded per selection) -------
	let deliveryMethod = $state('adls');
	let adlsMethod = $state('service_principal');
	let s3Method = $state('access_key');
	$effect(() => {
		void data.sel; void data.isNew;
		const s = data.server as Record<string, any> | null;
		const auth = (s?.auth ?? {}) as Record<string, string>;
		deliveryMethod = (s?.delivery_method as string) ?? 'adls';
		adlsMethod = auth.method === 'default' ? 'default' : 'service_principal';
		s3Method = auth.method === 'assume_role' ? 'assume_role' : 'access_key';
		activated = !!s?.activated;
		usePartnoFolder = !!s?.use_partno_folder;
	});
	const auth = $derived((server?.auth ?? {}) as Record<string, string>);

	// ---- subscription form: selected modality scopes the product picker ------
	let subModalityId = $state('');
	$effect(() => {
		void data.sel; void data.isNew;
		subModalityId = ((data.subscription as Record<string, any> | null)?.modality_id as string) ?? '';
		negate = !!(data.subscription as Record<string, any> | null)?.negate;
	});

	// ---- server detail: attached-subscriptions list (staged, saved together) --
	type SubLite = { id: string; name: string; modality_name: string | null; product_name: string | null };
	let attSubs = $state<SubLite[]>([]);
	let subQuery = $state('');
	$effect(() => {
		void data.sel; void data.view;
		attSubs = [...(data.attachedSubs as SubLite[])];
		subQuery = '';
	});
	const attSubIds = $derived(new Set(attSubs.map((s) => s.id)));
	const subMatches = $derived.by(() => {
		const q = subQuery.trim().toLowerCase();
		if (!q) return [];
		return (data.subscriptions as SubLite[])
			.filter((s) => !attSubIds.has(s.id) && s.name.toLowerCase().includes(q))
			.slice(0, 12);
	});
	function addSub(s: SubLite) {
		attSubs = [...attSubs, { id: s.id, name: s.name, modality_name: s.modality_name, product_name: s.product_name }];
		subQuery = '';
	}
	function removeSub(id: string) { attSubs = attSubs.filter((s) => s.id !== id); }
	const attSubsJson = $derived(JSON.stringify(attSubs.map((s) => s.id)));

	// ---- subscription detail: server grid (staged, saved together) -----------
	let attServerIds = $state(new Set<string>());
	let serverFilter = $state('');
	$effect(() => {
		void data.sel; void data.view;
		attServerIds = new Set(data.attachedServerIds as string[]);
		serverFilter = '';
	});
	function toggleServer(id: string) {
		if (attServerIds.has(id)) attServerIds.delete(id); else attServerIds.add(id);
		attServerIds = new Set(attServerIds); // nudge reactivity
	}
	const attServersJson = $derived(JSON.stringify([...attServerIds]));
	const filteredServers = $derived.by(() => {
		const q = serverFilter.trim().toLowerCase();
		const all = data.servers as { id: string; name: string; ip_address: string | null }[];
		return q ? all.filter((s) => s.name.toLowerCase().includes(q) || (s.ip_address ?? '').includes(q)) : all;
	});

	// ---- confirm dialogs ----------------------------------------------------
	let confirmDelServer = $state(false);
	let confirmDelSub = $state(false);

	const deliveryLabel: Record<string, string> = { adls: 'ADLS', s3: 'S3', scp: 'SCP' };
	const useCaseLabel: Record<string, string> = {
		compliance: 'Compliance', internal: 'Internal Business Purposes',
	};
</script>

<div class="fs">
	{#if form?.error}<p class="msg error">{form.error}</p>{/if}
	{#if form?.notice}<p class="msg info">{form.notice}</p>{/if}

	<!-- inner view tabs + spool-out -->
	<div class="subbar">
		<nav class="subtabs">
			{#each views as v (v.id)}
				<a href={href({ view: v.id, sel: null, new: null })} class:active={data.view === v.id}>{v.label}</a>
			{/each}
		</nav>
		{#if canEdit}
			<form method="POST" action="?/spoolValkey" use:enhance>
				<button type="submit" class="act-primary spool" title="Write the resolved subscriptions to Valkey for aeroftp">Save to Valkey</button>
			</form>
		{/if}
	</div>

	<!-- ===================== SUBSCRIBER SERVERS ======================== -->
	{#if data.view === 'servers'}
		<SplitPane storageKey="subs-servers" defaultLeft={34}>
			{#snippet left()}
			<aside class="list">
				<div class="col-head">
					<h3>Servers <span class="count">{data.servers.length}</span></h3>
					{#if canEdit}<a class="mini mini-new" href={href({ new: '1', sel: null })}>+ New</a>{/if}
				</div>
				<div class="scroll">
					{#each data.servers as s (s.id)}
						<a class="item" class:active={s.id === data.sel && !data.isNew} href={href({ sel: s.id, new: null })}>
							<span class="item-name">{s.name}{#if !s.activated}<span class="badge off">inactive</span>{/if}</span>
							<span class="item-meta">{s.ip_address ?? 'no IP'} · {deliveryLabel[s.delivery_method]} · {useCaseLabel[s.use_case]}{#if s.country} · {s.country}{/if} · {s.sub_count} sub{s.sub_count === 1 ? '' : 's'}</span>
						</a>
					{/each}
					{#if data.servers.length === 0}<p class="empty">No servers yet.</p>{/if}
				</div>
			</aside>
			{/snippet}

			{#snippet right()}
			<section class="detail">
				{#if !showServerForm}
					<p class="empty">{server ? '' : 'Select a server, or create one.'}</p>
				{:else}
					{#key `${data.sel}-${data.isNew}`}
						<form method="POST" action="?/saveServer" use:enhance>
							<input type="hidden" name="id" value={server?.id ?? ''} />

							<div class="fieldgrid">
								<label class="f-wide">Name
									<input type="text" name="name" value={server?.name ?? ''} required autocomplete="off" />
								</label>

								<label>IP address
									<input type="text" name="ip_address" value={server?.ip_address ?? ''} autocomplete="off" placeholder="10.0.0.0" />
								</label>

								<label>Country
									<select name="country">
										<option value="" selected={!server?.country}>— none —</option>
										{#each data.countries as co (co.iso)}
											<option value={co.iso} selected={co.iso === server?.country}>{co.name} ({co.iso})</option>
										{/each}
									</select>
								</label>

								<label>Use case type
									<select name="use_case">
										<option value="compliance" selected={server?.use_case === 'compliance'}>Compliance Use Case</option>
										<option value="internal" selected={(server?.use_case ?? 'internal') === 'internal'}>Internal Business Purposes Use Case</option>
									</select>
								</label>

								<label class="f-wide">Comment
									<input type="text" name="comment" value={server?.comment ?? ''} autocomplete="off" />
								</label>

								<label class="f-check">
									<input type="checkbox" name="activated" bind:checked={activated} />
									<span>Activated</span>
								</label>

								<label>Delivery method
									<select name="delivery_method" bind:value={deliveryMethod}>
										<option value="adls">ADLS</option>
										<option value="s3">S3</option>
										<option value="scp">SCP</option>
									</select>
								</label>

								<label class="f-wide">Root path
									<input type="text" name="root_path" value={server?.root_path ?? ''} autocomplete="off" placeholder="/" />
								</label>

								<label class="f-check">
									<input type="checkbox" name="use_partno_folder" bind:checked={usePartnoFolder} />
									<span>Use part number as folder level</span>
								</label>

								<label class="f-wide">Container or sub path
									<input type="text" name="container_path" value={server?.container_path ?? ''} autocomplete="off" />
								</label>
							</div>

							<!-- ---- authentication (method-specific) ---- -->
							<fieldset class="auth">
								<legend>Authentication</legend>

								{#if deliveryMethod === 'adls'}
									<label class="f-inline">Method
										<select name="adls_method" bind:value={adlsMethod}>
											<option value="service_principal">Entra ID Service Principal</option>
											<option value="default">Default</option>
										</select>
									</label>
									{#if adlsMethod === 'service_principal'}
										<div class="fieldgrid">
											<label class="f-wide">Storage account (URL)
												<input type="url" name="storage_account" value={auth.storage_account ?? ''} autocomplete="off" />
											</label>
											<label>Tenant ID
												<input type="text" name="tenant_id" value={auth.tenant_id ?? ''} autocomplete="off" />
											</label>
											<label>Application (Client) ID
												<input type="text" name="client_id" value={auth.client_id ?? ''} autocomplete="off" />
											</label>
											<label class="f-wide">Client secret
												<input type="password" name="client_secret" value={auth.client_secret ?? ''} autocomplete="off" placeholder={auth.client_secret ? '••••••••' : ''} />
											</label>
										</div>
									{:else}
										<div class="fieldgrid">
											<label class="f-wide">Account URL
												<input type="text" name="account_url" value={auth.account_url ?? ''} autocomplete="off" />
											</label>
											<label>Account name
												<input type="text" name="account_name" value={auth.account_name ?? ''} autocomplete="off" />
											</label>
											<label>Account key
												<input type="password" name="account_key" value={auth.account_key ?? ''} autocomplete="off" placeholder={auth.account_key ? '••••••••' : ''} />
											</label>
										</div>
									{/if}

								{:else if deliveryMethod === 's3'}
									<label class="f-inline">Method
										<select name="s3_method" bind:value={s3Method}>
											<option value="access_key">Access key</option>
											<option value="assume_role">Assume role</option>
										</select>
									</label>
									{#if s3Method === 'access_key'}
										<div class="fieldgrid">
											<label>Access key ID
												<input type="text" name="access_key_id" value={auth.access_key_id ?? ''} autocomplete="off" />
											</label>
											<label>Secret access key
												<input type="password" name="secret_access_key" value={auth.secret_access_key ?? ''} autocomplete="off" placeholder={auth.secret_access_key ? '••••••••' : ''} />
											</label>
											<label>Region
												<input type="text" name="region" value={auth.region ?? ''} autocomplete="off" placeholder="eu-west-2" />
											</label>
											<label>Endpoint (optional)
												<input type="text" name="endpoint" value={auth.endpoint ?? ''} autocomplete="off" placeholder="S3-compatible only" />
											</label>
										</div>
									{:else}
										<div class="fieldgrid">
											<label class="f-wide">Role ARN
												<input type="text" name="role_arn" value={auth.role_arn ?? ''} autocomplete="off" placeholder="arn:aws:iam::…:role/…" />
											</label>
											<label>External ID
												<input type="text" name="external_id" value={auth.external_id ?? ''} autocomplete="off" />
											</label>
											<label>Region
												<input type="text" name="region" value={auth.region ?? ''} autocomplete="off" placeholder="eu-west-2" />
											</label>
										</div>
									{/if}

								{:else}
									<div class="fieldgrid">
										<label>Username
											<input type="text" name="username" value={auth.username ?? ''} autocomplete="off" />
										</label>
										<label>Password
											<input type="password" name="password" value={auth.password ?? ''} autocomplete="off" placeholder={auth.password ? '••••••••' : ''} />
										</label>
									</div>
								{/if}
							</fieldset>

							<div class="actions-bar">
								{#if server}
									<button type="button" class="act-delete" onclick={() => (confirmDelServer = true)}>Delete</button>
								{/if}
								<a class="act-cancel" href={href({ sel: null, new: null })}>Cancel</a>
								<button type="submit" class="act-primary">{server ? 'Save' : 'Create'}</button>
							</div>
						</form>

						{#if server}
							<ConfirmDialog bind:open={confirmDelServer} title="Delete subscriber server?"
								message={`Delete "${server.name}"? Its subscription attachments are removed. This cannot be undone.`}>
								<form method="POST" action="?/deleteServer" use:enhance={() => async ({ update }) => { confirmDelServer = false; await update(); }}>
									<input type="hidden" name="id" value={server.id} />
									<button type="submit" class="act-delete">Delete</button>
								</form>
							</ConfirmDialog>

							<section class="attach-block">
								<h4>Attached subscriptions <span class="count">{attSubs.length}</span></h4>
								<form method="POST" action="?/saveServerSubs" use:enhance>
									<input type="hidden" name="server_id" value={server.id} />
									<input type="hidden" name="subscription_ids" value={attSubsJson} />
									{#if attSubs.length}
										<ul class="attlist">
											{#each attSubs as s (s.id)}
												<li>
													<a href={href({ view: 'subscriptions', sel: s.id, new: null })}>{s.name}</a>
													<span class="ameta">{s.modality_name ?? 'any'}{#if s.product_name} / {s.product_name}{/if}</span>
													{#if canEdit}<button type="button" class="rm" onclick={() => removeSub(s.id)} aria-label="Remove">✕</button>{/if}
												</li>
											{/each}
										</ul>
									{:else}
										<p class="muted">No subscriptions attached.</p>
									{/if}
									{#if canEdit}
										<div class="add-row">
											<input placeholder="Search subscriptions to attach…" bind:value={subQuery} autocomplete="off" spellcheck="false" />
											{#if subMatches.length}
												<ul class="results">
													{#each subMatches as s (s.id)}
														<li><button type="button" onclick={() => addSub(s)}>{s.name}<span class="rmeta">{s.modality_name ?? 'any'}{#if s.product_name} / {s.product_name}{/if}</span></button></li>
													{/each}
												</ul>
											{/if}
										</div>
										<div class="actions-bar"><button type="submit" class="act-primary">Save attachments</button></div>
									{/if}
								</form>
							</section>
						{/if}
					{/key}
				{/if}
			</section>
			{/snippet}
		</SplitPane>

	<!-- ======================== SUBSCRIPTIONS ========================== -->
	{:else if data.view === 'subscriptions'}
		<SplitPane storageKey="subs-subscriptions" defaultLeft={34}>
			{#snippet left()}
			<aside class="list">
				<div class="col-head">
					<h3>Subscriptions <span class="count">{data.subscriptions.length}</span></h3>
					{#if canEdit}<a class="mini mini-new" href={href({ new: '1', sel: null })}>+ New</a>{/if}
				</div>
				<div class="scroll">
					{#each data.subscriptions as sub (sub.id)}
						<a class="item" class:active={sub.id === data.sel && !data.isNew} href={href({ sel: sub.id, new: null })}>
							<span class="item-name">{sub.name}{#if sub.negate}<span class="badge neg">negate</span>{/if}</span>
							<span class="item-meta">{sub.modality_name ?? 'any'}{#if sub.product_name} / {sub.product_name}{/if} · {sub.server_count} server{sub.server_count === 1 ? '' : 's'}</span>
						</a>
					{/each}
					{#if data.subscriptions.length === 0}<p class="empty">No subscriptions yet.</p>{/if}
				</div>
			</aside>
			{/snippet}

			{#snippet right()}
			<section class="detail">
				{#if !showSubForm}
					<p class="empty">{subscription ? '' : 'Select a subscription, or create one.'}</p>
				{:else}
					{#key `${data.sel}-${data.isNew}`}
						<form method="POST" action="?/saveSubscription" use:enhance>
							<input type="hidden" name="id" value={subscription?.id ?? ''} />
							<div class="fieldgrid">
								<label class="f-wide">Name
									<input type="text" name="name" value={subscription?.name ?? ''} required autocomplete="off" />
								</label>

								<label>Modality
									<select name="modality_id" bind:value={subModalityId}>
										<option value="">— any —</option>
										{#each data.modalities as m (m.id)}
											<option value={m.id}>{m.name}</option>
										{/each}
									</select>
								</label>

								<label>Product
									{#key subModalityId}
										<EntityPicker api="/api/administration/product-picker" name="product_id"
											idField="id" labelField="display"
											value={subModalityId === ((subscription?.modality_id as string) ?? '') ? (subscription?.product_id ?? null) : null}
											label={subModalityId === ((subscription?.modality_id as string) ?? '') ? (subscription?.product_name ?? null) : null}
											extraParams={{ mod: subModalityId }}
											placeholder="search product..." />
									{/key}
								</label>

								<label class="f-wide">Pattern (PCRE)
									<input type="text" name="pattern" value={subscription?.pattern ?? ''} required autocomplete="off" spellcheck="false" placeholder=".*_Eventlog_.*\.zip" class="mono" />
								</label>

								<label class="f-check">
									<input type="checkbox" name="negate" bind:checked={negate} />
									<span>Negate (exclude matches from a broader subscription)</span>
								</label>
							</div>

							<div class="actions-bar">
								{#if subscription}
									<button type="button" class="act-delete" onclick={() => (confirmDelSub = true)}>Delete</button>
								{/if}
								<a class="act-cancel" href={href({ sel: null, new: null })}>Cancel</a>
								<button type="submit" class="act-primary">{subscription ? 'Save' : 'Create'}</button>
							</div>
						</form>

						{#if subscription}
							<ConfirmDialog bind:open={confirmDelSub} title="Delete subscription?"
								message={`Delete "${subscription.name}"? Its server attachments are removed. This cannot be undone.`}>
								<form method="POST" action="?/deleteSubscription" use:enhance={() => async ({ update }) => { confirmDelSub = false; await update(); }}>
									<input type="hidden" name="id" value={subscription.id} />
									<button type="submit" class="act-delete">Delete</button>
								</form>
							</ConfirmDialog>

							<section class="attach-block">
								<h4>Delivered to servers <span class="count">{attServerIds.size}</span></h4>
								<form method="POST" action="?/saveSubServers" use:enhance>
									<input type="hidden" name="subscription_id" value={subscription.id} />
									<input type="hidden" name="server_ids" value={attServersJson} />
									{#if canEdit}
										<input class="grid-filter" placeholder="Filter servers…" bind:value={serverFilter} autocomplete="off" spellcheck="false" />
									{/if}
									<div class="server-grid">
										{#each filteredServers as s (s.id)}
											<label class="srv-chip" class:on={attServerIds.has(s.id)}>
												<input type="checkbox" checked={attServerIds.has(s.id)} disabled={!canEdit} onchange={() => toggleServer(s.id)} />
												<span class="srv-name">{s.name}</span>
												<span class="srv-meta">{s.ip_address ?? 'no IP'}</span>
											</label>
									{/each}
										{#if filteredServers.length === 0}<p class="muted">No servers match.</p>{/if}
									</div>
									{#if canEdit}
										<div class="actions-bar"><button type="submit" class="act-primary">Save servers</button></div>
									{/if}
								</form>
							</section>
						{/if}
					{/key}
				{/if}
			</section>
			{/snippet}
		</SplitPane>
	{/if}
</div>

<style>
	.fs { display: flex; flex-direction: column; min-height: 0; flex: 1; gap: 0.9rem; }
	.msg { margin: 0; padding: 0.5rem 0.75rem; border-radius: var(--radius); font-size: 0.85rem; }
	.msg.error { background: color-mix(in srgb, var(--danger) 14%, transparent); color: var(--danger); }
	.msg.info { background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); }
	.empty { color: var(--text-subtle); font-size: 0.9rem; padding: 1rem 0; }

	.subbar { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; border-bottom: 1px solid var(--border); }
	.subbar .spool { margin-bottom: 0.4rem; }
	.subtabs { display: flex; gap: 1.2rem; }
	.subtabs a { padding: 0.5rem 0.1rem; color: var(--text-muted); text-decoration: none; font-size: 0.88rem; border-bottom: 2px solid transparent; margin-bottom: -1px; }
	.subtabs a:hover { color: var(--text); }
	.subtabs a.active { color: var(--text); border-bottom-color: var(--accent); }

	/* master-detail (inside SplitPane panes) */
	.col-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 0.5rem; gap: 0.5rem; }
	h3 { font-size: 1rem; margin: 0; }
	.count { color: var(--text-subtle); font-weight: 400; font-size: 0.82rem; }
	.list { flex: 1; display: flex; flex-direction: column; gap: 0.2rem; min-height: 0; }
	.scroll { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 0.2rem; padding-right: 2px; }
	.detail { min-height: 0; padding-right: 4px; }
	.item { display: flex; flex-direction: column; gap: 0.15rem; padding: 0.5rem 0.6rem; border: 1px solid var(--border); border-radius: var(--radius); text-decoration: none; color: var(--text); }
	.item:hover { background: var(--surface-2); }
	.item.active { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
	.item-name { font-size: 0.9rem; display: flex; align-items: center; gap: 0.4rem; }
	.item-meta { font-size: 0.72rem; color: var(--text-subtle); }
	.badge { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.05rem 0.35rem; border-radius: 999px; }
	.badge.off { background: color-mix(in srgb, var(--text-subtle) 25%, transparent); color: var(--text-muted); }
	.badge.neg { background: color-mix(in srgb, var(--danger) 18%, transparent); color: var(--danger); }
	.mini { background: var(--surface-2); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.25rem 0.6rem; font: inherit; font-size: 0.8rem; cursor: pointer; text-decoration: none; }
	.mini:hover { background: var(--surface); }
	.mini-new { background: var(--accent); color: var(--on-accent); border-color: var(--accent); font-weight: 600; }
	.mini-new:hover { background: var(--accent-hover); border-color: var(--accent-hover); }

	/* form */
	.fieldgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.8rem 1rem; }
	.fieldgrid label, .auth label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-subtle); }
	.f-wide { grid-column: 1 / -1; }
	.f-check { flex-direction: row !important; align-items: center; gap: 0.5rem !important; text-transform: none; letter-spacing: normal; font-size: 0.85rem; color: var(--text); grid-column: 1 / -1; }
	.f-check input { width: 15px; height: 15px; flex: none; }
	.f-inline { flex-direction: row !important; align-items: center; gap: 0.6rem !important; margin-bottom: 0.8rem; }
	.fieldgrid input:not([type='checkbox']), .fieldgrid select, .auth input:not([type='checkbox']), .auth select {
		background: var(--surface); color: var(--text); border: 1px solid var(--border);
		border-radius: var(--radius); padding: 0.4rem 0.55rem; font: inherit; font-size: 0.88rem; text-transform: none; letter-spacing: normal;
	}
	.fieldgrid input:focus-visible, .fieldgrid select:focus-visible, .auth input:focus-visible, .auth select:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	.mono { font-family: monospace; }

	.auth { border: 1px solid var(--border); border-radius: var(--radius); padding: 0.9rem 1rem 1.1rem; margin-top: 1rem; }
	.auth legend { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-subtle); padding: 0 0.4rem; }

	/* attachment editors (server detail list + subscription detail grid) */
	.attach-block { margin-top: 1.6rem; border-top: 1px solid var(--border); padding-top: 1rem; }
	.attach-block h4 { margin: 0 0 0.6rem; font-size: 0.95rem; display: flex; align-items: baseline; gap: 0.4rem; }
	.muted { color: var(--text-subtle); font-size: 0.85rem; margin: 0.2rem 0; }

	.attlist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.2rem; }
	.attlist li { display: flex; align-items: center; gap: 0.6rem; padding: 0.35rem 0.5rem; border: 1px solid var(--border); border-radius: var(--radius); }
	.attlist li a { color: var(--text); text-decoration: none; font-size: 0.86rem; }
	.attlist li a:hover { color: var(--accent); text-decoration: underline; }
	.attlist .ameta { color: var(--text-subtle); font-size: 0.74rem; margin-left: auto; }
	.attlist .rm { flex: none; margin-left: 0.4rem; background: none; border: none; color: var(--text-subtle); cursor: pointer; font-size: 0.85rem; line-height: 1; }
	.attlist .rm:hover { color: var(--danger); }

	.add-row { position: relative; margin-top: 0.6rem; }
	.add-row input { width: 100%; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.4rem 0.55rem; font: inherit; font-size: 0.85rem; }
	.add-row input:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	.add-row .results { position: absolute; z-index: 5; left: 0; right: 0; top: 100%; margin: 0.15rem 0 0; padding: 0.2rem; list-style: none; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow, 0 4px 14px rgba(0,0,0,0.25)); max-height: 260px; overflow-y: auto; }
	.add-row .results li button { display: flex; align-items: baseline; gap: 0.5rem; width: 100%; text-align: left; background: none; border: none; color: var(--text); font: inherit; font-size: 0.84rem; padding: 0.35rem 0.5rem; border-radius: var(--radius); cursor: pointer; }
	.add-row .results li button:hover { background: var(--surface-2); }
	.add-row .rmeta { color: var(--text-subtle); font-size: 0.74rem; margin-left: auto; }

	.grid-filter { width: 100%; max-width: 22rem; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.4rem 0.55rem; font: inherit; font-size: 0.85rem; margin-bottom: 0.7rem; }
	.grid-filter:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	.server-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr)); gap: 0.4rem; }
	.srv-chip { display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0.55rem; border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; min-width: 0; }
	.srv-chip:hover { background: var(--surface-2); }
	.srv-chip.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
	.srv-chip input { flex: none; }
	.srv-name { font-size: 0.84rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.srv-meta { color: var(--text-subtle); font-size: 0.72rem; margin-left: auto; flex: none; }
</style>
