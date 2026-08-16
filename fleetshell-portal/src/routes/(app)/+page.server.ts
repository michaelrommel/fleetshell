import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { base } from '$app/paths';

// The portal root hands off to /welcome, which shows the first-run page once
// (show_welcome cookie) and otherwise redirects straight to Devices.
export const load: PageServerLoad = async () => {
	throw redirect(303, `${base}/welcome`);
};
