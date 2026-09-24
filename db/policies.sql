-- Alfredo: who may see what, in Supabase.
--
-- Applied to a Supabase project on top of db/schema.sql (npm run db:push, or
-- Settings > Database when Alfredo sets a project up for you). Kept apart
-- because it speaks auth.uid(), which only exists where Supabase's auth
-- schema does; a local workspace on this Mac has one person and no sign-in.
create or replace function alfredo_person() returns uuid
  language sql stable security definer set search_path = public as $$
  select id from people where user_id = auth.uid() and active limit 1;
$$;

create or replace function alfredo_member() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from people where user_id = auth.uid() and active);
$$;

create or replace function alfredo_is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from people where user_id = auth.uid() and active limit 1), false);
$$;

/** Whether this workspace is split into projects at all. */
create or replace function alfredo_uses_projects() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((select (value ->> 'enabled')::boolean from workspace_settings where key = 'project_settings'), false);
$$;

/*
 * Whether the signed-in person may see (or change) one item.
 *
 * A project is its own room: people see the projects they are in. Work that
 * is in no project is the room everyone shares, the way the whole workspace
 * was before there were projects: every member sees it, and changes it unless
 * they are a viewer.
 */
create or replace function alfredo_visible(item_kind text, item text, need_write boolean default false) returns boolean
  language sql stable security definer set search_path = public as $$
  select alfredo_member() and (
    alfredo_is_admin()
    or (
      not exists (select 1 from project_items pi where pi.kind = item_kind and pi.item_id = item)
      and (not need_write or coalesce((select role <> 'viewer' from people where user_id = auth.uid() and active limit 1), false))
    )
    or exists (
      select 1
      from project_items pi
      join project_members pm on pm.project_id = pi.project_id and pm.person_id = alfredo_person()
      where pi.kind = item_kind and pi.item_id = item
        and (not need_write or pm.role in ('admin', 'write'))
    )
  );
$$;

do $$
declare
  t text;
  k text;
  kinds text[] := array['card', 'doc', 'canvas', 'meeting'];
  tables text[] := array['cards', 'docs', 'canvases', 'meetings'];
  i int;
begin
  -- The four kinds of work: read what you may see, change what you may change.
  for i in 1 .. array_length(tables, 1) loop
    t := tables[i];
    k := kinds[i];
    execute format('drop policy if exists %I_read on %I', t, t);
    execute format('drop policy if exists %I_write on %I', t, t);
    execute format('create policy %I_read on %I for select using (alfredo_visible(%L, id::text))', t, t, k);
    execute format(
      'create policy %I_write on %I for all using (alfredo_visible(%L, id::text, true)) with check (alfredo_visible(%L, id::text, true))',
      t, t, k, k);
  end loop;

  -- Shared furniture: every member reads it, and may add to what the board needs.
  foreach t in array array['weeks', 'columns', 'people', 'projects', 'project_members', 'project_items', 'workspace_settings', 'pack_data', 'folders'] loop
    execute format('drop policy if exists %I_read on %I', t, t);
    execute format('create policy %I_read on %I for select using (alfredo_member())', t, t);
  end loop;
  foreach t in array array['weeks', 'columns', 'project_items'] loop
    execute format('drop policy if exists %I_write on %I', t, t);
    execute format('create policy %I_write on %I for all using (alfredo_member()) with check (alfredo_member())', t, t);
  end loop;

  -- Running the workspace: admins only.
  foreach t in array array['people', 'projects', 'project_members', 'workspace_settings', 'pack_data', 'invites'] loop
    execute format('drop policy if exists %I_admin on %I', t, t);
    execute format('create policy %I_admin on %I for all using (alfredo_is_admin()) with check (alfredo_is_admin())', t, t);
  end loop;
end $$;

-- What the workspace knows follows the work it was taken from, so a question
-- can never reach across into a project you are not in.
drop policy if exists chunks_read on chunks;
create policy chunks_read on chunks for select using (alfredo_visible(kind, item_id));
drop policy if exists chunks_write on chunks;
create policy chunks_write on chunks for all
  using (alfredo_visible(kind, item_id, true)) with check (alfredo_visible(kind, item_id, true));

