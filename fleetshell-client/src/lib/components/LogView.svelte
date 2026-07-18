<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { attachLogger, LogLevel } from '@tauri-apps/plugin-log';

  const MAX_LINES = 5000;

  // ── State ────────────────────────────────────────────────────────────────
  interface LogLine {
    text: string;
    cls:  string;   // CSS class for colour
  }

  let logLines:   LogLine[]            = $state([]);
  let scrollEl:   HTMLElement | null   = $state(null);
  let autoScroll: boolean              = $state(true);
  let unlisten:   (() => void) | null  = null;

  // ── Helpers ──────────────────────────────────────────────────────────────
  function levelCls(level: LogLevel): string {
    switch (level) {
      case LogLevel.Error: return 'lvl-error';
      case LogLevel.Warn:  return 'lvl-warn';
      case LogLevel.Info:  return 'lvl-info';
      case LogLevel.Debug: return 'lvl-debug';
      case LogLevel.Trace: return 'lvl-trace';
      default:             return 'lvl-trace';
    }
  }

  function levelTag(level: LogLevel): string {
    switch (level) {
      case LogLevel.Error: return 'ERROR';
      case LogLevel.Warn:  return 'WARN ';
      case LogLevel.Info:  return 'INFO ';
      case LogLevel.Debug: return 'DEBUG';
      case LogLevel.Trace: return 'TRACE';
      default:             return '?????';
    }
  }

  /** Guess a CSS class from a raw log-file line. */
  function clsFromRaw(raw: string): string {
    const u = raw.toUpperCase();
    if (u.includes(' ERROR ') || u.includes('[ERROR]')) return 'lvl-error';
    if (u.includes(' WARN ')  || u.includes('[WARN]'))  return 'lvl-warn';
    if (u.includes(' INFO ')  || u.includes('[INFO]'))  return 'lvl-info';
    if (u.includes(' DEBUG ') || u.includes('[DEBUG]')) return 'lvl-debug';
    return 'lvl-trace';
  }

  function push(line: LogLine) {
    if (logLines.length >= MAX_LINES) {
      logLines = [...logLines.slice(logLines.length - MAX_LINES + 1), line];
    } else {
      logLines = [...logLines, line];
    }
  }

  function scrollToBottom() {
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  function onScroll() {
    if (!scrollEl) return;
    const distFromBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    autoScroll = distFromBottom < 40;
  }

  // Auto-scroll whenever lines update, if enabled.
  $effect(() => {
    void logLines;   // subscribe to reactive changes
    if (autoScroll) {
      // Schedule after DOM update.
      requestAnimationFrame(scrollToBottom);
    }
  });

  // ── Lifecycle ────────────────────────────────────────────────────────────
  onMount(async () => {
    // 1. Load history from the log file via Rust command.
    try {
      const history: string[] = await invoke('get_log_history', { lines: MAX_LINES });
      logLines = history.map((raw) => ({ text: raw, cls: clsFromRaw(raw) }));
    } catch (e) {
      logLines = [{ text: `[ERROR] Could not load log history: ${e}`, cls: 'lvl-error' }];
    }

    // 2. Subscribe to real-time log records emitted by the Rust side.
    unlisten = await attachLogger(({ level, message }) => {
      const ts  = new Date().toISOString().replace('T', ' ').slice(0, 23);
      push({ text: `${ts} ${levelTag(level)} ${message}`, cls: levelCls(level) });
    });

    scrollToBottom();
  });

  onDestroy(() => {
    unlisten?.();
  });
</script>

<div class="log-wrap">
  <!-- Toolbar -->
  <div class="log-toolbar">
    <span class="log-count">{logLines.length} / {MAX_LINES} lines</span>
    <button class="btn-clear" onclick={() => (logLines = [])}>Clear</button>
    <label class="autoscroll-toggle">
      <input type="checkbox" bind:checked={autoScroll} />
      Auto-scroll
    </label>
  </div>

  <!-- Log body -->
  <div
    class="log-body"
    bind:this={scrollEl}
    onscroll={onScroll}
    role="log"
    aria-live="polite"
    aria-label="Application log"
  >
    {#each logLines as line (line)}
      <div class="log-line {line.cls}">{line.text}</div>
    {/each}
  </div>
</div>

<style>
  .log-wrap {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  /* ── Toolbar ── */
  .log-toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 10px;
    background: var(--bg1);
    border-bottom: 1px solid var(--bg2);
    flex-shrink: 0;
  }

  .log-count {
    font-size: 0.85rem;
    color: var(--fg4);
    margin-right: auto;
  }

  .btn-clear {
    background: var(--bg2);
    color: var(--fg3);
    border: 1px solid var(--bg3);
    border-radius: 3px;
    padding: 2px 10px;
    cursor: pointer;
    font-size: 0.85rem;
    font-family: inherit;
    transition: background 0.1s;
  }
  .btn-clear:hover { background: var(--bg3); color: var(--fg); }

  .autoscroll-toggle {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 0.85rem;
    color: var(--fg4);
    cursor: pointer;
    user-select: none;
  }
  .autoscroll-toggle input { cursor: pointer; accent-color: var(--aqua); }

  /* ── Log body ── */
  .log-body {
    flex: 1;
    overflow-y: auto;
    overflow-x: auto;
    padding: 6px 8px;
    background: var(--bg-hard);
  }

  .log-line {
    white-space: pre;
    line-height: 1.55;
    font-size: 0.9rem;
  }

  /* ── Level colours ── */
  .lvl-error { color: var(--red);    }
  .lvl-warn  { color: var(--yellow); }
  .lvl-info  { color: var(--fg2);    }
  .lvl-debug { color: var(--blue);   }
  .lvl-trace { color: var(--gray);   }
</style>
