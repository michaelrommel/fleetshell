// src/lib/server/identity.ts
//
// Local-plane account + persona helpers: the person (login_account) authenticates, then
// assumes one of their linked personas (app_user). See docs/portal_ui.md.
//
// Only these functions touch login_account / account_persona, so swapping the
// password check for SAML/OAuth later is contained to verifyLogin().

import { localDb } from './db';
import { verifyPassword } from './password';

export interface Account {
	account_id: string;
	username: string;
	email: string;
	display_name: string | null;
}

export interface Persona {
	user_id: string;
	firstname: string;
	lastname: string;
	role_label: string | null;
	is_admin: boolean;
	home_region: string;
}

export interface LinkedPersona extends Persona {
	is_primary: boolean;
}

/** Verify a username-or-email + password against login_account. */
export async function verifyLogin(login: string, password: string): Promise<Account | null> {
	const [row] = await localDb<
		{ account_id: string; username: string; email: string; display_name: string | null; password_hash: string | null }[]
	>`
		SELECT account_id, username, email, display_name, password_hash
		FROM login_account
		WHERE username = ${login} OR email = ${login}
		LIMIT 1
	`;
	if (!row) return null;
	if (!(await verifyPassword(password, row.password_hash))) return null;
	return {
		account_id: row.account_id,
		username: row.username,
		email: row.email,
		display_name: row.display_name,
	};
}

/** The personas a person may assume (for the persona selector / switcher). */
export async function listPersonas(accountId: string): Promise<LinkedPersona[]> {
	return await localDb<LinkedPersona[]>`
		SELECT u.user_id, u.firstname, u.lastname, u.role_label, u.is_admin, u.home_region, ai.is_primary
		FROM account_persona ai
		JOIN app_user u ON u.user_id = ai.user_id
		WHERE ai.account_id = ${accountId}
		ORDER BY ai.is_primary DESC, u.is_admin DESC, u.lastname, u.firstname
	`;
}

/** Guard: does this account actually own this persona? */
export async function accountCanAssume(accountId: string, userId: string): Promise<boolean> {
	const [row] = await localDb<{ ok: boolean }[]>`
		SELECT true AS ok FROM account_persona
		WHERE account_id = ${accountId} AND user_id = ${userId}
	`;
	return row?.ok ?? false;
}

/** Load a persona row (for the shell top bar + admin gate). */
export async function getPersona(userId: string): Promise<Persona | null> {
	const [row] = await localDb<Persona[]>`
		SELECT user_id, firstname, lastname, role_label, is_admin, home_region
		FROM app_user WHERE user_id = ${userId}
	`;
	return row ?? null;
}

export async function getAccount(accountId: string): Promise<Account | null> {
	const [row] = await localDb<Account[]>`
		SELECT account_id, username, email, display_name
		FROM login_account WHERE account_id = ${accountId}
	`;
	return row ?? null;
}
