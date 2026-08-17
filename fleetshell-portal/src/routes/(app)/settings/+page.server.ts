import type { PageServerLoad, Actions } from './$types';
import { fail, redirect, error } from '@sveltejs/kit';
import { base } from '$app/paths';
import { getPersona } from '$lib/server/identity';
import { getCacheConfig, setCacheConfig, cacheKillSwitch, bumpAuthzGen, CACHE_DEFAULTS } from '$lib/server/cache';

async function requireAdmin(locals: App.Locals): Promise<void> {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	const isAdmin = persona?.is_admin ?? false;
	const cache = await getCacheConfig();
	return { isAdmin, cache, killSwitch: cacheKillSwitch(), defaults: CACHE_DEFAULTS };
};

export const actions: Actions = {
	saveCache: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const enabled = d.get('enabled') === 'on';
		const l0Ttl = Number(d.get('l0_ttl'));
		const l1Ttl = Number(d.get('l1_ttl'));
		if (!Number.isFinite(l0Ttl) || l0Ttl < 5 || !Number.isFinite(l1Ttl) || l1Ttl < 5) {
			return fail(400, { error: 'TTLs must be numbers >= 5 seconds.' });
		}
		await setCacheConfig({ enabled, l0Ttl, l1Ttl });
		return { saved: true };
	},

	flushCache: async ({ locals }) => {
		await requireAdmin(locals);
		// Rotate the authz generation: signature / page / count caches all miss
		// on the next request (L0 group keys age out by their own TTL).
		await bumpAuthzGen();
		return { flushed: true };
	},
};
