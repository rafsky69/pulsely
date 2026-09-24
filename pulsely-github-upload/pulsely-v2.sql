
-- ============================================================
-- PULSELY V2 DATABASE
-- Billing privileges + pages + issues + reviews + alerts
-- ============================================================

-- ------------------------------------------------------------
-- SUBSCRIPTIONS
-- ------------------------------------------------------------

alter table public.subscriptions
  add column if not exists admin_override_plan text,
  add column if not exists current_period_end timestamptz,
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists scheduled_change_at timestamptz,
  add column if not exists last_paddle_event_at timestamptz,
  add column if not exists last_paddle_event_id text;

-- Preserve founder/admin grants forever, independent of Paddle.
update public.subscriptions
set
  admin_override_plan = plan,
  plan = 'free'
where status = 'admin_granted'
  and admin_override_plan is null;

-- Every existing account gets a billing row.
insert into public.subscriptions (
  user_id,
  plan,
  status
)
select
  id,
  'free',
  'free'
from auth.users
on conflict (user_id) do nothing;

-- Every future account gets one automatically.
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

  return new;
end;
$$;

drop trigger if exists create_default_subscription_trigger
on auth.users;

create trigger create_default_subscription_trigger
after insert on auth.users
for each row
execute function public.create_default_subscription();


-- ------------------------------------------------------------
-- EFFECTIVE PLAN
-- ------------------------------------------------------------

create or replace function public.effective_plan_for_user(target_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select
        coalesce(
          admin_override_plan,
          case
            when status in (
              'active',
              'trialing',
              'past_due',
              'admin_granted'
            )
            then plan
            else 'free'
          end
        )
      from public.subscriptions
      where user_id = target_user_id
      limit 1
    ),
    'free'
  );
$$;


-- ------------------------------------------------------------
-- PLAN LIMIT FUNCTIONS
-- ------------------------------------------------------------

create or replace function public.plan_website_limit(plan_name text)
returns integer
language sql
immutable
as $$
  select case plan_name
    when 'free' then 1
    when 'developer' then 5
    when 'webmaster' then 15
    when 'freelancer' then 40
    when 'professional' then 100
    when 'studio' then 250
    when 'agency' then 750
    when 'enterprise' then 2000
    else 1
  end;
$$;

create or replace function public.plan_page_limit(plan_name text)
returns integer
language sql
immutable
as $$
  select case plan_name
    when 'free' then 50
    when 'developer' then 500
    when 'webmaster' then 2500
    when 'freelancer' then 10000
    when 'professional' then 50000
    when 'studio' then 150000
    when 'agency' then 500000
    when 'enterprise' then 2000000
    else 50
  end;
$$;

create or replace function public.plan_member_limit(plan_name text)
returns integer
language sql
immutable
as $$
  select case plan_name
    when 'free' then 1
    when 'developer' then 1
    when 'webmaster' then 1
    when 'freelancer' then 3
    when 'professional' then 10
    when 'studio' then 25
    when 'agency' then 75
    when 'enterprise' then 2147483647
    else 1
  end;
$$;

create or replace function public.plan_uptime_seconds(plan_name text)
returns integer
language sql
immutable
as $$
  select case plan_name
    when 'free' then 3600
    when 'developer' then 900
    when 'webmaster' then 300
    when 'freelancer' then 120
    when 'professional' then 60
    when 'studio' then 60
    when 'agency' then 30
    when 'enterprise' then 15
    else 3600
  end;
$$;

create or replace function public.plan_scan_minutes(plan_name text)
returns integer
language sql
immutable
as $$
  select case plan_name
    when 'free' then 10080
    when 'developer' then 1440
    when 'webmaster' then 720
    when 'freelancer' then 360
    when 'professional' then 180
    when 'studio' then 60
    when 'agency' then 30
    when 'enterprise' then 15
    else 10080
  end;
$$;


-- ------------------------------------------------------------
-- WEBSITE LIMIT ENFORCEMENT
-- ------------------------------------------------------------

create or replace function public.enforce_website_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  active_plan text;
  allowed_sites integer;
  current_sites bigint;
begin
  if auth.uid() is not null and new.user_id <> auth.uid() then
    raise exception 'INVALID_WEBSITE_OWNER';
  end if;

  active_plan := public.effective_plan_for_user(new.user_id);
  allowed_sites := public.plan_website_limit(active_plan);

  select count(*)
  into current_sites
  from public.websites
  where user_id = new.user_id;

  if current_sites >= allowed_sites then
    raise exception 'WEBSITE_LIMIT_REACHED';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_website_limit_trigger
on public.websites;

create trigger enforce_website_limit_trigger
before insert on public.websites
for each row
execute function public.enforce_website_limit();


-- ------------------------------------------------------------
-- PAGES
-- ------------------------------------------------------------

create table if not exists public.pages (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null
    references auth.users(id)
    on delete cascade,

  website_id uuid not null
    references public.websites(id)
    on delete cascade,

  url text not null,
  title text,

  health_status text not null default 'healthy'
    check (
      health_status in (
        'healthy',
        'needs_attention',
        'action_required',
        'critical'
      )
    ),

  http_status integer,

  last_scan_at timestamptz,
  last_human_review_at timestamptz,

  next_human_review_at timestamptz
    not null
    default (now() + interval '1 year'),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (website_id, url)
);

create index if not exists pages_user_id_idx
on public.pages(user_id);

