import { redirect }    from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Cookie gate for the first-visit welcome screen.
 *
 * show_welcome absent / anything other than "false"  →  show the welcome page
 *                                                        then set cookie to "false"
 * show_welcome === "false"                           →  skip straight to /devices
 */
export const load: PageServerLoad = ({ locals, cookies }) => {
	if (!locals.user) redirect(303, '/login');

	if (cookies.get('show_welcome') === 'false') {
		redirect(303, '/devices');
	}

	// Mark the welcome screen as seen so subsequent logins go straight to Devices.
	cookies.set('show_welcome', 'false', {
		path     : '/',
		httpOnly : false,          // readable by client JS if needed in the future
		sameSite : 'lax',
		secure   : false,          // set to true behind HTTPS in production
		maxAge   : 365 * 24 * 60 * 60,
	});

	return { user: locals.user };
};
