<script lang="ts">
	// Contract flags for a device, rendered as coloured chips (matching the
	// IpsecEditor DH-group chips). STD/NIU are mutually exclusive (either, or
	// neither); DPA and DMY are independent toggles. Emits the three hidden form
	// fields the server reads (internal_use / dpa / dmy).
	let { internalUse = null, dpa = false, dmy = false, disabled = false }: {
		internalUse?: string | null;
		dpa?: boolean | string | null;
		dmy?: boolean | string | null;
		disabled?: boolean;
	} = $props();

	// Seeded ONCE from props; the host remounts via {#key x.id} when the selected
	// device changes, so these snapshots are intentional.
	// svelte-ignore state_referenced_locally
	let iu = $state<string | null>(internalUse === 'STD' || internalUse === 'NIU' ? internalUse : null);
	// svelte-ignore state_referenced_locally
	let hasDpa = $state(!!dpa);
	// svelte-ignore state_referenced_locally
	let hasDmy = $state(!!dmy);

	function setIu(v: 'STD' | 'NIU') {
		if (disabled) return;
		iu = iu === v ? null : v;           // click an active one to clear
	}
</script>

<div class="chip-field">
	<span class="chip-label">Contracts</span>
	<div class="chips">
		<button type="button" class="chip" class:on={iu === 'STD'} disabled={disabled}
			title="Standard" onclick={() => setIu('STD')}>STD</button>
		<button type="button" class="chip" class:on={iu === 'NIU'} disabled={disabled}
			title="No internal use" onclick={() => setIu('NIU')}>NIU</button>
		<button type="button" class="chip" class:on={hasDpa} disabled={disabled}
			title="Data Processing Agreement" onclick={() => { if (!disabled) hasDpa = !hasDpa; }}>DPA</button>
		<button type="button" class="chip" class:on={hasDmy} disabled={disabled}
			title="Dummy" onclick={() => { if (!disabled) hasDmy = !hasDmy; }}>DMY</button>
	</div>
</div>
<input type="hidden" name="internal_use" value={iu ?? ''} />
<input type="hidden" name="dpa" value={hasDpa ? 'on' : ''} />
<input type="hidden" name="dmy" value={hasDmy ? 'on' : ''} />

<style>
	.chip-field { display: flex; align-items: center; gap: 0.75rem; margin: 0.75rem 0 0.2rem; flex-wrap: wrap; }
	.chip-label { font-size: 0.76rem; color: var(--text-muted); width: 7rem; flex-shrink: 0; }
	.chips { display: flex; flex-wrap: wrap; gap: 0.35rem; }
	.chip { padding: 0.2rem 0.75rem; background: var(--bg-app); color: var(--text-muted); border: 1px solid var(--border); border-radius: 14px; font-size: 0.76rem; font-family: var(--mono, monospace); cursor: pointer; }
	.chip:hover:not(:disabled) { border-color: var(--text-subtle); }
	.chip.on { background: color-mix(in srgb, var(--accent) 20%, var(--bg-app)); border-color: var(--accent); color: var(--accent); font-weight: 700; }
	.chip:disabled { cursor: default; opacity: 0.7; }
</style>
