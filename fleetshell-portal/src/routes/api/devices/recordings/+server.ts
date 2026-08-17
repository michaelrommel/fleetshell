/**
 * GET /api/devices/recordings?device=<uuid>              -> { days: string[] }
 * GET /api/devices/recordings?device=<uuid>&day=<d>      -> { sessions: [...] }
 * GET /api/devices/recordings?device=<uuid>&day=<d>&session=<s> -> { url }
 *
 * Session-recording browser backend for the device "Recordings" tab. Access is
 * gated by TWO independent grants (both enforced here, server-side; never trust
 * the client):
 *   1. service:connect over the 'screen_recording' catalog function (may this
 *      persona use Screen Recording at all -- feature entitlement).
 *   2. device:view over THIS device (may they reach it -- device scope).
 * The device IP is resolved from the DB by id; the client cannot pass an IP.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { globalDb } from '$lib/server/db';
import { resolveGroupIds, can, canService } from '$lib/server/authz';
import { listRecordingDays, listDaySessions, presignedDownloadUrl, s3Bucket } from '$lib/server/s3';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const deviceId = url.searchParams.get('device')?.trim() ?? '';
	const day = url.searchParams.get('day')?.trim() ?? '';
	const session = url.searchParams.get('session')?.trim() ?? '';
	if (!deviceId) throw error(400, 'Missing parameter: device');

	// --- two-grant gate: feature entitlement AND device reach ---------------
	const groupIds = await resolveGroupIds(locals.userId);
	const [entitled, reachable] = await Promise.all([
		canService(groupIds, 'view', 'screen_recording'),
		can(groupIds, 'view', deviceId),
	]);
	if (!entitled) throw error(403, 'Screen Recording access is not granted to your persona.');
	if (!reachable) throw error(403, 'You are not authorized to view this device.');

	if (!s3Bucket()) {
		throw error(503, 'Recording storage is not configured -- set GUACD_S3_BUCKET on the portal container.');
	}

	// Resolve the device IP server-side (recordings are keyed by device IP).
	const [dev] = await globalDb<{ ip: string | null }[]>`
		SELECT ip_address AS ip FROM device WHERE id = ${deviceId}`;
	const ip = dev?.ip?.trim() ?? '';
	if (!ip) throw error(404, 'Device has no IP address; no recordings can be located.');

	try {
		if (session && day) {
			return json({ url: await presignedDownloadUrl(ip, day, session) });
		}
		if (day) {
			return json({ sessions: await listDaySessions(ip, day) });
		}
		return json({ days: await listRecordingDays(ip) });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error('[api/devices/recordings]', msg);
		throw error(502, `S3 error: ${msg}`);
	}
};
