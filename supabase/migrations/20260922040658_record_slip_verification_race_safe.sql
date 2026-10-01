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

  return jsonb_build_object('ok', true, 'status', v_status);
end; $function$;

revoke all on function public.record_slip_verification(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_slip_verification(uuid, jsonb) to service_role;
