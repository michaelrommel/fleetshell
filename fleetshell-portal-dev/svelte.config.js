import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),

	kit: {
		adapter: adapter({ out: 'build' }),

		// Served under https://portal.fleetshell.com/dev/ during development.
		// The ALB routes /dev/* to this service WITHOUT stripping the prefix, so
		// SvelteKit must know its base. To cut over to root later, set base to ''
		// and flip the ALB default rule.
		paths: {
			base: process.env.BASE_PATH ?? '/dev',
		},
	},
};

export default config;
