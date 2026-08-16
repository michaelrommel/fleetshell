<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { listen }             from '@tauri-apps/api/event';
  import Logo                   from '$lib/components/Logo.svelte';

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

  interface Remap {
    requested: number;   // port the user asked for (target/service port)
    actual:    number;   // ephemeral port actually bound locally
    reason:    string;
  }

  interface Slot {
    id:       number;      // 1–16  →  127.0.0.{id + 1}
    status:   SlotStatus;
    progress: number;      // 0..1  (1 = full pie, 0 = empty)
    label:    string;      // target / service description when occupied
    remaps:   Remap[];     // non-empty when a local port had to be reassigned
  }

  let slots = $state<Slot[]>(
    Array.from({ length: SLOT_COUNT }, (_, i) => ({
      id:       i + 1,
      status:   'free' as SlotStatus,
      progress: 1,
      label:    '',
      remaps:   [] as Remap[],
    }))
  );

  // ── Tauri event listener ──────────────────────────────────────────────────

  let unlisten: (() => void) | null = null;

  onMount(async () => {
    unlisten = await listen<{ idx: number; status: string; progress: number; remaps?: Remap[] }>(
      'slot-update',
      ({ payload }) => {
        const status = payload.status as SlotStatus;
        slots = slots.map(s =>
          s.id === payload.idx + 1
            ? {
                ...s,
                status,
                progress: payload.progress,
                // A fresh event carries the current remaps; on release, clear them.
                remaps: status === 'free'
                  ? []
                  : (payload.remaps ?? s.remaps),
              }
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
    if (slot.status === 'active')    return 'var(--success)';
    if (slot.status === 'countdown') return slot.progress <= 0.05 ? 'var(--danger)' : 'var(--info-alt)';
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
    const head = (slot.status === 'free' || slot.status === 'idle')
      ? base
      : (slot.label ? `${base} — ${slot.label}` : base);
    if (slot.remaps.length === 0) return head;
    const lines = slot.remaps.map(
      r => `  target :${r.requested}  ->  local :${r.actual}  (remapped)\n  reason: ${r.reason}`,
    );
    return `${head}\n${lines.join('\n')}`;
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
  <div class="fn-scroll">

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

          <!-- Port-remap marker: shown when a local port had to be reassigned -->
          {#if slot.remaps.length > 0}
            <span class="slot-remap" aria-label="port remapped">⇄</span>
          {/if}

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

  </div><!-- /.fn-scroll -->

  <footer class="logo-footer">
    <Logo />
  </footer>

</div>

<style>
  .functions-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* Stretchable content area: holds the slots + service key and scrolls when
     content exceeds the viewport. The logo footer below stays pinned. */
  .fn-scroll {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 24px 32px;
    overflow-y: auto;
    gap: 0;
  }

  /* Fixed small footer, pinned to the bottom of the viewport; logo centered
     in the same column as the connection dots. */
  .logo-footer {
    flex-shrink: 0;
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 12px 32px;
    border-top: 1px solid var(--surface-2);
    --logo-fg: var(--text-muted);
  }

  .logo-footer :global(.logo svg) {
    height: 36px;
  }

  /* ── Slot section ── */
  .slot-section {
    border-bottom: 1px solid var(--surface-2);
    padding-bottom: 20px;
    margin-bottom: 24px;
  }

  .slot-title {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-muted);
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
    color: var(--surface-4);
    width: 2ch;               /* exactly two-character width — lines up 2-digit numbers */
    text-align: right;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
    transition: color 0.2s, font-weight 0.2s;
  }

  .slot-num-live {
    color: var(--text);
    font-weight: 600;
  }

  /* Port-remap marker — sits between the number and the disc when the local
     listen port had to be reassigned to an ephemeral one. */
  .slot-remap {
    color: var(--accent);
    font-size: 0.85em;
    line-height: 1;
    flex-shrink: 0;
    cursor: help;
  }

  /* The pie SVG — rendered at 28×28; viewBox stays 44×44 */
  .slot-svg {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
  }

  /* Background disc — muted ring to show slot outline even when free */
  .disc-bg {
    fill: var(--surface-2);
  }

  /* ── Service key area ── */
  .sk-area {
    flex: 1;
  }

  .sk-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--surface);
    border: 1px solid var(--surface-3);
    border-radius: 5px;
    padding: 20px 24px;
    min-width: 420px;
    max-width: 680px;
  }

  .sk-label {
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }

  .sk-value {
    font-family: inherit;
    font-size: 1rem;
    color: var(--info-alt);
    background: var(--bg-header);
    border: 1px solid var(--surface-2);
    border-radius: 3px;
    padding: 10px 12px;
    word-break: break-all;
    user-select: text;
  }

  .sk-copy-btn {
    align-self: flex-start;
    background: var(--surface-2);
    color: var(--text-2);
    border: 1px solid var(--surface-3);
    border-radius: 3px;
    padding: 5px 16px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.9rem;
    transition: background 0.1s, color 0.1s, border-color 0.1s;
    min-width: 140px;
  }

  .sk-copy-btn:hover { background: var(--surface-3); color: var(--text); }

  .sk-copy-btn.copied {
    background: var(--surface);
    color: var(--success);
    border-color: var(--success);
    cursor: default;
  }

  /* ── Empty state ── */
  .empty-state {
    display: flex;
    flex-direction: column;
    gap: 8px;
    color: var(--surface-4);
    margin-top: 8px;
  }

  .hint {
    font-size: 0.85rem;
    color: var(--surface-3);
  }

  code {
    color: var(--accent);
    font-family: inherit;
  }
</style>
