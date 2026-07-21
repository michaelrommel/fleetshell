<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();

	let submitting = $state(false);
</script>

<svelte:head><title>FleetShell Portal — Login</title></svelte:head>

<div class="page">
	<div class="card">
		<div class="logo">
			<span class="logo-fleet">Fleet</span><span class="logo-shell">Shell</span>
		</div>
		<p class="subtitle">Portal</p>

		<form
			method="POST"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}
		>
			{#if form?.error}
				<div class="error-banner" role="alert">{form.error}</div>
			{/if}

			<div class="field">
				<label for="username">Username</label>
				<input
					id="username"
					name="username"
					type="text"
					autocomplete="username"
					autocapitalize="off"
					spellcheck="false"
					required
				/>
			</div>

			<div class="field">
				<label for="password">Password</label>
				<input
					id="password"
					name="password"
					type="password"
					autocomplete="current-password"
					required
				/>
			</div>

			<button type="submit" disabled={submitting}>
				{submitting ? 'Signing in…' : 'Sign In'}
			</button>
		</form>
	</div>
</div>

<style>
	.page {
		min-height      : 100vh;
		display         : flex;
		align-items     : center;
		justify-content : center;
		padding         : 20px;
		background      : var(--bg-hard);
	}

	.card {
		width           : 100%;
		max-width       : 380px;
		background      : var(--bg0);
		border          : 1px solid var(--bg2);
		border-radius   : 5px;
		padding         : 40px 36px 36px;
		box-shadow      : 0 8px 32px rgba(0, 0, 0, 0.5);
	}

	/* ── Logo ── */
	.logo {
		font-size   : 1.8rem;
		font-weight : 700;
		letter-spacing: -0.01em;
		line-height : 1;
		margin-bottom: 4px;
	}
	.logo-fleet  { color: var(--fg1); }
	.logo-shell  { color: var(--bright-aqua); }

	.subtitle {
		font-size     : 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.18em;
		color         : var(--fg4);
		margin-bottom : 32px;
	}

	/* ── Form ── */
	form {
		display        : flex;
		flex-direction : column;
		gap            : 18px;
	}

	.field {
		display        : flex;
		flex-direction : column;
	}

	.error-banner { margin-bottom: 4px; }

	button[type="submit"] {
		margin-top: 6px;
	}
	button[type="submit"]:disabled {
		opacity: 0.55;
		cursor : not-allowed;
	}
</style>
