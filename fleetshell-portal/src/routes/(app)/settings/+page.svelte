<script lang="ts">
	import { enhance } from '$app/forms';
	import { toastEnhance } from '$lib/toast.svelte';

	let { data, form } = $props();

	// Seed local form state from the loaded config (initial value only; the form
	// posts and reloads, so re-deriving is unnecessary).
	// svelte-ignore state_referenced_locally
	let enabled = $state(data.cache.enabled);
	// svelte-ignore state_referenced_locally
	let l0 = $state(data.cache.l0Ttl);
	// svelte-ignore state_referenced_locally
	let l1 = $state(data.cache.l1Ttl);
</script>

<div class="wrap">
	<h1>Settings</h1>

	<section class="card">
		<h2>Authorization cache</h2>
		<p class="lede">
			Valkey caching for the device list &amp; count (see the timing chip on the
			Devices pager). Fail-open: if Valkey is unreachable every request falls
			back to the database.
		</p>

		{#if data.killSwitch}
			<p class="warn">Disabled by the <code>AUTHZ_CACHE=false</code> environment kill switch. The settings below have no effect until it is removed.</p>
		{/if}

		{#if !data.isAdmin}
			<p class="warn">Read-only: only administrators can change cache settings.</p>
		{/if}

		<form method="POST" action="?/saveCache" use:enhance={toastEnhance('Cache settings saved')}>
			<label class="row toggle">
				<input type="checkbox" name="enabled" bind:checked={enabled} disabled={!data.isAdmin} />
				<span>Enabled</span>
				<small>Master switch for the L0/L1 layers.</small>
			</label>

			<label class="row">
				<span class="lbl">L0 TTL <small>groups + scope signature</small></span>
				<span class="field">
					<input type="number" name="l0_ttl" min="5" step="5" bind:value={l0} disabled={!data.isAdmin} />
					<em>seconds (default {data.defaults.l0Ttl})</em>
				</span>
			</label>

			<label class="row">
				<span class="lbl">L1 TTL <small>rendered pages + counts</small></span>
				<span class="field">
					<input type="number" name="l1_ttl" min="5" step="5" bind:value={l1} disabled={!data.isAdmin} />
					<em>seconds (default {data.defaults.l1Ttl})</em>
				</span>
			</label>

			{#if form?.error}<p class="err">{form.error}</p>{/if}

			{#if data.isAdmin}
				<div class="actions-bar">
					<button type="submit" class="act-primary">Save</button>
				</div>
			{/if}
		</form>

		{#if data.isAdmin}
			<form method="POST" action="?/flushCache" use:enhance={toastEnhance('Cache flushed')} class="flush">
				<button type="submit" class="act-ghost">Flush cache now</button>
				<small>Rotates the authz generation: all signature / page / count entries miss on the next request.</small>
			</form>
		{/if}
	</section>
</div>

<style>
	.wrap { max-width: 46rem; padding: 1.4rem 1.6rem; }
	h1 { font-size: 1.3rem; margin: 0 0 1rem; }
	.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.2rem 1.3rem; }
	h2 { font-size: 1rem; margin: 0 0 0.4rem; }
	.lede { color: var(--text-subtle); font-size: 0.85rem; margin: 0 0 1rem; line-height: 1.45; }
	.warn { color: var(--text-subtle); font-size: 0.8rem; background: var(--surface-2, rgba(0,0,0,0.12)); border-radius: var(--radius); padding: 0.5rem 0.7rem; margin: 0 0 1rem; }
	.warn code { font-size: 0.78rem; }
	.row { display: flex; align-items: center; gap: 0.8rem; padding: 0.55rem 0; border-top: 1px solid var(--border); }
	.row.toggle { justify-content: flex-start; }
	.row.toggle span { font-size: 0.9rem; }
	.row .lbl { flex: 1; font-size: 0.9rem; display: flex; flex-direction: column; }
	.row small { color: var(--text-subtle); font-size: 0.72rem; font-weight: 400; }
	.field { display: flex; align-items: center; gap: 0.55rem; }
	.field input { width: 6rem; padding: 0.35rem 0.5rem; background: var(--input-bg, var(--surface)); color: inherit; border: 1px solid var(--border); border-radius: var(--radius); font: inherit; }
	.field em { color: var(--text-subtle); font-size: 0.75rem; font-style: normal; }
	.err { color: var(--danger, #e06c75); font-size: 0.82rem; margin: 0.6rem 0 0; }
	.flush { display: flex; align-items: center; gap: 0.7rem; margin-top: 1.1rem; padding-top: 0.9rem; border-top: 1px solid var(--border); }
	.flush small { color: var(--text-subtle); font-size: 0.72rem; }
	.act-ghost { background: transparent; color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.4rem 0.8rem; font: inherit; font-size: 0.82rem; cursor: pointer; white-space: nowrap; }
	.act-ghost:hover { border-color: var(--accent); color: var(--accent); }
</style>
