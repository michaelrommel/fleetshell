import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPersona } from '$lib/server/identity';
import { resolveGroupIds, authzHas } from '$lib/server/authz';
import { personaSearchFilter } from '$lib/server/personaSearch';
import { localDb } from '$lib/server/db';

// GET /api/administration/personas?q=<name|user_id|role>
// Type-ahead for linking / adding a persona. Reachable by an is_admin persona OR
// a "group admin" (holds a group:edit grant) -- the latter needs it for the
// top-level Groups page "Add a member" search. The match predicate is shared
// with the Admin > Personas list load via personaSearchFilter (no drift).
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.userId) throw error(401, 'unauthenticated');
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) {
		const groupIds = await resolveGroupIds(locals.userId);
		if (!(await authzHas(groupIds, 'group', 'edit'))) throw error(403, 'forbidden');
	}

	const q = (url.searchParams.get('q') ?? '').trim();
	if (q.length < 2) return json({ personas: [] });

	const search = personaSearchFilter(localDb, q);
	const personas = await localDb<
		{ user_id: string; firstname: string; lastname: string; role_label: string | null }[]
	>`
		SELECT u.user_id, u.firstname, u.lastname, u.role_label
		FROM app_user u
		WHERE true ${search}
		ORDER BY u.lastname, u.firstname
		LIMIT 25
	`;
	return json({ personas });
};
