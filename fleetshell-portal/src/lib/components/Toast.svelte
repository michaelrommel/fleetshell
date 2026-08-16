<!--
	Global toast host. Mounted once in AppShell; renders the shared `toasts`
	store as a stack in the bottom-right corner. Success = accent-green check,
	error = danger red. Click to dismiss early; otherwise auto-expires.
-->
<script lang="ts">
	import { fly, fade } from 'svelte/transition';
	import { toasts, dismissToast } from '$lib/toast.svelte';
</script>

<div class="toast-host" aria-live="polite" aria-atomic="false">
	{#each toasts as t (t.id)}
		<button
			type="button"
			class="toast {t.kind}"
			onclick={() => dismissToast(t.id)}
			in:fly={{ y: 12, duration: 160 }}
			out:fade={{ duration: 140 }}
		>
			<span class="ico" aria-hidden="true">
				{#if t.kind === 'success'}
					<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
				{:else}
					<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
				{/if}
			</span>
			<span class="msg">{t.message}</span>
		</button>
	{/each}
</div>

<style>
	.toast-host {
		position: fixed; bottom: 18px; right: 18px; z-index: 1000;
		display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
		pointer-events: none;
	}
	.toast {
		pointer-events: auto; cursor: pointer;
		display: flex; align-items: center; gap: 9px;
		max-width: 380px; padding: 10px 14px;
		background: var(--surface); color: var(--text);
		border: 1px solid var(--border); border-left-width: 3px;
		border-radius: var(--radius); box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
		font: inherit; font-size: 0.84rem; text-align: left;
	}
	.toast.success { border-left-color: var(--ok, #8ec07c); }
	.toast.error { border-left-color: var(--danger); }
	.ico { display: inline-flex; flex: none; }
	.toast.success .ico { color: var(--ok, #8ec07c); }
	.toast.error .ico { color: var(--danger); }
	.msg { min-width: 0; }
</style>
