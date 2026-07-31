<script lang="ts">
	// ── Types ─────────────────────────────────────────────────────────────────
	interface Device {
		ip:     string;
		fields: Record<string, string>;
	}

	// ── State ─────────────────────────────────────────────────────────────────
	let query        = $state('');
	let searching    = $state(false);
	let devices      = $state<Device[]>([]);
	let searchError  = $state('');

	// Selected device → recording days
	let selectedIp   = $state('');
	let loadingDays  = $state(false);
	let days         = $state<string[]>([]);
	let daysError    = $state('');

	// Selected day → sessions
	let selectedDay  = $state('');
	let loadingSess  = $state(false);
	let sessions     = $state<string[]>([]);
	let sessError    = $state('');

	// Download state
	let downloading  = $state<Record<string, boolean>>({});

	// ── Device search ─────────────────────────────────────────────────────────
	async function searchDevices(): Promise<void> {
		const q = query.trim();
		if (!q) return;

		searching   = true;
		searchError = '';
		devices     = [];
		selectedIp  = '';
		days        = [];
		selectedDay = '';
		sessions    = [];

		try {
			const res  = await fetch(`/api/administration/devices?q=${encodeURIComponent(q)}`);
			if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
			const body = await res.json();
			devices    = body.devices ?? [];
			if (devices.length === 0) searchError = `No devices found matching "${q}"`;
		} catch (e) {
			searchError = String(e);
		} finally {
			searching = false;
		}
	}

	// ── Recordings for a device ───────────────────────────────────────────────
	async function openDevice(ip: string): Promise<void> {
		selectedIp  = ip;
		selectedDay = '';
		sessions    = [];
		loadingDays = true;
		daysError   = '';
		days        = [];

		try {
			const res  = await fetch(`/api/administration/recordings?ip=${encodeURIComponent(ip)}`);
			if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
			const body = await res.json();
			days       = body.days ?? [];
			if (days.length === 0) daysError = 'No recordings found for this device.';
		} catch (e) {
			daysError = String(e);
		} finally {
			loadingDays = false;
		}
	}

	// ── Sessions for a day ────────────────────────────────────────────────────
	async function openDay(day: string): Promise<void> {
		selectedDay = day;
		sessions    = [];
		loadingSess = true;
		sessError   = '';

		try {
			const res  = await fetch(
				`/api/administration/recordings?ip=${encodeURIComponent(selectedIp)}&day=${day}`
			);
			if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
			const body = await res.json();
			sessions   = body.sessions ?? [];
			if (sessions.length === 0) sessError = 'No sessions recorded on this day.';
		} catch (e) {
			sessError = String(e);
		} finally {
			loadingSess = false;
		}
	}

	// ── Download ZIP ──────────────────────────────────────────────────────────
	async function downloadSession(session: string): Promise<void> {
		downloading = { ...downloading, [session]: true };
		try {
			const res = await fetch(
				`/api/administration/recordings` +
				`?ip=${encodeURIComponent(selectedIp)}` +
				`&day=${selectedDay}` +
				`&session=${encodeURIComponent(session)}`
			);
			if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
			const { url } = await res.json();
			window.open(url, '_blank');
		} catch (e) {
			alert(`Download failed: ${e}`);
		} finally {
			downloading = { ...downloading, [session]: false };
		}
	}

	// ── Helpers ───────────────────────────────────────────────────────────────
	/** Human-readable field name. */
	function label(key: string): string {
		return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
	}

	/** Priority fields shown prominently; rest in a secondary row. */
	const PRIMARY_FIELDS = ['serial', 'product', 'partno', 'country'];
	function primaryFields(d: Device): [string, string][] {
		return PRIMARY_FIELDS
			.map(k => [k, d.fields[k] ?? ''] as [string, string])
			.filter(([, v]) => v !== '');
	}
	function otherFields(d: Device): [string, string][] {
		return Object.entries(d.fields)
			.filter(([k]) => !PRIMARY_FIELDS.includes(k))
			.filter(([, v]) => v !== '');
	}

	/** Format a session base-name timestamp as a readable time. */
	function sessionTime(s: string): string {
		const ms = parseInt(s.split('-')[0]);
		if (isNaN(ms)) return s;
		return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}
</script>

<svelte:head><title>Administration — FleetShell</title></svelte:head>

