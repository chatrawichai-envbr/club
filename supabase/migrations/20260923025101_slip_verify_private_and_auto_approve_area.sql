-- แยกสวิตช์ยืนยันสลิปกับธนาคารออกจากค่าตั้งค่าสาธารณะ
-- และให้เจ้าหน้าที่ที่มีหน้าที่ตรวจสลิปเปิด/ปิดการออกใบสำคัญรับเงินอัตโนมัติได้เอง
-- ---------------------------------------------------------------------------
-- ปัญหาที่ 1: slip_check เป็นแถว is_public ใครก็อ่านได้โดยไม่ต้องเข้าสู่ระบบ
--   ในแถวนั้นมี bank_verify ซึ่งบอกว่าเปิดอนุมัติอัตโนมัติไว้หรือไม่ ตรวจบัญชีปลายทางหรือไม่
--   ค่าเหล่านี้ไม่มีหน้าไหนของสมาชิกใช้ จึงไม่มีเหตุให้เปิดเผย
--   ย้ายไปแถวใหม่ slip_verify ที่ is_public = false อ่านได้เฉพาะผู้ดูแล
--   (นโยบาย settings_admin_read) ฟังก์ชันในฐานข้อมูลและ Edge Function อ่านด้วยสิทธิ์ระบบ
--
--   ไม่ได้ทำแบบเดียวกันกับแถว bank เพราะหน้าชำระเงินของสมาชิกต้องใช้
--   และการสมัครใช้งานระบบเปิดให้ทุกคน การจำกัดให้เฉพาะผู้ที่เข้าสู่ระบบจึงไม่ได้กันใครจริง
--
-- ปัญหาที่ 2: เจ้าหน้าที่การเงินและเจ้าหน้าที่ทะเบียนและการเงินเป็นเจ้าของงานตรวจสลิป
--   แต่ปิดการออกใบสำคัญรับเงินอัตโนมัติเองไม่ได้ ถ้าผู้ให้บริการตรวจสลิปเพี้ยน
--   ต้องไปตามผู้ดูแลระบบมาปิดให้
--   เพิ่มพื้นที่สิทธิ์ slip_auto_approve และฟังก์ชัน admin_save_slip_verify
--   แบบเดียวกับ admin_save_signatories คือแก้ได้เฉพาะคีย์เดียว ตรวจสิทธิ์ทีละคีย์
--
--   สวิตช์ enabled (เปิด/ปิดการยืนยันกับธนาคารทั้งหมด) ยังเป็นของผู้ดูแลระบบเท่านั้น
--   เพราะการปิดทำให้ไม่มีผลจากธนาคารบันทึกไว้เป็นหลักฐาน ถ้าเจ้าหน้าที่คนเดียวกัน
--   ปิดได้แล้วกดยืนยันสลิปเองได้ ก็ลบหลักฐานที่ขัดกับการตัดสินของตัวเองได้
--   ส่วนการปิดการอนุมัติอัตโนมัติไม่มีความเสี่ยงแบบนั้น แค่งานกลับไปเป็นคนตรวจเหมือนเดิม

-- 1. แถวใหม่ ย้ายค่าเดิมมาทั้งก้อน
insert into public.settings (key, value, is_public, description)
select 'slip_verify',
       coalesce(s.value -> 'bank_verify', jsonb_build_object(
         'enabled', false, 'provider', '', 'require_account_match', true,
         'auto_reject_on_mismatch', false, 'auto_approve_on_verified', true)),
       false,
       'การยืนยันสลิปกับธนาคาร (อ่านได้เฉพาะผู้ดูแล)'
  from public.settings s where s.key = 'slip_check'
on conflict (key) do nothing;

update public.settings set value = value - 'bank_verify' where key = 'slip_check';

-- 2. กันไม่ให้ค่าหลุดกลับไปเป็นสาธารณะ ไม่ว่าจะเขียนผ่านหน้าไหน
--    หน้าตั้งค่ารุ่นเก่าที่ยังค้างอยู่ในเบราว์เซอร์หรือบน Apps Script ยังเขียน bank_verify
--    กลับเข้า slip_check และหน้าตั้งค่าส่ง is_public = true ทุกแถวที่บันทึก
--    ค่าเริ่มต้นของคอลัมน์ is_public ก็เป็น true ด้วย
create or replace function app_private.settings_guard()
 returns trigger
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.key = 'slip_check' and new.value ? 'bank_verify' then
    new.value := new.value - 'bank_verify';
  end if;
  if new.key = 'slip_verify' then
    new.is_public := false;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_settings_guard on public.settings;
create trigger trg_settings_guard
  before insert or update on public.settings
  for each row execute function app_private.settings_guard();

