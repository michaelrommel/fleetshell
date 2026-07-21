<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { invoke }             from '@tauri-apps/api/core';

	interface AppConfig {
		font_size:       number;
		vnc_viewer:      string;
		portal_base_url: string;
		client_id:       string | null;
	}

	const FONT_MIN     = 10;
	const FONT_MAX     = 28;
	const FONT_DEFAULT = 15;
	const FONT_STEP    =  1;

	let cfg: AppConfig = $state({
		font_size:       FONT_DEFAULT,
		vnc_viewer:      '',
		portal_base_url: 'https://portal.fleetshell.com',
		client_id:       null,
	});

	// Per-field save-state indicators so they don't interfere with each other.
	let fontSaveState:      'idle' | 'saving' | 'saved' | 'error' = $state('idle');
	let vncSaveState:       'idle' | 'saving' | 'saved' | 'error' = $state('idle');
	let portalUrlSaveState: 'idle' | 'saving' | 'saved' | 'error' = $state('idle');

	let fontSaveTimer: ReturnType<typeof setTimeout> | null = null;

	onMount(async () => {
		try {
			cfg = await invoke<AppConfig>('get_config');
		} catch (e) {
			console.warn('Could not load config:', e);
		}
	});

	onDestroy(() => {
		if (fontSaveTimer) clearTimeout(fontSaveTimer);
	});

	// ── Font size ────────────────────────────────────────────────────────────

	function applyFont(value: number) {
		const clamped = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(value)));
		cfg = { ...cfg, font_size: clamped };
		document.documentElement.style.setProperty('--font-size', `${clamped}px`);
		saveConfig('font');
	}

	// ── VNC viewer path ──────────────────────────────────────────────────────

	function applyVnc(value: string) {
		cfg = { ...cfg, vnc_viewer: value.trim() };
		saveConfig('vnc');
	}

	// ── Portal URL ───────────────────────────────────────────────────────────

	function applyPortalUrl(value: string) {
		cfg = { ...cfg, portal_base_url: value.trim() };
		saveConfig('portal');
	}

	// ── Shared save ──────────────────────────────────────────────────────────

	async function saveConfig(indicator: 'font' | 'vnc' | 'portal') {
		const setState =
			indicator === 'font'   ? (s: typeof fontSaveState)      => { fontSaveState      = s; } :
			indicator === 'vnc'    ? (s: typeof vncSaveState)       => { vncSaveState       = s; } :
			                         (s: typeof portalUrlSaveState) => { portalUrlSaveState = s; };

		setState('saving');
		try {
			await invoke('save_config', { config: cfg });
			setState('saved');
			setTimeout(() => setState('idle'), 1200);
		} catch (e) {
			console.error('Failed to save config:', e);
			setState('error');
		}
	}

	function resetFont() { applyFont(FONT_DEFAULT); }
</script>

<div class="settings-panel">

	<!-- ── Appearance ─────────────────────────────────────────────────────── -->
	<h2 class="section-title">Appearance</h2>

	<div class="setting-row">
		<label for="fs-number" class="setting-label">
			Font Size
			<span class="setting-hint">Scales the entire UI</span>
		</label>

		<div class="size-control">
			<input
				type="range"
				aria-label="Font size slider"
				min={FONT_MIN}
				max={FONT_MAX}
				step={FONT_STEP}
				value={cfg.font_size}
				oninput={(e)  => { cfg = { ...cfg, font_size: Number(e.currentTarget.value) }; }}
				onchange={(e) => applyFont(Number(e.currentTarget.value))}
				class="size-slider"
			/>
			<input
				type="number"
				id="fs-number"
				min={FONT_MIN}
				max={FONT_MAX}
				step={FONT_STEP}
				value={cfg.font_size}
				onchange={(e) => applyFont(Number(e.currentTarget.value))}
				class="size-number"
				aria-label="Font size in pixels"
			/>
			<span class="size-unit">px</span>
			<button class="btn-secondary" onclick={resetFont}
			        title="Reset to default ({FONT_DEFAULT}px)">Reset</button>
			{@render SaveIndicator({ state: fontSaveState })}
		</div>
	</div>

	<!-- ── Applications ───────────────────────────────────────────────────── -->
	<h2 class="section-title">Applications</h2>

	<div class="setting-row">
		<label for="vnc-path" class="setting-label">
			VNC Viewer
			<span class="setting-hint">
				Path to TigerVNC vncviewer.exe.<br>
				Leave empty to search PATH.
			</span>
		</label>

		<div class="path-control">
			<input
				type="text"
				id="vnc-path"
				class="path-input"
				value={cfg.vnc_viewer}
				placeholder="e.g. C:\Program Files\TigerVNC\vncviewer64.exe"
				onchange={(e) => applyVnc(e.currentTarget.value)}
				spellcheck={false}
			/>
			{@render SaveIndicator({ state: vncSaveState })}
		</div>
	</div>

	<!-- ── Portal ─────────────────────────────────────────────────────────── -->
	<h2 class="section-title">Portal</h2>

	<div class="setting-row">
		<label for="portal-url" class="setting-label">
			Portal URL
			<span class="setting-hint">
				Base URL of the FleetShell portal.<br>
				Use <code>http://localhost:5173</code> for local dev.
			</span>
		</label>

		<div class="path-control">
			<input
				type="url"
				id="portal-url"
				class="path-input"
				value={cfg.portal_base_url}
				placeholder="https://portal.fleetshell.com"
				onchange={(e) => applyPortalUrl(e.currentTarget.value)}
				spellcheck={false}
			/>
			{@render SaveIndicator({ state: portalUrlSaveState })}
		</div>
	</div>

	<div class="setting-row">
		<span class="setting-label">
			Client ID
			<span class="setting-hint">Assigned during enrollment.<br>Read-only.</span>
		</span>

		<div class="path-control">
			<input
				type="text"
				class="path-input id-field"
				value={cfg.client_id ?? ''}
				placeholder="Not enrolled yet"
				readonly
				spellcheck={false}
			/>
		</div>
	</div>

