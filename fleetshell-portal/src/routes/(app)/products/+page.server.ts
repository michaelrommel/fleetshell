import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { base } from '$app/paths';

export const load: PageServerLoad = async () => {
	throw redirect(303, `${base}/products/tree`);
};
