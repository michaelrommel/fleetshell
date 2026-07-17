<script lang="ts">
  import LogView from '$lib/components/LogView.svelte';

  type Tab = 'functions' | 'settings' | 'logging';
  let activeTab: Tab = $state('logging');
</script>

<div class="page">
  <!-- Tab bar -->
  <div class="tab-bar" role="tablist" aria-label="Main navigation">
    {#each (['functions', 'settings', 'logging'] as Tab[]) as tab}
      <button
        class="tab-btn"
        class:active={activeTab === tab}
        role="tab"
        aria-selected={activeTab === tab}
        onclick={() => (activeTab = tab)}
      >
        {tab.charAt(0).toUpperCase() + tab.slice(1)}
      </button>
    {/each}
  </div>

  <!-- Tab panels -->
  <div class="tab-content">
    {#if activeTab === 'functions'}
      <div class="empty-panel" role="tabpanel" aria-label="Functions">
        <span class="empty-label">Functions — coming soon</span>
      </div>
    {:else if activeTab === 'settings'}
      <div class="empty-panel" role="tabpanel" aria-label="Settings">
        <span class="empty-label">Settings — coming soon</span>
      </div>
    {:else if activeTab === 'logging'}
      <div class="log-panel" role="tabpanel" aria-label="Logging">
        <LogView />
      </div>
    {/if}
  </div>
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    background: var(--bg);
  }

  /* ── Tab bar ── */
  .tab-bar {
    display: flex;
    gap: 0;
    background: var(--bg-hard);
    border-bottom: 2px solid var(--bg2);
    flex-shrink: 0;
  }

  .tab-btn {
    background: transparent;
    color: var(--fg4);
    border: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -2px;          /* overlap the bar's border */
    padding: 9px 22px;
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
    letter-spacing: 0.02em;
    transition: color 0.12s, border-color 0.12s, background 0.12s;
  }

  .tab-btn:hover {
    color: var(--fg2);
    background: var(--bg1);
  }

  .tab-btn.active {
    color: var(--yellow);
    border-bottom-color: var(--yellow);
    background: var(--bg);
  }

  /* ── Panel container ── */
  .tab-content {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  /* Logging tab fills all available space */
  .log-panel {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  /* Placeholder for empty tabs */
  .empty-panel {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .empty-label {
    color: var(--bg4);
    font-size: 14px;
    letter-spacing: 0.05em;
  }
</style>
