<script module lang="ts">
  // What Connections last saw. Module scope, so reopening the panel is instant.
  let lastSnap: any = null
</script>

<script lang="ts">
  // Settings for the current workspace (and a little for this app).
  import Select from './Select.svelte'
  import FolderTree from '@lucide/svelte/icons/folder-tree'
  import BrainIcon from '@lucide/svelte/icons/brain'
  import { scope, PROJECT_COLORS_LIST as PROJECT_COLORS, type Project, type ProjectRole } from './project.svelte'
  import { rememberBrand, rememberFaces, forgetBrand, forgetShell } from './remembered.svelte'
  import { takeFocus } from './focus'
  import { setProject } from './state.svelte'
  import ConnectDatabase from './ConnectDatabase.svelte'
  import { PACK_TABS } from './packs'
  import X from '@lucide/svelte/icons/x'
  import Building from '@lucide/svelte/icons/building'
  import LayoutGrid from '@lucide/svelte/icons/layout-grid'
  import Users from '@lucide/svelte/icons/users'
  import Database from '@lucide/svelte/icons/database'
  import Plug from '@lucide/svelte/icons/plug'
  import Cpu from '@lucide/svelte/icons/cpu'
  import Sun from '@lucide/svelte/icons/sun'
  import Upload from '@lucide/svelte/icons/upload'
  import Camera from '@lucide/svelte/icons/camera'
  import Link from '@lucide/svelte/icons/link'
  import Shield from '@lucide/svelte/icons/shield'
  import ArrowUp from '@lucide/svelte/icons/arrow-up'
  import ArrowDown from '@lucide/svelte/icons/arrow-down'
  import Plus from '@lucide/svelte/icons/plus'
  import Laptop from '@lucide/svelte/icons/laptop'
  import Cloud from '@lucide/svelte/icons/cloud'
  import Check from '@lucide/svelte/icons/check'
  import Repeat from '@lucide/svelte/icons/repeat'
  import { drop } from './cache'
  import WorkspaceMark from './WorkspaceMark.svelte'
  import { untrack } from 'svelte'
  import Face from './Face.svelte'
  import { v2, imageDataUrl, type Person, type Settings, type TabDef } from './api'
  import { ui, type SettingsPage } from './state.svelte'
  import { activeWorkspace, workspace, updateWorkspace, removeWorkspace, loadWorkspaces, pick } from '../lib/workspace.svelte'
  import { api, post } from '../lib/session.svelte'
  import { theme, applyTheme, type Theme } from '../lib/theme.svelte'

  const ws = $derived(activeWorkspace())
  const where = (k?: string) => (k === 'remote' ? 'Supabase' : k === 'cloudflare' ? 'Cloudflare D1' : 'This Mac')

  const PAGES: { id: SettingsPage; label: string; icon: any; group: 'ws' | 'app' }[] = [
    { id: 'general', label: 'General', icon: Building, group: 'ws' },
    { id: 'tabs', label: 'Tabs', icon: LayoutGrid, group: 'ws' },
    { id: 'projects', label: 'Projects', icon: FolderTree, group: 'ws' },
    { id: 'cycles', label: 'Cycles', icon: Repeat, group: 'ws' },
    { id: 'members', label: 'Members', icon: Users, group: 'ws' },
    { id: 'database', label: 'Database', icon: Database, group: 'ws' },
    { id: 'connections', label: 'Connections', icon: Plug, group: 'ws' },
    { id: 'models', label: 'Models', icon: Cpu, group: 'app' },
    { id: 'appearance', label: 'Appearance', icon: Sun, group: 'app' },
  ]

  // --- projects ------------------------------------------------------------------
  let projects = $state<Project[]>([])
  let newProject = $state('')
  $effect(() => {
    projects = scope.list.map((p) => ({ ...p }))
  })
  async function saveProjects(list: Project[], enabled?: boolean) {
    try {
      const r = await v2.put<{ enabled: boolean; projects: Project[]; canManage?: boolean }>('/projects', { projects: list, ...(enabled === undefined ? {} : { enabled }) })
      scope.enabled = r.enabled
      scope.list = r.projects
      scope.canManage = !!r.canManage
      if (scope.id && !r.projects.some((p) => p.id === scope.id && !p.archived)) setProject(null)
      projects = r.projects.map((p) => ({ ...p }))
    } catch (e) {
      fail(e)
    }
  }
  const addProject = () => {
    const name = newProject.trim()
    if (!name) return
    newProject = ''
    // Whoever makes it is in it; workspace admins are in every project anyway.
    saveProjects([...projects, { id: '', name, color: PROJECT_COLORS[projects.length % PROJECT_COLORS.length], members: [] }], true)
  }
  /** Who is in a project, and what they may do there. */
  const roleIn = (p: Project, personId: string) => (p.members ?? []).find((m) => m.personId === personId)?.role ?? null
  function setRoleIn(i: number, personId: string, role: ProjectRole | null) {
    const cur = projects[i].members ?? []
    const next = role ? [...cur.filter((m) => m.personId !== personId), { personId, role }] : cur.filter((m) => m.personId !== personId)
    saveProjects(projects.map((x, k) => (k === i ? { ...x, members: next } : x)))
  }
  const ROLE_LABEL: Record<ProjectRole, string> = { admin: 'Runs it', write: 'Can edit', read: 'Read only' }
  let openAccess = $state<string | null>(null)

  // --- invitations ---------------------------------------------------------------
  type Invite = { id: string; email: string; role: 'admin' | 'member'; projects: { id: string; role: ProjectRole }[]; createdAt: string; usedAt?: string | null }
  let invites = $state<Invite[]>([])
  let inviteProjects = $state<Record<string, ProjectRole>>({})
  let madeLink = $state('')
  let linkCopied = $state(false)
  async function loadInvites() {
    if (!scope.canManage) return
    invites = await v2.get<Invite[]>('/invites').catch(() => [])
  }
  /** A workspace on this Mac has no sign-in, so a person is simply added. */
  const invitesAreLinks = $derived(ws?.kind !== 'local')

  async function makeInvite() {
    const email = inviteEmail.trim().toLowerCase()
    if (!email) return
    if (!invitesAreLinks) {
      try {
        await v2.post('/members/invite', { email, role: inviteRole })
        inviteEmail = ''
        await refreshMembers()
        flash('Added')
      } catch (e) {
        fail(e)
      }
      return
    }
    try {
      const r = await v2.post<{ link: string | null; token: string }>('/invites', {
        email,
        role: inviteRole,
        projects: Object.entries(inviteProjects).map(([id, role]) => ({ id, role })),
      })
      madeLink = r.link ?? ''
      inviteEmail = ''
      inviteProjects = {}
      await loadInvites()
      if (!r.link) flash('Invitation made. This workspace has no link to share; add them in Members.')
    } catch (e) {
      fail(e)
    }
  }
  async function revokeInvite(id: string) {
    try {
      await v2.del(`/invites/${id}`)
      await loadInvites()
    } catch (e) {
      fail(e)
    }
  }
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(madeLink)
      linkCopied = true
      setTimeout(() => (linkCopied = false), 1500)
    } catch {}
  }

  // The waiting invitations, whenever an admin looks at Members.
  $effect(() => {
    if (ui.settingsPage === 'members' && scope.canManage) untrack(() => loadInvites())
  })

  let msg = $state('')
  const flash = (m: string) => {
    msg = m
    setTimeout(() => (msg = ''), 2500)
  }
  const fail = (e: unknown) => (ui.error = (e as Error).message)

  // --- general ---------------------------------------------------------------
  let name = $state(ui.settings?.name ?? ws?.name ?? '')
  let status = $state<{ kind: string; ok: boolean; detail: string; missing?: string[] } | null>(null)
  $effect(() => {
    const id = ws?.id
    if (!id) return
    api<{ kind: string; ok: boolean; detail: string; missing?: string[] }>(`/api/workspaces/${id}/status`).then((s) => (status = s)).catch(() => {})
  })
  async function saveSettings(patch: Partial<Settings>) {
    try {
      ui.settings = await v2.put<Settings>('/settings', patch)
      flash('Saved')
    } catch (e) {
      fail(e)
    }
  }
  async function saveName() {
    if (!name.trim() || name === ui.settings?.name) return
    await saveSettings({ name: name.trim() })
    if (ws) await updateWorkspace(ws.id, { name: name.trim() }).catch(() => {})
    rememberBrand(ws?.id ?? '', { name: name.trim(), logo: ui.settings?.logo ?? null })
  }
  async function pickLogo(e: Event) {
    const f = (e.currentTarget as HTMLInputElement).files?.[0]
    if (!f) return
    await saveSettings({ logo: await imageDataUrl(f, 256) })
  }
  /**
   * Removing a local workspace deletes the folder it lives in, and nothing
   * brings it back. Two clicks in a row is not enough of a fence for that --
   * it sits under the pane everyone tabs through -- so the workspace has to be
   * named before the button does anything.
   */
  let confirmRemove = $state(false)
  let removeName = $state('')
  const removeReady = $derived(!!ws && removeName.trim().toLowerCase() === (ui.settings?.name ?? ws.name).trim().toLowerCase())

  async function forget() {
    if (!ws || ws.kind === 'remote') return
    if (!confirmRemove) {
      confirmRemove = true
      removeName = ''
      return
    }
    if (!removeReady) return
    forgetBrand(ws.id)
    forgetShell(ws.id)
    await removeWorkspace(ws.id).catch(fail)
    ui.overlay = null
  }

  // --- cycles ------------------------------------------------------------------------
  let cyc = $state({ length: ui.settings?.cycles?.length ?? 1, rollover: ui.settings?.cycles?.rollover ?? 'ask', upcoming: ui.settings?.cycles?.upcoming ?? 1 })
  async function saveCycles(patch: Partial<typeof cyc>) {
    cyc = { ...cyc, ...patch }
    await saveSettings({ cycles: $state.snapshot(cyc) as any })
    drop('/weeks')
    drop('/cards')
  }

  // --- tabs --------------------------------------------------------------------
  let tabs = $state<TabDef[]>(structuredClone($state.snapshot(ui.settings?.tabs ?? [])))
  let json = $state(false)
  let jsonText = $state('')
  let jsonErr = $state('')
  let newType = $state<TabDef['type']>('board')
  $effect(() => {
    if (json) jsonText = JSON.stringify({ name: ui.settings?.name, tabs: $state.snapshot(tabs) }, null, 2)
  })
  function move(i: number, d: number) {
    const j = i + d
    if (j < 0 || j >= tabs.length) return
    const next = [...tabs]
    ;[next[i], next[j]] = [next[j], next[i]]
    tabs = next
    saveSettings({ tabs: $state.snapshot(tabs) })
  }
  function toggle(i: number) {
    tabs = tabs.map((t, k) => (k === i ? { ...t, hidden: !t.hidden } : t))
    saveSettings({ tabs: $state.snapshot(tabs) })
  }
  function rename(i: number, v: string) {
    tabs = tabs.map((t, k) => (k === i ? { ...t, name: v } : t))
  }
  function addTab() {
    const base = ({ board: 'Board', docs: 'Docs', canvas: 'Canvas', meetings: 'Meetings' } as Record<string, string>)[newType] ?? newType.charAt(0).toUpperCase() + newType.slice(1)
    let id = newType as string
    for (let n = 2; tabs.some((t) => t.id === id); n++) id = `${newType}-${n}`
    tabs = [...tabs, { id, type: newType, name: tabs.some((t) => t.type === newType) ? `${base} ${tabs.filter((t) => t.type === newType).length + 1}` : base }]
    saveSettings({ tabs: $state.snapshot(tabs) })
  }
  function applyJson() {
    jsonErr = ''
    try {
      const parsed = JSON.parse(jsonText)
      const list: TabDef[] = parsed.tabs
      if (!Array.isArray(list) || !list.length || !list.every((t) => t.id && t.name && typeof t.type === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(t.type))) {
        throw new Error('Every tab needs an id, a name and a type: board, docs, canvas, meetings, or a pack type.')
      }
      tabs = list
      saveSettings({ tabs: list, ...(parsed.name ? { name: parsed.name } : {}) })
    } catch (e) {
      jsonErr = (e as Error).message
    }
  }

  // --- members -------------------------------------------------------------------
  let inviteEmail = $state('')
  let inviteRole = $state<'member' | 'admin'>('member')
  async function refreshMembers() {
    ui.members = await v2.get<Person[]>('/members')
    rememberFaces(ui.members)
    if (ui.me) ui.me = ui.members.find((m) => m.id === ui.me!.id) ?? ui.me
  }
  async function uploadFace(e: Event, id: string) {
    const f = (e.currentTarget as HTMLInputElement).files?.[0]
    if (!f) return
    try {
      await v2.patch(`/members/${id}`, { avatar: await imageDataUrl(f, 192) })
      await refreshMembers()
      flash('Photo updated')
    } catch (err) {
      fail(err)
    }
  }
  async function setRole(p: Person, role: string) {
    try {
      await v2.patch(`/members/${p.id}`, { role })
      await refreshMembers()
    } catch (e) {
      fail(e)
    }
  }

  // --- database ------------------------------------------------------------------
  let sqlCopied = $state(false)
  async function copySetupSql() {
    try {
      const r = await post<{ sql?: string }>(`/api/workspaces/${ws!.id}/schema`, {})
      if (r.sql) await navigator.clipboard.writeText(r.sql)
      sqlCopied = true
      setTimeout(() => (sqlCopied = false), 1400)
    } catch (e) {
      fail(e)
    }
  }

  // --- connections ---------------------------------------------------------------
  const APPS = [
    { slug: 'gmail', name: 'Gmail', blurb: 'Threads link to cards and docs', logo: 'https://svgl.app/library/gmail.svg', google: true },
    { slug: 'googlecalendar', name: 'Google Calendar', blurb: 'Upcoming meetings to transcribe', logo: 'https://svgl.app/library/google-calendar.svg', google: true },
    { slug: 'googlemeet', name: 'Google Meet', blurb: 'Meeting links and spaces', logo: 'https://svgl.app/library/google-meet.svg', google: true },
    { slug: 'googledrive', name: 'Google Drive', blurb: 'Attach files anywhere', logo: 'https://svgl.app/library/drive.svg', google: true },
    { slug: 'googledocs', name: 'Google Docs', blurb: 'Import into Docs', logo: 'https://upload.wikimedia.org/wikipedia/commons/0/01/Google_Docs_logo_%282014-2020%29.svg', google: true },
    { slug: 'googlesheets', name: 'Google Sheets', blurb: 'Live tables in Docs', logo: 'https://svgl.app/library/google-sheets.svg', google: true },
    { slug: 'slack', name: 'Slack', blurb: 'Post notes to a channel', logo: 'https://svgl.app/library/slack.svg', google: false },
    { slug: 'github', name: 'GitHub', blurb: 'Issues become cards', logo: 'https://svgl.app/library/github_dark.svg', google: false },
  ]
  type Account = { id: string; alias: string; status: string; email?: string }
  type Snap = { status: { installed: boolean; loggedIn: boolean; email: string }; accounts: Record<string, Account[]>; checking: boolean }
  // Kept across openings of this panel, so it draws the moment you land on it.
  let snap = $state<Snap | null>(lastSnap)
  const composioOk = $derived(snap?.status ?? null)
  const accountsFor = (slug: string) => (snap?.accounts?.[slug] ?? []).filter((a) => a.status === 'ACTIVE')
  /** The account this workspace uses for an app, by alias. */
  const chosen = (slug: string) => ws?.composio?.[slug] ?? ''
  // "googlecalendar_carex-basket" is the toolkit and the account; the toolkit
  // is already the card, so the name is enough.
  const accountLabel = (a: Account) => a.email ?? a.alias.replace(/^[a-z0-9]+_/, '') ?? a.id

  async function loadConnections(refresh = false) {
    try {
      snap = await api<Snap>(`/api/composio/all${refresh ? '?refresh=1' : ''}`)
      lastSnap = snap
      // A stale answer comes back at once and the real one follows.
      if (snap.checking) setTimeout(() => loadConnections(), 2500)
    } catch {
      snap = { status: { installed: false, loggedIn: false, email: '' }, accounts: {}, checking: false }
    }
  }
  $effect(() => {
    if (ui.settingsPage === 'connections') untrack(() => loadConnections())
  })

  /** Which account this workspace uses for an app. Each workspace picks its own. */
  async function useAccount(slug: string, alias: string) {
    if (alias === '__new') return link(slug)
    const next = { ...(ws?.composio ?? {}) }
    if (alias) next[slug] = alias
    else delete next[slug]
    try {
      await updateWorkspace(ws!.id, { composio: next })
      flash(alias ? 'This workspace will use that account' : 'Disconnected here')
    } catch (e) {
      fail(e)
    }
  }

  async function link(slug: string) {
    try {
      // The alias says which workspace asked, so accounts stay apart.
      const r = await post<{ url: string }>('/api/composio/link', { toolkit: slug, alias: ws?.id })
      window.open(r.url, '_blank')
      flash('Finish signing in in your browser, then come back')
      setTimeout(() => loadConnections(true), 4000)
    } catch (e) {
      fail(e)
    }
  }

  // --- models --------------------------------------------------------------------
  type Brain = { model: string; downloaded: boolean; chunks: number; progress: { state: string; done: number; total: number; error?: string } }
  let brain = $state<Brain | null>(null)
  let watching: ReturnType<typeof setTimeout> | undefined
  async function loadBrain() {
    brain = await v2.get<Brain>('/brain').catch(() => brain)
    clearTimeout(watching)
    // While it reads, keep the count moving.
    if (brain?.progress?.state === 'running') watching = setTimeout(loadBrain, 1200)
  }
  async function readWorkspaceIn() {
    try {
      await v2.post('/brain/read', {})
      await loadBrain()
    } catch (e) {
      fail(e)
    }
  }
  $effect(() => {
    if (ui.settingsPage === 'models') untrack(() => loadBrain())
  })

  let engine = $state<{ parakeet: boolean } | null>(null)
  v2.get<{ parakeet: boolean }>('/transcribe/engine').then((e) => (engine = e)).catch(() => {})
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="scrim" onclick={() => (ui.overlay = null)}>
  <div class="modal" onclick={(e) => e.stopPropagation()}>
    <nav>
      <span class="g">{ui.settings?.name ?? ws?.name}</span>
      {#each PAGES.filter((p) => p.group === 'ws') as p}
        <button class:on={ui.settingsPage === p.id} onclick={() => (ui.settingsPage = p.id)}><p.icon size={14} /><span>{p.label}</span></button>
      {/each}
      <span class="g">App</span>
      {#each PAGES.filter((p) => p.group === 'app') as p}
        <button class:on={ui.settingsPage === p.id} onclick={() => (ui.settingsPage = p.id)}><p.icon size={14} /><span>{p.label}</span></button>
      {/each}
    </nav>

    <div class="body">
      <div class="head">
        <h2>{PAGES.find((p) => p.id === ui.settingsPage)?.label}</h2>
        {#if msg}<span class="msg"><Check size={12} />{msg}</span>{/if}
        <button class="close" onclick={() => (ui.overlay = null)} aria-label="Close"><X size={15} /></button>
      </div>

      {#if ui.settingsPage === 'general'}
        <section>
          <div class="lab"><b>Logo</b><span>Shown in the workspace switcher. Square PNG or SVG works best.</span></div>
          <div class="logo">
            <WorkspaceMark name={ui.settings?.name ?? ''} logo={ui.settings?.logo ?? null} size={64} />
            <label class="drop"><Upload size={14} /><span>Drop an image or <b>browse</b></span><input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onchange={pickLogo} /></label>
            {#if ui.settings?.logo}<button class="link" onclick={() => saveSettings({ logo: null })}>Remove</button>{/if}
          </div>
        </section>
        <section>
          <div class="lab"><b>Name</b></div>
          <input class="field" bind:value={name} onblur={saveName} onkeydown={(e) => e.key === 'Enter' && saveName()} />
        </section>
        <section class="sep">
          <div class="lab"><b>Database</b><span>Where this workspace's cards, docs, canvases and meetings are stored.</span></div>
          <div class="dbrow">
            <div class="dbi">{#if ws?.kind === 'local'}<Laptop size={15} />{:else if ws?.kind === 'cloudflare'}<Cloud size={15} />{:else}<Database size={15} />{/if}</div>
            <div class="dbt">
              <span class="h">{where(ws?.kind)} {#if status}<i class="dot" class:bad={!status.ok}></i><small>{status.ok ? 'Connected' : 'Not reachable'}</small>{/if}</span>
              <span class="mono">{status?.detail ?? ''}</span>
            </div>
            <button class="ghost" onclick={() => (ui.settingsPage = 'database')}>Change</button>
          </div>
        </section>
        {#if ws && ws.kind !== 'remote'}
          <div class="grow"></div>
          <section class="danger">
            <div class="lab"><b>Remove workspace from this Mac</b><span>{ws.kind === 'cloudflare' ? 'The Cloudflare database is untouched. You can reconnect it later.' : 'This deletes the folder on this Mac.'}</span></div>
            {#if confirmRemove}
              <div class="sure">
                <span>Type <b>{ui.settings?.name ?? ws.name}</b> to remove it.</span>
                <div class="srow">
                  <input bind:value={removeName} placeholder={ui.settings?.name ?? ws.name} use:takeFocus onkeydown={(e) => e.key === 'Enter' && removeReady && forget()} />
                  <button class="red" disabled={!removeReady} onclick={forget}>Remove</button>
                  <button class="ghost" onclick={() => ((confirmRemove = false), (removeName = ''))}>Cancel</button>
                </div>
              </div>
            {:else}
              <button class="red" onclick={forget}>Remove</button>
            {/if}
          </section>
        {/if}
      {:else if ui.settingsPage === 'projects'}
        <p class="lead">Projects split this workspace into separate boards, docs, canvases and meetings, all in the same database. Switch between them under the workspace name. An admin decides who can open each one.</p>
        {#if !scope.canManage}<p class="note">You can open the projects you are in. An admin adds projects and decides who is in them.</p>{/if}
        <section>
          <div class="opt">
            <div class="dbt grow"><span class="h">Use projects here</span><span class="s">A switcher appears under the workspace name. Existing work stays where it is, in no project, until you move it.</span></div>
            <button class="switch" class:on={scope.enabled} role="switch" aria-checked={scope.enabled} aria-label="Use projects" onclick={() => saveProjects(projects, !scope.enabled)}><i></i></button>
          </div>
        </section>
        <section>
          <div class="lab"><b>Projects</b><span>Rename one, change its colour, or remove it. Removing keeps the work and puts it back in no project.</span></div>
          <div class="plist">
            {#each projects as p, i (p.id || i)}
              <div class="pitem">
                <div class="prow">
                  <Select
                    value={p.color}
                    width="128px"
                    disabled={!scope.canManage}
                    options={PROJECT_COLORS.map((c) => ({ value: c, label: c, dot: c }))}
                    onchange={(c) => saveProjects(projects.map((x, k) => (k === i ? { ...x, color: c } : x)))}
                    ariaLabel="Colour"
                  />
                  <input
                    class="field grow"
                    value={p.name}
                    disabled={!scope.canManage}
                    oninput={(e) => (projects[i] = { ...projects[i], name: e.currentTarget.value })}
                    onblur={() => saveProjects(projects)}
                    onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                  />
                  {#if scope.canManage}
                    <button class="ghost" onclick={() => (openAccess = openAccess === p.id ? null : p.id)}>
                      {(p.members ?? []).length} {(p.members ?? []).length === 1 ? 'person' : 'people'}
                    </button>
                    <button class="ghost" onclick={() => saveProjects(projects.filter((_, k) => k !== i))}>Remove</button>
                  {/if}
                </div>
                {#if scope.canManage && openAccess === p.id}
                  <div class="access">
                    <p class="note">Only these people can open {p.name}. Workspace admins are in every project.</p>
                    <div class="people">
                      {#each ui.members as m (m.id)}
                        {@const role = roleIn(p, m.id)}
                        <div class="who">
                          <Face person={m} size={20} />
                          <span class="wname">{m.name}</span>
                          {#if m.role === 'admin'}
                            <span class="s">Workspace admin</span>
                          {:else}
                            <Select
                              value={role ?? ''}
                              width="130px"
                              align="right"
                              options={[
                              { value: '', label: 'Not in it' },
                              { value: 'read', label: 'Read only' },
                              { value: 'write', label: 'Can edit' },
                              { value: 'admin', label: 'Runs it' },
                            ]}
                              onchange={(v) => setRoleIn(i, m.id, (v || null) as ProjectRole | null)}
                              ariaLabel="What {m.name} may do"
                            />
                          {/if}
                        </div>
                      {/each}
                    </div>
                  </div>
                {/if}
              </div>
            {/each}
            {#if scope.canManage}
              <div class="prow">
                <i class="pdot new"></i>
                <input class="field grow" placeholder="New project, e.g. Website" bind:value={newProject} onkeydown={(e) => e.key === 'Enter' && addProject()} />
                <button class="primary" disabled={!newProject.trim()} onclick={addProject}>Add</button>
              </div>
            {/if}
          </div>
          <p class="note">Claude can do this too: "make a project called Website and move these docs into it".</p>
        </section>
      {:else if ui.settingsPage === 'cycles'}
        <p class="lead">The board works in cycles, like sprints: a fixed run of weeks with a backlog beside it. Pick the length and what happens to unfinished cards when one ends.</p>
        <section>
          <div class="lab"><b>Length</b><span>How long each cycle runs. Cycles start on Mondays.</span></div>
          <div class="seg">
            {#each [1, 2, 4] as n}
              <button class:on={cyc.length === n} onclick={() => saveCycles({ length: n as 1 | 2 | 4 })}>{n} week{n > 1 ? 's' : ''}</button>
            {/each}
          </div>
        </section>
        <section>
          <div class="lab"><b>Unfinished cards when a cycle ends</b><span>Done cards always stay in their cycle as history.</span></div>
          <div class="choices">
            {#each [
              { id: 'ask', t: 'Ask me', s: 'Nothing moves until you complete the cycle from the board.' },
              { id: 'next', t: 'Roll over to the next cycle', s: 'Open cards move forward on their own, like Linear.' },
              { id: 'backlog', t: 'Send back to the backlog', s: 'Open cards leave the cycle and wait to be planned again.' },
            ] as o (o.id)}
              <button class="choice" class:on={cyc.rollover === o.id} onclick={() => saveCycles({ rollover: o.id as 'ask' | 'next' | 'backlog' })}>
                <i class="radio"></i><span class="dbt"><span class="h">{o.t}</span><span class="s">{o.s}</span></span>
              </button>
            {/each}
          </div>
          {#if cyc.rollover !== 'ask'}<p class="note">Applies from this cycle on. Earlier weeks are left as they are.</p>{/if}
        </section>
        <section>
          <div class="lab"><b>Upcoming cycles to show</b><span>So cards can be planned ahead. Cycles with cards always show.</span></div>
          <div class="seg">
            {#each [0, 1, 2, 3, 4] as n}
              <button class:on={cyc.upcoming === n} onclick={() => saveCycles({ upcoming: n })}>{n}</button>
            {/each}
          </div>
        </section>
      {:else if ui.settingsPage === 'tabs'}
        <p class="lead">Every workspace starts with the same base. Rename, reorder, hide or add tabs. It all lives in one file, in the workspace's own database, so everyone sees the same tabs.</p>
        <div class="seg">
          <button class:on={!json} onclick={() => (json = false)}>Visual</button>
          <button class:on={json} onclick={() => (json = true)}>JSON</button>
        </div>
        {#if !json}
          <div class="tabs">
            {#each tabs as t, i (t.id)}
              <div class="trow" class:off={t.hidden}>
                <div class="arrows">
                  <button onclick={() => move(i, -1)} aria-label="Up"><ArrowUp size={12} /></button>
                  <button onclick={() => move(i, 1)} aria-label="Down"><ArrowDown size={12} /></button>
                </div>
                <input value={t.name} oninput={(e) => rename(i, e.currentTarget.value)} onblur={() => saveSettings({ tabs: $state.snapshot(tabs) })} />
                <span class="type">{t.type}</span>
                <button class="switch" class:on={!t.hidden} onclick={() => toggle(i)} aria-label="Show tab"><i></i></button>
              </div>
            {/each}
            <div class="addtab">
              <Select
                value={newType}
                width="150px"
                options={[
                  { value: 'board', label: 'Board' },
                  { value: 'docs', label: 'Docs' },
                  { value: 'canvas', label: 'Canvas' },
                  { value: 'meetings', label: 'Meetings' },
                  ...Object.keys(PACK_TABS).map((t) => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) })),
                ]}
                onchange={(v) => (newType = v)}
                ariaLabel="What the tab shows"
              />
              <button class="ghost" onclick={addTab}><Plus size={12} />Add tab</button>
            </div>
          </div>
        {:else}
          <textarea class="json" bind:value={jsonText} spellcheck="false"></textarea>
          {#if jsonErr}<p class="err">{jsonErr}</p>{/if}
          <div><button class="primary" onclick={applyJson}>Save JSON</button></div>
        {/if}
        <p class="note">Your AI can change this too: the Alfredo MCP reads and writes the same settings.</p>
      {:else if ui.settingsPage === 'members'}
        {#if ui.me}
          <div class="me">
            <label class="face">
              <Face person={ui.me} size={56} />
              <span class="cam"><Camera size={11} /></span>
              <input type="file" accept="image/png,image/jpeg,image/webp" onchange={(e) => uploadFace(e, ui.me!.id)} />
            </label>
            <div class="dbt"><span class="h">{ui.me.name}</span><span class="s">Your photo is saved in this workspace's database, so everyone here sees it.</span></div>
          </div>
        {/if}
        {#if scope.canManage}
          <section>
            <div class="lab">
              <b>{invitesAreLinks ? 'Invite someone' : 'Add someone'}</b>
              <span>
                {#if invitesAreLinks}They get a link, open Alfredo, paste it and sign in with this email. What they can reach is decided here, and kept in this workspace's database.
                {:else}A workspace on this Mac has no sign-in, so this just adds a name to assign work to.{/if}
              </span>
            </div>
            <div class="invite">
              <input class="field grow" placeholder="name@company.com" bind:value={inviteEmail} onkeydown={(e) => e.key === 'Enter' && makeInvite()} />
              <Select
                value={inviteRole}
                width="124px"
                options={[
                  { value: 'member', label: 'Member' },
                  { value: 'admin', label: 'Admin', hint: 'runs it' },
                ]}
                onchange={(v) => (inviteRole = v as 'member' | 'admin')}
                ariaLabel="Their role here"
              />
              <button class="primary" onclick={makeInvite}>{invitesAreLinks ? 'Make a link' : 'Add'}</button>
            </div>
            {#if invitesAreLinks && scope.enabled && projects.length}
              <div class="people">
                {#each projects as p (p.id)}
                  <div class="who">
                    <i class="pdot {p.color}"></i>
                    <span class="wname">{p.name}</span>
                    <Select
                      value={inviteProjects[p.id] ?? ''}
                      width="130px"
                      align="right"
                      options={[
                              { value: '', label: 'Not in it' },
                              { value: 'read', label: 'Read only' },
                              { value: 'write', label: 'Can edit' },
                              { value: 'admin', label: 'Runs it' },
                            ]}
                      onchange={(v) => {
                        const next = { ...inviteProjects }
                        if (v) next[p.id] = v as ProjectRole
                        else delete next[p.id]
                        inviteProjects = next
                      }}
                      ariaLabel="What they may do in {p.name}"
                    />
                  </div>
                {/each}
              </div>
            {/if}
            {#if madeLink}
              <div class="linkbox">
                <Link size={13} />
                <span class="mono">{madeLink}</span>
                <button class="ghost" onclick={copyLink}>{linkCopied ? 'Copied' : 'Copy'}</button>
              </div>
              <p class="note">Send it however you like. It works once, for that email, and stops working in two weeks.</p>
            {/if}
          </section>
          {#if invites.filter((i) => !i.usedAt).length}
            <section>
              <div class="lab"><b>Waiting to be accepted</b></div>
              <div class="plist">
                {#each invites.filter((i) => !i.usedAt) as i (i.id)}
                  <div class="prow">
                    <span class="dbt grow"><span class="h">{i.email}</span><span class="s">{i.role === 'admin' ? 'Admin' : 'Member'}{i.projects.length ? ` · ${i.projects.length} project${i.projects.length === 1 ? '' : 's'}` : ''}</span></span>
                    <button class="ghost" onclick={() => revokeInvite(i.id)}>Revoke</button>
                  </div>
                {/each}
              </div>
            </section>
          {/if}
        {/if}
        <div class="people">
          <div class="ph"><span class="grow">Person</span><span class="w110">Role</span></div>
          {#each ui.members as p (p.id)}
            <div class="prow">
              <label class="face sm">
                <Face person={p} size={30} />
                <input type="file" accept="image/png,image/jpeg,image/webp" onchange={(e) => uploadFace(e, p.id)} />
              </label>
              <div class="dbt grow"><span class="h">{p.name}{p.id === ui.me?.id ? ' (you)' : ''}</span><span class="s">{p.email ?? ''}</span></div>
              <div class="w110">
                {#if ws?.kind === 'cloudflare' || !scope.canManage}
                  <span class="role">{#if p.role === 'admin'}<Shield size={11} />{/if}{p.role === 'admin' ? 'Admin' : p.role === 'viewer' ? 'Viewer' : 'Member'}</span>
                {:else}
                  <Select
                    value={p.role}
                    width="110px"
                    align="right"
                    options={[
                      { value: 'admin', label: 'Admin' },
                      { value: 'member', label: 'Member' },
                    ]}
                    onchange={(v) => setRole(p, v)}
                    ariaLabel="What {p.name} may do here"
                  />
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {:else if ui.settingsPage === 'database'}
        <p class="lead">Each workspace keeps its own database. Switching workspaces switches databases.</p>
        <div class="opt on">
          <div class="dbi">{#if ws?.kind === 'local'}<Laptop size={15} />{:else if ws?.kind === 'cloudflare'}<Cloud size={15} />{:else}<Database size={15} />{/if}</div>
          <div class="dbt grow">
            <span class="h">{ws?.name} · {where(ws?.kind)}</span>
            <span class="mono">{status?.detail ?? ''}</span>
          </div>
          {#if status}<span class="ok" class:bad={!status.ok}><i></i>{status.ok ? 'Connected' : 'Not reachable'}</span>{/if}
        </div>
        {#if status?.missing?.length}
          <div class="opt col">
            <div class="lab"><b>Tables missing</b><span>This Supabase project is missing {status.missing.join(', ')}. Run the setup SQL once in its SQL editor (or ask Claude to run setup_supabase_tables with an access token).</span></div>
            <div><button class="ghost" onclick={copySetupSql}>{sqlCopied ? 'Copied' : 'Copy setup SQL'}</button></div>
          </div>
        {/if}
        <div class="lab" style:margin-top="12px"><b>Connect another workspace</b></div>
        <ConnectDatabase onconnected={() => (ui.overlay = null)} />
      {:else if ui.settingsPage === 'connections'}
        <p class="lead">
          Bring your email, calendar and tools into {ui.settings?.name}. Each workspace picks which account it uses, so work and side projects stay apart.
          {#if snap?.checking}<span class="s"> Checking…</span>{/if}
        </p>
        {#if composioOk && !composioOk.loggedIn}
          <p class="err">Composio is not {composioOk.installed ? 'logged in' : 'installed'} on this Mac. Run <span class="mono">composio login</span> in a terminal, then reopen this page.</p>
        {/if}
        {#each [true, false] as google}
          <span class="g2">{google ? 'Google Workspace' : 'More'}</span>
          <div class="apps">
            {#each APPS.filter((a) => a.google === google) as a (a.slug)}
              {@const rows = accountsFor(a.slug)}
              {@const here = chosen(a.slug)}
              <div class="app" class:on={!!here}>
                <span class="al"><img src={a.logo} alt="" loading="lazy" /></span>
                <div class="dbt grow"><span class="h">{a.name}</span><span class="s">{a.blurb}</span></div>
                {#if rows.length}
                  <Select
                    value={here}
                    width="150px"
                    align="right"
                    options={[
                      { value: '', label: 'Not here' },
                      ...rows.map((acc) => ({ value: acc.alias || acc.id, label: accountLabel(acc) })),
                      { value: '__new', label: 'Connect another…' },
                    ]}
                    onchange={(v) => useAccount(a.slug, v)}
                    ariaLabel="Which account {a.name} uses here"
                  />
                {:else}
                  <button class="ghost" onclick={() => link(a.slug)}>Connect</button>
                {/if}
              </div>
            {/each}
          </div>
        {/each}
      {:else if ui.settingsPage === 'models'}
        <div class="opt">
          <div class="dbi"><Cpu size={15} /></div>
          <div class="dbt grow"><span class="h">Parakeet v3</span><span class="s">On-device transcription for Meetings. English and 24 European languages.</span></div>
          {#if engine}<span class="ok" class:bad={!engine.parakeet}><i></i>{engine.parakeet ? 'Installed' : 'Not installed'}</span>{/if}
        </div>
        {#if engine && !engine.parakeet}
          <p class="note">Install it once with <span class="mono">sh scripts/build-parakeet.sh</span> (needs Xcode command line tools, a few minutes), then reopen Alfredo.</p>
        {/if}

        <section>
          <div class="opt col">
            <div class="row">
              <div class="dbi"><BrainIcon size={15} /></div>
              <div class="dbt grow">
                <span class="h">The workspace, read in</span>
                <span class="s">
                  Everything written down here, cut into passages and turned into numbers on this Mac, so ⌘K can answer questions from it. Claude Code writes the answers; nothing is sent anywhere.
                </span>
              </div>
              {#if brain}
                <span class="ok" class:bad={!brain.chunks}><i></i>{brain.chunks ? `${brain.chunks} passages` : 'Not read yet'}</span>
              {/if}
            </div>
            <div class="form">
              <div>
                <button class="primary" disabled={brain?.progress?.state === 'running'} onclick={readWorkspaceIn}>
                  {brain?.progress?.state === 'running' ? `Reading… ${brain.progress.done}/${brain.progress.total}` : brain?.chunks ? 'Read it again' : 'Read the workspace in'}
                </button>
              </div>
              {#if brain?.progress?.state === 'running'}<div class="prog"><i style:width="{brain.progress.total ? (brain.progress.done / brain.progress.total) * 100 : 5}%"></i></div>{/if}
              {#if brain?.progress?.state === 'failed'}<p class="err">{brain.progress.error}</p>{/if}
              <p class="note">
                {brain?.downloaded ? `Model: ${brain.model}, on this Mac.` : `Model: ${brain?.model ?? 'bge-small'}, about 34 MB, downloaded the first time you read a workspace in.`}
                New work is read in as it is saved; this is for everything that came before.
              </p>
            </div>
          </div>
        </section>
      {:else if ui.settingsPage === 'appearance'}
        <div class="seg">
          {#each ['dark', 'light', 'system'] as t}
            <button class:on={theme.mode === t} onclick={() => applyTheme(t as Theme)}>{t[0].toUpperCase() + t.slice(1)}</button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 70;
  }
  .modal {
    width: 960px;
    max-width: calc(100vw - 48px);
    height: 640px;
    max-height: calc(100vh - 48px);
    display: flex;
    background: var(--panel);
    border: 1px solid var(--line-strong);
    border-radius: 12px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
    overflow: hidden;
  }
  nav {
    width: 200px;
    flex-shrink: 0;
    border-right: 1px solid var(--line);
    padding: 18px 10px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .g {
    padding: 0 8px 8px;
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
    font-weight: 500;
  }
  nav .g:not(:first-child) {
    padding-top: 16px;
  }
  nav button {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 28px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--r-md);
    background: none;
    color: var(--ink-2);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    text-align: left;
  }
  nav button:hover {
    background: var(--accent-soft);
  }
  nav button.on {
    background: var(--raised);
    color: var(--ink);
  }
  .body {
    flex: 1;
    min-width: 0;
    padding: 28px 32px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    overflow: auto;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  h2 {
    margin: 0;
    flex: 1;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  .msg {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    color: var(--ink-2);
  }
  .close {
    background: none;
    border: 0;
    color: var(--muted);
    cursor: pointer;
    display: flex;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  section.sep {
    padding-top: 20px;
    border-top: 1px solid var(--line);
  }
  .lab {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .lab b {
    font-size: 13px;
    font-weight: 500;
  }
  .lab span,
  .s,
  .lead,
  .note {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.5;
  }
  .lead {
    font-size: 13px;
    color: var(--ink-2);
    margin: 0;
  }
  .note {
    margin: 0;
  }
  .logo {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .drop {
    flex: 1;
    height: 64px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border: 1px dashed #333;
    border-radius: var(--r-lg);
    color: var(--ink-2);
    font-size: 12px;
    cursor: pointer;
  }
  .drop b {
    color: var(--ink);
  }
  .drop input,
  .face input {
    display: none;
  }
  .field {
    height: 34px;
    padding: 0 10px;
    border-radius: var(--r-md);
    background: var(--bg);
    border: 1px solid var(--line-strong);
    color: var(--ink);
    font: inherit;
    font-size: 13px;
    box-sizing: border-box;
  }
  .mono {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
  }
  .dbrow,
  .opt,
  .app,
  .me {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
  }
  .opt.on,
  .app.on {
    border-color: var(--line-strong);
  }
  .opt.col {
    flex-direction: column;
    align-items: stretch;
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
  .h {
    font-size: 13px;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .h small {
    font-size: 11px;
    font-weight: 400;
    color: var(--ink-2);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--running);
  }
  .dot.bad,
  .ok.bad i {
    background: var(--danger);
  }
  .ok {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    color: var(--ink-2);
    white-space: nowrap;
  }
  .ok i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--running);
  }
  .grow {
    flex: 1;
  }
  .prog {
    height: 4px;
    border-radius: 2px;
    background: var(--line);
    overflow: hidden;
  }
  .prog i {
    display: block;
    height: 100%;
    background: var(--ink);
    transition: width 0.3s ease;
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .plist {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .pitem {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .access {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0 0 4px 108px;
  }
  .who {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 220px;
    font-size: var(--fs-2);
    color: var(--ink-2);
  }
  .wname {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .small {
    height: 28px;
    font-size: var(--fs-2);
  }
  .people {
    display: flex;
    flex-wrap: wrap;
    gap: 10px 20px;
  }
  .prow {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .pcolor {
    width: 96px;
  }
  .pdot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--muted);
  }
  .pdot.new {
    background: none;
    border: 1px dashed var(--line-strong);
  }
  .pdot.blue { background: #6aa6ff; }
  .pdot.green { background: #6fcf97; }
  .pdot.amber { background: #e7b75f; }
  .pdot.rose { background: #f28ba8; }
  .pdot.violet { background: #b38cf0; }
  .pdot.teal { background: #5fd0c5; }
  .pdot.orange { background: #f0955f; }
  .pdot.slate { background: #8d97a8; }
  .ghost {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 12px;
    border-radius: var(--r-md);
    border: 1px solid var(--line-strong);
    background: var(--raised);
    color: var(--ink);
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
  }
  .primary {
    height: 34px;
    padding: 0 14px;
    border-radius: var(--r-md);
    background: var(--ink);
    color: var(--on-accent);
    border: 0;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .primary:disabled {
    opacity: 0.5;
  }
  .link {
    background: none;
    border: 0;
    color: var(--muted);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .sure {
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: flex-end;
  }
  .sure > span {
    font-size: 12px;
    color: var(--muted);
  }
  .sure b {
    color: var(--ink-2);
    font-weight: 600;
  }
  .srow {
    display: flex;
    gap: 6px;
  }
  .srow input {
    width: 190px;
    height: 30px;
    padding: 0 9px;
    border-radius: var(--r-md);
    border: 1px solid var(--line-strong);
    background: var(--bg);
    color: var(--ink);
    font: inherit;
    font-size: 13px;
  }
  .srow .red:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .danger {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }
  .red {
    height: 30px;
    padding: 0 12px;
    border-radius: var(--r-md);
    border: 0;
    background: var(--danger-soft);
    color: var(--danger);
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }
  .seg {
    display: inline-flex;
    align-self: flex-start;
    padding: 2px;
    border-radius: var(--r-md);
    background: var(--bg);
    border: 1px solid var(--line);
  }
  .seg button {
    height: 26px;
    padding: 0 12px;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .seg button.on {
    background: var(--raised);
    color: var(--ink);
  }
  .choices {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .choice {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    border-radius: var(--r-lg);
    border: 1px solid var(--line);
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .choice.on {
    border-color: var(--line-strong);
    background: var(--raised);
  }
  .radio {
    width: 14px;
    height: 14px;
    margin-top: 2px;
    flex-shrink: 0;
    border-radius: 50%;
    border: 1.5px solid #4a4a4a;
    box-sizing: border-box;
  }
  .choice.on .radio {
    border: 4px solid var(--ink);
  }
  .tabs {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .trow {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 42px;
    padding: 0 10px;
    border-radius: var(--r-md);
    border: 1px solid var(--line);
  }
  .trow.off {
    border-style: dashed;
    opacity: 0.6;
  }
  .trow input {
    flex: 1;
    background: none;
    border: 0;
    color: var(--ink);
    font: inherit;
    font-size: 13px;
    outline: none;
  }
  .arrows {
    display: flex;
    flex-direction: column;
  }
  .arrows button {
    background: none;
    border: 0;
    color: var(--muted);
    cursor: pointer;
    padding: 0;
    height: 14px;
    display: flex;
  }
  .type {
    width: 80px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
  }
  .switch {
    width: 28px;
    height: 16px;
    border-radius: 8px;
    border: 0;
    background: #262626;
    padding: 2px;
    display: flex;
    cursor: pointer;
  }
  .switch i {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #7e7e7e;
  }
  .switch.on {
    background: var(--ink);
    justify-content: flex-end;
  }
  .switch.on i {
    background: #0a0a0a;
  }
  .addtab {
    display: flex;
    gap: 8px;
    padding-top: 4px;
  }
  .json {
    min-height: 300px;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.6;
    color: var(--ink-2);
    background: var(--bg);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-lg);
    padding: 12px 14px;
    resize: vertical;
  }
  .err {
    font-size: 12px;
    color: var(--danger);
    margin: 0;
  }
  .face {
    position: relative;
    cursor: pointer;
    display: flex;
  }
  .cam {
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--ink);
    color: var(--on-accent);
    border: 2px solid var(--panel);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .invite {
    display: flex;
    gap: 8px;
  }
  .linkbox {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: var(--r-md);
    background: var(--raised);
  }
  .linkbox .mono {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .people {
    display: flex;
    flex-direction: column;
  }
  .ph {
    display: flex;
    height: 30px;
    align-items: center;
    border-bottom: 1px solid var(--line);
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .prow {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 52px;
    border-bottom: 1px solid var(--line);
  }
  .w110 {
    width: 110px;
  }
  .role {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 26px;
    padding: 0 8px;
    border-radius: 5px;
    background: #1e1e1e;
    border: 0;
    color: var(--ink);
    font: inherit;
    font-size: 12px;
  }
  .g2 {
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
    font-weight: 500;
  }
  .apps {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  .app {
    width: calc(50% - 5px);
    box-sizing: border-box;
    gap: 10px;
  }
  /* The name never wraps because an account name is long. */
  .app .dbt {
    min-width: 0;
  }
  .app .h,
  .app .s {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .al {
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    border-radius: 8px;
    background: #f4f4f4;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .al img {
    width: 20px;
    height: 20px;
    object-fit: contain;
  }
</style>
