<!--
	IPsec tunnel / crypto editor for a gateway. Faithful port of the legacy
	fleetshell-portal gateways edit UI (public IP + PSK, IP type + IKE version,
	IKE Phase 1 / Phase 2 chip multi-selects, remote traffic selectors), adapted
	to the portal-dev design tokens. Emits public_ip / psk / ipsec (JSON) as
	hidden inputs so it posts with the surrounding gateway form.
-->
<script lang="ts">
	type Ipsec = {
		ike_version?: number; ike_identity?: string; static_ip?: boolean; dyndns_password?: string;
		ike_enc?: string[]; ike_auth?: string[]; ike_dh?: number[];
		esp_enc?: string[]; esp_auth?: string[]; esp_pfs?: number[]; remote_ts?: string[];
	};
	let { publicIp = null, psk = null, ipsec = null, disabled = false, isCreate = false }:
		{ publicIp?: string | null; psk?: string | null; ipsec?: Ipsec | null; disabled?: boolean; isCreate?: boolean } = $props();

	const IKE_ENC   = ['aes128', 'aes192', 'aes256'];
	const IKE_AUTH  = ['sha256', 'sha384', 'sha512'];
	const DH_GROUPS = [1, 2, 5, 14, 15, 16, 19, 20, 21, 24];
	const ESP_ENC   = ['aes128', 'aes192', 'aes256', 'aes128gcm', 'aes192gcm', 'aes256gcm', 'none'];
	const ESP_AUTH  = ['sha256', 'sha384', 'sha512', 'none'];

	// All fields are seeded ONCE from props; the host remounts via {#key g.id}
	// when the selected gateway changes, so these snapshots are intentional.
	// svelte-ignore state_referenced_locally
	const s = ipsec ?? {};
	// svelte-ignore state_referenced_locally
	let ip = $state(publicIp ?? '');
	// svelte-ignore state_referenced_locally
	let pskVal = $state(psk ?? '');
	let showPsk = $state(false);
	let ike_version = $state(Number(s.ike_version) === 1 ? 1 : 2);
	let ike_identity = $state(s.ike_identity ?? '');
	let static_ip = $state(s.static_ip ?? true);
	let dyndns_password = $state(s.dyndns_password ?? '');
	let ike_enc = $state<string[]>(s.ike_enc ?? ['aes256']);
	let ike_auth = $state<string[]>(s.ike_auth ?? ['sha256']);
	let ike_dh = $state<number[]>(s.ike_dh ?? [14]);
	let esp_enc = $state<string[]>(s.esp_enc ?? ['aes256gcm']);
	let esp_auth = $state<string[]>(s.esp_auth ?? ['none']);
	let esp_pfs = $state<number[]>(s.esp_pfs ?? [14]);
	let remote_ts_text = $state((s.remote_ts ?? []).join('\n'));

	function toggleStr(arr: string[], v: string) { return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]; }
	function toggleNum(arr: number[], v: number) { return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]; }

	// Serialised ipsec record, kept in sync for the hidden field.
	const ipsecJson = $derived(JSON.stringify({
		ike_version, ike_identity: ike_identity.trim(), static_ip,
		...(!static_ip && dyndns_password ? { dyndns_password } : {}),
		ike_enc, ike_auth, ike_dh, esp_enc, esp_auth, esp_pfs,
		remote_ts: remote_ts_text.split('\n').map((l) => l.trim()).filter(Boolean),
	}));
</script>

<input type="hidden" name="public_ip" value={ip} />
<input type="hidden" name="psk" value={pskVal} />
<input type="hidden" name="ipsec" value={ipsecJson} />

