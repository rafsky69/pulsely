create table if not exists public.websites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  url text not null,
  created_at timestamptz not null default now()
);

create index if not exists websites_user_id_idx
on public.websites(user_id);

alter table public.websites enable row level security;

revoke all on table public.websites from anon;
revoke all on table public.websites from authenticated;

grant select, insert, update, delete
on table public.websites
to authenticated;

drop policy if exists "Users can view their websites"
on public.websites;

drop policy if exists "Users can add websites"
on public.websites;

drop policy if exists "Users can update their websites"
on public.websites;

drop policy if exists "Users can delete their websites"
on public.websites;

create policy "Users can view their websites"
on public.websites
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can add websites"
on public.websites
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their websites"
on public.websites
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their websites"
on public.websites
for delete
to authenticated
using ((select auth.uid()) = user_id);
