<script lang="ts">
	import { base } from '$app/paths';
	import { onMount } from 'svelte';
	import { GITHUB_RELEASE_URL } from '$lib/downloads';

	// Easter egg: type "kickass" on this page. Remove this block + static/easter.js to revert.
	onMount(() => {
		const s = document.createElement('script');
		s.id = 'easter-egg-script';
		s.src = `${base}/easter.js`;
		s.async = true;
		document.head.appendChild(s);
		return () => {
			(window as unknown as { __easterEggTeardown?: () => void }).__easterEggTeardown?.();
			s.remove();
		};
	});

	// Enrollment phase state machine:
	//   front -> install -> getting-id -> enrolling -> probe-wait
	//         -> probe-done -> csr-received -> cert-ready -> enrolled
	type Phase =
		| 'front'
		| 'install'
		| 'getting-id'
		| 'enrolling'
		| 'probe-wait'
		| 'probe-done'
		| 'csr-received'
		| 'cert-ready'
		| 'enrolled';

	const PHASE_ORDER: readonly Phase[] = [
		'install',
		'getting-id',
		'enrolling',
		'probe-wait',
		'probe-done',
		'csr-received',
		'cert-ready',
		'enrolled',
	];

	let phase = $state<Phase>('front');
	let clientId = $state<string | null>(null);
	let probeInfo = $state<{ version: string; arch: string } | null>(null);
	let statusMsg = $state('');
	let errorMsg = $state('');
	let flipped = $state(false);

	function toggleFlip(): void {
		flipped = !flipped;
		if (flipped && phase === 'front') phase = 'install';
	}

	type StepStatus = 'pending' | 'active' | 'done';
	function phaseIdx(p: Phase): number {
		return PHASE_ORDER.indexOf(p as Exclude<Phase, 'front'>);
	}
	function stepStatus(n: number): StepStatus {
		if (phase === 'front') return 'pending';
		const pi = phaseIdx(phase);
		switch (n) {
			case 1:
			case 2:
				return pi === 0 ? 'active' : 'done';
			case 3:
				return pi === 1 ? 'active' : pi > 1 ? 'done' : 'pending';
			case 4:
				return pi === 2 ? 'active' : pi > 2 ? 'done' : 'pending';
			case 5:
				return pi === 3 ? 'active' : pi > 3 ? 'done' : 'pending';
			case 6:
				return pi === 4 ? 'active' : pi > 4 ? 'done' : 'pending';
			case 7:
				if (pi === 5 || pi === 6) return 'active';
				return pi > 6 ? 'done' : 'pending';
			case 8:
				return pi === 7 ? 'done' : 'pending';
			default:
				return 'pending';
		}
	}

	function onDownloadClick(): void {
		flipped = true;
		if (phase === 'front') phase = 'install';
	}

	type DownloadState = 'idle' | 'downloading' | 'zscaler' | 'error';
	let dlState = $state<DownloadState>('idle');
	let dlError = $state('');

	async function downloadClient(): Promise<void> {
		dlState = 'downloading';
		dlError = '';

		let resp: Response;
		try {
			resp = await fetch(`${base}/support/apps/fleetshell-client.exe`);
		} catch {
			dlState = 'error';
			dlError = 'Network error -- check your connection and try again.';
			return;
		}

		const ct = resp.headers.get('content-type') ?? '';
		const cd = resp.headers.get('content-disposition') ?? '';
		const cdMatch = cd.match(/filename="?([^"]+)"?/);
		const filename = cdMatch?.[1] ?? 'fleetshell-client.exe';

		if (ct.includes('text/html')) {
			let body = '';
			try {
				body = await resp.text();
			} catch {
				/* ignore */
			}
			const lc = body.toLowerCase();
			const isZscaler =
				lc.includes('being analyzed for your protection') ||
				lc.includes('analysis can take up to') ||
				lc.includes('if safe, your file downloads automatically') ||
				lc.includes('zscaler');
			if (isZscaler) {
				dlState = 'zscaler';
			} else {
				dlState = 'error';
				dlError = `Unexpected response (HTTP ${resp.status} -- content-type: ${ct}).`;
			}
			return;
		}

		if (!resp.ok) {
			dlState = 'error';
			dlError = `Server returned HTTP ${resp.status} ${resp.statusText}.`;
			return;
		}

		try {
			const blob = await resp.blob();
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
		} catch (err) {
			dlState = 'error';
			dlError = `Could not save the file: ${String(err)}`;
			return;
		}

		dlState = 'idle';
		onDownloadClick();
	}

	async function onInstallConfirmed(): Promise<void> {
		phase = 'getting-id';
		statusMsg = 'Fetching unique client ID from portal...';
		errorMsg = '';

		let id: string;
		let token: string;
		try {
			const res = await fetch(`${base}/api/clients`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: '{}',
			});
			if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
			const body = (await res.json()) as { id: string; token: string };
			id = body.id;
			token = body.token;
		} catch (e) {
			errorMsg = `Failed to get client ID: ${e instanceof Error ? e.message : String(e)}`;
			phase = 'install';
			return;
		}

		clientId = id;
		statusMsg = `ID: ${id.slice(0, 8)}...`;
		await startEnrollment(id, token);
	}

	async function startEnrollment(id: string, token: string): Promise<void> {
		phase = 'enrolling';
		statusMsg = 'Opening probe stream...';

		const probeEvt = new EventSource(`${base}/api/probes/${id}/stream`);

		const probeGuard = setTimeout(() => {
			probeEvt.close();
			if (phase === 'enrolling' || phase === 'probe-wait') {
				statusMsg = 'No response from client -- is FleetShell Client running?';
				errorMsg = 'The client did not respond within 65 s. Ensure it is running and retry.';
			}
		}, 65_000);

		probeEvt.addEventListener('result', async (ev: Event) => {
			clearTimeout(probeGuard);
			probeEvt.close();
			const data = JSON.parse((ev as MessageEvent).data) as { version: string; arch: string };
			probeInfo = data;
			phase = 'probe-done';
			statusMsg = `Client v${data.version} \u00b7 ${data.arch}`;
			openEnrollmentStream(id);
		});

		probeEvt.addEventListener('timeout', () => {
			clearTimeout(probeGuard);
			probeEvt.close();
			statusMsg = 'Probe timed out -- client did not respond.';
			errorMsg = 'Please ensure FleetShell Client is running and try again.';
		});

		probeEvt.addEventListener('error', () => {
			/* transient; only the guard/timeout act */
		});

		await new Promise<void>((resolve) => {
			probeEvt.addEventListener('ready', () => resolve(), { once: true });
			setTimeout(() => resolve(), 3_000);
		});

		phase = 'probe-wait';
		statusMsg = 'Waiting for client to connect...';

		const payload = JSON.stringify({ type: 'enroll', payload: id, token });
		const encoded = btoa(payload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
		const anchor = document.createElement('a');
		anchor.href = `fleetshell://${encoded}`;
		anchor.style.display = 'none';
		document.body.appendChild(anchor);
		anchor.click();
		document.body.removeChild(anchor);
	}

	function openEnrollmentStream(id: string): void {
		statusMsg = 'Waiting for certificate signing request...';
		const evtSource = new EventSource(`${base}/api/enrollment/${id}/stream`);

		const guard = setTimeout(() => {
			evtSource.close();
			if (phase !== 'enrolled') statusMsg = 'Enrollment timed out. Please restart the process.';
		}, 5 * 60_000 + 10_000);

		evtSource.addEventListener('csr-received', () => {
			phase = 'csr-received';
			statusMsg = 'Certificate signing request received -- issuing certificate...';
		});
		evtSource.addEventListener('cert-ready', () => {
			phase = 'cert-ready';
			statusMsg = 'Certificate issued -- waiting for client to confirm receipt...';
		});
		evtSource.addEventListener('enrollment-confirmed', () => {
			clearTimeout(guard);
			evtSource.close();
			phase = 'enrolled';
			statusMsg = 'Enrollment complete!';
		});
		evtSource.addEventListener('timeout', () => {
			clearTimeout(guard);
			evtSource.close();
			if (phase !== 'enrolled') statusMsg = 'Enrollment stream timed out.';
		});
		evtSource.addEventListener('error', () => {
			/* transient */
		});
	}
</script>

<svelte:head><title>Support -- FleetShell Portal</title></svelte:head>

<div class="page">
	<h1 class="page-title">Support &amp; Downloads</h1>
	<p class="subtitle">Install the tools you need to connect to and manage remote devices.</p>

	<div class="main-grid">
		<div class="featured-flipper">
			<div class="card-inner" class:flipped>
				<!-- Front face -->
				<div
					class="card-face card-front"
					role="button"
					tabindex="0"
					onclick={toggleFlip}
					onkeydown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') toggleFlip();
					}}
				>
					<div class="front-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
							<rect x="2" y="2" width="20" height="8" rx="2" />
							<rect x="2" y="14" width="20" height="8" rx="2" />
							<line x1="6" y1="6" x2="6.01" y2="6" />
							<line x1="6" y1="18" x2="6.01" y2="18" />
						</svg>
					</div>
					<h2 class="front-title">FleetShell Client</h2>
					<p class="front-desc">Please download the client application and follow the steps on the flip side of this card.</p>

					<button class="dl-btn" type="button" disabled={dlState === 'downloading'} onclick={(e) => { e.stopPropagation(); downloadClient(); }}>
						<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
							<polyline points="7 10 12 15 17 10" />
							<line x1="12" y1="15" x2="12" y2="3" />
						</svg>
						{#if dlState === 'downloading'}Checking...{:else}Download FleetShell Client{/if}
					</button>

					{#if dlState === 'zscaler'}
						<div class="dl-notice dl-notice-scan">
							<strong>Security scanner is checking the file</strong>
							<p>Your organisation's security policy (ZScaler) is scanning the installer for threats. This can take <strong>up to 10 minutes</strong>. If the file is safe the download will start automatically next time you click the button -- just wait a few minutes and retry.</p>
							{#if GITHUB_RELEASE_URL}
								<p>Alternatively, download directly from GitHub where the file may already have been scanned and cleared:</p>
								<a class="dl-notice-link" href={GITHUB_RELEASE_URL} target="_blank" rel="noopener noreferrer">Download from GitHub</a>
							{/if}
							<button class="dl-notice-dismiss" type="button" onclick={() => (dlState = 'idle')}>Dismiss</button>
						</div>
					{:else if dlState === 'error'}
						<div class="dl-notice dl-notice-error">
							<strong>Download failed</strong>
							<p>{dlError}</p>
							{#if GITHUB_RELEASE_URL}
								<a class="dl-notice-link" href={GITHUB_RELEASE_URL} target="_blank" rel="noopener noreferrer">Try downloading from GitHub</a>
							{/if}
							<button class="dl-notice-dismiss" type="button" onclick={() => (dlState = 'idle')}>Dismiss</button>
						</div>
					{/if}
				</div>

				<!-- Back face -->
				<div class="card-face card-back">
					<div class="back-header">
						<h2 class="back-title">Enrollment Steps</h2>
						<div class="back-header-right">
							{#if statusMsg}<span class="status-pill">{statusMsg}</span>{/if}
							<button class="flip-back-btn" type="button" onclick={toggleFlip} title="Flip to front">
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<polyline points="15 18 9 12 15 6" />
								</svg>
							</button>
						</div>
					</div>

					{#if errorMsg}<div class="enroll-error" role="alert">{errorMsg}</div>{/if}

					<div class="timeline">
						{#each [1, 2, 3, 4, 5, 6, 7] as n (n)}
							<div class="tl-item">
								<div class="tl-left">
									<div class="tl-circle tl-circle-{stepStatus(n)}">
										{#if stepStatus(n) === 'done'}<span class="tl-check">&#10003;</span>
										{:else if stepStatus(n) === 'active'}<span class="tl-dot"></span>
										{:else}<span class="tl-num">{n}</span>{/if}
									</div>
									<div class="tl-line tl-line-{stepStatus(n) === 'done' ? 'done' : 'pending'}"></div>
								</div>
								<div class="tl-content">
									{#if n === 1}
										<span class="tl-label">Install</span>
										{#if stepStatus(1) !== 'pending'}<p class="tl-text">Start the installer once it has been downloaded. After successful installation please press the button below.</p>{/if}
									{:else if n === 2}
										<span class="tl-label">Confirm Installation</span>
										{#if stepStatus(2) === 'active'}<button class="action-btn" type="button" onclick={onInstallConfirmed}>Client installed successfully</button>
										{:else if stepStatus(2) === 'done'}<p class="tl-text tl-done-text">Installation confirmed.</p>{/if}
									{:else if n === 3}
										<span class="tl-label">Unique Client ID</span>
										{#if stepStatus(3) === 'active'}<p class="tl-text">Retrieving your unique client ID from the portal...</p>
										{:else if stepStatus(3) === 'done'}<p class="tl-text tl-done-text">ID:&nbsp;<code class="tl-code">{clientId?.slice(0, 8)}...</code></p>{/if}
									{:else if n === 4}
										<span class="tl-label">Enrollment Started</span>
										{#if stepStatus(4) === 'active'}<p class="tl-text">Enrollment started. Please accept the browser's request to <strong class="tl-em">"Open fleetshell-client"</strong> and check the box to always allow the portal to open links of this type.</p>
										{:else if stepStatus(4) === 'done'}<p class="tl-text tl-done-text">Enrollment request sent to client.</p>{/if}
									{:else if n === 5}
										<span class="tl-label">Client Connected</span>
										{#if stepStatus(5) === 'active'}<p class="tl-text">Waiting for the FleetShell Client to connect...</p>
										{:else if stepStatus(5) === 'done'}<p class="tl-text tl-done-text">{#if probeInfo}v{probeInfo.version} \u00b7 {probeInfo.arch}{:else}Client connected to the portal.{/if}</p>{/if}
									{:else if n === 6}
										<span class="tl-label">Certificate Signing Request</span>
										{#if stepStatus(6) === 'active'}<p class="tl-text">Waiting for client certificate signing request...</p>
										{:else if stepStatus(6) === 'done'}<p class="tl-text tl-done-text">Certificate signing request received.</p>{/if}
									{:else if n === 7}
										<span class="tl-label">Certificate Issued</span>
										{#if stepStatus(7) === 'active'}<p class="tl-text">{#if phase === 'csr-received'}Certificate being issued...{:else}Waiting for client to confirm certificate receipt...{/if}</p>
										{:else if stepStatus(7) === 'done'}<p class="tl-text tl-done-text">Certificate receipt confirmed.</p>{/if}
									{/if}
								</div>
							</div>
						{/each}

						<div class="tl-item tl-item-last">
							<div class="tl-left">
								<div class="tl-circle tl-circle-{stepStatus(8)}">
									{#if stepStatus(8) === 'done'}<span class="tl-check">&#10003;</span>{:else}<span class="tl-num">8</span>{/if}
								</div>
							</div>
							<div class="tl-content">
								<span class="tl-label" class:tl-label-success={stepStatus(8) === 'done'}>
									{stepStatus(8) === 'done' ? 'Client Successfully Enrolled' : 'Enrollment Complete'}
								</span>
								{#if stepStatus(8) === 'done'}
									<p class="tl-text tl-done-text">The client has been enrolled and has its certificate. You can now create tunnels from the <a href={`${base}/devices`}>Devices</a> page.</p>
								{/if}
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>

		<!-- Secondary download cards -- temporarily hidden (confused testers).
		     Re-enable when VNC/TeamViewer/SSH downloads are ready.
		{#each [
			{ name: 'VNC Viewer', desc: 'Remote desktop viewer for VNC-capable devices.', file: 'vnc-viewer.exe' },
			{ name: 'TeamViewer Client', desc: 'Remote support and control via TeamViewer.', file: 'teamviewer-client.exe' },
			{ name: 'SSH Terminal', desc: 'Secure shell access to command-line interfaces on remote devices.', file: 'ssh-terminal.exe' },
		] as app (app.file)}
			<div class="app-card">
				<div class="app-icon" aria-hidden="true">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
						<rect x="2" y="3" width="20" height="14" rx="2" />
						<line x1="8" y1="21" x2="16" y2="21" />
						<line x1="12" y1="17" x2="12" y2="21" />
					</svg>
				</div>
				<div class="app-info">
					<span class="app-name">{app.name}</span>
					<span class="app-desc">{app.desc}</span>
				</div>
				<a class="dl-btn dl-btn-pending" href={`${base}/support/apps/${app.file}`} download>
					<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
						<polyline points="7 10 12 15 17 10" />
						<line x1="12" y1="15" x2="12" y2="3" />
					</svg>
					Download
				</a>
			</div>
		{/each}
		-->
	</div>

	<!-- <p class="pending-note">Links marked in amber will be updated once the final filenames are confirmed.</p> -->
</div>

<style>
	.page { max-width: 860px; --ok: #8ec07c; --warn: #d8a657; }
	.page-title { font-size: 1.1rem; font-weight: 700; color: var(--text); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 6px; }
	.subtitle { font-size: 0.9rem; color: var(--text-subtle); margin-bottom: 28px; }

	.main-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }

	.featured-flipper { grid-column: 1 / -1; perspective: 1200px; }
	.card-inner { display: grid; transform-style: preserve-3d; transition: transform 0.65s cubic-bezier(0.4, 0, 0.2, 1); }
	.card-inner.flipped { transform: rotateY(180deg); }
	.card-face { grid-area: 1 / 1; backface-visibility: hidden; -webkit-backface-visibility: hidden; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; }
	.card-back { transform: rotateY(180deg); }

	.card-front { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px; padding: 56px 48px; text-align: center; cursor: pointer; }
	.card-front:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; border-radius: 6px; }
	.front-icon { width: 72px; height: 72px; color: var(--accent); }
	.front-icon svg { width: 100%; height: 100%; }
	.front-title { font-size: 1.7rem; font-weight: 700; color: var(--text); }
	.front-desc { font-size: 1rem; color: var(--text-muted); line-height: 1.65; max-width: 520px; }

	.card-back { padding: 32px 36px 36px; }
	.back-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 28px; }
	.back-header-right { display: flex; align-items: center; gap: 10px; }
	.flip-back-btn { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; background: transparent; border: 1px solid var(--border); border-radius: 4px; color: var(--text-subtle); cursor: pointer; flex-shrink: 0; }
	.flip-back-btn:hover { background: var(--surface-2); color: var(--text); border-color: var(--border); }
	.flip-back-btn svg { width: 16px; height: 16px; }
	.back-title { font-size: 1rem; font-weight: 700; color: var(--text); text-transform: uppercase; letter-spacing: 0.1em; }
	.status-pill { font-size: 0.78rem; color: var(--text-subtle); background: var(--surface-2); border: 1px solid var(--border); border-radius: 20px; padding: 3px 12px; white-space: nowrap; }

	.enroll-error { background: color-mix(in srgb, var(--danger) 15%, var(--surface)); border: 1px solid var(--danger); border-radius: 4px; padding: 10px 14px; font-size: 0.85rem; color: var(--danger); margin-bottom: 20px; line-height: 1.5; }

	.timeline { display: flex; flex-direction: column; }
	.tl-item { display: flex; gap: 18px; }
	.tl-left { display: flex; flex-direction: column; align-items: center; flex-shrink: 0; width: 28px; }
	.tl-circle { width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: background 0.35s ease, border-color 0.35s ease; }
	.tl-circle-pending { border: 2px solid var(--border); background: var(--bg-app); color: var(--text-subtle); }
	.tl-circle-active { border: 2px solid var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--surface)); color: var(--accent); animation: tl-pulse 2.2s ease-in-out infinite; }
	.tl-circle-done { border: 2px solid var(--ok); background: var(--ok); color: var(--bg-app); }
	@keyframes tl-pulse { 0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 55%, transparent); } 50% { box-shadow: 0 0 0 7px transparent; } }
	.tl-check { font-size: 0.85rem; font-weight: 700; line-height: 1; }
	.tl-num { font-size: 0.72rem; font-weight: 700; line-height: 1; }
	.tl-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; animation: tl-blink 1.1s ease-in-out infinite; }
	@keyframes tl-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
	.tl-line { flex: 1; width: 2px; min-height: 12px; margin: 3px 0; border-radius: 1px; transition: background 0.35s ease; }
	.tl-line-pending { background: var(--border); }
	.tl-line-done { background: var(--ok); }
	.tl-content { flex: 1; padding-top: 3px; padding-bottom: 22px; min-width: 0; }
	.tl-item-last .tl-content { padding-bottom: 6px; }
	.tl-label { display: block; font-size: 0.85rem; font-weight: 600; color: var(--text); margin-bottom: 5px; letter-spacing: 0.01em; }
	.tl-label-success { color: var(--ok); }
	.tl-text { font-size: 0.85rem; color: var(--text-subtle); line-height: 1.55; margin: 0; }
	.tl-text a { color: var(--accent); }
	.tl-done-text { color: var(--text-muted); }
	.tl-em { color: var(--warn); font-style: normal; }
	.tl-code { color: var(--warn); font-family: inherit; }

	.action-btn { display: inline-block; margin-top: 8px; background: var(--ok); color: var(--bg-app); border: none; border-radius: 3px; padding: 9px 22px; font-family: inherit; font-size: 0.9rem; cursor: pointer; white-space: nowrap; }
	.action-btn:hover { filter: brightness(1.08); }

	.dl-btn { display: inline-flex; align-items: center; gap: 7px; background: var(--accent); color: var(--on-accent); border: none; border-radius: 4px; padding: 12px 28px; font-family: inherit; font-size: 1rem; text-decoration: none; white-space: nowrap; flex-shrink: 0; cursor: pointer; transition: background 0.15s; }
	.dl-btn:hover { background: var(--accent-hover); text-decoration: none; }
	.dl-btn-pending { background: var(--warn); color: #1c1c1c; font-size: 0.85rem; padding: 7px 14px; }
	.dl-btn-pending:hover { filter: brightness(1.06); background: var(--warn); }
	.dl-btn:disabled { opacity: 0.65; cursor: not-allowed; }

	.dl-notice { margin-top: 0.9rem; padding: 1rem 1.1rem; border-radius: 8px; font-size: 0.85rem; line-height: 1.6; display: flex; flex-direction: column; gap: 0.55rem; text-align: left; }
	.dl-notice > strong { display: block; font-size: 0.88rem; }
	.dl-notice p { margin: 0; color: var(--text-muted); }
	.dl-notice-scan { background: color-mix(in srgb, var(--warn) 10%, var(--surface)); border: 1px solid var(--warn); }
	.dl-notice-scan strong { color: var(--warn); }
	.dl-notice-error { background: color-mix(in srgb, var(--danger) 10%, var(--surface)); border: 1px solid var(--danger); }
	.dl-notice-error strong { color: var(--danger); }
	.dl-notice-link { color: var(--accent); text-decoration: none; font-weight: 600; font-size: 0.85rem; }
	.dl-notice-link:hover { text-decoration: underline; }
	.dl-notice-dismiss { align-self: flex-start; background: transparent; border: 1px solid var(--border); border-radius: 4px; padding: 0.25rem 0.7rem; font-size: 0.78rem; color: var(--text-subtle); cursor: pointer; font-family: inherit; }
	.dl-notice-dismiss:hover { border-color: var(--text-muted); color: var(--text); }

	.btn-icon { width: 16px; height: 16px; flex-shrink: 0; }

	.app-card { display: flex; align-items: center; gap: 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: 16px 18px; transition: border-color 0.15s; }
	.app-card:hover { border-color: var(--text-subtle); }
	.app-icon { width: 36px; height: 36px; flex-shrink: 0; color: var(--accent); display: flex; align-items: center; }
	.app-icon svg { width: 100%; height: 100%; }
	.app-info { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
	.app-name { font-size: 0.95rem; font-weight: 600; color: var(--text); }
	.app-desc { font-size: 0.8rem; color: var(--text-subtle); line-height: 1.4; }

	.pending-note { margin-top: 18px; font-size: 0.8rem; color: var(--text-subtle); }

	@media (max-width: 60rem) { .main-grid { grid-template-columns: 1fr; } }
</style>
