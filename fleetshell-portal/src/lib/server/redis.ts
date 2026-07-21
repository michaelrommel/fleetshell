/**
 * Redis client singleton.
 *
 * A module-level variable is sufficient: in production (node adapter) the
 * module is loaded exactly once.  In dev with Vite HMR a new connection is
 * created on hot reload, which is acceptable for a local dev server.
 */
import { createClient } from 'redis';
import { env }          from '$env/dynamic/private';

let _client: Awaited<ReturnType<typeof buildClient>> | undefined;

async function buildClient() {
	const url    = env.REDIS_URL ?? 'redis://localhost:6379';
	const client = createClient({ url });

	client.on('error', (err: Error) => {
		console.error('[redis] client error:', err.message);
	});

	await client.connect();
	return client;
}

export async function getRedisClient() {
	if (_client?.isReady) return _client;
	_client = await buildClient();
	return _client;
}
