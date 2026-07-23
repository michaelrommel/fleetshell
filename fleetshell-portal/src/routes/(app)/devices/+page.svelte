<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	/** Sorted key/value pairs from the Redis hash. */
	const entries = $derived(
		data.result
			? Object.entries(data.result).sort(([a], [b]) => a.localeCompare(b))
			: [],
	);

	// ── Connect form state ────────────────────────────────────────────
	let target     = $state('172.16.33.');
	let gateway    = $state('gateway.fleetshell.com');
	let servicekey = $state('i-love-healthineers-so-much');
	let username   = $state('');
	let password   = $state('');

	interface PortRow {
		ports:       string;
		application: 'http' | 'https' | 'rdp' | 'vnc';
		guac:        boolean;
		e2ecrypt:    boolean;
		sni:         string;
	}

	let portRows = $state<PortRow[]>([
		{ ports: '443', application: 'https', guac: false, e2ecrypt: false, sni: '' },
	]);

	function addRow(): void {
		portRows = [...portRows, { ports: '', application: 'https', guac: false, e2ecrypt: false, sni: '' }];
	}

	function removeRow(i: number): void {
		if (portRows.length > 1) portRows = portRows.filter((_, idx) => idx !== i);
	}

	/** True when the SNI field is meaningful for a given row. */
	function sniEffective(row: PortRow): boolean {
		return (row.application === 'http' || row.application === 'https') && !row.e2ecrypt;
	}

	type ConnectState = 'idle' | 'signing' | 'connecting' | 'done' | 'error';
	let connectState = $state<ConnectState>('idle');
	let connectMsg   = $state('');
	let connectUrls  = $state<string[]>([]);

	const busy = $derived(connectState === 'signing' || connectState === 'connecting');

	async function onConnect(e: Event) {
		e.preventDefault();
		connectState = 'signing';
		connectMsg   = '';
		connectUrls  = [];

		// Collect all ports across rows for the JWT claim.
		const allPorts = portRows.map(r => r.ports).filter(Boolean).join(',');

		// 1. Sign the JWT server-side (JWT_SECRET never leaves the portal).
		let token: string;
		try {
			const res = await fetch('/api/tunnel/sign', {
				method  : 'POST',
				headers : { 'Content-Type': 'application/json' },
				body    : JSON.stringify({ target, ports: allPorts, gateway }),
			});
			if (!res.ok) {
				const txt = await res.text();
				throw new Error(`Sign failed (${res.status}): ${txt}`);
			}
			({ token } = await res.json());
		} catch (err) {
			connectState = 'error';
			connectMsg   = String(err);
			return;
		}

		// 2. Forward the full tunnel request to the local FleetShell client.
		connectState = 'connecting';
		try {
			const res = await fetch('https://127-0-0-1.client.fleetshell.com:8080/api/tunnel', {
				method  : 'POST',
				headers : { 'Content-Type': 'application/json' },
				body    : JSON.stringify({
					target,
					token,
					gateway,
					servicekey : servicekey || undefined,
					username   : username   || undefined,
					password   : password   || undefined,
					port_rows  : portRows.map(r => ({
						ports      : r.ports,
						application: r.application,
						guac       : r.guac       || undefined,
						e2ecrypt   : r.e2ecrypt   || undefined,
						sni        : r.sni        || undefined,
					})),
				}),
			});
			if (!res.ok) {
				const txt = await res.text();
				throw new Error(`Client returned ${res.status}: ${txt}`);
			}
			const body = await res.json();
			connectUrls  = Array.isArray(body.urls) ? body.urls : [];
			connectMsg   = `Connected on port(s): ${(body.ports ?? []).join(', ')}`;
			connectState = 'done';
		} catch (err) {
			connectState = 'error';
			connectMsg   = String(err);
		}
	}

	function resetConnect() {
		connectState = 'idle';
		connectMsg   = '';
		connectUrls  = [];
	}
</script>

