create table if not exists public.alert_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  in_app_enabled boolean not null default true,
  severity_threshold text not null default 'info'
    check (severity_threshold in ('info', 'warning', 'critical')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.alert_preferences enable row level security;

create policy "Users read their alert preferences"
on public.alert_preferences
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users update their alert preferences"
on public.alert_preferences
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

grant select, update on public.alert_preferences to authenticated;
grant all on public.alert_preferences to service_role;

insert into public.alert_preferences (user_id)
select id
from auth.users
on conflict (user_id) do nothing;
