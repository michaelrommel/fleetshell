<script lang="ts">
	// ── Phase type ────────────────────────────────────────────────────
	/**
	 * Enrollment phase state machine.
	 *
	 *  front  →  install  →  getting-id  →  enrolling  →  probe-wait
	 *         →  probe-done  →  csr-received  →  cert-ready  →  enrolled
	 *
	 * PHASE_ORDER maps each non-'front' phase to a numeric index used by
	 * stepStatus() to determine circle state without giant if-chains.
	 */
	type Phase =
		| 'front'         // card front face; download not yet clicked
		| 'install'       // back face; waiting for user to confirm install
		| 'getting-id'    // fetching stable client ID from /api/clients
		| 'enrolling'     // fleetshell:// URL triggered; probe SSE open
		| 'probe-wait'    // URL launched; waiting for client probe POST
		| 'probe-done'    // probe received; enrollment SSE opened
		| 'csr-received'  // client submitted CSR to /api/cert/request
		| 'cert-ready'    // backend issued cert; waiting for client confirm
		| 'enrolled';     // client confirmed cert receipt

	const PHASE_ORDER: readonly Phase[] = [
		'install',       // 0
		'getting-id',    // 1
		'enrolling',     // 2
		'probe-wait',    // 3
		'probe-done',    // 4
		'csr-received',  // 5
		'cert-ready',    // 6
		'enrolled',      // 7
	];

	// ── Reactive state ────────────────────────────────────────────────
	let phase     = $state<Phase>('front');
	let clientId  = $state<string | null>(null);
	let probeInfo = $state<{ version: string; arch: string } | null>(null);
	let statusMsg = $state('');
	let errorMsg  = $state('');

	// flipped is independent of phase so the card can be toggled freely
	// without triggering a download or advancing the enrollment state.
	let flipped = $state(false);

	function toggleFlip(): void {
		flipped = !flipped;
		// Advance to 'install' on first flip-to-back so the timeline is live.
		if (flipped && phase === 'front') phase = 'install';
		log(flipped ? 'card flipped to back' : 'card flipped to front');
	}

	// ── Browser-side logging ──────────────────────────────────────────
	function log(msg: string, data?: unknown): void {
		const ts = new Date().toISOString();
		if (data !== undefined) {
			console.log(`[FleetShell/enroll] ${ts} — ${msg}`, data);
		} else {
			console.log(`[FleetShell/enroll] ${ts} — ${msg}`);
		}
	}

	// ── Step-circle status ────────────────────────────────────────────
	type StepStatus = 'pending' | 'active' | 'done';

	function phaseIdx(p: Phase): number {
		return PHASE_ORDER.indexOf(p as Exclude<Phase, 'front'>);
	}

	/**
	 * Returns the visual state of a timeline circle for step n (1–8).
	 *
	 * PHASE_ORDER index reference:
	 *   install(0)  getting-id(1)  enrolling(2)  probe-wait(3)
	 *   probe-done(4)  csr-received(5)  cert-ready(6)  enrolled(7)
	 *
	 * Rule: active = currently at this step's phase(s); done = past it.
	 */
	function stepStatus(n: number): StepStatus {
		if (phase === 'front') return 'pending';
		const pi = phaseIdx(phase);

		switch (n) {
			case 1: // Install instructions  — active at install(0)
			case 2: // Confirm button        — active at install(0)
				return pi === 0 ? 'active' : 'done';

			case 3: // Get client ID         — active at getting-id(1)
				return pi === 1 ? 'active' : pi > 1 ? 'done' : 'pending';

			case 4: // Enrollment triggered  — active at enrolling(2)
				return pi === 2 ? 'active' : pi > 2 ? 'done' : 'pending';

			case 5: // Client connected      — active at probe-wait(3)
				return pi === 3 ? 'active' : pi > 3 ? 'done' : 'pending';

			case 6: // CSR received          — active at probe-done(4)
				return pi === 4 ? 'active' : pi > 4 ? 'done' : 'pending';

			case 7: // Cert issued/confirm   — active at csr-received(5) & cert-ready(6)
				if (pi === 5 || pi === 6) return 'active';
				return pi > 6 ? 'done' : 'pending';

			case 8: // Enrolled              — done only at enrolled(7)
				return pi === 7 ? 'done' : 'pending';

			default:
				return 'pending';
		}
	}

	/** True once every step past the given phase index has been reached. */
	function isPast(p: Phase): boolean {
		return phaseIdx(phase) > phaseIdx(p);
	}

	// ── Download & flip ───────────────────────────────────────────────
	function onDownloadClick(): void {
		log('download button clicked — flipping card to enrollment steps');
		flipped = true;
		if (phase === 'front') phase = 'install';
	}

	// ── Step 2: install confirmed ─────────────────────────────────────
	async function onInstallConfirmed(): Promise<void> {
		log('install confirmed — fetching client ID');
		phase     = 'getting-id';
		statusMsg = 'Fetching unique client ID from portal…';
		errorMsg  = '';

		let id: string;
		let token: string;

		try {
			log('POST /api/clients');
			const res = await fetch('/api/clients', {
				method  : 'POST',
				headers : { 'Content-Type': 'application/json' },
				body    : '{}',
			});
			if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
			const body = await res.json() as { id: string; token: string };
			id    = body.id;
			token = body.token;
			log('client ID received', { id, tokenLen: token.length });
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			log('ERROR: failed to get client ID', { error: msg });
			errorMsg = `Failed to get client ID: ${msg}`;
			phase    = 'install'; // revert so user can retry
			return;
		}

		clientId  = id;
		statusMsg = `ID: ${id.slice(0, 8)}…`;

		await startEnrollment(id, token);
	}

	// ── Enrollment flow ───────────────────────────────────────────────

	/**
	 * Opens the probe SSE stream, waits for it to confirm readiness,
	 * then fires the fleetshell:// URL so the desktop client connects.
	 */
	async function startEnrollment(id: string, token: string): Promise<void> {
		log('startEnrollment()', { id });
		phase     = 'enrolling';
		statusMsg = 'Opening probe stream…';

		// Open SSE BEFORE triggering the client to avoid missing a fast response.
		const probeEvt = new EventSource(`/api/probes/${id}/stream`);
		log('probe EventSource created', { url: `/api/probes/${id}/stream` });

		// Hard client-side guard — complements the server's 60 s timeout.
		const probeGuard = setTimeout(() => {
			log('WARN: probe guard fired — no client response within 65 s');
			probeEvt.close();
			if (phase === 'enrolling' || phase === 'probe-wait') {
				statusMsg = 'No response from client — is FleetShell Client running?';
				errorMsg  = 'The client did not respond within 65 s. Ensure it is running and retry.';
			}
		}, 65_000);

		probeEvt.addEventListener('result', async (ev: Event) => {
			clearTimeout(probeGuard);
			probeEvt.close();
			const data = JSON.parse((ev as MessageEvent).data) as { version: string; arch: string };
			log('probe result received', data);
			probeInfo = data;
			phase     = 'probe-done';
			statusMsg = `Client v${data.version} · ${data.arch}`;

			// Hand off to enrollment SSE (endpoint not yet implemented;
			// the call is safe — it will fail gracefully if 404/error).
			openEnrollmentStream(id);
		});

		probeEvt.addEventListener('timeout', () => {
			clearTimeout(probeGuard);
			probeEvt.close();
			log('probe SSE: server-side timeout event');
			statusMsg = 'Probe timed out — client did not respond.';
			errorMsg  = 'Please ensure FleetShell Client is running and try again.';
		});

		probeEvt.addEventListener('error', () => {
			// EventSource fires 'error' on transient network hiccups and also
			// when the server closes the stream.  Only act if still waiting.
			if (phase === 'enrolling' || phase === 'probe-wait') {
				log('probe SSE: error/close event while waiting');
			}
		});

		// Wait for 'ready' (subscription live) before triggering client,
		// but proceed after 3 s regardless to handle slow connections.
		await new Promise<void>((resolve) => {
			probeEvt.addEventListener('ready', (ev: Event) => {
				log('probe SSE: ready event received', JSON.parse((ev as MessageEvent).data));
				resolve();
			}, { once: true });
			setTimeout(() => {
				log('probe SSE: 3 s ready-wait elapsed, proceeding');
				resolve();
			}, 3_000);
		});

		// Trigger the desktop client via the custom URL scheme.
		phase     = 'probe-wait';
		statusMsg = 'Waiting for client to connect…';

		const payload = JSON.stringify({ type: 'enroll', payload: id, token });
		const encoded = btoa(payload)
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');

		log('triggering fleetshell:// URL scheme', {
			id,
			type    : 'enroll',
			encoded : encoded.slice(0, 40) + '…',
		});

		const anchor         = document.createElement('a');
		anchor.href          = `fleetshell://${encoded}`;
		anchor.style.display = 'none';
		document.body.appendChild(anchor);
		anchor.click();
		document.body.removeChild(anchor);

		log('fleetshell:// anchor clicked');
	}

	/**
	 * Opens the enrollment SSE stream that delivers csr-received,
	 * cert-ready, and enrollment-confirmed events from the portal.
	 *
	 * NOTE: /api/enrollment/[id]/stream is not yet implemented on the
	 * server.  This function will be a no-op until it is added.
	 */
	function openEnrollmentStream(id: string): void {
		log('openEnrollmentStream()', { id });
		statusMsg = 'Waiting for certificate signing request…';

		const evtSource = new EventSource(`/api/enrollment/${id}/stream`);
		log('enrollment EventSource created', { url: `/api/enrollment/${id}/stream` });

		// 5-minute client-side guard (server timeout is also 5 min).
		const guard = setTimeout(() => {
			log('WARN: enrollment stream guard fired — 5 min elapsed');
			evtSource.close();
			if (phase !== 'enrolled') {
				statusMsg = 'Enrollment timed out. Please restart the process.';
			}
		}, 5 * 60_000 + 10_000);

		evtSource.addEventListener('ready', (ev: Event) => {
			log('enrollment SSE: ready', JSON.parse((ev as MessageEvent).data));
		});

		evtSource.addEventListener('csr-received', (ev: Event) => {
			const data = JSON.parse((ev as MessageEvent).data);
			log('enrollment SSE: csr-received', data);
			phase     = 'csr-received';
			statusMsg = 'Certificate signing request received — issuing certificate…';
		});

		evtSource.addEventListener('cert-ready', (ev: Event) => {
			const data = JSON.parse((ev as MessageEvent).data);
			log('enrollment SSE: cert-ready', data);
			phase     = 'cert-ready';
			statusMsg = 'Certificate issued — waiting for client to confirm receipt…';
		});

		evtSource.addEventListener('enrollment-confirmed', (ev: Event) => {
			clearTimeout(guard);
			evtSource.close();
			const data = JSON.parse((ev as MessageEvent).data);
			log('enrollment SSE: enrollment-confirmed', data);
			phase     = 'enrolled';
			statusMsg = 'Enrollment complete!';
		});

		evtSource.addEventListener('timeout', () => {
			clearTimeout(guard);
			evtSource.close();
			log('enrollment SSE: server-side timeout');
			if (phase !== 'enrolled') {
				statusMsg = 'Enrollment stream timed out.';
			}
		});

		evtSource.addEventListener('error', () => {
			if (phase !== 'enrolled') {
				log('enrollment SSE: error/close event', { phase });
			}
		});
	}
