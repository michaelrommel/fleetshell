import type { PageServerLoad } from './$types';
import { getRedisClient }      from '$lib/server/redis';

export const load: PageServerLoad = async ({ url }) => {
	const ip = url.searchParams.get('ip')?.trim() || null;

	if (!ip) {
		return { ip: null, result: null, error: null };
	}

	try {
		const redis  = await getRedisClient();
		const hash   = await redis.hGetAll(`systems:by-ip:${ip}`);
		const result = Object.keys(hash).length > 0 ? hash : null;
		return { ip, result, error: null };
	} catch (e) {
		const error = e instanceof Error ? e.message : String(e);
		console.error('[devices] Redis query failed:', error);
		return { ip, result: null, error };
	}
};
