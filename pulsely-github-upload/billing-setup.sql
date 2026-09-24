
create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,

  plan text not null default 'free'
    check (
      plan in (
        'free',
        'developer',
        'webmaster',
        'freelancer',
        'professional',
        'studio',
        'agency',
        'enterprise'
      )
    ),

  status text not null default 'free',

  paddle_customer_id text,
  paddle_subscription_id text unique,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.subscriptions
enable row level security;

revoke all on table public.subscriptions
from anon, authenticated;

grant select
on table public.subscriptions
to authenticated;

drop policy if exists "Users can view their subscription"
on public.subscriptions;

create policy "Users can view their subscription"
on public.subscriptions
for select
to authenticated
using ((select auth.uid()) = user_id);

