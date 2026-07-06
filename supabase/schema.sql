-- Cloud sync schema for My PT — run this once in your Supabase project's SQL editor.
-- One row per (user, localStorage key); row-level security means every user can
-- only ever see and write their own rows.

create table if not exists public.user_state (
  user_id    uuid not null default auth.uid(),
  key        text not null,
  value      jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.user_state enable row level security;

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
