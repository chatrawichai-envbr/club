create or replace function app_private.slip_server_check(
  p_uid        uuid,
  p_fee        numeric,
  p_amount     numeric,
  p_paid_at    timestamptz,
  p_slip_path  text,
  p_slip_sha256 text,
  p_ref        text
) returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public', 'app_private', 'storage', 'pg_temp'
as $function$
declare
  v_cfg       jsonb := app_private.setting('slip_check', '{}'::jsonb);
  v_max_age   int   := coalesce((v_cfg ->> 'max_age_days')::int, 30);
  v_tol       numeric := coalesce((v_cfg ->> 'allow_amount_tolerance')::numeric, 0);
  v_obj       storage.objects;
  v_mime      text;
  v_size      bigint;
  v_allowed   text[];
  v_limit     bigint;
  v_checks    jsonb := '[]'::jsonb;
  v_blockers  text[] := '{}';
  v_total     int := 0;
  v_earned    int := 0;
  v_age_days  numeric;
begin
  select b.allowed_mime_types, b.file_size_limit
    into v_allowed, v_limit
    from storage.buckets b where b.id = 'payment-slips';

  select * into v_obj
    from storage.objects o
   where o.bucket_id = 'payment-slips' and o.name = p_slip_path;

  v_mime := v_obj.metadata ->> 'mimetype';
  v_size := (v_obj.metadata ->> 'size')::bigint;

  -- 1. ไฟล์สลิปมีอยู่จริงในที่เก็บไฟล์
  if v_obj.name is not null then
    v_checks := v_checks || jsonb_build_object('key','slip_exists',
      'label','พบไฟล์สลิปในที่เก็บไฟล์ของระบบ','pass',true,'weight',20);
    v_total := v_total + 20; v_earned := v_earned + 20;
  else
    v_checks := v_checks || jsonb_build_object('key','slip_exists',
      'label','ไม่พบไฟล์สลิปตามเส้นทางที่ส่งมา','pass',false,'weight',20);
    v_total := v_total + 20;
    v_blockers := array_append(v_blockers, 'slip_exists'::text);
  end if;

  -- 2. สลิปอยู่ในโฟลเดอร์ของผู้ที่เข้าสู่ระบบ
  if p_slip_path is not null and split_part(p_slip_path, '/', 1) = p_uid::text then
    v_checks := v_checks || jsonb_build_object('key','slip_owner',
      'label','ไฟล์สลิปอยู่ในโฟลเดอร์ของผู้ส่ง','pass',true,'weight',20);
    v_total := v_total + 20; v_earned := v_earned + 20;
  else
    v_checks := v_checks || jsonb_build_object('key','slip_owner',
      'label','ไฟล์สลิปไม่ได้อยู่ในโฟลเดอร์ของผู้ส่ง','pass',false,'weight',20);
    v_total := v_total + 20;
    v_blockers := array_append(v_blockers, 'slip_owner'::text);
  end if;

  -- 3. ชนิดไฟล์ (อ่านจากไฟล์ที่อัปโหลดจริง ไม่ใช่ค่าที่เบราว์เซอร์แจ้ง)
  if v_obj.name is null then
    v_checks := v_checks || jsonb_build_object('key','file_type',
      'label','ไม่มีไฟล์ให้ตรวจชนิด','pass',null,'weight',10);
  elsif v_allowed is null or v_mime = any (v_allowed) then
    v_checks := v_checks || jsonb_build_object('key','file_type',
      'label','ชนิดไฟล์ถูกต้อง (' || coalesce(v_mime,'ไม่ทราบ') || ')','pass',true,'weight',10);
    v_total := v_total + 10; v_earned := v_earned + 10;
  else
    v_checks := v_checks || jsonb_build_object('key','file_type',
      'label','ชนิดไฟล์ไม่รองรับ (' || coalesce(v_mime,'ไม่ทราบ') || ')','pass',false,'weight',10);
    v_total := v_total + 10;
    v_blockers := array_append(v_blockers, 'file_type'::text);
  end if;

  -- 4. ขนาดไฟล์
  if v_obj.name is null then
    v_checks := v_checks || jsonb_build_object('key','file_size',
      'label','ไม่มีไฟล์ให้ตรวจขนาด','pass',null,'weight',10);
  elsif v_size > 2048 and (v_limit is null or v_size <= v_limit) then
    v_checks := v_checks || jsonb_build_object('key','file_size',
      'label','ขนาดไฟล์เหมาะสม (' || round(v_size / 1024.0)::text || ' KB)','pass',true,'weight',10);
    v_total := v_total + 10; v_earned := v_earned + 10;
  else
    v_checks := v_checks || jsonb_build_object('key','file_size',
      'label','ขนาดไฟล์ไม่เหมาะสม (' || round(coalesce(v_size,0) / 1024.0)::text || ' KB)',
      'pass',false,'weight',10);
    v_total := v_total + 10;
    v_blockers := array_append(v_blockers, 'file_size'::text);
  end if;

  -- 5. จำนวนเงินตรงกับค่าธรรมเนียมของใบสมัคร (เผื่อผิดพลาดตามค่าที่ตั้งไว้)
  if p_fee > 0 and abs(coalesce(p_amount,0) - p_fee) <= v_tol + 0.004 then
    v_checks := v_checks || jsonb_build_object('key','amount_match',
      'label','จำนวนเงินตรงกับค่าธรรมเนียม (' || to_char(p_amount,'FM999999990.00') || ' บาท)',
      'pass',true,'weight',20);
    v_total := v_total + 20; v_earned := v_earned + 20;
  else
    v_checks := v_checks || jsonb_build_object('key','amount_match',
      'label','จำนวนเงินไม่ตรงกับค่าธรรมเนียม (ส่งมา '
        || to_char(coalesce(p_amount,0),'FM999999990.00') || ' บาท ต้องชำระ '
        || to_char(p_fee,'FM999999990.00') || ' บาท)','pass',false,'weight',20);
    v_total := v_total + 20;
    v_blockers := array_append(v_blockers, 'amount_match'::text);
  end if;

  -- 6. วัน-เวลาที่โอน ต้องไม่เป็นอนาคตและไม่เก่าเกินเกณฑ์
  if p_paid_at is null then
    v_checks := v_checks || jsonb_build_object('key','date_valid',
      'label','ไม่ได้ระบุวัน-เวลาที่โอน','pass',false,'weight',15);
    v_total := v_total + 15;
    v_blockers := array_append(v_blockers, 'date_valid'::text);
  else
    v_age_days := extract(epoch from (now() - p_paid_at)) / 86400.0;
    if p_paid_at > now() + interval '5 minutes' then
      v_checks := v_checks || jsonb_build_object('key','date_valid',
        'label','วัน-เวลาที่โอนเป็นเวลาในอนาคต','pass',false,'weight',15);
      v_total := v_total + 15;
      v_blockers := array_append(v_blockers, 'date_valid'::text);
    elsif v_age_days > v_max_age then
      v_checks := v_checks || jsonb_build_object('key','date_valid',
        'label','สลิปเก่าเกิน ' || v_max_age::text || ' วัน (' || floor(v_age_days)::text || ' วัน)',
        'pass',false,'weight',15);
      v_total := v_total + 15;
      v_blockers := array_append(v_blockers, 'date_valid'::text);
    else
      v_checks := v_checks || jsonb_build_object('key','date_valid',
        'label','วัน-เวลาที่โอนอยู่ในช่วงที่ยอมรับได้','pass',true,'weight',15);
      v_total := v_total + 15; v_earned := v_earned + 15;
    end if;
  end if;

  -- 7. ลายนิ้วมือไฟล์ต้องเป็น SHA-256 จริง
  if p_slip_sha256 ~ '^[0-9a-f]{64}$' then
    v_checks := v_checks || jsonb_build_object('key','hash_format',
      'label','ลายนิ้วมือไฟล์อยู่ในรูปแบบ SHA-256','pass',true,'weight',5);
    v_total := v_total + 5; v_earned := v_earned + 5;
  else
    v_checks := v_checks || jsonb_build_object('key','hash_format',
      'label','ลายนิ้วมือไฟล์ไม่อยู่ในรูปแบบ SHA-256','pass',false,'weight',5);
    v_total := v_total + 5;
    v_blockers := array_append(v_blockers, 'hash_format'::text);
  end if;

  -- 8. เลขอ้างอิงรายการ (ไม่ใช่ข้อบังคับ)
  if nullif(btrim(coalesce(p_ref,'')), '') is not null then
    v_checks := v_checks || jsonb_build_object('key','ref_present',
      'label','มีเลขอ้างอิงรายการ','pass',true,'weight',5);
    v_total := v_total + 5; v_earned := v_earned + 5;
  else
    v_checks := v_checks || jsonb_build_object('key','ref_present',
      'label','ไม่มีเลขอ้างอิงรายการ','pass',false,'weight',5);
    v_total := v_total + 5;
  end if;

  return jsonb_build_object(
    'score', case when v_total > 0 then round((v_earned::numeric / v_total) * 100)::int else 0 end,
    'checks', v_checks,
    'blockers', to_jsonb(v_blockers),
    'file', jsonb_build_object('mimetype', v_mime, 'size', v_size),
    'checked_at', now()
  );
