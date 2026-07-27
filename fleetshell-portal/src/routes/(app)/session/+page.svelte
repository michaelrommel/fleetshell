<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import type Guac from 'guacamole-common-js';

	const wsUrl = $derived($page.url.searchParams.get('ws') ?? '');

	// ── Constants ─────────────────────────────────────────────────────────────
	const TOOLBAR_W  = 44;   // px — fallback only; actual width measured at runtime
	const CANVAS_PAD = 8;    // px breathing room on every canvas edge

	/** Discrete zoom steps reachable via + / − buttons. */
	const SCALE_STEPS = [0.10, 0.20, 0.25, 0.33, 0.40, 0.50, 0.67, 0.75, 1.00, 1.25, 1.50, 2.00];

	// ── State ─────────────────────────────────────────────────────────────────
	let container:  HTMLDivElement | undefined = $state();
	let toolbarEl:  HTMLElement    | undefined = $state();
	let statusText  = $state('Connecting…');
	let isConnected = $state(false);
	let isError     = $state(false);

	// Scale
	let scale   = $state(1.0);
	let fitMode = $state(true);   // when true, recalculate on every resize

	const scalePercent = $derived(Math.round(scale * 100));

	// Guacamole references (set in onMount, used by toolbar handlers)
	let displayRef: InstanceType<typeof Guac.Display> | undefined;
	let clientRef:  InstanceType<typeof Guac.Client>  | undefined;
	let GuacLib:    typeof Guac | undefined;
	let cleanupFn:  (() => void) | undefined;

	// ── Scale helpers ─────────────────────────────────────────────────────────

	/** Apply a new scale factor: update guacamole display + wrapper dimensions. */
	function applyScale(s: number): void {
		scale = s;
		if (!displayRef || !container) return;

		displayRef.scale(s);

		// Update the wrapper div to the scaled dimensions so that the scroll
		// extent is correct (CSS transform alone does not change the layout box).
		const w = Math.round(displayRef.getWidth()  * s);
		const h = Math.round(displayRef.getHeight() * s);
		if (w > 0 && h > 0) {
			container.style.width  = `${w}px`;
			container.style.height = `${h}px`;
		}
	}

	/** Calculate the scale that makes the remote desktop fill the canvas area. */
	function calcFitScale(): number {
		const dw = displayRef?.getWidth()  ?? 0;
		const dh = displayRef?.getHeight() ?? 0;
		if (dw === 0 || dh === 0) return 1;
		// Measure the toolbar's actual rendered width (accounts for browser zoom,
		// DPI scaling, etc. — it may not equal TOOLBAR_W exactly).
		const toolbarW = toolbarEl?.getBoundingClientRect().width ?? TOOLBAR_W;
		// Use window.innerWidth: stable, never affected by scrollbar presence.
		// Subtract an extra 1px safety margin so sub-pixel rounding can never
		// push the scaled canvas past the container edge and trigger a scrollbar.
		const aw = window.innerWidth  - toolbarW - CANVAS_PAD * 2 - 1;
		const ah = window.innerHeight - CANVAS_PAD * 2 - 1;
		return Math.min(aw / dw, ah / dh);
	}

	// ── Toolbar actions ───────────────────────────────────────────────────────

	function setFit(): void {
		fitMode = true;
		applyScale(calcFitScale());
	}

	function setActual(): void {
		fitMode = false;
		applyScale(1.0);
	}

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

	function toggleFullscreen(): void {
		if (!document.fullscreenElement) {
			document.documentElement.requestFullscreen().catch(() => {});
		} else {
			document.exitFullscreen().catch(() => {});
		}
	}

	/** Read browser clipboard and send it to the remote desktop. */
	async function pasteToRemote(): Promise<void> {
		if (!clientRef || !GuacLib) return;
		let text: string;
		try {
			text = await navigator.clipboard.readText();
		} catch {
			// Clipboard permission denied — nothing to do.
			return;
		}
		if (!text) return;
		const stream = clientRef.createClipboardStream('text/plain');
		const writer = new GuacLib.StringWriter(stream);
		writer.sendText(text);
		writer.sendEnd();
	}

	function disconnectSession(): void {
		clientRef?.disconnect();
		window.close();
	}

	// ── Resize / fullscreen handlers ─────────────────────────────────────────

	function onWindowResize(): void {
		if (fitMode) applyScale(calcFitScale());
	}

	// fullscreenchange fires after the transition completes, at which point
	// clientWidth/clientHeight reflect the final fullscreen dimensions.
	function onFullscreenChange(): void {
		if (fitMode) applyScale(calcFitScale());
	}

	// ── Guacamole lifecycle ───────────────────────────────────────────────────

	onMount(() => {
		window.addEventListener('resize', onWindowResize);
		document.addEventListener('fullscreenchange', onFullscreenChange);

		// Kick off async setup without making onMount itself async —
		// an async onMount cannot return a synchronous cleanup function.
		(async () => {
			if (!wsUrl) {
				statusText = 'No session URL provided.';
				isError    = true;
				return;
			}

			const Guacamole = (await import('guacamole-common-js')).default;
			GuacLib = Guacamole;

			const qmark    = wsUrl.indexOf('?');
			const baseUrl  = qmark >= 0 ? wsUrl.slice(0, qmark) : wsUrl;
			const connData = qmark >= 0 ? wsUrl.slice(qmark + 1) : '';

			// ── Tunnel + client ──────────────────────────────────────────────
			const tunnel = new Guacamole.WebSocketTunnel(baseUrl);
			const client = new Guacamole.Client(tunnel);
			clientRef = client;

			// ── Display ──────────────────────────────────────────────────────
			const display = client.getDisplay();
			displayRef = display;

			const displayEl: HTMLElement = display.getElement();
			displayEl.style.cursor = 'default';
			container?.appendChild(displayEl);

			// Recalculate fit whenever guacd sends a size instruction.
			// This is the primary hook for initial auto-fit: display dimensions
			// are only known after the first size instruction arrives.
			display.onresize = () => {
				if (fitMode) applyScale(calcFitScale());
			};

			// ── Connection state ─────────────────────────────────────────────
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

			// ── Audio ────────────────────────────────────────────────────────
			client.onaudio = (stream: unknown, mimetype: string) => {
				const player = Guacamole.AudioPlayer.getInstance(stream, mimetype);
				if (!player) {
					(stream as any).sendAck('UNSUPPORTED',
						Guacamole.Status.Code.UNSUPPORTED ?? 0x100);
				}
			};

			// ── Clipboard: remote → browser ──────────────────────────────────
			client.onclipboard = (stream: unknown, mimetype: string) => {
				if (mimetype !== 'text/plain') return;
				const reader = new Guacamole.StringReader(stream);
				let text = '';
				reader.ontext = (chunk: string) => { text += chunk; };
				reader.onend  = () => { navigator.clipboard.writeText(text).catch(() => {}); };
			};

			// ── Mouse ─────────────────────────────────────────────────────────
			// sendMouseState(state, true): the `true` tells guacamole-common-js to
			// divide coordinates by the current display scale automatically.
			const mouse = new Guacamole.Mouse(displayEl);
			const sendMouse = (state: unknown) => client.sendMouseState(state, true);
			mouse.onmousedown = sendMouse;
			mouse.onmouseup   = sendMouse;
			mouse.onmousemove = sendMouse;

			// ── Keyboard ─────────────────────────────────────────────────────
			const keyboard = new Guacamole.Keyboard(document);
			keyboard.onkeydown = (keysym: number) => client.sendKeyEvent(1, keysym);
			keyboard.onkeyup   = (keysym: number) => client.sendKeyEvent(0, keysym);

			// ── Connect ───────────────────────────────────────────────────────
			client.connect(connData);

			// Store refs for the synchronous cleanup below.
			cleanupFn = () => {
				keyboard.onkeydown = null;
				keyboard.onkeyup   = null;
				client.disconnect();
			};
		})();

		// Synchronous cleanup — Svelte calls this when the component is
		// destroyed, whether or not the async setup above has finished.
		return () => {
			window.removeEventListener('resize', onWindowResize);
			document.removeEventListener('fullscreenchange', onFullscreenChange);
			cleanupFn?.();
		};
	});
