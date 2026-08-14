// seed_login_accounts.mjs -- dev login accounts + persona labels for the
// identity model (see docs/portal_ui.md). Run AFTER seed_test_users.py (which
// creates the 6 test personas) and AFTER migrate_identity_local.sql.
//
// It:
//   * sets role_label + is_admin on the 6 test personas,
//   * creates two login_accounts and links their identities:
//       super / super123  -> all 6 personas (demo the identity selector),
//       nora  / nora123    -> Nora only     (single-persona: no selector).
//
// Password hashing mirrors src/lib/server/password.ts EXACTLY (scrypt format);
// keep the two in sync. Uses the portal's `postgres` dependency, so run it with
// the portal's node_modules on the path:
//
//   cd fleetshell-portal-dev
//   LOCAL_DB_PASSWORD=... node ../../infrastructure/import/seed_login_accounts.mjs
//
// Connection comes from the same discrete LOCAL_DB_* env the portal uses
// (defaults target the localhost:5433 tunnel).

import postgres from 'postgres';
import { scrypt, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const N = 16384, R = 8, P = 1, KEYLEN = 32;

async function hashPassword(password) {
	const salt = randomBytes(16);
	const key = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P });
	return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

const sql = postgres({
	host: process.env.LOCAL_DB_HOST ?? 'localhost',
	port: Number(process.env.LOCAL_DB_PORT ?? 5433),
	database: process.env.LOCAL_DB_NAME ?? 'fleetshell_local',
	username: process.env.LOCAL_DB_USER ?? 'fsadmin',
	password: process.env.LOCAL_DB_PASSWORD,
	ssl: process.env.PGSSL === 'disable' ? false : 'require',
});

// Test personas (fixed ids from seed_test_users.py) -> (role_label, is_admin).
const PERSONAS = [
	['dddd0000-0000-0000-0000-000000000001', 'SuperUser',        true],
	['dddd0000-0000-0000-0000-000000000002', 'Service Engineer', false],
	['dddd0000-0000-0000-0000-000000000003', 'User',             false],
	['dddd0000-0000-0000-0000-000000000004', 'RSC Operator',     false],
	['dddd0000-0000-0000-0000-000000000005', 'BURepresentative', false],
	['dddd0000-0000-0000-0000-000000000006', 'Helpdesk',         false],
];

// account username, email, password, [linked persona ids]
const ACCOUNTS = [
	['super', 'super@test.local', 'super123', PERSONAS.map((p) => p[0])],
	['nora',  'nora@test.local',  'nora123',  ['dddd0000-0000-0000-0000-000000000003']],
];

try {
	for (const [uid, label, isAdmin] of PERSONAS) {
		await sql`UPDATE app_user SET role_label = ${label}, is_admin = ${isAdmin} WHERE user_id = ${uid}`;
	}

	for (const [username, email, password, personaIds] of ACCOUNTS) {
		const hash = await hashPassword(password);
		const [acct] = await sql`
			INSERT INTO login_account (account_id, username, email, password_hash, display_name)
			VALUES ('acct:' || nextval('login_account_seq'), ${username}, ${email}, ${hash}, ${username})
			ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, email = EXCLUDED.email
			RETURNING account_id`;
		for (const uid of personaIds) {
			await sql`
				INSERT INTO account_identity (account_id, user_id) VALUES (${acct.account_id}, ${uid})
				ON CONFLICT (account_id, user_id) DO NOTHING`;
		}
		console.log(`  ${username.padEnd(6)} / ${password.padEnd(10)} -> ${personaIds.length} identities`);
	}
	console.log('Seeded login accounts. Test personas labelled (Tess = SuperUser/is_admin).');
} finally {
	await sql.end();
}
