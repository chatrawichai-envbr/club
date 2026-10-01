create or replace function app_private.approve_payment(
  p_payment_id uuid,
  p_actor      uuid,
  p_auto       boolean default false
) returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'app_private', 'pg_temp'
as $function$
declare
  v_pay   public.payments;
  v_app   public.applications;
  v_m     public.members;
  v_rec   public.receipts;
  v_no    text;
  v_payer text;
begin
  /*
   * เปลี่ยนสถานะแบบมีเงื่อนไขในคำสั่งเดียว
   *
   * ถ้ามีคำขออนุมัติเข้ามาพร้อมกันสองทาง (เจ้าหน้าที่กดพอดีกับที่ธนาคารยืนยันกลับมา)
   * จะมีเพียงคำสั่งเดียวที่ได้แถวไปต่อ อีกคำสั่งได้ศูนย์แถวแล้วออกไปเงียบ ๆ
   * จึงออกใบสำคัญรับเงินซ้ำไม่ได้ และดัชนี receipts_payment_id_key กันไว้อีกชั้น
   */
  update public.payments pm
     set status = 'verified',
         verified_at = now(),
         verified_by = p_actor,
         reject_reason = null
   where pm.id = p_payment_id and pm.status = 'pending'
  returning * into v_pay;

  if v_pay.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_pending');
  end if;

  select * into v_app from public.applications a where a.id = v_pay.application_id;
  select * into v_m   from public.members m      where m.id = v_pay.member_id;

  v_payer := coalesce(nullif(btrim(coalesce(v_pay.payer_name, '')), ''),
                      btrim(coalesce(v_m.title, '') || ' ' || v_m.first_name || ' ' || v_m.last_name));
  v_no := app_private.gen_code('RCP');

  insert into public.receipts
    (receipt_no, payment_id, application_id, member_id, amount, amount_text,
     payer_name, purpose, issued_by)
  values
    (v_no, v_pay.id, v_app.id, v_m.id, v_pay.amount, app_private.baht_text(v_pay.amount),
     v_payer,
     case when v_app.app_type = 'renew'
          then 'ค่าต่ออายุสมาชิกชมรมอนามัยสิ่งแวดล้อมจังหวัดบุรีรัมย์'
          else 'ค่าสมัครสมาชิกชมรมอนามัยสิ่งแวดล้อมจังหวัดบุรีรัมย์' end,
     p_actor)
  returning * into v_rec;

  if v_app.status <> 'approved' then
    update public.applications a set status = 'payment_verified' where a.id = v_app.id;
  end if;

  perform app_private.log_audit(
    case when p_auto then 'auto_verify_payment' else 'verify_payment' end,
    'payments', v_pay.id::text,
    'ใบสำคัญรับเงิน ' || v_no, null,
    case when p_auto
         then 'ธนาคารยืนยันรายการโอนแล้ว ระบบออกใบสำคัญรับเงินอัตโนมัติ'
         else 'ตรวจสอบสลิปผ่านและออกใบสำคัญรับเงิน' end);

  return jsonb_build_object(
    'ok', true,
    'receipt_no', v_rec.receipt_no,
    'receipt_id', v_rec.id,
    'application_status',
      case when v_app.status = 'approved' then 'approved' else 'payment_verified' end);
end; $function$;

revoke all on function app_private.approve_payment(uuid, uuid, boolean) from public, anon, authenticated;

create or replace function public.admin_review_payment(p_payment_id uuid, p_approve boolean, p_reason text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'app_private', 'pg_temp'
as $function$
declare
  v_pay public.payments; v_app public.applications;
  v_res jsonb;
begin
  perform app_private.require_area('payments');

  select * into v_pay from public.payments pm where pm.id = p_payment_id;
  if v_pay.id is null then
    raise exception 'ไม่พบรายการชำระเงิน' using errcode = 'P0002';
  end if;
  if v_pay.status <> 'pending' then
    raise exception 'รายการนี้ตรวจสอบแล้ว (สถานะ: %)', v_pay.status using errcode = '55000';
  end if;

  select * into v_app from public.applications a where a.id = v_pay.application_id;

  if p_approve then
    v_res := app_private.approve_payment(p_payment_id, auth.uid(), false);
    if not coalesce((v_res ->> 'ok')::boolean, false) then
      raise exception 'รายการนี้เพิ่งถูกตรวจสอบไปแล้ว กรุณารีเฟรชหน้าจอ' using errcode = '55000';
    end if;
    return jsonb_build_object('ok', true,
      'receipt_no', v_res ->> 'receipt_no',
      'receipt_id', (v_res ->> 'receipt_id')::uuid,
      'application_status', v_res ->> 'application_status');
  else
    if nullif(btrim(coalesce(p_reason, '')), '') is null then
      raise exception 'กรุณาระบุเหตุผลที่ไม่อนุมัติสลิป' using errcode = '22023';
    end if;
    update public.payments pm
       set status = 'rejected', reject_reason = btrim(p_reason),
           verified_at = now(), verified_by = auth.uid()
     where pm.id = p_payment_id;

    if v_app.status <> 'approved' then
      update public.applications a set status = 'awaiting_payment' where a.id = v_app.id;
    end if;

    perform app_private.log_audit('reject_payment', 'payments', v_pay.id::text,
      null, null, 'ไม่อนุมัติสลิป: ' || btrim(p_reason));

    return jsonb_build_object('ok', true, 'status', 'rejected',
                              'application_status',
                              case when v_app.status = 'approved'
                                   then 'approved' else 'awaiting_payment' end);
  end if;
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
  v_slip   jsonb := app_private.setting('slip_check', '{}'::jsonb);
  v_cfg    jsonb := v_slip -> 'bank_verify';
  v_auto   boolean := coalesce((v_cfg ->> 'auto_reject_on_mismatch')::boolean, false);
  v_approve boolean := coalesce((v_cfg ->> 'auto_approve_on_verified')::boolean, true);
  v_tol    numeric := coalesce((v_slip ->> 'allow_amount_tolerance')::numeric, 0);
  v_fee    numeric;
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

update public.settings
   set value = jsonb_set(value, '{bank_verify,auto_approve_on_verified}',
                         coalesce(value -> 'bank_verify' -> 'auto_approve_on_verified', 'true'::jsonb))
 where key = 'slip_check';
