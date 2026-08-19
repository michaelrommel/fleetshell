<script lang="ts">
	import { base } from '$app/paths';
	import { page as pageState } from '$app/state';
	import { goto } from '$app/navigation';
	import { enhance } from '$app/forms';
	import SplitPane from '$lib/components/SplitPane.svelte';
	import EntityPicker from '$lib/components/EntityPicker.svelte';
	import ContractsChips from '$lib/components/ContractsChips.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import { CLIENT_API_BASE } from '$lib/client-api';
	import { searchHotkey } from '$lib/searchHotkey';
	import { toastEnhance } from '$lib/toast.svelte';

	let { data, form } = $props();
	let confirmDelete = $state(false);

	// local search box seeded from the URL; submitted via the form (stage 1).
	// Count (approach A): carried in the URL while paging (data.total is a number);
	// when the filter changes (data.total === null) the client fetches it once.
	let fetchedCount = $state<number | null>(null);
	let countLoading = $state(false);
	let countMs = $state<number | null>(null);
	let countCached = $state(false);
	const effectiveTotal = $derived(data.total ?? fetchedCount);
	$effect(() => {
		const qq = data.q, mm = data.mode;
		if (data.total !== null) { fetchedCount = null; countLoading = false; countMs = null; return; }
		countLoading = true; fetchedCount = null; countMs = null;
		const p = new URLSearchParams({ q: qq });
		if (mm === 'all') p.set('mode', 'all');
		fetch(`${base}/devices/count?${p}`)
			.then((r) => (r.ok ? r.json() : { total: null }))
			.then((j) => { fetchedCount = j.total ?? null; countMs = j.ms ?? null; countCached = !!j.cached; countLoading = false; })
			.catch(() => { countLoading = false; });
	});
	function pageLink(dir: 'prev' | 'next'): string {
		const ch: Record<string, string | null> = dir === 'next'
			? { after: data.nextCursor, before: null, page: String(data.page + 1) }
			: { before: data.prevCursor, after: null, page: String(Math.max(1, data.page - 1)) };
		if (effectiveTotal !== null) ch.n = String(effectiveTotal);
		return withParams(ch);
	}

	function withParams(changes: Record<string, string | null>): string {
		const u = new URLSearchParams(pageState.url.searchParams);
		for (const [k, v] of Object.entries(changes)) v === null ? u.delete(k) : u.set(k, v);
		return `${base}/devices?${u}`;
	}
	const selHref = (id: string) => withParams({ sel: id, new: null });
	const newHref = $derived(withParams({ new: '1', sel: null }));
	const cancelHref = $derived(withParams({ new: null, sel: null }));

	// The current LIST state (filter / mode / pagination), minus the detail-panel
	// params. Carried through Save/Delete as a hidden field so the redirect can
	// restore the left-hand filter instead of resetting it.
	const listQs = $derived.by(() => {
		const u = new URLSearchParams(pageState.url.searchParams);
		u.delete('sel'); u.delete('tab'); u.delete('new');
		return u.toString();
	});

	// Detail-panel tabs (Connect is the daily driver, so it is the default).
	// 'recordings' is only reachable when the two-grant gate passed (data.canRecordings).
	const TABS = ['connect', 'files', 'recordings', 'manage'] as const;
	const tab = $derived.by(() => {
		const t = pageState.url.searchParams.get('tab');
		return (TABS as readonly string[]).includes(t ?? '') ? (t as string) : 'connect';
	});
	const tabHref = (t: string) => withParams({ tab: t });
	function setMode(m: string) { return withParams({ mode: m, after: null, before: null, page: null, sel: null }); }
	let searchInput: HTMLInputElement;
	let searching = $state(false);
	async function doSearch() {
		searching = true;
		try {
			await goto(withParams({ q: searchInput.value.trim() || null, after: null, before: null, page: null, n: null }), { keepFocus: true, noScroll: true });
		} finally {
			searching = false;
		}
	}
	function clearSearch() {
		searchInput.value = ''; searchInput.focus();
		goto(withParams({ q: null, after: null, before: null, page: null, n: null }), { keepFocus: true, noScroll: true });
	}

	const canEdit = $derived(data.isAdmin);
	const d = $derived(data.detail as Record<string, string | null> | null);
	type App = { name: string; application: string; ports: string; guac: boolean; e2ecrypt: boolean; sni: string; path: string; drive: boolean; record: boolean; width?: number; height?: number; dpi?: number };
	const apps = $derived((data.detail?.apps ?? []) as App[]);

	// ---- Recordings browser (lazy; gated by data.canRecordings) ---------------
	// S3 tree device -> day -> session; each level fetched on demand from
	// /api/devices/recordings (which re-checks both grants on every call).
	type RecSession = { session: string; sizeBytes: number; lastModified: string | null };
	let recDays = $state<string[]>([]);
	let recDay = $state<string | null>(null);
	let recSessions = $state<RecSession[]>([]);
	let recState = $state<'idle' | 'loading-days' | 'loading-sessions' | 'ready' | 'error'>('idle');
	let recError = $state('');
	let recBusy = $state('');           // session base being downloaded
	let recLoadedFor = '';              // device id whose days are loaded

	function fmtSize(n: number): string {
		if (!n) return '';
		const u = ['B', 'KB', 'MB', 'GB'];
		let i = 0, v = n;
		while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
		return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
	}

	async function loadRecDays() {
		if (!d?.id) return;
		recState = 'loading-days';
		recError = ''; recDay = null; recSessions = [];
		try {
			const r = await fetch(`${base}/api/devices/recordings?device=${encodeURIComponent(d.id)}`);
			if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `HTTP ${r.status}`);
			recDays = (await r.json()).days ?? [];
			recLoadedFor = d.id;
			recState = 'ready';
		} catch (e) {
			recError = e instanceof Error ? e.message : String(e);
			recState = 'error';
		}
	}

	async function openRecDay(day: string) {
		if (!d?.id) return;
		recDay = day; recState = 'loading-sessions'; recError = ''; recSessions = [];
		try {
			const r = await fetch(`${base}/api/devices/recordings?device=${encodeURIComponent(d.id)}&day=${encodeURIComponent(day)}`);
			if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `HTTP ${r.status}`);
			recSessions = (await r.json()).sessions ?? [];
			recState = 'ready';
		} catch (e) {
			recError = e instanceof Error ? e.message : String(e);
			recState = 'error';
		}
	}

	async function downloadRec(session: string) {
		if (!d?.id || !recDay) return;
		recBusy = session;
		try {
			const r = await fetch(`${base}/api/devices/recordings?device=${encodeURIComponent(d.id)}&day=${encodeURIComponent(recDay)}&session=${encodeURIComponent(session)}`);
			if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `HTTP ${r.status}`);
			const { url } = await r.json();
			if (url) window.location.href = url;
		} catch (e) {
			recError = e instanceof Error ? e.message : String(e);
		} finally {
			recBusy = '';
		}
	}

	// Auto-load the day list when the tab opens or the device changes.
	$effect(() => {
		if (tab === 'recordings' && data.canRecordings && d?.id && recLoadedFor !== d.id) {
			void loadRecDays();
		}
	});

	// ---- Connect workflow -----------------------------------------------------
	// Selectable copy of the inherited apps; target + gateway are resolved
	// server-side by /api/tunnel/sign (never dictated by the browser).
	type PortRow = App & { selected: boolean };
	let portRows = $state<PortRow[]>([]);
	let username = $state('');
	let password = $state('');
	// NAT-mode context + global-uniqueness probe for the left IP (Manage tab).
	let gwNatMode = $state<string | null>(null);
	let leftIp = $state('');
	let ipInUse = $state(false);
	let ipCheckSeq = 0;
	let ipCheckTimer: ReturnType<typeof setTimeout> | undefined;
	async function checkIpUnique() {
		const ip = leftIp.trim();
		const seq = ++ipCheckSeq;
		if (!ip) { ipInUse = false; return; }
		try {
			const p = new URLSearchParams({ ip });
			if (d?.id) p.set('exclude', d.id);
			const res = await fetch(`${base}/api/devices/ip-in-use?${p}`);
			const j = await res.json();
			if (seq === ipCheckSeq) ipInUse = !!j.inUse;
		} catch { /* ignore transient errors */ }
	}
	function onLeftIpInput(e: Event) {
		leftIp = (e.target as HTMLInputElement).value;
		clearTimeout(ipCheckTimer);
		ipCheckTimer = setTimeout(checkIpUnique, 350);
	}
	let lastDeviceId = '';
	$effect(() => {
		const id = d?.id ?? '';
		if (id === lastDeviceId) return;
		lastDeviceId = id;
		portRows = apps.map((a) => ({ ...a, selected: false }));
		username = '';
		password = '';
		gwNatMode = (d?.gateway_nat_mode as string | null) ?? null;
		leftIp = d?.ip_address ?? '';
		ipInUse = false;
		checkIpUnique();
		resetConnect();
	});

	const guacApplicable = (r: PortRow) => ['rdp', 'vnc', 'ssh'].includes(r.application);
	const selectedRows = () => portRows.filter((r) => r.selected);
	const selectedCount = $derived(portRows.filter((r) => r.selected).length);
	const needsCreds = $derived(portRows.some((r) => r.selected && (r.guac || (r.application === 'ssh' && !r.e2ecrypt))));
	// No Tunnel Gateway on the device -> connections cannot be signed; block them.
	const hasTunnelGw = $derived(!!(d?.gateway_tunnel && String(d.gateway_tunnel).trim()));

	function appSummary(a: PortRow): string {
		const bits = [a.application.toUpperCase(), a.ports || '?'];
		if (a.guac) bits.push('guac');
		if (a.e2ecrypt) bits.push('e2e');
		if (a.record) bits.push('rec');
		if (a.drive) bits.push('drive');
		return bits.join(' \u00b7 ');
	}

	type ConnectState = 'idle' | 'signing' | 'connecting' | 'launching' | 'done' | 'error';
	let connectState = $state<ConnectState>('idle');
	let connectMsg = $state('');
	let connectUrls = $state<string[]>([]);
	let connectedToken = $state<string | null>(null);
	let connectedBindIp = $state('');
	let connectedRows = $state<PortRow[]>([]);
	let connectedTarget = $state('');
	let connectedGateway = $state('');
	type PortRemap = { requested: number; actual: number; reason?: string };
	let connectRemaps = $state<PortRemap[]>([]);
	const busy = $derived(connectState === 'signing' || connectState === 'connecting');

	type ProbeState = 'idle' | 'checking' | 'unreachable';
	let probeState = $state<ProbeState>('idle');
	let probeMsg = $state('');

	const actualPort = (requested: number) => connectRemaps.find((r) => r.requested === requested)?.actual ?? requested;
	const requestedPort = (actual: number) => connectRemaps.find((r) => r.actual === actual)?.requested ?? actual;
	const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

	function firstPort(spec: string): number {
		const n = parseInt((spec.split(',')[0] ?? '').trim().split('-')[0]);
		return isNaN(n) ? 0 : n;
	}
	function portFromUrl(url: string): number {
		try {
			const u = new URL(url);
			if (u.port) return parseInt(u.port);
			return u.protocol === 'https:' ? 443 : 80;
		} catch {
			return 0;
		}
	}
	function rowForPort(port: number, rows: PortRow[]): PortRow | undefined {
		return rows.find((r) =>
			r.ports.split(',').some((t) => {
				t = t.trim();
				if (t.includes('-')) {
					const [lo, hi] = t.split('-').map((n) => parseInt(n));
					return port >= lo && port <= hi;
				}
				return parseInt(t) === port;
			}),
		);
	}

	interface ResultButton {
		label: string;
		kind: 'url' | 'guac' | 'launch';
		url: string;
		app: string;
		port: number;
		targetPort: number;
		record?: boolean;
	}

	const resultButtons = $derived.by<ResultButton[]>(() => {
		if (connectState !== 'done') return [];
		const buttons: ResultButton[] = [];
		for (const url of connectUrls) {
			if (url.startsWith('wss://') || url.startsWith('ws://')) {
				if (url.includes('/ssh-ws')) {
					const row = connectedRows.find((r) => r.application === 'ssh' && !r.guac);
					if (!row) continue;
					const tp = firstPort(row.ports);
					buttons.push({ label: 'Open SSH Session', kind: 'guac', url, app: 'ssh', port: tp, targetPort: tp });
				} else {
					const row = connectedRows.find((r) => r.guac && guacApplicable(r));
					if (!row) continue;
					const tp = firstPort(row.ports);
					buttons.push({ label: `Open ${row.application.toUpperCase()} Session`, kind: 'guac', url, app: row.application, port: tp, targetPort: tp, record: row.record });
				}
			} else {
				const port = portFromUrl(url);
				const reqPort = requestedPort(port);
				const row = rowForPort(reqPort, connectedRows);
				if (!row) continue;
				const label = port !== reqPort ? `${row.application.toUpperCase()} :${port} (was :${reqPort})` : `${row.application.toUpperCase()} :${port}`;
				buttons.push({ label, kind: 'url', url, app: row.application, port, targetPort: reqPort });
			}
		}
		const hasSshWs = connectUrls.some((u) => u.includes('/ssh-ws'));
		for (const row of connectedRows) {
			if (row.guac || !guacApplicable(row)) continue;
			if (row.application === 'ssh' && hasSshWs) continue;
			const reqPort = firstPort(row.ports);
			if (!reqPort) continue;
			const port = actualPort(reqPort);
			const label = port !== reqPort ? `Open ${row.application.toUpperCase()} :${port} (was :${reqPort})` : `Open ${row.application.toUpperCase()} :${port}`;
			buttons.push({ label, kind: 'launch', url: '', app: row.application, port, targetPort: reqPort });
		}
		return buttons;
	});

	function tunnelBody(token: string): string {
		const rows = selectedRows();
		const guacRow = rows.find((r) => r.guac && guacApplicable(r));
		const sshRow = rows.find((r) => r.application === 'ssh' && !r.guac);
		const dimRow = guacRow ?? sshRow;
		return JSON.stringify({
			target: connectedTarget,
			token,
			gateway: connectedGateway,
			username: username || undefined,
			password: password || undefined,
			width: dimRow?.width ?? undefined,
			height: dimRow?.height ?? undefined,
			dpi: dimRow?.dpi ?? undefined,
			enable_drive: (guacRow?.drive && guacRow?.application === 'rdp') || undefined,
			enable_record: guacRow?.record || undefined,
			port_rows: rows.map((r) => ({
				ports: r.ports,
				application: r.application,
				guac: r.guac || undefined,
				e2ecrypt: !r.guac && r.e2ecrypt ? true : undefined,
				sni: r.sni || undefined,
				path: r.path && r.path !== '/' ? r.path : undefined,
			})),
		});
	}

	async function executeItem(btn: ResultButton): Promise<void> {
		if (btn.kind === 'guac') {
			const proto = btn.url.includes('/ssh-ws') ? '&proto=ssh' : '';
			const rec = !btn.url.includes('/ssh-ws') && btn.record ? '&record=1' : '';
			window.open(`${base}/session?ws=${encodeURIComponent(btn.url)}${proto}${rec}`, '_blank');
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

	let probeBtnLabel = $state<string | null>(null);
	async function openItem(btn: ResultButton): Promise<void> {
		if (!connectedToken) { await executeItem(btn); return; }
		probeState = 'checking'; probeMsg = ''; probeBtnLabel = btn.label;
		try {
			const res = await fetch(`${CLIENT_API_BASE}/api/probe`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ target: connectedTarget, port: btn.targetPort, gateway: connectedGateway, token: connectedToken }),
				signal: AbortSignal.timeout(7_000),
			});
			if (!res.ok) { await executeItem(btn); probeState = 'idle'; probeBtnLabel = null; return; }
			const data = await res.json();
			if (data.reachable) { await executeItem(btn); probeState = 'idle'; probeBtnLabel = null; }
			else { probeMsg = data.message ?? 'Target device did not respond.'; probeState = 'unreachable'; }
		} catch {
			await executeItem(btn); probeState = 'idle'; probeBtnLabel = null;
		}
	}

	async function onConnect(e: Event): Promise<void> {
		e.preventDefault();
		if (!hasTunnelGw) {
			connectState = 'error';
			connectMsg = 'This device has no Tunnel Gateway configured.';
			return;
		}
		if (selectedRows().length === 0) {
			connectState = 'error';
			connectMsg = 'Select at least one application to connect.';
			return;
		}
		await doConnect();
	}

	async function doConnect(): Promise<void> {
		connectState = 'signing';
		connectMsg = '';
		connectUrls = [];
		const rows = selectedRows();
		const allPorts = rows.map((r) => r.ports).filter(Boolean).join(',');
		const record = rows.find((r) => r.guac && guacApplicable(r))?.record ?? false;

		let token: string;
		try {
			const res = await fetch(`${base}/api/tunnel/sign`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ deviceId: d?.id, ports: allPorts, record }),
			});
			if (!res.ok) {
				if (res.status === 401) { window.location.href = `${base}/login`; return; }
				throw new Error(`Sign failed (${res.status}): ${await res.text()}`);
			}
			const signed = await res.json();
			token = signed.token;
			connectedTarget = signed.target;
			connectedGateway = signed.gateway;
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
			connectUrls = Array.isArray(body.urls) ? body.urls : [];
			connectedBindIp = body.bind_ip ?? '';
			connectedRows = rows.map((r) => ({ ...r }));
			connectedToken = token;
			connectRemaps = Array.isArray(body.remaps) ? body.remaps : [];
			probeState = 'idle';
			const portList = (body.ports ?? []).join(', ');
			connectMsg = connectedBindIp
				? `Tunnel open via ${connectedGateway} \u00b7 slot ${connectedBindIp} \u00b7 port(s): ${portList}`
				: `Tunnel open via ${connectedGateway} \u00b7 port(s): ${portList}`;
			connectState = 'done';
		} catch (err) {
			if (err instanceof TypeError) { await launchViaDeepLink(token); }
			else { connectState = 'error'; connectMsg = String(err); }
		}
	}

	function resetConnect(): void {
		connectState = 'idle'; connectMsg = ''; connectUrls = [];
		connectedToken = null; connectedBindIp = ''; connectedRows = [];
		connectedTarget = ''; connectedGateway = ''; connectRemaps = [];
		probeState = 'idle'; probeMsg = ''; probeBtnLabel = null;
	}

	async function launchViaDeepLink(token: string): Promise<void> {
		const rows = selectedRows();
		const envelope = {
			type: 'tunnel',
			payload: {
				target: connectedTarget, token, gateway: connectedGateway,
				username: username || undefined,
				password: password || undefined,
				port_rows: rows.map((r) => ({
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
					connectUrls = Array.isArray(body.urls) ? body.urls : [];
					connectedRows = rows.map((r) => ({ ...r }));
					connectedBindIp = body.bind_ip ?? '';
					connectRemaps = Array.isArray(body.remaps) ? body.remaps : [];
					connectMsg = `Gateway tunnel open on port(s): ${(body.ports ?? []).join(', ')}`;
					connectState = 'done';
					connectedToken = token;
					probeState = 'idle';
					return;
				}
				connectState = 'error';
				connectMsg = `Client returned ${res.status}: ${await res.text()}`;
				return;
			} catch { /* keep polling */ }
		}
		connectState = 'launching';
	}
</script>

<SplitPane storageKey="devices" defaultLeft={52} overlay overlayActive={!!(data.sel || data.isNew)} closeHref={cancelHref}>
	{#snippet left()}
		<div class="col-head">
			<h2>Devices <span class="count">{data.total}</span></h2>
			<div class="head-actions">
				{#if data.isAdmin}
					<div class="modes">
						<a class:active={data.mode === 'scope'} href={setMode('scope')}>My scope</a>
						<a class:active={data.mode === 'all'} href={setMode('all')}>All devices</a>
					</div>
					<a class="new-btn" href={newHref}>+ New</a>
				{/if}
			</div>
		</div>

		<form method="GET" action={`${base}/devices`} class="searchbar" class:searching onsubmit={(e) => { e.preventDefault(); doSearch(); }}>
			{#if data.mode === 'all'}<input type="hidden" name="mode" value="all" />{/if}
			<div class="search-wrap">
				<input name="q" value={data.q} bind:this={searchInput} use:searchHotkey placeholder="serial / functional location / IP  ·  sn: fl: ip: tid: c: city: hosp:" autocomplete="off" spellcheck="false" />
				{#if searching}<span class="search-spin" aria-label="Searching" role="status"></span>{:else if data.q}<button type="button" class="in-clear" onclick={clearSearch} aria-label="Clear search">✕</button>{/if}
			</div>
			<button type="submit">Search</button>
		</form>

		<div class="card list">
			<table>
				<thead>
					<tr><th>serial / part no</th><th>func. loc.</th><th>model / product</th><th>IP</th><th>hospital / city</th></tr>
				</thead>
				<tbody>
					{#each data.devices as dev (dev.id)}
						<tr class:sel={dev.id === data.sel} onclick={() => goto(selHref(dev.id), { keepFocus: true, noScroll: true })}>
							<td class="mono"><div>{dev.serial ?? ''}</div>{#if dev.partno}<div class="sub">{dev.partno}</div>{/if}</td>
							<td class="mono">{dev.functional_location ?? ''}</td>
							<td><div class="model-cell">{dev.model_name ?? ''}</div>{#if dev.product_name}<div class="sub">{dev.product_name}</div>{/if}</td>
							<td class="mono">{dev.ip_address ?? ''}</td>
							<td><div>{dev.customer_name ?? dev.hospital_name ?? ''}</div>{#if dev.city}<div class="sub">{dev.city}</div>{/if}</td>
						</tr>
					{:else}
						<tr><td colspan="5" class="empty">No devices{data.q ? ' match' : ' in scope'}.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>

		<div class="pager">
			<a class="pg" class:disabled={!data.hasPrev} href={data.hasPrev ? pageLink('prev') : '#'}>‹ Prev</a>
			<span class="range">
				{data.from}–{data.to} of
				{#if effectiveTotal !== null}{effectiveTotal.toLocaleString()}{:else}<span class="spin" title="counting…">⟳</span>{/if}
			</span>
			<span class="perf" title="query timings (• = served from cache)">
				<span class:cached={data.listCached}>list {data.listMs}ms{#if data.listCached}•{/if}</span>
				{#if countMs !== null}<span class:cached={countCached}>count {countMs}ms{#if countCached}•{/if}</span>{/if}
			</span>
			<a class="pg" class:disabled={!data.hasNext} href={data.hasNext ? pageLink('next') : '#'}>Next ›</a>
		</div>
	{/snippet}

	{#snippet right()}
		{#if form?.error}<p class="error">{form.error}</p>{/if}

		{#if data.isNew}
			<div class="card detail">
				<h3>New device</h3>
				<form method="POST" action="?/createDevice" use:enhance={toastEnhance('Device created')}>
					{@render fields(null, true)}
					<div class="actions-bar">
						<a class="act-cancel" href={cancelHref}>Cancel</a>
						<button type="submit" class="act-primary">Create device</button>
					</div>
				</form>
			</div>
		{:else if d}
			<div class="card detail">
				<div class="dhead">
					<h3>{d.serial || '(no serial)'}</h3>
					<span class="model">{d.model_name ?? ''}</span>
				</div>
				<p class="path">{d.modality_name ?? '?'} / {d.product_name ?? '?'} / {d.model_name ?? '?'}</p>

				<div class="tabs" role="tablist">
					<a role="tab" aria-selected={tab === 'connect'} class:active={tab === 'connect'} href={tabHref('connect')}>Connect</a>
					<a role="tab" aria-selected={tab === 'files'} class:active={tab === 'files'} href={tabHref('files')}>Files</a>
					{#if data.canRecordings}
						<a role="tab" aria-selected={tab === 'recordings'} class:active={tab === 'recordings'} href={tabHref('recordings')}>Recordings</a>
					{/if}
					<a role="tab" aria-selected={tab === 'manage'} class:active={tab === 'manage'} href={tabHref('manage')}>Manage</a>
				</div>

				{#if tab === 'connect'}
					{#if apps.length === 0}
						<p class="muted">No applications defined on this device's model.</p>
					{:else}
						{#if !hasTunnelGw}
							<p class="warn-box">⚠ No <strong>Tunnel Gateway</strong> is set. Connections are blocked until one is configured on the gateway{#if d?.gateway_id} {' '}<a href={`${base}/gateways?sel=${d.gateway_id}`}>{d.gateway_name ?? 'this gateway'}</a>.{:else}. Assign an IPsec gateway in the <a href={tabHref('manage')}>Manage</a> tab first.{/if}</p>
						{/if}
						<form class="connect-form" onsubmit={onConnect}>
							<div class="capps">
								{#each portRows as row (row.name + row.application + row.ports)}
									<label class="capp" class:on={row.selected}>
										<input type="checkbox" bind:checked={row.selected} disabled={busy} />
										<span class="capp-name">{row.name || row.application.toUpperCase()}</span>
										<span class="capp-sum">{appSummary(row)}</span>
									</label>
								{/each}
							</div>

							{#if needsCreds}
								<div class="cgrid">
									<label>Username <span class="opt">(optional)</span>
										<input type="text" bind:value={username} placeholder="administrator" autocomplete="off" spellcheck="false" disabled={busy} />
									</label>
									<label>Password <span class="opt">(optional)</span>
										<input type="password" bind:value={password} placeholder="••••••••" autocomplete="current-password" disabled={busy} />
									</label>
								</div>
							{/if}

							<div class="crow">
								<button type="submit" class="act-primary" disabled={busy || selectedCount === 0 || !hasTunnelGw}>
									{#if connectState === 'signing'}Signing token…
									{:else if connectState === 'connecting'}Connecting…
									{:else}Connect{selectedCount > 0 ? ` (${selectedCount})` : ''}{/if}
								</button>
								{#if connectState === 'done' || connectState === 'error' || connectState === 'launching'}
									<button type="button" class="act-cancel" onclick={resetConnect}>Dismiss</button>
								{/if}
							</div>
						</form>

						{#if connectState === 'error'}
							<p class="error">{connectMsg}</p>
						{:else if connectState === 'launching'}
							<p class="muted">Opening the FleetShell client… if nothing happens, ensure it is installed and running.</p>
						{:else if connectState === 'done'}
							<div class="cbanner">
								<p class="cbanner-msg">{connectMsg}</p>
								{#if resultButtons.length}
									<div class="cbtns">
										{#each resultButtons as btn (btn.label)}
											<button type="button" class="cbtn" class:guac={btn.kind === 'guac'} class:launch={btn.kind === 'launch'}
												disabled={probeState === 'checking' && probeBtnLabel === btn.label}
											onclick={() => openItem(btn)}>
											{#if probeState === 'checking' && probeBtnLabel === btn.label}Checking…{:else}{btn.label}{/if}
										</button>
									{/each}
								</div>
							{/if}
								{#if probeState === 'unreachable'}
									<p class="probe-warn">⚠ Device not reachable · {probeMsg}</p>
								{/if}
							</div>
						{/if}
					{/if}
				{:else if tab === 'files'}
					<p class="muted files-stub">File browser (S3 <span class="mono">/clean/&lt;modality&gt;/&lt;product&gt;/&lt;partno&gt;/&lt;serial&gt;/</span>) is not wired yet.</p>
				{:else if tab === 'recordings'}
					{#if !data.canRecordings}
						<p class="muted">You are not authorized to view recordings for this device.</p>
					{:else}
						<div class="rec">
							<div class="rec-head">
								<p class="muted">Session recordings (PHI-bearing). Access is logged.</p>
								<button type="button" class="rec-refresh" onclick={loadRecDays} disabled={recState === 'loading-days'}>Refresh</button>
							</div>
							{#if recState === 'error'}
								<p class="error">{recError}</p>
							{/if}
							{#if recState === 'loading-days'}
								<p class="muted">Loading recording days…</p>
							{:else}
								<div class="rec-cols">
									<div class="rec-days">
										{#each recDays as day (day)}
											<button type="button" class="rec-day" class:sel={day === recDay} onclick={() => openRecDay(day)}>{day}</button>
										{:else}
											<p class="muted">No recordings found for this device.</p>
										{/each}
									</div>
									<div class="rec-sessions">
										{#if recState === 'loading-sessions'}
											<p class="muted">Loading sessions…</p>
										{:else if recDay}
											{#each recSessions as s (s.session)}
												<div class="rec-session">
													<span class="rec-name">{s.session}</span>
													{#if s.sizeBytes}<span class="rec-size">{fmtSize(s.sizeBytes)}</span>{/if}
													<button type="button" class="rec-dl" onclick={() => downloadRec(s.session)} disabled={recBusy === s.session}>
														{recBusy === s.session ? 'Preparing…' : 'Download ZIP'}
													</button>
												</div>
											{:else}
												<p class="muted">No sessions on {recDay}.</p>
											{/each}
										{:else}
											<p class="muted">Select a day to list its sessions.</p>
										{/if}
									</div>
								</div>
							{/if}
						</div>
					{/if}
				{:else}
					<form method="POST" action="?/updateDevice" use:enhance={toastEnhance('Device saved')}>
						<input type="hidden" name="id" value={d.id} />
						<input type="hidden" name="tab" value="manage" />
						<input type="hidden" name="qs" value={listQs} />
						{#key d.id}
							{@render fields(d, canEdit)}
						{/key}
						{#if canEdit}
							<div class="actions-bar">
								<button type="button" class="act-delete" onclick={() => (confirmDelete = true)}>Delete device</button>
								{#if data.detailMs !== null}
									<span class="perf bar" title="detail query timing (loaded once; tab switches are client-side)">detail {data.detailMs}ms</span>
								{/if}
								<button type="submit" class="act-primary">Save device</button>
							</div>
						{/if}
					</form>
				{/if}
			</div>
		{:else}
			<div class="card placeholder">Select a device, or search.</div>
		{/if}
	{/snippet}
</SplitPane>

{#if d}
	<ConfirmDialog bind:open={confirmDelete} title="Delete device?" message={`Delete "${d.serial || d.id}"? This cannot be undone.`}>
		<form method="POST" action="?/deleteDevice" use:enhance={toastEnhance('Device deleted', () => (confirmDelete = false))}>
			<input type="hidden" name="id" value={d.id} />
			<input type="hidden" name="qs" value={listQs} />
			<button type="submit" class="act-delete">Delete</button>
		</form>
	</ConfirmDialog>
{/if}

{#snippet fields(x: Record<string, string | null> | null, edit: boolean)}
	<div class="grid2">
		<label>Serial<input name="serial" value={x?.serial ?? ''} disabled={!edit} /></label>
		<div class="field">
			<span class="flabel">Product model</span>
			<EntityPicker api="/api/administration/models" name="product_path" idField="path" labelField="display"
				value={x?.product_path ?? null} label={x?.model_name ?? null} disabled={!edit} placeholder="search model..." />
			{#if x?.model_partno}<span class="partno-note">Part no <span class="mono">{x.model_partno}</span></span>{/if}
		</div>
		<label>Functional location<input name="functional_location" value={x?.functional_location ?? ''} disabled={!edit} /></label>
		<label>Technical ident<input name="technical_ident" value={x?.technical_ident ?? ''} disabled={!edit} /></label>
		<label>Host / hardware ID<input name="host_hw_id" value={x?.host_hw_id ?? ''} disabled={!edit} /></label>
		<label>Order number<input name="order_number" value={x?.order_number ?? ''} disabled={!edit} /></label>
		<label>Hospital<input name="hospital_name" value={x?.hospital_name ?? ''} disabled={!edit} /></label>
		<label>Software version<input name="software_version" value={x?.software_version ?? ''} disabled={!edit} /></label>
		<div class="field">
			<span class="flabel">Region</span>
			<EntityPicker api="/api/administration/regions" name="region_path" idField="path" labelField="name"
				value={x?.region_path ?? null} label={x?.region_name ?? null} disabled={!edit} placeholder="search region..." />
		</div>
		<label>City<input name="city" value={x?.city ?? ''} disabled={!edit} /></label>
		<div class="field">
			<span class="flabel">IPsec gateway</span>
			<EntityPicker api="/api/administration/gateways" name="gateway_id" idField="id" labelField="name"
				value={x?.gateway_id ?? null} label={x?.gateway_name ?? null} disabled={!edit}
				placeholder="search gateway..." onPick={(it) => (gwNatMode = (it?.nat_mode ?? null))}>
				{#snippet trailing(gwId)}
					{#if gwId}<a class="gw-jump" href={`${base}/gateways?sel=${gwId}`} title="Open this gateway" aria-label="Open this gateway"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg></a>{/if}
				{/snippet}
			</EntityPicker>
		</div>
		<label>Access requirement
			<select name="access_requirement" value={x?.access_requirement ?? 'open'} disabled={!edit}>
				<option value="open">open</option><option value="device">device</option>
				<option value="customer">customer</option><option value="site">site</option>
			</select>
		</label>
		<label>
			<span class="lbl-chip">IP address{#if ipInUse}<span class="iptag warning" title="This IP is already used on another device (global uniqueness)">WARNING</span>{/if}</span>
			<input name="ip_address" value={x?.ip_address ?? ''} disabled={!edit} oninput={onLeftIpInput} />
		</label>
		<label>
			<span class="lbl-chip">IP (real){#if gwNatMode === 'customer'}<span class="iptag informative">INFORMATIVE</span>{:else if gwNatMode === 'backend'}<span class="iptag translated">TRANSLATED</span>{/if}</span>
			<input name="ip_real" value={x?.ip_real ?? ''} disabled={!edit} />
		</label>
	</div>
	<label class="full">Contact<input name="contact" value={x?.contact ?? ''} disabled={!edit} /></label>
	{#key x?.id ?? 'new'}
		<ContractsChips internalUse={x?.internal_use} dpa={x?.dpa} dmy={x?.dmy} disabled={!edit} />
	{/key}

	<h4>Notifications</h4>
	<div class="checks">
		<label class="chk"><input type="checkbox" name="notify_on_access" checked={!!x?.notify_on_access} disabled={!edit} /> Notify on access</label>
		<label class="chk"><input type="checkbox" name="notify_on_disconnect" checked={!!x?.notify_on_disconnect} disabled={!edit} /> Notify on disconnect</label>
		<label class="chk"><input type="checkbox" name="notification_info_active" checked={!!x?.notification_info_active} disabled={!edit} /> Notification info active</label>
		<label class="chk"><input type="checkbox" name="notify_pseudonymized" checked={!!x?.notify_pseudonymized} disabled={!edit} /> Anonymize (send ID, not username)</label>
	</div>
	<label class="full">Notification address<input name="notification_address" type="email" value={x?.notification_address ?? ''} disabled={!edit} placeholder="ops@example.com" /></label>

	<h4>Operator messages</h4>
	<label class="full">Display before connect<textarea name="display_before_connect" rows="2" disabled={!edit} placeholder="Shown to the operator before a session starts">{x?.display_before_connect ?? ''}</textarea></label>
	<label class="full">Additional info (annotations)<textarea name="additional_info" rows="2" disabled={!edit}>{x?.additional_info ?? ''}</textarea></label>

	<h4>Relations</h4>
	<div class="rel-grid">
		<span class="rlabel">Customer</span>
		<span class="rval" class:unset={!x?.customer_name}>{x?.customer_name ?? 'not assigned'}</span>
		<span class="rlabel">Site</span>
		<span class="rval" class:unset={!x?.site_name}>{x?.site_name ?? 'not assigned'}</span>
		<span class="rel-note">Derived from site membership · manage in <a href={`${base}/customers`}>Customers / Sites</a></span>
	</div>
{/snippet}

<style>
	.col-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.6rem; gap: 0.6rem; flex: none; }
	h2 { font-size: 1rem; margin: 0; }
	.count { color: var(--text-subtle); font-weight: 400; font-size: 0.85rem; }
	.head-actions { display: flex; align-items: center; gap: 0.6rem; }
	.modes { display: flex; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
	.modes a { padding: 0.25rem 0.6rem; font-size: 0.78rem; color: var(--text-muted); text-decoration: none; }
	.modes a.active { background: var(--surface-active); color: var(--text); box-shadow: inset 0 -2px 0 var(--accent); }
	.new-btn { background: var(--accent); color: var(--on-accent); text-decoration: none; border-radius: var(--radius); padding: 0.3rem 0.6rem; font-size: 0.8rem; font-weight: 600; }
	.new-btn:hover { background: var(--accent-hover); }

	.searchbar { display: flex; gap: 0.4rem; margin-bottom: 0.6rem; flex: none; align-items: center; }
	.search-wrap { position: relative; flex: 1; display: flex; }
	.searchbar input { width: 100%; background: var(--bg-app); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.45rem 1.9rem 0.45rem 0.6rem; font: inherit; font-size: 0.85rem; }
	.searchbar input:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	.in-clear { position: absolute; right: 0.35rem; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--text-subtle); cursor: pointer; font-size: 0.8rem; line-height: 1; padding: 0.2rem; border-radius: var(--radius); }
	.in-clear:hover { color: var(--text); }
	.search-spin { position: absolute; right: 0.55rem; top: 50%; width: 0.85rem; height: 0.85rem; margin-top: -0.45rem; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: search-spin 0.6s linear infinite; pointer-events: none; }
	.searchbar.searching input { cursor: progress; }
	@keyframes search-spin { to { transform: rotate(360deg); } }
	.searchbar > button { background: var(--accent); color: var(--on-accent); border: none; border-radius: var(--radius); padding: 0.45rem 0.8rem; font: inherit; font-weight: 600; font-size: 0.83rem; cursor: pointer; }

	.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
	.list { flex: 1; min-height: 0; overflow-y: auto; padding: 0.2rem 0.3rem; }
	table { width: 100%; border-collapse: collapse; }
	th, td { text-align: left; padding: 0.4rem 0.55rem; border-bottom: 1px solid var(--divider); vertical-align: top; }
	th { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-subtle); position: sticky; top: 0; background: var(--surface); }
	td { font-size: 0.83rem; }
	.mono { font-variant-numeric: tabular-nums; }
	.model-cell { line-height: 1.2; }
	.sub { color: var(--text-subtle); font-size: 0.72rem; line-height: 1.2; }
	tbody tr { cursor: pointer; }
	tbody tr:hover td { background: var(--surface-2); }
	tbody tr.sel td { background: var(--surface-active); }
	tbody tr:last-child td { border-bottom: none; }
	.empty { color: var(--text-subtle); text-align: center; padding: 1.4rem; cursor: default; }

	.pager { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; padding: 0.5rem 0.2rem 0; flex: none; }
	.pg { color: var(--accent); text-decoration: none; font-size: 0.82rem; }
	.pg.disabled { color: var(--text-subtle); pointer-events: none; }
	.range { color: var(--text-subtle); font-size: 0.78rem; }
	.perf { display: inline-flex; align-items: center; gap: 0.5rem; color: var(--text-subtle); font-size: 0.7rem; font-variant-numeric: tabular-nums; border: 1px solid var(--border); border-radius: 999px; padding: 0.15rem 0.6rem; }
	.perf .cached { color: var(--accent); }
	.perf.bar { margin-right: auto; }
	.spin { display: inline-block; animation: spin 0.9s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }

	.detail { padding: 0.9rem; }
	.placeholder { padding: 2rem; text-align: center; color: var(--text-subtle); }
	.dhead { display: flex; align-items: baseline; gap: 0.6rem; }
	h3 { font-size: 0.98rem; margin: 0; }
	.model { color: var(--text-muted); font-size: 0.85rem; }
	.path { font-size: 0.76rem; color: var(--text-subtle); margin: 0.2rem 0 0.9rem; }

	.tabs { display: flex; gap: 0.15rem; border-bottom: 1px solid var(--border); margin: 0 0 1rem; }
	.tabs a {
		padding: 0.4rem 0.85rem; font-size: 0.82rem; font-weight: 600; text-decoration: none;
		color: var(--text-muted); border-bottom: 2px solid transparent; margin-bottom: -1px;
	}
	.tabs a:hover { color: var(--text); }
	.tabs a.active { color: var(--text); border-bottom-color: var(--accent); }

	/* Recordings tab */
	.rec { display: flex; flex-direction: column; gap: 0.7rem; }
	.rec-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
	.rec-head .muted { margin: 0; }
	.rec-refresh { background: var(--surface-2); color: var(--text); border: 1px solid var(--border);
		border-radius: var(--radius); padding: 0.3rem 0.7rem; font: inherit; font-size: 0.82rem; cursor: pointer; }
	.rec-refresh:hover:not(:disabled) { background: var(--surface-active); }
	.rec-refresh:disabled { opacity: 0.5; cursor: default; }
	.rec-cols { display: grid; grid-template-columns: 12rem 1fr; gap: 0.9rem; align-items: start; }
	.rec-days { display: flex; flex-direction: column; gap: 0.2rem; max-height: 22rem; overflow-y: auto; }
	.rec-day { text-align: left; background: none; color: var(--text); border: 1px solid transparent;
		border-radius: var(--radius); padding: 0.35rem 0.55rem; font: inherit; font-size: 0.85rem;
		font-variant-numeric: tabular-nums; cursor: pointer; }
	.rec-day:hover { background: var(--surface-2); }
	.rec-day.sel { background: var(--surface-active); box-shadow: inset 2px 0 0 var(--accent); font-weight: 600; }
	.rec-sessions { display: flex; flex-direction: column; gap: 0.35rem; min-width: 0; }
	.rec-session { display: flex; align-items: center; gap: 0.7rem; padding: 0.4rem 0.55rem;
		background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
	.rec-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		font-size: 0.85rem; font-variant-numeric: tabular-nums; }
	.rec-size { flex: none; color: var(--text-muted); font-size: 0.78rem; }
	.rec-dl { flex: none; background: var(--accent); color: var(--accent-fg, #fff); border: none;
		border-radius: var(--radius); padding: 0.3rem 0.7rem; font: inherit; font-size: 0.8rem; cursor: pointer; }
	.rec-dl:hover:not(:disabled) { filter: brightness(1.08); }
	.rec-dl:disabled { opacity: 0.6; cursor: default; }
	.files-stub { padding: 1.5rem 0; }
	h4 { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-subtle); margin: 1.2rem 0 0.5rem; }

	.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem 0.9rem; }
	label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.76rem; color: var(--text-muted); }
	input:not([type='checkbox']), select { background: var(--bg-app); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.4rem 0.55rem; font: inherit; font-size: 0.84rem; }
	input:focus-visible, select:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	input:disabled, select:disabled { color: var(--text-muted); opacity: 0.85; }
	textarea { background: var(--bg-app); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.4rem 0.55rem; font: inherit; font-size: 0.84rem; resize: vertical; }
	textarea:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	textarea:disabled { color: var(--text-muted); opacity: 0.85; }
	.checks { display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem 0.9rem; margin: 0.2rem 0 0.6rem; }
	label.chk { flex-direction: row; align-items: center; gap: 0.45rem; color: var(--text); font-size: 0.82rem; }
	label.chk input { flex: none; width: 15px; height: 15px; }
	label.full { margin-top: 0.6rem; }

	.rel-grid { display: grid; grid-template-columns: 7rem 1fr 7rem 1fr; gap: 0.5rem 0.9rem; align-items: center; }
	.rlabel { align-self: center; font-size: 0.76rem; color: var(--text-muted); }
	.rval { align-self: center; font-size: 0.84rem; color: var(--text); }
	.rval.unset { color: var(--text-subtle); font-style: italic; }
	.rel-note { grid-column: 1 / -1; font-size: 0.72rem; color: var(--text-subtle); margin-bottom: 0.2rem; }
	.rel-note a { color: var(--accent); }
	.partno-note { font-size: 0.72rem; color: var(--text-subtle); }

	/* Connect tab */
	.connect-form { display: flex; flex-direction: column; gap: 0.9rem; }
	.capps { display: flex; flex-direction: column; gap: 0.35rem; }
	.capp { display: grid; grid-template-columns: auto auto 1fr; align-items: center; gap: 0.55rem;
		padding: 0.4rem 0.6rem; border: 1px solid var(--border); border-radius: var(--radius);
		background: var(--surface-2); cursor: pointer; font-size: 0.83rem; }
	.capp.on { border-color: var(--accent); background: var(--surface-active); }
	.capp input { margin: 0; }
	.capp-name { font-weight: 600; color: var(--text); }
	.capp-sum { color: var(--text-subtle); font-size: 0.76rem; justify-self: end; }
	.cgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem 0.9rem; }
	.opt { color: var(--text-subtle); font-weight: 400; }
	.crow { display: flex; align-items: center; gap: 0.6rem; }
	.cbanner { margin-top: 0.9rem; padding: 0.7rem 0.8rem; border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
		border-radius: var(--radius); background: color-mix(in srgb, var(--accent) 8%, transparent); }
	.cbanner-msg { margin: 0 0 0.5rem; font-size: 0.82rem; color: var(--text); }
	.cbtns { display: flex; flex-wrap: wrap; gap: 0.4rem; }
	.cbtn { background: var(--accent); color: var(--on-accent); border: none; border-radius: var(--radius);
		padding: 0.4rem 0.7rem; font: inherit; font-size: 0.8rem; font-weight: 600; cursor: pointer; }
	.cbtn:hover { background: var(--accent-hover); }
	.cbtn.launch { background: var(--surface); color: var(--text); border: 1px solid var(--border); }
	.cbtn:disabled { opacity: 0.6; cursor: default; }
	.probe-warn { margin: 0.5rem 0 0; font-size: 0.8rem; color: var(--danger); }
	.warn-box { margin: 0 0 0.9rem; padding: 0.6rem 0.7rem; font-size: 0.82rem; color: var(--text);
		border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
		background: color-mix(in srgb, var(--danger) 8%, transparent); border-radius: var(--radius); }
	.warn-box a { color: var(--accent); }

	.error { color: var(--danger); font-size: 0.85rem; margin: 0 0 0.8rem; }

	/* Manage tab: field wrapper (label-on-top, matches the plain <label> fields). */
	.field { display: flex; flex-direction: column; gap: 0.25rem; }
	.field .flabel { font-size: 0.76rem; color: var(--text-muted); }
	.gw-jump { flex: none; display: inline-flex; align-items: center; justify-content: center;
		background: none; border: 1px solid var(--border); color: var(--text-muted);
		border-radius: var(--radius); padding: 0.2rem 0.35rem; text-decoration: none; }
	.gw-jump:hover { color: var(--text); border-color: var(--text-subtle); }
	/* IP label rows: field label + a compact status chip on one line. */
	.lbl-chip { display: flex; align-items: center; gap: 0.4rem; min-height: 1.05rem; }
	.iptag { padding: 0.12rem 0.55rem; border-radius: 14px; font-size: 0.64rem; font-weight: 700;
		letter-spacing: 0.04em; font-family: var(--mono, monospace); border: 1px solid var(--border); line-height: 1.25; }
	.iptag.informative { background: var(--bg-app); color: var(--text-muted); }
	.iptag.translated, .iptag.warning { color: #b45309;
		background: color-mix(in srgb, #f59e0b 14%, transparent);
		border-color: color-mix(in srgb, #f59e0b 45%, transparent); }
</style>
