<script lang="ts">
  // Signing in, inside the app: this workspace's database asks who you are
  // before it shows anything. The rest of the app stays where it is.
  import Lock from '@lucide/svelte/icons/lock'
  import WorkspaceMark from './WorkspaceMark.svelte'
  import Header from './Header.svelte'
  import { auth, post, signIn, signUp, signInWithGoogle } from '../lib/session.svelte'
  import { activeWorkspace, pendingInvite, clearInvite, workspace } from '../lib/workspace.svelte'
  import { loadWorkspaceState } from './state.svelte'
  import { v2 } from './api'

  const ws = $derived(activeWorkspace())
  /** The invitation waiting for this workspace, if one was pasted in. */
  const invite = $derived(ws ? pendingInvite(ws.id) : null)
  // The hosted site has no owner's install behind it: an account there is
  // made against the project directly, and only an invited email gets in.
  const owner = $derived(!workspace.hosted && ws?.supabase?.mode !== 'member')
  let mode = $state<'in' | 'new'>('in')
  let name = $state('')
  let email = $state('')
  let password = $state('')
  let busy = $state(false)

  // Someone arriving with an invitation is making an account, not signing in.
  $effect(() => {
    if (invite) mode = 'new'
  })

  /** Once there is a session, spend the invitation: the database writes the person. */
  async function claim() {
    if (!invite || !ws) return
    try {
      if (workspace.hosted) await v2.post('/invites/claim', { token: invite, name: name.trim() || undefined })
      else await post(`/api/workspaces/${ws.id}/claim`, { token: invite, name: name.trim() || undefined })
      clearInvite(ws.id)
      await loadWorkspaceState(email.trim() || null)
    } catch (e) {
      auth.error = (e as Error).message
    }
  }

  async function submit(e: Event) {
    e.preventDefault()
    if (busy || !ws) return
    busy = true
    auth.error = ''
    let ok = false
    if (mode === 'new') {
      // An owner's install can make the account outright; a member signs up
      // against the project with the publishable key.
      if (owner && !invite) {
        try {
          await post(`/api/workspaces/${ws.id}/account`, { name, email: email.trim(), password })
          ok = await signIn(email.trim(), password)
        } catch (err) {
          auth.error = (err as Error).message
        }
      } else {
        ok = await signUp(email.trim(), password)
        if (!ok && !auth.error) ok = await signIn(email.trim(), password)
      }
    } else {
      ok = await signIn(email.trim(), password)
    }
    if (ok && invite) await claim()
    busy = false
  }

  async function google() {
    if (busy || !ws) return
    busy = true
    const ok = await signInWithGoogle(ws.id)
    if (ok && invite) await claim()
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
        {#if invite}You were invited to {ws?.name}. Use the email the invitation was sent to, and you land in the projects it names.
        {:else if mode === 'in'}{ws?.name}'s database is shared, so it needs to know who you are.
        {:else if owner}You connected this database, so the first account here runs the workspace: you invite everyone else.
        {:else}Use the email an admin invited, or ask them for an invite link.{/if}
      </p>
      {#if !workspace.hosted}
      <button type="button" class="google" onclick={google} disabled={busy}>
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
          <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.7v3h3.9c2.3-2.1 3.5-5.2 3.5-8.9z" />
          <path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1A12 12 0 0 0 12 24z" />
          <path fill="#FBBC05" d="M5.4 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.4a12 12 0 0 0 0 10.8l4-3.1z" />
          <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.4 6.6l4 3.1C6.3 6.9 8.9 4.8 12 4.8z" />
        </svg>
        Sign in with Google
      </button>
      <span class="or">or</span>
      {/if}
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
  .google {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    height: 36px;
    margin-top: 2px;
    border-radius: var(--r-md);
    border: 1px solid var(--line-strong);
    background: var(--panel);
    color: var(--ink);
    font-weight: 500;
  }
  .google:hover {
    background: var(--raised);
  }
  .or {
    text-align: center;
    font-size: var(--fs-1);
    color: var(--muted);
  }
  .err {
    color: var(--danger);
    font-size: 12px;
  }
</style>
