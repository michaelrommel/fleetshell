import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPersona } from '$lib/server/identity';
import { localDb } from '$lib/server/db';

// GET /dev/api/administration/personas?q=<name|user_id|role>
// Type-ahead for linking an existing persona (e.g. an imported user) to a
// login account. Admin personas only.
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.userId) throw error(401, 'unauthenticated');
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');

	const q = (url.searchParams.get('q') ?? '').trim();
	if (q.length < 2) return json({ personas: [] });

	const personas = await localDb<
		{ user_id: string; firstname: string; lastname: string; role_label: string | null }[]
	>`
		SELECT user_id, firstname, lastname, role_label
		FROM app_user
		WHERE firstname ILIKE ${'%' + q + '%'} OR lastname ILIKE ${'%' + q + '%'}
		   OR user_id ILIKE ${'%' + q + '%'} OR role_label ILIKE ${'%' + q + '%'}
		ORDER BY lastname, firstname
		LIMIT 25
	`;
	return json({ personas });
};
