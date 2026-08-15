<!--
	Site membership editor: the three ways a device joins a site --
	  * assigned gateways (ScopePicker over /api/administration/gateways) -> rule,
	  * hospital names (free-text chips)                                   -> rule,
	  * manually assigned devices (searchable list)                        -> static.
	Saved together to ?/saveMembership, which rewrites the rules + static list and
	recomputes device.site_id (precedence: manual > gateway > hospital). Remount
	via {#key site_id} in the host to reseed.
-->
<script lang="ts">
	import { base } from '$app/paths';
	import { enhance } from '$app/forms';
	import ScopePicker from './ScopePicker.svelte';

	type Chip = { key: string; label: string };
	type Dev = { id: string; serial: string; model: string; product: string };
	let {
		siteId, customerId, gatewayChips, hospitalNames, members, memberTotal, effectiveCount, canEdit,
	}: {
		siteId: string; customerId: string; gatewayChips: Chip[]; hospitalNames: string[];
		members: Dev[]; memberTotal: number; effectiveCount: number; canEdit: boolean;
	} = $props();

	// One-time seed from props; host remounts via {#key} to reseed.
	// svelte-ignore state_referenced_locally
	let gateways = $state<Chip[]>([...gatewayChips]);
	// svelte-ignore state_referenced_locally
	let hospitals = $state<string[]>([...hospitalNames]);
	// svelte-ignore state_referenced_locally
	let devices = $state<Dev[]>([...members]);
	let hospInput = $state('');

	function addHosp() {
		const v = hospInput.trim();
		if (v && !hospitals.includes(v)) hospitals = [...hospitals, v];
		hospInput = '';
	}
	function removeHosp(v: string) { hospitals = hospitals.filter((h) => h !== v); }

	// Device search (list-style add, matching the gateway edit page).
	let devQuery = $state('');
	let devResults = $state<Dev[]>([]);
	async function searchDevices() {
		if (devQuery.trim().length < 2) { devResults = []; return; }
		const res = await fetch(`${base}/api/administration/devices?q=${encodeURIComponent(devQuery.trim())}`);
		if (!res.ok) { devResults = []; return; }
		const have = new Set(devices.map((d) => d.id));
		devResults = ((await res.json()).items ?? []).filter((d: Dev) => !have.has(d.id));
	}
	function addDevice(d: Dev) {
		devices = [...devices, d];
		devResults = devResults.filter((r) => r.id !== d.id);
		devQuery = '';
	}
	function removeDevice(id: string) { devices = devices.filter((d) => d.id !== id); }

	const gatewaysJson = $derived(JSON.stringify(gateways.map((g) => g.key)));
	const hospitalsJson = $derived(JSON.stringify(hospitals));
	const devicesJson = $derived(JSON.stringify(devices.map((d) => d.id)));
</script>

<form method="POST" action="?/saveMembership" use:enhance class="membership">
	<input type="hidden" name="site_id" value={siteId} />
	<input type="hidden" name="customer_id" value={customerId} />
	<input type="hidden" name="gateways" value={gatewaysJson} />
	<input type="hidden" name="hospitals" value={hospitalsJson} />
	<input type="hidden" name="devices" value={devicesJson} />

	<div class="mhead">
		<h4>Membership</h4>
		<span class="eff" title="Devices currently resolved into this site">{effectiveCount} device(s) in site</span>
	</div>

	<ScopePicker label="Assigned gateways (all devices behind them join)" endpoint="/api/administration/gateways"
		bind:selected={gateways} placeholder="Search gateways…"
		toItem={(g) => ({ key: g.id, label: g.name || g.hospital || g.id })} />

	<div class="block">
		<div class="plabel">Hospital names (matched against the device hospital field)</div>
		{#if hospitals.length}
			<div class="chips">
				{#each hospitals as h (h)}
					<span class="chip">{h}{#if canEdit}<button type="button" onclick={() => removeHosp(h)} aria-label="Remove">✕</button>{/if}</span>
				{/each}
			</div>
		{/if}
		{#if canEdit}
			<div class="add-row">
				<input placeholder="Add hospital name…" bind:value={hospInput}
					onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addHosp(); } }} />
				<button type="button" class="mini" onclick={addHosp}>Add</button>
			</div>
		{/if}
	</div>

	<div class="block">
		<div class="plabel">Customer systems (manually assigned devices) <span class="count">{devices.length}</span></div>
		{#if devices.length}
			<ul class="devs">
				{#each devices as d (d.id)}
					<li>
						<a href={`${base}/devices?mode=all&sel=${encodeURIComponent(d.id)}`}><span class="mono">{d.serial || '(no serial)'}</span></a>
						<span class="dmeta">{d.model || ''}{#if d.product} · {d.product}{/if}</span>
						{#if canEdit}<button type="button" class="rm" onclick={() => removeDevice(d.id)} aria-label="Remove">✕</button>{/if}
					</li>
				{/each}
			</ul>
			{#if memberTotal > members.length}
				<p class="warn">Showing {members.length} of {memberTotal} assigned devices — saving would drop the rest.</p>
			{/if}
		{:else}
			<p class="muted">No manually assigned devices.</p>
		{/if}
		{#if canEdit}
			<div class="add-row search">
				<input placeholder="Search devices by serial / IP…" bind:value={devQuery} oninput={searchDevices}
					autocomplete="off" spellcheck="false" />
				{#if devResults.length}
					<ul class="results">
						{#each devResults as d (d.id)}
							<li><button type="button" onclick={() => addDevice(d)}>
								<span class="mono">{d.serial || '(no serial)'}</span>
								<span class="dmeta">{d.model || ''}{#if d.product} · {d.product}{/if}</span>
							</button></li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}
	</div>

	{#if canEdit}
		<div class="actions-bar">
			<button type="submit" class="act-save">Save membership &amp; recompute</button>
		</div>
	{/if}
</form>

<style>
	.membership { display: flex; flex-direction: column; gap: 0.9rem; }
	.mhead { display: flex; align-items: baseline; justify-content: space-between; }
	h4 { font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-subtle); margin: 0; }
	.eff { font-size: 0.78rem; color: var(--accent); font-weight: 600; }
	.block { display: flex; flex-direction: column; gap: 0.4rem; }
	.plabel { font-size: 0.78rem; color: var(--text-muted); }
	.count { color: var(--text-subtle); }

	.chips { display: flex; flex-wrap: wrap; gap: 0.35rem; }
	.chip { display: inline-flex; align-items: center; gap: 0.3rem; background: color-mix(in srgb, var(--accent) 14%, var(--bg-app));
		border: 1px solid var(--border); border-radius: 14px; padding: 0.15rem 0.6rem; font-size: 0.8rem; color: var(--text); }
	.chip button { background: none; border: none; color: var(--text-subtle); cursor: pointer; font-size: 0.72rem; padding: 0; line-height: 1; }
	.chip button:hover { color: var(--danger); }

	.devs { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.25rem; }
	.devs li { display: flex; align-items: baseline; gap: 0.6rem; font-size: 0.83rem; }
	.devs a { color: var(--accent); text-decoration: none; }
	.devs a:hover { text-decoration: underline; }
	.dmeta { color: var(--text-subtle); font-size: 0.78rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.devs .rm { margin-left: auto; flex: none; width: 20px; height: 20px; border: 1px solid var(--border); background: var(--surface-2);
		color: var(--text-subtle); border-radius: var(--radius); cursor: pointer; font-size: 0.7rem; line-height: 1; }
	.devs .rm:hover { color: var(--danger); border-color: var(--danger); }
	.mono { font-family: var(--mono, monospace); }

	.add-row { display: flex; gap: 0.4rem; position: relative; }
	.add-row input { flex: 1; min-width: 0; background: var(--bg-app); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.35rem 0.5rem; font: inherit; font-size: 0.82rem; }
	.add-row input:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	.mini { background: none; border: 1px solid var(--border); color: var(--text-muted); border-radius: var(--radius); padding: 0.2rem 0.6rem; font: inherit; font-size: 0.78rem; cursor: pointer; }
	.mini:hover { color: var(--text); border-color: var(--text-subtle); }
	.results { position: absolute; z-index: 5; left: 0; right: 0; top: 100%; margin: 0.15rem 0 0; padding: 0.2rem; list-style: none;
		background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow, 0 4px 14px rgba(0,0,0,0.25)); max-height: 240px; overflow-y: auto; }
	.results li button { display: flex; align-items: baseline; gap: 0.5rem; width: 100%; text-align: left; background: none; border: none;
		color: var(--text); font: inherit; font-size: 0.82rem; padding: 0.35rem 0.5rem; border-radius: var(--radius); cursor: pointer; }
	.results li button:hover { background: var(--surface-2); }

	.warn { color: var(--warning, #d79921); font-size: 0.78rem; margin: 0; }
	.muted { color: var(--text-subtle); font-size: 0.82rem; margin: 0; }
	.act-save { align-self: flex-start; background: var(--accent); color: var(--on-accent); border: none; border-radius: var(--radius); padding: 0.45rem 0.9rem; font: inherit; font-weight: 600; font-size: 0.85rem; cursor: pointer; }
	.act-save:hover { background: var(--accent-hover); }
</style>
