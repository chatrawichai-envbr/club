-- สวิตช์เปิด/ปิดการยืนยันสลิปกับธนาคารทั้งหมด เป็นของผู้ดูแลระดับสูงสุดเท่านั้น
-- ---------------------------------------------------------------------------
-- เดิมผู้ดูแลระบบ (admin) ปิดได้ผ่านพื้นที่ settings
-- การปิดทำให้ไม่มีผลจากธนาคารบันทึกไว้เป็นหลักฐานของสลิปใบต่อ ๆ ไป
-- จึงยกขึ้นไปเป็นอำนาจเฉพาะของผู้ดูแลระดับสูงสุด แบบเดียวกับ admin_accounts และ slip_override
--
-- พื้นที่ bank_verify_switch ไม่มีอยู่ในรายการของ admin_can โดยเจตนา
-- จึงเป็นจริงได้เฉพาะเงื่อนไขข้อแรก a.role = 'superadmin' ไม่ต้องแก้ admin_can
--
-- ปิดทางลัดด้วย: นโยบาย settings_write เปิดให้ผู้มีพื้นที่ settings เขียนตาราง settings ได้ทั้งแถว
-- ถ้ากันไว้แค่ในฟังก์ชัน ผู้ดูแลระบบยังเขียนแถว slip_verify ตรง ๆ ผ่าน REST API ได้
-- ทริกเกอร์ settings_guard จึงตรวจซ้ำที่ตัวแถว ไม่ว่าจะเขียนมาทางไหน
--   - ผู้ดูแลระดับสูงสุด แก้ได้ทุกค่า
--   - ผู้มีพื้นที่ slip_auto_approve แก้ได้เฉพาะ auto_approve_on_verified
--   - ค่าอื่นในแถว (require_account_match, auto_reject_on_mismatch ฯลฯ) เป็นเกณฑ์ของ
--     การตรวจกับธนาคารเช่นกัน จึงเป็นของผู้ดูแลระดับสูงสุดด้วย
--   - ลบแถวได้เฉพาะผู้ดูแลระดับสูงสุด
--   - คำสั่งจากระบบที่ไม่มีผู้ใช้ (migration, service_role) ไม่ถูกตรวจ

create or replace function app_private.settings_guard()
 returns trigger
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_old jsonb;
begin
  if tg_op = 'DELETE' then
    if old.key = 'slip_verify' and auth.uid() is not null
       and not public.admin_can('bank_verify_switch') then
      raise exception 'ลบค่าตั้งค่าการยืนยันสลิปกับธนาคารได้เฉพาะผู้ดูแลระดับสูงสุด'
        using errcode = '42501';
    end if;
    return old;
  end if;

  if new.key = 'slip_check' and new.value ? 'bank_verify' then
    new.value := new.value - 'bank_verify';
  end if;

  if new.key = 'slip_verify' then
    new.is_public := false;

    if auth.uid() is not null and not public.admin_can('bank_verify_switch') then
      v_old := case when tg_op = 'UPDATE' and old.key = 'slip_verify'
                    then old.value else '{}'::jsonb end;

      if (new.value - 'auto_approve_on_verified') is distinct from
         (v_old - 'auto_approve_on_verified') then
        raise exception 'เปลี่ยนเกณฑ์การยืนยันสลิปกับธนาคารได้เฉพาะผู้ดูแลระดับสูงสุด'
          using errcode = '42501';
      end if;

      if (new.value -> 'auto_approve_on_verified') is distinct from
         (v_old -> 'auto_approve_on_verified')
         and not public.admin_can('slip_auto_approve') then
        raise exception 'บัญชีผู้ดูแลของท่านไม่มีสิทธิ์เปิด/ปิดการออกใบสำคัญรับเงินอัตโนมัติ'
          using errcode = '42501';
      end if;
    end if;
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_settings_guard on public.settings;
create trigger trg_settings_guard
  before insert or update or delete on public.settings
  for each row execute function app_private.settings_guard();

