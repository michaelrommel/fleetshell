<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	/** Sorted key/value pairs from the Redis hash. */
	const entries = $derived(
		data.result
			? Object.entries(data.result).sort(([a], [b]) => a.localeCompare(b))
			: [],
	);
</script>

<svelte:head><title>Devices — FleetShell Portal</title></svelte:head>

<div class="page">

	<!-- ── Search ─────────────────────────────────────────────────────────── -->
	<section class="search-section">
		<h1 class="page-title">Devices</h1>

		<form method="GET" class="search-form">
			<input
				class="search-input"
				name="ip"
				type="text"
				placeholder="Enter search criterium…"
				value={data.ip ?? ''}
				autocomplete="off"
				spellcheck="false"
				aria-label="IP address"
			/>
			<button type="submit" class="search-btn">Search</button>
		</form>
	</section>

	<!-- ── Results ────────────────────────────────────────────────────────── -->
	{#if data.ip !== null}
		<section class="results-section">
			<div class="results-header">
				<span class="results-label">
					Result for <code class="ip-code">{data.ip}</code>
				</span>
			</div>

			{#if data.error}
				<div class="error-banner" role="alert">
					Redis error: {data.error}
				</div>

			{:else if data.result === null}
				<div class="empty-state">
					No record found for key <code>systems:by-ip:{data.ip}</code>
				</div>

			{:else}
				<table class="result-table">
					<thead>
						<tr>
							<th>Field</th>
							<th>Value</th>
						</tr>
					</thead>
					<tbody>
						{#each entries as [field, value]}
							<tr>
								<td class="cell-field">{field}</td>
								<td class="cell-value">{value}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</section>
	{/if}

</div>

<style>
	.page {
		display        : flex;
		flex-direction : column;
		gap            : 32px;
		max-width      : 860px;
	}

	/* ── Title ──────────────────────────────────────────────────────────── */
	.page-title {
		font-size     : 1.1rem;
		font-weight   : 700;
		color         : var(--fg2);
		text-transform: uppercase;
		letter-spacing: 0.1em;
		margin-bottom : 18px;
	}

	/* ── Search form ─────────────────────────────────────────────────────── */
	.search-form {
		display  : flex;
		gap      : 10px;
		align-items: stretch;
	}

	.search-input {
		flex        : 1;
		background  : var(--bg1);
		color       : var(--fg1);
		border      : 1px solid var(--bg3);
		border-radius: 3px;
		padding     : 12px 16px;
		font-family : inherit;
		font-size   : 1.05rem;
		outline     : none;
		transition  : border-color 0.15s, box-shadow 0.15s;
		min-width   : 0;
	}
	.search-input:focus {
		border-color : var(--bright-blue);
		box-shadow   : 0 0 0 2px color-mix(in srgb, var(--bright-blue) 25%, transparent);
	}
	.search-input::placeholder { color: var(--bg4); }

	.search-btn {
		background    : var(--blue);
		color         : var(--fg0);
		border        : none;
		border-radius : 3px;
		padding       : 12px 28px;
		font-family   : inherit;
		font-size     : 1rem;
		cursor        : pointer;
		white-space   : nowrap;
		transition    : background 0.15s;
		flex-shrink   : 0;
		width         : auto;   /* override global button[type="submit"] { width: 100% } */
	}
	.search-btn:hover  { background: var(--bright-blue); }
	.search-btn:active { background: var(--bg3); }

	/* ── Results ─────────────────────────────────────────────────────────── */
	.results-header {
		margin-bottom : 14px;
	}
	.results-label {
		font-size : 0.85rem;
		color     : var(--fg4);
	}
	.ip-code {
		color      : var(--bright-yellow);
		font-family: inherit;
	}

	.empty-state {
		color      : var(--fg4);
		font-size  : 0.9rem;
		padding    : 20px 0;
	}
	.empty-state code {
		color      : var(--bright-orange);
		font-family: inherit;
	}

	/* ── Table ───────────────────────────────────────────────────────────── */
	.result-table {
		width           : 100%;
		border-collapse : collapse;
		font-size       : 0.9rem;
	}

	.result-table th {
		text-align     : left;
		padding        : 8px 14px;
		background     : var(--bg1);
		color          : var(--fg4);
		font-weight    : 600;
		text-transform : uppercase;
		letter-spacing : 0.07em;
		font-size      : 0.75rem;
		border-bottom  : 1px solid var(--bg2);
	}

	.result-table tr:nth-child(even) { background: var(--bg0); }
	.result-table tr:nth-child(odd)  { background: var(--bg-hard); }
	.result-table tr:hover           { background: var(--bg1); }

	.result-table td {
		padding       : 9px 14px;
		border-bottom : 1px solid var(--bg2);
		vertical-align: top;
	}

	.cell-field {
		color       : var(--bright-aqua);
		white-space : nowrap;
		width       : 220px;
	}

	.cell-value {
		color      : var(--fg2);
		word-break : break-word;
	}
</style>
