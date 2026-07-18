<script lang="ts">
  let { servicekey = null }: { servicekey: string | null } = $props();

  let copied = $state(false);

  async function copyToClipboard() {
    if (!servicekey) return;
    try {
      await navigator.clipboard.writeText(servicekey);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch (e) {
      console.error('Clipboard write failed:', e);
    }
  }
</script>

<div class="functions-panel">
  {#if servicekey}
    <div class="sk-card">
      <div class="sk-label">Service Key</div>
      <div class="sk-value">{servicekey}</div>
      <button class="sk-copy-btn" class:copied onclick={copyToClipboard}>
        {#if copied}
          ✓ Copied!
        {:else}
          Copy to Clipboard
        {/if}
      </button>
    </div>
  {:else}
    <div class="empty-state">
      <span>No active service key</span>
      <span class="hint">Submit a tunnel request with a <code>servicekey</code> field to display it here.</span>
    </div>
  {/if}
</div>

<style>
  .functions-panel {
    flex: 1;
    display: flex;
    align-items: flex-start;
    justify-content: flex-start;
    padding: 28px 32px;
    overflow-y: auto;
  }

  /* ── Service key card ── */
  .sk-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--bg1);
    border: 1px solid var(--bg3);
    border-radius: 5px;
    padding: 20px 24px;
    min-width: 420px;
    max-width: 680px;
  }

  .sk-label {
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--fg4);
  }

  .sk-value {
    font-family: inherit;
    font-size: 1rem;
    color: var(--aqua);
    background: var(--bg-hard);
    border: 1px solid var(--bg2);
    border-radius: 3px;
    padding: 10px 12px;
    word-break: break-all;
    user-select: text;
  }

  .sk-copy-btn {
    align-self: flex-start;
    background: var(--bg2);
    color: var(--fg2);
    border: 1px solid var(--bg3);
    border-radius: 3px;
    padding: 5px 16px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.9rem;
    transition: background 0.1s, color 0.1s, border-color 0.1s;
    min-width: 140px;
  }

  .sk-copy-btn:hover { background: var(--bg3); color: var(--fg); }

  .sk-copy-btn.copied {
    background: var(--bg1);
    color: var(--green);
    border-color: var(--green);
    cursor: default;
  }

  /* ── Empty state ── */
  .empty-state {
    display: flex;
    flex-direction: column;
    gap: 8px;
    color: var(--bg4);
    margin-top: 8px;
  }

  .hint {
    font-size: 0.85rem;
    color: var(--bg3);
  }

  code {
    color: var(--orange);
    font-family: inherit;
  }
</style>
