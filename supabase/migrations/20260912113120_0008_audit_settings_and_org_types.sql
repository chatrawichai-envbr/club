-- บันทึกประวัติการแก้ไขค่าตั้งค่าระบบและประเภทหน่วยงานด้วย
-- (audit_row_change ใช้คอลัมน์ id เป็นตัวระบุ ตารางสองตารางนี้ใช้ key/code
--  จึงต้องมีทริกเกอร์เฉพาะเพื่อเก็บชื่อคีย์ให้อ่านเข้าใจได้)
create or replace function public.audit_keyed_change()
returns trigger language plpgsql security definer
set search_path = public, app_private, pg_temp
as $$
declare
  v_old jsonb; v_new jsonb; v_changed jsonb;
  v_key text; v_action text;
begin
  if tg_op = 'INSERT' then
    v_action := 'insert'; v_new := to_jsonb(new); v_old := '{}'::jsonb;
  elsif tg_op = 'UPDATE' then
    v_action := 'update'; v_new := to_jsonb(new); v_old := to_jsonb(old);
  else
    v_action := 'delete'; v_new := '{}'::jsonb; v_old := to_jsonb(old);
  end if;

  v_key := coalesce(v_new ->> 'key', v_old ->> 'key', v_new ->> 'code', v_old ->> 'code');

  select jsonb_object_agg(k, jsonb_build_object('from', v_old -> k, 'to', v_new -> k))
    into v_changed
  from (
    select key as k from jsonb_each(v_old)
    union
    select key as k from jsonb_each(v_new)
  ) keys
  where (v_old -> k) is distinct from (v_new -> k)
    and k not in ('updated_at', 'updated_by');

  if v_changed is null or v_changed = '{}'::jsonb then
    return coalesce(new, old);
  end if;

  perform app_private.log_audit(v_action, tg_table_name, v_key, v_key, v_changed, null);
  return coalesce(new, old);
end;
$$;

revoke all on function public.audit_keyed_change() from public, anon, authenticated;

drop trigger if exists trg_audit_settings on public.settings;
create trigger trg_audit_settings
  after insert or update or delete on public.settings
  for each row execute function public.audit_keyed_change();

drop trigger if exists trg_audit_org_types on public.org_types;
create trigger trg_audit_org_types
  after insert or update or delete on public.org_types
  for each row execute function public.audit_keyed_change();
