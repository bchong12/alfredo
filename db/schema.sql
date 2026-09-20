-- Alfredo schema (Supabase / Postgres)
-- Meetings -> transcript -> summary -> cards, plus docs and roadmap.
-- Everything is single-tenant (you), so RLS is permissive-for-service-role only.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- meetings

create table if not exists meetings (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  duration_s    integer,
  -- local path while recording; storage key once uploaded
  audio_path    text,
  audio_key     text,
  participants  text[] default '{}',
  -- What you typed DURING the meeting. Not a draft of the summary: it is the
  -- outline the summariser expands against, which is the whole point.
  raw_notes     text,
  -- Last time the tab doing the recording said it was still there. A meeting
  -- sitting in 'recording' with a stale heartbeat was interrupted, not live,
  -- and that is the difference between "still going" and "recoverable".
  last_seen_at  timestamptz,
  source        text not null default 'recorded'
                check (source in ('recorded','imported','pasted')),
  status        text not null default 'recording'
                check (status in ('recording','recorded','transcribing','transcribed','summarized','failed')),
  error         text,
  created_at    timestamptz not null default now()
);

create table if not exists transcripts (
  meeting_id  uuid primary key references meetings(id) on delete cascade,
  -- full plain text, used for search and for feeding the summarizer
  text        text not null,
  -- [{speaker, start, end, text}] when the engine gives us diarization
  segments    jsonb,
  engine      text,
  created_at  timestamptz not null default now()
);

-- One row per uploaded audio segment, transcribed WHILE the meeting is still
-- running rather than all at once at the end.
--
-- This exists because of a hosting limit with teeth: an Edge Function may stay
-- alive for 150 seconds, and transcribing a whole meeting in one pass spends
-- that budget in proportion to the meeting's length. A 27-minute meeting took
-- 48s, so somewhere north of an hour the work would simply be killed, and the
-- person would find out only afterwards. Per-segment, each pass is bounded by
-- the segment length no matter how long the meeting runs.
create table if not exists transcript_parts (
  meeting_id  uuid not null references meetings(id) on delete cascade,
  idx         integer not null,
  audio_key   text not null,
  text        text,
  engine      text,
  error       text,
  -- What this segment cost to transcribe, in US dollars, as billed.
  cost_usd    numeric(10, 6) not null default 0,
  created_at  timestamptz not null default now(),
  primary key (meeting_id, idx)
);

