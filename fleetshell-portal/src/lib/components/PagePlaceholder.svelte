<!--
	Placeholder for sidebar sections not yet built out. Keeps the shell coherent
	while the real views land. Remove per-section as each is implemented.
-->
<script lang="ts">
	let { title, note = '' }: { title: string; note?: string } = $props();
</script>

<div class="page">
	<div class="page-head">
		<h1>{title}</h1>
		{#if note}<p class="sub">{note}</p>{/if}
	</div>
	<section class="card">
		<p class="placeholder">This section is not implemented yet.</p>
	</section>
</div>

<style>
	.page { max-width: 72rem; }
	.page-head { margin-bottom: 1.2rem; }
	h1 { font-size: 1.3rem; margin: 0 0 0.2rem; }
	.sub { margin: 0; color: var(--text-muted); font-size: 0.9rem; }
	.card {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 2rem;
	}
	.placeholder { margin: 0; color: var(--text-subtle); text-align: center; }
</style>
