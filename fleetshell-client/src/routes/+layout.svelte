<script lang="ts">
  import '../app.css';
  let { children } = $props();
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
