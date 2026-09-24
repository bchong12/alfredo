<script lang="ts">
  // How to set a shared workspace up, from nothing: the steps in order, for
  // whichever database was chosen. Opened from the add-workspace screen.
  import X from '@lucide/svelte/icons/x'
  import Database from '@lucide/svelte/icons/database'
  import Cloud from '@lucide/svelte/icons/cloud'

  let { kind, onclose }: { kind: 'supabase' | 'cloudflare'; onclose: () => void } = $props()

  const GUIDES = {
    supabase: {
      title: 'Setting up on Supabase',
      lead: 'A Postgres database your team owns. Free tier is plenty. About five minutes.',
      steps: [
        { h: 'Make a project', s: 'At supabase.com, New project. Any name, any region; the password it asks for is the database password, keep it somewhere. Wait until the project says Active.' },
        { h: 'Make a personal access token', s: 'supabase.com/dashboard/account/tokens, Generate new token. Alfredo uses it once to read the project’s keys and create its tables and sign-in rules, then forgets it. (Or use Project keys: the project’s Settings, API Keys, and paste the URL, publishable key and secret key.)' },
        { h: 'Paste it here and pick the project', s: 'Find projects, choose the one you made, Connect and set up. If Alfredo cannot create the tables itself, it shows the SQL to paste into the project’s SQL editor, and Check again.' },
        { h: 'Make your account', s: 'The first account on a fresh database runs the workspace: Create an account with your email and a password. Your keys stay in this Mac’s keychain.' },
        { h: 'Bring the team in', s: 'Settings, Members. Invite someone makes a link for a new person (they choose Add workspace, I have a link, create an account). Copy workspace link is for someone who already has a login there. Everyone lands in General, the room the team shares, with a Personal project of their own.' },
        { h: 'What each person sees', s: 'Their app talks to the database as them; the database’s own rules decide what they may see and change. Admins run the workspace, members edit, viewers read.' },
      ],
    },
    cloudflare: {
      title: 'Setting up on Cloudflare',
      lead: 'A small Worker and a D1 database in your Cloudflare account. Free tier is plenty. About three minutes.',
      steps: [
        { h: 'Have a Cloudflare account', s: 'cloudflare.com, free. Nothing to configure there.' },
        { h: 'Sign wrangler in', s: 'In Terminal: npx wrangler login. A browser tab opens; choose the account the workspace should live in. Come back here and Check again.' },
        { h: 'Create on Cloudflare', s: 'Alfredo makes the D1 database and the Worker with your login, sets the Worker’s token, and keeps that token in this Mac’s keychain. You are the workspace’s owner.' },
        { h: 'Bring the team in', s: 'Settings, Members, Invite someone. They get a link; the Worker signs them in itself, so they only say what to call them. Everyone lands in General with a Personal project of their own.' },
        { h: 'Already have a Worker?', s: 'Connect existing: paste the Worker’s URL and its workspace API token. It has to speak Alfredo’s workspace API (Alfredo’s own template, cloudflare/worker.mjs, or a compatible one).' },
      ],
    },
  } as const
  const g = $derived(GUIDES[kind])
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="scrim" onclick={onclose}>
  <div class="sheet" onclick={(e) => e.stopPropagation()}>
    <div class="top">
      <span class="ico">{#if kind === 'supabase'}<Database size={15} />{:else}<Cloud size={15} />{/if}</span>
      <div class="tt"><b>{g.title}</b><span>{g.lead}</span></div>
      <button class="x" aria-label="Close" onclick={onclose}><X size={14} /></button>
    </div>
    <ol>
      {#each g.steps as step, i (step.h)}
        <li>
          <span class="n">{i + 1}</span>
          <div class="st"><b>{step.h}</b><span>{step.s}</span></div>
        </li>
      {/each}
    </ol>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 95;
    background: var(--scrim);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .sheet {
    width: min(600px, calc(100vw - 48px));
    max-height: calc(100vh - 80px);
    overflow: auto;
    background: var(--panel);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-md);
  }
  .top {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 18px 18px 14px;
    border-bottom: 1px solid var(--line);
  }
  .ico {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: 8px;
    background: var(--raised);
    color: var(--ink);
    flex: none;
  }
  .tt {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1;
    min-width: 0;
  }
  .tt b {
    font-size: 14px;
    font-weight: 600;
    color: var(--ink);
  }
  .tt span {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.5;
  }
  .x {
    background: none;
    border: 0;
    color: var(--muted);
    cursor: pointer;
    display: flex;
    padding: 4px;
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 8px 18px 18px;
  }
  li {
    display: flex;
    gap: 14px;
    padding: 12px 0;
    border-bottom: 1px solid var(--line);
  }
  li:last-child {
    border-bottom: 0;
  }
  .n {
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 1px solid var(--line-strong);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-2);
    margin-top: 1px;
  }
  .st {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .st b {
    font-size: 13px;
    font-weight: 600;
    color: var(--ink);
  }
  .st span {
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--ink-2);
  }
</style>
