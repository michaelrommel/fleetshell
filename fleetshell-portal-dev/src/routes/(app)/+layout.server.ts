import type { LayoutServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { resolveGroupIds } from '$lib/server/authz';
import { getPersona, listIdentities } from '$lib/server/identity';

// Auth guard + shared chrome data for every page inside the (app) group.
//   no account   -> /login
//   account only -> /select-identity (must choose a persona first)
//   account+user -> render, using the active persona for name/role/admin gate.
export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.accountId) throw redirect(303, `${base}/login`);
	if (!locals.userId) throw redirect(303, `${base}/select-identity`);

	const [persona, groupIds, identities] = await Promise.all([
		getPersona(locals.userId),
		resolveGroupIds(locals.userId),
		listIdentities(locals.accountId),
	]);

	const displayName = persona ? `${persona.lastname}, ${persona.firstname}` : 'Unknown identity';

	// role_label is the display role (cosmetic). Fall back to the group count
	// until a real role summary from grants exists. Authorization itself and the
	// grayed-out controls come from the persona's grants (authz_can), NOT this.
	const role = persona?.role_label ?? (groupIds.length === 1 ? '1 group' : `${groupIds.length} groups`);

	return {
		accountId: locals.accountId,
		userId: locals.userId,
		displayName,
		role,
		// Interim capability gate for the Administration section (see docs).
		isAdmin: persona?.is_admin ?? false,
		// Show the top-bar identity switcher only when there is a choice.
		canSwitch: identities.length > 1,
		groupIds,
		// TODO(news): wire to a real news feed; 0 = no unread, hides the bell dot.
		newsCount: 0,
	};
};
