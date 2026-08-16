// ws-server.js
//
// Base-path-aware WebSocket wiring, shared by all three run modes:
//   * vite dev / preview  -> attached via the plugin in vite.config.ts
//   * production          -> attached in server.js (wraps adapter-node handler)
//
// Plain ESM (not TypeScript) so both vite.config.ts and the production
// server.js can import it directly without a build step. Keep it free of
// SvelteKit aliases ($lib, $env) for the same reason; business logic (device
// status, live lists) is registered via onConnection later.
//
// The upgrade handler ignores Vite's own HMR socket (subprotocol 'vite-hmr')
// and only claims our path, so HMR keeps working in dev.

import { WebSocketServer, WebSocket } from 'ws';

/** @type {WebSocketServer | null} */
let wss = null;

/**
 * @param {import('node:http').Server} server
 * @param {string} base  e.g. '' (root) or '/dev'
 */
export function attachWebSocket(server, base = process.env.BASE_PATH ?? '') {
	if (wss) return wss; // idempotent: dev HMR can re-run configureServer
	const w = new WebSocketServer({ noServer: true });
	wss = w;
	const wsPath = `${base}/ws`;

	server.on('upgrade', (req, socket, head) => {
		// Leave Vite's HMR socket to Vite.
		if (req.headers['sec-websocket-protocol'] === 'vite-hmr') return;
		const { pathname } = new URL(req.url ?? '', 'http://localhost');
		if (pathname !== wsPath) return;
		w.handleUpgrade(req, socket, head, (client) => {
			w.emit('connection', client, req);
		});
	});

	w.on('connection', (client) => {
		client.send(JSON.stringify({ type: 'hello', ts: Date.now() }));
		client.on('message', (data) => {
			// Echo skeleton -- replace with real channels (device-status, etc.).
			client.send(JSON.stringify({ type: 'echo', data: data.toString() }));
		});
	});

	return wss;
}

/**
 * Broadcast an object to every open client (for future live updates).
 * @param {unknown} obj
 */
export function broadcast(obj) {
	if (!wss) return;
	const msg = JSON.stringify(obj);
	for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
}
