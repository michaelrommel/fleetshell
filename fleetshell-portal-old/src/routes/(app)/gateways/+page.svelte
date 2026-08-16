<script lang="ts">
	// ── Types (mirror $lib/server/gateways) ─────────────────────────────────────
	interface GatewaySummary {
		ip:           string;
		customer_id:  string;
		static_ip:    boolean;
		ike_version:  number;
		device_count: number;
	}
	interface DeviceEntry {
		internal_ip: string;
		global_ip:   string;
		system:      Record<string, string> | null;
	}
	interface BackendNat {
		access_server?: string;
		sd_server?:     string;
		em_server?:     string;
	}
	interface SiteRecord {
		customer_id:     string;
		ike_identity:    string;
		static_ip:       boolean;
		dyndns_password: string;
		ike_version:  number;
		ike_enc:      string[];
		ike_auth:     string[];
		ike_dh:       number[];
		esp_enc:      string[];
		esp_auth:     string[];
		esp_pfs:      number[];
		remote_ts:    string[];
	}
	interface GatewayDetail {
		ip:          string;
		exists:      boolean;
		site:        SiteRecord;
		psk:         string;
		devices:     DeviceEntry[];
		backend_nat: BackendNat | null;
	}

	// ── Option catalogues ───────────────────────────────────────────────────────
	const IKE_ENC   = ['aes128', 'aes192', 'aes256'];
	const IKE_AUTH  = ['sha256', 'sha384', 'sha512'];
	const DH_GROUPS = [1, 2, 5, 14, 15, 16, 19, 20, 21, 24];
	const ESP_ENC   = ['aes128', 'aes192', 'aes256', 'aes128gcm', 'aes192gcm', 'aes256gcm', 'none'];
	const ESP_AUTH  = ['sha256', 'sha384', 'sha512', 'none'];

	// ── State ───────────────────────────────────────────────────────────────────
	type Mode = 'list' | 'view' | 'edit';
	let mode        = $state<Mode>('list');

	let query       = $state('');
	let searching   = $state(false);
	let gateways    = $state<GatewaySummary[]>([]);
	let searchError = $state('');
	let searched    = $state(false);

	let detail      = $state<GatewayDetail | null>(null);
	let loading     = $state(false);
	let loadError   = $state('');

	let saving      = $state(false);
	let saveError   = $state('');
	let isCreate    = $state(false);
	let showPsk     = $state(false);

	// Editable form (flat; remote_ts as newline text).
	interface Form {
		ip:             string;
		customer_id:    string;
		ike_identity:   string;
		static_ip:      boolean;
		dyndns_password: string;
		ike_version:    number;
		ike_enc:        string[];
		ike_auth:       string[];
		ike_dh:         number[];
		esp_enc:        string[];
		esp_auth:       string[];
		esp_pfs:        number[];
		remote_ts_text: string;
		psk:            string;
	}
	let form = $state<Form>(blankForm());

	function blankForm(): Form {
		return {
			ip: '', customer_id: '', ike_identity: '',
			static_ip: true, dyndns_password: '', ike_version: 2,
			ike_enc: ['aes256'], ike_auth: ['sha256'], ike_dh: [14],
			esp_enc: ['aes256gcm'], esp_auth: ['none'], esp_pfs: [14],
			remote_ts_text: '', psk: '',
		};
	}

	// ── Search ──────────────────────────────────────────────────────────────────
	async function search(): Promise<void> {
		searching   = true;
		searchError = '';
		searched    = true;
		try {
			const res  = await fetch(`/api/gateways?q=${encodeURIComponent(query.trim())}`);
			if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
			const body = await res.json();
			gateways   = body.gateways ?? [];
			if (gateways.length === 0) searchError = 'No gateways found.';
		} catch (e) {
			searchError = String(e);
		} finally {
			searching = false;
		}
	}

	// ── Load detail (view) ──────────────────────────────────────────────────────
	async function view(ip: string): Promise<void> {
		loading   = true;
		loadError = '';
		showPsk   = false;
		try {
			const res  = await fetch(`/api/gateways/${encodeURIComponent(ip)}`);
			if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
			const body = await res.json();
			detail     = body.gateway as GatewayDetail;
			mode       = 'view';
		} catch (e) {
			loadError = String(e);
		} finally {
			loading = false;
		}
	}

	// ── Enter edit / create ─────────────────────────────────────────────────────
	function startEdit(): void {
		if (!detail) return;
		const s  = detail.site;
		form = {
			ip:             detail.ip,
			customer_id:    s.customer_id,
			ike_identity:   s.ike_identity,
			static_ip:      s.static_ip,
			dyndns_password: s.dyndns_password,
			ike_version:    s.ike_version,
			ike_enc:        [...s.ike_enc],
			ike_auth:       [...s.ike_auth],
			ike_dh:         [...s.ike_dh],
			esp_enc:        [...s.esp_enc],
			esp_auth:       [...s.esp_auth],
			esp_pfs:        [...s.esp_pfs],
			remote_ts_text: s.remote_ts.join('\n'),
			psk:            detail.psk,
		};
		isCreate  = false;
		saveError = '';
		showPsk   = false;
		mode      = 'edit';
	}

	function startCreate(): void {
		form      = blankForm();
		isCreate  = true;
		saveError = '';
		showPsk   = true;
		detail    = null;
		mode      = 'edit';
	}

	// ── Toggle helpers for multi-select chip groups ─────────────────────────────
	function toggleStr(arr: string[], v: string): string[] {
		return arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v];
	}
	function toggleNum(arr: number[], v: number): number[] {
		return arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v];
	}

	// ── Save ────────────────────────────────────────────────────────────────────
	async function save(): Promise<void> {
		saveError = '';
		const ip = form.ip.trim();
		if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) { saveError = 'Enter a valid IPv4 gateway address.'; return; }
		if (!form.customer_id.trim())            { saveError = 'Customer ID is required.';            return; }
		if (isCreate && !form.psk.trim())        { saveError = 'A PSK is required to create a gateway.'; return; }

		const remote_ts = form.remote_ts_text
			.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

		const site = {
			customer_id:  form.customer_id.trim(),
			ike_identity: form.ike_identity.trim(),
			static_ip:    form.static_ip,
			dyndns_password: form.dyndns_password,
			ike_version:  form.ike_version,
			ike_enc:      form.ike_enc,
			ike_auth:     form.ike_auth,
			ike_dh:       form.ike_dh,
			esp_enc:      form.esp_enc,
			esp_auth:     form.esp_auth,
			esp_pfs:      form.esp_pfs,
			remote_ts,
		};

		saving = true;
		try {
			const res = await fetch(`/api/gateways/${encodeURIComponent(ip)}`, {
				method:  'PUT',
				headers: { 'Content-Type': 'application/json' },
				body:    JSON.stringify({ site, psk: form.psk, create: isCreate }),
			});
			if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
			await view(ip);      // reload fresh detail into view mode
			await search();      // refresh list in the background
		} catch (e) {
			saveError = String(e);
		} finally {
			saving = false;
		}
	}

	function backToList(): void { mode = 'list'; detail = null; }

	// ── Display helpers ───────────────────────────────────────────────────────────
	function joinOrDash(arr: (string | number)[]): string {
		return arr.length ? arr.join(', ') : '—';
	}
	function maskPsk(psk: string): string {
		return psk ? '•'.repeat(Math.min(psk.length, 16)) : '(none)';
	}
	const SYS_FIELDS = ['serial', 'product', 'partno', 'modality', 'country', 'contracts', 'dtm'];
