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
	fetchedAt: number;
	inflight?: Promise<DbSecret>;
}

// A short TTL bounds how long a just-rotated secret keeps failing NEW
// connections before the cache refreshes on its own. `invalidateDbSecret()`
// (called on an auth failure) makes recovery immediate rather than waiting it
// out. Override with DB_SECRET_TTL_MS.
const TTL_MS = Number(env.DB_SECRET_TTL_MS ?? 30_000);

const cache = new Map<string, CacheEntry>();

/**
 * Fetch and cache a DB credential secret (JSON with username/password[/host/
 * port/dbname]). Concurrent callers share one in-flight request.
 */
export async function getDbSecret(secretId: string, opts?: { force?: boolean }): Promise<DbSecret> {
	const now = Date.now();
	const hit = cache.get(secretId);
	if (!opts?.force && hit && now - hit.fetchedAt < TTL_MS) return hit.value;
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
		cache.set(secretId, { value, fetchedAt: Date.now() });
		return value;
	})();

	// Preserve any stale value while the refresh is in flight so other callers
	// that hit the TTL can still fall back if they choose to.
	cache.set(secretId, { value: hit?.value ?? ({} as DbSecret), fetchedAt: hit?.fetchedAt ?? 0, inflight });
	try {
		return await inflight;
	} catch (err) {
		// Drop the failed in-flight marker; keep any previously good value.
		if (hit?.value) cache.set(secretId, { value: hit.value, fetchedAt: hit.fetchedAt });
		else cache.delete(secretId);
		throw err;
	}
}

/** Force the next getDbSecret() to re-fetch (call after an auth failure). */
export function invalidateDbSecret(secretId: string): void {
	cache.delete(secretId);
}
