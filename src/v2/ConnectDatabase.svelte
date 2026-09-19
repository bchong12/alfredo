<script lang="ts">
  // Where a new workspace keeps its data: this Mac, a Supabase project, or a
  // Cloudflare D1. Used by "Add a workspace" and by Settings > Database. The
  // same steps are MCP tools, so Claude can do any of this for you.
  import Laptop from '@lucide/svelte/icons/laptop'
  import Cloud from '@lucide/svelte/icons/cloud'
  import Database from '@lucide/svelte/icons/database'
  import Ticket from '@lucide/svelte/icons/ticket'
  import ArrowLeft from '@lucide/svelte/icons/arrow-left'
  import Check from '@lucide/svelte/icons/check'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import CopyNode from './CopyNode.svelte'
  import { api, post } from '../lib/session.svelte'
  import { createWorkspace, loadWorkspaces, pick, rememberInvite } from '../lib/workspace.svelte'

  let { onconnected }: { onconnected: (id: string) => void } = $props()

  type Mode = null | 'local' | 'supabase' | 'cloudflare' | 'invite'
  type Project = { ref: string; name: string; region: string; status: string }
  type Job = { step: string; log: string[]; error?: string; workspaceId: string | null }

  let mode = $state<Mode>(null)
  let name = $state('')
  let busy = $state(false)
  let err = $state('')

  async function done(id: string) {
    await loadWorkspaces()
    pick(id)
    onconnected(id)
  }
  async function attempt(fn: () => Promise<void>) {
    busy = true
    err = ''
    try {
      await fn()
    } catch (e) {
      err = (e as Error).message
    }
    busy = false
  }

  // --- this Mac -------------------------------------------------------------------
  const local = () =>
    attempt(async () => {
      const w = await createWorkspace(name.trim())
      await done((w as { id: string }).id)
    })

  // --- Supabase -------------------------------------------------------------------
  let how = $state<'token' | 'keys'>('token')
  let token = $state('')
  let projects = $state<Project[] | null>(null)
  let ref = $state('')
  let keys = $state({ url: '', anonKey: '', serviceKey: '' })
  /** Tables to create by hand: the SQL, and the workspace waiting on it. */
  let setup = $state<{ id: string; sql: string; ref: string } | null>(null)

  const findProjects = () =>
    attempt(async () => {
      projects = await post<Project[]>('/api/workspaces/supabase/projects', { accessToken: token })
      ref = projects.find((p) => p.status === 'ACTIVE_HEALTHY')?.ref ?? projects[0]?.ref ?? ''
      if (!projects.length) err = 'That token sees no projects. Create one at supabase.com first.'
    })

  type Connected = { workspace: { id: string }; schema: 'applied' | 'ready' | 'missing'; sql?: string }
  const connectSupabase = () =>
    attempt(async () => {
      const body = how === 'token' ? { name, accessToken: token, ref } : { name, ...keys }
      const r = await post<Connected>('/api/workspaces/supabase', body)
      if (r.schema === 'missing' && r.sql) setup = { id: r.workspace.id, sql: r.sql, ref: keys.url.match(/https:\/\/([a-z0-9]+)\./)?.[1] ?? '' }
      else await done(r.workspace.id)
    })

  const checkAgain = () =>
    attempt(async () => {
      const r = await post<{ schema: string; missing?: string[] }>(`/api/workspaces/${setup!.id}/schema`, {})
      if (r.schema === 'missing') err = `Still missing: ${r.missing?.join(', ')}. Run the SQL, then check again.`
      else await done(setup!.id)
    })

  // --- Cloudflare -----------------------------------------------------------------
  let cfHow = $state<'create' | 'existing'>('create')
  let login = $state<{ loggedIn: boolean; email: string | null } | null>(null)
  let cf = $state({ url: '', token: '' })
  let job = $state<Job | null>(null)
  const STEPS = [
    { id: 'database', label: 'Create the D1 database' },
    { id: 'tables', label: 'Create the tables' },
    { id: 'worker', label: 'Deploy the Worker' },
    { id: 'token', label: 'Set its access token' },
    { id: 'connect', label: 'Connect' },
  ]
  const stepIndex = $derived(job ? (job.step === 'done' ? STEPS.length : STEPS.findIndex((s) => s.id === job!.step)) : -1)

  const checkLogin = () =>
    attempt(async () => {
      login = await api<{ loggedIn: boolean; email: string | null }>('/api/workspaces/cloudflare/login')
    })

  const createCloudflare = () =>
    attempt(async () => {
      const { job: id } = await post<{ job: string }>('/api/workspaces/cloudflare/deploy', { name })
      job = { step: 'check', log: [], workspaceId: null }
      while (true) {
        await new Promise((r) => setTimeout(r, 1500))
        const j = await api<Job>(`/api/workspaces/cloudflare/deploy/${id}`)
        job = j
        if (j.step === 'failed') throw new Error(j.error ?? 'The deploy failed.')
        if (j.step === 'done' && j.workspaceId) return done(j.workspaceId)
      }
    })

  const connectExisting = () =>
    attempt(async () => {
      const w = await post<{ id: string }>('/api/workspaces/cloudflare', { name, ...cf })
      await done(w.id)
    })

  // --- joining with an invite ------------------------------------------------------
  let link = $state('')
  let joining = $state<{ kind: 'supabase' | 'cloudflare'; name: string } | null>(null)
  let joinName = $state('')
  let joinPassword = $state('')

  const lookAtLink = () =>
    attempt(async () => {
      joining = await post<{ kind: 'supabase' | 'cloudflare'; name: string }>('/api/workspaces/join/inspect', { link })
      // A Cloudflare workspace signs people in itself, so it needs a password now.
      if (joining.kind === 'supabase') await useInvite()
    })

  const useInvite = () =>
    attempt(async () => {
      const r = await post<{ workspace: { id: string }; token: string | null }>('/api/workspaces/join', {
        link,
        name: joinName.trim() || undefined,
        password: joinPassword || undefined,
      })
      if (r.token) rememberInvite(r.workspace.id, r.token)
      await done(r.workspace.id)
    })

  function choose(m: Mode) {
    mode = m
    err = ''
    if (m === 'cloudflare' && !login) checkLogin()
  }
