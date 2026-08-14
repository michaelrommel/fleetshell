<script lang="ts">
	let { data } = $props();
</script>

<div class="page">
	<div class="page-head">
		<h1>Devices</h1>
		<p class="sub">Devices you are authorized to view ({data.devices.length}).</p>
	</div>

	<section class="card">
		<table>
			<thead>
				<tr>
					<th>region</th><th>country</th><th>modality</th>
					<th>product</th><th>hospital</th><th>access</th>
				</tr>
			</thead>
			<tbody>
				{#each data.devices as d (d.id)}
					<tr>
						<td>{d.region_path ?? ''}</td>
						<td>{d.country_iso ?? ''}</td>
						<td>{d.modality ?? ''}</td>
						<td>{d.product_path ?? ''}</td>
						<td>{d.hospital_name ?? ''}</td>
						<td>{d.access_requirement === 'open' ? '' : d.access_requirement}</td>
					</tr>
				{:else}
					<tr><td colspan="6" class="empty">No devices in your scope.</td></tr>
				{/each}
			</tbody>
		</table>
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
		padding: 0.4rem 0.6rem;
	}
	table { width: 100%; border-collapse: collapse; }
	th, td { text-align: left; padding: 0.45rem 0.7rem; border-bottom: 1px solid var(--divider); }
	th { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-subtle); }
	td { font-size: 0.88rem; }
	tbody tr:last-child td { border-bottom: none; }
	.empty { color: var(--text-subtle); text-align: center; padding: 1.4rem; }
</style>