create table if not exists summaries (
  meeting_id  uuid primary key references meetings(id) on delete cascade,
  tldr        text not null,
  -- The body of the note. Headings are chosen per meeting rather than fixed,
  -- so this is [{heading, bullets[]}] rather than a flat list.
  sections    jsonb not null default '[]'::jsonb,
  -- [{what, why, quote}] — the quote is what the claim was checked against.
  decisions   jsonb not null default '[]'::jsonb,
  open_questions jsonb not null default '[]'::jsonb,
  -- {quality, note}: how much of the meeting the audio actually carried.
  coverage    jsonb not null default '{}'::jsonb,
  -- extracted but not yet promoted to cards; [{title, detail, assignee, due}]
  action_items jsonb default '[]'::jsonb,
  -- How many claims were dropped because their quote was not in the transcript.
  unverified  integer not null default 0,
  model       text,
  -- Which of your own note lines the transcript actually supported.
  anchored    jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------- folders

-- Somewhere to file meetings, and the unit of sharing alongside the meeting
-- itself. Owned by an auth user rather than a `people` row: people exist so
-- work can be assigned to someone with no login, which is the opposite of what
-- an access decision needs.
create table if not exists folders (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  owner_id   uuid not null,
  -- false means only the owner sees it. Sharing is opt-in in both directions:
  -- a recording is nobody else's business until the person who made it says so.
  shared     boolean not null default false,
  position   double precision not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists folders_owner_idx on folders(owner_id);

-- --------------------------------------------------------- API keys

-- Each person pays for their own model calls. Held per auth user rather than
-- one shared key in the environment, so nobody spends someone else's credit
-- without knowing it.
--
-- Stored in the clear, which is the same trust boundary the environment
-- variable had: only the service role can read this table, and the service
-- role is the server. It is never returned to a browser -- `hint` is what the
-- UI displays, and it is the masked label the provider itself gives back.
create table if not exists user_keys (
  user_id    uuid primary key,
  key        text not null,
  hint       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- people

-- Who work can be assigned to. Deliberately separate from auth users: you can
-- assign a card to someone who has no login.
create table if not exists people (
  id         uuid primary key default gen_random_uuid(),
  name       text unique not null,
  email      text,
  avatar_url text,
  position   double precision not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- weeks

-- The board is scoped to a week. Weeks are numbered from the start of the
-- project rather than by ISO week, because "week 2" is how the work is
-- actually talked about.
create table if not exists weeks (
  id         uuid primary key default gen_random_uuid(),
  number     integer unique not null,
  starts_on  date unique not null,
  label      text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- kanban

create table if not exists columns (
  id        uuid primary key default gen_random_uuid(),
  name      text not null,
  position  double precision not null,
  created_at timestamptz not null default now()
);

create sequence if not exists card_number_seq;

create table if not exists cards (
  id          uuid primary key default gen_random_uuid(),
  -- Linear-style reference. The PUR prefix is a constant in src/lib/ref.ts,
  -- not stored: storing it would mean migrating every row to rename it.
  number      integer unique not null default nextval('card_number_seq'),
  column_id   uuid not null references columns(id) on delete cascade,
  title       text not null,
  body        text,
  -- fractional index so a move only rewrites one row
  position    double precision not null,
  labels      text[] default '{}',
  assignee_id uuid references people(id) on delete set null,
  -- Two audiences, deliberately separate. `notes` is what a person needs to
  -- pick this up: decisions, links, what was tried. `agent_context` is written
  -- for Claude: the paths, constraints and definition of done it should read
  -- before touching anything. Mixing them makes both worse.
  notes         text,
  agent_context text,
  -- A deadline is a calendar day, not an instant. timestamptz here renders
  -- as the previous day for anyone west of UTC.
  due_on      date,
  -- provenance: which meeting produced this card, if any
  meeting_id  uuid references meetings(id) on delete set null,
  -- null means the backlog: real work that is not in any week yet
  week_id     uuid references weeks(id) on delete set null,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists cards_column_pos_idx on cards(week_id, column_id, position)
  where archived_at is null;
create index if not exists cards_meeting_idx on cards(meeting_id);

-- ---------------------------------------------------------------- docs

create table if not exists docs (
  id         uuid primary key default gen_random_uuid(),
  slug       text unique not null,
  title      text not null,
  body       text not null default '',
  tags       text[] default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- full-text search over docs, kept current by trigger
alter table docs add column if not exists fts tsvector
  generated always as (to_tsvector('english', title || ' ' || body)) stored;
create index if not exists docs_fts_idx on docs using gin(fts);

-- ---------------------------------------------------------------- roadmap

create table if not exists roadmap_items (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  detail     text,
  -- coarse time bucket rather than hard dates; roadmaps lie about dates
  horizon    text not null default 'next'
             check (horizon in ('now','next','later','shipped')),
  status     text not null default 'idea'
             check (status in ('idea','committed','building','shipped','dropped')),
  position   double precision not null default 0,
  shipped_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- a roadmap item is delivered by many cards
create table if not exists roadmap_cards (
  roadmap_id uuid references roadmap_items(id) on delete cascade,
  card_id    uuid references cards(id) on delete cascade,
  primary key (roadmap_id, card_id)
);

-- ---------------------------------------------------------------- housekeeping

create or replace function touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

do $$
declare t text;
begin
  foreach t in array array['cards','docs','roadmap_items'] loop
    execute format(
      'drop trigger if exists %I_touch on %I; '
      'create trigger %I_touch before update on %I '
      'for each row execute function touch_updated_at()', t, t, t, t);
  end loop;
end $$;

-- Columns added after the tables were first created. `create table if not
-- exists` is a no-op on an existing database, so anything added later has to
-- say so here or the file stops describing the database it built. It had
-- already drifted once: summaries grew five columns that lived only in ad-hoc
-- SQL, and a fresh push would have produced a schema the code could not use.
alter table meetings  add column if not exists raw_notes text;
alter table meetings  add column if not exists last_seen_at timestamptz;
-- Every model call this meeting paid for: each segment's transcription plus
-- the extraction pass. Recorded from what the provider billed, not estimated.
alter table meetings  add column if not exists cost_usd numeric(10, 6) not null default 0;
alter table transcript_parts add column if not exists cost_usd numeric(10, 6) not null default 0;

-- Who recorded a meeting, and who may see it. A meeting is visible to someone
-- other than its owner only when it is shared AND, if it is filed, its folder
-- is shared too: the more restrictive of the two wins, so moving a meeting into
-- a private folder can never widen who can read it.
alter table meetings add column if not exists owner_id uuid;
alter table meetings add column if not exists shared boolean not null default false;
alter table meetings add column if not exists folder_id uuid references folders(id) on delete set null;
create index if not exists meetings_owner_idx on meetings(owner_id);
create index if not exists meetings_folder_idx on meetings(folder_id);
alter table summaries add column if not exists sections jsonb not null default '[]'::jsonb;
alter table summaries add column if not exists open_questions jsonb not null default '[]'::jsonb;
alter table summaries add column if not exists coverage jsonb not null default '{}'::jsonb;
alter table summaries add column if not exists unverified integer not null default 0;
alter table summaries add column if not exists anchored jsonb not null default '[]'::jsonb;

-- seed the board once
insert into columns (name, position)
select * from (values ('Backlog',1.0),('In Progress',2.0),('In Review',3.0),('Done',4.0)) v
where not exists (select 1 from columns);

-- Boards made before there was a review lane get one, between progress and
-- done. The old agent lane folds into Backlog: sessions are tracked on the
-- card itself now, not by which column it sits in.
insert into columns (name, position)
select 'In Review', (select position from columns where name = 'Done') - 0.5
where not exists (select 1 from columns where name = 'In Review')
  and exists (select 1 from columns where name = 'Done');
update cards set column_id = (select id from columns where name = 'Backlog')
where column_id in (select id from columns where name = 'Agent')
  and exists (select 1 from columns where name = 'Backlog');
delete from columns where name = 'Agent';

-- Seed twelve weeks anchored so that today falls in week 2. Weeks run Monday
-- to Sunday; date_trunc gives the Monday of the current week.
insert into weeks (number, starts_on)
select n, (date_trunc('week', current_date)::date - interval '7 days' * (2 - n))::date
from generate_series(1, 12) n
where not exists (select 1 from weeks);

-- Where a card came from, when something outside made it: canvas:assignment:123.
-- Syncing again finds the card by this instead of making a second one.
alter table cards add column if not exists external_ref text;
create index if not exists cards_external_ref on cards (external_ref) where external_ref is not null;

-- ---------------------------------------------------------------------------
-- Alfredo v2: the four base tabs and per-workspace settings.
--
-- Canvases are whiteboards: React Flow / Svelte Flow JSON (nodes, edges),
-- saved whole with a revision so two people cannot silently overwrite each
-- other. workspace_settings is one row per key; `tabs` and `brand` are the
-- ones the app reads. Settings live here, in the database, so everyone who
-- connects to the workspace sees the same tabs, name and logo.
-- ---------------------------------------------------------------------------
create table if not exists canvases (
  id         uuid primary key default gen_random_uuid(),
  title      text not null default 'Untitled canvas',
  content    jsonb not null default '{"nodes":[],"edges":[]}'::jsonb,
  revision   integer not null default 1,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists workspace_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table people add column if not exists role text not null default 'member';

-- Content for tabs that are not one of the four base types (a marketing
-- library, say). One JSON document per key, read by whichever app shows it,
-- so the content lives in the workspace's database and not in anyone's code.
create table if not exists pack_data (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Projects: an optional split of one workspace into separate boards, docs,
-- canvases and meetings. Who is in a project, and what they may do there, is
-- the point of the split, so both are tables rather than settings JSON.
create table if not exists projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  color       text not null default 'slate',
  position    double precision not null default 0,
  archived_at timestamptz,
  created_at  timestamptz not null default now()
);

-- A person's place in a project. Workspace admins are in every project
-- without a row here; everyone else needs one.
create table if not exists project_members (
  project_id uuid not null references projects(id) on delete cascade,
  person_id  uuid not null references people(id) on delete cascade,
  role       text not null default 'write' check (role in ('admin','write','read')),
  created_at timestamptz not null default now(),
  primary key (project_id, person_id)
);
create index if not exists project_members_person on project_members (person_id);

-- Which project each item belongs to. The items themselves never change shape.
create table if not exists project_items (
  kind       text not null check (kind in ('card','doc','canvas','meeting')),
  item_id    text not null,
  project_id uuid not null references projects(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (kind, item_id)
);
create index if not exists project_items_project on project_items (project_id);

-- project_items arrived before projects had a table of their own, so an early
-- install has its project_id as text. The ids were always uuids.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'project_items' and column_name = 'project_id' and data_type <> 'uuid'
  ) then
    delete from project_items where project_id !~ '^[0-9a-f-]{36}$';
    alter table project_items alter column project_id type uuid using project_id::uuid;
  end if;
  if not exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public' and table_name = 'project_items' and constraint_type = 'FOREIGN KEY'
  ) then
    delete from project_items pi where not exists (select 1 from projects p where p.id = pi.project_id);
    alter table project_items add constraint project_items_project_fk foreign key (project_id) references projects(id) on delete cascade;
  end if;
end $$;

-- Joining a workspace: an admin makes an invite, the link carries the token,
-- and accepting it creates the account and the memberships in one go. Only
-- the hash is kept, so a leaked database does not hand out invitations.
create table if not exists invites (
  id         uuid primary key default gen_random_uuid(),
  token_hash text unique not null,
  email      text not null,
  role       text not null default 'member' check (role in ('admin','member')),
  projects   jsonb not null default '[]'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  used_at    timestamptz
);
create index if not exists invites_email on invites (lower(email));

-- The sign-in behind a person, so the database can tell who is asking.
alter table people add column if not exists user_id uuid;
create index if not exists people_user on people (user_id);

-- ---------------------------------------------------------------------------
-- What the workspace knows, in a form a question can reach.
--
-- One row per chunk of a doc, meeting, card or canvas: the words, who they
-- belong to, and a vector of them. Asking a question is a vector search and a
-- word search over this table, fused. It is a copy of the writing, so it can
-- be thrown away and rebuilt at any time, and it follows the same access
-- rules as the work it came from (see db/policies.sql).
-- ---------------------------------------------------------------------------
create extension if not exists vector;

create table if not exists chunks (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('card','doc','canvas','meeting')),
  item_id    text not null,
  ord        integer not null default 0,
  title      text not null default '',
  heading    text not null default '',
  text       text not null,
  embedding  vector(384),
  updated_at timestamptz not null default now(),
  unique (kind, item_id, ord)
);
create index if not exists chunks_item on chunks (kind, item_id);

-- The word half of the search, so an exact term still lands.
alter table chunks add column if not exists fts tsvector
  generated always as (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(heading,'') || ' ' || text)) stored;
create index if not exists chunks_fts on chunks using gin (fts);

-- The meaning half. Cosine, because the vectors come out normalised.
do $$
begin
  if not exists (select 1 from pg_class where relname = 'chunks_embedding_idx') then
    begin
      execute 'create index chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops)';
    exception when others then
      -- Older pgvector has no HNSW; a list index is still far better than none.
      begin
        execute 'create index chunks_embedding_idx on chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100)';
      exception when others then
        null;
      end;
    end;
  end if;
end $$;

/*
 * Asking the workspace something.
 *
 * Two searches and one list. The vector half finds what a question means;
 * the word half finds the exact term the vectors shrug at (a name, "PUR-42",
 * a price). Reciprocal rank fusion puts them together: each half votes with
 * 1/(60 + its rank), which needs no tuning and no comparable scores.
 *
 * Runs as the caller, so the policies on chunks decide what can be found.
 */
create or replace function alfredo_search(q_embedding vector(384), q_text text default '', k integer default 12)
returns table (kind text, item_id text, ord integer, title text, heading text, text text, score double precision)
language sql stable as $$
  with dense as (
    select c.kind, c.item_id, c.ord, c.title, c.heading, c.text,
           row_number() over (order by c.embedding <=> q_embedding) as rank
    from chunks c
    where q_embedding is not null and c.embedding is not null
    order by c.embedding <=> q_embedding
    limit greatest(k * 4, 40)
  ),
  words as (
    select c.kind, c.item_id, c.ord, c.title, c.heading, c.text,
           row_number() over (order by ts_rank(c.fts, websearch_to_tsquery('english', q_text)) desc) as rank
    from chunks c
    where coalesce(q_text, '') <> '' and c.fts @@ websearch_to_tsquery('english', q_text)
    order by ts_rank(c.fts, websearch_to_tsquery('english', q_text)) desc
    limit greatest(k * 4, 40)
  )
  select coalesce(d.kind, w.kind)         as kind,
         coalesce(d.item_id, w.item_id)   as item_id,
         coalesce(d.ord, w.ord)           as ord,
         coalesce(d.title, w.title)       as title,
         coalesce(d.heading, w.heading)   as heading,
         coalesce(d.text, w.text)         as text,
         coalesce(1.0 / (60 + d.rank), 0) + coalesce(1.0 / (60 + w.rank), 0) as score
  from dense d
  full outer join words w on w.kind = d.kind and w.item_id = d.item_id and w.ord = d.ord
  order by score desc
  limit k;
$$;

-- Row-level security on, no policies. Every server talks to the database with
-- the service key (which bypasses RLS); the publishable key in the browser is
-- only for signing in. With RLS off, that public key could read and write
-- every table through the REST API, user_keys included.
do $$
declare t text;
begin
  foreach t in array array['meetings','transcripts','transcript_parts','summaries','folders','user_keys',
    'people','weeks','columns','cards','docs','roadmap_items','roadmap_cards','canvases','workspace_settings','pack_data','projects','project_members','project_items','invites','chunks'] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;
