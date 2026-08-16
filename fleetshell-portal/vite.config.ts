import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { attachWebSocket } from './ws-server.js';

const base = process.env.BASE_PATH ?? '';

export default defineConfig({
	plugins: [
		sveltekit(),
		{
			// Attach our WebSocket server onto Vite's dev + preview http server so
			// `vite dev` and `vite preview` behave like production.
			name: 'fleetshell-ws',
			configureServer(server) {
				if (server.httpServer) attachWebSocket(server.httpServer as never, base);
			},
			configurePreviewServer(server) {
				if (server.httpServer) attachWebSocket(server.httpServer as never, base);
			},
		},
	],
});
