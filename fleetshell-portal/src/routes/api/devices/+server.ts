/**
 * GET /api/devices?q=<query>
 *
 * Search devices in Valkey.  Query grammar:
 *   ip:<v>       match on the device IP
 *   <field>:<v>  match on any aeroftp hash field (serial, product, country, ...)
 *   <v>          bare word matches ip OR any field value
 *   space ANDs tokens;  '|' ORs alternatives within a token
 * An empty query returns every device (browse mode).
 *
 * Returns: { devices: DeviceSummary[] }
 */
import { json, error }        from '@sveltejs/kit';
import { searchDevices }      from '$lib/server/devices';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const q = url.searchParams.get('q') ?? '';
	const devices = await searchDevices(q);
	return json({ devices });
};