</div>

<!-- ── Inline save-state badge ──────────────────────────────────────────── -->
{#snippet SaveIndicator(props: { state: 'idle' | 'saving' | 'saved' | 'error' })}
	<span
		class="save-indicator"
		class:saving={props.state === 'saving'}
		class:saved={props.state  === 'saved'}
		class:error={props.state  === 'error'}
		aria-live="polite"
	>
		{#if props.state === 'saving'}saving…
		{:else if props.state === 'saved'}saved ✓
		{:else if props.state === 'error'}error ✗
		{/if}
	</span>
{/snippet}

<style>
	.settings-panel {
		flex: 1;
		overflow-y: auto;
		padding: 28px 32px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	/* ── Section heading ── */
	.section-title {
		font-size: 0.85rem;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--fg4);
		border-bottom: 1px solid var(--bg2);
		padding-bottom: 6px;
		margin: 8px 0 4px;
		font-weight: normal;
	}
	.section-title:first-child { margin-top: 0; }

	/* ── Row layout ── */
	.setting-row {
		display: flex;
		align-items: flex-start;
		gap: 24px;
	}

	.setting-label {
		display: flex;
		flex-direction: column;
		gap: 3px;
		color: var(--fg2);
		font-size: 1rem;
		min-width: 120px;
		padding-top: 4px;
	}

	.setting-hint {
		font-size: 0.85rem;
		color: var(--fg4);
		line-height: 1.4;
	}

	/* ── Font size controls ── */
	.size-control {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}

	.size-slider {
		width: 180px;
		accent-color: var(--yellow);
		cursor: pointer;
	}

	.size-number {
		width: 64px;
		background: var(--bg1);
		color: var(--fg);
		border: 1px solid var(--bg3);
		border-radius: 3px;
		padding: 3px 6px;
		font-family: inherit;
		font-size: 1rem;
		text-align: right;
		-moz-appearance: textfield;
		appearance: textfield;
	}
	.size-number::-webkit-outer-spin-button,
	.size-number::-webkit-inner-spin-button { -webkit-appearance: none; }
	.size-number:focus { outline: 1px solid var(--yellow); border-color: var(--yellow); }

	.size-unit { color: var(--fg4); font-size: 0.85rem; }

	/* ── Path / text controls ── */
	.path-control {
		display: flex;
		align-items: center;
		gap: 10px;
		flex: 1;
	}

	.path-input {
		flex: 1;
		max-width: 520px;
		background: var(--bg1);
		color: var(--fg);
		border: 1px solid var(--bg3);
		border-radius: 3px;
		padding: 4px 8px;
		font-family: inherit;
		font-size: 0.9rem;
	}
	.path-input::placeholder        { color: var(--bg4); }
	.path-input:focus:not([readonly]) { outline: 1px solid var(--yellow); border-color: var(--yellow); }

	/* Readonly variant — dimmed, no focus ring */
	.id-field {
		color: var(--fg4);
		cursor: default;
		font-family: monospace;
		font-size: 0.85rem;
	}

	/* ── Shared secondary button ── */
	.btn-secondary {
		background: var(--bg2);
		color: var(--fg3);
		border: 1px solid var(--bg3);
		border-radius: 3px;
		padding: 3px 12px;
		cursor: pointer;
		font-family: inherit;
		font-size: 0.85rem;
		transition: background 0.1s;
	}
	.btn-secondary:hover { background: var(--bg3); color: var(--fg); }

	/* ── Save indicator ── */
	.save-indicator {
		font-size: 0.85rem;
		min-width: 60px;
		color: transparent;
		transition: color 0.15s;
	}
	.save-indicator.saving { color: var(--fg4);  }
	.save-indicator.saved  { color: var(--green); }
	.save-indicator.error  { color: var(--red);   }
</style>
