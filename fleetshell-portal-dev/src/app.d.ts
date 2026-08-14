import type { Theme } from '$lib/theme';

// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			theme: Theme;
			accountId?: string;   // the authenticated human (login_account)
			userId?: string;      // the active persona (app_user); absent until selected
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
