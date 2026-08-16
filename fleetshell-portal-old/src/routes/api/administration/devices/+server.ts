/**
 * GET /api/administration/devices?q=<query>
 *
 * Searches Valkey for device entries matching the query.
 *
 * If the query looks like an IP address, a direct hGetAll on
 * systems:by-ip:<q> is attempted first.  Otherwise (or additionally),
 * SCAN is used to find all systems:by-ip:* keys whose field values contain
 * the query string (case-insensitive).  Safe for admin use where the
 * device count is in the low hundreds.
 *
 * Returns: { devices: Array<{ ip: string; fields: Record<string, string> }> }
 */
import { json, error }       from '@sveltejs/kit';
import { getRedisClient }    from '$lib/server/redis';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request, locals, url }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const q = (url.searchParams.get('q') ?? '').trim();
	if (!q) return json({ devices: [] });

	const redis   = await getRedisClient();
	const results: { ip: string; fields: Record<string, string> }[] = [];
	const seen    = new Set<string>();

	// ── 1. Direct IP lookup ───────────────────────────────────────────────────
	const isIpLike = /^[\d.]+$/.test(q);
	if (isIpLike) {
		const hash = await redis.hGetAll(`systems:by-ip:${q}`);
		if (Object.keys(hash).length > 0) {
			seen.add(q);
			results.push({ ip: q, fields: hash });
		}
	}

	// ── 2. SCAN for pattern matches across all device keys ────────────────────
	// redis v6 scanIterator yields string[] batches (one page per iteration),
	// not individual strings — iterate the inner array.
	const lq = q.toLowerCase();
	for await (const batch of redis.scanIterator({ MATCH: 'systems:by-ip:*', COUNT: 100 })) {
		for (const key of batch) {
			const ip = (key as string).replace('systems:by-ip:', '');
			if (seen.has(ip)) continue;

			const hash = await redis.hGetAll(key as string);
			const matches =
				ip.includes(lq) ||
				Object.values(hash).some(v => v.toLowerCase().includes(lq));

			if (matches) {
				seen.add(ip);
				results.push({ ip, fields: hash });
			}
		}
	}

	return json({ devices: results });
};
