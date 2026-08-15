<!--
	Product-model application list. Adopts the legacy fleetshell-portal port-rows
	editor layout (single inline table: Name | Ports | Application | Guac | E2E |
	x, with conditional Path/SNI and Guac (Width/Height/DPI + Drives/Record)
	sub-rows), adapted to the portal-dev design tokens. Edits a local row array
	and saves the whole list at once to the ?/saveApps action (replace-all).
	Remount via {#key model_id} in the host to reseed when the model changes.
-->
<script lang="ts">
	import { enhance } from '$app/forms';

	type Row = {
		name: string; ports: string; application: string; guac: boolean; e2ecrypt: boolean;
		sni: string; path: string; width: number; height: number; dpi: number; drive: boolean; record: boolean;
	};
	let { productId, apps, canEdit }:
		{ productId: string; apps: Partial<Row>[]; canEdit: boolean } = $props();

	function seed(a: Partial<Row>): Row {
		return {
			name: a.name ?? '', ports: a.ports ?? '', application: a.application ?? 'https',
			guac: a.guac ?? false, e2ecrypt: a.e2ecrypt ?? false, sni: a.sni ?? '', path: a.path ?? '/',
			width: a.width ?? 1920, height: a.height ?? 1080, dpi: a.dpi ?? 96,
			drive: a.drive ?? false, record: a.record ?? false,
		};
	}
	function blank(): Row { return seed({}); }

	let rows = $state<Row[]>(apps.length ? apps.map(seed) : [blank()]);

	function guacApplicable(r: Row) { return r.application === 'rdp' || r.application === 'vnc' || r.application === 'ssh'; }
	function sniEffective(r: Row) {
		if (r.guac) return false;
		return (r.application === 'http' || r.application === 'https' || r.application === 'expert-i') && !r.e2ecrypt;
	}
	function showGuacParams(r: Row) { return r.guac && guacApplicable(r); }
	function showPathParam(r: Row) { return r.application === 'http' || r.application === 'https' || r.application === 'expert-i'; }
	function onAppChange(r: Row) {
		if (guacApplicable(r)) { if (!r.guac && r.application !== 'ssh') r.e2ecrypt = true; }
		else { r.guac = false; r.e2ecrypt = false; }
		if (r.application !== 'rdp') r.drive = false;
		if (!guacApplicable(r)) r.record = false;
	}
	function addRow() { rows = [...rows, blank()]; }
	function removeRow(i: number) { if (rows.length > 1) rows = rows.filter((_, idx) => idx !== i); }

	const appsJson = $derived(JSON.stringify(rows));
</script>

<div class="apps-head">
	<h4>Applications <span class="count">{rows.length}</span></h4>
	<span class="note">Devices with this model inherit these live, unless the device overrides them.</span>
</div>

<form method="POST" action="?/saveApps" use:enhance>
	<input type="hidden" name="product_id" value={productId} />
	<input type="hidden" name="apps" value={appsJson} />

	<div class="port-rows">
		<div class="port-row-head">
			<span>Name</span>
			<span>Ports</span>
			<span>Application</span>
			<span class="col-center">Guac</span>
			<span class="col-center">E2E</span>
			<span></span>
		</div>
		{#each rows as row, i}
			<div class="port-row">
				<input class="pr-input" type="text" placeholder="RDP console" bind:value={row.name} disabled={!canEdit} autocomplete="off" spellcheck="false" />
				<input class="pr-input" type="text" placeholder="443 or 80,8080-8090" bind:value={row.ports} disabled={!canEdit} autocomplete="off" spellcheck="false" />
				<select class="pr-input pr-select" bind:value={row.application} onchange={() => onAppChange(row)} disabled={!canEdit}>
					<option value="https">HTTPS</option>
					<option value="http">HTTP</option>
					<option value="expert-i">Expert-i</option>
					<option value="rdp">RDP</option>
					<option value="vnc">VNC</option>
					<option value="ssh">SSH</option>
				</select>
				<label class="pr-check" title={guacApplicable(row) ? 'Open via Guacamole in a new browser tab' : 'Guacamole not applicable'}>
					<input type="checkbox" class="check-input" bind:checked={row.guac} disabled={!canEdit || !guacApplicable(row)} />
				</label>
				<label class="pr-check" title={row.guac ? 'E2E not applicable - guacd handles the upstream' : guacApplicable(row) ? 'Required - native protocol relayed byte-for-byte' : 'Pass TLS bytes end-to-end'}>
					<input type="checkbox" class="check-input" bind:checked={row.e2ecrypt} disabled={!canEdit || row.guac || (guacApplicable(row) && row.application !== 'ssh')} />
				</label>
				<button type="button" class="pr-remove" onclick={() => removeRow(i)} disabled={!canEdit || rows.length === 1} title="Remove row" aria-label="Remove row">✕</button>
			</div>
			{#if showPathParam(row)}
				<div class="port-row-path">
					<span class="path-param-label">Path</span>
					<input class="path-param-input" type="text" placeholder="/" bind:value={row.path} disabled={!canEdit} autocomplete="off" spellcheck="false" />
					<span class="path-param-label path-param-sni-label">SNI</span>
					<input class="path-param-input path-param-sni" type="text" placeholder="device.example.com" bind:value={row.sni} disabled={!canEdit || !sniEffective(row)} autocomplete="off" spellcheck="false" />
				</div>
			{/if}
			{#if showGuacParams(row)}
				<div class="port-row-guac">
					<span class="guac-param-label">Width</span>
					<input class="guac-param-input" type="number" min="640" max="7680" step="1" bind:value={row.width} disabled={!canEdit} />
					<span class="guac-param-label">Height</span>
					<input class="guac-param-input" type="number" min="480" max="4320" step="1" bind:value={row.height} disabled={!canEdit} />
					<span class="guac-param-label">DPI</span>
					<input class="guac-param-input guac-param-dpi" type="number" min="72" max="288" step="1" bind:value={row.dpi} disabled={!canEdit} />
					<span class="guac-param-hint">px - Guacamole display size</span>
					<label class="guac-param-drive" title={row.application === 'rdp' ? 'Mount a shared drive buffer (RDP only)' : 'Drive sharing is RDP-only'}>
						<input type="checkbox" class="check-input" bind:checked={row.drive} disabled={!canEdit || row.application !== 'rdp'} /> Drives
					</label>
					<label class="guac-param-record" title="Record this session on the gateway">
						<input type="checkbox" class="check-input" bind:checked={row.record} disabled={!canEdit} /> Record
					</label>
				</div>
			{/if}
		{/each}
		{#if canEdit}
			<button type="button" class="pr-add" onclick={addRow}>+ Add application</button>
		{/if}
	</div>

	{#if canEdit}
		<div class="actions-bar"><button type="submit" class="save">Save applications</button></div>
	{/if}
</form>

<style>
	.apps-head { display: flex; align-items: baseline; gap: 0.6rem; margin: 1.3rem 0 0.5rem; flex-wrap: wrap; }
	h4 { font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-subtle); margin: 0; }
	.count { color: var(--text-subtle); font-weight: 400; font-size: 0.8rem; }
	.note { color: var(--text-subtle); font-size: 0.76rem; }

	.port-rows { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
	.port-row-head, .port-row {
		display: grid; grid-template-columns: minmax(120px, 1.4fr) minmax(110px, 1fr) 120px 52px 52px 34px; align-items: stretch;
	}
	.port-row-head { background: var(--surface-2); font-size: 0.68rem; font-weight: 600; color: var(--text-subtle); text-transform: uppercase; letter-spacing: 0.06em; }
	.port-row-head > span { padding: 6px 10px; }
	.col-center { text-align: center; }
	.port-row { border-top: 1px solid var(--border); }
	.pr-input {
		background: transparent; color: var(--text); border: none; border-right: 1px solid var(--border);
		padding: 8px 10px; font: inherit; font-size: 0.86rem; outline: none; width: 100%; min-width: 0;
	}
	.pr-input:focus { background: var(--bg-app); box-shadow: inset 0 0 0 2px var(--focus); position: relative; z-index: 1; }
	.pr-input::placeholder { color: var(--text-subtle); }
	.pr-input:disabled { color: var(--text-muted); }
	.pr-select {
		appearance: none;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath fill='%23888'%20d='M6 8 0 0h12z'/%3E%3C/svg%3E");
		background-repeat: no-repeat; background-position: right 8px center; padding-right: 26px; cursor: pointer;
	}
	.pr-select option { background: var(--surface); color: var(--text); }
	.pr-check { display: flex; justify-content: center; align-items: center; border-right: 1px solid var(--border); cursor: pointer; }
	.pr-check:has(.check-input:disabled) { opacity: 0.5; cursor: not-allowed; }
	.path-param-sni:disabled { opacity: 0.4; }
	.path-param-sni-label:has(~ .path-param-sni:disabled) { opacity: 0.4; }
	.pr-remove { background: transparent; color: var(--text-subtle); border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; font-size: 0.82rem; }
	.pr-remove:hover:not(:disabled) { color: var(--danger); }
	.pr-remove:disabled { opacity: 0.25; cursor: not-allowed; }
	.pr-add { display: block; width: 100%; background: transparent; color: var(--accent); border: none; border-top: 1px solid var(--border); padding: 8px 14px; font-size: 0.83rem; cursor: pointer; text-align: left; }
	.pr-add:hover { background: var(--surface-2); }

	.port-row-path, .port-row-guac { display: flex; align-items: center; gap: 8px; padding: 6px 10px 6px 26px; border-top: 1px dashed var(--border); flex-wrap: wrap; box-shadow: inset 3px 0 0 var(--border); }
	.port-row-path { background: color-mix(in srgb, var(--accent) 6%, transparent); }
	.port-row-guac { background: color-mix(in srgb, var(--accent) 10%, transparent); }
	.path-param-label, .guac-param-label { font-size: 0.68rem; font-weight: 600; color: var(--accent); text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; }
	.path-param-input { flex: 1; background: var(--bg-app); color: var(--text); border: 1px solid var(--border); border-radius: 3px; padding: 4px 8px; font-family: monospace; font-size: 0.84rem; outline: none; }
	.path-param-input:not(.path-param-sni) { flex: 0 0 180px; }
	.path-param-input:focus { border-color: var(--accent); outline: 2px solid var(--focus); outline-offset: 0; }
	.path-param-input:disabled { opacity: 0.5; cursor: not-allowed; }
	.guac-param-input { width: 72px; background: var(--bg-app); color: var(--text); border: 1px solid var(--border); border-radius: 3px; padding: 4px 8px; font-size: 0.84rem; outline: none; }
	.guac-param-input:focus { border-color: var(--accent); }
	.guac-param-dpi { width: 56px; }
	.guac-param-hint { font-size: 0.72rem; color: var(--text-subtle); margin-left: 4px; }
	.guac-param-drive, .guac-param-record { display: flex; align-items: center; gap: 5px; font-size: 0.68rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; cursor: pointer; }
	.guac-param-drive { margin-left: auto; color: var(--accent); }
	.guac-param-drive:has(input:disabled) { opacity: 0.4; cursor: not-allowed; }
	.guac-param-record { margin-left: 12px; color: var(--danger); }

	.save { background: var(--accent); color: var(--on-accent); border: none; border-radius: var(--radius); padding: 0.45rem 0.85rem; font: inherit; font-weight: 600; font-size: 0.85rem; cursor: pointer; }
	.save:hover { background: var(--accent-hover); }
</style>
