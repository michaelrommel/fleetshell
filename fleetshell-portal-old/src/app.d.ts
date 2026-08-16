// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {
		interface Locals {
			/** Authenticated username, or null when unauthenticated. */
			user: string | null;
		}
	}
}

export {};
