<script lang="ts">
  import { onMount }   from 'svelte';
  import { invoke }    from '@tauri-apps/api/core';
  import '../app.css';

  interface AppConfig { font_size: number; theme?: string; }

  const THEMES = ['nucleus', 'gruvbox'];

  let { children } = $props();

  onMount(async () => {
    try {
      const cfg = await invoke<AppConfig>('get_config');
      document.documentElement.style.setProperty('--font-size', `${cfg.font_size}px`);
      const theme = cfg.theme && THEMES.includes(cfg.theme) ? cfg.theme : 'nucleus';
      document.documentElement.dataset.theme = theme;
    } catch (e) {
      // Config unreadable on first run - CSS :root default (nucleus, 15px) applies.
      console.warn('Could not load config:', e);
    }
  });
</script>

<div class="shell">
  {@render children()}
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }
</style>
