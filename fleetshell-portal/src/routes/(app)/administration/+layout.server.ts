import type { LayoutServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { getPersona } from '$lib/server/identity';

// Interim gate: the Administration section requires an is_admin persona. This
// mirrors the greyed-out sidebar item; replace with authz_can once the
// authz-admin privileges are wired.
export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw redirect(303, `${base}/devices`);
	return {};
};
