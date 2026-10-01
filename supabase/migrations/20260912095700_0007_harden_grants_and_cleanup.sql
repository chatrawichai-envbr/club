-- ===== 1) ลบของเหลือจากระบบต้นแบบเดิม =====
-- reset_system() เดิมเรียกได้โดยผู้ใช้ที่ล็อกอินทุกคน ซึ่งเป็นความเสี่ยงสูง
drop function if exists public.reset_system() cascade;
drop function if exists public.next_sequence(text) cascade;
drop schema if exists app cascade;

-- ===== 2) ปิดสิทธิ์ EXECUTE ที่ PostgreSQL ให้ PUBLIC โดยปริยาย =====
-- ฟังก์ชัน SECURITY DEFINER ต้องไม่ถูกเรียกจากผู้ที่ไม่ได้ล็อกอิน
-- (ยกเว้น verify_card ที่ต้องเปิดให้ตรวจบัตรจาก QR ได้)
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
  loop
    execute format('revoke all on function %s from public', r.sig);
    execute format('revoke all on function %s from anon', r.sig);

    if r.proname = 'verify_card' then
      execute format('grant execute on function %s to anon, authenticated', r.sig);
    elsif r.proname in ('handle_new_user', 'audit_row_change', 'touch_updated_at') then
      -- ฟังก์ชันทริกเกอร์: ไม่ต้องให้ใครเรียกโดยตรง
      execute format('revoke all on function %s from authenticated', r.sig);
    else
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
  end loop;
end;
$$;

-- ฟังก์ชันในสคีมาภายในต้องไม่ถูกเรียกจาก API เลย
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
end;
$$;

-- ===== 3) กำหนด search_path ให้ครบทุกฟังก์ชัน (กัน search_path hijacking) =====
alter function app_private.be_year()                   set search_path = pg_catalog, pg_temp;
alter function app_private.is_valid_thai_id(text)      set search_path = pg_catalog, pg_temp;
alter function app_private.thai_read_int(bigint)       set search_path = app_private, pg_catalog, pg_temp;
alter function app_private.baht_text(numeric)          set search_path = app_private, pg_catalog, pg_temp;
alter function public.touch_updated_at()               set search_path = pg_catalog, pg_temp;

-- ===== 4) ไม่ให้สร้างวัตถุใหม่ในสคีมา public โดยผู้ใช้ทั่วไป =====
revoke create on schema public from anon, authenticated;
