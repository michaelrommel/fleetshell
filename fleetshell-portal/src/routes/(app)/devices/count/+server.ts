import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPersona } from '$lib/server/identity';
import { countDevices } from '$lib/server/deviceQuery';

// Exact device count for (mode, q). Called by the Devices page only when the
// count is not already carried in the URL (i.e. the filter changed), so paging
// never pays for it. See docs/portal_ui.md (Devices count = URL-carry, approach A).
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.userId) throw error(401, 'unauthenticated');
	const persona = await getPersona(locals.userId);
	const isAdmin = persona?.is_admin ?? false;
	const q = (url.searchParams.get('q') ?? '').trim();
	const mode = isAdmin && url.searchParams.get('mode') === 'all' ? 'all' : 'scope';
	const { total, ms, cached } = await countDevices(locals.userId, mode, q);
	return json({ total, ms, cached });
};
