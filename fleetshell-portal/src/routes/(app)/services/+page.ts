import { redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import type { PageLoad } from './$types';

// /services has no landing page of its own -- open the first tab.
export const load: PageLoad = () => {
	throw redirect(307, `${base}/services/infoproxy`);
};
