<!--
	In-page confirmation dialog styled to the app tokens (replaces window.confirm).
	The host provides the confirm ACTION as children (typically a small
	`<form use:enhance>` with a submit button), so the dialog stays generic and
	SvelteKit form actions keep working. Cancel / backdrop / Escape close it.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	let {
		open = $bindable(false),
		title,
		message = '',
		children,
	}: { open?: boolean; title: string; message?: string; children: Snippet } = $props();

	function close() { open = false; }
</script>

<svelte:window onkeydown={(e) => { if (open && e.key === 'Escape') close(); }} />

{#if open}
	<div class="overlay">
		<button type="button" class="backdrop" aria-label="Cancel" onclick={close}></button>
		<div class="dialog" role="dialog" aria-modal="true">
			<h4>{title}</h4>
			{#if message}<p>{message}</p>{/if}
			<div class="actions">
				<button type="button" class="cancel" onclick={close}>Cancel</button>
				{@render children()}
			</div>
		</div>
	</div>
{/if}

<style>
	.overlay { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; padding: 1rem; }
	.backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.55); border: none; cursor: pointer; }
	.dialog {
		position: relative; background: var(--surface); border: 1px solid var(--border);
		border-radius: var(--radius); padding: 1.2rem 1.3rem; width: 100%; max-width: 24rem;
		box-shadow: 0 12px 44px rgba(0, 0, 0, 0.45);
	}
	h4 { margin: 0 0 0.5rem; font-size: 1rem; color: var(--text); }
	p { margin: 0 0 1.1rem; font-size: 0.88rem; color: var(--text-muted); }
	.actions { display: flex; justify-content: flex-end; gap: 0.6rem; align-items: center; }
	.cancel {
		background: var(--surface-2); color: var(--text); border: 1px solid var(--border);
		border-radius: var(--radius); padding: 0.45rem 0.9rem; font: inherit; font-size: 0.85rem; cursor: pointer;
	}
	.cancel:hover { background: var(--surface-active); }
</style>
