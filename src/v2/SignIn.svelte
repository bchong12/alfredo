<script lang="ts">
  // Signing in, inside the app: this workspace's database asks who you are
  // before it shows anything. The rest of the app stays where it is.
  import Lock from '@lucide/svelte/icons/lock'
  import WorkspaceMark from './WorkspaceMark.svelte'
  import Header from './Header.svelte'
  import { auth, post, signIn } from '../lib/session.svelte'
  import { activeWorkspace } from '../lib/workspace.svelte'

  const ws = $derived(activeWorkspace())
  let mode = $state<'in' | 'new'>('in')
  let name = $state('')
  let email = $state('')
  let password = $state('')
  let busy = $state(false)

  async function submit(e: Event) {
    e.preventDefault()
    if (busy) return
    busy = true
    auth.error = ''
    if (mode === 'new') {
      try {
        await post(`/api/workspaces/${ws!.id}/account`, { name, email: email.trim(), password })
      } catch (err) {
        auth.error = (err as Error).message
        busy = false
        return
      }
    }
    await signIn(email.trim(), password)
    busy = false
  }
</script>

<div class="page">
  <Header crumbs={['Sign in']} />
  <div class="center">
    <form onsubmit={submit}>
      <div class="top">
        <WorkspaceMark name={ws?.name ?? ''} size={36} />
        <span class="lock"><Lock size={11} /></span>
      </div>
      <h1>{mode === 'in' ? 'Sign in to' : 'Join'} {ws?.name}</h1>
      <p>
        {#if mode === 'in'}{ws?.name}'s database is shared, so it needs to know who you are.
        {:else}The first account in a new workspace becomes its admin. After that, use the email an admin invited.{/if}
      </p>
      {#if mode === 'new'}<label><span>Name</span><input bind:value={name} autocomplete="name" /></label>{/if}
      <label><span>Email</span><input type="email" bind:value={email} autocomplete="username" required /></label>
      <label><span>Password</span><input type="password" bind:value={password} autocomplete={mode === 'in' ? 'current-password' : 'new-password'} minlength={mode === 'new' ? 8 : undefined} required /></label>
      {#if auth.error}<p class="err">{auth.error}</p>{/if}
      <button type="submit" disabled={busy}>{busy ? (mode === 'in' ? 'Signing in…' : 'Creating…') : mode === 'in' ? 'Sign in' : 'Create account'}</button>
      <button type="button" class="link" onclick={() => ((mode = mode === 'in' ? 'new' : 'in'), (auth.error = ''))}>
        {mode === 'in' ? 'New here? Create an account' : 'Have an account? Sign in'}
      </button>
    </form>
  </div>
</div>

<style>
  .page {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .center {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding-bottom: 80px;
  }
  form {
    width: 340px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .top {
    position: relative;
    width: 36px;
    margin-bottom: 4px;
  }
  .lock {
    position: absolute;
    right: -6px;
    bottom: -4px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--ink);
    color: var(--on-accent);
    border: 2px solid var(--bg);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  h1 {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  p {
    margin: 0 0 6px;
    font-size: 13px;
    line-height: 1.5;
    color: var(--ink-2);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 12px;
    color: var(--muted);
  }
  input {
    height: 36px;
    padding: 0 10px;
    border-radius: var(--r-md);
    background: var(--panel);
    border: 1px solid var(--line-strong);
    color: var(--ink);
    font: inherit;
    font-size: 13px;
  }
  button {
    height: 36px;
    margin-top: 4px;
    border-radius: var(--r-md);
    border: 0;
    background: var(--ink);
    color: var(--on-accent);
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .link {
    margin: 0;
    height: auto;
    background: none;
    color: var(--muted);
    font-weight: 400;
    font-size: 12px;
  }
  .link:hover {
    color: var(--ink);
  }
  button:disabled {
    opacity: 0.6;
  }
  .err {
    color: var(--danger);
    font-size: 12px;
  }
</style>
