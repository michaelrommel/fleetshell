// src/lib/server/secrets.ts
//
// Runtime Secrets Manager fetcher for rotating DB credentials.
//
// ECS injects `secrets` (valueFrom) into the environment ONLY once, at task
// start -- a rotated secret is invisible to the running container until the task
// is replaced. To survive rotation without a restart we instead fetch the DB
// credential secret at runtime (via the task role) and hand postgres.js a
// dynamic `password` callback that reads from this cache.
//
// Credentials come from the ECS task role / default provider chain -- no
// explicit config. The task role MUST hold secretsmanager:GetSecretValue on the
// DB secret ARNs (and kms:Decrypt on their key if a CMK is used).

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { env } from '$env/dynamic/private';

export interface DbSecret {
	username: string;
	password: string;
	host?: string;
	port?: number;
	dbname?: string;
}

let _client: SecretsManagerClient | undefined;
function client(): SecretsManagerClient {
	return (_client ??= new SecretsManagerClient({
		region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'eu-west-2',
	}));
}

interface CacheEntry {
	value: DbSecret;
	inflight?: Promise<DbSecret>;
}

// The secret is cached for the LIFE OF THE PROCESS -- NOT re-fetched on a timer.
// Password rotation happens on a multi-day interval, so paying a Secrets Manager
// round-trip on every new connection (a TTL) is a hot-path regression. Instead we
// fetch once and only re-fetch when an ACTUAL auth fault calls
// `invalidateDbSecret()` (see db.ts). Recovery cost is paid on the fault, never
// on the steady-state path.
const cache = new Map<string, CacheEntry>();

/**
 * Fetch and cache a DB credential secret (JSON with username/password[/host/
 * port/dbname]). Returns the cached value on every subsequent call until
 * `invalidateDbSecret()` clears it. Concurrent first-callers share one request.
 */
export async function getDbSecret(secretId: string): Promise<DbSecret> {
	const hit = cache.get(secretId);
	if (hit?.value) return hit.value;
	if (hit?.inflight) return hit.inflight;

	const inflight = (async () => {
		const resp = await client().send(new GetSecretValueCommand({ SecretId: secretId }));
		if (!resp.SecretString) throw new Error(`secret ${secretId} has no SecretString`);
		const parsed = JSON.parse(resp.SecretString) as Partial<DbSecret>;
		if (!parsed.username || !parsed.password) {
			throw new Error(`secret ${secretId} is missing username/password`);
		}
		const value: DbSecret = {
			username: parsed.username,
			password: parsed.password,
			host: parsed.host,
			port: parsed.port,
			dbname: parsed.dbname,
		};
		cache.set(secretId, { value });
		return value;
	})();

	cache.set(secretId, { inflight } as CacheEntry);
	try {
		return await inflight;
	} catch (err) {
		cache.delete(secretId); // let the next attempt retry the fetch
		throw err;
	}
}

/** Force the next getDbSecret() to re-fetch (call ONLY on an auth failure). */
export function invalidateDbSecret(secretId: string): void {
	cache.delete(secretId);
}
