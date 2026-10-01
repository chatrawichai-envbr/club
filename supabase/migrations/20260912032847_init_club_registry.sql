create schema if not exists app;
revoke all on schema app from anon, authenticated;
grant usage on schema app to authenticated;

create table app.grants (
  uid        uuid primary key references auth.users (id) on delete cascade,
  level      text not null check (level in ('staff', 'owner')),
  note       text not null default '',
  created_at timestamptz not null default now()
);
alter table app.grants enable row level security;

create or replace function app.level()
returns text language sql stable security definer
set search_path = app, pg_catalog
as $$
  select coalesce((select g.level from app.grants g where g.uid = auth.uid()), 'none');
$$;

create or replace function app.is_staff() returns boolean
language sql stable set search_path = app, pg_catalog
as $$ select app.level() in ('staff', 'owner'); $$;

create or replace function app.is_owner() returns boolean
language sql stable set search_path = app, pg_catalog
as $$ select app.level() = 'owner'; $$;

grant execute on function app.level(), app.is_staff(), app.is_owner() to authenticated;

create or replace function app.touch_updated_at()
returns trigger language plpgsql set search_path = pg_catalog
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create table public.meta (
  id         text primary key,
  doc        jsonb not null,
  updated_at timestamptz not null default now()
);
create trigger meta_touch before update on public.meta
  for each row execute function app.touch_updated_at();

create table public.admins (
  username   text primary key,
  doc        jsonb not null,
  updated_at timestamptz not null default now()
);
create trigger admins_touch before update on public.admins
  for each row execute function app.touch_updated_at();

create table public.counters (
  id         text primary key,
  value      bigint not null default 0,
  updated_at timestamptz not null default now()
);
create trigger counters_touch before update on public.counters
  for each row execute function app.touch_updated_at();

create table public.members (
  id          text primary key,
  doc         jsonb not null,
  code        text generated always as (doc ->> 'code') stored,
  blind_index text generated always as (doc ->> 'blindIndex') stored,
  created_at  text generated always as (doc ->> 'createdAt') stored,
  updated_at  timestamptz not null default now()
);
create trigger members_touch before update on public.members
  for each row execute function app.touch_updated_at();

create unique index members_code_key on public.members (code)
  where code is not null and code <> '';
create index members_blind_index_idx on public.members (blind_index)
  where blind_index is not null and blind_index <> '';
create index members_created_at_idx on public.members (created_at desc);
create index members_doc_idx on public.members using gin (doc jsonb_path_ops);
create index members_updated_at_idx on public.members (updated_at desc);

create table public.audit (
  id  text primary key,
  doc jsonb not null,
  ts  text generated always as (doc ->> 'ts') stored
);
create index audit_ts_idx on public.audit (ts desc);

create table public.verify (
  id         text primary key,
  doc        jsonb not null,
  updated_at timestamptz not null default now()
);
create trigger verify_touch before update on public.verify
  for each row execute function app.touch_updated_at();

create or replace function public.next_sequence(p_key text)
returns bigint language plpgsql security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_next bigint;
begin
  if not app.is_staff() then
    raise exception 'ไม่มีสิทธิ์ออกเลขลำดับ' using errcode = '42501';
  end if;
  insert into public.counters as c (id, value)
       values (p_key, 1)
  on conflict (id) do update set value = c.value + 1
  returning c.value into v_next;
  return v_next;
end;
$$;
revoke all on function public.next_sequence(text) from public, anon;
grant execute on function public.next_sequence(text) to authenticated;

alter table public.meta     enable row level security;
alter table public.admins   enable row level security;
alter table public.counters enable row level security;
alter table public.members  enable row level security;
alter table public.audit    enable row level security;
alter table public.verify   enable row level security;

create policy meta_read   on public.meta for select using (app.is_staff());
create policy meta_write  on public.meta for insert with check (app.is_staff());
create policy meta_update on public.meta for update using (app.is_staff()) with check (app.is_staff());
create policy meta_delete on public.meta for delete using (app.is_owner());

create policy admins_read   on public.admins for select using (app.is_staff());
create policy admins_write  on public.admins for insert with check (app.is_staff());
create policy admins_update on public.admins for update using (app.is_staff()) with check (app.is_staff());
create policy admins_delete on public.admins for delete using (app.is_owner());

create policy counters_read on public.counters for select using (app.is_staff());

create policy members_read   on public.members for select using (app.is_staff());
create policy members_write  on public.members for insert with check (app.is_staff());
create policy members_update on public.members for update using (app.is_staff()) with check (app.is_staff());
create policy members_delete on public.members for delete using (app.is_owner());

create policy audit_read  on public.audit for select using (app.is_staff());
create policy audit_write on public.audit for insert with check (app.is_staff());

create policy verify_public_read on public.verify for select to anon, authenticated using (true);
create policy verify_write  on public.verify for insert with check (app.is_staff());
create policy verify_update on public.verify for update using (app.is_staff()) with check (app.is_staff());
create policy verify_delete on public.verify for delete using (app.is_staff());

revoke all on all tables in schema public from anon, authenticated;

grant select on public.verify to anon;

grant select, insert, update on public.meta     to authenticated;
grant select, insert, update on public.admins   to authenticated;
grant select                 on public.counters to authenticated;
grant select, insert, update on public.members  to authenticated;
grant select, insert         on public.audit    to authenticated;
grant select, insert, update on public.verify   to authenticated;

grant delete on public.meta    to authenticated;
grant delete on public.admins  to authenticated;
grant delete on public.members to authenticated;
grant delete on public.verify  to authenticated;
