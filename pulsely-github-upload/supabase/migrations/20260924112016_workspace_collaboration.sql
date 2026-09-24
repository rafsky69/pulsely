-- Workspaces keep the existing owner user_id and Paddle subscription model.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create table public.workspace_settings (
  owner_user_id uuid primary key references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  updated_at timestamptz not null default now()
);
create table public.workspace_activity (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  subject text not null,
  created_at timestamptz not null default now()
);
create index workspace_activity_owner_date_idx on public.workspace_activity(owner_user_id, created_at desc);
create index if not exists team_members_member_idx on public.team_members(member_user_id, owner_user_id);
create index if not exists team_invites_owner_status_idx on public.team_invites(owner_user_id, status, expires_at);

create or replace function private.workspace_role(target_owner uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case when auth.uid() is null then null
    when auth.uid() = target_owner then 'owner'
    else (select role from public.team_members where owner_user_id = target_owner and member_user_id = auth.uid()) end;
$$;
revoke all on function private.workspace_role(uuid) from public;
grant execute on function private.workspace_role(uuid) to authenticated;

create or replace function public.can_read_owner(target_owner uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select private.workspace_role(target_owner) is not null;
$$;
create or replace function public.can_write_owner(target_owner uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select coalesce(private.workspace_role(target_owner) in ('owner', 'admin', 'editor'), false);
$$;
revoke all on function public.can_read_owner(uuid), public.can_write_owner(uuid) from public, anon;
grant execute on function public.can_read_owner(uuid), public.can_write_owner(uuid) to authenticated, service_role;
grant usage on schema private to service_role;
grant execute on function private.workspace_role(uuid) to service_role;

alter table public.workspace_settings enable row level security;
alter table public.workspace_activity enable row level security;
revoke all on public.workspace_settings, public.workspace_activity from anon, authenticated;
grant select on public.workspace_settings, public.workspace_activity to authenticated;
grant all on public.workspace_settings, public.workspace_activity to service_role;
create policy "Workspace settings visible to members" on public.workspace_settings for select to authenticated using (public.can_read_owner(owner_user_id));
create policy "Workspace activity visible to members" on public.workspace_activity for select to authenticated using (public.can_read_owner(owner_user_id));

-- Membership mutations only go through checked, serialized functions.
revoke all on public.team_members, public.team_invites from anon, authenticated;
grant select on public.team_members, public.team_invites to authenticated;
drop policy if exists "Owners and members read memberships" on public.team_members;
create policy "Workspace roster" on public.team_members for select to authenticated using (public.can_read_owner(owner_user_id));
drop policy if exists "Owners delete memberships" on public.team_members;
drop policy if exists "Owners manage invites" on public.team_invites;
create policy "Workspace invite managers" on public.team_invites for select to authenticated using (private.workspace_role(owner_user_id) in ('owner', 'admin'));

create function private.list_workspaces()
returns table(owner_user_id uuid, name text, owner_email text, role text, plan text, has_override boolean)
language sql stable security definer set search_path = '' as $$
  select u.id, coalesce(s.name, split_part(u.email, '@', 1) || '''s workspace'), u.email,
    private.workspace_role(u.id), public.effective_plan_for_user(u.id), sub.admin_override_plan is not null
  from auth.users u
  left join public.workspace_settings s on s.owner_user_id = u.id
  left join public.subscriptions sub on sub.user_id = u.id
  where auth.uid() is not null and (u.id = auth.uid() or exists (
    select 1 from public.team_members m where m.owner_user_id = u.id and m.member_user_id = auth.uid()
  ));
$$;
create function public.list_workspaces()
returns table(owner_user_id uuid, name text, owner_email text, role text, plan text, has_override boolean)
language sql stable security invoker set search_path = '' as $$ select * from private.list_workspaces(); $$;

create function private.create_workspace_invite(target_owner uuid, invite_email text, invite_role text)
returns public.team_invites language plpgsql security definer set search_path = '' as $$
declare
  actor_role text := private.workspace_role(target_owner);
  normalized_email text := lower(trim(invite_email));
  invitation public.team_invites;
  occupied integer;
begin
  if auth.uid() is null or actor_role is null or actor_role not in ('owner', 'admin') then raise exception 'Only an owner or admin can invite members.'; end if;
  if invite_role is null or invite_role not in ('admin', 'editor', 'viewer') then raise exception 'Choose a valid role.'; end if;
  if actor_role <> 'owner' and invite_role = 'admin' then raise exception 'Only the owner can appoint admins.'; end if;
  if normalized_email is null or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(normalized_email) > 254 then raise exception 'Enter a valid email address.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(target_owner::text, 0));
  if exists (select 1 from auth.users where id = target_owner and lower(email) = normalized_email)
    or exists (select 1 from public.team_members where owner_user_id = target_owner and lower(member_email) = normalized_email)
  then raise exception 'This person already belongs to the workspace.'; end if;
  select * into invitation from public.team_invites where owner_user_id = target_owner and lower(email) = normalized_email and status = 'pending' order by created_at desc limit 1 for update;
  if actor_role <> 'owner' and invitation.role = 'admin' then raise exception 'Only the owner can manage admin invitations.'; end if;
  select 1 + (select count(*) from public.team_members where owner_user_id = target_owner)
    + (select count(*) from public.team_invites where owner_user_id = target_owner and status = 'pending' and expires_at > now() and id is distinct from invitation.id)
    into occupied;
  if occupied >= public.plan_member_limit(public.effective_plan_for_user(target_owner)) then raise exception 'Your plan has no available seats. Revoke a pending invitation or upgrade your plan.'; end if;
  if invitation.id is not null then
    update public.team_invites set token = gen_random_uuid(), role = invite_role, expires_at = now() + interval '7 days' where id = invitation.id returning * into invitation;
  else
    insert into public.team_invites(owner_user_id, email, role) values (target_owner, normalized_email, invite_role) returning * into invitation;
  end if;
  insert into public.workspace_activity(owner_user_id, actor_user_id, action, subject) values (target_owner, auth.uid(), 'Invitation created', normalized_email);
  return invitation;
end;
$$;
create function public.create_workspace_invite(target_owner uuid, invite_email text, invite_role text default 'viewer')
returns public.team_invites language sql security invoker set search_path = '' as $$ select private.create_workspace_invite(target_owner, invite_email, invite_role); $$;

create function private.revoke_workspace_invite(invite_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare invitation public.team_invites; actor_role text;
begin
  select * into invitation from public.team_invites where id = invite_id;
  actor_role := private.workspace_role(invitation.owner_user_id);
  if auth.uid() is null or actor_role is null or actor_role not in ('owner', 'admin') or (actor_role <> 'owner' and invitation.role = 'admin') then raise exception 'You cannot revoke this invitation.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(invitation.owner_user_id::text, 0));
  update public.team_invites set status = 'revoked' where id = invite_id and status = 'pending';
  if not found then raise exception 'This invitation is no longer pending.'; end if;
  insert into public.workspace_activity(owner_user_id, actor_user_id, action, subject) values (invitation.owner_user_id, auth.uid(), 'Invitation revoked', invitation.email);
end;
$$;
create function public.revoke_workspace_invite(invite_id uuid)
returns void language sql security invoker set search_path = '' as $$ select private.revoke_workspace_invite(invite_id); $$;

create function private.accept_workspace_invite(invite_token uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare invitation public.team_invites; current_email text; occupied integer;
begin
  if auth.uid() is null then raise exception 'Sign in to accept your invitation.'; end if;
  select lower(email) into current_email from auth.users where id = auth.uid() and email_confirmed_at is not null;
  if current_email is null then raise exception 'Verify your email before joining a workspace.'; end if;
  select * into invitation from public.team_invites where token = invite_token;
  if not found then raise exception 'This invitation does not exist or has been replaced.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(invitation.owner_user_id::text, 0));
  select * into invitation from public.team_invites where token = invite_token for update;
  if not found then raise exception 'This invitation has been replaced.'; end if;
  if lower(invitation.email) <> current_email then raise exception 'Sign in with the email address on the invitation.'; end if;
  if invitation.status = 'accepted' and exists(select 1 from public.team_members where owner_user_id = invitation.owner_user_id and member_user_id = auth.uid()) then return invitation.owner_user_id; end if;
  if invitation.status <> 'pending' then raise exception 'This invitation is no longer available.'; end if;
  if invitation.expires_at <= now() then raise exception 'This invitation has expired. Ask for a new link.'; end if;
  if auth.uid() = invitation.owner_user_id then raise exception 'You already own this workspace.'; end if;
  if exists(select 1 from public.team_members where owner_user_id = invitation.owner_user_id and member_user_id = auth.uid()) then raise exception 'You already belong to this workspace.'; end if;
  select 1 + count(*) into occupied from public.team_members where owner_user_id = invitation.owner_user_id;
  if occupied >= public.plan_member_limit(public.effective_plan_for_user(invitation.owner_user_id)) then raise exception 'This workspace has reached its plan seat limit.'; end if;
  insert into public.team_members(owner_user_id, member_user_id, member_email, role) values (invitation.owner_user_id, auth.uid(), current_email, invitation.role);
  update public.team_invites set status = 'accepted' where id = invitation.id;
  insert into public.workspace_activity(owner_user_id, actor_user_id, action, subject) values (invitation.owner_user_id, auth.uid(), 'Member joined', current_email);
  return invitation.owner_user_id;
end;
$$;
create or replace function public.accept_team_invite(invite_token uuid)
returns uuid language sql security invoker set search_path = '' as $$ select private.accept_workspace_invite(invite_token); $$;

create function private.change_workspace_member(member_id uuid, new_role text)
returns void language plpgsql security definer set search_path = '' as $$
declare member public.team_members; actor_role text;
begin
  select * into member from public.team_members where id = member_id;
  if not found then raise exception 'This membership no longer exists.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(member.owner_user_id::text, 0));
  select * into member from public.team_members where id = member_id for update;
  if not found then raise exception 'This membership no longer exists.'; end if;
  actor_role := private.workspace_role(member.owner_user_id);
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if not (new_role is null and member.member_user_id = auth.uid()) then
    if actor_role is null or actor_role not in ('owner', 'admin') then raise exception 'You cannot manage this member.'; end if;
    if actor_role <> 'owner' and (member.role = 'admin' or new_role = 'admin') then raise exception 'Only the owner can manage admins.'; end if;
  end if;
  if new_role is null then
    delete from public.team_members where id = member_id;
  else
    if new_role not in ('admin', 'editor', 'viewer') then raise exception 'Choose a valid role.'; end if;
    update public.team_members set role = new_role where id = member_id;
  end if;
  insert into public.workspace_activity(owner_user_id, actor_user_id, action, subject) values (member.owner_user_id, auth.uid(), case when new_role is null then 'Member removed' else 'Role changed to ' || new_role end, member.member_email);
end;
$$;
create function public.change_workspace_member(member_id uuid, new_role text default null)
returns void language sql security invoker set search_path = '' as $$ select private.change_workspace_member(member_id, new_role); $$;

create function private.pending_workspace_invites()
returns table(id uuid, token uuid, email text, role text, expires_at timestamptz, workspace_name text)
language sql stable security definer set search_path = '' as $$
  select i.id, i.token, i.email, i.role, i.expires_at, coalesce(s.name, split_part(u.email, '@', 1) || '''s workspace')
  from public.team_invites i join auth.users u on u.id = i.owner_user_id
  left join public.workspace_settings s on s.owner_user_id = i.owner_user_id
  where auth.uid() is not null and lower(i.email) = (select lower(email) from auth.users where id = auth.uid() and email_confirmed_at is not null)
  and i.status = 'pending' and i.expires_at > now();
$$;
create function public.pending_workspace_invites()
returns table(id uuid, token uuid, email text, role text, expires_at timestamptz, workspace_name text)
language sql stable security invoker set search_path = '' as $$ select * from private.pending_workspace_invites(); $$;

create function private.rename_workspace(target_owner uuid, workspace_name text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or coalesce(private.workspace_role(target_owner), '') not in ('owner', 'admin') then raise exception 'Only an owner or admin can change workspace settings.'; end if;
  if workspace_name is null or length(trim(workspace_name)) not between 1 and 80 then raise exception 'Use a name between 1 and 80 characters.'; end if;
  insert into public.workspace_settings(owner_user_id, name) values (target_owner, trim(workspace_name)) on conflict (owner_user_id) do update set name = excluded.name, updated_at = now();
  insert into public.workspace_activity(owner_user_id, actor_user_id, action, subject) values (target_owner, auth.uid(), 'Workspace renamed', trim(workspace_name));
end;
$$;
create function public.rename_workspace(target_owner uuid, workspace_name text)
returns void language sql security invoker set search_path = '' as $$ select private.rename_workspace(target_owner, workspace_name); $$;

-- Explicit RPC grants: no anonymous membership or invitation APIs.
do $$ declare signature text; begin
  foreach signature in array array[
    'private.list_workspaces()', 'public.list_workspaces()',
    'private.create_workspace_invite(uuid,text,text)', 'public.create_workspace_invite(uuid,text,text)',
    'private.revoke_workspace_invite(uuid)', 'public.revoke_workspace_invite(uuid)',
    'private.accept_workspace_invite(uuid)', 'public.accept_team_invite(uuid)',
    'private.change_workspace_member(uuid,text)', 'public.change_workspace_member(uuid,text)',
    'private.pending_workspace_invites()', 'public.pending_workspace_invites()',
    'private.rename_workspace(uuid,text)', 'public.rename_workspace(uuid,text)'
  ] loop
    execute 'revoke all on function ' || signature || ' from public, anon';
    execute 'grant execute on function ' || signature || ' to authenticated';
  end loop;
end $$;

create policy "Workspace admins add websites" on public.websites for insert to authenticated with check (private.workspace_role(user_id) in ('owner', 'admin'));
create policy "Workspace admins remove websites" on public.websites for delete to authenticated using (private.workspace_role(user_id) in ('owner', 'admin'));

-- A write must never move a resource between tenants or attach it to a foreign parent.
create function private.check_resource_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
declare expected_owner uuid; expected_website uuid;
begin
  if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then raise exception 'Resource ownership cannot be changed.'; end if;
  if tg_table_name in ('pages', 'issues') then
    select user_id into expected_owner from public.websites where id = new.website_id;
    if expected_owner is distinct from new.user_id then raise exception 'Website does not belong to this workspace.'; end if;
  end if;
  if tg_table_name = 'issues' and new.page_id is not null then
    select website_id into expected_website from public.pages where id = new.page_id;
    if expected_website is distinct from new.website_id then raise exception 'Page does not belong to this website.'; end if;
  end if;
  return new;
end;
$$;
revoke all on function private.check_resource_owner() from public, anon, authenticated;
create trigger check_website_owner before update on public.websites for each row execute function private.check_resource_owner();
create trigger check_page_owner before insert or update on public.pages for each row execute function private.check_resource_owner();
create trigger check_issue_owner before insert or update on public.issues for each row execute function private.check_resource_owner();

create table public.page_checks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  website_id uuid not null references public.websites(id) on delete cascade,
  page_id uuid not null references public.pages(id) on delete cascade,
  checked_at timestamptz not null,
  http_status integer,
  response_ms integer,
  content_changed boolean not null default false,
  changed_fields text[] not null default '{}',
  snapshot jsonb not null,
  previous_snapshot jsonb,
  unique(page_id, checked_at)
);
create index page_checks_website_date_idx on public.page_checks(website_id, checked_at desc);
create index page_checks_owner_date_idx on public.page_checks(user_id, checked_at desc);
alter table public.page_checks enable row level security;
revoke all on public.page_checks from anon, authenticated;
grant select on public.page_checks to authenticated;
grant all on public.page_checks to service_role;
create policy "Members read page checks" on public.page_checks for select to authenticated using (public.can_read_owner(user_id));

create function private.record_page_check()
returns trigger language plpgsql security definer set search_path = '' as $$
declare before_snapshot jsonb; after_snapshot jsonb; changes text[] := '{}'; key text;
begin
  if new.last_scan_at is null then return new; end if;
  if tg_op = 'UPDATE' and new.last_scan_at is not distinct from old.last_scan_at then return new; end if;
  after_snapshot := jsonb_build_object('title', new.title, 'meta_description', new.meta_description, 'h1_count', new.h1_count, 'canonical_url', new.canonical_url, 'content_hash', new.content_hash, 'redirect_count', new.redirect_count);
  if tg_op = 'UPDATE' and old.last_scan_at is not null then
    before_snapshot := jsonb_build_object('title', old.title, 'meta_description', old.meta_description, 'h1_count', old.h1_count, 'canonical_url', old.canonical_url, 'content_hash', old.content_hash, 'redirect_count', old.redirect_count);
    foreach key in array array['title','meta_description','h1_count','canonical_url','content_hash','redirect_count'] loop
      if before_snapshot -> key is distinct from after_snapshot -> key then changes := array_append(changes, key); end if;
    end loop;
  end if;
  insert into public.page_checks(user_id, website_id, page_id, checked_at, http_status, response_ms, content_changed, changed_fields, snapshot, previous_snapshot)
    values (new.user_id, new.website_id, new.id, new.last_scan_at, new.http_status, new.response_ms, 'content_hash' = any(changes), changes, after_snapshot, before_snapshot)
    on conflict (page_id, checked_at) do nothing;
  return new;
end;
$$;
revoke all on function private.record_page_check() from public, anon, authenticated;
create trigger record_page_check after insert or update on public.pages for each row execute function private.record_page_check();

-- Retain each person's read state without marking a teammate's alerts as read.
create table public.alert_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  alert_id uuid not null references public.alerts(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key(user_id, alert_id)
);
create index alert_receipts_alert_idx on public.alert_receipts(alert_id);
alter table public.alert_receipts enable row level security;
revoke all on public.alert_receipts from anon, authenticated;
grant select, insert, update on public.alert_receipts to authenticated;
grant all on public.alert_receipts to service_role;
create policy "Own alert receipts" on public.alert_receipts for select to authenticated using (user_id = (select auth.uid()));
create policy "Mark accessible alerts read" on public.alert_receipts for insert to authenticated with check (user_id = (select auth.uid()) and exists(select 1 from public.alerts a where a.id = alert_id and public.can_read_owner(a.user_id)));
create policy "Update own alert receipts" on public.alert_receipts for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()) and exists(select 1 from public.alerts a where a.id = alert_id and public.can_read_owner(a.user_id)));

notify pgrst, 'reload schema';
