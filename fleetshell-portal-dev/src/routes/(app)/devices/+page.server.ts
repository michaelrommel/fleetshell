import type { PageServerLoad } from './$types';
import { resolveGroupIds, listDevices } from '$lib/server/authz';

// Auth + persona selection are enforced by (app)/+layout.server.ts. If we are
// still in the account-only state the layout redirects; return empty here so
// this load never runs an unauthenticated query.
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.userId) return { devices: [] };
	const groupIds = await resolveGroupIds(locals.userId);
	const devices = await listDevices(groupIds, 'view');
	return { devices };
};
