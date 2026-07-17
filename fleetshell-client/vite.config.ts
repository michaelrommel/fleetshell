import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// Use adapter-static so Tauri can serve the built files from disk.
			adapter: adapter()
		})
	],

	// Tauri dev server settings
	clearScreen: false,
	server: {
		port: 5173,
		strictPort: true,
		host: host || false,
		hmr: host
			? {
					protocol: 'ws',
					host,
					port: 5174
				}
			: undefined,
		watch: {
			// Avoid watching the Rust src-tauri tree to prevent unnecessary rebuilds.
			ignored: ['**/src-tauri/**']
		}
	}
});
