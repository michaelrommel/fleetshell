<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { listen }             from '@tauri-apps/api/event';
  import LogView        from '$lib/components/LogView.svelte';
  import FunctionsView  from '$lib/components/FunctionsView.svelte';
  import SettingsView   from '$lib/components/SettingsView.svelte';

  type Tab = 'functions' | 'settings' | 'logging';

  let activeTab:  Tab          = $state('logging');
  let servicekey: string | null = $state(null);

  let unlisten: (() => void) | null = null;

  onMount(async () => {
    // The Rust server emits "navigate" to switch tabs and optionally pass a servicekey.
    unlisten = await listen<{ tab: Tab; servicekey?: string }>('navigate', ({ payload }) => {
      activeTab = payload.tab;
      if (payload.servicekey) {
        servicekey = payload.servicekey;
      }
    });
  });

  onDestroy(() => unlisten?.());
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
      <div class="fill-panel" role="tabpanel" aria-label="Functions">
        <FunctionsView {servicekey} />
      </div>
    {:else if activeTab === 'settings'}
      <div class="fill-panel" role="tabpanel" aria-label="Settings">
        <SettingsView />
      </div>
    {:else if activeTab === 'logging'}
      <div class="fill-panel" role="tabpanel" aria-label="Logging">
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
    background: var(--bg-hard);
    border-bottom: 2px solid var(--bg2);
    flex-shrink: 0;
  }

  .tab-btn {
    background: transparent;
    color: var(--fg4);
    border: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -2px;
    padding: 9px 22px;
    cursor: pointer;
    font-family: inherit;
    font-size: 1rem;
    letter-spacing: 0.02em;
    transition: color 0.12s, border-color 0.12s, background 0.12s;
  }

  .tab-btn:hover       { color: var(--fg2); background: var(--bg1); }
  .tab-btn.active      { color: var(--yellow); border-bottom-color: var(--yellow); background: var(--bg); }

  /* ── Panel containers ── */
  .tab-content {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  /* Panels that fill all available height (Logging, Functions) */
  .fill-panel {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

</style>
