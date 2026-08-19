// src/lib/server/db.ts
//
// Two connection pools, one per data plane (see docs/mdm_design.md):
//   globalDb - Aurora Global (master data + authz). In production -> RDS Proxy.
//   localDb  - Aurora regional (user PII + group membership).
//
// Discrete connection options (NOT a URL): RDS-managed passwords frequently
// contain '/', '+', '@', '=' which corrupt a postgres:// URL. Passing the
// password as a plain option avoids all URL-escaping pitfalls.
//
// Rotating credentials: when `${prefix}_DB_SECRET_ARN` is set, the password is
// fetched from Secrets Manager at RUNTIME (via the task role) through a dynamic
// `password` callback that postgres.js invokes for every new physical
// connection. This survives secret rotation with no container restart -- on an
// auth failure we invalidate the cache so the next reconnect pulls the fresh
// password. When the ARN is absent we fall back to the static
// `${prefix}_DB_PASSWORD` env (local dev via an SSH/SSM port-forward).

import postgres from 'postgres';
import { env } from '$env/dynamic/private';
import { getDbSecret, invalidateDbSecret } from './secrets';

// 'require' encrypts without CA verification (fine for dev via the tunnel).
// For production set PGSSL=verify-full and provide the RDS CA (PGSSLROOTCERT).
function sslOption(): postgres.Options<{}>['ssl'] {
	switch (env.PGSSL) {
		case 'disable':
			return false;
		case 'verify-full':
			return { rejectUnauthorized: true };
		default:
			return 'require';
	}
}

function poolFor(prefix: 'GLOBAL' | 'LOCAL'): { sql: postgres.Sql<{}>; secretArn?: string } {
	const host = env[`${prefix}_DB_HOST`] ?? 'localhost';
	const database = env[`${prefix}_DB_NAME`];
	const secretArn = env[`${prefix}_DB_SECRET_ARN`];
	const staticPassword = env[`${prefix}_DB_PASSWORD`];
	if (!database) throw new Error(`${prefix}_DB_NAME is not set`);
	if (!secretArn && !staticPassword) {
		throw new Error(`${prefix}_DB_SECRET_ARN or ${prefix}_DB_PASSWORD must be set`);
	}

	// Dynamic password: postgres.js calls this for every NEW connection. Returning
	// the cached secret means a rotation self-heals within the cache TTL; an auth
	// failure (see lazyPool) invalidates the cache for an immediate refresh.
	const password: string | (() => Promise<string>) = secretArn
		? async () => (await getDbSecret(secretArn)).password
		: (staticPassword as string);

	const sql = postgres({
		host,
		port: Number(env[`${prefix}_DB_PORT`] ?? 5432),
		database,
		username: env[`${prefix}_DB_USER`] ?? 'fsadmin',
		password,
		ssl: sslOption(),
		max: Number(env.PG_POOL_MAX ?? 10),
		idle_timeout: 30,
		connect_timeout: 10,
	});

	return { sql, secretArn };
}

// Postgres `invalid_password` (28P01) -- emitted when the cached secret no longer
// matches the DB (e.g. just after a rotation the container did not pick up).
function isAuthError(err: unknown): boolean {
	const e = err as { code?: string; message?: string } | undefined;
	return e?.code === '28P01' || /password authentication failed/i.test(e?.message ?? '');
}

export const globalDb = lazyPool('GLOBAL');
export const localDb = lazyPool('LOCAL');

// Lazily instantiate the pool on first use. Importing this module (e.g. during
// SvelteKit's build-time `analyse` pass, which has no DB env) must NOT construct
// the pool or read the env -- otherwise `vite build` fails with
// "GLOBAL_DB_NAME is not set". The env is validated on the first query/method
// access at runtime instead.
function lazyPool(prefix: 'GLOBAL' | 'LOCAL'): postgres.Sql<{}> {
	let real: { sql: postgres.Sql<{}>; secretArn?: string } | undefined;
	const get = () => (real ??= poolFor(prefix));
	// A callable Proxy: `globalDb\`...\`` hits `apply`; `.begin`/`.json`/`.end`
	// hit `get` (bound to the real Sql).
	const target = function () {} as unknown as postgres.Sql<{}>;
	return new Proxy(target, {
		apply: (_t, _this, args: unknown[]) => {
			const { sql, secretArn } = get();
			const result = (sql as unknown as (...a: unknown[]) => unknown)(...args);
			// Observe-only: postgres.Query extends Promise, so attaching a rejection
			// handler does not re-execute the query. On an auth failure we drop the
			// cached secret so the NEXT connection re-fetches the rotated password.
			// The original PendingQuery (with .values()/.cursor()) is returned intact.
			if (secretArn && result && typeof (result as { then?: unknown }).then === 'function') {
				Promise.resolve(result).catch((err) => {
					if (isAuthError(err)) invalidateDbSecret(secretArn);
				});
			}
			return result;
		},
		get: (_t, prop) => {
			const sql = get().sql as unknown as Record<PropertyKey, unknown>;
			const v = sql[prop];
			return typeof v === 'function' ? v.bind(sql) : v;
		},
	});
}
