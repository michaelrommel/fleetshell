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
// fetched from Secrets Manager ONCE and cached for the process lifetime (no TTL,
// no per-connection Secrets Manager call -- that was a hot-path regression). The
// cached value feeds postgres.js via a dynamic `password` callback. On an actual
// auth fault (28P01) after a rotation, `retryableQuery` invalidates the cache and
// transparently replays the query once on a fresh connection, which re-fetches
// the rotated password. When the ARN is absent we fall back to the static
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

// postgres.js builder methods that mutate the query and return `this` (the same
// Query instance). Safe to record and replay on a fresh query during a retry.
// Streaming methods (cursor/forEach/stream) are deliberately NOT here -- they
// yield rows incrementally, so retry disables itself and forwards verbatim.
const CHAINABLE = new Set(['values', 'raw', 'simple', 'describe', 'execute']);

// Wrap a postgres.js query with a ONE-SHOT retry that fires only on a password
// auth failure (28P01). The password is applied per physical connection at auth
// time (see Pass() in postgres/src/connection.js), so after invalidateDbSecret()
// a rebuilt query opens a fresh connection whose auth pulls the rotated password.
//   - `run()` recreates the query from the original tagged-template args.
//   - Plain `await` and chainable builders (.values() etc.) are covered.
//   - Streaming (.cursor()) and anything unrecognised disable retry and forward.
function retryableQuery(run: () => unknown, secretArn: string): unknown {
	const first = run() as PromiseLike<unknown> & Record<PropertyKey, unknown>;
	const replay: Array<[PropertyKey, unknown[]]> = [];
	let disabled = false;

	const execute = (): Promise<unknown> =>
		Promise.resolve(first).catch((err) => {
			if (disabled || !isAuthError(err)) throw err;
			invalidateDbSecret(secretArn);
			// Rebuild on a fresh connection; its auth handshake re-fetches the secret.
			let q = run() as Record<PropertyKey, unknown>;
			for (const [prop, args] of replay) {
				q = (q[prop] as (...a: unknown[]) => unknown)(...args) as Record<PropertyKey, unknown>;
			}
			return q;
		});

	const proxy: unknown = new Proxy(first, {
		get(target, prop) {
			if (prop === 'then') return (f: unknown, r: unknown) => execute().then(f as never, r as never);
			if (prop === 'catch') return (r: unknown) => execute().catch(r as never);
			if (prop === 'finally') return (f: unknown) => execute().finally(f as never);
			const v = (target as Record<PropertyKey, unknown>)[prop];
			if (typeof v !== 'function') return v;
			if (CHAINABLE.has(prop as string)) {
				return (...args: unknown[]) => {
					replay.push([prop, args]);
					(v as (...a: unknown[]) => unknown).apply(target, args); // mutates `first` in place
					return proxy; // keep the retry wrapper for chaining + await
				};
			}
			// Streaming / unknown method: retry is unsafe -- forward to the real query.
			disabled = true;
			return (v as (...a: unknown[]) => unknown).bind(target);
		},
	});
	return proxy;
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
			const run = () => (sql as unknown as (...a: unknown[]) => unknown)(...args);
			// Static-password pools (no ARN) get the raw query -- no wrapper, no cost.
			return secretArn ? retryableQuery(run, secretArn) : run();
		},
		get: (_t, prop) => {
			const sql = get().sql as unknown as Record<PropertyKey, unknown>;
			const v = sql[prop];
			return typeof v === 'function' ? v.bind(sql) : v;
		},
	});
}
