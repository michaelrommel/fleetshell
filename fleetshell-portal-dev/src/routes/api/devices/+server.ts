import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { resolveGroupIds, listDevices } from '$lib/server/authz';

// GET /dev/api/devices?user=<uuid>&verb=view&limit=50
// Cursor pagination: &after_updated=<iso>&after_id=<uuid>
export const GET: RequestHandler = async ({ url }) => {
	const userId = url.searchParams.get('user') ?? env.DEV_USER_ID;
	if (!userId) throw error(400, 'no user (pass ?user= or set DEV_USER_ID)');

	const verb = url.searchParams.get('verb') ?? 'view';
	const limit = Number(url.searchParams.get('limit') ?? 50);
	const afterUpdated = url.searchParams.get('after_updated');
	const afterId = url.searchParams.get('after_id');
	const cursor = afterUpdated && afterId ? { updatedAt: afterUpdated, id: afterId } : undefined;

	const groupIds = await resolveGroupIds(userId);
	const devices = await listDevices(groupIds, verb, cursor, limit);

	const nextCursor =
		devices.length === limit
			? { after_updated: devices[devices.length - 1].updated_at, after_id: devices[devices.length - 1].id }
			: null;

	return json({ userId, groupIds, count: devices.length, nextCursor, devices });
};
