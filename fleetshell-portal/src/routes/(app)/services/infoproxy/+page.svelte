<!--
	Info Proxy (Services > Infoproxy): Squid destination authorization.

	Left  : searchable collection list, filtered by two proxy-type chips
	        (Internet / Intranet, both on by default).
	Right  : selected collection -> two sub-tabs:
	        - Destinations : the permitted URLs (rules) editor.
	        - Applies to   : three-tier scope -> global toggle / model chips /
	                         individual systems (searchable, incremental).

	Deep link ?product=<model_id> filters the list to collections bound to that
	model OR ANY (the legacy model-dialog semantics).
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { base } from '$app/paths';
	import { page as pageState } from '$app/state';
	import { enhance } from '$app/forms';
	import ScopePicker from '$lib/components/ScopePicker.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import SplitPane from '$lib/components/SplitPane.svelte';
	import { searchHotkey } from '$lib/searchHotkey';

	let { data, form } = $props();
	const canEdit = $derived(data.isAdmin);

	function href(changes: Record<string, string | null>): string {
		const u = new URLSearchParams(pageState.url.searchParams);
		for (const [k, v] of Object.entries(changes)) v === null ? u.delete(k) : u.set(k, v);
		return `${base}/services/infoproxy?${u}`;
	}

	const typeLabel: Record<string, string> = { internet: 'Internet', intranet: 'Intranet' };

	// proxy-type chips
	function toggleType(t: string): string {
		const cur = new Set(data.types as string[]);
		cur.has(t) ? cur.delete(t) : cur.add(t);
		const arr = [...cur];
		// both on = default (omit param); none/one = explicit
		return href({ types: arr.length === 2 ? null : arr.join(','), sel: null });
	}

	const collection = $derived(data.collection as Record<string, any> | null);
	const showForm = $derived(canEdit && (data.isNew || !!collection));

	// ---- destinations (rules) grid: staged, replace-all save ----------------
	type RuleRow = { cidr: string; dns: string; port: string; protocol: string };
	let rules = $state<RuleRow[]>([]);
	$effect(() => {
		void data.sel; void data.tab;
		rules = (data.rules as any[]).map((r) => ({
			cidr: r.cidr ?? '', dns: r.dns ?? '',
			port: r.port_from != null ? String(r.port_from) : '', protocol: r.protocol ?? '',
		}));
	});
	function addRule() { rules = [...rules, { cidr: '', dns: '', port: '', protocol: 'CONNECT / HTTPS' }]; }
	function removeRule(i: number) { rules = rules.filter((_, idx) => idx !== i); }
	const rulesJson = $derived(JSON.stringify(rules));

	// ---- scope: models (ScopePicker, replace-all) ---------------------------
	let models = $state<{ key: string; label: string }[]>([]);
	$effect(() => {
		void data.sel; void data.tab;
		models = ((data.scope?.models as { key: string; label: string }[]) ?? []).map((m) => ({ ...m }));
	});
	const modelsJson = $derived(JSON.stringify(models.map((m) => m.key)));

	// ---- scope: individual systems (incremental via API) --------------------
	type Dev = { id: string; serial: string; model: string };
	let sysList = $state<Dev[]>([]);
	let sysQuery = $state('');
	let addQuery = $state('');
	let addResults = $state<Dev[]>([]);
	let sysBusy = $state(false);

	async function loadSystems() {
		if (!data.sel) { sysList = []; return; }
		const u = new URLSearchParams({ collection: data.sel });
		if (sysQuery.trim()) u.set('q', sysQuery.trim());
		const res = await fetch(`${base}/api/administration/proxy-binding?${u}`);
		sysList = res.ok ? (await res.json()).items : [];
	}
	$effect(() => {
		const sel = data.sel, tab = data.tab;          // track only navigation
		untrack(() => {
			if (tab === 'scope' && sel) { sysQuery = ''; addQuery = ''; addResults = []; loadSystems(); }
		});
	});
	async function searchAdd() {
		if (addQuery.trim().length < 2) { addResults = []; return; }
		const res = await fetch(`${base}/api/administration/devices?q=${encodeURIComponent(addQuery.trim())}`);
		const have = new Set(sysList.map((d) => d.id));
		addResults = res.ok ? ((await res.json()).items ?? []).filter((d: Dev) => !have.has(d.id)) : [];
	}
	async function addSystem(d: Dev) {
		if (sysBusy) return; sysBusy = true;
		try {
			await fetch(`${base}/api/administration/proxy-binding`, {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ collection: data.sel, device: d.id }) });
			sysList = [{ id: d.id, serial: d.serial, model: d.model }, ...sysList];
			addResults = addResults.filter((r) => r.id !== d.id); addQuery = '';
		} finally { sysBusy = false; }
	}
	async function removeSystem(id: string) {
		if (sysBusy) return; sysBusy = true;
		try {
			await fetch(`${base}/api/administration/proxy-binding`, {
				method: 'DELETE', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ collection: data.sel, device: id }) });
			sysList = sysList.filter((d) => d.id !== id);
		} finally { sysBusy = false; }
	}

	let confirmDel = $state(false);

	// -- Valkey spool (streamed with live progress) ------------------------------
	// The spool walks the master data tier by tier server-side and emits an SSE
	// progress tick per key, so we can show "Spooling <phase> n/m" in the header
	// instead of blocking on one giant request. See spool/+server.ts.
	let spooling = $state(false);
	let spoolStatus = $state('');
	let spoolPct = $state(0);
	let spoolDone = $state<string | null>(null);

	function startSpool() {
		if (spooling) return;
		spooling = true;
		spoolDone = null;
		spoolPct = 0;
		spoolStatus = 'Starting\u2026';
		const es = new EventSource(`${base}/services/infoproxy/spool`);

		es.addEventListener('progress', (e) => {
			const p = JSON.parse((e as MessageEvent).data);
			if (p.phase === 'count') {
				spoolStatus = 'Counting keys\u2026';
				spoolPct = 0;
			} else if (p.phase === 'prune') {
				spoolStatus = p.total ? `Pruning stale ${p.done}/${p.total}` : 'Pruning stale keys\u2026';
				spoolPct = 100;
			} else {
				spoolStatus = `Spooling ${p.phase} ${p.done}/${p.total}`;
				spoolPct = p.total > 0 ? Math.min(100, (p.done / p.total) * 100) : 0;
			}
		});

		es.addEventListener('done', (e) => {
			const r = JSON.parse((e as MessageEvent).data);
			const parts = Object.entries(r.byType ?? {}).map(([t, n]) => `${n} ${t}`);
			spoolDone = `Spooled ${r.written} allow-lists`
				+ (parts.length ? ` (${parts.join(', ')})` : '')
				+ (r.removed ? `; removed ${r.removed} stale.` : '.');
			spoolStatus = '';
			spooling = false;
			es.close();
		});

		// Fires for our custom `error` event (with data) AND for transport drops
		// (no data) -- the `done` handler closes the stream first, so a stray drop
		// after success never reaches here.
		es.addEventListener('error', (e) => {
			let msg = 'Valkey spool failed';
			try {
				const d = (e as MessageEvent).data;
				if (d) msg = JSON.parse(d).message ?? msg;
			} catch { /* transport error: keep generic message */ }
			spoolStatus = '';
			spoolDone = msg;
			spooling = false;
			es.close();
		});
	}