</script>

<svelte:head>
	<title>Remote Session — FleetShell</title>
</svelte:head>

<!--
	Covers the entire viewport (including the app sidebar) via position:fixed.
	Layout: [toolbar 44px] [canvas-area fills rest]
-->
<div class="session-shell">

	<!-- ── Left toolbar ───────────────────────────────────────────────────── -->
	<nav class="toolbar" bind:this={toolbarEl} aria-label="Session controls">

		<!-- Zoom group -->
		<button
			class="tbtn"
			class:tbtn--active={fitMode}
			title="Fit to window"
			onclick={setFit}
		>
			<!-- four diagonal arrows pointing inward from each corner = compress to fit -->
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

		<!-- Clipboard -->
		<button
			class="tbtn"
			title="Paste local clipboard to remote"
			onclick={pasteToRemote}
		>
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

		<!-- File manager placeholder -->
		<button class="tbtn tbtn--soon" title="File manager (coming soon)" disabled>
			<svg viewBox="0 0 16 16" fill="none" stroke="currentColor"
			     stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
			     width="19" height="19" aria-hidden="true">
				<rect x="1" y="6" width="14" height="8" rx="1"/>
				<path d="M2 6V5a1 1 0 011-1h4a1 1 0 011 1v1"/>
			</svg>
		</button>

		<div class="spacer"></div>

		<!-- outer corner brackets = full viewport (no arrows, just the corners) -->
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

	<!-- ── Canvas area ────────────────────────────────────────────────────── -->
	<div class="canvas-area">

		<!-- The Guacamole library appends its <canvas> stack here. -->
		<div class="display" bind:this={container}></div>

		{#if statusText}
			<div class="overlay" class:overlay--error={isError}>
				{#if isError}⚠ {/if}{statusText}
			</div>
		{/if}

	</div>
</div>

<style>
	/* ── Shell ────────────────────────────────────────────────────────────── */

	/* Covers the entire viewport, including the app sidebar. */
	.session-shell {
		position  : fixed;
		inset     : 0;
		z-index   : 200;
		background: #1d2021;
		display   : flex;
		flex-direction: row;
	}

	/* ── Left toolbar ─────────────────────────────────────────────────────── */

	.toolbar {
		width      : 44px;
		min-width  : 44px;
		flex-shrink: 0;
		background : var(--bg1, #282828);
		border-right: 1px solid var(--bg3, #504945);
		display    : flex;
		flex-direction: column;
		align-items: center;
		padding    : 6px 0 8px;
		gap        : 2px;
		z-index    : 202;
		user-select: none;
	}

	/* Generic toolbar button */
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

	/* Text-label buttons (1:1) and zoom percentage — same size, slightly
	   smaller than the default 1rem so they fit the narrow toolbar. */
	.tbtn--sm,
	.scale-label {
		font-size: 0.8rem;
	}

	.scale-label {
		color             : var(--fg4, #928374);
		text-align        : center;
		width             : 32px;
		padding           : 1px 0;
		font-variant-numeric: tabular-nums;
		pointer-events    : none;
	}

	/* Active / selected state (fit button when fit-mode on, 1:1 when at 100%) */
	.tbtn--active {
		background  : var(--bg2, #3c3836);
		color       : var(--yellow, #d8a657);
		border-color: var(--yellow, #d8a657);
	}

	/* Disconnect button — red on hover */
	.tbtn--danger:hover:not(:disabled) {
		background: rgba(204, 36, 29, 0.25);
		color     : var(--red, #fb4934);
	}

	/* Greyed-out placeholder button */
	.tbtn--soon {
		opacity: 0.35;
		cursor : default;
	}

/* Horizontal rule between button groups */
	.sep {
		width      : 28px;
		height     : 1px;
		background : var(--bg3, #504945);
		margin     : 4px 0;
		flex-shrink: 0;
	}

	/* Pushes disconnect / fullscreen to the bottom */
	.spacer { flex: 1; }

	/* ── Canvas area ──────────────────────────────────────────────────────── */

	.canvas-area {
		flex      : 1;
		overflow  : auto;
		background: #000;
		position  : relative;
		/* 2px breathing room on every edge so the canvas never touches the
		   browser chrome and scrollbars don't flicker at exact-fit sizes. */
		padding   : 8px;
		/* Flex so that .display can be centred when smaller than the area. */
		display   : flex;
		align-items    : flex-start;
		justify-content: flex-start;
	}

	/*
	 * The Guacamole library appends a stack of <canvas> elements here.
	 * JS sets explicit width/height to match the scaled canvas dimensions
	 * so that the scroll extent is correct even though the transform does
	 * not affect the CSS layout box.
	 */
	.display {
		flex-shrink: 0;
		line-height: 0;
		cursor     : default;
		/* Clip the guacamole cursor-sprite layer when it drifts near an edge.
		   Without this, the cursor canvas extends beyond the display bounds
		   and causes the canvas-area scrollbars to flicker. */
		overflow   : hidden;
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

	.overlay--error {
		background: rgba(180, 30, 30, 0.85);
	}
</style>
