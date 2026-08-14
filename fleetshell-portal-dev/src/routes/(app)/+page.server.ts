import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { base } from '$app/paths';

// The portal root lands on Devices (the primary workflow).
export const load: PageServerLoad = async () => {
	throw redirect(303, `${base}/devices`);
};