create or replace function public.admin_menu()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object(
    'role',           public.admin_role(),
    'dashboard',      public.admin_can('dashboard'),
    'applications',   public.admin_can('applications'),
    'payments',       public.admin_can('payments'),
    'members',        public.admin_can('members'),
    'audit',          public.admin_can('audit'),
    'announcements',  public.admin_can('announcements'),
    'signatories',         public.admin_can('signatories'),
    'signatory_president', public.admin_can('signatory_president'),
    'signatory_receipt',   public.admin_can('signatory_receipt'),
    'settings',       public.admin_can('settings'),
    'admin_accounts', public.admin_can('admin_accounts'),
    'slip_override',  public.admin_can('slip_override'),
    'slip_auto_approve',  public.admin_can('slip_auto_approve'),
    'bank_verify_switch', public.admin_can('bank_verify_switch')
  );
$function$;

create or replace function public.admin_save_slip_verify(p jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'app_private', 'pg_temp'
as $function$
/*
 * แก้ได้สองคีย์เท่านั้น และแต่ละคีย์ต้องมีสิทธิ์ของตัวเอง
 *   auto_approve_on_verified  ต้องมีพื้นที่ slip_auto_approve
 *   enabled                   ต้องมีพื้นที่ bank_verify_switch (ผู้ดูแลระดับสูงสุดเท่านั้น)
 * ค่าอื่นในแถว (require_account_match ฯลฯ) คงไว้ตามเดิมเสมอ
 *
 * รวมค่าในฐานข้อมูลด้วย jsonb_set ไม่ได้เขียนทับทั้งแถวจากค่าที่หน้าเว็บถือไว้
 * สองคนแก้คนละคีย์พร้อมกันจึงไม่ทับกัน
 * ทริกเกอร์ settings_guard ตรวจสิทธิ์ชุดเดียวกันซ้ำที่ตัวแถวอีกชั้น
 */
declare
  v_cur jsonb;
  v_new jsonb;
  v_chg jsonb;
  v_key text;
begin
  perform app_private.require_area('slip_auto_approve');

  if p is null or jsonb_typeof(p) <> 'object' or p = '{}'::jsonb then
    raise exception 'ข้อมูลที่ส่งมาไม่ถูกต้อง' using errcode = '22023';
  end if;

  for v_key in select jsonb_object_keys(p) loop
    if v_key not in ('auto_approve_on_verified', 'enabled') then
      raise exception 'แก้ค่า % ผ่านช่องทางนี้ไม่ได้', v_key using errcode = '22023';
    end if;
    if jsonb_typeof(p -> v_key) <> 'boolean' then
      raise exception 'ค่า % ต้องเป็นจริงหรือเท็จ', v_key using errcode = '22023';
    end if;
  end loop;

  if p ? 'enabled' and not public.admin_can('bank_verify_switch') then
    raise exception 'เปิด/ปิดการยืนยันสลิปกับธนาคารได้เฉพาะผู้ดูแลระดับสูงสุด'
      using errcode = '42501';
  end if;

  select s.value into v_cur from public.settings s where s.key = 'slip_verify' for update;
  if v_cur is null then
    raise exception 'ไม่พบค่าตั้งค่าการยืนยันสลิปกับธนาคาร' using errcode = 'P0002';
  end if;

  v_new := v_cur;
  for v_key in select jsonb_object_keys(p) loop
    v_new := jsonb_set(v_new, array[v_key], p -> v_key);
  end loop;

  if v_new = v_cur then
    return v_new;
  end if;

  select jsonb_object_agg(k, jsonb_build_object('เดิม', v_cur -> k, 'ใหม่', v_new -> k))
    into v_chg
    from jsonb_object_keys(v_new) k
   where v_cur -> k is distinct from v_new -> k;

  update public.settings
     set value = v_new, updated_at = now(), updated_by = auth.uid()
   where key = 'slip_verify';

  perform app_private.log_audit(
    'settings_change', 'settings', 'slip_verify', 'การยืนยันสลิปกับธนาคาร',
    v_chg,
    case
      when v_new -> 'auto_approve_on_verified' is distinct from v_cur -> 'auto_approve_on_verified'
        then case when (v_new ->> 'auto_approve_on_verified')::boolean
                  then 'เปิดการออกใบสำคัญรับเงินอัตโนมัติ'
                  else 'ปิดการออกใบสำคัญรับเงินอัตโนมัติ' end
      else case when (v_new ->> 'enabled')::boolean
                then 'เปิดการยืนยันสลิปกับธนาคาร'
                else 'ปิดการยืนยันสลิปกับธนาคาร' end
    end);

  return v_new;
end;
$function$;

revoke all on function public.admin_save_slip_verify(jsonb) from public, anon;
grant execute on function public.admin_save_slip_verify(jsonb) to authenticated;