end;
$function$;

create or replace function public.submit_payment(p jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'app_private', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_app public.applications; v_m public.members;
  v_hash text := nullif(btrim(coalesce(p ->> 'slip_sha256', '')), '');
  v_ref text := nullif(btrim(coalesce(p ->> 'ref_no', '')), '');
  v_path text := nullif(btrim(coalesce(p ->> 'slip_path', '')), '');
  v_amount numeric := coalesce((p ->> 'amount')::numeric, 0);
  v_paid_at timestamptz := nullif(p ->> 'paid_at', '')::timestamptz;
  v_score int := nullif(p ->> 'check_score', '')::int;
  v_cfg jsonb := app_private.setting('slip_check', '{}'::jsonb);
  v_enforce boolean := coalesce((v_cfg ->> 'enforce_server')::boolean, true);
  v_srv jsonb;
  v_blockers text[];
  v_pay public.payments;
begin
  if v_uid is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน' using errcode = '28000';
  end if;
  select * into v_m from public.members m where m.user_id = v_uid;
  if v_m.id is null then
    raise exception 'ไม่พบข้อมูลผู้สมัคร' using errcode = 'P0002';
  end if;

  select * into v_app from public.applications a
   where a.id = (p ->> 'application_id')::uuid and a.member_id = v_m.id;
  if v_app.id is null then
    raise exception 'ไม่พบใบสมัครนี้' using errcode = 'P0002';
  end if;
  if v_app.status not in ('awaiting_payment', 'payment_submitted') then
    raise exception 'ใบสมัครนี้ไม่อยู่ในขั้นตอนชำระเงิน (สถานะปัจจุบัน: %)', v_app.status
      using errcode = '55000';
  end if;

  -- สลิปต้องอยู่ในโฟลเดอร์ของผู้ใช้ที่เข้าสู่ระบบเท่านั้น
  -- ตรวจซ้ำตรงนี้ด้วยเพื่อให้ข้อความผิดพลาดชัดเจน แม้ slip_server_check จะตรวจอีกชั้น
  if v_path is not null and split_part(v_path, '/', 1) <> v_uid::text then
    raise exception 'เส้นทางไฟล์สลิปไม่ตรงกับผู้ใช้ที่เข้าสู่ระบบ' using errcode = '42501';
  end if;

  if v_amount <= 0 then
    raise exception 'จำนวนเงินต้องมากกว่าศูนย์' using errcode = '22023';
  end if;

  -- ตรวจสลิปฝั่งเซิร์ฟเวอร์ ไม่เชื่อผลที่ส่งมาจากเครื่องผู้ใช้
  v_srv := app_private.slip_server_check(
    v_uid, v_app.fee_amount, v_amount, v_paid_at, v_path, v_hash, v_ref);

  select array_agg(value::text) into v_blockers
    from jsonb_array_elements_text(v_srv -> 'blockers') as t(value);

  if v_enforce and coalesce(array_length(v_blockers, 1), 0) > 0 then
    raise exception 'สลิปไม่ผ่านการตรวจสอบของระบบ: %',
      (select string_agg(c ->> 'label', ' · ')
         from jsonb_array_elements(v_srv -> 'checks') as c
        where (c ->> 'pass') = 'false'
          and (c ->> 'key') = any (v_blockers))
      using errcode = '22023';
  end if;

  if v_hash is not null and exists (
    select 1 from public.payments pm where pm.slip_sha256 = v_hash and pm.status <> 'rejected') then
    raise exception 'สลิปนี้ถูกใช้ยืนยันการชำระเงินไปแล้ว กรุณาแนบสลิปการโอนของท่านเอง'
      using errcode = '23505';
  end if;
  if v_ref is not null and exists (
    select 1 from public.payments pm where pm.ref_no = v_ref and pm.status <> 'rejected') then
    raise exception 'เลขที่อ้างอิงรายการนี้ถูกใช้ไปแล้ว' using errcode = '23505';
  end if;

  update public.payments pm
     set status = 'rejected',
         reject_reason = coalesce(pm.reject_reason, 'ผู้สมัครแนบสลิปใหม่แทนรายการนี้')
   where pm.application_id = v_app.id and pm.status = 'pending';

  insert into public.payments (
    application_id, member_id, amount, paid_at, bank_code, bank_name, payer_name,
    ref_no, slip_path, slip_sha256, slip_qr_raw, check_score, check_result,
    server_check_score, server_check_result, status
  ) values (
    v_app.id, v_m.id, v_amount, v_paid_at,
    nullif(btrim(coalesce(p ->> 'bank_code', '')), ''),
    nullif(btrim(coalesce(p ->> 'bank_name', '')), ''),
    nullif(btrim(coalesce(p ->> 'payer_name', '')), ''),
    v_ref, v_path, v_hash,
    nullif(btrim(coalesce(p ->> 'slip_qr_raw', '')), ''),
    -- คะแนนจากเครื่องผู้ใช้ เก็บไว้เปรียบเทียบเท่านั้น บีบให้อยู่ในช่วง 0-100
    case when v_score is null then null else least(greatest(v_score, 0), 100) end,
    case when p ? 'check_result' then p -> 'check_result' else null end,
    (v_srv ->> 'score')::int,
    v_srv,
    'pending'
  ) returning * into v_pay;

  update public.applications a set status = 'payment_submitted' where a.id = v_app.id;

  return jsonb_build_object(
    'payment_id', v_pay.id, 'status', v_pay.status, 'amount', v_pay.amount,
    'expected', v_app.fee_amount, 'amount_matches', (v_pay.amount = v_app.fee_amount),
    'server_score', v_pay.server_check_score,
    'server_blockers', coalesce(to_jsonb(v_blockers), '[]'::jsonb));
end; $function$;

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
  v_cfg    jsonb := app_private.setting('slip_check', '{}'::jsonb) -> 'bank_verify';
  v_auto   boolean := coalesce((v_cfg ->> 'auto_reject_on_mismatch')::boolean, false);
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
  -- ดัชนี payments_bank_ref_uniq กันไว้อีกชั้น ตรวจตรงนี้เพื่อให้ผลออกมาเป็น
  -- สถานะ duplicate แทนที่จะเป็น error ของฐานข้อมูล
  if v_ref is not null and exists (
    select 1 from public.payments pm
     where pm.bank_ref = v_ref and pm.id <> p_payment_id and pm.status <> 'rejected'
  ) then
    v_status := 'duplicate';
    v_ref := null;
  end if;

  -- ถ้าสองคำขอผ่านการตรวจข้างบนพร้อมกัน ดัชนี payments_bank_ref_uniq จะกันไว้
  -- รับไว้ตรงนี้แล้วบันทึกเป็นสถานะ duplicate แทนที่จะปล่อยให้เป็นข้อผิดพลาดของระบบ
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

  -- ปฏิเสธอัตโนมัติเมื่อธนาคารบอกว่าไม่ตรง และเปิดโหมดนี้ไว้
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

  return jsonb_build_object('ok', true, 'status', v_status);
end; $function$;

revoke all on function app_private.slip_server_check(uuid, numeric, numeric, timestamptz, text, text, text) from public, anon, authenticated;
revoke all on function public.record_slip_verification(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_slip_verification(uuid, jsonb) to service_role;