<div class="page">
	<h1 class="page-title">Administration</h1>

	<!-- ── Device search ──────────────────────────────────────────────────── -->
	<section class="card">
		<h2 class="card-title">Device search</h2>
		<form class="search-row" onsubmit={(e) => { e.preventDefault(); searchDevices(); }}>
			<input
				class="search-input"
				type="text"
				placeholder="IP address, serial number, product name…"
				bind:value={query}
				disabled={searching}
			/>
			<button class="btn-primary" type="submit" disabled={searching || !query.trim()}>
				{searching ? 'Searching…' : 'Search'}
			</button>
		</form>
	</section>

	<!-- ── Search results ─────────────────────────────────────────────────── -->
	{#if searchError}
		<p class="notice notice--warn">{searchError}</p>
	{/if}

	{#if devices.length > 0}
	<section class="card">
		<h2 class="card-title">Results — {devices.length} device{devices.length !== 1 ? 's' : ''}</h2>
		<table class="dev-table">
			<thead>
				<tr>
					<th>IP</th>
					<th>Serial</th>
					<th>Product</th>
					<th>Part&nbsp;#</th>
					<th>Country</th>
					<th>Other</th>
					<th></th>
				</tr>
			</thead>
			<tbody>
				{#each devices as dev}
				<tr class:selected={dev.ip === selectedIp}>
					<td class="ip-cell">{dev.ip}</td>
					{#each PRIMARY_FIELDS as f}
						<td>{dev.fields[f] ?? '—'}</td>
					{/each}
					<td class="other-cell">
						{#each otherFields(dev) as [k, v]}
							<span class="other-kv"><span class="other-key">{label(k)}</span> {v}</span>
						{/each}
					</td>
					<td>
						<button
							class="btn-detail"
							onclick={() => openDevice(dev.ip)}
							disabled={loadingDays && selectedIp === dev.ip}
						>
							{#if loadingDays && selectedIp === dev.ip}
								Loading…
							{:else}
								Recordings
							{/if}
						</button>
					</td>
				</tr>
				{/each}
			</tbody>
		</table>
	</section>
	{/if}

	<!-- ── Recording days for selected device ─────────────────────────────── -->
	{#if selectedIp && !loadingDays}
	<section class="card">
		<h2 class="card-title">
			Recordings — {selectedIp}
			<button class="btn-back" onclick={() => { selectedIp = ''; days = []; }}>✕</button>
		</h2>

		{#if daysError}
			<p class="notice notice--warn">{daysError}</p>
		{:else if days.length === 0}
			<p class="notice">No recordings found.</p>
		{:else}
			<div class="day-grid">
				{#each days as day}
					<button
						class="day-btn"
						class:day-btn--active={day === selectedDay}
						onclick={() => openDay(day)}
					>
						{day}
					</button>
				{/each}
			</div>
		{/if}
	</section>
	{/if}

	<!-- ── Sessions for selected day ──────────────────────────────────────── -->
	{#if selectedDay && !loadingSess}
	<section class="card">
		<h2 class="card-title">
			Sessions on {selectedDay}
			<button class="btn-back" onclick={() => { selectedDay = ''; sessions = []; }}>✕</button>
		</h2>

		{#if sessError}
			<p class="notice notice--warn">{sessError}</p>
		{:else if sessions.length === 0}
			<p class="notice">No sessions recorded on this day.</p>
		{:else}
			<table class="sess-table">
				<thead>
					<tr><th>Session</th><th>Time (UTC)</th><th></th></tr>
				</thead>
				<tbody>
					{#each sessions as sess}
					<tr>
						<td class="sess-id">{sess}</td>
						<td>{sessionTime(sess)}</td>
						<td>
							<button
								class="btn-dl"
								onclick={() => downloadSession(sess)}
								disabled={downloading[sess]}
								title="Download ZIP (video + transcript + subtitles)"
							>
								{downloading[sess] ? '…' : '⬇ ZIP'}
							</button>
						</td>
					</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>
	{/if}
</div>

<style>
	.page       { padding: 24px 28px; max-width: 1100px; }
	.page-title {
		font-size: 1.1rem; font-weight: 700; color: var(--fg2);
		text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 20px;
	}

	/* ── Cards ──────────────────────────────────────────────────────────── */
	.card {
		background   : var(--bg1, #3c3836);
		border       : 1px solid var(--bg3, #504945);
		border-radius: 6px;
		padding      : 18px 20px;
		margin-bottom: 18px;
	}
	.card-title {
		font-size: 0.8rem; font-weight: 700; letter-spacing: 0.08em;
		text-transform: uppercase; color: var(--fg4, #a89984);
		margin: 0 0 14px; display: flex; align-items: center; gap: 10px;
	}

	/* ── Search ─────────────────────────────────────────────────────────── */
	.search-row  { display: flex; gap: 10px; align-items: center; }
	.search-input {
		flex: 1; min-width: 0;
		padding: 8px 12px; background: var(--bg, #1d2021);
		border: 1px solid var(--bg3, #504945); border-radius: 4px;
		color: var(--fg, #ebdbb2); font-size: 0.9rem;
	}
	/* Override app.css width:100% defaults that break the flex row. */
	.search-row :global(input),
	.search-row :global(button) { width: auto; }

	/* ── Buttons ────────────────────────────────────────────────────────── */
	.btn-primary {
		flex-shrink: 0; padding: 8px 20px;
		background: var(--bright-blue, #83a598);
		color: #1d2021; border: none; border-radius: 4px;
		font-weight: 700; font-size: 0.9rem; cursor: pointer; white-space: nowrap;
	}
	.btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
	.btn-detail {
		padding: 5px 14px; background: var(--bg2, #504945);
		color: var(--fg, #ebdbb2); border: 1px solid var(--bg3, #665c54);
		border-radius: 4px; font-size: 0.8rem; cursor: pointer; white-space: nowrap;
	}
	.btn-detail:hover   { background: var(--bg3, #665c54); }
	.btn-detail:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-dl {
		padding: 4px 12px; background: var(--bright-aqua, #8ec07c);
		color: #1d2021; border: none; border-radius: 4px;
		font-size: 0.8rem; font-weight: 700; cursor: pointer;
	}
	.btn-dl:disabled { opacity: 0.4; cursor: not-allowed; }
	.btn-back {
		margin-left: auto; background: none; border: none;
		color: var(--fg4, #a89984); cursor: pointer; font-size: 0.9rem; padding: 0;
	}
	.btn-back:hover { color: var(--fg, #ebdbb2); }

	/* ── Device table ───────────────────────────────────────────────────── */
	.dev-table  { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
	.dev-table th {
		text-align: left; color: var(--fg4, #a89984); font-weight: 600;
		padding: 6px 10px; border-bottom: 1px solid var(--bg3, #504945);
		font-size: 0.75rem; letter-spacing: 0.06em; text-transform: uppercase;
	}
	.dev-table td   { padding: 8px 10px; border-bottom: 1px solid var(--bg2, #3c3836); }
	.dev-table tr.selected td { background: var(--bg2, #3c3836); }
	.ip-cell    { font-family: monospace; color: var(--bright-aqua, #8ec07c); }
	.other-cell { font-size: 0.78rem; }
	.other-kv   { display: inline-block; margin-right: 12px; }
	.other-key  { color: var(--fg4, #a89984); }

	/* ── Day grid ───────────────────────────────────────────────────────── */
	.day-grid   { display: flex; flex-wrap: wrap; gap: 8px; }
	.day-btn {
		padding: 7px 16px; background: var(--bg2, #504945);
		color: var(--fg, #ebdbb2); border: 1px solid var(--bg3, #665c54);
		border-radius: 4px; font-size: 0.85rem; cursor: pointer;
	}
	.day-btn:hover        { background: var(--bg3, #665c54); }
	.day-btn--active      { border-color: var(--bright-blue, #83a598); color: var(--bright-blue, #83a598); }

	/* ── Session table ──────────────────────────────────────────────────── */
	.sess-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
	.sess-table th {
		text-align: left; color: var(--fg4, #a89984); font-weight: 600;
		padding: 6px 10px; border-bottom: 1px solid var(--bg3, #504945);
		font-size: 0.75rem; letter-spacing: 0.06em; text-transform: uppercase;
	}
	.sess-table td { padding: 8px 10px; border-bottom: 1px solid var(--bg2, #3c3836); }
	.sess-id    { font-family: monospace; font-size: 0.8rem; color: var(--fg3, #bdae93); }

	/* ── Notices ────────────────────────────────────────────────────────── */
	.notice       { font-size: 0.85rem; color: var(--fg4, #a89984); margin: 4px 0; }
	.notice--warn { color: var(--bright-orange, #fe8019); }
</style>
