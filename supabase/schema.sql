-- Cloud sync schema for Exervo — run this in your Supabase project's SQL editor.
-- One row per (user, localStorage key); row-level security means every user can
-- only ever see and write their own rows. The whole script is idempotent — safe
-- to re-run any time (e.g. after pulling an update to this file).

create table if not exists public.user_state (
  user_id    uuid not null default auth.uid(),
  key        text not null,
  value      jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.user_state enable row level security;

drop policy if exists "users manage own state" on public.user_state;
create policy "users manage own state" on public.user_state
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- keep updated_at honest on every write (the client's pull cursor depends on it)
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists t_touch_user_state on public.user_state;
create trigger t_touch_user_state
  before insert or update on public.user_state
  for each row execute function public.touch_updated_at();

-- helpful index for the sync pull ("everything newer than my cursor")
create index if not exists idx_user_state_updated
  on public.user_state (user_id, updated_at);

-- live multi-device updates: broadcast row changes over Realtime. RLS above still
-- governs who receives what. Safe to re-run.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'user_state'
  ) then
    alter publication supabase_realtime add table public.user_state;
  end if;
end $$;
