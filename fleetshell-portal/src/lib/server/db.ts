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
// For local dev an SSH/SSM port-forward maps each cluster to a localhost port.

import postgres from 'postgres';
import { env } from '$env/dynamic/private';

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

function poolFor(prefix: 'GLOBAL' | 'LOCAL') {
	const host = env[`${prefix}_DB_HOST`] ?? 'localhost';
	const database = env[`${prefix}_DB_NAME`];
	const password = env[`${prefix}_DB_PASSWORD`];
	if (!database) throw new Error(`${prefix}_DB_NAME is not set`);
	if (!password) throw new Error(`${prefix}_DB_PASSWORD is not set`);

	return postgres({
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
}

export const globalDb = lazyPool('GLOBAL');
export const localDb = lazyPool('LOCAL');

// Lazily instantiate the pool on first use. Importing this module (e.g. during
// SvelteKit's build-time `analyse` pass, which has no DB env) must NOT construct
// the pool or read the env -- otherwise `vite build` fails with
// "GLOBAL_DB_NAME is not set". The env is validated on the first query/method
// access at runtime instead.
function lazyPool(prefix: 'GLOBAL' | 'LOCAL'): postgres.Sql<{}> {
	let real: postgres.Sql<{}> | undefined;
	const get = () => (real ??= poolFor(prefix));
	// A callable Proxy: `globalDb\`...\`` hits `apply`; `.begin`/`.json`/`.end`
	// hit `get` (bound to the real Sql).
	const target = function () {} as unknown as postgres.Sql<{}>;
	return new Proxy(target, {
		apply: (_t, _this, args: unknown[]) => (get() as unknown as (...a: unknown[]) => unknown)(...args),
		get: (_t, prop) => {
			const v = (get() as unknown as Record<PropertyKey, unknown>)[prop];
			return typeof v === 'function' ? v.bind(get()) : v;
		},
	});
}
