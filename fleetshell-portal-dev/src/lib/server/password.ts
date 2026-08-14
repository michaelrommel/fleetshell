// src/lib/server/password.ts
//
// Password hashing for the dev login_account (real SAML/OAuth replaces this
// later; see docs/portal_ui.md). Uses node:crypto scrypt so there is no extra
// dependency. Self-describing format so parameters can evolve:
//
//   scrypt$<N>$<r>$<p>$<saltHex>$<keyHex>
//
// infrastructure/import/seed_login_accounts.mjs reproduces this exact format;
// keep the two in sync if the parameters change.

import { scrypt, randomBytes, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// Typed wrapper: promisify does not carry scrypt's options overload, so wrap the
// callback form directly.
function scryptAsync(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(password, salt, keylen, options, (err, derived) => (err ? reject(err) : resolve(derived)));
	});
}

const N = 16384; // CPU/memory cost
const R = 8;
const P = 1;
const KEYLEN = 32;

export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const key = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P });
	return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
	if (!stored) return false;
	const parts = stored.split('$');
	if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
	const [, nStr, rStr, pStr, saltHex, keyHex] = parts;
	const salt = Buffer.from(saltHex, 'hex');
	const expected = Buffer.from(keyHex, 'hex');
	const key = await scryptAsync(password, salt, expected.length, {
		N: Number(nStr),
		r: Number(rStr),
		p: Number(pStr),
	});
	return key.length === expected.length && timingSafeEqual(key, expected);
}
