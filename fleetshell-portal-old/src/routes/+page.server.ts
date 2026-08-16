import { redirect } from '@sveltejs/kit';

/** Root "/" — hand off to /welcome which decides based on the show_welcome cookie. */
export function load({ locals }) {
	if (locals.user) redirect(303, '/welcome');
	redirect(303, '/login');
}
