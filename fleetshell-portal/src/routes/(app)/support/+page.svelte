<script lang="ts">
	// ── Flip state ────────────────────────────────────────────────────
	let flipped = $state(false);

	// ── Probe state ───────────────────────────────────────────────────
	interface ProbeResult { version: string; arch: string; }

	let step        = $state(0);          // 0 idle · 1 id received · 2 triggered · 3 done
	let statusText  = $state('');
	let probeResult = $state<ProbeResult | null>(null);
	let checking    = $state(false);

	async function checkClient() {
		if (checking) return;
		checking    = true;
		step        = 0;
		statusText  = 'Contacting portal…';
		probeResult = null;

		// ── 1. Get / create stable client ID ─────────────────────────
		let id: string;
		let token: string;
		try {
			const res = await fetch('/api/clients', {
				method  : 'POST',
				headers : { 'Content-Type': 'application/json' },
				body    : '{}',
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			({ id, token } = await res.json() as { id: string; token: string });
		} catch (e) {
			statusText = `Error: ${e instanceof Error ? e.message : String(e)}`;
			checking   = false;
			return;
		}

		step       = 1;
		statusText = `ID: ${id.slice(0, 8)}…`;

		// ── 2. Open SSE stream (before triggering the client, so we
		//       never miss a fast response via the Redis fast-path) ────
		const evtSource = new EventSource(`/api/probes/${id}/stream`);

		// Browser-side timeout — belt-and-suspenders alongside the server one.
		const guard = setTimeout(() => {
			evtSource.close();
			if (step < 3) {
				statusText = 'No response — is the client running?';
				checking   = false;
			}
		}, 65_000);

		evtSource.addEventListener('result', (ev) => {
			clearTimeout(guard);
			evtSource.close();
			const data  = JSON.parse((ev as MessageEvent).data) as ProbeResult;
			probeResult = data;
			step        = 3;
			statusText  = `${data.version} · ${data.arch}`;
			checking    = false;
		});

		evtSource.addEventListener('timeout', () => {
			clearTimeout(guard);
			evtSource.close();
			statusText = 'Probe timed out — client did not respond';
			checking   = false;
		});

		evtSource.addEventListener('error', () => {
			clearTimeout(guard);
			evtSource.close();
			if (step < 3) { statusText = 'Stream error'; checking = false; }
		});

		// Wait for "ready" so the subscription is live before we trigger.
		await new Promise<void>((resolve) => {
			evtSource.addEventListener('ready', () => resolve(), { once: true });
			// Proceed anyway after 3 s — the pub/sub setup is fast in practice.
			setTimeout(resolve, 3_000);
		});

		// ── 3. Trigger the desktop client via custom URL scheme ───────
		step       = 2;
		statusText = `Triggered client ${id.slice(0, 8)}…`;

		// Payload: base64url (URL-safe, no padding) per the fleetshell:// spec.
		const raw     = JSON.stringify({ type: 'probe', payload: id, token });
		const encoded = btoa(raw)
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');

		// Hidden anchor avoids navigating away if the scheme is unregistered.
		const a = document.createElement('a');
		a.href  = `fleetshell://${encoded}`;
		a.style.display = 'none';
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
	}
</script>

<svelte:head><title>Support — FleetShell Portal</title></svelte:head>

<div class="page">
	<h1 class="page-title">Support &amp; Downloads</h1>
	<p class="subtitle">
		Install the tools you need to connect to and manage remote devices.
	</p>

	<div class="grid">

		<!-- ── FleetShell Client — flippable card ───────────────────── -->
		<div class="flipper">
			<div class="card-inner" class:flipped>

				<!-- Front: download ────────────────────────────────── -->
				<div class="card-face card-front app-card"
				     role="button"
				     tabindex="0"
				     onclick={() => { flipped = true; }}
				     onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') flipped = true; }}>
					<div class="app-icon">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
						     stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
							<rect x="2" y="2" width="20" height="8" rx="2"/>
							<rect x="2" y="14" width="20" height="8" rx="2"/>
							<line x1="6" y1="6"  x2="6.01" y2="6"/>
							<line x1="6" y1="18" x2="6.01" y2="18"/>
						</svg>
					</div>
					<div class="app-info">
						<span class="app-name">FleetShell Client</span>
						<span class="app-desc">The desktop client required to open tunnels to remote devices.</span>
					</div>
					<a
						class="dl-btn"
						href="/support/apps/fleetshell-client.exe"
						download
						onclick={() => { flipped = true; }}
					>
						<svg class="dl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
						     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
							<polyline points="7 10 12 15 17 10"/>
							<line x1="12" y1="15" x2="12" y2="3"/>
						</svg>
						Download
					</a>
				</div>

				<!-- Back: probe ─────────────────────────────────────── -->
				<div class="card-face card-back app-card back-face">

					<div class="app-icon">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
						     stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
							<rect x="2" y="2" width="20" height="8" rx="2"/>
							<rect x="2" y="14" width="20" height="8" rx="2"/>
							<line x1="6" y1="6"  x2="6.01" y2="6"/>
							<line x1="6" y1="18" x2="6.01" y2="18"/>
						</svg>
					</div>

					<div class="app-info">
						<span class="app-name">FleetShell Client</span>
						<span class="app-desc">
							Check your setup{#if probeResult}&nbsp;&middot; Client connected!&nbsp;<span class="check-mark">✓</span>{/if}
						</span>
					</div>

					<div class="probe-panel">
						<button
							class="dl-btn check-btn"
							type="button"
							disabled={checking}
							onclick={checkClient}
						>
							{checking ? 'Checking…' : 'Check Client'}
						</button>

						<div class="progress-bar" aria-label="Probe progress">
							<div class="segment" class:seg-lit={step >= 1}></div>
							<div class="segment" class:seg-lit={step >= 2}></div>
							<div class="segment" class:seg-lit={step >= 3}></div>
						</div>

						{#if statusText}
							<p class="probe-status">{statusText}{#if step >= 3}&nbsp;<span class="check-mark">✓</span>{/if}</p>
						{/if}
					</div>

				</div>

			</div>
		</div>

		<!-- ── VNC Viewer ───────────────────────────────────────────── -->
		<div class="app-card">
			<div class="app-icon">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
				     stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
					<rect x="2" y="3" width="20" height="14" rx="2"/>
					<line x1="8" y1="21" x2="16" y2="21"/>
					<line x1="12" y1="17" x2="12" y2="21"/>
				</svg>
			</div>
			<div class="app-info">
				<span class="app-name">VNC Viewer</span>
				<span class="app-desc">Remote desktop viewer for VNC-capable devices.</span>
			</div>
			<a class="dl-btn dl-btn--pending"
			   href="https://portal.fleetshell.com/support/apps/vnc-viewer.exe"
			   download>
				<svg class="dl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
				     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
					<polyline points="7 10 12 15 17 10"/>
					<line x1="12" y1="15" x2="12" y2="3"/>
				</svg>
				Download
			</a>
		</div>

		<!-- ── TeamViewer Client ─────────────────────────────────────── -->
		<div class="app-card">
			<div class="app-icon">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
				     stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
					<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
					<polyline points="10 17 15 12 10 7"/>
					<line x1="15" y1="12" x2="3" y2="12"/>
				</svg>
			</div>
			<div class="app-info">
				<span class="app-name">TeamViewer Client</span>
				<span class="app-desc">Remote support and control via TeamViewer.</span>
			</div>
			<a class="dl-btn dl-btn--pending"
			   href="https://portal.fleetshell.com/support/apps/teamviewer-client.exe"
			   download>
				<svg class="dl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
				     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
					<polyline points="7 10 12 15 17 10"/>
					<line x1="12" y1="15" x2="12" y2="3"/>
				</svg>
				Download
			</a>
		</div>

		<!-- ── SSH Terminal ──────────────────────────────────────────── -->
		<div class="app-card">
			<div class="app-icon">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
				     stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
					<polyline points="4 17 10 11 4 5"/>
					<line x1="12" y1="19" x2="20" y2="19"/>
				</svg>
			</div>
			<div class="app-info">
				<span class="app-name">SSH Terminal</span>
				<span class="app-desc">Secure shell access to command-line interfaces on remote devices.</span>
			</div>
			<a class="dl-btn dl-btn--pending"
			   href="https://portal.fleetshell.com/support/apps/ssh-terminal.exe"
			   download>
				<svg class="dl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
				     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
					<polyline points="7 10 12 15 17 10"/>
					<line x1="12" y1="15" x2="12" y2="3"/>
				</svg>
				Download
			</a>
		</div>

	</div>

	<p class="pending-note">
		Links marked in orange will be updated once the final filenames are confirmed.
	</p>
</div>

<style>
	.page      { max-width: 800px; }

	.page-title {
		font-size      : 1.1rem;
		font-weight    : 700;
		color          : var(--fg2);
		text-transform : uppercase;
		letter-spacing : 0.1em;
		margin-bottom  : 6px;
	}
	.subtitle {
		font-size     : 0.9rem;
		color         : var(--fg4);
		margin-bottom : 28px;
	}

	/* ── Card grid ──────────────────────────────────────────────────── */
	.grid {
		display               : grid;
		grid-template-columns : repeat(auto-fill, minmax(320px, 1fr));
		gap                   : 14px;
	}

	.app-card {
		display        : flex;
		align-items    : center;
		gap            : 14px;
		background     : var(--bg0);
		border         : 1px solid var(--bg2);
		border-radius  : 4px;
		padding        : 16px 18px;
		transition     : border-color 0.15s;
	}
	.app-card:hover { border-color: var(--bg3); }

	/* ── 3-D flip ───────────────────────────────────────────────────── */
	.flipper    { perspective: 900px; }

	.card-inner {
		display         : grid;          /* both faces in same cell → stable height */
		transform-style : preserve-3d;
		transition      : transform 0.55s cubic-bezier(0.4, 0, 0.2, 1);
	}
	.card-inner.flipped { transform: rotateY(180deg); }

	.card-face {
		grid-area                  : 1 / 1;
		backface-visibility        : hidden;
		-webkit-backface-visibility: hidden;
	}
	.card-back  { transform: rotateY(180deg); }
	.card-front { cursor: pointer; }
	.card-front:hover { border-color: var(--bg4); }

	/* Back face needs top-aligned content so the probe panel grows downward. */
	/* back-face: no align-items override — inherits center from .app-card
	   so the icon stays vertically centred even when the probe panel is tall. */

	/* ── App icon ───────────────────────────────────────────────────── */
	.app-icon {
		width       : 36px;
		height      : 36px;
		flex-shrink : 0;
		color       : var(--bright-aqua);
		display     : flex;
		align-items : center;
	}
	.app-icon svg { width: 100%; height: 100%; }

	/* ── App info ───────────────────────────────────────────────────── */
	.app-info {
		flex           : 1;
		display        : flex;
		flex-direction : column;
		gap            : 3px;
		min-width      : 0;
	}
	.app-name {
		font-size   : 0.95rem;
		font-weight : 600;
		color       : var(--fg1);
	}
	.app-desc {
		font-size  : 0.8rem;
		color      : var(--fg4);
		line-height: 1.4;
	}

	/* ── Buttons ────────────────────────────────────────────────────── */
	.dl-btn {
		display         : inline-flex;
		align-items     : center;
		gap             : 6px;
		background      : var(--blue);
		color           : var(--fg0);
		border          : none;
		border-radius   : 3px;
		padding         : 7px 14px;
		font-family     : inherit;
		font-size       : 0.85rem;
		text-decoration : none;
		white-space     : nowrap;
		flex-shrink     : 0;
		cursor          : pointer;
		transition      : background 0.15s;
	}
	.dl-btn:hover         { background: var(--bright-blue); text-decoration: none; }
	.dl-btn--pending      { background: var(--orange); }
	.dl-btn--pending:hover{ background: var(--bright-orange); }
	.dl-btn:disabled      { opacity: 0.55; cursor: not-allowed; }

	.check-btn {
		background      : var(--green);
		width           : 100%;          /* fill the fixed-width probe panel */
		justify-content : center;
	}
	.check-btn:hover { background: var(--bright-green); }

	.dl-icon { width: 14px; height: 14px; }

	/* ── Probe panel ────────────────────────────────────────────────── */
	.probe-panel {
		display        : flex;
		flex-direction : column;
		gap            : 6px;
		flex-shrink    : 0;
		width          : 130px;  /* fixed — prevents status text from expanding the card */
	}

	/* Progress bar — three distinct segments */
	.progress-bar {
		display : flex;
		gap     : 3px;
	}
	.segment {
		flex          : 1;
		height        : 5px;
		border-radius : 2px;
		background    : var(--bg2);
		transition    : background 0.35s ease;
	}
	.seg-lit    { background: var(--bright-green); }

	.check-mark { color: var(--bright-green); font-weight: 700; }

	/* Status line under the progress bar */
	.probe-status {
		font-size  : 0.72rem;
		color      : var(--fg4);
		margin     : 0;
		word-break : break-all;
		line-height: 1.35;
	}

	/* ── Footer note ────────────────────────────────────────────────── */
	.pending-note {
		margin-top : 18px;
		font-size  : 0.8rem;
		color      : var(--bg4);
	}
</style>