-- 3. พื้นที่สิทธิ์ใหม่ slip_auto_approve
create or replace function public.admin_can(p_area text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1 from public.admins a
    where a.user_id = auth.uid()
      and a.active
      and (
        -- ผู้ดูแลระดับสูงสุด เข้าได้ทุกพื้นที่
        a.role = 'superadmin'
        -- ภาพรวม เปิดให้ผู้ดูแลทุกบทบาท
        or p_area = 'dashboard'
        or (p_area = 'settings'      and a.role = 'admin')
        -- ประชาสัมพันธ์ เปิดให้ผู้ที่ทำทั้งงานทะเบียนและงานการเงินดูแลได้ด้วย
        or (p_area = 'announcements' and a.role in ('admin', 'registrar_treasurer'))
        -- ช่องลงนามในเอกสาร แยกสิทธิ์ตามหน้าที่
        --   ช่องลงนามประธานชมรม (พิมพ์บนบัตรสมาชิก) เป็นงานของนายทะเบียน
        --   ช่องผู้ลงนามในใบสำคัญรับเงิน เป็นงานของเจ้าหน้าที่การเงิน
        --   ผู้ที่ทำทั้งสองหน้าที่จึงดูแลได้ทั้งสองช่อง
        or (p_area = 'signatory_president' and a.role in ('admin', 'registrar', 'registrar_treasurer'))
        or (p_area = 'signatory_receipt'   and a.role in ('admin', 'treasurer', 'registrar_treasurer'))
        -- หน้าผู้ลงนามในเอกสาร เปิดให้ผู้ที่ดูแลได้อย่างน้อยหนึ่งช่อง
        or (p_area = 'signatories' and a.role in ('admin', 'registrar', 'treasurer', 'registrar_treasurer'))
        or (p_area = 'applications'  and a.role in ('admin', 'registrar', 'registrar_treasurer'))
        or (p_area = 'payments'      and a.role in ('admin', 'treasurer', 'registrar_treasurer'))
        -- เปิด/ปิดการออกใบสำคัญรับเงินอัตโนมัติ เป็นของผู้ที่มีหน้าที่ตรวจสลิป
        -- เพราะเป็นงานของคนกลุ่มนี้ที่สวิตช์นี้ทำแทน
        or (p_area = 'slip_auto_approve' and a.role in ('admin', 'treasurer', 'registrar_treasurer'))
        or (p_area = 'members'       and a.role in ('admin', 'registrar', 'treasurer', 'registrar_treasurer'))
        or (p_area = 'audit'         and a.role in ('admin', 'registrar', 'treasurer', 'registrar_treasurer'))
        -- admin_accounts และ slip_override ไม่มีในรายการนี้โดยเจตนา
        -- จึงเป็นจริงได้เฉพาะกับผู้ดูแลระดับสูงสุดในเงื่อนไขข้อแรก
      )
  );
$function$;

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
    'slip_auto_approve', public.admin_can('slip_auto_approve')
  );
$function$;

