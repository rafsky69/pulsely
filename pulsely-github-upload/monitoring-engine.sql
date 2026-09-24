
-- ============================================================
-- PULSELY MONITORING ENGINE
-- ============================================================

alter table public.websites
  add column if not exists health_status text not null default 'healthy'
    check (
      health_status in (
        'healthy',
        'needs_attention',
        'action_required',
        'critical'
      )
    ),
  add column if not exists http_status integer,
  add column if not exists last_response_ms integer,
  add column if not exists last_uptime_at timestamptz,
  add column if not exists last_scan_at timestamptz,
  add column if not exists next_uptime_at timestamptz not null default now(),
  add column if not exists next_scan_at timestamptz not null default now(),
  add column if not exists scan_error text;

alter table public.pages
  add column if not exists response_ms integer;

alter table public.issues
  add column if not exists fingerprint text;

create unique index if not exists issues_user_fingerprint_key
on public.issues(user_id, fingerprint);

create index if not exists websites_next_uptime_idx
on public.websites(next_uptime_at);

create index if not exists websites_next_scan_idx
on public.websites(next_scan_at);

create index if not exists pages_last_scan_idx
on public.pages(last_scan_at);