</script>

<svelte:head><title>Support — FleetShell Portal</title></svelte:head>

<div class="page">
	<h1 class="page-title">Support &amp; Downloads</h1>
	<p class="subtitle">Install the tools you need to connect to and manage remote devices.</p>

	<div class="main-grid">

		<!-- ── FleetShell Client — featured flipper (full-width) ────── -->
		<div class="featured-flipper">
			<div class="card-inner" class:flipped>

				<!-- ── Front face ──────────────────────────────────── -->
				<div class="card-face card-front"
				     role="button"
				     tabindex="0"
				     onclick={toggleFlip}
				     onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleFlip(); }}>
					<div class="front-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
						     stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
							<rect x="2" y="2" width="20" height="8" rx="2"/>
							<rect x="2" y="14" width="20" height="8" rx="2"/>
							<line x1="6" y1="6"  x2="6.01" y2="6"/>
							<line x1="6" y1="18" x2="6.01" y2="18"/>
						</svg>
					</div>

					<h2 class="front-title">FleetShell Client</h2>

					<p class="front-desc">
						Please download the client application and follow the steps on the
						flip side of this card.
					</p>

					<a
						class="dl-btn"
						href="/support/apps/fleetshell-client.exe"
						download
						onclick={(e) => { e.stopPropagation(); onDownloadClick(); }}
					>
						<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
						     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
							<polyline points="7 10 12 15 17 10"/>
							<line x1="12" y1="15" x2="12" y2="3"/>
						</svg>
						Download FleetShell Client
					</a>
				</div>

				<!-- ── Back face ───────────────────────────────────── -->
				<div class="card-face card-back">
					<div class="back-header">
						<h2 class="back-title">Enrollment Steps</h2>
						<div class="back-header-right">
							{#if statusMsg}
								<span class="status-pill">{statusMsg}</span>
							{/if}
							<button class="flip-back-btn" type="button" onclick={toggleFlip}
							        title="Flip to front">
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
								     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<polyline points="15 18 9 12 15 6"/>
								</svg>
							</button>
						</div>
					</div>

					{#if errorMsg}
						<div class="enroll-error" role="alert">{errorMsg}</div>
					{/if}

					<div class="timeline">

						<!-- ─── Step 1: Install ──────────────────── -->
						<div class="tl-item">
							<div class="tl-left">
								<div class="tl-circle tl-circle-{stepStatus(1)}">
									{#if stepStatus(1) === 'done'}
										<span class="tl-check">✓</span>
									{:else if stepStatus(1) === 'active'}
										<span class="tl-dot"></span>
									{:else}
										<span class="tl-num">1</span>
									{/if}
								</div>
								<div class="tl-line tl-line-{stepStatus(1) === 'done' ? 'done' : 'pending'}"></div>
							</div>
							<div class="tl-content">
								<span class="tl-label">Install</span>
								{#if stepStatus(1) !== 'pending'}
									<p class="tl-text">
										Start the installer once it has been downloaded. After
										successful installation please press the button below.
									</p>
								{/if}
							</div>
						</div>

						<!-- ─── Step 2: Confirm installation ────── -->
						<div class="tl-item">
							<div class="tl-left">
								<div class="tl-circle tl-circle-{stepStatus(2)}">
									{#if stepStatus(2) === 'done'}
										<span class="tl-check">✓</span>
									{:else if stepStatus(2) === 'active'}
										<span class="tl-dot"></span>
									{:else}
										<span class="tl-num">2</span>
									{/if}
								</div>
								<div class="tl-line tl-line-{stepStatus(2) === 'done' ? 'done' : 'pending'}"></div>
							</div>
							<div class="tl-content">
								<span class="tl-label">Confirm Installation</span>
								{#if stepStatus(2) === 'active'}
									<button class="action-btn" type="button" onclick={onInstallConfirmed}>
										Client installed successfully
									</button>
								{:else if stepStatus(2) === 'done'}
									<p class="tl-text tl-done-text">Installation confirmed.</p>
								{/if}
							</div>
						</div>

						<!-- ─── Step 3: Get unique client ID ──────── -->
						<div class="tl-item">
							<div class="tl-left">
								<div class="tl-circle tl-circle-{stepStatus(3)}">
									{#if stepStatus(3) === 'done'}
										<span class="tl-check">✓</span>
									{:else if stepStatus(3) === 'active'}
										<span class="tl-dot"></span>
									{:else}
										<span class="tl-num">3</span>
									{/if}
								</div>
								<div class="tl-line tl-line-{stepStatus(3) === 'done' ? 'done' : 'pending'}"></div>
							</div>
							<div class="tl-content">
								<span class="tl-label">Unique Client ID</span>
								{#if stepStatus(3) === 'active'}
									<p class="tl-text">Retrieving your unique client ID from the portal…</p>
								{:else if stepStatus(3) === 'done'}
									<p class="tl-text tl-done-text">
										ID:&nbsp;<code class="tl-code">{clientId?.slice(0, 8)}…</code>
									</p>
								{/if}
							</div>
						</div>

						<!-- ─── Step 4: Enrollment triggered ─────── -->
						<div class="tl-item">
							<div class="tl-left">
								<div class="tl-circle tl-circle-{stepStatus(4)}">
									{#if stepStatus(4) === 'done'}
										<span class="tl-check">✓</span>
									{:else if stepStatus(4) === 'active'}
										<span class="tl-dot"></span>
									{:else}
										<span class="tl-num">4</span>
									{/if}
								</div>
								<div class="tl-line tl-line-{stepStatus(4) === 'done' ? 'done' : 'pending'}"></div>
							</div>
							<div class="tl-content">
								<span class="tl-label">Enrollment Started</span>
								{#if stepStatus(4) === 'active'}
									<p class="tl-text">
										Enrollment started. Please accept the browser's request to
										<strong class="tl-em">"Open fleetshell-client"</strong>
										and check the box
										<em>"Always allow http://portal.fleetshell.com/ to open links
										of this type in the associated app"</em>.
									</p>
								{:else if stepStatus(4) === 'done'}
									<p class="tl-text tl-done-text">Enrollment request sent to client.</p>
								{/if}
							</div>
						</div>

						<!-- ─── Step 5: Client connected ─────────── -->
						<div class="tl-item">
							<div class="tl-left">
								<div class="tl-circle tl-circle-{stepStatus(5)}">
									{#if stepStatus(5) === 'done'}
										<span class="tl-check">✓</span>
									{:else if stepStatus(5) === 'active'}
										<span class="tl-dot"></span>
									{:else}
										<span class="tl-num">5</span>
									{/if}
								</div>
								<div class="tl-line tl-line-{stepStatus(5) === 'done' ? 'done' : 'pending'}"></div>
							</div>
							<div class="tl-content">
								<span class="tl-label">Client Connected</span>
								{#if stepStatus(5) === 'active'}
									<p class="tl-text">Waiting for the FleetShell Client to connect…</p>
								{:else if stepStatus(5) === 'done'}
									<p class="tl-text tl-done-text">
										{#if probeInfo}
											v{probeInfo.version} · {probeInfo.arch}
										{:else}
											Client connected to the portal.
										{/if}
									</p>
								{/if}
							</div>
						</div>

						<!-- ─── Step 6: CSR received ──────────────── -->
						<div class="tl-item">
							<div class="tl-left">
								<div class="tl-circle tl-circle-{stepStatus(6)}">
									{#if stepStatus(6) === 'done'}
										<span class="tl-check">✓</span>
									{:else if stepStatus(6) === 'active'}
										<span class="tl-dot"></span>
									{:else}
										<span class="tl-num">6</span>
									{/if}
								</div>
								<div class="tl-line tl-line-{stepStatus(6) === 'done' ? 'done' : 'pending'}"></div>
							</div>
							<div class="tl-content">
								<span class="tl-label">Certificate Signing Request</span>
								{#if stepStatus(6) === 'active'}
									<p class="tl-text">Waiting for client certificate signing request…</p>
								{:else if stepStatus(6) === 'done'}
									<p class="tl-text tl-done-text">Certificate signing request received.</p>
								{/if}
							</div>
						</div>

						<!-- ─── Step 7: Certificate issued ───────── -->
						<div class="tl-item">
							<div class="tl-left">
								<div class="tl-circle tl-circle-{stepStatus(7)}">
									{#if stepStatus(7) === 'done'}
										<span class="tl-check">✓</span>
									{:else if stepStatus(7) === 'active'}
										<span class="tl-dot"></span>
									{:else}
										<span class="tl-num">7</span>
									{/if}
								</div>
								<div class="tl-line tl-line-{stepStatus(7) === 'done' ? 'done' : 'pending'}"></div>
							</div>
							<div class="tl-content">
								<span class="tl-label">Certificate Issued</span>
								{#if stepStatus(7) === 'active'}
									<p class="tl-text">
										{#if phase === 'csr-received'}
											Certificate being issued…
										{:else}
											Waiting for client to confirm certificate receipt…
										{/if}
									</p>
								{:else if stepStatus(7) === 'done'}
									<p class="tl-text tl-done-text">Certificate receipt confirmed.</p>
								{/if}
							</div>
						</div>

						<!-- ─── Step 8: Enrolled (last, no line) ── -->
						<div class="tl-item tl-item-last">
							<div class="tl-left">
								<div class="tl-circle tl-circle-{stepStatus(8)}">
									{#if stepStatus(8) === 'done'}
										<span class="tl-check">✓</span>
									{:else}
										<span class="tl-num">8</span>
									{/if}
								</div>
								<!-- no .tl-line — last stop -->
							</div>
							<div class="tl-content">
								<span class="tl-label" class:tl-label-success={stepStatus(8) === 'done'}>
									{stepStatus(8) === 'done' ? 'Client Successfully Enrolled 🎉' : 'Enrollment Complete'}
								</span>
								{#if stepStatus(8) === 'done'}
									<p class="tl-text tl-done-text">
										The client has been enrolled and has its certificate.
										You can now create tunnels from the
										<a href="/devices">Devices</a> page.
									</p>
								{/if}
							</div>
						</div>

					</div><!-- /timeline -->
				</div><!-- /card-back -->

			</div><!-- /card-inner -->
		</div><!-- /featured-flipper -->

		<!-- ── Secondary download cards (2-per-row beneath) ────────── -->

		<!-- VNC Viewer -->
		<div class="app-card">
			<div class="app-icon" aria-hidden="true">
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
			<a class="dl-btn dl-btn-pending"
			   href="https://portal.fleetshell.com/support/apps/vnc-viewer.exe"
			   download>
				<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
				     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
					<polyline points="7 10 12 15 17 10"/>
					<line x1="12" y1="15" x2="12" y2="3"/>
				</svg>
				Download
			</a>
		</div>

		<!-- TeamViewer -->
		<div class="app-card">
			<div class="app-icon" aria-hidden="true">
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
			<a class="dl-btn dl-btn-pending"
			   href="https://portal.fleetshell.com/support/apps/teamviewer-client.exe"
			   download>
				<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
				     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
					<polyline points="7 10 12 15 17 10"/>
					<line x1="12" y1="15" x2="12" y2="3"/>
				</svg>
				Download
			</a>
		</div>

		<!-- SSH Terminal -->
		<div class="app-card">
			<div class="app-icon" aria-hidden="true">
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
			<a class="dl-btn dl-btn-pending"
			   href="https://portal.fleetshell.com/support/apps/ssh-terminal.exe"
			   download>
				<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
				     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
					<polyline points="7 10 12 15 17 10"/>
					<line x1="12" y1="15" x2="12" y2="3"/>
				</svg>
				Download
			</a>
		</div>

	</div><!-- /main-grid -->

	<p class="pending-note">
		Links marked in orange will be updated once the final filenames are confirmed.
	</p>
</div>

<style>
	/* ── Page shell ─────────────────────────────────────────────────── */
	.page        { max-width: 860px; }

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

	/* ── Main grid ──────────────────────────────────────────────────── */
	.main-grid {
		display               : grid;
		grid-template-columns : 1fr 1fr;
		gap                   : 14px;
	}

	/* ── Featured flipper — spans both columns ──────────────────────── */
	.featured-flipper {
		grid-column : 1 / -1;
		perspective : 1200px;
	}

	.card-inner {
		display         : grid;           /* stacks both faces in the same cell */
		transform-style : preserve-3d;
		transition      : transform 0.65s cubic-bezier(0.4, 0, 0.2, 1);
	}
	.card-inner.flipped { transform: rotateY(180deg); }

	.card-face {
		grid-area                  : 1 / 1;   /* overlap both faces */
		backface-visibility        : hidden;
		-webkit-backface-visibility: hidden;
		background                 : var(--bg0);
		border                     : 1px solid var(--bg2);
		border-radius              : 6px;
	}

	.card-back { transform: rotateY(180deg); }

	/* ── Front face ─────────────────────────────────────────────────── */
	.card-front {
		display         : flex;
		flex-direction  : column;
		align-items     : center;
		justify-content : center;
		gap             : 22px;
		padding         : 56px 48px;
		text-align      : center;
		cursor          : pointer;
	}
	.card-front:focus-visible {
		outline        : 2px solid var(--bright-blue);
		outline-offset : -2px;
		border-radius  : 6px;
	}

	.front-icon {
		width  : 72px;
		height : 72px;
		color  : var(--bright-aqua);
	}
	.front-icon svg { width: 100%; height: 100%; }

	.front-title {
		font-size   : 1.7rem;
		font-weight : 700;
		color       : var(--fg1);
	}

	.front-desc {
		font-size  : 1rem;
		color      : var(--fg3);
		line-height: 1.65;
		max-width  : 520px;
	}

	/* ── Back face ──────────────────────────────────────────────────── */
	.card-back {
		padding : 32px 36px 36px;
	}

	.back-header {
		display         : flex;
		align-items     : center;
		justify-content : space-between;
		flex-wrap       : wrap;
		gap             : 10px;
		margin-bottom   : 28px;
	}
	.back-header-right {
		display     : flex;
		align-items : center;
		gap         : 10px;
	}
	.flip-back-btn {
		display         : flex;
		align-items     : center;
		justify-content : center;
		width           : 28px;
		height          : 28px;
		background      : transparent;
		border          : 1px solid var(--bg3);
		border-radius   : 4px;
		color           : var(--fg4);
		cursor          : pointer;
		flex-shrink     : 0;
		transition      : background 0.15s, color 0.15s, border-color 0.15s;
	}
	.flip-back-btn:hover {
		background   : var(--bg1);
		color        : var(--fg1);
		border-color : var(--bg4);
	}
	.flip-back-btn svg { width: 16px; height: 16px; }
	.back-title {
		font-size      : 1rem;
		font-weight    : 700;
		color          : var(--fg2);
		text-transform : uppercase;
		letter-spacing : 0.1em;
	}
	.status-pill {
		font-size     : 0.78rem;
		color         : var(--fg4);
		background    : var(--bg1);
		border        : 1px solid var(--bg2);
		border-radius : 20px;
		padding       : 3px 12px;
		white-space   : nowrap;
	}

	.enroll-error {
		background    : color-mix(in srgb, var(--bright-red) 15%, var(--bg0));
		border        : 1px solid var(--bright-red);
		border-radius : 4px;
		padding       : 10px 14px;
		font-size     : 0.85rem;
		color         : var(--bright-red);
		margin-bottom : 20px;
		line-height   : 1.5;
	}

	/* ── Vertical timeline ──────────────────────────────────────────── */
	.timeline {
		display        : flex;
		flex-direction : column;
	}

	.tl-item {
		display : flex;
		gap     : 18px;
	}

	/* Left column: circle + connecting line */
	.tl-left {
		display        : flex;
		flex-direction : column;
		align-items    : center;
		flex-shrink    : 0;
		width          : 28px;
	}

	.tl-circle {
		width          : 28px;
		height         : 28px;
		border-radius  : 50%;
		display        : flex;
		align-items    : center;
		justify-content: center;
		flex-shrink    : 0;
		transition     : background 0.35s ease, border-color 0.35s ease;
	}

	/* Circle — pending: numbered, gray */
	.tl-circle-pending {
		border     : 2px solid var(--bg3);
		background : var(--bg-hard);
		color      : var(--fg4);
	}

	/* Circle — active: blue pulse ring */
	.tl-circle-active {
		border     : 2px solid var(--bright-blue);
		background : color-mix(in srgb, var(--bright-blue) 12%, var(--bg0));
		color      : var(--bright-blue);
		animation  : tl-pulse 2.2s ease-in-out infinite;
	}

	/* Circle — done: solid green */
	.tl-circle-done {
		border     : 2px solid var(--bright-green);
		background : var(--bright-green);
		color      : var(--bg-hard);
	}

	@keyframes tl-pulse {
		0%, 100% {
			box-shadow: 0 0 0 0 color-mix(in srgb, var(--bright-blue) 55%, transparent);
		}
		50% {
			box-shadow: 0 0 0 7px transparent;
		}
	}

	.tl-check { font-size: 0.85rem; font-weight: 700; line-height: 1; }
	.tl-num   { font-size: 0.72rem; font-weight: 700; line-height: 1; }

	/* Animated dot inside active circle */
	.tl-dot {
		width         : 7px;
		height        : 7px;
		border-radius : 50%;
		background    : currentColor;
		animation     : tl-blink 1.1s ease-in-out infinite;
	}
	@keyframes tl-blink {
		0%, 100% { opacity: 1; }
		50%       { opacity: 0.25; }
	}

	/* Vertical connecting line */
	.tl-line {
		flex       : 1;
		width      : 2px;
		min-height : 12px;
		margin     : 3px 0;
		border-radius: 1px;
		transition : background 0.35s ease;
	}
	.tl-line-pending { background: var(--bg2); }
	.tl-line-done    { background: var(--bright-green); }

	/* Right column: label + detail text */
	.tl-content {
		flex           : 1;
		padding-top    : 3px;
		padding-bottom : 22px;
		min-width      : 0;
	}
	.tl-item-last .tl-content { padding-bottom: 6px; }

	.tl-label {
		display        : block;
		font-size      : 0.85rem;
		font-weight    : 600;
		color          : var(--fg2);
		margin-bottom  : 5px;
		letter-spacing : 0.01em;
	}
	.tl-label-success { color: var(--bright-green); }

	.tl-text {
		font-size   : 0.85rem;
		color       : var(--fg4);
		line-height : 1.55;
		margin      : 0;
	}
	.tl-done-text { color: var(--fg3); }
	.tl-em        { color: var(--bright-yellow); font-style: normal; }

	.tl-code {
		color       : var(--bright-yellow);
		font-family : inherit;
	}

	/* Confirm-install action button */
	.action-btn {
		display       : inline-block;
		margin-top    : 8px;
		background    : var(--green);
		color         : var(--fg0);
		border        : none;
		border-radius : 3px;
		padding       : 9px 22px;
		font-family   : inherit;
		font-size     : 0.9rem;
		cursor        : pointer;
		transition    : background 0.15s;
		white-space   : nowrap;
	}
	.action-btn:hover { background: var(--bright-green); }

	/* ── Download button (shared by all cards) ──────────────────────── */
	.dl-btn {
		display         : inline-flex;
		align-items     : center;
		gap             : 7px;
		background      : var(--blue);
		color           : var(--fg0);
		border          : none;
		border-radius   : 4px;
		padding         : 12px 28px;
		font-family     : inherit;
		font-size       : 1rem;
		text-decoration : none;
		white-space     : nowrap;
		flex-shrink     : 0;
		cursor          : pointer;
		transition      : background 0.15s;
	}
	.dl-btn:hover       { background: var(--bright-blue); text-decoration: none; }
	.dl-btn-pending     { background: var(--orange); font-size: 0.85rem; padding: 7px 14px; }
	.dl-btn-pending:hover { background: var(--bright-orange); }

	.btn-icon { width: 16px; height: 16px; flex-shrink: 0; }

	/* ── Secondary app cards ────────────────────────────────────────── */
	.app-card {
		display       : flex;
		align-items   : center;
		gap           : 14px;
		background    : var(--bg0);
		border        : 1px solid var(--bg2);
		border-radius : 4px;
		padding       : 16px 18px;
		transition    : border-color 0.15s;
	}
	.app-card:hover { border-color: var(--bg3); }

	.app-icon {
		width       : 36px;
		height      : 36px;
		flex-shrink : 0;
		color       : var(--bright-aqua);
		display     : flex;
		align-items : center;
	}
	.app-icon svg { width: 100%; height: 100%; }

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

	/* ── Footer note ────────────────────────────────────────────────── */
	.pending-note {
		margin-top : 18px;
		font-size  : 0.8rem;
		color      : var(--bg4);
	}
</style>
