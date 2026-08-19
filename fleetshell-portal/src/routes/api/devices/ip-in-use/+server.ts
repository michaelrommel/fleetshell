import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { globalDb } from '$lib/server/db';

// Global uniqueness probe for a device left IP (device.ip_address).
//
// Returns ONLY a boolean. The query runs on the GLOBAL cluster with NO row-level
// authz filter, so it enforces fleet-wide uniqueness even when the caller cannot
// see the other device (privacy-preserving: the conflicting device is never
// disclosed). `exclude` omits the device being edited from the check.
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.userId) throw error(401, 'unauthenticated');
	const ip = (url.searchParams.get('ip') ?? '').trim();
	const exclude = (url.searchParams.get('exclude') ?? '').trim();
	if (!ip) return json({ inUse: false });

	const rows = exclude
		? await globalDb`SELECT 1 FROM device WHERE ip_address = ${ip} AND id <> ${exclude}::uuid LIMIT 1`
		: await globalDb`SELECT 1 FROM device WHERE ip_address = ${ip} LIMIT 1`;

	return json({ inUse: rows.length > 0 });
};
