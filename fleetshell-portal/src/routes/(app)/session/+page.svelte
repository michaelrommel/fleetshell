<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/stores';

	// The wss:// URL passed as a query parameter by the devices page.
	const wsUrl = $derived($page.url.searchParams.get('ws') ?? '');

	// ── State ─────────────────────────────────────────────────────────────────
	let container:   HTMLDivElement | undefined = $state();
	let statusText = $state('Connecting…');
	let isConnected = $state(false);
	let isError     = $state(false);

	// ── Guacamole lifecycle ───────────────────────────────────────────────────
	let disconnectFn: (() => void) | undefined;

	onMount(async () => {
		if (!wsUrl) {
			statusText = 'No session URL provided.';
			isError    = true;
			return;
		}

		// Dynamic import avoids running guacamole-common-js during SSR.
		// The ESM build is used automatically by Vite.
		const Guacamole = (await import('guacamole-common-js')).default;

		// guacamole-common-js WebSocketTunnel always builds the final URL as
		//   tunnelURL + '?' + data
		// The constructor must receive the base URL only (no query string)
		// and the query part passed as the data argument to connect().
		// Passing the full URL to the constructor produces a double-?:
		//   wss://…?session=g…?  or  wss://…?session=g…?undefined
		const qmark    = wsUrl.indexOf('?');
		const baseUrl  = qmark >= 0 ? wsUrl.slice(0, qmark) : wsUrl;
		const connData = qmark >= 0 ? wsUrl.slice(qmark + 1) : '';

		// ── Tunnel + client ───────────────────────────────────────────────────────────
		const tunnel = new Guacamole.WebSocketTunnel(baseUrl);
		const client = new Guacamole.Client(tunnel);

// ── Mount display ────────────────────────────────────────────────────
		const display = client.getDisplay();
		const displayEl: HTMLElement = display.getElement();
		displayEl.style.cursor = 'default';
		container?.appendChild(displayEl);

		// ── Connection state ─────────────────────────────────────────────────
		// Guacamole states: 0=idle 1=connecting 2=waiting 3=connected
		//                   4=disconnecting 5=disconnected
		client.onstatechange = (state: number) => {
			switch (state) {
				case 1: statusText = 'Connecting…';           isConnected = false; break;
				case 2: statusText = 'Waiting for session…';  isConnected = false; break;
				case 3: statusText = '';                       isConnected = true;  break;
				case 4: statusText = 'Disconnecting…';        isConnected = false; break;
				case 5: statusText = 'Session ended.';        isConnected = false; break;
			}
		};

		tunnel.onerror = (status: { code?: number; message?: string }) => {
			statusText = `Connection error: ${status?.message ?? `code ${status?.code}`}`;
			isError    = true;
		};

		client.onerror = (status: { code?: number; message?: string }) => {
			statusText = `Session error: ${status?.message ?? `code ${status?.code}`}`;
			isError    = true;
		};

		// ── Audio ───────────────────────────────────────────────────────────
		// When the server opens an audio channel, wire it to the browser’s
		// Web Audio API via AudioPlayer.  Without this handler the stream is
		// received but silently dropped and nothing plays.
		client.onaudio = (stream: any, mimetype: string) => {
			const player = Guacamole.AudioPlayer.getInstance(stream, mimetype);
			if (!player) {
				// Browser or guacamole-common-js does not support this codec.
				// Send a NACK so guacd stops sending on this stream.
				stream.sendAck('UNSUPPORTED',
					Guacamole.Status.Code.UNSUPPORTED ?? 0x100);
			}
		};

		// ── Mouse ────────────────────────────────────────────────────────────
		const mouse = new Guacamole.Mouse(displayEl);
		const sendMouse = (state: unknown) => client.sendMouseState(state, true);
		mouse.onmousedown = sendMouse;
		mouse.onmouseup   = sendMouse;
		mouse.onmousemove = sendMouse;

		// ── Keyboard ─────────────────────────────────────────────────────────
		const keyboard = new Guacamole.Keyboard(document);
		keyboard.onkeydown = (keysym: number) => client.sendKeyEvent(1, keysym);
		keyboard.onkeyup   = (keysym: number) => client.sendKeyEvent(0, keysym);

		// ── Connect ───────────────────────────────────────────────────────────
		// connData is the query string from the original wss:// URL, e.g.
		// "session=g0000000000000001". The library appends "?" + connData to
		// the base URL, producing the correct final WebSocket address.
		client.connect(connData);

		// ── Cleanup ───────────────────────────────────────────────────────────
		disconnectFn = () => {
			keyboard.onkeydown = null;
			keyboard.onkeyup   = null;
			client.disconnect();
		};
	});

	onDestroy(() => disconnectFn?.());
</script>

<svelte:head>
	<title>Remote Session — FleetShell</title>
</svelte:head>

<!--
	This page renders on top of the (app) sidebar shell.
	position:fixed + z-index covers the sidebar so the remote desktop
	fills the entire browser viewport.
-->
<div class="session-shell">
	<div class="display" bind:this={container}></div>

	{#if statusText}
		<div class="overlay" class:overlay--error={isError} class:overlay--hidden={isConnected && !statusText}>
			{#if isError}⚠ {/if}{statusText}
		</div>
	{/if}
</div>

<style>
	/* Cover the entire viewport, including the sidebar. */
	.session-shell {
		position  : fixed;
		inset     : 0;
		z-index   : 200;
		background: #1d2021;
		/* Allow scrolling when the remote canvas is larger than the viewport. */
		overflow  : auto;
		/* Flex container so margin:auto on .display centres it when there
		   is spare space in both axes. */
		display   : flex;
	}

	/* The Guacamole library appends a <canvas> here. */
	.display {
		/* Centre when the viewport is larger than the canvas;
		   scroll when smaller (overflow:auto on parent handles this). */
		margin     : auto;
		/* Never shrink below the canvas’s natural size. */
		flex-shrink: 0;
		cursor     : default;
		/* Remove the implicit inline gap that browsers add below <canvas>. */
		line-height: 0;
	}

	/* Status / error overlay, centred over the canvas. */
	.overlay {
		position        : fixed;
		top             : 50%;
		left            : 50%;
		transform       : translate(-50%, -50%);
		background      : rgba(0, 0, 0, 0.72);
		color           : #fff;
		padding         : 14px 24px;
		border-radius   : 6px;
		font-size       : 0.95rem;
		font-family     : inherit;
		white-space     : nowrap;
		pointer-events  : none;
		backdrop-filter : blur(2px);
		z-index         : 201;
	}

	.overlay--error {
		background: rgba(180, 30, 30, 0.85);
	}

	.overlay--hidden {
		display: none;
	}
</style>
