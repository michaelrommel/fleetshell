import type { PageServerLoad } from './$types';

/**
 * The Devices page is now a client-driven search/view/edit flow (see
 * +page.svelte).  The only server responsibility is to pass through an
 * optional initial query (?q= or ?ip=) so deep-links auto-search on load.
 */
export const load: PageServerLoad = async ({ url }) => {
	const q = url.searchParams.get('q') ?? url.searchParams.get('ip') ?? '';
	return { initialQuery: q.trim() };
};
