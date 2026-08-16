/**
 * GET /api/administration/recordings?ip=<ip>
 *   → { days: string[] }          — list recording days for a device
 *
 * GET /api/administration/recordings?ip=<ip>&day=<YYYY-MM-DD>
 *   → { sessions: string[] }      — list session base-names for a day
 *
 * GET /api/administration/recordings?ip=<ip>&day=<day>&session=<session>
 *   → { url: string }             — presigned download URL for the ZIP
 */
import { json, error }               from '@sveltejs/kit';
import { listRecordingDays, listDaySessions, presignedDownloadUrl, s3Bucket }
	from '$lib/server/s3';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const ip      = url.searchParams.get('ip')?.trim()      ?? '';
	const day     = url.searchParams.get('day')?.trim()     ?? '';
	const session = url.searchParams.get('session')?.trim() ?? '';

	if (!ip) error(400, 'Missing parameter: ip');

	if (!s3Bucket()) {
		error(503, 'S3 recording access is not configured — set GUACD_S3_BUCKET on the portal container');
	}

	try {
		if (session && day) {
			// Presigned ZIP download URL
			const url_ = await presignedDownloadUrl(ip, day, session);
			return json({ url: url_ });
		}

		if (day) {
			// List sessions for a specific day
			const sessions = await listDaySessions(ip, day);
			return json({ sessions });
		}

		// List recording days for a device
		const days = await listRecordingDays(ip);
		return json({ days });

	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error('[administration/recordings]', msg);
		error(502, `S3 error: ${msg}`);
	}
};
