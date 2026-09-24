-- Pulsely maintenance command center additions.
-- Safe to run repeatedly against the existing Supabase project.

alter table public.pages
  add column if not exists meta_description text,
  add column if not exists h1_count integer,
  add column if not exists canonical_url text,
  add column if not exists content_hash text,
  add column if not exists redirect_count integer not null default 0,
  add column if not exists response_ms integer;

alter table public.websites
  add column if not exists robots_status integer,
  add column if not exists sitemap_status integer,
  add column if not exists ssl_expires_at timestamptz,
  add column if not exists last_ssl_check_at timestamptz;

alter table public.monitoring_runs
  add column if not exists page_id uuid
    references public.pages(id)
    on delete cascade;

create index if not exists monitoring_runs_website_checked_idx
on public.monitoring_runs(website_id, checked_at desc);

create index if not exists pages_health_idx
on public.pages(health_status);

create index if not exists issues_page_status_idx
on public.issues(page_id, status);

create or replace function public.page_health_score(target_page_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  p record;
  issue_penalty integer;
  score integer := 100;
begin
  select *
  into p
  from public.pages
  where id = target_page_id;

  if p.id is null then
    return 0;
  end if;

  if coalesce(p.http_status, 200) >= 500 then
    score := score - 55;
  elsif coalesce(p.http_status, 200) >= 400 then
    score := score - 38;
  end if;

  if coalesce(p.response_ms, 0) > 3000 then
    score := score - 14;
  end if;

  if p.title is null or length(trim(p.title)) = 0 then
    score := score - 12;
  end if;

  if p.meta_description is null or length(trim(p.meta_description)) = 0 then
    score := score - 8;
  end if;

  if coalesce(p.h1_count, 1) = 0 then
    score := score - 10;
  elsif coalesce(p.h1_count, 1) > 1 then
    score := score - 4;
  end if;

  if coalesce(p.redirect_count, 0) >= 2 then
    score := score - 7;
  end if;

  select coalesce(sum(
    case severity
      when 'critical' then 28
      when 'high' then 18
      when 'warning' then 9
      else 4
    end
  ), 0)
  into issue_penalty
  from public.issues
  where page_id = target_page_id
    and status not in ('resolved', 'ignored');

  score := score - issue_penalty;

  return greatest(0, least(100, score));
end;
$$;

grant execute on function public.page_health_score(uuid) to authenticated;
