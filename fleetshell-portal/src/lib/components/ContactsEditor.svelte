<!--
	Per-site contact list editor. Local editable rows (name/role/email/phone/note),
	saved as a whole to ?/saveContacts (replace-all). Remount via {#key site_id}
	in the host to reseed when the site changes.
-->
<script lang="ts">
	import { enhance } from '$app/forms';

	type Contact = { name: string; role: string; email: string; phone: string; note: string };
	let { siteId, customerId, contacts, canEdit }:
		{ siteId: string; customerId: string; contacts: Partial<Contact>[]; canEdit: boolean } = $props();

	function seed(c: Partial<Contact>): Contact {
		return { name: c.name ?? '', role: c.role ?? '', email: c.email ?? '', phone: c.phone ?? '', note: c.note ?? '' };
	}
	// One-time seed from props; host remounts via {#key} to reseed.
	// svelte-ignore state_referenced_locally
	let rows = $state<Contact[]>(contacts.map(seed));

	function addRow() { rows = [...rows, seed({})]; }
	function removeRow(i: number) { rows = rows.filter((_, idx) => idx !== i); }

	const contactsJson = $derived(JSON.stringify(rows));
</script>

<form method="POST" action="?/saveContacts" use:enhance class="contacts">
	<input type="hidden" name="site_id" value={siteId} />
	<input type="hidden" name="customer_id" value={customerId} />
	<input type="hidden" name="contacts" value={contactsJson} />

	<div class="chead">
		<h4>Contacts <span class="count">{rows.length}</span></h4>
		{#if canEdit}<button type="button" class="mini" onclick={addRow}>+ Add contact</button>{/if}
	</div>

	{#if rows.length}
		<div class="clist">
			{#each rows as c, i (i)}
				<div class="crow">
					<input placeholder="Name" bind:value={c.name} disabled={!canEdit} />
					<input placeholder="Role" bind:value={c.role} disabled={!canEdit} />
					<input placeholder="Email" bind:value={c.email} disabled={!canEdit} />
					<input placeholder="Phone" bind:value={c.phone} disabled={!canEdit} />
					<input placeholder="Note" bind:value={c.note} disabled={!canEdit} />
					{#if canEdit}<button type="button" class="rm" onclick={() => removeRow(i)} aria-label="Remove">✕</button>{/if}
				</div>
			{/each}
		</div>
	{:else}
		<p class="muted">No contacts.</p>
	{/if}

	{#if canEdit}
		<div class="actions-bar">
			<button type="submit" class="act-save">Save contacts</button>
		</div>
	{/if}
</form>

<style>
	.contacts { display: flex; flex-direction: column; gap: 0.5rem; }
	.chead { display: flex; align-items: center; justify-content: space-between; }
	h4 { font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-subtle); margin: 0; }
	.count { color: var(--text-subtle); font-weight: 400; }
	.mini { background: none; border: 1px solid var(--border); color: var(--text-muted); border-radius: var(--radius); padding: 0.2rem 0.55rem; font: inherit; font-size: 0.76rem; cursor: pointer; }
	.mini:hover { color: var(--text); border-color: var(--text-subtle); }
	.clist { display: flex; flex-direction: column; gap: 0.35rem; }
	.crow { display: grid; grid-template-columns: 1.3fr 1fr 1.5fr 1fr 1.5fr auto; gap: 0.35rem; align-items: center; }
	.crow input { background: var(--bg-app); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.35rem 0.5rem; font: inherit; font-size: 0.82rem; min-width: 0; }
	.crow input:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
	.rm { width: 24px; height: 24px; flex: none; border: 1px solid var(--border); background: var(--surface-2); color: var(--text-subtle); border-radius: var(--radius); cursor: pointer; font-size: 0.72rem; }
	.rm:hover { color: var(--danger); border-color: var(--danger); }
	.muted { color: var(--text-subtle); font-size: 0.82rem; margin: 0; }
	.act-save { align-self: flex-start; background: var(--accent); color: var(--on-accent); border: none; border-radius: var(--radius); padding: 0.45rem 0.9rem; font: inherit; font-weight: 600; font-size: 0.85rem; cursor: pointer; }
	.act-save:hover { background: var(--accent-hover); }
</style>
