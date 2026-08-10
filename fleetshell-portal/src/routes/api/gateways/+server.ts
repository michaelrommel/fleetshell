/**
 * GET /api/gateways?q=<query>
 *
 * Search IPSec gateways in Valkey.  Query grammar (first version):
 *   ip:<v>   match on the gateway public IP
 *   id:<v>   match on the customer_id
 *   <v>      bare word matches ip OR id
 *   space    ANDs tokens;  '|'  ORs alternatives within a token
 * An empty query returns every gateway (browse mode).
 *
 * Returns: { gateways: GatewaySummary[] }
 */
import { json, error }        from '@sveltejs/kit';
import { searchGateways }     from '$lib/server/gateways';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const q = url.searchParams.get('q') ?? '';
	const gateways = await searchGateways(q);
	return json({ gateways });
};