-- A meeting's transcript and write-up follow the meeting itself.
drop policy if exists transcripts_read on transcripts;
create policy transcripts_read on transcripts for select using (alfredo_visible('meeting', meeting_id::text));
drop policy if exists transcripts_write on transcripts;
create policy transcripts_write on transcripts for all
  using (alfredo_visible('meeting', meeting_id::text, true)) with check (alfredo_visible('meeting', meeting_id::text, true));
drop policy if exists summaries_read on summaries;
create policy summaries_read on summaries for select using (alfredo_visible('meeting', meeting_id::text));
drop policy if exists summaries_write on summaries;
create policy summaries_write on summaries for all
  using (alfredo_visible('meeting', meeting_id::text, true)) with check (alfredo_visible('meeting', meeting_id::text, true));
drop policy if exists transcript_parts_read on transcript_parts;
create policy transcript_parts_read on transcript_parts for select using (alfredo_visible('meeting', meeting_id::text));
drop policy if exists transcript_parts_write on transcript_parts;
create policy transcript_parts_write on transcript_parts for all
  using (alfredo_visible('meeting', meeting_id::text, true)) with check (alfredo_visible('meeting', meeting_id::text, true));

-- Your own row: you may set your name, photo and the sign-in behind it.
drop policy if exists people_self on people;
create policy people_self on people for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Your own model key, and nobody else's.
drop policy if exists user_keys_self on user_keys;
create policy user_keys_self on user_keys for all using (user_id = auth.uid()) with check (user_id = auth.uid());

/*
 * Joining a workspace from an invite link.
 *
 * The person who is joining holds no key but the publishable one, so nothing
 * here can go through the tables directly: this runs as the definer, checks
 * the invitation against the email in their sign-in, and writes the person
 * row and the memberships itself. The app sends the hash, never the token.
 */
create or replace function alfredo_join(token_hash text, display_name text default null) returns json
  language plpgsql security definer set search_path = public as $$
declare
  inv        invites%rowtype;
  mail       text := lower(coalesce(auth.jwt() ->> 'email', ''));
  person     people%rowtype;
  wanted     jsonb;
  use_name   text;
begin
  if auth.uid() is null then
    raise exception 'Sign in before joining.';
  end if;
  select * into inv from invites where invites.token_hash = alfredo_join.token_hash;
  if inv.id is null or inv.used_at is not null or inv.expires_at < now() then
    raise exception 'This invitation is no longer good. Ask for a new one.';
  end if;
  if lower(inv.email) <> mail then
    raise exception 'This invitation was sent to a different email.';
  end if;

  use_name := coalesce(nullif(trim(coalesce(display_name, '')), ''), split_part(mail, '@', 1));
  select * into person from people where lower(email) = mail limit 1;
  if person.id is null then
    insert into people (name, email, role, user_id, position)
    values (use_name, mail, inv.role, auth.uid(), extract(epoch from now()) / 1e12)
    returning * into person;
  else
    update people set user_id = auth.uid(), role = inv.role, active = true where id = person.id returning * into person;
  end if;

  for wanted in select * from jsonb_array_elements(inv.projects) loop
    if exists (select 1 from projects p where p.id = (wanted ->> 'id')::uuid) then
      insert into project_members (project_id, person_id, role)
      values ((wanted ->> 'id')::uuid, person.id, coalesce(nullif(wanted ->> 'role', ''), 'write'))
      on conflict (project_id, person_id) do update set role = excluded.role;
    end if;
  end loop;

  update invites set used_at = now() where id = inv.id;
  return json_build_object('id', person.id, 'name', person.name, 'email', person.email, 'role', person.role);
end $$;

revoke all on function alfredo_join(text, text) from public;
grant execute on function alfredo_join(text, text) to authenticated;
