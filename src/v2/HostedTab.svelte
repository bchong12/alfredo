<script lang="ts">
  // A tab this copy of Alfredo does not carry, shown from the site that does.
  import ExternalLink from '@lucide/svelte/icons/external-link'
  import Header from './Header.svelte'
  import Skeleton from './Skeleton.svelte'
  import { auth } from '../lib/session.svelte'
  import type { HostedTab } from './hosted.svelte'

  let { tabId, tabName, at, view }: { tabId: string; tabName: string; at: HostedTab; view: string } = $props()

  // The address is set once; after that the page is told which view to show,
  // so moving between them does not load the site again.
  const first = view
  const src = `${at.site}/?embed=${encodeURIComponent(tabId)}${first ? `&view=${encodeURIComponent(first)}` : ''}`
  const host = new URL(at.site).host

  let frame = $state<HTMLIFrameElement | null>(null)
  let seen = $state<'waiting' | 'there' | 'ready' | 'silent'>('waiting')
  const label = $derived(at.views.find((v) => v.id === view)?.label ?? '')

  const send = (m: Record<string, unknown>) => frame?.contentWindow?.postMessage(m, at.site)
  function handSession() {
    const s = auth.session
    if (!s) return
    const u = s.user
    send({ type: 'alfredo:session', access_token: s.access_token, expires_at: s.expires_at, user: { id: u.id, email: u.email, user_metadata: { name: u.user_metadata?.name } } })
  }

  function heard(e: MessageEvent) {
    if (e.origin !== at.site || e.source !== frame?.contentWindow || e.data?.type !== 'alfredo:embed') return
    if (e.data.state === 'hello') {
      seen = 'there'
      handSession()
      if (view) send({ type: 'alfredo:view', view })
    } else if (e.data.state === 'ready') seen = 'ready'
    else if (e.data.state === 'expired') handSession()
  }

  // A renewed session goes across as soon as this app has it.
  $effect(() => {
    void auth.session?.access_token
    if (seen !== 'waiting') handSession()
  })
  $effect(() => {
    const v = view
    if (seen !== 'waiting' && v) send({ type: 'alfredo:view', view: v })
  })
  // A site that never answers is said so, rather than left as a grey page.
  $effect(() => {
    const t = setTimeout(() => seen === 'waiting' && (seen = 'silent'), 12_000)
    return () => clearTimeout(t)
  })
</script>

<svelte:window onmessage={heard} />

<div class="page">
  {#if seen !== 'ready'}
    <div class="cover">
      <Header crumbs={label ? [tabName, label] : [tabName]} />
      {#if seen === 'silent'}
        <div class="quiet">
          <b>{tabName} did not load</b>
          <span>It is served from {host}, which has not answered. Check the connection, or open it in the browser.</span>
          <a class="btn" href={at.site} target="_blank" rel="noopener"><ExternalLink size={12} /><span>Open {host}</span></a>
        </div>
      {:else}
        <div class="sk">
          <Skeleton w={220} h={18} />
          <Skeleton w="60%" />
          {#each [0, 1, 2, 3, 4, 5] as i (i)}<Skeleton h={44} r={8} />{/each}
        </div>
      {/if}
    </div>
  {/if}
  <iframe bind:this={frame} {src} title={tabName} class:shown={seen === 'ready'} allow="clipboard-write"></iframe>
</div>

<style>
  .page {
    position: relative;
    height: 100%;
    min-width: 0;
  }
  iframe {
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
    background: var(--bg);
    opacity: 0;
  }
  iframe.shown {
    opacity: 1;
    transition: opacity 140ms;
  }
  .cover {
    position: absolute;
    inset: 0;
    z-index: 1;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }
  .sk {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 24px 28px;
  }
  .quiet {
    margin: auto;
    max-width: 380px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    text-align: center;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.5;
  }
  .quiet b {
    color: var(--ink);
    font-size: 15px;
    font-weight: 600;
  }
  .btn {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    margin-top: 6px;
    padding: 0 10px;
    border-radius: var(--r-md);
    border: 1px solid var(--line-strong);
    color: var(--ink-2);
    font-size: 12px;
    text-decoration: none;
  }
  .btn:hover {
    color: var(--ink);
    background: var(--accent-soft);
  }
</style>
