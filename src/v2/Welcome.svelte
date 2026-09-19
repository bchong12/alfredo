<script lang="ts">
  // The first thing a fresh install shows: no workspaces yet, so make one.
  import Wordmark from '../lib/Wordmark.svelte'
  import ConnectDatabase from './ConnectDatabase.svelte'
</script>

<div class="welcome">
  <div class="card">
    <Wordmark height={16} />
    <h1>Your company's brain, in a database you own.</h1>
    <p>A workspace is a board, docs, canvases and meetings, kept in one database: a folder on this Mac, your Supabase project, or your Cloudflare account. Start with one; add more any time.</p>
    <ConnectDatabase onconnected={() => {}} />
  </div>
</div>

<style>
  .welcome {
    height: 100vh;
    overflow: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 40px 16px;
    box-sizing: border-box;
    background: var(--bg);
    color: var(--ink);
  }
  .card {
    width: 460px;
    max-width: 100%;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  h1 {
    margin: 10px 0 0;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.25;
  }
  p {
    margin: 0 0 8px;
    font-size: 13px;
    line-height: 1.55;
    color: var(--ink-2);
  }
</style>
