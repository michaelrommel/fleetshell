import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),

	kit: {
		adapter: adapter({ out: 'build' }),

		// Served at the site root. Override with BASE_PATH (e.g. '/dev') only if the
		// app must live under a sub-path behind a prefix-preserving proxy.
		paths: {
			base: process.env.BASE_PATH ?? '',
		},
	},
};

export default config;
