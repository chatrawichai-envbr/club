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

  if v_path is not null and split_part(v_path, '/', 1) <> v_uid::text then
    raise exception 'เส้นทางไฟล์สลิปไม่ตรงกับผู้ใช้ที่เข้าสู่ระบบ' using errcode = '42501';
  end if;

  if v_amount <= 0 then
    raise exception 'จำนวนเงินต้องมากกว่าศูนย์' using errcode = '22023';
  end if;

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

update public.settings
   set value = value
     || jsonb_build_object('enforce_server', coalesce(value -> 'enforce_server', 'true'::jsonb))
     || jsonb_build_object('bank_verify', coalesce(value -> 'bank_verify', jsonb_build_object(
          'enabled', false,
          'provider', '',
          'require_account_match', true,
          'auto_reject_on_mismatch', false)))
 where key = 'slip_check';
