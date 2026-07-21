<script lang="ts">
  import { onMount }  from 'svelte';
  import { invoke }   from '@tauri-apps/api/core';

  interface AppConfig {
    font_size:       number;
    vnc_viewer:      string;
    portal_base_url: string;
  }

  let portalUrl: string = $state('');
  let username:  string = $state('');
  let password:  string = $state('');
  let response:  string = $state('');
  let loading:   boolean = $state(false);
  let urlSaveState: 'idle' | 'saving' | 'saved' | 'error' = $state('idle');

  onMount(async () => {
    try {
      const cfg = await invoke<AppConfig>('get_config');
      portalUrl = cfg.portal_base_url;
    } catch (e) {
      console.warn('Could not load config:', e);
    }
  });

  async function savePortalUrl() {
    urlSaveState = 'saving';
    try {
      const cfg = await invoke<AppConfig>('get_config');
      await invoke('save_config', { config: { ...cfg, portal_base_url: portalUrl } });
      urlSaveState = 'saved';
      setTimeout(() => { urlSaveState = 'idle'; }, 1200);
    } catch (e) {
      console.error('Failed to save portal URL:', e);
      urlSaveState = 'error';
    }
  }

  async function enroll() {
    if (!portalUrl || !username) return;
    loading  = true;
    response = '';
    try {
      response = await invoke<string>('enrollment_login', { username, password });
    } catch (e) {
      response = `Error: ${e}`;
    } finally {
      loading = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !loading) enroll();
  }
</script>

<div class="enrollment-panel">

  <h2 class="section-title">Portal Enrollment</h2>

  <!-- ── Portal URL ───────────────────────────────────────────────────────── -->
  <div class="setting-row">
    <label for="portal-url" class="setting-label">
      Portal URL
      <span class="setting-hint">Base URL of the FleetShell portal.<br>
        Paths like <code>/api/login</code> are appended automatically.<br>
        Set to <code>http://localhost:5173</code> for local dev.</span>
    </label>
    <div class="field-control">
      <input
        type="url"
        id="portal-url"
        class="text-input wide"
        bind:value={portalUrl}
        placeholder="https://portal.fleetshell.com"
        spellcheck={false}
        onblur={savePortalUrl}
      />
      <span
        class="save-indicator"
        class:saving={urlSaveState === 'saving'}
        class:saved={urlSaveState  === 'saved'}
        class:error={urlSaveState  === 'error'}
        aria-live="polite"
      >
        {#if urlSaveState === 'saving'}saving…
        {:else if urlSaveState === 'saved'}saved ✓
        {:else if urlSaveState === 'error'}error ✗
        {/if}
      </span>
    </div>
  </div>

  <!-- ── Credentials ──────────────────────────────────────────────────────── -->
  <div class="setting-row">
    <label for="enroll-user" class="setting-label">Username</label>
    <div class="field-control">
      <input
        type="text"
        id="enroll-user"
        class="text-input"
        bind:value={username}
        autocomplete="username"
        spellcheck={false}
        onkeydown={handleKeydown}
      />
    </div>
  </div>

  <div class="setting-row">
    <label for="enroll-pass" class="setting-label">Password</label>
    <div class="field-control">
      <input
        type="password"
        id="enroll-pass"
        class="text-input"
        bind:value={password}
        autocomplete="current-password"
        onkeydown={handleKeydown}
      />
    </div>
  </div>

  <!-- ── Submit ───────────────────────────────────────────────────────────── -->
  <div class="action-row">
    <button
      class="btn-enroll"
      onclick={enroll}
      disabled={loading || !portalUrl || !username}
    >
      {loading ? 'Enrolling…' : 'Enroll'}
    </button>
  </div>

  <!-- ── Response ─────────────────────────────────────────────────────────── -->
  {#if response}
    <h2 class="section-title">Response</h2>
    <pre class="response-box">{response}</pre>
  {/if}

</div>

<style>
  .enrollment-panel {
    flex: 1;
    overflow-y: auto;
    padding: 28px 32px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  /* ── Section heading ── */
  .section-title {
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--fg4);
    border-bottom: 1px solid var(--bg2);
    padding-bottom: 6px;
    margin: 8px 0 4px;
    font-weight: normal;
  }
  .section-title:first-child { margin-top: 0; }

  /* ── Row layout ── */
  .setting-row {
    display: flex;
    align-items: flex-start;
    gap: 24px;
  }

  .setting-label {
    display: flex;
    flex-direction: column;
    gap: 3px;
    color: var(--fg2);
    font-size: 1rem;
    min-width: 120px;
    padding-top: 4px;
  }

  .setting-hint {
    font-size: 0.85rem;
    color: var(--fg4);
    line-height: 1.4;
  }

  /* ── Field controls ── */
  .field-control {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
  }

  .text-input {
    background: var(--bg1);
    color: var(--fg);
    border: 1px solid var(--bg3);
    border-radius: 3px;
    padding: 4px 8px;
    font-family: inherit;
    font-size: 0.95rem;
    width: 280px;
  }
  .text-input.wide   { width: 480px; max-width: 100%; }
  .text-input::placeholder { color: var(--bg4); }
  .text-input:focus  { outline: 1px solid var(--yellow); border-color: var(--yellow); }

  /* ── Save indicator ── */
  .save-indicator {
    font-size: 0.85rem;
    min-width: 60px;
    color: transparent;
    transition: color 0.15s;
  }
  .save-indicator.saving { color: var(--fg4);  }
  .save-indicator.saved  { color: var(--green); }
  .save-indicator.error  { color: var(--red);   }

  /* ── Submit button ── */
  .action-row {
    display: flex;
    padding-top: 4px;
    padding-left: calc(120px + 24px); /* align with inputs */
  }

  .btn-enroll {
    background: var(--yellow);
    color: var(--bg-hard);
    border: none;
    border-radius: 3px;
    padding: 6px 28px;
    cursor: pointer;
    font-family: inherit;
    font-size: 1rem;
    font-weight: bold;
    letter-spacing: 0.03em;
    transition: opacity 0.15s;
  }
  .btn-enroll:hover:not(:disabled) { opacity: 0.88; }
  .btn-enroll:disabled { opacity: 0.4; cursor: not-allowed; }

  /* ── Response area ── */
  .response-box {
    background: var(--bg1);
    border: 1px solid var(--bg2);
    border-radius: 3px;
    padding: 12px 16px;
    color: var(--fg2);
    font-family: inherit;
    font-size: 0.9rem;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-all;
    overflow-y: auto;
    max-height: 320px;
  }
</style>
