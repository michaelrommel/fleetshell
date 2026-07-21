import { redirect }      from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

/** Auth guard for every route in the (app) group. */
export const load: LayoutServerLoad = ({ locals }) => {
	if (!locals.user) redirect(303, '/login');
	return { user: locals.user };
};
