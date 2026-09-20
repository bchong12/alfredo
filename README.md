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
- **Ask it things**: ⌘K takes a question as well as a name. Everything written
  down in the workspace is searched, and Claude Code answers from the passages
  it found, saying which doc or meeting each claim came from. Nothing leaves
  the Mac.
- **Tabs you choose**: every workspace has a tabs JSON in its own database.
  Rename, hide or add tabs; teams can add their own tab types as packs.
- **Projects** (optional): split one workspace into separate boards, docs,
  canvases and meetings, in the same database. You switch between the projects
  you are in, under the workspace name.
- **People**: whoever connects the database and makes the first account runs
  the workspace. They invite the rest with a link, put each person in the
  projects they need, and give each a role there: runs it, can edit, or read
  only. Admin can be handed to someone else. All of it lives in the workspace's
  database, so it travels with the workspace rather than with a Mac.

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
| `ask_workspace`, `search_workspace` | Answer from the workspace's own writing, with citations |
| `read_workspace_in`, `brain_status` | Read everything in, and see how it went |
| `list_projects`, `create_project`, `set_project_people`, `move_to_project`, `set_projects_enabled` | Projects, and who is in them |
| `invite_person` | An invite link to send someone |
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

### Asking the workspace

Every doc, meeting, card and canvas is cut into passages and embedded on this
Mac with `bge-small-en-v1.5` (int8, 384 dimensions, about 34 MB, downloaded on
first use). Searching runs both halves and fuses them by reciprocal rank:
vectors for what a question means, words for the exact term vectors miss. The
answer is written by Claude Code from those passages only, and there is no
hosted fallback, because a company's own writing should not leave the machine.

Retrieval quality comes from the chunking rather than the model: pieces follow
the writing's own headings, overlap a little, and carry the title and heading
path so a passage still says what it is about.

- **Supabase**: a `chunks` table with pgvector and Postgres full-text, under
  the same row-level security as the work itself.
- **Cloudflare**: vectors stored in D1, scored by the Worker, which only ever
  looks at what the caller may open.
- **This Mac**: the same, through PGlite with pgvector.

New work is read in as it is saved. Everything from before is read in once
from Settings, Models (or `read_workspace_in` over MCP).

### Projects and who may open them

Off until a workspace turns them on. Projects, their people and the
invitations are tables next to the work (`projects`, `project_members`,
`project_items`, `invites`), so nothing about the items themselves changes.
Work in no project waits for an admin to file it.

The rules are kept by the database, not by the app:

- **Supabase**: `db/policies.sql` is row-level security over those tables. An
  invited teammate's Alfredo holds no secret key at all; it connects with the
  publishable key and their own sign-in, so the project list they see is
  Postgres's answer. Applied by `npm run db:push`, or by Alfredo when it sets
  a project up for you.
- **Cloudflare**: the Worker keeps people, sessions, invitations and
  memberships in D1 and answers every request accordingly. Its own token still
  belongs to whoever created the workspace.
- **This Mac**: one person, no sign-in, so there is nothing to enforce.

An invite link carries where the workspace is and nothing secret. Paste it
into Alfredo (Add workspace, "I have an invite"), sign in with that email, and
you land in the projects the invitation names.

### Sign in with Google

Available on Supabase workspaces whose project has the Google provider turned
on. Google will not sign anyone in inside an app window, so Alfredo opens the
system browser and catches the answer on `http://127.0.0.1:29981/auth/callback`
-- add that to the project's redirect URLs.

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

The server binds to 127.0.0.1 and can hold database keys, so it never listens
on the network. The MCP endpoint refuses browser origins and foreign hosts.

Who may see what is decided by the database (row-level security on Supabase,
the Worker on Cloudflare), so the app is not what stands between a teammate
and someone else's project. The secret key stays with whoever set the
workspace up; everyone else holds a session of their own.

## License

MIT
