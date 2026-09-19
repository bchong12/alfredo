# Alfredo

Your company's brain, in a database you own. Alfredo is a Mac app with four
tabs, **Board, Docs, Canvas and Meetings**, and an MCP server so Claude can
read and write all of it.

Each workspace keeps its data in one database of your choice:

| Where | Good for | Setup |
| --- | --- | --- |
| This Mac | Personal, offline | None. A folder under `~/.alfredo/workspaces` |
| Supabase | A team | Paste a personal access token; Alfredo creates the tables |
| Cloudflare D1 | A team, on your own account | One click with your `wrangler` login |

Nothing is hosted by us. Keys and tokens live in the macOS keychain.

## What's in it

- **Board**: kanban cards in cycles (1, 2 or 4 weeks, like sprints), a backlog,
  and a choice of what happens to unfinished work when a cycle ends.
- **Docs**: a writing home with real page thumbnails.
- **Canvas**: a whiteboard with frames, stickies, shapes and arrows (Svelte
  Flow, React Flow JSON compatible).
- **Meetings**: record, transcribe on this Mac with Parakeet, and get notes
  written by Claude Code. Only the transcript is kept; the audio is deleted.
- **Tabs you choose**: every workspace has a tabs JSON in its own database.
  Rename, hide or add tabs; teams can add their own tab types as packs.

## Run it

Needs macOS and Node 22 or newer.

```sh
npm install
npm run dev          # http://localhost:5210
```

Or build and install the Mac app:

```sh
npm run desktop:install
```

The first screen asks where your first workspace should live.

Optional extras:

- **Claude Code** (`claude` on your PATH) writes the meeting notes. Without it,
  set `OPENROUTER_API_KEY` in `.env.local` (see `.env.local.example`).
- **Parakeet** transcribes meetings on your Mac. Meetings offers to download it
  the first time (needs Xcode command line tools; about 600 MB).
- **Composio** (`composio login`) connects Gmail, Google Calendar and the rest
  of Google Workspace in Settings, Connections.
- **Wrangler** (`npx wrangler login`) lets Alfredo create Cloudflare workspaces.

## Connect Claude (MCP)

With Alfredo running:

```sh
claude mcp add --transport http alfredo http://127.0.0.1:29981/mcp
```

Add `--header "x-workspace: <id>"` to pin a workspace; otherwise calls go to
the active one. Tools:

| Tool | Does |
| --- | --- |
| `list_workspaces` | Every workspace and where it lives |
| `ws_list`, `ws_read`, `ws_write` | Cards, docs, canvases, meetings, members |
| `get_workspace`, `set_workspace_tabs` | The workspace's name and tabs JSON |
| `list_pack_data`, `get_pack_data`, `set_pack_data` | Data for custom tab types |
| `list_supabase_projects`, `connect_supabase` | Add a Supabase workspace |
| `get_setup_sql`, `setup_supabase_tables` | Create or upgrade its tables |
| `connect_cloudflare`, `create_cloudflare_workspace`, `get_cloudflare_deploy` | Add a Cloudflare workspace |

So you can say "connect my Supabase project to a new workspace called Acme"
and Claude does the rest.

## How the data is shaped

- Supabase: `db/schema.sql` (idempotent; RLS on, the app uses the service key
  from this Mac only). The first account in a new project becomes its admin;
  after that, people need an invite.
- Cloudflare: `cloudflare/worker.mjs` and `cloudflare/schema.sql`. The Worker
  is the only door to D1 and checks a random token kept in your keychain.
- This Mac: the same schema in PGlite (Postgres in WebAssembly).

### Tabs JSON

```json
[
  { "id": "board", "type": "board", "name": "Board", "columns": ["Todo", "In progress", "Review", "Done"] },
  { "id": "docs", "type": "docs", "name": "Docs" },
  { "id": "canvas", "type": "canvas", "name": "Canvas" },
  { "id": "meetings", "type": "meetings", "name": "Meetings", "hidden": true }
]
```

Any other `type` is a pack: a folder in `src/v2/packs/<name>/` whose
`index.ts` exports `tabs`, keyed by type. Its data goes in the workspace's
database through the pack data tools, never in the code.

## Security

The server binds to 127.0.0.1 and holds database keys, so it never listens
on the network. The MCP endpoint refuses browser origins and foreign hosts.

## License

MIT
