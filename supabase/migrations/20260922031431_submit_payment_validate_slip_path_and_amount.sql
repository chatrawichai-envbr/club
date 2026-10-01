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
  v_score int := nullif(p ->> 'check_score', '')::int;
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
  --
  -- นโยบาย RLS ของที่เก็บไฟล์กันไม่ให้ผู้ใช้ "อ่าน" ไฟล์ของคนอื่นอยู่แล้ว
  -- แต่ไม่ได้กันการ "อ้างถึง" เส้นทางไฟล์ของคนอื่นในรายการชำระเงินของตัวเอง
  -- ถ้าไม่ตรวจตรงนี้ ผู้สมัครสามารถส่ง slip_path ที่ชี้ไปยังสลิปของสมาชิกรายอื่น
  -- เจ้าหน้าที่ซึ่งเปิดดูสลิปได้ทุกใบจะเห็นสลิปจริงของผู้อื่นในรายการของผู้ส่ง
  -- กลายเป็นการใช้หลักฐานการโอนของคนอื่นมายืนยันการชำระเงินของตัวเอง
  -- และทำให้เอกสารการเงินของชมรมชี้ไปผิดคน
  --
  -- ตรวจแบบเดียวกับ admin_replace_slip ข้อ 4.3 และ upsert_my_member
  if v_path is not null and split_part(v_path, '/', 1) <> v_uid::text then
    raise exception 'เส้นทางไฟล์สลิปไม่ตรงกับผู้ใช้ที่เข้าสู่ระบบ' using errcode = '42501';
  end if;

  -- จำนวนเงินต้องมากกว่าศูนย์ (เกณฑ์เดียวกับ admin_replace_slip)
  if v_amount <= 0 then
    raise exception 'จำนวนเงินต้องมากกว่าศูนย์' using errcode = '22023';
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
    ref_no, slip_path, slip_sha256, slip_qr_raw, check_score, check_result, status
  ) values (
    v_app.id, v_m.id, v_amount,
    nullif(p ->> 'paid_at', '')::timestamptz,
    nullif(btrim(coalesce(p ->> 'bank_code', '')), ''),
    nullif(btrim(coalesce(p ->> 'bank_name', '')), ''),
    nullif(btrim(coalesce(p ->> 'payer_name', '')), ''),
    v_ref,
    v_path,
    v_hash,
    nullif(btrim(coalesce(p ->> 'slip_qr_raw', '')), ''),
    -- คะแนนตรวจสลิปคำนวณในเครื่องผู้ใช้ จึงถือเป็นค่าที่ผู้ส่งกำหนดเองได้
    -- บีบให้อยู่ในช่วง 0-100 เพื่อไม่ให้แสดงคะแนนเกินจริงต่อเจ้าหน้าที่
    case when v_score is null then null else least(greatest(v_score, 0), 100) end,
    case when p ? 'check_result' then p -> 'check_result' else null end,
    'pending'
  ) returning * into v_pay;

  update public.applications a set status = 'payment_submitted' where a.id = v_app.id;

  return jsonb_build_object(
    'payment_id', v_pay.id, 'status', v_pay.status, 'amount', v_pay.amount,
    'expected', v_app.fee_amount, 'amount_matches', (v_pay.amount = v_app.fee_amount));
end; $function$;
