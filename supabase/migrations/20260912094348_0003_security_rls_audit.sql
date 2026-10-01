create or replace function public.admin_role()
returns text language sql security definer stable
set search_path = public, pg_temp
as $$
  select a.role from public.admins a
  where a.user_id = auth.uid() and a.active limit 1;
$$;

create or replace function public.is_admin()
returns boolean language sql security definer stable
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid() and a.active);
$$;

create or replace function public.has_admin_role(p_roles text[])
returns boolean language sql security definer stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.admins a
    where a.user_id = auth.uid() and a.active
      and (a.role = 'superadmin' or a.role = any (p_roles))
  );
$$;

grant execute on function public.is_admin()             to authenticated;
grant execute on function public.admin_role()           to authenticated;
grant execute on function public.has_admin_role(text[]) to authenticated;

create or replace function app_private.log_audit(
  p_action text, p_entity text, p_entity_id text,
  p_entity_label text default null, p_changed jsonb default null, p_note text default null
) returns void language plpgsql security definer
set search_path = public, app_private, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_role text;
begin
  begin
    v_email := nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'email', '');
  exception when others then
    v_email := null;
  end;

  if v_email is null and v_uid is not null then
    select p.email into v_email from public.profiles p where p.id = v_uid;
  end if;

  select a.role into v_role from public.admins a where a.user_id = v_uid and a.active;

  insert into public.audit_log
    (actor_id, actor_email, actor_role, action, entity, entity_id, entity_label, changed, note)
  values
    (v_uid, v_email, coalesce(v_role, 'member'), p_action, p_entity,
     p_entity_id, p_entity_label, p_changed, p_note);
end;
$$;

create or replace function public.audit_row_change()
returns trigger language plpgsql security definer
set search_path = public, app_private, pg_temp
as $$
declare
  v_old jsonb; v_new jsonb; v_changed jsonb;
  v_label text; v_id text; v_action text;
  v_masked text[] := array['national_id_enc','phone_enc','addr_detail_enc',
                           'national_id_bidx','phone_bidx'];
begin
  if tg_op = 'INSERT' then
    v_action := 'insert'; v_new := to_jsonb(new); v_old := '{}'::jsonb;
  elsif tg_op = 'UPDATE' then
    v_action := 'update'; v_new := to_jsonb(new); v_old := to_jsonb(old);
  else
    v_action := 'delete'; v_new := '{}'::jsonb; v_old := to_jsonb(old);
  end if;

  select jsonb_object_agg(
           k,
           case when k = any (v_masked) then jsonb_build_object('changed', true)
                else jsonb_build_object('from', v_old -> k, 'to', v_new -> k) end
         )
    into v_changed
  from (
    select key as k from jsonb_each(v_old)
    union
    select key as k from jsonb_each(v_new)
  ) keys
  where (v_old -> k) is distinct from (v_new -> k)
    and k not in ('updated_at','created_at','updated_by');

  if v_changed is null or v_changed = '{}'::jsonb then
    return coalesce(new, old);
  end if;

  v_id := coalesce(v_new ->> 'id', v_old ->> 'id');
  v_label := case tg_table_name
    when 'members' then
      btrim(coalesce(v_new ->> 'title', v_old ->> 'title', '') || ' ' ||
            coalesce(v_new ->> 'first_name', v_old ->> 'first_name', '') || ' ' ||
            coalesce(v_new ->> 'last_name', v_old ->> 'last_name', '')) ||
      coalesce(' (' || (v_new ->> 'member_code') || ')', '')
    when 'applications' then coalesce(v_new ->> 'app_no', v_old ->> 'app_no')
    when 'payments'     then 'ชำระเงิน ' || coalesce(v_new ->> 'amount', v_old ->> 'amount') || ' บาท'
    when 'cards'        then coalesce(v_new ->> 'card_no', v_old ->> 'card_no')
    when 'receipts'     then coalesce(v_new ->> 'receipt_no', v_old ->> 'receipt_no')
    when 'admins'       then coalesce(v_new ->> 'full_name', v_old ->> 'full_name')
    else null
  end;

  perform app_private.log_audit(
    v_action, tg_table_name, v_id, nullif(btrim(coalesce(v_label,'')), ''), v_changed, null);

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_audit_members on public.members;
create trigger trg_audit_members after insert or update or delete on public.members
  for each row execute function public.audit_row_change();
