<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import type Guac from 'guacamole-common-js';

	const wsUrl = $derived($page.url.searchParams.get('ws') ?? '');

	// ── Session type detection ─────────────────────────────────────────────────
	// The devices page appends ?proto=ssh when opening an xterm.js SSH session.
	// As a fallback, detect from the WebSocket path itself (/ssh-ws vs /guac-ws).
	const isSsh = $derived(
		$page.url.searchParams.get('proto') === 'ssh' ||
		wsUrl.includes('/ssh-ws'),
	);

	// ── Constants ─────────────────────────────────────────────────────────────
	const TOOLBAR_W  = 44;
	const CANVAS_PAD = 8;
	const SCALE_STEPS = [0.10, 0.20, 0.25, 0.33, 0.40, 0.50, 0.67, 0.75, 1.00, 1.25, 1.50, 2.00];

	// SSH font-size steps (px)
	const FONT_STEPS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 28];
	const FONT_DEFAULT = 15;

	// ── Shared state ──────────────────────────────────────────────────────────
	let container:  HTMLDivElement | undefined = $state();
	let toolbarEl:  HTMLElement    | undefined = $state();
	let statusText  = $state('Connecting…');
	let isConnected = $state(false);
	let isError     = $state(false);
	let cleanupFn:  (() => void) | undefined;

	// ── Guacamole state ───────────────────────────────────────────────────────
	let scale   = $state(1.0);
	let fitMode = $state(true);
	const scalePercent = $derived(Math.round(scale * 100));
	let displayRef: InstanceType<typeof Guac.Display> | undefined;
	let clientRef:  InstanceType<typeof Guac.Client>  | undefined;
	let GuacLib:    typeof Guac | undefined;

	// ── SSH / xterm state ─────────────────────────────────────────────────────
	let termEl:   HTMLDivElement | undefined = $state();
	let fontSize  = $state(FONT_DEFAULT);

	// ── Guac scale helpers ─────────────────────────────────────────────────────

	function applyScale(s: number): void {
		scale = s;
		if (!displayRef || !container) return;
		displayRef.scale(s);
		const w = Math.round(displayRef.getWidth()  * s);
		const h = Math.round(displayRef.getHeight() * s);
		if (w > 0 && h > 0) {
			container.style.width  = `${w}px`;
			container.style.height = `${h}px`;
		}
	}

	function calcFitScale(): number {
		const dw = displayRef?.getWidth()  ?? 0;
		const dh = displayRef?.getHeight() ?? 0;
		if (dw === 0 || dh === 0) return 1;
		const toolbarW = toolbarEl?.getBoundingClientRect().width ?? TOOLBAR_W;
		const aw = window.innerWidth  - toolbarW - CANVAS_PAD * 2 - 1;
		const ah = window.innerHeight - CANVAS_PAD * 2 - 1;
		return Math.min(aw / dw, ah / dh);
	}

	function setFit(): void  { fitMode = true;  applyScale(calcFitScale()); }
	function setActual(): void { fitMode = false; applyScale(1.0); }

	function zoomIn(): void {
		fitMode = false;
		const next = SCALE_STEPS.find(s => s > scale + 0.005) ?? SCALE_STEPS.at(-1)!;
		applyScale(next);
	}

	function zoomOut(): void {
		fitMode = false;
		const prev = [...SCALE_STEPS].reverse().find(s => s < scale - 0.005) ?? SCALE_STEPS[0];
		applyScale(prev);
	}

	// ── SSH font-size helpers ─────────────────────────────────────────────────

	function fontIncrease(): void {
		const next = FONT_STEPS.find(s => s > fontSize);
		if (next) fontSize = next;
	}

	function fontDecrease(): void {
		const prev = [...FONT_STEPS].reverse().find(s => s < fontSize);
		if (prev) fontSize = prev;
	}

	// ── Shared toolbar actions ─────────────────────────────────────────────────

	function toggleFullscreen(): void {
		if (!document.fullscreenElement) {
			document.documentElement.requestFullscreen().catch(() => {});
		} else {
			document.exitFullscreen().catch(() => {});
		}
	}

	async function pasteToRemote(): Promise<void> {
		if (!clientRef || !GuacLib) return;
		let text: string;
		try { text = await navigator.clipboard.readText(); }
		catch { return; }
		if (!text) return;
		const stream = clientRef.createClipboardStream('text/plain');
		const writer = new GuacLib.StringWriter(stream);
		writer.sendText(text);
		writer.sendEnd();
	}

	function disconnectSession(): void {
		clientRef?.disconnect();
		cleanupFn?.();
		window.close();
	}

	// ── Guac resize/fullscreen handlers ──────────────────────────────────────
	function onWindowResize(): void   { if (fitMode) applyScale(calcFitScale()); }
	function onFullscreenChange(): void { if (fitMode) applyScale(calcFitScale()); }

	// ── SSH framing helpers ────────────────────────────────────────────────────
	//
	// Wire protocol (client → gateway, after 200 CONNECTED):
	//   [0x00][len_hi][len_lo][...data]   keyboard input → PTY stdin
	//   [0x01][0x00][0x04][rows_hi][rows_lo][cols_hi][cols_lo]  PTY resize

	function sshFrameData(ws: WebSocket, data: string): void {
		const bytes  = new TextEncoder().encode(data);
		const frame  = new Uint8Array(3 + bytes.length);
		frame[0]     = 0x00;
		frame[1]     = (bytes.length >> 8) & 0xff;
		frame[2]     = bytes.length & 0xff;
		frame.set(bytes, 3);
		ws.send(frame);
	}

	function sshFrameResize(ws: WebSocket, rows: number, cols: number): void {
		ws.send(new Uint8Array([
			0x01, 0x00, 0x04,
			(rows >> 8) & 0xff, rows & 0xff,
			(cols >> 8) & 0xff, cols & 0xff,
		]));
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	onMount(() => {
		window.addEventListener('resize', onWindowResize);
		document.addEventListener('fullscreenchange', onFullscreenChange);

		if (isSsh) {
			// ── SSH / xterm.js path ─────────────────────────────────────────
			(async () => {
				if (!wsUrl) { statusText = 'No session URL.'; isError = true; return; }

				// Load all addons in parallel with the terminal core.
				const [
					{ Terminal },
					{ FitAddon },
					{ WebglAddon },
					{ ImageAddon },
					{ Unicode11Addon },
					{ UnicodeGraphemesAddon },
				] = await Promise.all([
					import('@xterm/xterm'),
					import('@xterm/addon-fit'),
					import('@xterm/addon-webgl'),
					import('@xterm/addon-image'),
					import('@xterm/addon-unicode11'),
					import('@xterm/addon-unicode-graphemes'),
				]);

				// Wait for all four Victor Mono NF faces to be ready before
				// opening the terminal.  Without this, xterm.js measures glyph
				// widths before the font loads and the cell grid is wrong.
				const FontFaceObserver = (await import('fontfaceobserver')).default;
				try {
					await Promise.all([
						new FontFaceObserver('Victor Mono NF', { weight: 'normal', style: 'normal' }).load(null, 5000),
						new FontFaceObserver('Victor Mono NF', { weight: 'bold',   style: 'normal' }).load(null, 5000),
						new FontFaceObserver('Victor Mono NF', { weight: 'normal', style: 'italic' }).load(null, 5000),
						new FontFaceObserver('Victor Mono NF', { weight: 'bold',   style: 'italic' }).load(null, 5000),
					]);
				} catch {
					// Font load timed out or failed — proceed anyway with fallback.
					console.warn('Victor Mono NF font load timed out, proceeding with fallback');
				}

				const term = new Terminal({
					cursorBlink:      true,
					cursorStyle:      'block',
					fontSize:         FONT_DEFAULT,
					fontFamily:       '"Victor Mono NF", "Victor Mono", monospace',
					fontWeight:       '400',
					fontWeightBold:   '600',
					lineHeight:       1.0,
					scrollback:       5000,
					allowProposedApi: true,   // required by ImageAddon and UnicodeGraphemesAddon
					theme: {
						background:  '#1d2021',
						foreground:  '#ebdbb2',
						cursor:      '#ebdbb2',
						black:       '#282828', brightBlack:   '#928374',
						red:         '#cc241d', brightRed:     '#fb4934',
						green:       '#98971a', brightGreen:   '#b8bb26',
						yellow:      '#d79921', brightYellow:  '#fabd2f',
						blue:        '#458588', brightBlue:    '#83a598',
						magenta:     '#b16286', brightMagenta: '#d3869b',
						cyan:        '#689d6a', brightCyan:    '#8ec07c',
						white:       '#a89984', brightWhite:   '#ebdbb2',
					},
				});

				// Load addons before open() so they are active from the first render.
				const fit = new FitAddon();
				term.loadAddon(fit);
				term.loadAddon(new Unicode11Addon());
				term.loadAddon(new UnicodeGraphemesAddon());
				term.loadAddon(new ImageAddon());
				// Activate Unicode 11 character width tables.
				term.unicode.activeVersion = '11';

				if (!termEl) return;
				term.open(termEl);

				// WebGL renderer — falls back to canvas automatically if WebGL is
				// unavailable (e.g. headless browser, software rendering).
				try {
					term.loadAddon(new WebglAddon());
				} catch {
					console.warn('WebGL renderer unavailable, using canvas fallback');
				}

				fit.fit();

				// ── WebSocket connection ──────────────────────────────────────
				const ws = new WebSocket(wsUrl);
				ws.binaryType = 'arraybuffer';

				ws.onopen = () => {
					isConnected = true;
					statusText  = '';
					// Send initial size immediately after connect.
					sshFrameResize(ws, term.rows, term.cols);
				};

				ws.onmessage = (e: MessageEvent) => {
					term.write(new Uint8Array(e.data as ArrayBuffer));
				};

				ws.onerror = () => {
					statusText = 'WebSocket error';
					isError    = true;
				};

				ws.onclose = () => {
					isConnected = false;
					if (!isError) statusText = 'Disconnected';
				};

				// ── Keyboard input ────────────────────────────────────────────
				term.onData((data: string) => {
					if (ws.readyState === WebSocket.OPEN) {
						sshFrameData(ws, data);
					}
				});

				// ── Font-size reactivity ──────────────────────────────────────
				// Watch the `fontSize` state variable and update the terminal.
				// We use an effect inside onMount; cleanupFn tears it down.
				let prevFontSize = fontSize;
				const fontInterval = setInterval(() => {
					if (fontSize !== prevFontSize) {
						prevFontSize = fontSize;
						term.options.fontSize = fontSize;
						fit.fit();
						if (ws.readyState === WebSocket.OPEN) {
							sshFrameResize(ws, term.rows, term.cols);
						}
					}
				}, 100);

				// ── Responsive resize ─────────────────────────────────────────
				const ro = new ResizeObserver(() => {
					fit.fit();
					if (ws.readyState === WebSocket.OPEN) {
						sshFrameResize(ws, term.rows, term.cols);
					}
				});
				if (termEl) ro.observe(termEl);

				// Fullscreen resize
				const onFsChange = () => { fit.fit(); };
				document.addEventListener('fullscreenchange', onFsChange);

				cleanupFn = () => {
					clearInterval(fontInterval);
					ro.disconnect();
					document.removeEventListener('fullscreenchange', onFsChange);
					ws.close();
					term.dispose();
				};
			})();
		} else {
			// ── Guacamole path (unchanged) ──────────────────────────────────
			(async () => {
				if (!wsUrl) { statusText = 'No session URL provided.'; isError = true; return; }

				const Guacamole = (await import('guacamole-common-js')).default;
				GuacLib = Guacamole;

				const qmark    = wsUrl.indexOf('?');
				const baseUrl  = qmark >= 0 ? wsUrl.slice(0, qmark) : wsUrl;
				const connData = qmark >= 0 ? wsUrl.slice(qmark + 1) : '';

				const tunnel = new Guacamole.WebSocketTunnel(baseUrl);
				const client = new Guacamole.Client(tunnel);
				clientRef = client;

				const display = client.getDisplay();
				displayRef = display;

				const displayEl: HTMLElement = display.getElement();
				displayEl.style.cursor = 'default';
				container?.appendChild(displayEl);

				display.onresize = () => {
					if (fitMode) applyScale(calcFitScale());
				};

				client.onstatechange = (state: number) => {
					switch (state) {
						case 1: statusText = 'Connecting…';          isConnected = false; break;
						case 2: statusText = 'Waiting for session…'; isConnected = false; break;
						case 3: statusText = '';                      isConnected = true;  break;
						case 4: statusText = 'Disconnecting…';       isConnected = false; break;
						case 5: statusText = 'Session ended.';       isConnected = false; break;
					}
				};

				tunnel.onerror = (status: { code?: number; message?: string }) => {
					statusText = `Connection error: ${status?.message ?? `code ${status?.code}`}`;
					isError = true;
				};
				client.onerror = (status: { code?: number; message?: string }) => {
					statusText = `Session error: ${status?.message ?? `code ${status?.code}`}`;
					isError = true;
				};

				client.onaudio = (stream: unknown, mimetype: string) => {
					const player = Guacamole.AudioPlayer.getInstance(stream, mimetype);
					if (!player) {
						(stream as any).sendAck('UNSUPPORTED',
							Guacamole.Status.Code.UNSUPPORTED ?? 0x100);
					}
				};

				client.onclipboard = (stream: unknown, mimetype: string) => {
					if (mimetype !== 'text/plain') return;
					const reader = new Guacamole.StringReader(stream);
					let text = '';
					reader.ontext = (chunk: string) => { text += chunk; };
					reader.onend  = () => { navigator.clipboard.writeText(text).catch(() => {}); };
				};

				const mouse = new Guacamole.Mouse(displayEl);
				const sendMouse = (state: unknown) => client.sendMouseState(state, true);
				mouse.onmousedown = sendMouse;
				mouse.onmouseup   = sendMouse;
				mouse.onmousemove = sendMouse;

				const keyboard = new Guacamole.Keyboard(document);
				keyboard.onkeydown = (keysym: number) => client.sendKeyEvent(1, keysym);
				keyboard.onkeyup   = (keysym: number) => client.sendKeyEvent(0, keysym);

				client.connect(connData);

				cleanupFn = () => {
					keyboard.onkeydown = null;
					keyboard.onkeyup   = null;
					client.disconnect();
				};
			})();
		}

		return () => {
			window.removeEventListener('resize', onWindowResize);
			document.removeEventListener('fullscreenchange', onFullscreenChange);
			cleanupFn?.();
		};
	});
</script>

<svelte:head>
	<title>{isSsh ? 'SSH Session' : 'Remote Session'} — FleetShell</title>
</svelte:head>

<div class="session-shell">

	<!-- ── Left toolbar ───────────────────────────────────────────────────── -->
	<nav class="toolbar" bind:this={toolbarEl} aria-label="Session controls">

		{#if isSsh}
			<!-- ── SSH toolbar: font-size controls ────────────────────────── -->
			<button class="tbtn" title="Decrease font size" onclick={fontDecrease}>
				<svg viewBox="0 0 16 16" fill="none" stroke="currentColor"
				     stroke-width="1.5" stroke-linecap="round"
				     width="16" height="16" aria-hidden="true">
					<!-- small A -->
					<text x="2" y="14" font-size="10" fill="currentColor" stroke="none"
					      font-family="monospace">A</text>
					<line x1="9" y1="10" x2="15" y2="10"/>
				</svg>
			</button>

			<span class="scale-label" title="Font size">{fontSize}px</span>

			<button class="tbtn" title="Increase font size" onclick={fontIncrease}>
				<svg viewBox="0 0 16 16" fill="none" stroke="currentColor"
				     stroke-width="1.5" stroke-linecap="round"
				     width="16" height="16" aria-hidden="true">
					<!-- large A -->
					<text x="1" y="15" font-size="13" fill="currentColor" stroke="none"
					      font-family="monospace">A</text>
					<line x1="10" y1="7"  x2="15" y2="7"/>
					<line x1="12.5" y1="4" x2="12.5" y2="10"/>
				</svg>
			</button>

		{:else}
			<!-- ── Guac toolbar: zoom controls ────────────────────────────── -->
			<button
				class="tbtn"
				class:tbtn--active={fitMode}
				title="Fit to window"
				onclick={setFit}
			>
				<svg viewBox="0 0 16 16" fill="none" stroke="currentColor"
				     stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
				     width="19" height="19" aria-hidden="true">
					<line x1="2"  y1="2"  x2="7"  y2="7"/><polyline points="2,4 2,2 4,2"/>
					<line x1="14" y1="2"  x2="9"  y2="7"/><polyline points="14,4 14,2 12,2"/>
					<line x1="14" y1="14" x2="9"  y2="9"/><polyline points="14,12 14,14 12,14"/>
					<line x1="2"  y1="14" x2="7"  y2="9"/><polyline points="2,12 2,14 4,14"/>
				</svg>
			</button>

			<button
				class="tbtn tbtn--sm"
				class:tbtn--active={!fitMode && scale === 1.0}
				title="Actual size (100%)"
				onclick={setActual}
			>1:1</button>

			<button class="tbtn" title="Zoom in" onclick={zoomIn}>
				<svg viewBox="0 0 16 16" fill="none" stroke="currentColor"
				     stroke-width="1.75" stroke-linecap="round"
				     width="16" height="16" aria-hidden="true">
					<line x1="8" y1="2" x2="8" y2="14"/>
					<line x1="2" y1="8" x2="14" y2="8"/>
				</svg>
			</button>
			<span class="scale-label" title="Current zoom level">{scalePercent}%</span>
			<button class="tbtn" title="Zoom out" onclick={zoomOut}>
				<svg viewBox="0 0 16 16" fill="none" stroke="currentColor"
				     stroke-width="1.75" stroke-linecap="round"
				     width="16" height="16" aria-hidden="true">
					<line x1="2" y1="8" x2="14" y2="8"/>
				</svg>
			</button>

			<div class="sep"></div>

			<button class="tbtn" title="Paste local clipboard to remote" onclick={pasteToRemote}>
				<svg viewBox="0 0 16 16" fill="none" stroke="currentColor"
				     stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
				     width="19" height="19" aria-hidden="true">
					<rect x="4" y="5" width="8" height="9" rx="1"/>
					<path d="M6 5V4a2 2 0 014 0v1"/>
					<line x1="6" y1="9"    x2="10" y2="9"/>
					<line x1="6" y1="11.5" x2="9"  y2="11.5"/>
				</svg>
			</button>

			<div class="sep"></div>

			<button class="tbtn tbtn--soon" title="File manager (coming soon)" disabled>
				<svg viewBox="0 0 16 16" fill="none" stroke="currentColor"
				     stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
				     width="19" height="19" aria-hidden="true">
					<rect x="1" y="6" width="14" height="8" rx="1"/>
					<path d="M2 6V5a1 1 0 011-1h4a1 1 0 011 1v1"/>
				</svg>
			</button>
		{/if}

		<div class="spacer"></div>

		<button class="tbtn" title="Toggle fullscreen" onclick={toggleFullscreen}>
			<svg viewBox="0 0 16 16" fill="none" stroke="currentColor"
			     stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
			     width="16" height="16" aria-hidden="true">
				<path d="M1 6V1H6M10 1H15V6M15 10V15H10M6 15H1V10"/>
			</svg>
		</button>
		<button class="tbtn tbtn--danger" title="Disconnect session" onclick={disconnectSession}>
			<svg viewBox="0 0 16 16" fill="none" stroke="currentColor"
			     stroke-width="1.75" stroke-linecap="round"
			     width="16" height="16" aria-hidden="true">
				<line x1="3" y1="3" x2="13" y2="13"/>
				<line x1="13" y1="3" x2="3" y2="13"/>
			</svg>
		</button>
	</nav>

	<!-- ── Canvas / terminal area ─────────────────────────────────────────── -->
	<div class="canvas-area">

		{#if isSsh}
			<!-- xterm.js mounts here. FitAddon sizes it to fill the area. -->
			<div class="ssh-term" bind:this={termEl}></div>
		{:else}
			<!-- Guacamole appends its <canvas> stack here. -->
			<div class="display" bind:this={container}></div>
		{/if}

		{#if statusText}
			<div class="overlay" class:overlay--error={isError}>
				{#if isError}⚠ {/if}{statusText}
			</div>
		{/if}

	</div>
</div>

<style>
	.session-shell {
		position      : fixed;
		inset         : 0;
		z-index       : 200;
		background    : #1d2021;
		display       : flex;
		flex-direction: row;
	}

	/* ── Toolbar ──────────────────────────────────────────────────────────── */

	.toolbar {
		width         : 44px;
		min-width     : 44px;
		flex-shrink   : 0;
		background    : var(--bg1, #282828);
		border-right  : 1px solid var(--bg3, #504945);
		display       : flex;
		flex-direction: column;
		align-items   : center;
		padding       : 6px 0 8px;
		gap           : 2px;
		z-index       : 202;
		user-select   : none;
	}

	.tbtn {
		width          : 32px;
		height         : 32px;
		background     : transparent;
		border         : 1px solid transparent;
		border-radius  : 4px;
		color          : var(--fg3, #bdae93);
		font-size      : 1rem;
		line-height    : 1;
		cursor         : pointer;
		display        : flex;
		align-items    : center;
		justify-content: center;
		padding        : 0;
		transition     : background 0.1s, color 0.1s, border-color 0.1s;
		flex-shrink    : 0;
	}
	.tbtn:hover:not(:disabled) {
		background: var(--bg3, #504945);
		color     : var(--fg,  #ebdbb2);
	}
	.tbtn--sm, .scale-label { font-size: 0.8rem; }
	.scale-label {
		color               : var(--fg4, #928374);
		text-align          : center;
		width               : 32px;
		padding             : 1px 0;
		font-variant-numeric: tabular-nums;
		pointer-events      : none;
	}
	.tbtn--active {
		background  : var(--bg2, #3c3836);
		color       : var(--yellow, #d8a657);
		border-color: var(--yellow, #d8a657);
	}
	.tbtn--danger:hover:not(:disabled) {
		background: rgba(204, 36, 29, 0.25);
		color     : var(--red, #fb4934);
	}
	.tbtn--soon { opacity: 0.35; cursor: default; }
	.sep {
		width     : 28px;
		height    : 1px;
		background: var(--bg3, #504945);
		margin    : 4px 0;
		flex-shrink: 0;
	}
	.spacer { flex: 1; }

	/* ── Canvas / terminal area ───────────────────────────────────────────── */

	.canvas-area {
		flex      : 1;
		overflow  : hidden;
		background: #1d2021;
		position  : relative;
		display   : flex;
		align-items    : flex-start;
		justify-content: flex-start;
	}

	/* Guacamole canvas container — padding + scrollable */
	.display {
		flex-shrink: 0;
		line-height: 0;
		cursor     : default;
		overflow   : hidden;
		margin     : 8px;
	}

	/* xterm.js container — fills the canvas area completely so FitAddon
	   can calculate the correct cols × rows from the actual pixel dimensions. */
	.ssh-term {
		width   : 100%;
		height  : 100%;
		padding : 6px 8px;
		box-sizing: border-box;
	}

	/* ── Status / error overlay ───────────────────────────────────────────── */

	.overlay {
		position       : fixed;
		top            : 50%;
		left           : 50%;
		transform      : translate(-50%, -50%);
		background     : rgba(0, 0, 0, 0.72);
		color          : #fff;
		padding        : 14px 24px;
		border-radius  : 6px;
		font-size      : 0.95rem;
		font-family    : inherit;
		white-space    : nowrap;
		pointer-events : none;
		backdrop-filter: blur(2px);
		z-index        : 201;
	}
	.overlay--error { background: rgba(180, 30, 30, 0.85); }
</style>
