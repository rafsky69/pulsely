
-- ============================================================
-- PULSELY COMPLETE V1
-- ============================================================

-- ------------------------------------------------------------
-- WEBSITE MONITORING FIELDS
-- ------------------------------------------------------------

alter table public.websites
  add column if not exists health_status text not null default 'healthy',
  add column if not exists http_status integer,
  add column if not exists last_response_ms integer,
  add column if not exists last_uptime_at timestamptz,
  add column if not exists last_scan_at timestamptz,
  add column if not exists next_uptime_at timestamptz not null default now(),
  add column if not exists next_scan_at timestamptz not null default now(),
  add column if not exists scan_error text,
  add column if not exists robots_status integer,
  add column if not exists sitemap_status integer,
  add column if not exists ssl_expires_at timestamptz,
  add column if not exists last_ssl_check_at timestamptz;

create index if not exists websites_next_uptime_idx
on public.websites(next_uptime_at);

create index if not exists websites_next_scan_idx
on public.websites(next_scan_at);


-- ------------------------------------------------------------
-- PAGE DETAILS
-- ------------------------------------------------------------

alter table public.pages
  add column if not exists response_ms integer,
  add column if not exists meta_description text,
  add column if not exists h1_count integer,
  add column if not exists redirect_count integer not null default 0,
  add column if not exists canonical_url text,
  add column if not exists content_hash text;

create index if not exists pages_last_scan_idx
on public.pages(last_scan_at);


-- ------------------------------------------------------------
-- ISSUE DETAILS
-- ------------------------------------------------------------

alter table public.issues
  add column if not exists fingerprint text;

create unique index if not exists issues_user_fingerprint_key
on public.issues(user_id, fingerprint);


-- ------------------------------------------------------------
-- ALERT DETAILS
-- ------------------------------------------------------------

alter table public.alerts
  add column if not exists severity text not null default 'info';


-- ------------------------------------------------------------
-- LINK GRAPH
-- ------------------------------------------------------------

create table if not exists public.page_links (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null
    references auth.users(id)
    on delete cascade,

  website_id uuid not null
    references public.websites(id)
    on delete cascade,

  source_page_id uuid not null
    references public.pages(id)
    on delete cascade,

  target_url text not null,
  target_host text,

  is_internal boolean not null default false,

  last_status integer,
  is_broken boolean not null default false,
  last_checked_at timestamptz,

  created_at timestamptz not null default now(),

  unique(source_page_id, target_url)
);

create index if not exists page_links_website_idx
on public.page_links(website_id);

create index if not exists page_links_broken_idx
on public.page_links(is_broken);


-- ------------------------------------------------------------
-- MONITORING HISTORY
-- ------------------------------------------------------------

create table if not exists public.monitoring_runs (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null
    references auth.users(id)
    on delete cascade,

  website_id uuid not null
    references public.websites(id)
    on delete cascade,

  mode text not null,

  success boolean not null,
  status_code integer,
  response_ms integer,

  checked_at timestamptz not null default now()
);

create index if not exists monitoring_runs_user_date_idx
on public.monitoring_runs(user_id, checked_at desc);


-- ------------------------------------------------------------
-- ISSUE HISTORY
-- ------------------------------------------------------------

create table if not exists public.issue_history (
  id uuid primary key default gen_random_uuid(),

  issue_id uuid not null
    references public.issues(id)
    on delete cascade,

  user_id uuid not null
    references auth.users(id)
    on delete cascade,

  event text not null,

  old_status text,
  new_status text,

  severity text,
  title text,

  created_at timestamptz not null default now()
);

create index if not exists issue_history_issue_idx
on public.issue_history(issue_id, created_at desc);


-- ------------------------------------------------------------
-- EMAIL ALERT OUTBOX
-- ------------------------------------------------------------