<div class="grid2">
	<label><span class="lbl">Public IP <span class="opt">(tunnel endpoint)</span></span>
		<input class="mono" bind:value={ip} disabled={disabled} placeholder="62.238.110.152" /></label>
	<div class="field">
		<span>Shared secret (PSK)</span>
		<span class="psk-row">
			{#if showPsk}<input class="mono" bind:value={pskVal} disabled={disabled} />
			{:else}<input class="mono" type="password" bind:value={pskVal} disabled={disabled} />{/if}
			<button type="button" class="mini" onclick={() => (showPsk = !showPsk)}>{showPsk ? 'hide' : 'show'}</button>
		</span>
	</div>
	<label><span class="lbl">IKE identity <span class="opt">(optional)</span></span>
		<input class="mono" bind:value={ike_identity} disabled={disabled} placeholder="10.5.0.1" /></label>
	<div class="field">
		<span>IP type</span>
		<div class="radio-row">
			<label><input type="radio" value={true} bind:group={static_ip} disabled={disabled} /> Static</label>
			<label><input type="radio" value={false} bind:group={static_ip} disabled={disabled} /> Dynamic</label>
		</div>
	</div>
	{#if !static_ip}
		<div class="field">
			<!-- In production the DynDNS password would come from the source
			     WEBDNSPWID / WEBDNSPWPW (not imported into this dev dump). -->
			<span>DynDNS password</span>
			<span class="psk-row">
				{#if showPsk}<input class="mono" bind:value={dyndns_password} disabled={disabled} />
				{:else}<input class="mono" type="password" bind:value={dyndns_password} disabled={disabled} />{/if}
			</span>
		</div>
	{/if}
	<div class="field">
		<span>IKE version</span>
		<div class="radio-row">
			<label><input type="radio" value={1} bind:group={ike_version} disabled={disabled} /> IKEv1</label>
			<label><input type="radio" value={2} bind:group={ike_version} disabled={disabled} /> IKEv2</label>
		</div>
	</div>
</div>

<h4>IKE Phase 1</h4>
{@render chips('Encryption', IKE_ENC, ike_enc, (v) => (ike_enc = toggleStr(ike_enc, v as string)))}
{@render chips('Authentication', IKE_AUTH, ike_auth, (v) => (ike_auth = toggleStr(ike_auth, v as string)))}
{@render chips('DH group', DH_GROUPS, ike_dh, (v) => (ike_dh = toggleNum(ike_dh, v as number)))}

<h4>IKE Phase 2 (ESP)</h4>
{@render chips('Encryption', ESP_ENC, esp_enc, (v) => (esp_enc = toggleStr(esp_enc, v as string)))}
{@render chips('Authentication', ESP_AUTH, esp_auth, (v) => (esp_auth = toggleStr(esp_auth, v as string)))}
{@render chips('PFS (DH group)', DH_GROUPS, esp_pfs, (v) => (esp_pfs = toggleNum(esp_pfs, v as number)), 'No chips = no PFS.')}

<h4>Tunnel rules (remote traffic selectors)</h4>
<textarea class="ts mono" rows="4" bind:value={remote_ts_text} disabled={disabled}
          placeholder={"10.67.0.0/16\n141.67.0.0/16\n10.14.3.5/32"}></textarea>
<span class="hint">One CIDR per line. Empty = catch-all (0.0.0.0/0).</span>

{#snippet chips(label: string, opts: (string | number)[], sel: (string | number)[], toggle: (v: string | number) => void, hint?: string)}
	<div class="chip-field">
		<span class="chip-label">{label}</span>
		<div class="chips">
			{#each opts as v}
				<button type="button" class="chip" class:on={sel.includes(v)} disabled={disabled} onclick={() => toggle(v)}>{v}</button>
			{/each}
		</div>
		{#if hint}<span class="hint">{hint}</span>{/if}
	</div>
{/snippet}

<style>
	.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem 0.9rem; margin-bottom: 0.4rem; }
	label, .field { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.76rem; color: var(--text-muted); }
	.opt { color: var(--text-subtle); font-size: 0.72rem; }
	input, textarea { background: var(--bg-app); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.4rem 0.55rem; font: inherit; font-size: 0.84rem; }
	input:focus-visible, textarea:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	input:disabled, textarea:disabled { color: var(--text-muted); opacity: 0.85; }
	.mono { font-family: var(--mono, monospace); }
	.psk-row { display: flex; gap: 0.4rem; align-items: center; }
	.psk-row input { flex: 1; }
	.mini { background: none; border: 1px solid var(--border); color: var(--text-muted); border-radius: var(--radius); padding: 0.15rem 0.45rem; font-size: 0.72rem; cursor: pointer; }
	.mini:hover { color: var(--text); border-color: var(--text-subtle); }
	.radio-row { display: flex; gap: 1rem; font-size: 0.83rem; color: var(--text); }
	.radio-row label { flex-direction: row; align-items: center; gap: 0.35rem; }
	.radio-row input { width: auto; }

	h4 { font-size: 0.75rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--text-subtle); margin: 1rem 0 0.4rem; }
	.chip-field { display: flex; align-items: center; gap: 0.75rem; margin: 0.4rem 0; flex-wrap: wrap; }
	.chip-label { font-size: 0.76rem; color: var(--text-muted); width: 8.5rem; flex-shrink: 0; }
	.chips { display: flex; flex-wrap: wrap; gap: 0.35rem; }
	.chip { padding: 0.2rem 0.65rem; background: var(--bg-app); color: var(--text-muted); border: 1px solid var(--border); border-radius: 14px; font-size: 0.76rem; font-family: var(--mono, monospace); cursor: pointer; }
	.chip:hover:not(:disabled) { border-color: var(--text-subtle); }
	.chip.on { background: color-mix(in srgb, var(--accent) 20%, var(--bg-app)); border-color: var(--accent); color: var(--accent); font-weight: 700; }
	.chip:disabled { cursor: default; opacity: 0.7; }
	.ts { width: 100%; resize: vertical; }
	.hint { color: var(--text-subtle); font-size: 0.73rem; }
</style>