create index if not exists pages_website_id_idx
on public.pages(website_id);

create index if not exists pages_review_due_idx
on public.pages(next_human_review_at);

alter table public.pages enable row level security;

grant select, insert, update, delete
on public.pages
to authenticated;

drop policy if exists "Users view own pages"
on public.pages;

create policy "Users view own pages"
on public.pages
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users insert own pages"
on public.pages;

create policy "Users insert own pages"
on public.pages
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "Users update own pages"
on public.pages;

create policy "Users update own pages"
on public.pages
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users delete own pages"
on public.pages;

create policy "Users delete own pages"
on public.pages
for delete
to authenticated
using (auth.uid() = user_id);


-- Page quota.
create or replace function public.enforce_page_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  active_plan text;
  allowed_pages integer;
  current_pages bigint;
begin
  if not exists (
    select 1
    from public.websites
    where id = new.website_id
      and user_id = new.user_id
  ) then
    raise exception 'INVALID_PAGE_WEBSITE';
  end if;

  if auth.uid() is not null and new.user_id <> auth.uid() then
    raise exception 'INVALID_PAGE_OWNER';
  end if;

  active_plan := public.effective_plan_for_user(new.user_id);
  allowed_pages := public.plan_page_limit(active_plan);

  select count(*)
  into current_pages
  from public.pages
  where user_id = new.user_id;

  if current_pages >= allowed_pages then
    raise exception 'PAGE_LIMIT_REACHED';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_page_limit_trigger
on public.pages;

create trigger enforce_page_limit_trigger
before insert on public.pages
for each row
execute function public.enforce_page_limit();


-- ------------------------------------------------------------
-- HUMAN REVIEWS
-- ------------------------------------------------------------

create table if not exists public.human_reviews (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null
    references auth.users(id)
    on delete cascade,

  page_id uuid not null
    references public.pages(id)
    on delete cascade,

  status text not null default 'pending'
    check (
      status in (
        'pending',
        'in_progress',
        'completed',
        'skipped'
      )
    ),

  notes text,
  findings jsonb not null default '{}'::jsonb,

  due_at timestamptz not null,
  completed_at timestamptz,

  created_at timestamptz not null default now()
);

alter table public.human_reviews enable row level security;

grant select, insert, update, delete
on public.human_reviews
to authenticated;

drop policy if exists "Users manage own reviews"
on public.human_reviews;

create policy "Users manage own reviews"
on public.human_reviews
for all
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);


-- ------------------------------------------------------------
-- ISSUES
-- ------------------------------------------------------------

create table if not exists public.issues (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null
    references auth.users(id)
    on delete cascade,

  website_id uuid not null
    references public.websites(id)
    on delete cascade,

  page_id uuid
    references public.pages(id)
    on delete cascade,

  type text not null default 'general',

  severity text not null default 'warning'
    check (
      severity in (
        'info',
        'warning',
        'high',
        'critical'
      )
    ),

  title text not null,
  description text,

  status text not null default 'open'
    check (
      status in (
        'open',
        'in_progress',
        'resolved',
        'ignored'
      )
    ),

  detected_at timestamptz not null default now(),
  resolved_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists issues_user_id_idx
on public.issues(user_id);

create index if not exists issues_status_idx
on public.issues(status);

alter table public.issues enable row level security;

grant select, insert, update, delete
on public.issues
to authenticated;

drop policy if exists "Users manage own issues"
on public.issues;

create policy "Users manage own issues"
on public.issues
for all
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);


-- ------------------------------------------------------------
-- ALERTS
-- ------------------------------------------------------------

create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null
    references auth.users(id)
    on delete cascade,

  website_id uuid
    references public.websites(id)
    on delete cascade,

  issue_id uuid
    references public.issues(id)
    on delete cascade,

  type text not null default 'general',
  title text not null,
  message text,

  created_at timestamptz not null default now(),
  read_at timestamptz
);

alter table public.alerts enable row level security;

grant select, insert, update, delete
on public.alerts
to authenticated;

drop policy if exists "Users manage own alerts"
on public.alerts;

create policy "Users manage own alerts"
on public.alerts
for all
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);


-- ------------------------------------------------------------
-- REPORTS
-- ------------------------------------------------------------

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null
    references auth.users(id)
    on delete cascade,

  name text not null,

  period_start timestamptz,
  period_end timestamptz,

  summary jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now()
);

alter table public.reports enable row level security;

grant select, insert, delete
on public.reports
to authenticated;

drop policy if exists "Users manage own reports"
on public.reports;

create policy "Users manage own reports"
on public.reports
for all
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);


-- ------------------------------------------------------------
-- SUBSCRIPTION RLS
-- ------------------------------------------------------------

alter table public.subscriptions enable row level security;

revoke all
on public.subscriptions
from anon, authenticated;

grant select
on public.subscriptions
to authenticated;

drop policy if exists "Users can view their subscription"
on public.subscriptions;

create policy "Users can view their subscription"
on public.subscriptions
for select
to authenticated
using (auth.uid() = user_id);


-- ------------------------------------------------------------
-- VERIFY YOUR FOUNDER OVERRIDE
-- ------------------------------------------------------------

select
  u.email,
  s.plan as paddle_plan,
  s.admin_override_plan,
  s.status,
  public.effective_plan_for_user(u.id) as effective_plan
from public.subscriptions s
join auth.users u
  on u.id = s.user_id
where u.email = 'rafesykes2@gmail.com';

