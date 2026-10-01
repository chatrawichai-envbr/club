-- 1) หน้าสมาชิกเห็นคะแนนจากเซิร์ฟเวอร์และผลยืนยันกับธนาคาร
--    เพิ่มเฉพาะฟิลด์ใน payment ส่วนอื่นของ get_my_status คงเดิมทั้งหมด
create or replace function public.get_my_status()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'app_private', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_m   public.members;
  v_app public.applications;
  v_pay public.payments;
  v_rec public.receipts;
  v_card public.cards;
begin
  if v_uid is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน' using errcode = '28000';
  end if;

  select * into v_m from public.members m where m.user_id = v_uid;
  if v_m.id is null then
    return jsonb_build_object('has_member', false, 'is_admin', public.is_admin());
  end if;

  select * into v_app from public.applications a
   where a.member_id = v_m.id order by a.created_at desc limit 1;

  if v_app.id is not null then
    select * into v_pay from public.payments pm
     where pm.application_id = v_app.id order by pm.created_at desc limit 1;
    select * into v_rec from public.receipts r
     where r.application_id = v_app.id and r.voided_at is null order by r.issued_at desc limit 1;
  end if;

  select * into v_card from public.cards c
   where c.member_id = v_m.id and c.status = 'active'
   order by c.issued_at desc limit 1;

  return jsonb_build_object(
    'has_member', true,
    'is_admin',   public.is_admin(),
    'member', jsonb_build_object(
      'id', v_m.id, 'member_code', v_m.member_code, 'status', v_m.status,
      'title', v_m.title, 'title_other', v_m.title_other,
      'first_name', v_m.first_name, 'last_name', v_m.last_name,
      'first_name_en', v_m.first_name_en, 'last_name_en', v_m.last_name_en,
      'national_id', app_private.decrypt_pii(v_m.national_id_enc),
      'national_id_last4', v_m.national_id_last4,
      'phone', app_private.decrypt_pii(v_m.phone_enc),
      'addr_detail', app_private.decrypt_pii(v_m.addr_detail_enc),
      'birth_date', v_m.birth_date, 'gender', v_m.gender, 'email', v_m.email,
      'license_no', v_m.license_no, 'license_type', v_m.license_type,
      'license_issued_on', v_m.license_issued_on, 'license_expires_on', v_m.license_expires_on,
      'education_level', v_m.education_level, 'education_major', v_m.education_major,
      'org_type_code', v_m.org_type_code, 'org_type_other', v_m.org_type_other,
      'org_name', v_m.org_name, 'position_name', v_m.position_name,
      'work_tambon', v_m.work_tambon, 'work_amphoe', v_m.work_amphoe,
      'work_addr_detail', app_private.decrypt_pii(v_m.work_addr_detail_enc),
      'work_province', v_m.work_province, 'work_zip', v_m.work_zip, 'work_phone', v_m.work_phone,
      'addr_tambon', v_m.addr_tambon, 'addr_amphoe', v_m.addr_amphoe,
      'addr_province', v_m.addr_province, 'addr_zip', v_m.addr_zip,
      'photo_path', v_m.photo_path, 'signature_path', v_m.signature_path,
      'member_since', v_m.member_since, 'valid_from', v_m.valid_from, 'valid_to', v_m.valid_to
    ),
    'application', case when v_app.id is null then null else jsonb_build_object(
      'id', v_app.id, 'app_no', v_app.app_no, 'app_type', v_app.app_type,
      'status', v_app.status, 'fee_amount', v_app.fee_amount, 'term_years', v_app.term_years,
      'submitted_at', v_app.submitted_at, 'reviewed_at', v_app.reviewed_at,
      'review_note', v_app.review_note,
      'period_start', v_app.period_start, 'period_end', v_app.period_end
    ) end,
    'payment', case when v_pay.id is null then null else jsonb_build_object(
      'id', v_pay.id, 'amount', v_pay.amount, 'status', v_pay.status,
      'paid_at', v_pay.paid_at, 'bank_name', v_pay.bank_name, 'ref_no', v_pay.ref_no,
      'slip_path', v_pay.slip_path, 'check_score', v_pay.check_score,
      'check_result', v_pay.check_result, 'reject_reason', v_pay.reject_reason,
      'verified_at', v_pay.verified_at,
      'server_check_score', v_pay.server_check_score,
      'server_check_result', v_pay.server_check_result,
      'bank_verify_status', v_pay.bank_verify_status,
      'bank_verify_at', v_pay.bank_verify_at
    ) end,
    'receipt', case when v_rec.id is null then null else jsonb_build_object(
      'id', v_rec.id, 'receipt_no', v_rec.receipt_no, 'amount', v_rec.amount,
      'amount_text', v_rec.amount_text, 'issued_at', v_rec.issued_at,
      'payer_name', v_rec.payer_name, 'purpose', v_rec.purpose
    ) end,
    'card', case when v_card.id is null then null else jsonb_build_object(
      'id', v_card.id, 'card_no', v_card.card_no, 'verify_token', v_card.verify_token,
      'issued_at', v_card.issued_at, 'valid_from', v_card.valid_from,
      'valid_to', v_card.valid_to, 'status', v_card.status,
      'print_count', v_card.print_count,
      'is_expired', (v_card.valid_to < current_date)
    ) end
  );
end;
$function$;