</script>

<div class="connect">
  {#if !mode}
    <input class="field" placeholder="Workspace name" bind:value={name} />
    <button class="opt" disabled={!name.trim()} onclick={() => choose('local')}>
      <span class="dbi"><Laptop size={15} /></span>
      <span class="dbt"><b>On this Mac</b><span>Private and offline. Nothing to set up.</span></span>
    </button>
    <button class="opt" disabled={!name.trim()} onclick={() => choose('supabase')}>
      <span class="dbi"><Database size={15} /></span>
      <span class="dbt"><b>Supabase</b><span>Shared with your team. Paste an access token and Alfredo sets up the tables.</span></span>
    </button>
    <button class="opt" disabled={!name.trim()} onclick={() => choose('cloudflare')}>
      <span class="dbi"><Cloud size={15} /></span>
      <span class="dbt"><b>Cloudflare D1</b><span>Shared with your team, in your own Cloudflare account. Alfredo can create it for you.</span></span>
    </button>
    <button class="opt" onclick={() => choose('invite')}>
      <span class="dbi"><Ticket size={15} /></span>
      <span class="dbt"><b>I have an invite</b><span>Someone sent you a link to their workspace. You need no keys and no name: the link carries both.</span></span>
    </button>
    <p class="hint">Or ask Claude through the Alfredo MCP: “connect my Supabase project to a new workspace”.</p>
  {:else}
    <button class="back" onclick={() => ((mode = null), (err = ''), (setup = null), (job = null))} disabled={busy}><ArrowLeft size={13} /> {mode === 'invite' ? 'Invite' : name}</button>

    {#if mode === 'invite'}
      {#if joining?.kind === 'cloudflare'}
        <p class="lead">You were invited to {joining.name}. Choose a password for it; the workspace keeps your sign-in, and shows you the projects you were put in.</p>
        <input class="field" placeholder="Your name" bind:value={joinName} />
        <input class="field" type="password" placeholder="A password, at least 8 characters" bind:value={joinPassword} onkeydown={(e) => e.key === 'Enter' && joinPassword.length >= 8 && useInvite()} />
        <div><button class="primary" disabled={busy || joinPassword.length < 8} onclick={useInvite}>{busy ? 'Joining…' : 'Join'}</button></div>
      {:else}
        <p class="lead">Paste the link an admin sent you. Alfredo connects to their workspace without any secret key, then asks you to sign in; what you can see is their database's decision, not this Mac's.</p>
        <input class="field mono" placeholder="alfredo:join:…" bind:value={link} onkeydown={(e) => e.key === 'Enter' && link.trim() && lookAtLink()} />
        <div><button class="primary" disabled={busy || !link.trim()} onclick={lookAtLink}>{busy ? 'Connecting…' : 'Continue'}</button></div>
      {/if}
    {:else if mode === 'local'}
      <p class="lead">A private workspace in a folder on this Mac. Copy the folder to back it up.</p>
      <div><button class="primary" disabled={busy} onclick={local}>{busy ? 'Creating…' : 'Create workspace'}</button></div>
    {:else if mode === 'supabase'}
      {#if setup}
        <p class="lead">Connected. The project has no Alfredo tables yet: run this once in its SQL editor, then check again.</p>
        <div class="sql">
          <div class="sqlbar">
            <span>schema.sql</span>
            <CopyNode text={() => setup!.sql} />
          </div>
          <pre>{setup.sql.slice(0, 1200)}…</pre>
        </div>
        <div class="acts">
          {#if setup.ref}<a class="ghost" href="https://supabase.com/dashboard/project/{setup.ref}/sql/new" target="_blank" rel="noreferrer">Open the SQL editor</a>{/if}
          <button class="primary" disabled={busy} onclick={checkAgain}>{busy ? 'Checking…' : 'Check again'}</button>
        </div>
      {:else}
        <div class="seg">
          <button class:on={how === 'token'} onclick={() => ((how = 'token'), (err = ''))}>Access token</button>
          <button class:on={how === 'keys'} onclick={() => ((how = 'keys'), (err = ''))}>Project keys</button>
        </div>
        {#if how === 'token'}
          <p class="lead">
            Make a personal access token at <a href="https://supabase.com/dashboard/account/tokens" target="_blank" rel="noreferrer">supabase.com/dashboard/account/tokens</a>. Alfredo uses it once to read the project's keys and create the tables, then forgets it. The keys go to this Mac's keychain.
          </p>
          <div class="line">
            <input class="field mono grow" type="password" placeholder="sbp_…" bind:value={token} onkeydown={(e) => e.key === 'Enter' && token && findProjects()} />
            <button class="ghost" disabled={busy || !token.trim()} onclick={findProjects}>{busy && !projects ? 'Looking…' : 'Find projects'}</button>
          </div>
          {#if projects?.length}
            <div class="list">
              {#each projects as p (p.ref)}
                <label class="proj" class:on={ref === p.ref}>
                  <input type="radio" bind:group={ref} value={p.ref} />
                  <span class="dbt"><b>{p.name}</b><span class="mono">{p.ref} · {p.region}</span></span>
                  <span class="state" class:off={p.status !== 'ACTIVE_HEALTHY'}>{p.status === 'ACTIVE_HEALTHY' ? 'Active' : p.status.toLowerCase().replace(/_/g, ' ')}</span>
                </label>
              {/each}
            </div>
            <div><button class="primary" disabled={busy || !ref} onclick={connectSupabase}>{busy ? 'Connecting…' : 'Connect and set up'}</button></div>
          {/if}
        {:else}
          <p class="lead">From the project's Settings, API Keys. The secret key never leaves this Mac: it goes to the keychain, and only Alfredo's server uses it.</p>
          <input class="field mono" placeholder="https://<ref>.supabase.co" bind:value={keys.url} />
          <input class="field mono" placeholder="Publishable key (sb_publishable_… or anon)" bind:value={keys.anonKey} />
          <input class="field mono" type="password" placeholder="Secret key (sb_secret_… or service_role)" bind:value={keys.serviceKey} />
          <div><button class="primary" disabled={busy || !keys.url || !keys.anonKey || !keys.serviceKey} onclick={connectSupabase}>{busy ? 'Checking…' : 'Connect'}</button></div>
        {/if}
      {/if}
    {:else if mode === 'cloudflare'}
      {#if job}
        <ol class="steps">
          {#each STEPS as s, i (s.id)}
            <li class:now={i === stepIndex && job.step !== 'failed'} class:ok={i < stepIndex}>
              <span class="tick">{#if i < stepIndex}<Check size={12} />{:else if i === stepIndex && job.step !== 'failed'}<span class="spin"><LoaderCircle size={12} /></span>{/if}</span>
              {s.label}
            </li>
          {/each}
        </ol>
        {#if job.log.length}<p class="mono">{job.log[job.log.length - 1]}</p>{/if}
      {:else}
        <div class="seg">
          <button class:on={cfHow === 'create'} onclick={() => ((cfHow = 'create'), (err = ''))}>Create new</button>
          <button class:on={cfHow === 'existing'} onclick={() => ((cfHow = 'existing'), (err = ''))}>Connect existing</button>
        </div>
        {#if cfHow === 'create'}
          <p class="lead">Alfredo creates a D1 database and a small Worker in your Cloudflare account with your own wrangler login, then keeps the Worker's token in this Mac's keychain. Free tier is plenty.</p>
          {#if !login}
            <p class="note">Checking wrangler…</p>
          {:else if !login.loggedIn}
            <p class="note">Wrangler isn't logged in on this Mac. Run <span class="mono">npx wrangler login</span> in Terminal, then check again.</p>
            <div><button class="ghost" disabled={busy} onclick={checkLogin}>Check again</button></div>
          {:else}
            <p class="note">Signed in to Cloudflare as {login.email}.</p>
            <div><button class="primary" disabled={busy} onclick={createCloudflare}>Create on Cloudflare</button></div>
          {/if}
        {:else}
          <p class="lead">A Worker that speaks Alfredo's workspace API (cloudflare/worker.mjs in Alfredo's repo). The token goes to this Mac's keychain.</p>
          <input class="field mono" placeholder="https://your-worker.workers.dev" bind:value={cf.url} />
          <input class="field mono" type="password" placeholder="Workspace API token" bind:value={cf.token} />
          <div><button class="primary" disabled={busy || !cf.url || !cf.token} onclick={connectExisting}>{busy ? 'Checking…' : 'Connect'}</button></div>
        {/if}
      {/if}
    {/if}
    {#if err}<p class="err">{err}</p>{/if}
  {/if}
</div>

<style>
  .connect {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  button,
  a {
    font: inherit;
    color: inherit;
  }
  .field {
    height: 34px;
    padding: 0 10px;
    border-radius: var(--r-md);
    background: var(--bg);
    border: 1px solid var(--line-strong);
    color: var(--ink);
    font-size: 13px;
    min-width: 0;
  }
  .mono {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
  }
  .field.mono {
    color: var(--ink);
  }
  .grow {
    flex: 1;
  }
  .opt {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .opt:hover:not(:disabled) {
    border-color: var(--line-strong);
    background: var(--raised);
  }
  .opt:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .dbi {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    border-radius: 7px;
    background: var(--raised);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .dbt {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .dbt b {
    font-size: 13px;
    font-weight: 500;
  }
  .dbt > span {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.45;
  }
  .lead,
  .note,
  .hint {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--muted);
  }
  .lead {
    color: var(--ink-2);
  }
  .lead a {
    color: var(--ink);
  }
  .hint {
    margin-top: 4px;
  }
  .back {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 8px 0 4px;
    border: 0;
    border-radius: var(--r-md);
    background: none;
    color: var(--muted);
    font-size: 12px;
    cursor: pointer;
  }
  .back:hover {
    color: var(--ink);
    background: var(--raised);
  }
  .seg {
    display: flex;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    align-self: flex-start;
  }
  .seg button {
    height: 26px;
    padding: 0 10px;
    border: 0;
    border-radius: calc(var(--r-md) - 2px);
    background: none;
    color: var(--muted);
    font-size: 12px;
    cursor: pointer;
  }
  .seg button.on {
    background: var(--raised);
    color: var(--ink);
  }
  .line {
    display: flex;
    gap: 8px;
  }
  .primary,
  .ghost {
    display: inline-flex;
    align-items: center;
    height: 32px;
    padding: 0 14px;
    border-radius: var(--r-md);
    font-size: 13px;
    cursor: pointer;
    text-decoration: none;
    white-space: nowrap;
  }
  .primary {
    border: 0;
    background: var(--ink);
    color: var(--on-accent);
    font-weight: 600;
  }
  .ghost {
    border: 1px solid var(--line-strong);
    background: none;
  }
  .primary:disabled,
  .ghost:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .list {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    overflow: hidden;
  }
  .proj {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    cursor: pointer;
  }
  .proj + .proj {
    border-top: 1px solid var(--line);
  }
  .proj.on {
    background: var(--raised);
  }
  .proj input {
    accent-color: var(--ink);
  }
  .state {
    font-size: 11px;
    color: var(--ink-2);
    text-transform: capitalize;
  }
  .state.off {
    color: var(--muted);
  }
  .sql {
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    overflow: hidden;
  }
  .sqlbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    border-bottom: 1px solid var(--line);
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
  }
  pre {
    margin: 0;
    max-height: 160px;
    overflow: auto;
    padding: 10px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-2);
    white-space: pre-wrap;
  }
  .acts {
    display: flex;
    gap: 8px;
  }
  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .steps li {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--muted);
  }
  .steps li.ok,
  .steps li.now {
    color: var(--ink);
  }
  .tick {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 1px solid var(--line-strong);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .steps li.ok .tick {
    background: var(--ink);
    color: var(--on-accent);
    border-color: var(--ink);
  }
  .spin {
    display: flex;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .err {
    margin: 0;
    font-size: 12px;
    color: var(--danger);
    line-height: 1.5;
  }
</style>