create table if not exists public.alert_outbox (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null
    references auth.users(id)
    on delete cascade,

  alert_id uuid not null
    references public.alerts(id)
    on delete cascade,

  status text not null default 'pending'
    check (
      status in (
        'pending',
        'sent',
        'failed',
        'suppressed'
      )
    ),

  attempts integer not null default 0,
  last_error text,

  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists alert_outbox_pending_idx
on public.alert_outbox(status, created_at);


-- ------------------------------------------------------------
-- ALERT PREFERENCES
-- ------------------------------------------------------------

create table if not exists public.alert_preferences (
  user_id uuid primary key
    references auth.users(id)
    on delete cascade,

  email_enabled boolean not null default true,
  critical_only boolean not null default false,

  updated_at timestamptz not null default now()
);

insert into public.alert_preferences(user_id)
select id
from auth.users
on conflict (user_id) do nothing;


-- ------------------------------------------------------------
-- HUMAN REVIEW IMPROVEMENTS
-- ------------------------------------------------------------

alter table public.human_reviews
  add column if not exists reviewer_user_id uuid
    references auth.users(id)
    on delete set null;


-- ------------------------------------------------------------
-- TEAM MEMBERS
-- ------------------------------------------------------------

create table if not exists public.team_members (
  id uuid primary key default gen_random_uuid(),

  owner_user_id uuid not null
    references auth.users(id)
    on delete cascade,

  member_user_id uuid not null
    references auth.users(id)
    on delete cascade,

  member_email text not null,

  role text not null default 'viewer'
    check (
      role in (
        'viewer',
        'editor',
        'admin'
      )
    ),

  created_at timestamptz not null default now(),

  unique(owner_user_id, member_user_id)
);


-- ------------------------------------------------------------
-- TEAM INVITES
-- ------------------------------------------------------------

create table if not exists public.team_invites (
  id uuid primary key default gen_random_uuid(),

  owner_user_id uuid not null
    references auth.users(id)
    on delete cascade,

  email text not null,

  role text not null default 'viewer'
    check (
      role in (
        'viewer',
        'editor',
        'admin'
      )
    ),

  token uuid not null unique
    default gen_random_uuid(),

  status text not null default 'pending'
    check (
      status in (
        'pending',
        'accepted',
        'revoked'
      )
    ),

  created_at timestamptz not null default now(),
  expires_at timestamptz not null
    default (now() + interval '7 days')
);


-- ============================================================
-- TEAM ACCESS HELPERS
-- ============================================================

create or replace function public.can_read_owner(target_owner uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    auth.uid() = target_owner
    or exists (
      select 1
      from public.team_members tm
      where tm.owner_user_id = target_owner
        and tm.member_user_id = auth.uid()
    );
$$;

create or replace function public.can_write_owner(target_owner uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    auth.uid() = target_owner
    or exists (
      select 1
      from public.team_members tm
      where tm.owner_user_id = target_owner
        and tm.member_user_id = auth.uid()
        and tm.role in ('editor', 'admin')
    );
$$;

grant execute on function public.can_read_owner(uuid)
to authenticated;

grant execute on function public.can_write_owner(uuid)
to authenticated;


-- ============================================================
-- ACCEPT TEAM INVITE
-- ============================================================

create or replace function public.accept_team_invite(invite_token uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  invite_record public.team_invites%rowtype;
  current_email text;
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  current_email := lower(
    coalesce(
      auth.jwt() ->> 'email',
      ''
    )
  );

  select *
  into invite_record
  from public.team_invites
  where token = invite_token
  for update;

  if not found then
    raise exception 'INVITE_NOT_FOUND';
  end if;

  if invite_record.status <> 'pending' then
    raise exception 'INVITE_NOT_PENDING';
  end if;

  if invite_record.expires_at < now() then
    raise exception 'INVITE_EXPIRED';
  end if;

  if lower(invite_record.email) <> current_email then
    raise exception 'INVITE_EMAIL_MISMATCH';
  end if;

  insert into public.team_members (
    owner_user_id,
    member_user_id,
    member_email,
    role
  )
  values (
    invite_record.owner_user_id,
    auth.uid(),
    current_email,
    invite_record.role
  )
  on conflict (owner_user_id, member_user_id)
  do update set
    member_email = excluded.member_email,
    role = excluded.role;

  update public.team_invites
  set status = 'accepted'
  where id = invite_record.id;

  return invite_record.owner_user_id;
end;
$$;

grant execute on function public.accept_team_invite(uuid)
to authenticated;


-- ============================================================
-- COMPLETE HUMAN REVIEW
-- ============================================================

create or replace function public.complete_human_review(
  target_page_id uuid,
  review_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  page_owner uuid;
  new_review_id uuid;
begin
  select user_id
  into page_owner
  from public.pages
  where id = target_page_id;

  if page_owner is null then
    raise exception 'PAGE_NOT_FOUND';
  end if;

  if not public.can_write_owner(page_owner) then
    raise exception 'NOT_ALLOWED';
  end if;

  insert into public.human_reviews (
    user_id,
    page_id,
    reviewer_user_id,
    status,
    notes,
    due_at,
    completed_at
  )
  values (
    page_owner,
    target_page_id,
    auth.uid(),
    'completed',
    review_notes,
    now(),
    now()
  )
  returning id
  into new_review_id;

  update public.pages
  set
    last_human_review_at = now(),
    next_human_review_at = now() + interval '1 year',
    updated_at = now()
  where id = target_page_id;

  return new_review_id;
end;
$$;

grant execute on function public.complete_human_review(uuid, text)
to authenticated;


-- ============================================================
-- ISSUE HISTORY TRIGGER
-- ============================================================

create or replace function public.record_issue_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  event_name text;
begin
  if tg_op = 'INSERT' then
    event_name := 'created';

    insert into public.issue_history (
      issue_id,
      user_id,
      event,
      new_status,
      severity,
      title
    )
    values (
      new.id,
      new.user_id,
      event_name,
      new.status,
      new.severity,
      new.title
    );

    return new;
  end if;

  if
    old.status is distinct from new.status
    or old.severity is distinct from new.severity
  then
    event_name :=
      case
        when new.status = 'resolved'
          then 'resolved'
        when old.status = 'resolved'
          and new.status <> 'resolved'
          then 'reopened'
        else 'updated'
      end;

    insert into public.issue_history (
      issue_id,
      user_id,
      event,
      old_status,
      new_status,
      severity,
      title
    )
    values (
      new.id,
      new.user_id,
      event_name,
      old.status,
      new.status,
      new.severity,
      new.title
    );
  end if;

  return new;
end;
$$;

drop trigger if exists issue_history_trigger
on public.issues;

create trigger issue_history_trigger
after insert or update
on public.issues
for each row
execute function public.record_issue_history();


-- ============================================================
-- ISSUE → ALERT TRIGGER
-- ============================================================

create or replace function public.issue_alert_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.alerts (
      user_id,
      website_id,
      issue_id,
      type,
      severity,
      title,
      message
    )
    values (
      new.user_id,
      new.website_id,
      new.id,
      'issue_created',
      new.severity,
      new.title,
      new.description
    );

    return new;
  end if;

  if
    old.status is distinct from new.status
    and new.status = 'resolved'
  then
    insert into public.alerts (
      user_id,
      website_id,
      issue_id,
      type,
      severity,
      title,
      message
    )
    values (
      new.user_id,
      new.website_id,
      new.id,
      'issue_resolved',
      new.severity,
      'Resolved: ' || new.title,
      new.description
    );
  elsif
    old.status is distinct from new.status
    and old.status = 'resolved'
  then
    insert into public.alerts (
      user_id,
      website_id,
      issue_id,
      type,
      severity,
      title,
      message
    )
    values (
      new.user_id,
      new.website_id,
      new.id,
      'issue_reopened',
      new.severity,
      'Reopened: ' || new.title,
      new.description
    );
  end if;

  return new;
end;
$$;

drop trigger if exists issue_alert_trigger
on public.issues;

create trigger issue_alert_trigger
after insert or update
on public.issues
for each row
execute function public.issue_alert_trigger();


-- ============================================================
-- ALERT → EMAIL OUTBOX
-- ============================================================

create or replace function public.queue_alert_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.alert_outbox (
    user_id,
    alert_id
  )
  values (
    new.user_id,
    new.id
  );

  return new;
end;
$$;

drop trigger if exists queue_alert_email_trigger
on public.alerts;

create trigger queue_alert_email_trigger
after insert
on public.alerts
for each row
execute function public.queue_alert_email();


-- ============================================================
-- REPORT SUMMARY
-- ============================================================

create or replace function public.build_report_summary(
  target_user_id uuid,
  start_at timestamptz,
  end_at timestamptz
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(

    'monitoring_checks',
    (
      select count(*)
      from public.monitoring_runs
      where user_id = target_user_id
        and checked_at between start_at and end_at
    ),

    'successful_checks',
    (
      select count(*)
      from public.monitoring_runs
      where user_id = target_user_id
        and success = true
        and checked_at between start_at and end_at
    ),

    'uptime_percent',
    (
      select coalesce(
        round(
          100.0 *
          count(*) filter (where success = true)
          /
          nullif(count(*), 0),
          2
        ),
        100
      )
      from public.monitoring_runs
      where user_id = target_user_id
        and checked_at between start_at and end_at
    ),

    'average_response_ms',
    (
      select coalesce(
        round(avg(response_ms)),
        0
      )
      from public.monitoring_runs
      where user_id = target_user_id
        and response_ms is not null
        and checked_at between start_at and end_at
    ),

    'issues_detected',
    (
      select count(*)
      from public.issues
      where user_id = target_user_id
        and detected_at between start_at and end_at
    ),

    'open_issues',
    (
      select count(*)
      from public.issues
      where user_id = target_user_id
        and status in ('open', 'in_progress')
    ),

    'reviews_completed',
    (
      select count(*)
      from public.human_reviews
      where user_id = target_user_id
        and completed_at between start_at and end_at
    ),

    'pages',
    (
      select count(*)
      from public.pages
      where user_id = target_user_id
    ),

    'websites',
    (
      select count(*)
      from public.websites
      where user_id = target_user_id
    )
  );
$$;

revoke all
on function public.build_report_summary(uuid, timestamptz, timestamptz)
from public, anon, authenticated;

grant execute
on function public.build_report_summary(uuid, timestamptz, timestamptz)
to service_role;


-- ============================================================
-- ACCOUNT CREATION
-- ============================================================

create or replace function public.create_default_subscription()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.subscriptions (
    user_id,
    plan,
    status
  )
  values (
    new.id,
    'free',
    'free'
  )
  on conflict (user_id) do nothing;

  insert into public.alert_preferences (
    user_id
  )
  values (
    new.id
  )
  on conflict (user_id) do nothing;

  return new;
end;
$$;


-- ============================================================
-- RLS
-- ============================================================

alter table public.page_links enable row level security;
alter table public.monitoring_runs enable row level security;
alter table public.issue_history enable row level security;
alter table public.alert_outbox enable row level security;
alter table public.alert_preferences enable row level security;
alter table public.team_members enable row level security;
alter table public.team_invites enable row level security;


-- Page links

drop policy if exists "Read accessible page links"
on public.page_links;

create policy "Read accessible page links"
on public.page_links
for select
to authenticated
using (
  public.can_read_owner(user_id)
);


-- Monitoring history

drop policy if exists "Read accessible monitoring runs"
on public.monitoring_runs;

create policy "Read accessible monitoring runs"
on public.monitoring_runs
for select
to authenticated
using (
  public.can_read_owner(user_id)
);


-- Issue history

drop policy if exists "Read accessible issue history"
on public.issue_history;

create policy "Read accessible issue history"
on public.issue_history
for select
to authenticated
using (
  public.can_read_owner(user_id)
);


-- Alert preferences

drop policy if exists "Users read alert preferences"
on public.alert_preferences;

create policy "Users read alert preferences"
on public.alert_preferences
for select
to authenticated
using (
  auth.uid() = user_id
);

drop policy if exists "Users update alert preferences"
on public.alert_preferences;

create policy "Users update alert preferences"
on public.alert_preferences
for update
to authenticated
using (
  auth.uid() = user_id
)
with check (
  auth.uid() = user_id
);


-- Team members

drop policy if exists "Owners and members read memberships"
on public.team_members;

create policy "Owners and members read memberships"
on public.team_members
for select
to authenticated
using (
  owner_user_id = auth.uid()
  or member_user_id = auth.uid()
);

drop policy if exists "Owners delete memberships"
on public.team_members;

create policy "Owners delete memberships"
on public.team_members
for delete
to authenticated
using (
  owner_user_id = auth.uid()
);


-- Team invites

drop policy if exists "Owners manage invites"
on public.team_invites;

create policy "Owners manage invites"
on public.team_invites
for all
to authenticated
using (
  owner_user_id = auth.uid()
)
with check (
  owner_user_id = auth.uid()
);


-- Team access to existing Pulsely resources

drop policy if exists "Team read websites"
on public.websites;

create policy "Team read websites"
on public.websites
for select
to authenticated
using (
  public.can_read_owner(user_id)
);

drop policy if exists "Team update websites"
on public.websites;

create policy "Team update websites"
on public.websites
for update
to authenticated
using (
  public.can_write_owner(user_id)
)
with check (
  public.can_write_owner(user_id)
);


drop policy if exists "Team read pages"
on public.pages;

create policy "Team read pages"
on public.pages
for select
to authenticated
using (
  public.can_read_owner(user_id)
);

drop policy if exists "Team update pages"
on public.pages;

create policy "Team update pages"
on public.pages
for update
to authenticated
using (
  public.can_write_owner(user_id)
)
with check (
  public.can_write_owner(user_id)
);


drop policy if exists "Team read issues"
on public.issues;

create policy "Team read issues"
on public.issues
for select
to authenticated
using (
  public.can_read_owner(user_id)
);

drop policy if exists "Team update issues"
on public.issues;

create policy "Team update issues"
on public.issues
for update
to authenticated
using (
  public.can_write_owner(user_id)
)
with check (
  public.can_write_owner(user_id)
);


drop policy if exists "Team read alerts"
on public.alerts;

create policy "Team read alerts"
on public.alerts
for select
to authenticated
using (
  public.can_read_owner(user_id)
);


drop policy if exists "Team read reports"
on public.reports;

create policy "Team read reports"
on public.reports
for select
to authenticated
using (
  public.can_read_owner(user_id)
);


drop policy if exists "Team read reviews"
on public.human_reviews;

create policy "Team read reviews"
on public.human_reviews
for select
to authenticated
using (
  public.can_read_owner(user_id)
);


-- ============================================================
-- GRANTS
-- ============================================================

grant select
on public.page_links,
   public.monitoring_runs,
   public.issue_history
to authenticated;

grant select, update
on public.alert_preferences
to authenticated;

grant select, delete
on public.team_members
to authenticated;

grant select, insert, update, delete
on public.team_invites
to authenticated;


grant select, insert, update, delete
on public.websites,
   public.pages,
   public.issues,
   public.alerts,
   public.reports,
   public.human_reviews,
   public.subscriptions,
   public.page_links,
   public.monitoring_runs,
   public.issue_history,
   public.alert_outbox,
   public.alert_preferences,
   public.team_members,
   public.team_invites
to service_role;

