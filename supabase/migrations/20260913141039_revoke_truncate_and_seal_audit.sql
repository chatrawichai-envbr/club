revoke truncate, trigger, references on all tables in schema public from anon, authenticated;

do $$
declare
  r text;
begin
  foreach r in array array['postgres', 'supabase_admin'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      begin
        execute format(
          'alter default privileges for role %I in schema public '
          'revoke truncate, trigger, references on tables from anon, authenticated', r);
      exception when insufficient_privilege then
        raise notice 'ตั้งสิทธิ์ตั้งต้นสำหรับบทบาท % ไม่ได้ (ไม่มีสิทธิ์) ข้ามไป', r;
      end;
    end if;
  end loop;
end;
$$;

create or replace function app_private.block_audit_truncate()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if coalesce(current_setting('app.allow_audit_maintenance', true), '') = 'on' then
    return null;
  end if;
  raise exception
    'ตาราง audit_log เป็นบันทึกแบบเพิ่มได้เท่านั้น จึง TRUNCATE ไม่ได้ '
    'หากต้องลบตามรอบเก็บรักษาข้อมูล ให้รัน: '
    'set local app.allow_audit_maintenance = ''on''; ภายในธุรกรรมเดียวกันก่อน'
    using errcode = '42501';
end;
$$;

revoke all on function app_private.block_audit_truncate() from public, anon, authenticated;

drop trigger if exists trg_audit_log_no_truncate on public.audit_log;
create trigger trg_audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function app_private.block_audit_truncate();
