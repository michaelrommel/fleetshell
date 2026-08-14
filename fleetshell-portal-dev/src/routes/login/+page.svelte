<script lang="ts">
	import { enhance } from '$app/forms';
	import Logo from '$lib/components/Logo.svelte';

	let { form } = $props();
</script>

<main class="wrap">
	<div class="card">
		<div class="head">
			<div class="mark"><Logo /></div>
			<h1>FleetShell&nbsp;Portal <span class="tag">dev</span></h1>
		</div>
		<p class="hint">Sign in with your account. You will pick a persona next if you have more than one.</p>

		{#if form?.error}<p class="error">{form.error}</p>{/if}

		<form method="POST" use:enhance>
			<label>
				<span>Username or email</span>
				<input name="login" autocomplete="username" value={form?.login ?? ''} required />
			</label>
			<label>
				<span>Password</span>
				<input name="password" type="password" autocomplete="current-password" required />
			</label>
			<button type="submit">Sign in</button>
		</form>
	</div>
</main>

<style>
	.wrap { min-height: 100vh; display: grid; place-items: center; padding: 1rem; }
	.card {
		width: 100%; max-width: 26rem;
		background: var(--surface); border: 1px solid var(--border);
		border-radius: var(--radius); padding: 1.8rem 1.6rem;
	}
	.head { display: flex; align-items: center; gap: 0.8rem; margin-bottom: 0.4rem; }
	.mark { --logo-fg: var(--text); display: inline-flex; }
	h1 { font-size: 1.15rem; margin: 0; }
	.tag {
		font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.05em;
		background: var(--accent); color: var(--on-accent);
		padding: 0.1rem 0.4rem; border-radius: var(--radius); vertical-align: middle;
	}
	.hint { color: var(--text-muted); font-size: 0.88rem; margin: 0.2rem 0 1.1rem; }
	.error {
		color: var(--danger); font-size: 0.88rem; margin: 0 0 1rem;
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
		border-radius: var(--radius); padding: 0.5rem 0.7rem;
	}
	form { display: flex; flex-direction: column; gap: 0.9rem; }
	label { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.85rem; color: var(--text-muted); }
	input {
		background: var(--bg-app); color: var(--text);
		border: 1px solid var(--border); border-radius: var(--radius);
		padding: 0.55rem 0.7rem; font: inherit;
	}
	input:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	button {
		margin-top: 0.3rem; background: var(--accent); color: var(--on-accent);
		border: none; border-radius: var(--radius); padding: 0.6rem 0.9rem;
		font: inherit; font-weight: 600; cursor: pointer;
	}
	button:hover { background: var(--accent-hover); }
</style>
