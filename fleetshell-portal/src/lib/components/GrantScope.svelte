<!--
	Shared grant-scope renderer. One place decides how EVERY resource_type is
	displayed, so the Grants, Groups and Personas pages stay in lock-step:
	  single_system -> "system <label>"
	  group         -> "group <group subtree(s)>"
	  gateway       -> "gateway <region(s)>"
	  service       -> "service <service subtree(s)>"
	  product       -> "product <product subtree(s)>"
	  customer      -> "customer <customer(s)>"
	  site          -> "site <customer / site(s)>"
	  region        -> "region <region subtree(s)>"
	  device (else) -> "<region> | <product> | <customer[/site]>"
	`sep` selects the divider used in the device triple ('|' on Grants/Groups,
	'·' on the denser Personas list).
-->
<script lang="ts">
	import type { GrantScope } from '$lib/grantScope';

	let { g, sep = '|' }: { g: GrantScope; sep?: string } = $props();
</script>

{#if g.scope_kind === 'single_system'}
	<span class="kind">system</span> {g.single_label || 'single system'}
{:else if g.resource_type === 'group'}
	<span class="kind">group</span> {g.group_scope}
{:else if g.resource_type === 'gateway'}
	<span class="kind">gateway</span> {g.region}
{:else if g.resource_type === 'service'}
	<span class="kind">service</span> {g.service_scope}
{:else if g.resource_type === 'product'}
	<span class="kind">product</span> {g.product}
{:else if g.resource_type === 'customer'}
	<span class="kind">customer</span> {g.customer}
{:else if g.resource_type === 'site'}
	<span class="kind">site</span> {g.site === 'ANY' ? g.customer : `${g.customer} / ${g.site}`}
{:else if g.resource_type === 'region'}
	<span class="kind">region</span> {g.region}
{:else}
	{g.region} <span class="sep">{sep}</span> {g.product} <span class="sep">{sep}</span> {g.site === 'ANY' ? g.customer : `${g.customer} / ${g.site}`}
{/if}

<style>
	.kind { color: var(--accent); font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.03em; margin-right: 0.2rem; }
	.sep { color: var(--text-subtle); margin: 0 0.15rem; }
</style>
