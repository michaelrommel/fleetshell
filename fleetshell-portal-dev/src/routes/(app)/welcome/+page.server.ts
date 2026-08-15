import { redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import type { PageServerLoad } from './$types';

/**
 * First-visit welcome gate. `show_welcome` cookie:
 *   absent / anything but "false" -> show the welcome page, then set "false"
 *   "false"                        -> skip straight to Devices
 */
export const load: PageServerLoad = ({ locals, cookies }) => {
	if (!locals.userId) throw redirect(303, `${base}/login`);

	if (cookies.get('show_welcome') === 'false') {
		throw redirect(303, `${base}/devices`);
	}

	cookies.set('show_welcome', 'false', {
		path: base || '/',
		httpOnly: false,
		sameSite: 'lax',
		secure: false, // set true behind HTTPS in production
		maxAge: 365 * 24 * 60 * 60,
	});

	return {};
};
