// Valkey/Redis client singleton for the enrollment flow (probe + cert SSE).
//
// Mirrors the connection style used by classification.ts (TLS-aware via
// rediss://). A module-level variable is enough: in production the module loads
// once; in dev with Vite HMR a fresh connection on reload is acceptable.
//
// The SSE streams open a dedicated *subscriber* connection via duplicate().
// node-redis merges duplicate() overrides shallowly, so a bare
// { socket: { reconnectStrategy: false } } would drop the TLS settings. Use
// subscriberOptions() so the subscriber keeps TLS AND disables auto-reconnect.

import { createClient } from 'redis';
import { env } from '$env/dynamic/private';

let _client: ReturnType<typeof createClient> | undefined;

function valkeyUrl(): { url: string; tls: boolean; rejectUnauthorized: boolean } {
	const url = env.VALKEY_URL ?? 'rediss://localhost:6380';
	const rejectUnauthorized = env.VALKEY_TLS_REJECT_UNAUTHORIZED !== 'false';
	return { url, tls: url.startsWith('rediss://'), rejectUnauthorized };
}

export async function getRedisClient() {
	if (_client?.isReady) return _client;
	const { url, tls, rejectUnauthorized } = valkeyUrl();
	_client = createClient({
		url,
		socket: tls ? { tls: true, rejectUnauthorized } : undefined,
	});
	_client.on('error', (err: Error) => console.error('[redis] client error:', err.message));
	await _client.connect();
	return _client;
}

/**
 * Options for the SSE subscriber connection (redis.duplicate(...)). Preserves
 * TLS (when rediss://) and disables auto-reconnect so disconnect() truly
 * terminates the connection (avoids a message-handler reconnect loop).
 */
export function subscriberOptions() {
	const { tls, rejectUnauthorized } = valkeyUrl();
	return {
		socket: tls
			? { tls: true as const, rejectUnauthorized, reconnectStrategy: false as const }
			: { reconnectStrategy: false as const },
	};
}
