<script lang="ts">
	import Logo from '$lib/components/Logo.svelte';

	let { data, form } = $props();
</script>

<main class="wrap">
	<div class="card">
		<div class="head">
			<div class="mark"><Logo /></div>
			<h1>Choose an identity</h1>
		</div>
		<p class="hint">
			Signed in as <strong>{data.account?.display_name ?? data.account?.username}</strong>.
			Pick the identity to work as. You can switch again at any time from the top bar.
		</p>

		{#if form?.error}<p class="error">{form.error}</p>{/if}

		<ul>
			{#each data.identities as p (p.user_id)}
				<li>
					<form method="POST">
						<input type="hidden" name="user_id" value={p.user_id} />
						<button type="submit" class:current={p.user_id === data.currentUserId}>
							<span class="name">{p.firstname} {p.lastname}</span>
							<span class="right">
								{#if p.role_label}<span class="role">{p.role_label}</span>{/if}
								{#if p.is_admin}<span class="admin">admin</span>{/if}
								{#if p.user_id === data.currentUserId}<span class="cur">current</span>{/if}
							</span>
						</button>
					</form>
				</li>
			{/each}
		</ul>
	</div>
</main>

<style>
	.wrap { min-height: 100vh; display: grid; place-items: center; padding: 1rem; }
	.card {
		width: 100%; max-width: 30rem;
		background: var(--surface); border: 1px solid var(--border);
		border-radius: var(--radius); padding: 1.8rem 1.6rem;
	}
	.head { display: flex; align-items: center; gap: 0.8rem; margin-bottom: 0.4rem; }
	.mark { --logo-fg: var(--text); display: inline-flex; }
	h1 { font-size: 1.15rem; margin: 0; }
	.hint { color: var(--text-muted); font-size: 0.88rem; margin: 0.2rem 0 1.1rem; }
	.hint strong { color: var(--text); }
	.error { color: var(--danger); font-size: 0.88rem; margin: 0 0 0.8rem; }
	ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem; }
	button {
		width: 100%; cursor: pointer; text-align: left;
		display: flex; align-items: center; justify-content: space-between; gap: 0.6rem;
		background: var(--bg-app); color: var(--text);
		border: 1px solid var(--border); border-radius: var(--radius);
		padding: 0.7rem 0.9rem; font: inherit;
	}
	button:hover { border-color: var(--accent); }
	button.current { border-color: var(--accent); }
	.name { font-weight: 600; }
	.right { display: flex; align-items: center; gap: 0.5rem; }
	.role { color: var(--text-muted); font-size: 0.82rem; }
	.admin {
		font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.04em;
		color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
		border-radius: 999px; padding: 0.05rem 0.45rem;
	}
	.cur { font-size: 0.7rem; color: var(--text-subtle); }
</style>
