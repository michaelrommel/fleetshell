<script lang="ts">
	import type { PageData }     from './$types';
	import { CLIENT_API_BASE }   from '$lib/client-api';
	import { onMount }           from 'svelte';

	let { data }: { data: PageData } = $props();

	// ── Types (mirror $lib/server/devices) ──────────────────────────────────────
	type Application = 'http' | 'https' | 'expert-i' | 'rdp' | 'vnc' | 'ssh';

	interface AppProfile {
		name: string; ports: string; application: Application;
		guac: boolean; e2ecrypt: boolean; sni: string; path: string;
		width: number; height: number; dpi: number; drive: boolean; record: boolean;
	}
	/** Working row: an AppProfile plus a view-mode "connect this" flag. */
	interface PortRow extends AppProfile { selected: boolean; }

	interface DeviceConfig { target: string; gateway: string; servicekey: string; apps: AppProfile[]; }
	interface DeviceSummary { ip: string; fields: Record<string, string>; app_count: number; }
	interface DeviceDetail  { ip: string; exists: boolean; fields: Record<string, string>; config: DeviceConfig; }

	// ── Mode ────────────────────────────────────────────────────────────────────
	type Mode = 'list' | 'view' | 'edit';
	let mode = $state<Mode>('list');

	// ── Search / list ───────────────────────────────────────────────────────────
	let query       = $state(data.initialQuery ?? '');
	let searching   = $state(false);
	let devices     = $state<DeviceSummary[]>([]);
	let searchError = $state('');

	// ── Detail ──────────────────────────────────────────────────────────────────
	let detail    = $state<DeviceDetail | null>(null);
	let loading    = $state(false);
	let loadError  = $state('');

	// ── Connection working set (shared by view + connect) ───────────────────────
	let target     = $state('');
	let gateway    = $state('');
	let servicekey = $state('');
	let username   = $state('');
	let password   = $state('');
	let portRows   = $state<PortRow[]>([]);

	// ── Edit / create ───────────────────────────────────────────────────────────
	let isCreate  = $state(false);
	let createIp  = $state('');
	let saving    = $state(false);
	let saveError = $state('');

	// ── Helpers: app profile <-> port row ────────────────────────────────────────
	function blankRow(): PortRow {
		return {
			name: '', ports: '', application: 'https', guac: false, e2ecrypt: false,
			sni: '', path: '/', width: 1920, height: 1080, dpi: 96,
			drive: false, record: false, selected: false,
		};
	}
	function appToRow(a: AppProfile): PortRow { return { ...a, selected: false }; }
	function rowToApp(r: PortRow): AppProfile {
		const { selected, ...app } = r;
		return app;
	}

	// ── Search ────────────────────────────────────────────────────────────────────
	async function search(): Promise<void> {
		searching   = true;
		searchError = '';
		loadError   = '';
		try {
			const res  = await fetch(`/api/devices?q=${encodeURIComponent(query.trim())}`);
			if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
			const body = await res.json();
			devices    = body.devices ?? [];
			if (devices.length === 0) searchError = 'No devices found.';
		} catch (e) {
			searchError = String(e);
		} finally {
			searching = false;
		}
	}

	onMount(() => { if (query.trim()) search(); });

	// ── Load detail (view) ───────────────────────────────────────────────────────
	async function view(ip: string): Promise<void> {
		loading   = true;
		loadError = '';
		resetConnect();
		try {
			const res  = await fetch(`/api/devices/${encodeURIComponent(ip)}`);
			if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
			const body = await res.json();
			detail     = body.device as DeviceDetail;
			loadConfigIntoState(detail.config);
			mode       = 'view';
		} catch (e) {
			loadError = String(e);
		} finally {
			loading = false;
		}
	}

	function loadConfigIntoState(cfg: DeviceConfig): void {
		target     = cfg.target;
		gateway    = cfg.gateway;
		servicekey = cfg.servicekey;
		portRows   = cfg.apps.map(appToRow);
	}

	// ── Enter edit / create ───────────────────────────────────────────────────────
	function startEdit(): void {
		if (!detail) return;
		isCreate  = false;
		saveError = '';
		// portRows/target/gateway/servicekey already reflect the loaded config.
		if (portRows.length === 0) portRows = [blankRow()];
		mode = 'edit';
	}

	function startCreate(): void {
		isCreate   = true;
		saveError  = '';
		createIp   = '';
		target     = '';
		gateway    = 'gateway.fleetshell.com';
		servicekey = '';
		portRows   = [blankRow()];
		detail     = null;
		resetConnect();
		mode = 'edit';
	}

	// ── Save (upsert app_config) ───────────────────────────────────────────────────
	async function save(): Promise<void> {
		saveError = '';
		const ip = (isCreate ? createIp : detail?.ip ?? '').trim();
		if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) { saveError = 'Enter a valid IPv4 device address.'; return; }

		const config: DeviceConfig = {
			target: target.trim() || ip,
			gateway: gateway.trim(),
			servicekey: servicekey.trim(),
			apps: portRows.map(rowToApp),
		};

		saving = true;
		try {
			const res = await fetch(`/api/devices/${encodeURIComponent(ip)}`, {
				method:  'PUT',
				headers: { 'Content-Type': 'application/json' },
				body:    JSON.stringify({ config, create: isCreate }),
			});
			if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
			await view(ip);      // reload detail into view mode
			await search();      // refresh list in the background
		} catch (e) {
			saveError = String(e);
		} finally {
			saving = false;
		}
	}

	function cancelEdit(): void {
		if (isCreate) { mode = 'list'; detail = null; }
		else if (detail) view(detail.ip);
		else mode = 'list';
	}

	function backToList(): void { mode = 'list'; detail = null; resetConnect(); }

	// ── Port-row editor helpers ────────────────────────────────────────────────────
	function addRow(): void { portRows = [...portRows, blankRow()]; }
	function removeRow(i: number): void {
		if (portRows.length > 1) portRows = portRows.filter((_, idx) => idx !== i);
	}
	function guacApplicable(row: PortRow): boolean {
		return row.application === 'rdp' || row.application === 'vnc' || row.application === 'ssh';
	}
	function sniEffective(row: PortRow): boolean {
		if (row.guac) return false;
		return (row.application === 'http' || row.application === 'https' || row.application === 'expert-i') && !row.e2ecrypt;
	}
	function showGuacParams(row: PortRow): boolean { return row.guac && guacApplicable(row); }
	function showPathParam(row: PortRow): boolean {
		return row.application === 'http' || row.application === 'https' || row.application === 'expert-i';
	}
	function onAppChange(row: PortRow): void {
		if (guacApplicable(row)) {
			if (!row.guac && row.application !== 'ssh') row.e2ecrypt = true;
		} else {
			row.guac = false; row.e2ecrypt = false;
		}
		if (row.application !== 'rdp') row.drive = false;
		if (!guacApplicable(row))      row.record = false;
	}

	// ══ CONNECT FLOW (preserved from the original page) ═════════════════════════

	type ConnectState = 'idle' | 'signing' | 'connecting' | 'launching' | 'done' | 'error';
	let connectState = $state<ConnectState>('idle');
	let connectMsg   = $state('');
	let connectUrls    = $state<string[]>([]);
	let connectedToken = $state<string | null>(null);
	let connectedBindIp = $state<string>('');
	let connectedRows  = $state<PortRow[]>([]);
	let probeState = $state<'idle' | 'checking' | 'unreachable'>('idle');
	let probeMsg   = $state('');
	let probeBtn   = $state<ResultButton | null>(null);

	let resultBanner: HTMLElement | undefined = $state();
	$effect(() => {
		if (connectState === 'done' || connectState === 'error') {
			resultBanner?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
		}
	});

	const busy = $derived(connectState === 'signing' || connectState === 'connecting');

	/** Rows the user has ticked for connection. */
	function selectedRows(): PortRow[] { return portRows.filter(r => r.selected); }
	const selectedCount = $derived(portRows.filter(r => r.selected).length);

	function tunnelBody(token: string): string {
		const rows    = selectedRows();
		const guacRow = rows.find(r => r.guac && guacApplicable(r));
		const sshRow  = rows.find(r => r.application === 'ssh' && !r.guac);
		const dimRow  = guacRow ?? sshRow;
		return JSON.stringify({
			target,
			token,
			gateway,
			servicekey : servicekey || undefined,
			username   : username   || undefined,
			password   : password   || undefined,
			width         : dimRow?.width  ?? undefined,
			height        : dimRow?.height ?? undefined,
			dpi           : dimRow?.dpi    ?? undefined,
			enable_drive  : (guacRow?.drive && guacRow?.application === 'rdp') || undefined,
			enable_record : guacRow?.record || undefined,
			port_rows  : rows.map(r => ({
				ports      : r.ports,
				application: r.application,
				guac       : r.guac       || undefined,
				e2ecrypt   : (!r.guac && r.e2ecrypt) ? true : undefined,
				sni        : r.sni        || undefined,
				path       : (r.path && r.path !== '/') ? r.path : undefined,
			})),
		});
	}

	const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

	interface ResultButton {
		label: string; kind: 'url' | 'guac' | 'launch';
		url: string; app: string; port: number; record?: boolean;
	}
	function firstPort(spec: string): number {
		const part = spec.split(',')[0].trim();
		const n    = parseInt(part.split('-')[0]);
		return isNaN(n) ? 0 : n;
	}
	function portFromUrl(url: string): number {
		try { return parseInt(new URL(url).port) || 0; } catch { return 0; }
	}
	function rowForPort(port: number, rows: PortRow[]): PortRow | undefined {
		return rows.find(r => {
			for (const part of r.ports.split(',')) {
				const t = part.trim();
				if (t.includes('-')) {
					const [s, e] = t.split('-').map(Number);
					if (port >= s && port <= e) return true;
				} else if (parseInt(t) === port) return true;
			}
			return false;
		});
	}

	const resultButtons = $derived<ResultButton[]>((() => {
		if (connectState !== 'done') return [];
		const buttons: ResultButton[] = [];

		for (const url of connectUrls) {
			if (url.startsWith('wss://') || url.startsWith('ws://')) {
				const isSshWs = url.includes('/ssh-ws');
				if (isSshWs) {
					const row = connectedRows.find(r => r.application === 'ssh' && !r.guac);
					if (!row?.selected) continue;
					buttons.push({ label: 'Open SSH Session', kind: 'guac', url, app: 'ssh', port: firstPort(row.ports) });
				} else {
					const row = connectedRows.find(r => r.guac && guacApplicable(r));
					if (!row?.selected) continue;
					buttons.push({
						label: `Open ${row.application.toUpperCase()} Session`,
						kind: 'guac', url, app: row.application, port: firstPort(row.ports), record: row.record,
					});
				}
			} else {
				const port = portFromUrl(url);
				const row  = rowForPort(port, connectedRows);
				if (!row?.selected) continue;
				buttons.push({ label: `${row.application.toUpperCase()} :${port}`, kind: 'url', url, app: row.application, port });
			}
		}

		const hasSshWs = connectUrls.some(u => u.includes('/ssh-ws'));
		for (const row of connectedRows) {
			if (!row.selected) continue;
			if (row.guac || !guacApplicable(row)) continue;
			if (row.application === 'ssh' && hasSshWs) continue;
			const port = firstPort(row.ports);
			if (!port) continue;
			buttons.push({ label: `Open ${row.application.toUpperCase()} :${port}`, kind: 'launch', url: '', app: row.application, port });
		}
		return buttons;
	})());

	async function executeItem(btn: ResultButton): Promise<void> {
		if (btn.kind === 'guac') {
			const proto = btn.url.includes('/ssh-ws') ? '&proto=ssh' : '';
			const rec   = (!btn.url.includes('/ssh-ws') && btn.record) ? '&record=1' : '';
			window.open(`/session?ws=${encodeURIComponent(btn.url)}${proto}${rec}`, '_blank');
		} else if (btn.kind === 'launch') {
			try {
				await fetch(`${CLIENT_API_BASE}/api/launch`, {
					method: 'POST', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ bind_ip: connectedBindIp, port: btn.port, application: btn.app }),
				});
			} catch (e) { console.error('launch failed', e); }
		} else {
			window.open(btn.url, '_blank', 'noopener,noreferrer');
		}
	}

	async function openItem(btn: ResultButton): Promise<void> {
		if (!connectedToken) { await executeItem(btn); return; }
		probeState = 'checking'; probeMsg = ''; probeBtn = btn;
		try {
			const res = await fetch(`${CLIENT_API_BASE}/api/probe`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ target, port: btn.port, gateway, token: connectedToken }),
				signal: AbortSignal.timeout(7_000),
			});
			if (!res.ok) { await executeItem(btn); probeState = 'idle'; probeBtn = null; return; }
			const data = await res.json();
			if (data.reachable) { await executeItem(btn); probeState = 'idle'; probeBtn = null; }
			else { probeMsg = data.message ?? 'Target device did not respond.'; probeState = 'unreachable'; }
		} catch {
			await executeItem(btn); probeState = 'idle'; probeBtn = null;
		}
	}

	async function onConnect(e: Event): Promise<void> {
		e.preventDefault();
		if (selectedRows().length === 0) {
			connectState = 'error';
			connectMsg   = 'Select at least one application to connect.';
			return;
		}
		await doConnect();
	}

	async function doConnect(): Promise<void> {
		connectState = 'signing';
		connectMsg   = '';
		connectUrls  = [];

		const rows     = selectedRows();
		const allPorts = rows.map(r => r.ports).filter(Boolean).join(',');

		let token: string;
		try {
			const res = await fetch('/api/tunnel/sign', {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					target, ports: allPorts, gateway,
					record: rows.find(r => r.guac && guacApplicable(r))?.record ?? false,
				}),
			});
			if (!res.ok) {
				if (res.status === 401) { window.location.href = '/login'; return; }
				throw new Error(`Sign failed (${res.status}): ${await res.text()}`);
			}
			({ token } = await res.json());
		} catch (err) {
			connectState = 'error'; connectMsg = String(err); return;
		}

		connectState = 'connecting';
		try {
			const res = await fetch(`${CLIENT_API_BASE}/api/tunnel`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: tunnelBody(token),
			});
			if (!res.ok) throw new Error(`Client returned ${res.status}: ${await res.text()}`);
			const body = await res.json();
			connectUrls     = Array.isArray(body.urls) ? body.urls : [];
			connectedBindIp = body.bind_ip ?? '';
			connectedRows   = rows.map(r => ({ ...r }));
			connectedToken  = token;
			probeState      = 'idle';
			const portList  = (body.ports ?? []).join(', ');
			connectMsg = connectedBindIp
				? `Tunnel open via ${gateway} \u00b7 slot ${connectedBindIp} \u00b7 port(s): ${portList}`
				: `Tunnel open via ${gateway} \u00b7 port(s): ${portList}`;
			connectState = 'done';
		} catch (err) {
			if (err instanceof TypeError) { await launchViaDeepLink(token); }
			else { connectState = 'error'; connectMsg = String(err); }
		}
	}

	function resetConnect(): void {
		connectState = 'idle'; connectMsg = ''; connectUrls = [];
		connectedToken = null; connectedBindIp = ''; connectedRows = [];
		probeState = 'idle'; probeMsg = ''; probeBtn = null;
	}

	async function launchViaDeepLink(token: string): Promise<void> {
		const rows = selectedRows();
		const envelope = {
			type: 'tunnel',
			payload: {
				target, token, gateway,
				servicekey: servicekey || undefined,
				username: username || undefined,
				password: password || undefined,
				port_rows: rows.map(r => ({
					ports: r.ports, application: r.application,
					guac: r.guac || undefined, e2ecrypt: r.e2ecrypt || undefined, sni: r.sni || undefined,
				})),
			},
		};
		const encoded = btoa(JSON.stringify(envelope)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
		window.location.href = `fleetshell://${encoded}`;

		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			await sleep(750);
			try {
				const res = await fetch(`${CLIENT_API_BASE}/api/tunnel`, {
					method: 'POST', headers: { 'Content-Type': 'application/json' },
					body: tunnelBody(token), signal: AbortSignal.timeout(2_000),
				});
				if (res.ok) {
					const body = await res.json();
					connectUrls    = Array.isArray(body.urls) ? body.urls : [];
					connectedRows  = rows.map(r => ({ ...r }));
					connectedBindIp = body.bind_ip ?? '';
					connectMsg     = `Gateway tunnel open on port(s): ${(body.ports ?? []).join(', ')}`;
					connectState   = 'done';
					connectedToken = token;
					probeState     = 'idle';
					return;
				}
				connectState = 'error';
				connectMsg   = `Client returned ${res.status}: ${await res.text()}`;
				return;
			} catch { /* keep polling */ }
		}
		connectState = 'launching';
	}

	// ── Display helpers ───────────────────────────────────────────────────────────
	const PRIMARY_FIELDS = ['serial', 'product', 'partno', 'country'];
	function appSummary(a: PortRow): string {
		const bits = [a.application.toUpperCase(), a.ports || '?'];
		if (a.guac)     bits.push('guac');
		if (a.e2ecrypt) bits.push('e2e');
		if (a.record)   bits.push('rec');
		if (a.drive)    bits.push('drive');
		return bits.join(' \u00b7 ');
	}
