<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { listen }             from '@tauri-apps/api/event';

  let { servicekey = null }: { servicekey: string | null } = $props();

  // ── Connection slot state ─────────────────────────────────────────────────
  //
  // 16 slots corresponding to loopback addresses 127.0.0.2 – 127.0.0.17.
  // State is kept in sync with the Rust backend via "slot-update" Tauri events.

  const SLOT_COUNT    = 16;
  const RADIUS        = 18;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;  // ≈ 113.1

  type SlotStatus = 'free' | 'active' | 'countdown' | 'idle';

  interface Slot {
    id:       number;      // 1–16  →  127.0.0.{id + 1}
    status:   SlotStatus;
    progress: number;      // 0..1  (1 = full ring, 0 = empty)
    label:    string;      // target / service description when occupied
  }

  let slots = $state<Slot[]>(
    Array.from({ length: SLOT_COUNT }, (_, i) => ({
      id:       i + 1,
      status:   'free' as SlotStatus,
      progress: 1,
      label:    '',
    }))
  );

  // ── Tauri event listener ──────────────────────────────────────────────────

  let unlisten: (() => void) | null = null;

  onMount(async () => {
    unlisten = await listen<{ idx: number; status: string; progress: number }>(
      'slot-update',
      ({ payload }) => {
        // payload.idx is 0-based (slot index); slot.id is 1-based.
        slots = slots.map(s =>
          s.id === payload.idx + 1
            ? { ...s, status: payload.status as SlotStatus, progress: payload.progress }
            : s
        );
      }
    );
  });

  onDestroy(() => { unlisten?.(); });

  // ── Arc helpers ───────────────────────────────────────────────────────────

  function arcStroke(slot: Slot): string {
    switch (slot.status) {
      case 'active':    return 'var(--green)';
      case 'countdown': return slot.progress <= 0.05 ? 'var(--red)' : 'var(--aqua)';
      default:          return 'none';          // free / idle → no arc
    }
  }

  function arcProgress(slot: Slot): number {
    if (slot.status === 'active')    return 1;
    if (slot.status === 'countdown') return slot.progress;
    return 0;
  }

  function slotIp(slot: Slot): string {
    return `127.0.0.${slot.id + 1}`;
  }

  function slotTitle(slot: Slot): string {
    const base = slotIp(slot);
    if (slot.status === 'free' || slot.status === 'idle') return base;
    return slot.label ? `${base} — ${slot.label}` : base;
  }

  // ── Service key clipboard ─────────────────────────────────────────────────

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

  <!-- ── Slot grid ──────────────────────────────────────────────────────────── -->
  <section class="slot-section">
    <h2 class="slot-title">Connection Slots</h2>
    <div class="slot-grid">
      {#each slots as slot (slot.id)}
        {@const p = arcProgress(slot)}
        <div class="slot-item" title={slotTitle(slot)}>
          <svg viewBox="0 0 44 44" width="44" height="44" aria-hidden="true">
            <!-- Background ring, always visible -->
            <circle
              cx="22" cy="22" r={RADIUS}
              fill="none"
              stroke="var(--bg2)"
              stroke-width="5"
            />
            <!-- Progress arc — starts at 12 o'clock, shrinks counter-clockwise -->
            {#if p > 0}
              <circle
                cx="22" cy="22" r={RADIUS}
                fill="none"
                stroke={arcStroke(slot)}
                stroke-width="5"
                stroke-linecap="round"
                stroke-dasharray="{p * CIRCUMFERENCE} {CIRCUMFERENCE}"
                transform="rotate(-90 22 22)"
              />
            {/if}
            <!-- Slot number -->
            <text
              x="22" y="26"
              text-anchor="middle"
              class="slot-num"
              class:slot-num-live={slot.status === 'active' || slot.status === 'countdown'}
            >{slot.id + 1}</text>
          </svg>
        </div>
      {/each}
    </div>
  </section>

  <!-- ── Service key ────────────────────────────────────────────────────────── -->
  <div class="sk-area">
    {#if servicekey}
      <div class="sk-card">
        <div class="sk-label">Service Key</div>
        <div class="sk-value">{servicekey}</div>
        <button class="sk-copy-btn" class:copied onclick={copyToClipboard}>
          {#if copied}✓ Copied!{:else}Copy to Clipboard{/if}
        </button>
      </div>
    {:else}
      <div class="empty-state">
        <span>No active service key</span>
        <span class="hint">Submit a tunnel request with a <code>servicekey</code> field to display it here.</span>
      </div>
    {/if}
  </div>

</div>

<style>
  .functions-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 24px 32px;
    overflow-y: auto;
    gap: 0;
  }

  /* ── Slot section ── */
  .slot-section {
    border-bottom: 1px solid var(--bg2);
    padding-bottom: 20px;
    margin-bottom: 24px;
  }

  .slot-title {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--fg4);
    font-weight: normal;
    margin: 0 0 14px;
  }

  /* 8 columns, rows wrap automatically → two rows of 8 */
  .slot-grid {
    display: grid;
    grid-template-columns: repeat(8, 44px);
    gap: 14px 10px;
  }

  .slot-item {
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: default;
  }

  /* SVG text nodes — font-size / fill set here via CSS class */
  .slot-num {
    font-size: 9px;
    fill: var(--bg3);
    font-family: inherit;
    user-select: none;
  }

  .slot-num-live {
    fill: var(--fg3);
  }

  /* ── Service key area ── */
  .sk-area {
    flex: 1;
  }

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