</script>

<div class="ip">
	{#if form?.error}<p class="msg error">{form.error}</p>{/if}
	{#if form?.notice}<p class="msg info">{form.notice}</p>{/if}
	{#if spoolDone}<p class="msg info">{spoolDone}</p>{/if}

	<div class="topbar">
		<span class="title">Info Proxy destinations</span>
		{#if canEdit}
			<span class="spool-wrap">
				{#if spooling || spoolStatus}
					<div class="spool-bar" class:indet={spoolPct === 0} role="progressbar"
						aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(spoolPct)} aria-live="polite">
						<span class="lbl">{spoolStatus}</span>
						<div class="fill" style:width="{spoolPct}%"><span class="lbl on">{spoolStatus}</span></div>
					</div>
				{/if}
				<button type="button" class="act-primary spool" disabled={spooling} onclick={startSpool}
					title="Write the resolved proxy authorization to Valkey for the Squid helper">{spooling ? 'Spooling\u2026' : 'Save to Valkey'}</button>
			</span>
		{/if}
	</div>

	{#if data.productFilter}
		<p class="filterbar">Showing destinations for model <strong>{data.productFilterName ?? data.productFilter}</strong>
			<a href={href({ product: null, sel: null })}>clear</a></p>
	{/if}

	<SplitPane storageKey="infoproxy" defaultLeft={34}>
		{#snippet left()}
		<aside class="list-pane">
			<form class="searchbar" onsubmit={(e) => e.preventDefault()}>
				<input placeholder="Search collections…" value={data.q} use:searchHotkey
					oninput={(e) => { const v = (e.currentTarget as HTMLInputElement).value;
						clearTimeout((window as any).__ipT); (window as any).__ipT = setTimeout(() => location.assign(href({ q: v || null, sel: null })), 300); }} />
				{#if canEdit}<a class="new-btn" href={href({ new: '1', sel: null })}>+ New</a>{/if}
			</form>
			<div class="chips">
				{#each ['internet', 'intranet'] as t (t)}
					<a class="chip" class:on={(data.types as string[]).includes(t)} href={toggleType(t)}>{typeLabel[t]}</a>
				{/each}
			</div>
			<div class="scroll">
				{#each data.collections as c (c.id)}
					<a class="item" class:active={c.id === data.sel && !data.isNew} href={href({ sel: c.id, new: null })} title={c.name}>
						<span class="item-name">{c.name}</span>
						<span class="item-meta">
							<span class="badge {c.proxy_type}">{typeLabel[c.proxy_type]}</span>
							<span class="chip" title="permitted URLs">{c.rule_count} url</span>
							{#if c.has_any}
								<span class="chip any" title="applies to all systems">ANY</span>
							{:else}
								<span class="cnt" title="product models">{c.n_models} mdl</span>
								<span class="cnt" title="individual systems">{c.n_devices} sys</span>
							{/if}
						</span>
					</a>
				{/each}
				{#if data.collections.length === 0}<p class="empty">No collections.</p>{/if}
			</div>
		</aside>
		{/snippet}

		{#snippet right()}
		<section class="detail">
			{#if !showForm}
				<p class="empty">{collection ? '' : 'Select a collection, or create one.'}</p>
			{:else}
				{#key `${data.sel}-${data.isNew}`}
					<!-- header: name / type / description -->
					<form method="POST" action="?/saveCollection" use:enhance class="head">
						<input type="hidden" name="id" value={collection?.id ?? ''} />
						<input class="cname" type="text" name="name" value={collection?.name ?? ''} required autocomplete="off" placeholder="Collection name" />
						<select name="proxy_type" class="ptype">
							<option value="internet" selected={(collection?.proxy_type ?? 'internet') === 'internet'}>Internet</option>
							<option value="intranet" selected={collection?.proxy_type === 'intranet'}>Intranet</option>
						</select>
						<input class="cdesc" type="text" name="description" value={collection?.description ?? ''} autocomplete="off" placeholder="Description (optional)" />
						<button type="submit" class="mini">{collection ? 'Save' : 'Create'}</button>
						{#if collection}<button type="button" class="mini del" onclick={() => (confirmDel = true)}>Delete</button>{/if}
					</form>

					{#if collection}
						<!-- sub-tabs -->
						<nav class="subtabs">
							<a href={href({ tab: null })} class:active={data.tab === 'dest'}>Destinations</a>
							<a href={href({ tab: 'scope' })} class:active={data.tab === 'scope'}>Applies to</a>
						</nav>

						{#if data.tab === 'dest'}
							<!-- ===== permitted URLs ===== -->
							<form method="POST" action="?/saveRules" use:enhance>
								<input type="hidden" name="id" value={collection.id} />
								<input type="hidden" name="rules" value={rulesJson} />
								<div class="grid">
									<div class="grid-head">
										<span>Target IP / range</span><span>Target DNS name</span><span>Port</span><span>Protocol</span><span></span>
									</div>
									{#each rules as row, i}
										<div class="grid-row">
											<input class="mono" bind:value={row.cidr} placeholder="10.0.0.1" disabled={!canEdit} autocomplete="off" spellcheck="false" />
											<input class="mono" bind:value={row.dns} placeholder="host.example.com" disabled={!canEdit} autocomplete="off" spellcheck="false" />
											<input class="mono port" bind:value={row.port} placeholder="443" disabled={!canEdit} autocomplete="off" />
											<input bind:value={row.protocol} placeholder="CONNECT / HTTPS" disabled={!canEdit} autocomplete="off" />
											<button type="button" class="g-x" onclick={() => removeRule(i)} disabled={!canEdit} aria-label="Remove">✕</button>
										</div>
									{/each}
									{#if rules.length === 0}<p class="empty grid-empty">No destinations yet.</p>{/if}
									{#if canEdit}<button type="button" class="g-add" onclick={addRule}>+ Add destination</button>{/if}
								</div>
								{#if canEdit}
									<div class="actions-bar"><button type="submit" class="act-primary">Save destinations</button></div>
								{/if}
							</form>

						{:else}
							<!-- ===== applies to (scope) ===== -->
							<div class="scope">
								<form method="POST" action="?/toggleAny" use:enhance class="global-row">
									<input type="hidden" name="id" value={collection.id} />
									<input type="hidden" name="on" value={data.scope?.has_any ? '0' : '1'} />
									<label class="chk">
										<input type="checkbox" checked={data.scope?.has_any ?? false} disabled={!canEdit}
											onchange={(e) => { e.preventDefault(); (e.currentTarget as HTMLInputElement).form?.requestSubmit(); }} />
										<span><strong>All systems</strong> (global) — applies to every device</span>
									</label>
								</form>

								<div class="block">
									<h4>Product models <span class="count">{models.length}</span></h4>
									<ScopePicker label="" endpoint="/api/administration/models"
										bind:selected={models} placeholder="Search product models…"
										toItem={(m) => ({ key: m.id, label: m.display ?? m.name })} />
									{#if canEdit}
										<form method="POST" action="?/saveModels" use:enhance class="save-inline">
											<input type="hidden" name="id" value={collection.id} />
											<input type="hidden" name="product_ids" value={modelsJson} />
											<button type="submit" class="act-primary sm">Save models</button>
										</form>
									{/if}
								</div>

								<div class="block">
									<h4>Individual systems <span class="count">{data.scope?.device_count ?? 0}</span></h4>
									{#if canEdit}
										<div class="add-row">
											<input placeholder="+ Add system (serial / IP / FL)…" bind:value={addQuery} oninput={searchAdd} autocomplete="off" spellcheck="false" />
											{#if addResults.length}
												<ul class="results">
													{#each addResults as d (d.id)}
														<li><button type="button" onclick={() => addSystem(d)}><span class="mono">{d.serial || '(no serial)'}</span><span class="rmeta">{d.model}</span></button></li>
													{/each}
												</ul>
											{/if}
										</div>
									{/if}
									<input class="sysfilter" placeholder="Filter systems (model, serial, IP…)" bind:value={sysQuery}
										oninput={() => { clearTimeout((window as any).__sT); (window as any).__sT = setTimeout(loadSystems, 250); }} autocomplete="off" />
									{#if sysList.length}
										<ul class="syslist">
											{#each sysList as d (d.id)}
												<li>
													<a href={`${base}/devices?mode=all&sel=${encodeURIComponent(d.id)}`}><span class="mono">{d.serial || '(no serial)'}</span></a>
													<span class="dmeta">{d.model}</span>
													{#if canEdit}<button type="button" class="rm" onclick={() => removeSystem(d.id)} aria-label="Remove">✕</button>{/if}
												</li>
											{/each}
										</ul>
										{#if (data.scope?.device_count ?? 0) > sysList.length && !sysQuery}
											<p class="muted">Showing {sysList.length} of {data.scope?.device_count}. Use the filter to find a specific system.</p>
										{/if}
									{:else}
										<p class="muted">{sysQuery ? 'No bound systems match.' : 'No individual systems bound.'}</p>
									{/if}
								</div>
							</div>
						{/if}

						<ConfirmDialog bind:open={confirmDel} title="Delete collection?"
							message={`Delete "${collection.name}"? Its destinations and all scope bindings are removed. This cannot be undone.`}>
							<form method="POST" action="?/deleteCollection" use:enhance={() => async ({ update }) => { confirmDel = false; await update(); }}>
								<input type="hidden" name="id" value={collection.id} />
								<button type="submit" class="act-delete">Delete</button>
							</form>
						</ConfirmDialog>
					{/if}
				{/key}
			{/if}
		</section>
		{/snippet}
	</SplitPane>
</div>

<style>
	.ip { display: flex; flex-direction: column; min-height: 0; flex: 1; gap: 0.7rem; }
	.msg { margin: 0; padding: 0.5rem 0.75rem; border-radius: var(--radius); font-size: 0.85rem; }
	.msg.error { background: color-mix(in srgb, var(--danger) 14%, transparent); color: var(--danger); }
	.msg.info { background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); }
	.topbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
	.topbar .title { font-size: 0.9rem; color: var(--text-muted); }
	.spool-wrap { display: flex; align-items: center; gap: 0.6rem; }
	/* Pill-shaped determinate progress bar. Two copies of the label are stacked:
	   the base (readable on the track) and a duplicate inside the accent fill
	   (readable on the fill). Both labels are the FULL bar width and left-anchored,
	   so the fill's overflow:hidden clips its copy exactly at the progress edge. */
	.spool-bar {
		position: relative; width: 18rem; height: 1.7rem; flex: none;
		border-radius: 999px; overflow: hidden;
		background: var(--surface-2); border: 1px solid var(--border);
	}
	.spool-bar .fill {
		position: absolute; top: 0; left: 0; height: 100%; width: 0;
		background: var(--accent); overflow: hidden;
		transition: width 0.18s ease;
	}
	.spool-bar .lbl {
		position: absolute; top: 0; left: 0; width: 18rem; height: 100%;
		display: flex; align-items: center; justify-content: center;
		padding: 0 0.8rem; box-sizing: border-box;
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
		font-size: 0.78rem; font-weight: 600; font-variant-numeric: tabular-nums;
		color: var(--text); pointer-events: none;
	}
	.spool-bar .fill .lbl { color: var(--on-accent); }
	/* Indeterminate (count phase, before a total is known): gentle pulse. */
	.spool-bar.indet { animation: spool-pulse 1.1s ease-in-out infinite; }
	@keyframes spool-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
	.empty { color: var(--text-subtle); font-size: 0.9rem; padding: 1rem 0; }
	.muted { color: var(--text-subtle); font-size: 0.82rem; margin: 0.4rem 0 0; }
	.filterbar { margin: 0; font-size: 0.85rem; color: var(--text-muted); background: color-mix(in srgb, var(--accent) 9%, transparent); padding: 0.4rem 0.7rem; border-radius: var(--radius); }
	.filterbar a { margin-left: 0.5rem; }

	/* left pane */
	.list-pane { display: flex; flex-direction: column; min-height: 0; gap: 0.5rem; }
	.searchbar { display: flex; gap: 0.4rem; }
	.searchbar input { flex: 1; min-width: 0; background: var(--bg-app); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.45rem 0.6rem; font: inherit; font-size: 0.85rem; }
	.new-btn { background: var(--accent); color: var(--on-accent); border: 1px solid var(--accent); border-radius: var(--radius); padding: 0.35rem 0.6rem; font: inherit; font-weight: 600; font-size: 0.8rem; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; }
	.new-btn:hover { background: var(--accent-hover); }
	.chips { display: flex; gap: 0.4rem; }
	.chip { font-size: 0.76rem; padding: 0.2rem 0.6rem; border-radius: 999px; border: 1px solid var(--border); color: var(--text-muted); text-decoration: none; }
	.chip.on { background: color-mix(in srgb, var(--accent) 14%, transparent); border-color: var(--accent); color: var(--text); }
	.scroll { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 0.2rem; padding-right: 2px; }
	.item { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; padding: 0.45rem 0.6rem; border: 1px solid var(--border); border-radius: var(--radius); text-decoration: none; color: var(--text); }
	.item:hover { background: var(--surface-2); }
	.item.active { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
	.item-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.86rem; }
	.item-meta { display: flex; align-items: center; gap: 0.35rem; flex: none; }
	.item-meta .cnt { color: var(--text-subtle); font-size: 0.7rem; white-space: nowrap; }
	.item-meta .chip { font-size: 0.66rem; color: var(--text-muted); border: 1px solid var(--border); border-radius: 999px; padding: 0.05rem 0.4rem; white-space: nowrap; }
	.item-meta .chip.any { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
	.badge { font-size: 0.58rem; text-transform: uppercase; letter-spacing: 0.03em; padding: 0.05rem 0.3rem; border-radius: 999px; white-space: nowrap; }
	.badge.internet { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
	.badge.intranet { background: color-mix(in srgb, var(--text-subtle) 22%, transparent); color: var(--text-muted); }

	/* right pane */
	.detail { min-height: 0; display: flex; flex-direction: column; }
	.head { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.8rem; }
	.cname { font-size: 1rem; font-weight: 600; background: transparent; color: var(--text); border: none; border-bottom: 1px solid var(--border); padding: 0.2rem 0; outline: none; min-width: 12rem; }
	.cname:focus { border-bottom-color: var(--accent); }
	.ptype { background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.3rem 0.4rem; font: inherit; font-size: 0.82rem; }
	.cdesc { flex: 1; min-width: 10rem; background: transparent; color: var(--text-muted); border: none; border-bottom: 1px solid var(--border); padding: 0.2rem 0; font: inherit; font-size: 0.85rem; outline: none; }
	.cdesc:focus { border-bottom-color: var(--accent); }
	.mini { background: var(--surface-2); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.3rem 0.7rem; font: inherit; font-size: 0.8rem; cursor: pointer; }
	.mini.del { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }

	.subtabs { display: flex; gap: 1.2rem; border-bottom: 1px solid var(--border); margin-bottom: 1rem; }
	.subtabs a { padding: 0.5rem 0.1rem; color: var(--text-muted); text-decoration: none; font-size: 0.88rem; border-bottom: 2px solid transparent; margin-bottom: -1px; }
	.subtabs a:hover { color: var(--text); }
	.subtabs a.active { color: var(--text); border-bottom-color: var(--accent); }

	/* rules grid */
	.grid { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
	.grid-head, .grid-row { display: grid; grid-template-columns: 1.2fr 1.6fr 70px 1.1fr 30px; align-items: stretch; }
	.grid-head { background: var(--surface-2); font-size: 0.66rem; font-weight: 600; color: var(--text-subtle); text-transform: uppercase; letter-spacing: 0.04em; }
	.grid-head > span { padding: 6px 8px; border-right: 1px solid var(--border); }
	.grid-row { border-top: 1px solid var(--border); }
	.grid-row input { background: transparent; color: var(--text); border: none; border-right: 1px solid var(--border); padding: 7px 8px; font: inherit; font-size: 0.83rem; outline: none; width: 100%; min-width: 0; }
	.grid-row input:focus { background: var(--bg-app); box-shadow: inset 0 0 0 2px var(--focus); }
	.grid-row .mono { font-family: monospace; }
	.g-x { background: transparent; color: var(--text-subtle); border: none; cursor: pointer; font-size: 0.8rem; }
	.g-x:hover:not(:disabled) { color: var(--danger); }
	.g-add { display: block; width: 100%; background: transparent; color: var(--accent); border: none; border-top: 1px solid var(--border); padding: 8px 12px; font-size: 0.83rem; cursor: pointer; text-align: left; }
	.g-add:hover { background: var(--surface-2); }
	.grid-empty { padding: 0.8rem 12px; margin: 0; }

	.actions-bar { display: flex; justify-content: flex-end; margin-top: 1rem; }
	.act-primary { background: var(--accent); color: var(--on-accent); border: none; border-radius: var(--radius); padding: 0.45rem 0.9rem; font: inherit; font-weight: 600; font-size: 0.85rem; cursor: pointer; }
	.act-primary:hover { background: var(--accent-hover); }
	.act-primary.sm { padding: 0.35rem 0.7rem; font-size: 0.8rem; }
	.act-delete { background: var(--danger); color: #fff; border: none; border-radius: var(--radius); padding: 0.45rem 0.9rem; font: inherit; font-weight: 600; font-size: 0.85rem; cursor: pointer; }

	/* scope */
	.scope { display: flex; flex-direction: column; gap: 1.3rem; }
	.global-row { margin: 0; }
	.chk { display: flex; align-items: center; gap: 0.5rem; font-size: 0.88rem; color: var(--text); }
	.block h4 { margin: 0 0 0.5rem; font-size: 0.92rem; display: flex; align-items: baseline; gap: 0.4rem; }
	.count { color: var(--text-subtle); font-weight: 400; font-size: 0.8rem; }
	.save-inline { margin-top: 0.5rem; }
	.add-row { position: relative; margin-bottom: 0.5rem; }
	.add-row input, .sysfilter { width: 100%; background: var(--bg-app); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.4rem 0.55rem; font: inherit; font-size: 0.84rem; }
	.add-row input:focus-visible, .sysfilter:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	.sysfilter { margin-bottom: 0.4rem; }
	.results { position: absolute; z-index: 5; left: 0; right: 0; top: 100%; margin: 0.15rem 0 0; padding: 0.2rem; list-style: none; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow, 0 4px 14px rgba(0,0,0,0.25)); max-height: 260px; overflow-y: auto; }
	.results li button { display: flex; align-items: baseline; gap: 0.5rem; width: 100%; text-align: left; background: none; border: none; color: var(--text); font: inherit; font-size: 0.83rem; padding: 0.35rem 0.5rem; border-radius: var(--radius); cursor: pointer; }
	.results li button:hover { background: var(--surface-2); }
	.rmeta { color: var(--text-subtle); font-size: 0.74rem; margin-left: auto; }
	.syslist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.2rem; }
	.syslist li { display: flex; align-items: center; gap: 0.6rem; padding: 0.35rem 0.5rem; border: 1px solid var(--border); border-radius: var(--radius); }
	.syslist li a { color: var(--text); text-decoration: none; font-size: 0.84rem; }
	.syslist li a:hover { color: var(--accent); }
	.syslist .dmeta { color: var(--text-subtle); font-size: 0.74rem; margin-left: auto; }
	.syslist .rm { flex: none; background: none; border: none; color: var(--text-subtle); cursor: pointer; font-size: 0.85rem; }
	.syslist .rm:hover { color: var(--danger); }
	.mono { font-family: monospace; }
</style>