</script>

<svelte:head><title>Gateways — FleetShell</title></svelte:head>

<div class="page">
	<div class="page-head">
		<h1 class="page-title">Gateways</h1>
		{#if mode === 'list'}
			<button class="btn-primary" onclick={startCreate}>+ New gateway</button>
		{/if}
	</div>

	<!-- ══ LIST ══════════════════════════════════════════════════════════════ -->
	{#if mode === 'list'}
		<section class="card">
			<h2 class="card-title">Search</h2>
			<form class="search-row" onsubmit={(e) => { e.preventDefault(); search(); }}>
				<input
					class="search-input"
					type="text"
					placeholder="ip:62.238.110.152   id:helena2   (space = AND, | = OR, blank = all)"
					bind:value={query}
					disabled={searching}
				/>
				<button class="btn-primary" type="submit" disabled={searching}>
					{searching ? 'Searching…' : 'Search'}
				</button>
			</form>
			<p class="hint">
				Fields: <code>ip:</code> public IP, <code>id:</code> customer ID.
				Combine with spaces (AND) or <code>|</code> (OR). Leave blank to list all.
			</p>
		</section>

		{#if loadError}<p class="notice notice--warn">{loadError}</p>{/if}
		{#if searchError}<p class="notice notice--warn">{searchError}</p>{/if}

		{#if gateways.length > 0}
		<section class="card">
			<h2 class="card-title">Results — {gateways.length} gateway{gateways.length !== 1 ? 's' : ''}</h2>
			<table class="gw-table">
				<thead>
					<tr>
						<th>Customer ID</th><th>Public IP</th><th>IP type</th>
						<th>IKE</th><th>Devices</th><th></th>
					</tr>
				</thead>
				<tbody>
					{#each gateways as gw}
					<tr>
						<td class="id-cell">{gw.customer_id || '—'}</td>
						<td class="ip-cell">{gw.ip}</td>
						<td>{gw.static_ip ? 'Static' : 'Dynamic'}</td>
						<td>IKEv{gw.ike_version}</td>
						<td>{gw.device_count}</td>
						<td>
							<button class="btn-detail" onclick={() => view(gw.ip)} disabled={loading}>
								View
							</button>
						</td>
					</tr>
					{/each}
				</tbody>
			</table>
		</section>
		{/if}
	{/if}

	<!-- ══ VIEW ══════════════════════════════════════════════════════════════ -->
	{#if mode === 'view' && detail}
		<section class="card">
			<h2 class="card-title">
				{detail.site.customer_id || detail.ip}
				<span class="sub">{detail.ip}</span>
				<button class="btn-back" onclick={backToList}>✕</button>
			</h2>

			<div class="view-actions">
				<button class="btn-primary" onclick={startEdit}>Edit</button>
			</div>

			<dl class="kv">
				<dt>Customer ID</dt><dd>{detail.site.customer_id || '—'}</dd>
				<dt>Public IP</dt><dd class="mono">{detail.ip}</dd>
				<dt>IKE identity</dt><dd class="mono">{detail.site.ike_identity || '—'}</dd>
				<dt>IP type</dt><dd>{detail.site.static_ip ? 'Static IP' : 'Dynamic IP'}</dd>
				{#if !detail.site.static_ip}
					<dt>DynDNS password</dt>
					<dd class="mono">
						{showPsk ? (detail.site.dyndns_password || '(none)') : maskPsk(detail.site.dyndns_password)}
					</dd>
				{/if}
				<dt>IKE version</dt><dd>IKEv{detail.site.ike_version}</dd>
				<dt>Shared secret</dt>
				<dd class="mono">
					{showPsk ? (detail.psk || '(none)') : maskPsk(detail.psk)}
					<button class="btn-mini" onclick={() => showPsk = !showPsk}>
						{showPsk ? 'hide' : 'reveal'}
					</button>
				</dd>
			</dl>

			<h3 class="sub-title">IKE Phase 1</h3>
			<dl class="kv">
				<dt>Encryption</dt><dd>{joinOrDash(detail.site.ike_enc)}</dd>
				<dt>Authentication</dt><dd>{joinOrDash(detail.site.ike_auth)}</dd>
				<dt>DH group</dt><dd>{joinOrDash(detail.site.ike_dh)}</dd>
			</dl>

			<h3 class="sub-title">IKE Phase 2 (ESP)</h3>
			<dl class="kv">
				<dt>Encryption</dt><dd>{joinOrDash(detail.site.esp_enc)}</dd>
				<dt>Authentication</dt><dd>{joinOrDash(detail.site.esp_auth)}</dd>
				<dt>PFS (DH group)</dt><dd>{detail.site.esp_pfs.length ? detail.site.esp_pfs.join(', ') : 'None'}</dd>
			</dl>

			<h3 class="sub-title">Tunnel rules (remote traffic selectors)</h3>
			{#if detail.site.remote_ts.length}
				<ul class="ts-list">
					{#each detail.site.remote_ts as cidr}<li class="mono">{cidr}</li>{/each}
				</ul>
			{:else}
				<p class="notice">Catch-all (0.0.0.0/0)</p>
			{/if}
		</section>

		<!-- Read-only devices / NAT -->
		<section class="card">
			<h2 class="card-title">Devices behind this gateway <span class="sub">read-only</span></h2>
			{#if detail.devices.length === 0}
				<p class="notice">No device NAT entries.</p>
			{:else}
				<table class="dev-table">
					<thead>
						<tr>
							<th>Internal IP</th><th>Global IP</th>
							{#each SYS_FIELDS as f}<th>{f}</th>{/each}
						</tr>
					</thead>
					<tbody>
						{#each detail.devices as d}
						<tr>
							<td class="mono">{d.internal_ip || '—'}</td>
							<td class="mono">{d.global_ip || '—'}</td>
							{#each SYS_FIELDS as f}<td>{d.system?.[f] ?? '—'}</td>{/each}
						</tr>
						{/each}
					</tbody>
				</table>
			{/if}

			{#if detail.backend_nat}
				<h3 class="sub-title">Backend NAT</h3>
				<dl class="kv">
					<dt>Access server</dt><dd class="mono">{detail.backend_nat.access_server ?? '—'}</dd>
					<dt>SD server</dt><dd class="mono">{detail.backend_nat.sd_server ?? '—'}</dd>
					<dt>EM server</dt><dd class="mono">{detail.backend_nat.em_server ?? '—'}</dd>
				</dl>
			{/if}
		</section>
	{/if}

	<!-- ══ EDIT / CREATE ═════════════════════════════════════════════════════ -->
	{#if mode === 'edit'}
		<section class="card">
			<h2 class="card-title">
				{isCreate ? 'New gateway' : `Edit — ${form.customer_id || form.ip}`}
				<button class="btn-back" onclick={() => (isCreate ? backToList() : view(form.ip))}>✕</button>
			</h2>

			<div class="form-grid">
				<label class="field">
					<span>Public IP {#if isCreate}<em class="req">*</em>{/if}</span>
					<input class="inp mono" type="text" bind:value={form.ip} disabled={!isCreate}
					       placeholder="62.238.110.152" />
				</label>
				<label class="field">
					<span>Customer ID <em class="req">*</em></span>
					<input class="inp" type="text" bind:value={form.customer_id} placeholder="acme-corp" />
				</label>
				<label class="field">
					<span>IKE identity <span class="opt">(optional)</span></span>
					<input class="inp mono" type="text" bind:value={form.ike_identity} placeholder="10.5.0.1" />
				</label>
				<label class="field">
					<span>Shared secret (PSK) {#if isCreate}<em class="req">*</em>{/if}</span>
					<span class="psk-row">
						{#if showPsk}
							<input class="inp mono" type="text" bind:value={form.psk} />
						{:else}
							<input class="inp mono" type="password" bind:value={form.psk} />
						{/if}
						<button type="button" class="btn-mini" onclick={() => showPsk = !showPsk}>
							{showPsk ? 'hide' : 'show'}
						</button>
					</span>
				</label>
			</div>

			<div class="form-grid">
				<div class="field">
					<span>IP type</span>
					<div class="radio-row">
						<label><input type="radio" value={true}  bind:group={form.static_ip} /> Static IP</label>
						<label><input type="radio" value={false} bind:group={form.static_ip} /> Dynamic IP</label>
					</div>
				</div>
				{#if !form.static_ip}
					<label class="field">
						<span>DynDNS password</span>
						<span class="psk-row">
							{#if showPsk}
								<input class="inp mono" type="text" bind:value={form.dyndns_password} />
							{:else}
								<input class="inp mono" type="password" bind:value={form.dyndns_password} />
							{/if}
							<button type="button" class="btn-mini" onclick={() => showPsk = !showPsk}>
								{showPsk ? 'hide' : 'show'}
							</button>
						</span>
					</label>
				{/if}
				<div class="field">
					<span>IKE version</span>
					<div class="radio-row">
						<label><input type="radio" value={1} bind:group={form.ike_version} /> IKEv1</label>
						<label><input type="radio" value={2} bind:group={form.ike_version} /> IKEv2</label>
					</div>
				</div>
			</div>

			<h3 class="sub-title">IKE Phase 1</h3>
			<div class="chip-field">
				<span class="chip-label">Encryption</span>
				<div class="chips">
					{#each IKE_ENC as v}
						<button type="button" class="chip" class:on={form.ike_enc.includes(v)}
						        onclick={() => form.ike_enc = toggleStr(form.ike_enc, v)}>{v}</button>
					{/each}
				</div>
			</div>
			<div class="chip-field">
				<span class="chip-label">Authentication</span>
				<div class="chips">
					{#each IKE_AUTH as v}
						<button type="button" class="chip" class:on={form.ike_auth.includes(v)}
						        onclick={() => form.ike_auth = toggleStr(form.ike_auth, v)}>{v}</button>
					{/each}
				</div>
			</div>
			<div class="chip-field">
				<span class="chip-label">DH group</span>
				<div class="chips">
					{#each DH_GROUPS as v}
						<button type="button" class="chip" class:on={form.ike_dh.includes(v)}
						        onclick={() => form.ike_dh = toggleNum(form.ike_dh, v)}>{v}</button>
					{/each}
				</div>
			</div>

			<h3 class="sub-title">IKE Phase 2 (ESP)</h3>
			<div class="chip-field">
				<span class="chip-label">Encryption</span>
				<div class="chips">
					{#each ESP_ENC as v}
						<button type="button" class="chip" class:on={form.esp_enc.includes(v)}
						        onclick={() => form.esp_enc = toggleStr(form.esp_enc, v)}>{v}</button>
					{/each}
				</div>
			</div>
			<div class="chip-field">
				<span class="chip-label">Authentication</span>
				<div class="chips">
					{#each ESP_AUTH as v}
						<button type="button" class="chip" class:on={form.esp_auth.includes(v)}
						        onclick={() => form.esp_auth = toggleStr(form.esp_auth, v)}>{v}</button>
					{/each}
				</div>
			</div>
			<div class="chip-field">
				<span class="chip-label">PFS (DH group)</span>
				<div class="chips">
					{#each DH_GROUPS as v}
						<button type="button" class="chip" class:on={form.esp_pfs.includes(v)}
						        onclick={() => form.esp_pfs = toggleNum(form.esp_pfs, v)}>{v}</button>
					{/each}
				</div>
				<span class="hint">No chips selected = no PFS.</span>
			</div>

			<h3 class="sub-title">Tunnel rules (remote traffic selectors)</h3>
			<textarea class="inp ts-area mono" rows="5" bind:value={form.remote_ts_text}
			          placeholder={"10.67.0.0/16\n141.67.0.0/16\n10.14.3.5/32"}></textarea>
			<span class="hint">One CIDR per line. Empty = catch-all (0.0.0.0/0).</span>

			{#if saveError}<p class="notice notice--warn">{saveError}</p>{/if}

			<div class="form-actions">
				<button class="btn-action" onclick={() => (isCreate ? backToList() : view(form.ip))} disabled={saving}>
					Cancel
				</button>
				<button class="btn-action btn-action--primary" onclick={save} disabled={saving}>
					{saving ? 'Saving…' : 'Save'}
				</button>
			</div>
		</section>
	{/if}
</div>

<style>
	.page       { padding: 24px 28px; max-width: 1100px; }
	.page-head  { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
	.page-title {
		font-size: 1.1rem; font-weight: 700; color: var(--fg2);
		text-transform: uppercase; letter-spacing: 0.1em; margin: 0;
	}

	.card {
		background: var(--bg1, #3c3836); border: 1px solid var(--bg3, #504945);
		border-radius: 6px; padding: 18px 20px; margin-bottom: 18px;
	}
	.card-title {
		font-size: 0.8rem; font-weight: 700; letter-spacing: 0.08em;
		text-transform: uppercase; color: var(--fg4, #a89984);
		margin: 0 0 14px; display: flex; align-items: center; gap: 10px;
	}
	.card-title .sub { font-size: 0.7rem; color: var(--fg4); text-transform: none; letter-spacing: 0; }
	.sub-title {
		font-size: 0.75rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
		color: var(--fg3, #bdae93); margin: 18px 0 8px;
	}

	/* Search */
	.search-row   { display: flex; gap: 10px; align-items: center; }
	.search-input {
		flex: 1; min-width: 0; padding: 8px 12px; background: var(--bg, #1d2021);
		border: 1px solid var(--bg3, #504945); border-radius: 4px;
		color: var(--fg, #ebdbb2); font-size: 0.9rem;
	}
	.search-row :global(input), .search-row :global(button) { width: auto; }
	.hint  { font-size: 0.75rem; color: var(--fg4, #a89984); margin: 8px 0 0; }
	.hint code { background: var(--bg, #1d2021); padding: 1px 5px; border-radius: 3px; }

	/* Buttons */
	.btn-primary {
		flex-shrink: 0; width: auto; padding: 8px 20px; background: var(--bright-blue, #83a598);
		color: #1d2021; border: none; border-radius: 4px; font-weight: 700;
		font-size: 0.9rem; cursor: pointer; white-space: nowrap;
	}
	.btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
	.btn-detail {
		width: auto; padding: 6px 16px; background: var(--bg2, #504945); color: var(--fg, #ebdbb2);
		border: 1px solid var(--bg3, #665c54); border-radius: 4px; font-size: 0.8rem;
		cursor: pointer; white-space: nowrap;
	}
	.btn-detail:hover { background: var(--bg3, #665c54); }
	.btn-detail:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-back {
		margin-left: auto; background: none; border: none; color: var(--fg4, #a89984);
		cursor: pointer; font-size: 0.9rem; padding: 0;
	}
	.btn-back:hover { color: var(--fg, #ebdbb2); }
	.btn-mini {
		background: var(--bg2, #504945); color: var(--fg3, #bdae93); border: 1px solid var(--bg3, #665c54);
		border-radius: 3px; font-size: 0.7rem; padding: 2px 7px; cursor: pointer; width: auto;
	}
	.btn-mini:hover { color: var(--fg, #ebdbb2); }

	/* Tables */
	.gw-table, .dev-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
	.gw-table th, .dev-table th {
		text-align: left; color: var(--fg4, #a89984); font-weight: 600; padding: 6px 10px;
		border-bottom: 1px solid var(--bg3, #504945); font-size: 0.72rem;
		letter-spacing: 0.05em; text-transform: uppercase;
	}
	.gw-table td, .dev-table td { padding: 8px 10px; border-bottom: 1px solid var(--bg2, #3c3836); }
	.ip-cell, .id-cell { font-family: monospace; }
	.ip-cell  { color: var(--bright-aqua, #8ec07c); }
	.id-cell  { color: var(--fg1, #ebdbb2); font-weight: 600; }
	.mono     { font-family: monospace; }

	/* Key/value description lists */
	.kv { display: grid; grid-template-columns: 180px 1fr; gap: 4px 16px; margin: 6px 0; font-size: 0.85rem; }
	.kv dt { color: var(--fg4, #a89984); }
	.kv dd { margin: 0; color: var(--fg1, #ebdbb2); }
	.view-actions { margin-bottom: 14px; }
	.ts-list { margin: 4px 0; padding-left: 18px; font-size: 0.85rem; color: var(--fg1); }

	/* Form */
	.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 18px; margin-bottom: 8px; }
	.field { display: flex; flex-direction: column; gap: 5px; }
	.field > span { font-size: 0.78rem; color: var(--fg4, #a89984); }
	.req { color: var(--bright-orange, #fe8019); font-style: normal; }
	.opt { color: var(--fg4); font-size: 0.72rem; }
	.inp {
		width: 100%; padding: 7px 10px; background: var(--bg, #1d2021);
		border: 1px solid var(--bg3, #504945); border-radius: 4px;
		color: var(--fg, #ebdbb2); font-size: 0.85rem;
	}
	.inp:disabled { opacity: 0.55; }
	.psk-row { display: flex; gap: 8px; align-items: center; }
	.psk-row .inp { flex: 1; }
	.radio-row { display: flex; gap: 18px; font-size: 0.85rem; color: var(--fg1); }
	.radio-row label { display: flex; align-items: center; gap: 6px; }
	.radio-row input { width: auto; }

	.chip-field { display: flex; align-items: center; gap: 12px; margin: 8px 0; flex-wrap: wrap; }
	.chip-label { font-size: 0.78rem; color: var(--fg4, #a89984); width: 140px; flex-shrink: 0; }
	.chips { display: flex; flex-wrap: wrap; gap: 6px; }
	.chip {
		padding: 4px 12px; background: var(--bg, #1d2021); color: var(--fg3, #bdae93);
		border: 1px solid var(--bg3, #504945); border-radius: 14px; font-size: 0.78rem;
		cursor: pointer; width: auto; font-family: monospace;
	}
	.chip:hover { border-color: var(--fg4, #a89984); }
	.chip.on {
		background: color-mix(in srgb, var(--bright-aqua, #8ec07c) 22%, var(--bg, #1d2021));
		border-color: var(--bright-aqua, #8ec07c); color: var(--bright-aqua, #8ec07c); font-weight: 700;
	}
	.ts-area { resize: vertical; font-size: 0.85rem; }
	.form-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
	.btn-action {
		width: auto; min-width: 96px; padding: 8px 20px; border-radius: 4px;
		font-size: 0.85rem; font-weight: 700; cursor: pointer; white-space: nowrap;
		background: var(--bg2, #504945); color: var(--fg, #ebdbb2);
		border: 1px solid var(--bg3, #665c54);
	}
	.btn-action:hover:not(:disabled) { background: var(--bg3, #665c54); }
	.btn-action--primary {
		background: var(--bright-blue, #83a598); color: #1d2021; border: none;
	}
	.btn-action--primary:hover:not(:disabled) { filter: brightness(1.05); }
	.btn-action:disabled { opacity: 0.4; cursor: not-allowed; }

	.notice       { font-size: 0.85rem; color: var(--fg4, #a89984); margin: 8px 0; }
	.notice--warn { color: var(--bright-orange, #fe8019); }
</style>