drop trigger if exists trg_audit_applications on public.applications;
create trigger trg_audit_applications after insert or update or delete on public.applications
  for each row execute function public.audit_row_change();
drop trigger if exists trg_audit_payments on public.payments;
create trigger trg_audit_payments after insert or update or delete on public.payments
  for each row execute function public.audit_row_change();
drop trigger if exists trg_audit_cards on public.cards;
create trigger trg_audit_cards after insert or update or delete on public.cards
  for each row execute function public.audit_row_change();
drop trigger if exists trg_audit_receipts on public.receipts;
create trigger trg_audit_receipts after insert or update or delete on public.receipts
  for each row execute function public.audit_row_change();
drop trigger if exists trg_audit_admins on public.admins;
create trigger trg_audit_admins after insert or update or delete on public.admins
  for each row execute function public.audit_row_change();

alter table public.profiles     enable row level security;
alter table public.admins       enable row level security;
alter table public.org_types    enable row level security;
alter table public.settings     enable row level security;
alter table public.members      enable row level security;
alter table public.applications enable row level security;
alter table public.payments     enable row level security;
alter table public.receipts     enable row level security;
alter table public.cards        enable row level security;
alter table public.consents     enable row level security;
alter table public.audit_log    enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles for insert to authenticated
  with check (id = auth.uid());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

drop policy if exists admins_select on public.admins;
create policy admins_select on public.admins for select to authenticated
  using (public.is_admin());
drop policy if exists admins_write on public.admins;
create policy admins_write on public.admins for all to authenticated
  using (public.admin_role() = 'superadmin')
  with check (public.admin_role() = 'superadmin');

drop policy if exists org_types_select on public.org_types;
create policy org_types_select on public.org_types for select to anon, authenticated
  using (active);
drop policy if exists org_types_write on public.org_types;
create policy org_types_write on public.org_types for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists settings_select on public.settings;
create policy settings_select on public.settings for select to anon, authenticated
  using (is_public or public.is_admin());
drop policy if exists settings_write on public.settings;
create policy settings_write on public.settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists members_select on public.members;
create policy members_select on public.members for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists applications_select on public.applications;
create policy applications_select on public.applications for select to authenticated
  using (
    public.is_admin()
    or exists (select 1 from public.members m where m.id = applications.member_id and m.user_id = auth.uid())
  );

drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments for select to authenticated
  using (
    public.is_admin()
    or exists (select 1 from public.members m where m.id = payments.member_id and m.user_id = auth.uid())
  );

drop policy if exists receipts_select on public.receipts;
create policy receipts_select on public.receipts for select to authenticated
  using (
    public.is_admin()
    or exists (select 1 from public.members m where m.id = receipts.member_id and m.user_id = auth.uid())
  );

drop policy if exists cards_select on public.cards;
create policy cards_select on public.cards for select to authenticated
  using (
    public.is_admin()
    or exists (select 1 from public.members m where m.id = cards.member_id and m.user_id = auth.uid())
  );

drop policy if exists consents_select on public.consents;
create policy consents_select on public.consents for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
drop policy if exists consents_insert on public.consents;
create policy consents_insert on public.consents for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log for select to authenticated
  using (public.is_admin());

revoke insert, update, delete on public.members      from anon, authenticated;
revoke insert, update, delete on public.applications from anon, authenticated;
revoke insert, update, delete on public.payments     from anon, authenticated;
revoke insert, update, delete on public.receipts     from anon, authenticated;
revoke insert, update, delete on public.cards        from anon, authenticated;
revoke insert, update, delete on public.audit_log    from anon, authenticated;
revoke all on app_private.counters from anon, authenticated;

grant select on public.members, public.applications, public.payments,
                public.receipts, public.cards, public.audit_log to authenticated;
grant select on public.org_types, public.settings to anon, authenticated;