-- 4. บันทึกสวิตช์ ตรวจสิทธิ์ทีละคีย์
create or replace function public.admin_save_slip_verify(p jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'app_private', 'pg_temp'
as $function$
/*
 * แก้ได้สองคีย์เท่านั้น และแต่ละคีย์ต้องมีสิทธิ์ของตัวเอง
 *   auto_approve_on_verified  ต้องมีพื้นที่ slip_auto_approve
 *   enabled                   ต้องมีพื้นที่ settings
 * ค่าอื่นในแถว (require_account_match ฯลฯ) คงไว้ตามเดิมเสมอ
 *
 * รวมค่าในฐานข้อมูลด้วย jsonb_set ไม่ได้เขียนทับทั้งแถวจากค่าที่หน้าเว็บถือไว้
 * สองคนแก้คนละคีย์พร้อมกันจึงไม่ทับกัน
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

  if p ? 'enabled' and not public.admin_can('settings') then
    raise exception 'บัญชีผู้ดูแลของท่านไม่มีสิทธิ์เปิด/ปิดการยืนยันสลิปกับธนาคาร'
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

-- 5. ผู้อ่านค่า: ใช้แถวใหม่ก่อน ถ้ายังไม่มีจึงถอยไปใช้ที่เดิม
create or replace function public.record_slip_verification(p_payment_id uuid, p jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'app_private', 'pg_temp'
as $function$
declare
  v_pay    public.payments;
  v_status text := nullif(btrim(coalesce(p ->> 'status', '')), '');
  v_ref    text := nullif(btrim(coalesce(p ->> 'bank_ref', '')), '');
  v_slip   jsonb := app_private.setting('slip_check', '{}'::jsonb);
  v_cfg    jsonb := coalesce(app_private.setting('slip_verify'), v_slip -> 'bank_verify', '{}'::jsonb);
  v_auto   boolean := coalesce((v_cfg ->> 'auto_reject_on_mismatch')::boolean, false);
  v_approve boolean := coalesce((v_cfg ->> 'auto_approve_on_verified')::boolean, true);
  v_tol    numeric := coalesce((v_slip ->> 'allow_amount_tolerance')::numeric, 0);
  v_fee    numeric;
  v_res    jsonb;
  v_auto_res jsonb := null;
begin
  if v_status is null or v_status not in
     ('not_checked','disabled','verified','mismatch','not_found','error','duplicate') then
    raise exception 'สถานะผลการยืนยันไม่ถูกต้อง: %', coalesce(v_status, '(ว่าง)')
      using errcode = '22023';
  end if;

  select * into v_pay from public.payments pm where pm.id = p_payment_id;
  if v_pay.id is null then
    raise exception 'ไม่พบรายการชำระเงิน' using errcode = 'P0002';
  end if;

  -- เลขอ้างอิงจากธนาคารต้องไม่ถูกใช้กับรายการอื่นมาก่อน
  if v_ref is not null and exists (
    select 1 from public.payments pm
     where pm.bank_ref = v_ref and pm.id <> p_payment_id and pm.status <> 'rejected'
  ) then
    v_status := 'duplicate';
    v_ref := null;
  end if;

  begin
    update public.payments pm
       set bank_verify_status = v_status,
           bank_verify_result = p - 'status' - 'bank_ref',
           bank_verify_at     = now(),
           bank_ref           = coalesce(v_ref, pm.bank_ref)
     where pm.id = p_payment_id;
  exception when unique_violation then
    v_status := 'duplicate';
    v_ref := null;
    update public.payments pm
       set bank_verify_status = v_status,
           bank_verify_result = (p - 'status' - 'bank_ref')
             || jsonb_build_object('note', 'เลขอ้างอิงนี้ถูกใช้กับรายการอื่นแล้ว'),
           bank_verify_at     = now()
     where pm.id = p_payment_id;
  end;

  if v_auto and v_status in ('mismatch','not_found','duplicate') and v_pay.status = 'pending' then
    update public.payments pm
       set status = 'rejected',
           reject_reason = 'ระบบยืนยันกับธนาคารไม่ผ่าน: ' ||
             coalesce(p ->> 'reason', v_status)
     where pm.id = p_payment_id;
  end if;

  perform app_private.log_audit(
    'bank_verify_slip', 'payments', p_payment_id::text, null,
    jsonb_build_object('status', v_status, 'bank_ref', v_ref),
    left(coalesce(p ->> 'reason', ''), 500));

  /*
   * อนุมัติอัตโนมัติ
   *
   * เงื่อนไขครบทุกข้อเท่านั้นจึงจะออกใบสำคัญรับเงินให้เอง
   *   - ธนาคารยืนยันรายการโอนนี้ (verified)
   *   - เปิดใช้งานการอนุมัติอัตโนมัติไว้
   *   - รายการยังรอตรวจอยู่
   *   - ผู้เรียกยืนยันว่าได้เทียบบัญชีปลายทางกับบัญชีชมรมแล้วและตรงกัน
   *     ถ้าปิดการตรวจบัญชีปลายทางไว้ จะไม่อนุมัติอัตโนมัติ เพราะไม่มีหลักฐาน
   *     ว่าเงินเข้าบัญชีชมรมจริง ไม่ใช่บัญชีอื่น
   *   - ยอดที่ธนาคารยืนยัน และยอดที่บันทึกไว้ ตรงกับค่าธรรมเนียมของใบสมัครทั้งคู่
   *     ตรวจซ้ำจากฐานข้อมูลเอง ไม่เชื่อค่าที่ส่งเข้ามาเพียงอย่างเดียว
   *
   * ถ้าขั้นตอนนี้ล้มเหลว ต้องไม่ทำให้การบันทึกผลจากธนาคารหายไปด้วย
   * จึงรับข้อผิดพลาดไว้แล้วปล่อยให้เจ้าหน้าที่ตรวจเองตามปกติ
   */
  if v_status = 'verified'
     and v_approve
     and v_pay.status = 'pending'
     and coalesce((p ->> 'account_checked')::boolean, false)
  then
    select a.fee_amount into v_fee
      from public.applications a where a.id = v_pay.application_id;

    if coalesce(v_fee, 0) > 0
       and abs(v_pay.amount - v_fee) <= v_tol + 0.004
       and abs(coalesce((p ->> 'amount')::numeric, -1) - v_fee) <= v_tol + 0.004
    then
      begin
        v_auto_res := app_private.approve_payment(p_payment_id, null, true);
      exception when others then
        raise warning 'อนุมัติอัตโนมัติไม่สำเร็จ: %', sqlerrm;
        v_auto_res := null;
      end;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', v_status,
    'auto_approved', coalesce((v_auto_res ->> 'ok')::boolean, false),
    'receipt_no', v_auto_res ->> 'receipt_no');
end; $function$;

revoke all on function public.record_slip_verification(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_slip_verification(uuid, jsonb) to service_role;