<svelte:head><title>Devices — FleetShell Portal</title></svelte:head>

<div class="page">

	<!-- ── Search ─────────────────────────────────────────────────────────── -->
	<section class="search-section">
		<h1 class="page-title">Devices</h1>

		<form method="GET" class="search-form">
			<input
				class="search-input"
				name="ip"
				type="text"
				placeholder="Enter search criterium…"
				value={data.ip ?? ''}
				autocomplete="off"
				spellcheck="false"
				aria-label="IP address"
			/>
			<button type="submit" class="search-btn">Search</button>
		</form>
	</section>

	<!-- ── Results ────────────────────────────────────────────────────────── -->
	{#if data.ip !== null}
		<section class="results-section">
			<div class="results-header">
				<span class="results-label">
					Result for <code class="ip-code">{data.ip}</code>
				</span>
			</div>

			{#if data.error}
				<div class="error-banner" role="alert">
					Redis error: {data.error}
				</div>

			{:else if data.result === null}
				<div class="empty-state">
					No record found for key <code>systems:by-ip:{data.ip}</code>
				</div>

			{:else}
				<table class="result-table">
					<thead>
						<tr>
							<th>Field</th>
							<th>Value</th>
						</tr>
					</thead>
					<tbody>
						{#each entries as [field, value]}
							<tr>
								<td class="cell-field">{field}</td>
								<td class="cell-value">{value}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</section>
	{/if}

	<!-- ── Manual connect ─────────────────────────────────────────────────── -->
	<section class="connect-section">
		<h2 class="section-title">Manual Connect</h2>
		<p class="section-desc">
			Sends a tunnel request directly to the FleetShell client running on this
			machine. The portal signs a JWT for the target device; the client opens
			the tunnel to the gateway.
		</p>

		<form class="connect-form" onsubmit={onConnect}>

			<!-- Target + Gateway -->
		<div class="field-grid">
			<div class="field">
				<label class="field-label" for="cf-target">Target</label>
				<input
					id="cf-target"
					class="field-input"
					type="text"
					placeholder="192.168.1.100"
					bind:value={target}
					required
					autocomplete="off"
					spellcheck="false"
					disabled={busy}
				/>
			</div>

			<div class="field">
				<label class="field-label" for="cf-gateway">Gateway</label>
				<input
					id="cf-gateway"
					class="field-input"
					type="text"
					placeholder="gateway.fleetshell.com"
					bind:value={gateway}
					required
					autocomplete="off"
					spellcheck="false"
					disabled={busy}
				/>
			</div>
		</div>

		<!-- Port rows -->
		<div class="field">
			<span class="field-label">Ports</span>
			<div class="port-rows">
				<div class="port-row-head">
					<span>Ports</span>
					<span>Application</span>
					<span class="col-center">Guac</span>
					<span class="col-center">E2E</span>
					<span>SNI <span class="optional">(optional)</span></span>
					<span></span>
				</div>
				{#each portRows as row, i}
				<div class="port-row">
					<input
						class="pr-input"
						type="text"
						placeholder="443 or 80,8080-8090"
						bind:value={row.ports}
						disabled={busy}
						autocomplete="off"
						spellcheck="false"
					/>
					<select
						class="pr-input pr-select"
						bind:value={row.application}
						disabled={busy}
					>
						<option value="https">HTTPS</option>
						<option value="http">HTTP</option>
						<option value="rdp">RDP</option>
						<option value="vnc">VNC</option>
					</select>
					<label class="pr-check" title="Open via Guacamole in a new browser tab (placeholder)">
						<input type="checkbox" class="check-input" bind:checked={row.guac} disabled={busy} />
					</label>
					<label class="pr-check" title="Pass TLS bytes end-to-end; browser sees device certificate directly">
						<input type="checkbox" class="check-input" bind:checked={row.e2ecrypt} disabled={busy} />
					</label>
					<input
						class="pr-input"
						class:pr-sni-muted={!sniEffective(row)}
						type="text"
						placeholder="device.example.com"
						bind:value={row.sni}
						disabled={busy}
						autocomplete="off"
						spellcheck="false"
					/>
					<button
						type="button"
						class="pr-remove"
						onclick={() => removeRow(i)}
						disabled={busy || portRows.length === 1}
						title="Remove row"
						aria-label="Remove row"
					>✕</button>
				</div>
				{/each}
				<button
					type="button"
					class="pr-add"
					onclick={addRow}
					disabled={busy}
				>+ Add row</button>
			</div>
		</div>

		<!-- Service Key -->
		<div class="field">
			<label class="field-label" for="cf-servicekey">
				Service Key <span class="optional">(optional)</span>
			</label>
			<input
				id="cf-servicekey"
				class="field-input"
				type="text"
				placeholder="abcde-…"
				bind:value={servicekey}
				autocomplete="off"
				spellcheck="false"
				disabled={busy}
			/>
		</div>

		<!-- Username + Password -->
		<div class="field-grid">
			<div class="field">
				<label class="field-label" for="cf-username">
					Username <span class="optional">(optional)</span>
				</label>
				<input
					id="cf-username"
					class="field-input"
					type="text"
					placeholder="administrator"
					bind:value={username}
					autocomplete="off"
					spellcheck="false"
					disabled={busy}
				/>
			</div>
			<div class="field">
				<label class="field-label" for="cf-password">
					Password <span class="optional">(optional)</span>
				</label>
				<input
					id="cf-password"
					class="field-input"
					type="password"
					placeholder="••••••••"
					bind:value={password}
					autocomplete="current-password"
					disabled={busy}
				/>
			</div>
		</div>

				<!-- Action row -->
			<div class="action-row">
				<button
					type="submit"
					class="connect-btn"
					disabled={busy}
				>
					{#if connectState === 'signing'}
						Signing token…
					{:else if connectState === 'connecting'}
						Connecting…
					{:else}
						Connect
					{/if}
				</button>

				{#if connectState === 'done' || connectState === 'error'}
					<button
						type="button"
						class="reset-btn"
						onclick={resetConnect}
					>
						Dismiss
					</button>
				{/if}
			</div>

		</form>

		<!-- Result banner -->
		{#if connectState === 'done'}
			<div class="result-banner result-ok" role="status">
				<span class="result-icon">✓</span>
				<div class="result-body">
					<span class="result-msg">{connectMsg}</span>
					{#if connectUrls.length > 0}
						<ul class="url-list">
							{#each connectUrls as url}
								<li>
									<a class="url-link" href={url} target="_blank" rel="noopener noreferrer">
										{url}
									</a>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
				{#if connectUrls.length > 0}
					<button
						type="button"
						class="open-btn"
						onclick={() => connectUrls.forEach(u => window.open(u, '_blank'))}
					>
						Open
					</button>
				{/if}
			</div>
		{:else if connectState === 'error'}
			<div class="result-banner result-err" role="alert">
				<span class="result-icon">✕</span>
				<span class="result-msg">{connectMsg}</span>
			</div>
		{/if}

	</section>

</div>

<style>
	.page {
		display        : flex;
		flex-direction : column;
		gap            : 32px;
		max-width      : 860px;
	}

	/* ── Title ──────────────────────────────────────────────────────────── */
	.page-title {
		font-size     : 1.1rem;
		font-weight   : 700;
		color         : var(--fg2);
		text-transform: uppercase;
		letter-spacing: 0.1em;
		margin-bottom : 18px;
	}

	/* ── Search form ─────────────────────────────────────────────────────── */
	.search-form {
		display    : flex;
		gap        : 10px;
		align-items: stretch;
	}

	.search-input {
		flex         : 1;
		background   : var(--bg1);
		color        : var(--fg1);
		border       : 1px solid var(--bg3);
		border-radius: 3px;
		padding      : 12px 16px;
		font-family  : inherit;
		font-size    : 1.05rem;
		outline      : none;
		transition   : border-color 0.15s, box-shadow 0.15s;
		min-width    : 0;
	}
	.search-input:focus {
		border-color : var(--bright-blue);
		box-shadow   : 0 0 0 2px color-mix(in srgb, var(--bright-blue) 25%, transparent);
	}
	.search-input::placeholder { color: var(--bg4); }

	.search-btn {
		background   : var(--blue);
		color        : var(--fg0);
		border       : none;
		border-radius: 3px;
		padding      : 12px 28px;
		font-family  : inherit;
		font-size    : 1rem;
		cursor       : pointer;
		white-space  : nowrap;
		transition   : background 0.15s;
		flex-shrink  : 0;
		width        : auto;
	}
	.search-btn:hover  { background: var(--bright-blue); }
	.search-btn:active { background: var(--bg3); }

	/* ── Results ─────────────────────────────────────────────────────────── */
	.results-header  { margin-bottom: 14px; }
	.results-label   { font-size: 0.85rem; color: var(--fg4); }
	.ip-code         { color: var(--bright-yellow); font-family: inherit; }

	.empty-state      { color: var(--fg4); font-size: 0.9rem; padding: 20px 0; }
	.empty-state code { color: var(--bright-orange); font-family: inherit; }

	/* ── Table ───────────────────────────────────────────────────────────── */
	.result-table {
		width           : 100%;
		border-collapse : collapse;
		font-size       : 0.9rem;
	}
	.result-table th {
		text-align    : left;
		padding       : 8px 14px;
		background    : var(--bg1);
		color         : var(--fg4);
		font-weight   : 600;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		font-size     : 0.75rem;
		border-bottom : 1px solid var(--bg2);
	}
	.result-table tr:nth-child(even) { background: var(--bg0); }
	.result-table tr:nth-child(odd)  { background: var(--bg-hard); }
	.result-table tr:hover           { background: var(--bg1); }
	.result-table td {
		padding       : 9px 14px;
		border-bottom : 1px solid var(--bg2);
		vertical-align: top;
	}
	.cell-field { color: var(--bright-aqua); white-space: nowrap; width: 220px; }
	.cell-value { color: var(--fg2); word-break: break-word; }

	/* ── Connect section ─────────────────────────────────────────────────── */
	.connect-section {
		border-top : 1px solid var(--bg2);
		padding-top: 8px;
	}

	.section-title {
		font-size     : 0.85rem;
		font-weight   : 700;
		color         : var(--fg3);
		text-transform: uppercase;
		letter-spacing: 0.1em;
		margin-bottom : 8px;
	}

	.section-desc {
		font-size    : 0.85rem;
		color        : var(--fg4);
		margin-bottom: 22px;
		line-height  : 1.5;
	}

	/* ── Field grid ──────────────────────────────────────────────────────── */
	.connect-form  { display: flex; flex-direction: column; gap: 20px; }

	.field-grid {
		display              : grid;
		grid-template-columns: 1fr 1fr;
		gap                  : 16px 24px;
	}

	.field {
		display       : flex;
		flex-direction: column;
		gap           : 6px;
	}

	/* The transform checkbox occupies the second column and centres vertically */
	.field-check {
		justify-content: flex-end;
	}

	.field-label {
		font-size  : 0.78rem;
		font-weight: 600;
		color      : var(--fg4);
		text-transform: uppercase;
		letter-spacing: 0.07em;
	}

	.optional {
		font-weight   : 400;
		text-transform: none;
		letter-spacing: 0;
		color         : var(--bg4);
	}

	.field-input {
		background   : var(--bg1);
		color        : var(--fg1);
		border       : 1px solid var(--bg3);
		border-radius: 3px;
		padding      : 10px 14px;
		font-family  : inherit;
		font-size    : 0.95rem;
		outline      : none;
		transition   : border-color 0.15s, box-shadow 0.15s;
		min-width    : 0;
	}
	.field-input:focus {
		border-color: var(--bright-blue);
		box-shadow  : 0 0 0 2px color-mix(in srgb, var(--bright-blue) 25%, transparent);
	}
	.field-input::placeholder { color: var(--bg4); }
	.field-input:disabled     { opacity: 0.5; cursor: not-allowed; }

	.field-select {
		appearance      : none;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath fill='%237c6f64' d='M6 8 0 0h12z'/%3E%3C/svg%3E");
		background-repeat  : no-repeat;
		background-position: right 12px center;
		padding-right      : 36px;
		cursor             : pointer;
	}
	.field-select option { background: var(--bg1); }

	/* ── Checkbox ────────────────────────────────────────────────────────── */
	.check-label {
		display    : flex;
		align-items: center;
		gap        : 10px;
		cursor     : pointer;
		padding    : 10px 14px;
		background : var(--bg1);
		border     : 1px solid var(--bg3);
		border-radius: 3px;
	}
	.check-label:has(.check-input:disabled) { opacity: 0.5; cursor: not-allowed; }

	.check-input {
		width        : 15px;
		height       : 15px;
		accent-color : var(--bright-blue);
		flex-shrink  : 0;
		cursor       : inherit;
	}

	.check-text {
		font-size     : 0.85rem;
		color         : var(--fg4);
		line-height   : 1.5;
		text-transform: none;
		letter-spacing: normal;
	}

	/* ── Action row ──────────────────────────────────────────────────────── */
	.action-row {
		display    : flex;
		gap        : 10px;
		align-items: center;
	}

	.connect-btn {
		background   : var(--blue);
		color        : var(--fg0);
		border       : none;
		border-radius: 3px;
		padding      : 12px 36px;
		font-family  : inherit;
		font-size    : 1rem;
		font-weight  : 600;
		cursor       : pointer;
		white-space  : nowrap;
		transition   : background 0.15s;
		width        : auto;
	}
	.connect-btn:hover:not(:disabled)  { background: var(--bright-blue); }
	.connect-btn:active:not(:disabled) { background: var(--bg3); }
	.connect-btn:disabled              { opacity: 0.5; cursor: not-allowed; }

	.reset-btn {
		background   : transparent;
		color        : var(--fg4);
		border       : 1px solid var(--bg3);
		border-radius: 3px;
		padding      : 12px 20px;
		font-family  : inherit;
		font-size    : 0.9rem;
		cursor       : pointer;
		transition   : border-color 0.15s, color 0.15s;
		width        : auto;
	}
	.reset-btn:hover { border-color: var(--fg4); color: var(--fg2); }

	/* ── Result banner ───────────────────────────────────────────────────── */
	.result-banner {
		display      : flex;
		align-items  : flex-start;
		gap          : 12px;
		border-radius: 3px;
		padding      : 14px 18px;
		font-size    : 0.9rem;
		line-height  : 1.5;
		margin-top   : 16px;
	}

	.result-ok  { background: color-mix(in srgb, var(--green)  15%, var(--bg0)); border: 1px solid var(--green);     }
	.result-err { background: color-mix(in srgb, var(--red)    15%, var(--bg0)); border: 1px solid var(--bright-red); }

	.result-icon {
		font-size  : 1rem;
		flex-shrink: 0;
		margin-top : 1px;
	}
	.result-ok  .result-icon { color: var(--bright-green); }
	.result-err .result-icon { color: var(--bright-red);   }

	.result-body { display: flex; flex-direction: column; gap: 8px; }

	.result-msg { color: var(--fg2); }
	.result-err .result-msg { color: var(--fg1); }

	.url-list {
		list-style  : none;
		padding     : 0;
		margin      : 0;
		display     : flex;
		flex-direction: column;
		gap         : 4px;
	}

	.url-link {
		color          : var(--bright-blue);
		text-decoration: none;
		font-family    : monospace;
		font-size      : 0.88rem;
	}
	.url-link:hover { text-decoration: underline; }

	/* ── Open button (inside success banner) ────────────────────────────────── */
	.open-btn {
		margin-left  : auto;
		flex-shrink  : 0;
		align-self   : center;
		background   : var(--green);
		color        : var(--fg0);
		border       : none;
		border-radius: 3px;
		padding      : 8px 22px;
		font-family  : inherit;
		font-size    : 0.9rem;
		font-weight  : 600;
		cursor       : pointer;
		white-space  : nowrap;
		transition   : background 0.15s;
		width        : auto;
	}
	.open-btn:hover  { background: var(--bright-green); color: var(--bg-hard); }
	.open-btn:active { background: var(--aqua); }

	/* ── Port rows ─────────────────────────────────────────────────────────── */
	.port-rows {
		border       : 1px solid var(--bg3);
		border-radius: 3px;
		overflow     : hidden;
	}

	.port-row-head,
	.port-row {
		display              : grid;
		grid-template-columns: 140px 110px 52px 52px 1fr 32px;
		align-items          : stretch;
	}

	.port-row-head {
		background    : var(--bg1);
		font-size     : 0.72rem;
		font-weight   : 600;
		color         : var(--fg4);
		text-transform: uppercase;
		letter-spacing: 0.07em;
	}
	.port-row-head > span {
		padding: 7px 10px;
	}
	.col-center { text-align: center; }

	.port-row { border-top: 1px solid var(--bg2); }

	/* Shared style for all inline inputs and selects inside a port row */
	.pr-input {
		background  : transparent;
		color       : var(--fg1);
		border      : none;
		border-right: 1px solid var(--bg2);
		padding     : 9px 10px;
		font-family : inherit;
		font-size   : 0.92rem;
		outline     : none;
		width       : 100%;
		min-width   : 0;
		transition  : background 0.12s;
	}
	.pr-input:focus {
		background: var(--bg1);
		box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--bright-blue) 30%, transparent);
		position  : relative;
		z-index   : 1;
	}
	.pr-input::placeholder { color: var(--bg4); }
	.pr-input:disabled     { opacity: 0.5; cursor: not-allowed; }

	.pr-select {
		appearance         : none;
		background-image   : url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath fill='%237c6f64' d='M6 8 0 0h12z'/%3E%3C/svg%3E");
		background-repeat  : no-repeat;
		background-position: right 8px center;
		padding-right      : 28px;
		cursor             : pointer;
	}
	.pr-select option { background: var(--bg1); }

	.pr-check {
		display        : flex;
		justify-content: center;
		align-items    : center;
		border-right   : 1px solid var(--bg2);
		cursor         : pointer;
	}
	.pr-check:has(.check-input:disabled) { opacity: 0.5; cursor: not-allowed; }

	/* Dim SNI when it has no effect (rdp/vnc, or e2ecrypt on) */
	.pr-sni-muted { opacity: 0.35; }

	.pr-remove {
		background     : transparent;
		color          : var(--fg4);
		border         : none;
		cursor         : pointer;
		display        : flex;
		align-items    : center;
		justify-content: center;
		padding        : 0;
		font-size      : 0.85rem;
		transition     : color 0.12s;
	}
	.pr-remove:hover:not(:disabled) { color: var(--bright-red); }
	.pr-remove:disabled              { opacity: 0.25; cursor: not-allowed; }

	.pr-add {
		display    : block;
		width      : 100%;
		background : transparent;
		color      : var(--bright-blue);
		border     : none;
		border-top : 1px solid var(--bg2);
		padding    : 8px 14px;
		font-family: inherit;
		font-size  : 0.85rem;
		cursor     : pointer;
		text-align : left;
		transition : background 0.12s, color 0.12s;
	}
	.pr-add:hover:not(:disabled) { background: var(--bg1); color: var(--bright-aqua); }
	.pr-add:disabled              { opacity: 0.5; cursor: not-allowed; }
</style>
