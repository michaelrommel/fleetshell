<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { listen }             from '@tauri-apps/api/event';

  let { servicekey = null }: { servicekey: string | null } = $props();

  // ── Connection slot state ─────────────────────────────────────────────────
  //
  // 16 slots corresponding to loopback addresses 127.0.0.2 – 127.0.0.17.
  // State is kept in sync with the Rust backend via "slot-update" Tauri events.

  const SLOT_COUNT = 16;
  const RADIUS     = 18;
  const CX         = 22;
  const CY         = 22;

  type SlotStatus = 'free' | 'active' | 'countdown' | 'idle';

  interface Slot {
    id:       number;      // 1–16  →  127.0.0.{id + 1}
    status:   SlotStatus;
    progress: number;      // 0..1  (1 = full pie, 0 = empty)
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
        slots = slots.map(s =>
          s.id === payload.idx + 1
            ? { ...s, status: payload.status as SlotStatus, progress: payload.progress }
            : s
        );
      }
    );
  });

  onDestroy(() => { unlisten?.(); });

  // ── Pie-segment helpers ───────────────────────────────────────────────────

  /**
   * How much of the pie to fill for a given slot.
   *   active    → 1  (full disc)
   *   countdown → slot.progress (shrinking wedge)
   *   free/idle → 0  (no foreground)
   */
  function slotProgress(slot: Slot): number {
    if (slot.status === 'active')    return 1;
    if (slot.status === 'countdown') return slot.progress;
    return 0;
  }

  /** Fill colour for the foreground pie segment. */
  function pieColor(slot: Slot): string {
    if (slot.status === 'active')    return 'var(--green)';
    if (slot.status === 'countdown') return slot.progress <= 0.05 ? 'var(--red)' : 'var(--aqua)';
    return 'transparent';
  }

  /**
   * SVG path for a filled pie wedge.
   *
   * Starts at 12 o'clock and sweeps clockwise by `progress` (0..1).
   * For a full circle (`progress >= 1`) the caller renders a `<circle>`
   * element instead, because a zero-length arc degenerates.
   */
  function piePath(cx: number, cy: number, r: number, progress: number): string {
    const startX = cx;
    const startY = cy - r;
    const angle  = progress * 2 * Math.PI;
    const endX   = cx + r * Math.sin(angle);
    const endY   = cy - r * Math.cos(angle);
    const large  = progress > 0.5 ? 1 : 0;
    return (
      `M ${cx} ${cy} ` +
      `L ${startX} ${startY} ` +
      `A ${r} ${r} 0 ${large} 1 ${endX.toFixed(3)} ${endY.toFixed(3)} ` +
      `Z`
    );
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
        {@const p     = slotProgress(slot)}
        {@const live  = slot.status === 'active' || slot.status === 'countdown'}
        <div class="slot-item" title={slotTitle(slot)}>

          <!-- Number in plain text before the circle -->
          <span class="slot-num" class:slot-num-live={live}>
            {slot.id + 1}
          </span>

          <!-- Pie disc -->
          <svg class="slot-svg" viewBox="0 0 44 44" aria-hidden="true">
            <!-- Background disc — always visible so free slots have a shape -->
            <circle cx={CX} cy={CY} r={RADIUS} class="disc-bg" />

            <!-- Foreground: full filled circle for active, wedge for countdown -->
            {#if p >= 1}
              <circle cx={CX} cy={CY} r={RADIUS} fill={pieColor(slot)} />
            {:else if p > 0}
              <path d={piePath(CX, CY, RADIUS, p)} fill={pieColor(slot)} />
            {/if}
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

  /* 8 columns; each cell is a (number + disc) pair */
  .slot-grid {
    display: grid;
    grid-template-columns: repeat(8, min-content);
    gap: 10px 14px;
  }

  .slot-item {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 5px;
    cursor: default;
    white-space: nowrap;
  }

  /* Number shown before the disc */
  .slot-num {
    font-size: 1em;
    color: var(--bg4);
    width: 2ch;               /* exactly two-character width — lines up 2-digit numbers */
    text-align: right;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
    transition: color 0.2s, font-weight 0.2s;
  }

  .slot-num-live {
    color: var(--fg1);
    font-weight: 600;
  }

  /* The pie SVG — rendered at 28×28; viewBox stays 44×44 */
  .slot-svg {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
  }

  /* Background disc — muted ring to show slot outline even when free */
  .disc-bg {
    fill: var(--bg2);
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