</script>

<svelte:head><title>Devices — FleetShell Portal</title></svelte:head>

<div class="page">
	<div class="page-head">
		<h1 class="page-title">Devices</h1>
		{#if mode === 'list'}
			<button class="btn-primary" onclick={startCreate}>+ New device</button>
		{/if}
	</div>

	<!-- ══ LIST ══════════════════════════════════════════════════════════════ -->
	{#if mode === 'list'}
		<section class="card">
			<h2 class="card-title">Search</h2>
			<form class="search-form" onsubmit={(e) => { e.preventDefault(); search(); }}>
				<input
					class="search-input"
					type="text"
					placeholder="ip:198.51.100.134   serial:100134   (space = AND, | = OR, blank = all)"
					bind:value={query}
					disabled={searching}
					autocomplete="off"
					spellcheck="false"
				/>
				<button class="search-btn" type="submit" disabled={searching}>
					{searching ? 'Searching…' : 'Search'}
				</button>
			</form>
			<p class="hint">
				Fields: <code>ip:</code> device IP, or any record field
				(<code>serial:</code>, <code>product:</code>, <code>country:</code> …).
				Combine with spaces (AND) or <code>|</code> (OR). Leave blank to list all.
			</p>
		</section>

		{#if loadError}<p class="notice notice--warn">{loadError}</p>{/if}
		{#if searchError}<p class="notice notice--warn">{searchError}</p>{/if}

		{#if devices.length > 0}
		<section class="card">
			<h2 class="card-title">Results — {devices.length} device{devices.length !== 1 ? 's' : ''}</h2>
			<table class="gw-table">
				<thead>
					<tr>
						<th>IP</th><th>Serial</th><th>Product</th><th>Part #</th>
						<th>Country</th><th>Apps</th><th></th>
					</tr>
				</thead>
				<tbody>
					{#each devices as dev}
					<tr>
						<td class="ip-cell">{dev.ip}</td>
						{#each PRIMARY_FIELDS as f}<td>{dev.fields[f] ?? '—'}</td>{/each}
						<td>{dev.app_count}</td>
						<td>
							<button class="btn-detail" onclick={() => view(dev.ip)} disabled={loading}>View</button>
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
				Device <span class="sub">{detail.ip}</span>
				<button class="btn-back" onclick={backToList}>✕</button>
			</h2>

			<div class="view-actions">
				<button class="btn-primary" onclick={startEdit}>Edit configuration</button>
			</div>

			<h3 class="sub-title">Record fields <span class="sub">read-only</span></h3>
			{#if Object.keys(detail.fields).length === 0}
				<p class="notice">No aeroftp record fields (device created via portal).</p>
			{:else}
				<table class="result-table">
					<thead><tr><th>Field</th><th>Value</th></tr></thead>
					<tbody>
						{#each Object.entries(detail.fields).sort(([a],[b]) => a.localeCompare(b)) as [field, value]}
							<tr><td class="cell-field">{field}</td><td class="cell-value">{value}</td></tr>
						{/each}
					</tbody>
				</table>
			{/if}

			<h3 class="sub-title">Connection</h3>
			<dl class="kv">
				<dt>Target</dt><dd class="mono">{target || '—'}</dd>
				<dt>Gateway</dt><dd class="mono">{gateway || '—'}</dd>
				<dt>Service key</dt><dd class="mono">{servicekey || '—'}</dd>
			</dl>
		</section>

		<!-- Connect: pick apps -->
		<section class="card">
			<h2 class="card-title">Connect</h2>
			{#if portRows.length === 0}
				<p class="notice">No applications configured. Use <em>Edit configuration</em> to add some.</p>
			{:else}
				<form class="connect-form" onsubmit={onConnect}>
					<div class="app-list">
						{#each portRows as row}
						<label class="app-item" class:app-item--on={row.selected}>
							<input type="checkbox" class="check-input" bind:checked={row.selected} disabled={busy} />
							<span class="app-name">{row.name || row.application.toUpperCase()}</span>
							<span class="app-sum">{appSummary(row)}</span>
						</label>
						{/each}
					</div>

					<div class="field-grid">
						<div class="field">
							<label class="field-label" for="cf-username">Username <span class="optional">(optional)</span></label>
							<input id="cf-username" class="field-input" type="text" placeholder="administrator"
							       bind:value={username} autocomplete="off" spellcheck="false" disabled={busy} />
						</div>
						<div class="field">
							<label class="field-label" for="cf-password">Password <span class="optional">(optional)</span></label>
							<input id="cf-password" class="field-input" type="password" placeholder="••••••••"
							       bind:value={password} autocomplete="current-password" disabled={busy} />
						</div>
					</div>

					<div class="action-row">
						<button type="submit" class="connect-btn" disabled={busy || selectedCount === 0}>
							{#if connectState === 'signing'}Signing token…
							{:else if connectState === 'connecting'}Connecting…
							{:else}Connect{selectedCount > 0 ? ` (${selectedCount})` : ''}{/if}
						</button>
						{#if connectState === 'done' || connectState === 'error' || connectState === 'launching'}
							<button type="button" class="reset-btn" onclick={resetConnect}>Dismiss</button>
						{/if}
					</div>
				</form>

				<!-- Result banner -->
				{#if connectState === 'done'}
					<div class="result-banner result-ok" role="status" bind:this={resultBanner}>
						<span class="result-icon">✓</span>
						<div class="result-body">
							<span class="result-msg">{connectMsg}</span>
							{#if resultButtons.length > 0}
								<div class="result-buttons">
									{#each resultButtons as btn}
										<button type="button" class="result-open-btn"
											class:result-open-btn--guac={btn.kind === 'guac'}
											class:result-open-btn--launch={btn.kind === 'launch'}
											disabled={probeState === 'checking' && probeBtn?.label === btn.label}
											onclick={() => openItem(btn)}>
											{#if probeState === 'checking' && probeBtn?.label === btn.label}Checking…{:else}{btn.label}{/if}
										</button>
									{/each}
								</div>
							{/if}
							{#if probeState === 'unreachable' && probeBtn}
								<div class="probe-warn">
									<strong>⚠ Device not reachable</strong>
									<span>{probeMsg}</span>
									<span class="probe-warn-btns">
										<button type="button" class="probe-btn probe-btn-open"
											onclick={async () => { const b = probeBtn!; probeState = 'idle'; probeBtn = null; await executeItem(b); }}>Open anyway</button>
										<button type="button" class="probe-btn probe-btn-retry"
											onclick={async () => { const b = probeBtn!; probeState = 'idle'; probeBtn = null; await openItem(b); }}>Retry check</button>
									</span>
								</div>
							{/if}
						</div>
					</div>
				{:else if connectState === 'error'}
					<div class="result-banner result-err" role="alert" bind:this={resultBanner}>
						<span class="result-icon">✕</span>
						<span class="result-msg">{connectMsg}</span>
					</div>
				{:else if connectState === 'launching'}
					<div class="result-banner result-launching" role="status" bind:this={resultBanner}>
						<span class="result-icon">⟳</span>
						<div class="result-body">
							<span class="result-msg">
								FleetShell client is not running. A launch command has been sent via the
								<code>fleetshell://</code> protocol — if the client is installed it will start and
								connect automatically. Otherwise install it from the <a href="/support">Support</a> page.
							</span>
						</div>
						<button type="button" class="open-btn" onclick={doConnect}>Try again</button>
					</div>
				{/if}
			{/if}
		</section>
	{/if}

	<!-- ══ EDIT / CREATE ═════════════════════════════════════════════════════ -->
	{#if mode === 'edit'}
		<section class="card">
			<h2 class="card-title">
				{isCreate ? 'New device' : `Edit — ${detail?.ip ?? ''}`}
				<button class="btn-back" onclick={cancelEdit}>✕</button>
			</h2>

			{#if isCreate}
				<p class="notice">Enter the device IP and its application configuration. The device must be saved before you can connect.</p>
			{/if}

			<div class="field-grid">
				{#if isCreate}
				<div class="field">
					<label class="field-label" for="cf-ip">Device IP <em class="req">*</em></label>
					<input id="cf-ip" class="field-input mono" type="text" placeholder="198.51.100.134"
					       bind:value={createIp} autocomplete="off" spellcheck="false" />
				</div>
				{/if}
				<div class="field">
					<label class="field-label" for="cf-target">Target</label>
					<input id="cf-target" class="field-input mono" type="text" placeholder="192.168.1.100"
					       bind:value={target} autocomplete="off" spellcheck="false" />
				</div>
				<div class="field">
					<label class="field-label" for="cf-gateway">Gateway</label>
					<input id="cf-gateway" class="field-input" type="text" placeholder="gateway.fleetshell.com"
					       bind:value={gateway} autocomplete="off" spellcheck="false" />
				</div>
			</div>

			<!-- Port rows editor -->
			<div class="field">
				<span class="field-label">Applications</span>
				<div class="port-rows">
					<div class="port-row-head">
						<span>Name</span>
						<span>Ports</span>
						<span>Application</span>
						<span class="col-center">Guac</span>
						<span class="col-center">E2E</span>
						<span></span>
					</div>
					{#each portRows as row, i}
					<div class="port-row">
						<input class="pr-input" type="text" placeholder="RDP console"
						       bind:value={row.name} autocomplete="off" spellcheck="false" />
						<input class="pr-input" type="text" placeholder="443 or 80,8080-8090"
						       bind:value={row.ports} autocomplete="off" spellcheck="false" />
						<select class="pr-input pr-select" bind:value={row.application} onchange={() => onAppChange(row)}>
							<option value="https">HTTPS</option>
							<option value="http">HTTP</option>
							<option value="expert-i">Expert-i</option>
							<option value="rdp">RDP</option>
							<option value="vnc">VNC</option>
							<option value="ssh">SSH</option>
						</select>
						<label class="pr-check" title={guacApplicable(row) ? 'Open via Guacamole in a new browser tab' : 'Guacamole not applicable'}>
							<input type="checkbox" class="check-input" bind:checked={row.guac} disabled={!guacApplicable(row)} />
						</label>
						<label class="pr-check" title={row.guac ? 'E2E not applicable — guacd handles the upstream' : guacApplicable(row) ? 'Required — native protocol relayed byte-for-byte' : 'Pass TLS bytes end-to-end'}>
							<input type="checkbox" class="check-input" bind:checked={row.e2ecrypt}
							       disabled={row.guac || (guacApplicable(row) && row.application !== 'ssh')} />
						</label>
						<button type="button" class="pr-remove" onclick={() => removeRow(i)}
						        disabled={portRows.length === 1} title="Remove row" aria-label="Remove row">✕</button>
					</div>
					{#if showPathParam(row)}
					<div class="port-row-path">
						<span class="path-param-label">Path</span>
						<input class="path-param-input" type="text" placeholder="/" bind:value={row.path} autocomplete="off" spellcheck="false" />
						<span class="path-param-label path-param-sni-label">SNI</span>
						<input class="path-param-input path-param-sni" type="text" placeholder="device.example.com"
						       bind:value={row.sni} disabled={!sniEffective(row)} autocomplete="off" spellcheck="false" />
					</div>
					{/if}
					{#if showGuacParams(row)}
					<div class="port-row-guac">
						<span class="guac-param-label">Width</span>
						<input class="guac-param-input" type="number" min="640" max="7680" step="1" bind:value={row.width} />
						<span class="guac-param-label">Height</span>
						<input class="guac-param-input" type="number" min="480" max="4320" step="1" bind:value={row.height} />
						<span class="guac-param-label">DPI</span>
						<input class="guac-param-input guac-param-dpi" type="number" min="72" max="288" step="1" bind:value={row.dpi} />
						<span class="guac-param-hint">px — Guacamole display size</span>
						<label class="guac-param-drive" title={row.application === 'rdp' ? 'Mount a shared drive buffer (RDP only)' : 'Drive sharing is RDP-only'}>
							<input type="checkbox" class="check-input" bind:checked={row.drive} disabled={row.application !== 'rdp'} /> Drives
						</label>
						<label class="guac-param-record" title="Record this session on the gateway">
							<input type="checkbox" class="check-input" bind:checked={row.record} /> Record
						</label>
					</div>
					{/if}
					{/each}
					<button type="button" class="pr-add" onclick={addRow}>+ Add application</button>
				</div>
			</div>

			<!-- Service key -->
			<div class="field">
				<label class="field-label" for="cf-servicekey">Service Key <span class="optional">(optional)</span></label>
				<input id="cf-servicekey" class="field-input" type="text" placeholder="abcde-…"
				       bind:value={servicekey} autocomplete="off" spellcheck="false" />
			</div>

			{#if saveError}<p class="notice notice--warn">{saveError}</p>{/if}

			<div class="form-actions">
				<button class="btn-action" onclick={cancelEdit} disabled={saving}>Cancel</button>
				<button class="btn-action btn-action--primary" onclick={save} disabled={saving}>
					{saving ? 'Saving…' : 'Save'}
				</button>
			</div>
		</section>
	{/if}
</div>

<style>
	.page       { display: flex; flex-direction: column; gap: 18px; max-width: 1000px; }
	.page-head  { display: flex; align-items: center; justify-content: space-between; }
	.page-title { font-size: 1.1rem; font-weight: 700; color: var(--fg2); text-transform: uppercase; letter-spacing: 0.1em; margin: 0; }

	/* Cards */
	.card { background: var(--bg1, #3c3836); border: 1px solid var(--bg3, #504945); border-radius: 6px; padding: 18px 20px; }
	.card-title {
		font-size: 0.8rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
		color: var(--fg4, #a89984); margin: 0 0 14px; display: flex; align-items: center; gap: 10px;
	}
	.card-title .sub { font-size: 0.7rem; color: var(--fg4); text-transform: none; letter-spacing: 0; }
	.sub-title { font-size: 0.75rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--fg3, #bdae93); margin: 18px 0 8px; }
	.sub-title .sub { font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--fg4); }
	.view-actions { margin-bottom: 6px; }

	/* Search */
	.search-form  { display: flex; gap: 10px; align-items: stretch; }
	.search-input {
		flex: 1; min-width: 0; background: var(--bg, #1d2021); color: var(--fg1);
		border: 1px solid var(--bg3); border-radius: 4px; padding: 9px 14px; font-size: 0.95rem; outline: none;
	}
	.search-input:focus { border-color: var(--bright-blue); }
	.search-btn {
		background: var(--bright-blue, #83a598); color: #1d2021; border: none; border-radius: 4px;
		padding: 9px 24px; font-weight: 700; cursor: pointer; white-space: nowrap; flex-shrink: 0; width: auto;
	}
	.search-btn:disabled { opacity: 0.4; cursor: not-allowed; }
	.hint  { font-size: 0.75rem; color: var(--fg4, #a89984); margin: 8px 0 0; }
	.hint code { background: var(--bg, #1d2021); padding: 1px 5px; border-radius: 3px; }

	/* Buttons */
	.btn-primary {
		flex-shrink: 0; width: auto; padding: 8px 18px; background: var(--bright-blue, #83a598);
		color: #1d2021; border: none; border-radius: 4px; font-weight: 700; font-size: 0.9rem; cursor: pointer; white-space: nowrap;
	}
	.btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
	.btn-detail {
		width: auto; padding: 6px 16px; background: var(--bg2, #504945); color: var(--fg, #ebdbb2);
		border: 1px solid var(--bg3, #665c54); border-radius: 4px; font-size: 0.8rem; cursor: pointer; white-space: nowrap;
	}
	.btn-detail:hover { background: var(--bg3, #665c54); }
	.btn-detail:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-back { margin-left: auto; background: none; border: none; color: var(--fg4, #a89984); cursor: pointer; font-size: 0.9rem; padding: 0; width: auto; }
	.btn-back:hover { color: var(--fg, #ebdbb2); }

	/* Results / record table */
	.gw-table, .result-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
	.gw-table th, .result-table th {
		text-align: left; color: var(--fg4, #a89984); font-weight: 600; padding: 6px 10px;
		border-bottom: 1px solid var(--bg3, #504945); font-size: 0.72rem; letter-spacing: 0.05em; text-transform: uppercase;
	}
	.gw-table td, .result-table td { padding: 8px 10px; border-bottom: 1px solid var(--bg2, #3c3836); vertical-align: top; }
	.ip-cell { font-family: monospace; color: var(--bright-aqua, #8ec07c); }
	.cell-field { color: var(--bright-aqua); white-space: nowrap; width: 220px; }
	.cell-value { color: var(--fg2); word-break: break-word; }
	.mono { font-family: monospace; }

	/* Key/value list */
	.kv { display: grid; grid-template-columns: 160px 1fr; gap: 4px 16px; margin: 6px 0; font-size: 0.85rem; }
	.kv dt { color: var(--fg4, #a89984); }
	.kv dd { margin: 0; color: var(--fg1, #ebdbb2); }

	/* Connect app list */
	.connect-form { display: flex; flex-direction: column; gap: 18px; }
	.app-list { display: flex; flex-direction: column; gap: 6px; }
	.app-item {
		display: flex; align-items: center; gap: 12px; padding: 8px 12px;
		background: var(--bg, #1d2021); border: 1px solid var(--bg3, #504945); border-radius: 4px; cursor: pointer;
	}
	.app-item--on { border-color: var(--bright-aqua, #8ec07c); background: color-mix(in srgb, var(--bright-aqua, #8ec07c) 8%, var(--bg, #1d2021)); }
	.app-name { font-weight: 700; color: var(--fg1, #ebdbb2); font-size: 0.9rem; }
	.app-sum  { font-family: monospace; font-size: 0.8rem; color: var(--fg4, #a89984); }

	/* Field grid */
	.field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 18px; }
	.field { display: flex; flex-direction: column; gap: 6px; }
	/* Standalone fields in the edit form (Applications, Service Key) need breathing room. */
	.card > .field { margin-top: 18px; }
	.field-label { font-size: 0.78rem; font-weight: 600; color: var(--fg4); text-transform: uppercase; letter-spacing: 0.07em; }
	.optional { font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--bg4); }
	.req { color: var(--bright-orange, #fe8019); font-style: normal; }
	.field-input {
		background: var(--bg1, #1d2021); color: var(--fg1); border: 1px solid var(--bg3);
		border-radius: 3px; padding: 9px 12px; font-size: 0.9rem; outline: none; min-width: 0;
	}
	.field-input:focus { border-color: var(--bright-blue); }
	.field-input::placeholder { color: var(--bg4); }
	.field-input:disabled { opacity: 0.5; cursor: not-allowed; }
	.check-input { width: 15px; height: 15px; accent-color: var(--bright-blue); flex-shrink: 0; cursor: inherit; }

	/* Action rows */
	.action-row { display: flex; gap: 10px; align-items: center; }
	.connect-btn {
		background: var(--green, #689d6a); color: var(--fg0, #fbf1c7); border: none; border-radius: 3px;
		padding: 11px 32px; font-size: 1rem; font-weight: 700; cursor: pointer; white-space: nowrap; width: auto;
	}
	.connect-btn:hover:not(:disabled) { background: var(--bright-green, #b8bb26); color: var(--bg-hard); }
	.connect-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.reset-btn {
		background: transparent; color: var(--fg4); border: 1px solid var(--bg3); border-radius: 3px;
		padding: 11px 18px; font-size: 0.9rem; cursor: pointer; width: auto;
	}
	.reset-btn:hover { border-color: var(--fg4); color: var(--fg2); }
	.form-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
	.btn-action {
		width: auto; min-width: 96px; padding: 8px 20px; border-radius: 4px; font-size: 0.85rem; font-weight: 700;
		cursor: pointer; white-space: nowrap; background: var(--bg2, #504945); color: var(--fg, #ebdbb2); border: 1px solid var(--bg3, #665c54);
	}
	.btn-action:hover:not(:disabled) { background: var(--bg3, #665c54); }
	.btn-action--primary { background: var(--bright-blue, #83a598); color: #1d2021; border: none; }
	.btn-action--primary:hover:not(:disabled) { filter: brightness(1.05); }
	.btn-action:disabled { opacity: 0.4; cursor: not-allowed; }
	.open-btn {
		background: var(--yellow, #d79921); color: var(--bg-hard); border: none; border-radius: 3px;
		padding: 8px 18px; font-weight: 700; cursor: pointer; width: auto; margin-left: auto;
	}

	/* Notices */
	.notice       { font-size: 0.85rem; color: var(--fg4, #a89984); margin: 8px 0; }
	.notice--warn { color: var(--bright-orange, #fe8019); }

	/* ── Result banner ───────────────────────────────────────────────────── */
	.result-banner { display: flex; align-items: flex-start; gap: 12px; border-radius: 3px; padding: 14px 18px; font-size: 0.9rem; line-height: 1.5; margin-top: 16px; }
	.result-ok        { background: color-mix(in srgb, var(--green)  15%, var(--bg0)); border: 1px solid var(--green); }
	.result-err       { background: color-mix(in srgb, var(--red)    15%, var(--bg0)); border: 1px solid var(--bright-red); }
	.result-launching { background: color-mix(in srgb, var(--yellow) 12%, var(--bg0)); border: 1px solid var(--yellow); }
	.result-icon { font-size: 1rem; flex-shrink: 0; margin-top: 1px; }
	.result-ok .result-icon { color: var(--bright-green); }
	.result-err .result-icon { color: var(--bright-red); }
	.result-launching .result-icon { color: var(--yellow); }
	.result-body { display: flex; flex-direction: column; gap: 8px; }
	.result-msg { color: var(--fg2); }
	.result-err .result-msg { color: var(--fg1); }
	.result-launching a { color: var(--yellow); }
	.result-launching code { color: var(--yellow); font-family: inherit; }
	.result-buttons { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
	.result-open-btn {
		background: var(--green); color: var(--fg0); border: none; border-radius: 3px; padding: 7px 18px;
		font-size: 0.88rem; font-weight: 600; cursor: pointer; white-space: nowrap; width: auto;
	}
	.result-open-btn:hover { background: var(--bright-green); color: var(--bg-hard); }
	.result-open-btn--guac { background: var(--blue); }
	.result-open-btn--guac:hover { background: var(--bright-blue); color: var(--fg0); }
	.result-open-btn--launch { background: var(--orange); }
	.result-open-btn--launch:hover { background: var(--bright-orange); color: var(--fg0); }

	.probe-warn {
		display: flex; flex-direction: column; gap: 0.4rem; padding: 0.65rem 0.9rem; border-radius: 3px;
		font-size: 0.82rem; line-height: 1.5; background: color-mix(in srgb, var(--orange) 12%, var(--bg0)); border: 1px solid var(--orange); color: var(--fg2);
	}
	.probe-warn strong { color: var(--bright-orange); font-size: 0.84rem; }
	.probe-warn-btns { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 2px; }
	.probe-btn { background: transparent; border: 1px solid var(--bg3); border-radius: 3px; padding: 3px 10px; font-size: 0.78rem; color: var(--fg4); cursor: pointer; }
	.probe-btn-open:hover { color: var(--orange); border-color: var(--orange); }
	.probe-btn-retry:hover { color: var(--aqua); border-color: var(--aqua); }

	/* ── Port rows editor ───────────────────────────────────────────────────── */
	.port-rows { border: 1px solid var(--bg3); border-radius: 3px; overflow: hidden; }
	.port-row-head, .port-row {
		display: grid; grid-template-columns: 130px 130px 110px 48px 48px 32px; align-items: stretch;
	}
	.port-row-head { background: var(--bg1); font-size: 0.72rem; font-weight: 600; color: var(--fg4); text-transform: uppercase; letter-spacing: 0.07em; }
	.port-row-head > span { padding: 7px 10px; }
	.col-center { text-align: center; }
	.port-row { border-top: 1px solid var(--bg2); }
	.pr-input {
		background: transparent; color: var(--fg1); border: none; border-right: 1px solid var(--bg2);
		padding: 9px 10px; font-family: inherit; font-size: 0.9rem; outline: none; width: 100%; min-width: 0;
	}
	.pr-input:focus { background: var(--bg1); box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--bright-blue) 30%, transparent); position: relative; z-index: 1; }
	.pr-input::placeholder { color: var(--bg4); }
	.pr-select {
		appearance: none;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath fill='%237c6f64' d='M6 8 0 0h12z'/%3E%3C/svg%3E");
		background-repeat: no-repeat; background-position: right 8px center; padding-right: 28px; cursor: pointer;
	}
	.pr-select option { background: var(--bg1); }
	.pr-check { display: flex; justify-content: center; align-items: center; border-right: 1px solid var(--bg2); cursor: pointer; }
	.pr-check:has(.check-input:disabled) { opacity: 0.5; cursor: not-allowed; }
	.path-param-sni:disabled { opacity: 0.4; }
	.path-param-sni-label:has(~ .path-param-sni:disabled) { opacity: 0.4; }
	.pr-remove { background: transparent; color: var(--fg4); border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; font-size: 0.85rem; }
	.pr-remove:hover:not(:disabled) { color: var(--bright-red); }
	.pr-remove:disabled { opacity: 0.25; cursor: not-allowed; }
	.pr-add { display: block; width: 100%; background: transparent; color: var(--bright-blue); border: none; border-top: 1px solid var(--bg2); padding: 8px 14px; font-size: 0.85rem; cursor: pointer; text-align: left; }
	.pr-add:hover:not(:disabled) { background: var(--bg1); color: var(--bright-aqua); }
	.port-row-path { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-top: 1px dashed var(--bg3); background: color-mix(in srgb, var(--bright-blue) 5%, var(--bg0)); }
	.path-param-label { font-size: 0.72rem; font-weight: 600; color: var(--bright-blue); text-transform: uppercase; letter-spacing: 0.06em; white-space: nowrap; }
	.path-param-input { flex: 1; background: var(--bg1); color: var(--fg1); border: 1px solid var(--bg3); border-radius: 3px; padding: 4px 8px; font-family: monospace; font-size: 0.88rem; outline: none; }
	.path-param-input:not(.path-param-sni) { flex: 0 0 180px; }
	.path-param-input:focus { border-color: var(--bright-blue); }
	.path-param-input:disabled { opacity: 0.5; cursor: not-allowed; }
	.port-row-guac { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-top: 1px dashed var(--bg3); background: color-mix(in srgb, var(--bright-aqua) 5%, var(--bg0)); }
	.guac-param-label { font-size: 0.72rem; font-weight: 600; color: var(--bright-aqua); text-transform: uppercase; letter-spacing: 0.06em; white-space: nowrap; }
	.guac-param-input { width: 72px; background: var(--bg1); color: var(--fg1); border: 1px solid var(--bg3); border-radius: 3px; padding: 4px 8px; font-size: 0.88rem; outline: none; }
	.guac-param-input:focus { border-color: var(--bright-aqua); }
	.guac-param-dpi { width: 52px; }
	.guac-param-hint { font-size: 0.75rem; color: var(--bg4); margin-left: 4px; }
	.guac-param-drive { display: flex; align-items: center; gap: 5px; margin-left: auto; font-size: 0.72rem; font-weight: 600; color: var(--bright-aqua); text-transform: uppercase; letter-spacing: 0.06em; white-space: nowrap; cursor: pointer; }
	.guac-param-drive:has(input:disabled) { opacity: 0.4; cursor: not-allowed; }
	.guac-param-record { display: flex; align-items: center; gap: 5px; margin-left: 12px; font-size: 0.72rem; font-weight: 600; color: var(--bright-orange); text-transform: uppercase; letter-spacing: 0.06em; white-space: nowrap; cursor: pointer; }
</style>
