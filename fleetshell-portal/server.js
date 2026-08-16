// server.js -- production entry (replaces adapter-node's build/index.js).
//
// Wraps the adapter-node request handler in our own http.Server so we can
// attach the WebSocket server on the same port. Run with: node server.js
// (after `npm run build`). Dockerfile CMD points here.

import http from 'node:http';
import { handler } from './build/handler.js';
import { attachWebSocket } from './ws-server.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const base = process.env.BASE_PATH ?? '';

const server = http.createServer(handler);
attachWebSocket(server, base);

server.listen(port, host, () => {
	console.log(`fleetshell-portal listening on ${host}:${port}${base ? ` (base ${base})` : ''}`);
});