-- 2) สลิปที่ผู้ดูแลระดับสูงสุดแนบแทนสมาชิก ให้บันทึกผลตรวจฝั่งเซิร์ฟเวอร์ไว้ด้วย
--    ไม่กันการบันทึก เพราะเส้นทางนี้มีไว้ override โดยเจตนา แต่ให้เจ้าหน้าที่เห็นคะแนน
create or replace function public.admin_replace_slip(p jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'app_private', 'pg_temp'
as $function$
declare
  v_app     public.applications;
  v_m       public.members;
  v_pay     public.payments;
  v_hash    text := nullif(btrim(coalesce(p ->> 'slip_sha256', '')), '');
  v_ref     text := nullif(btrim(coalesce(p ->> 'ref_no', '')), '');
  v_path    text := nullif(btrim(coalesce(p ->> 'slip_path', '')), '');
  v_reason  text := nullif(btrim(coalesce(p ->> 'reason', '')), '');
  v_amount  numeric := coalesce((p ->> 'amount')::numeric, 0);
  v_paid_at timestamptz := nullif(p ->> 'paid_at', '')::timestamptz;
  v_folder  text;
  v_voided  int := 0;
  v_dropped int := 0;
  v_keep_approved boolean;
  v_srv     jsonb;
begin
  perform app_private.require_area('slip_override');

  if v_reason is null then
    raise exception 'กรุณาระบุเหตุผลที่แนบสลิปใหม่แทนสมาชิก' using errcode = '22023';
  end if;
  if v_path is null then
    raise exception 'ไม่พบไฟล์สลิปที่อัปโหลด' using errcode = '22023';
  end if;
  if v_amount <= 0 then
    raise exception 'จำนวนเงินต้องมากกว่าศูนย์' using errcode = '22023';
  end if;

  select * into v_app from public.applications a
   where a.id = (p ->> 'application_id')::uuid;
  if v_app.id is null then
    raise exception 'ไม่พบใบสมัครนี้' using errcode = 'P0002';
  end if;
  select * into v_m from public.members m where m.id = v_app.member_id;
  if v_m.id is null then
    raise exception 'ไม่พบข้อมูลสมาชิกของใบสมัครนี้' using errcode = 'P0002';
  end if;

  if v_app.status not in ('awaiting_payment', 'payment_submitted',
                          'payment_verified', 'approved') then
    raise exception 'ใบสมัครนี้ไม่อยู่ในขั้นตอนที่แนบสลิปได้ (สถานะปัจจุบัน: %)', v_app.status
      using errcode = '55000';
  end if;

  v_folder := split_part(v_path, '/', 1);
  if v_m.user_id is null or v_folder <> v_m.user_id::text then
    raise exception 'เส้นทางไฟล์สลิปไม่ตรงกับเจ้าของใบสมัคร' using errcode = '42501';
  end if;

  if v_hash is not null and exists (
    select 1 from public.payments pm
     where pm.slip_sha256 = v_hash and pm.status <> 'rejected'
       and pm.application_id <> v_app.id) then
    raise exception 'สลิปใบนี้ถูกใช้กับใบสมัครอื่นไปแล้ว' using errcode = '23505';
  end if;
  if v_ref is not null and exists (
    select 1 from public.payments pm
     where pm.ref_no = v_ref and pm.status <> 'rejected'
       and pm.application_id <> v_app.id) then
    raise exception 'เลขที่อ้างอิงรายการนี้ถูกใช้กับใบสมัครอื่นไปแล้ว' using errcode = '23505';
  end if;

  -- บันทึกผลตรวจฝั่งเซิร์ฟเวอร์ไว้ให้เจ้าหน้าที่เห็น แต่ไม่ขัดการบันทึก
  v_srv := app_private.slip_server_check(
    v_m.user_id, v_app.fee_amount, v_amount, v_paid_at, v_path, v_hash, v_ref);

  update public.receipts r
     set voided_at = now(), voided_by = auth.uid(),
         void_reason = 'แนบสลิปใหม่แทน: ' || v_reason
   where r.application_id = v_app.id and r.voided_at is null;
  get diagnostics v_voided = row_count;

  update public.payments pm
     set status = 'rejected',
         reject_reason = 'ผู้ดูแลระดับสูงสุดแนบสลิปใหม่แทน: ' || v_reason
   where pm.application_id = v_app.id and pm.status in ('pending', 'verified');
  get diagnostics v_dropped = row_count;

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
    nullif(p ->> 'check_score', '')::int,
    case when p ? 'check_result' then p -> 'check_result' else null end,
    (v_srv ->> 'score')::int,
    v_srv,
    'pending'
  ) returning * into v_pay;

  v_keep_approved := (v_app.status = 'approved');
  if not v_keep_approved then
    update public.applications a set status = 'payment_submitted' where a.id = v_app.id;
  end if;

  perform app_private.log_audit(
    'replace_slip', 'payments', v_pay.id::text,
    'ใบสมัคร ' || coalesce(v_app.app_no, v_app.id::text),
    jsonb_build_object(
      'application_id', v_app.id,
      'member_id', v_m.id,
      'payments_superseded', v_dropped,
      'receipts_voided', v_voided,
      'kept_application_approved', v_keep_approved,
      'new_payment_id', v_pay.id,
      'server_check_score', (v_srv ->> 'score')::int,
      'slip_path', v_path),
    'ผู้ดูแลระดับสูงสุดแนบสลิปใหม่แทนสมาชิก: ' || v_reason);

  return jsonb_build_object(
    'ok', true,
    'payment_id', v_pay.id,
    'status', v_pay.status,
    'payments_superseded', v_dropped,
    'receipts_voided', v_voided,
    'kept_application_approved', v_keep_approved,
    'application_status', case when v_keep_approved then 'approved' else 'payment_submitted' end,
    'server_score', (v_srv ->> 'score')::int,
    'amount_matches', (v_pay.amount = v_app.fee_amount));
end; $function$;
