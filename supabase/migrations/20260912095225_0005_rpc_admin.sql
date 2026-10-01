-- ตรวจสิทธิ์ผู้ดูแลแบบมีข้อความภาษาไทย
create or replace function app_private.require_admin(p_roles text[] default null)
returns void language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'ต้องเข้าสู่ระบบด้วยบัญชีผู้ดูแลระบบ' using errcode = '42501';
  end if;
  if p_roles is not null and not public.has_admin_role(p_roles) then
    raise exception 'บัญชีผู้ดูแลของท่านไม่มีสิทธิ์ดำเนินการนี้' using errcode = '42501';
  end if;
end; $$;

-- ตรวจสอบสลิป: อนุมัติ (ออกใบสำคัญรับเงินให้อัตโนมัติ) หรือปฏิเสธ
create or replace function public.admin_review_payment(
  p_payment_id uuid, p_approve boolean, p_reason text default null)
returns jsonb language plpgsql security definer
set search_path = public, app_private, pg_temp
as $$
declare
  v_pay public.payments; v_app public.applications; v_m public.members;
  v_rec public.receipts; v_no text; v_payer text;
begin
  perform app_private.require_admin(array['treasurer','registrar','admin']);

  select * into v_pay from public.payments pm where pm.id = p_payment_id;
  if v_pay.id is null then
    raise exception 'ไม่พบรายการชำระเงิน' using errcode = 'P0002';
  end if;
  if v_pay.status <> 'pending' then
    raise exception 'รายการนี้ตรวจสอบแล้ว (สถานะ: %)', v_pay.status using errcode = '55000';
  end if;

  select * into v_app from public.applications a where a.id = v_pay.application_id;
  select * into v_m   from public.members m      where m.id = v_pay.member_id;

  if p_approve then
    update public.payments pm
       set status = 'verified', verified_at = now(), verified_by = auth.uid(),
           reject_reason = null
     where pm.id = p_payment_id;

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
       auth.uid())
    returning * into v_rec;

    update public.applications a set status = 'payment_verified' where a.id = v_app.id;

    perform app_private.log_audit('verify_payment', 'payments', v_pay.id::text,
      'ใบสำคัญรับเงิน ' || v_no, null, 'ตรวจสอบสลิปผ่านและออกใบสำคัญรับเงิน');

    return jsonb_build_object('ok', true, 'receipt_no', v_rec.receipt_no,
                              'receipt_id', v_rec.id, 'application_status', 'payment_verified');
  else
    if nullif(btrim(coalesce(p_reason, '')), '') is null then
      raise exception 'กรุณาระบุเหตุผลที่ไม่อนุมัติสลิป' using errcode = '22023';
    end if;
    update public.payments pm
       set status = 'rejected', reject_reason = btrim(p_reason),
           verified_at = now(), verified_by = auth.uid()
     where pm.id = p_payment_id;

    update public.applications a set status = 'awaiting_payment' where a.id = v_app.id;

    perform app_private.log_audit('reject_payment', 'payments', v_pay.id::text,
      null, null, 'ไม่อนุมัติสลิป: ' || btrim(p_reason));

    return jsonb_build_object('ok', true, 'status', 'rejected',
                              'application_status', 'awaiting_payment');
  end if;
end; $$;

-- อนุมัติ / ไม่อนุมัติใบสมัคร  (อนุมัติ = ออกรหัสสมาชิกและบัตรสมาชิก)
create or replace function public.admin_decide_application(
  p_app_id uuid, p_approve boolean, p_note text default null)
returns jsonb language plpgsql security definer
set search_path = public, app_private, pg_temp
as $$
declare
  v_app public.applications; v_m public.members; v_card public.cards;
  v_from date; v_to date; v_code text; v_years int;
begin
  perform app_private.require_admin(array['registrar','admin']);

  select * into v_app from public.applications a where a.id = p_app_id;
  if v_app.id is null then
    raise exception 'ไม่พบใบสมัคร' using errcode = 'P0002';
  end if;
  select * into v_m from public.members m where m.id = v_app.member_id;

  if not p_approve then
    if nullif(btrim(coalesce(p_note, '')), '') is null then
      raise exception 'กรุณาระบุเหตุผลที่ไม่อนุมัติ' using errcode = '22023';
    end if;
    update public.applications a
       set status = 'rejected', reviewed_at = now(), reviewed_by = auth.uid(),
           review_note = btrim(p_note)
     where a.id = p_app_id;
    perform app_private.log_audit('reject_application', 'applications', p_app_id::text,
      v_app.app_no, null, 'ไม่อนุมัติใบสมัคร: ' || btrim(p_note));
    return jsonb_build_object('ok', true, 'status', 'rejected');
  end if;

  if v_app.status <> 'payment_verified' then
    raise exception 'ต้องตรวจสอบการชำระเงินให้ผ่านก่อนอนุมัติใบสมัคร (สถานะปัจจุบัน: %)', v_app.status
      using errcode = '55000';
  end if;

  v_years := greatest(coalesce(v_app.term_years, 1), 1);

  -- ต่ออายุก่อนหมดอายุ: นับต่อจากวันหมดอายุเดิม
  if v_app.app_type = 'renew' and v_m.valid_to is not null and v_m.valid_to >= current_date then
    v_from := v_m.valid_to + 1;
  else
    v_from := current_date;
  end if;
  v_to := (v_from + (v_years || ' years')::interval)::date - 1;

  v_code := coalesce(v_m.member_code, app_private.gen_code('MEM'));

  update public.members m
     set member_code  = v_code,
         status       = 'active',
         member_since = coalesce(m.member_since, v_from),
         valid_from   = v_from,
         valid_to     = v_to,
         updated_by   = auth.uid()
   where m.id = v_m.id;

  -- บัตรใบเดิมถือว่าถูกแทนที่
  update public.cards c set status = 'replaced'
   where c.member_id = v_m.id and c.status = 'active';

  insert into public.cards
    (member_id, application_id, card_no, verify_token, valid_from, valid_to, status)
  values
    (v_m.id, v_app.id, app_private.gen_code('CARD'),
     encode(extensions.gen_random_bytes(16), 'hex'), v_from, v_to, 'active')
  returning * into v_card;

  update public.applications a
     set status = 'approved', reviewed_at = now(), reviewed_by = auth.uid(),
         review_note = nullif(btrim(coalesce(p_note, '')), ''),
         period_start = v_from, period_end = v_to
   where a.id = p_app_id;

  perform app_private.log_audit('approve_application', 'applications', p_app_id::text,
    v_app.app_no, jsonb_build_object('member_code', v_code, 'card_no', v_card.card_no,
                                     'valid_from', v_from, 'valid_to', v_to),
    'อนุมัติใบสมัครและออกบัตรสมาชิก');

  return jsonb_build_object('ok', true, 'status', 'approved', 'member_code', v_code,
    'card_no', v_card.card_no, 'card_id', v_card.id,
    'valid_from', v_from, 'valid_to', v_to);
end; $$;

-- แก้ไขข้อมูลสมาชิกโดยผู้ดูแล (แก้เฉพาะคีย์ที่ส่งมา, บันทึก log อัตโนมัติ)
create or replace function public.admin_update_member(p_member_id uuid, p jsonb)
returns jsonb language plpgsql security definer
set search_path = public, app_private, pg_temp
as $$
declare
  v_m public.members;
  v_nid text; v_bidx text;
begin
  perform app_private.require_admin(array['registrar','admin']);

  select * into v_m from public.members m where m.id = p_member_id;
  if v_m.id is null then
    raise exception 'ไม่พบข้อมูลสมาชิก' using errcode = 'P0002';
  end if;

  if p ? 'national_id' and nullif(btrim(coalesce(p ->> 'national_id', '')), '') is not null then
    v_nid := regexp_replace(p ->> 'national_id', '[^0-9]', '', 'g');
    if not app_private.is_valid_thai_id(v_nid) then
      raise exception 'เลขประจำตัวประชาชนไม่ถูกต้อง' using errcode = '22023';
    end if;
    v_bidx := app_private.bidx(v_nid);
    if exists (select 1 from public.members m2
               where m2.national_id_bidx = v_bidx and m2.id <> p_member_id) then
      raise exception 'เลขประจำตัวประชาชนนี้มีอยู่ในระบบแล้ว (สมาชิกรายอื่น)' using errcode = '23505';
    end if;
  end if;

  update public.members m set
    title       = case when p ? 'title' then nullif(btrim(coalesce(p ->> 'title','')),'') else m.title end,
    title_other = case when p ? 'title_other' then nullif(btrim(coalesce(p ->> 'title_other','')),'') else m.title_other end,
    first_name  = case when p ? 'first_name' and nullif(btrim(coalesce(p ->> 'first_name','')),'') is not null
                       then btrim(p ->> 'first_name') else m.first_name end,
    last_name   = case when p ? 'last_name' and nullif(btrim(coalesce(p ->> 'last_name','')),'') is not null
                       then btrim(p ->> 'last_name') else m.last_name end,
    first_name_en = case when p ? 'first_name_en' then nullif(btrim(coalesce(p ->> 'first_name_en','')),'') else m.first_name_en end,
    last_name_en  = case when p ? 'last_name_en' then nullif(btrim(coalesce(p ->> 'last_name_en','')),'') else m.last_name_en end,
    national_id_enc   = case when v_nid is not null then app_private.encrypt_pii(v_nid) else m.national_id_enc end,
    national_id_bidx  = case when v_bidx is not null then v_bidx else m.national_id_bidx end,
    national_id_last4 = case when v_nid is not null then right(v_nid, 4) else m.national_id_last4 end,
    phone_enc  = case when p ? 'phone' then app_private.encrypt_pii(nullif(btrim(coalesce(p ->> 'phone','')),'')) else m.phone_enc end,
    phone_bidx = case when p ? 'phone' then app_private.bidx(nullif(btrim(coalesce(p ->> 'phone','')),'')) else m.phone_bidx end,
    addr_detail_enc = case when p ? 'addr_detail' then app_private.encrypt_pii(nullif(btrim(coalesce(p ->> 'addr_detail','')),'')) else m.addr_detail_enc end,
    birth_date  = case when p ? 'birth_date' then nullif(p ->> 'birth_date','')::date else m.birth_date end,
    gender      = case when p ? 'gender' then nullif(btrim(coalesce(p ->> 'gender','')),'') else m.gender end,
    email       = case when p ? 'email' then nullif(btrim(coalesce(p ->> 'email','')),'') else m.email end,
    license_no   = case when p ? 'license_no' then nullif(btrim(coalesce(p ->> 'license_no','')),'') else m.license_no end,
    license_type = case when p ? 'license_type' then nullif(btrim(coalesce(p ->> 'license_type','')),'') else m.license_type end,
    license_issued_on  = case when p ? 'license_issued_on' then nullif(p ->> 'license_issued_on','')::date else m.license_issued_on end,
    license_expires_on = case when p ? 'license_expires_on' then nullif(p ->> 'license_expires_on','')::date else m.license_expires_on end,
    education_level = case when p ? 'education_level' then nullif(btrim(coalesce(p ->> 'education_level','')),'') else m.education_level end,
    education_major = case when p ? 'education_major' then nullif(btrim(coalesce(p ->> 'education_major','')),'') else m.education_major end,
    org_type_code  = case when p ? 'org_type_code' then nullif(btrim(coalesce(p ->> 'org_type_code','')),'') else m.org_type_code end,
    org_type_other = case when p ? 'org_type_other' then nullif(btrim(coalesce(p ->> 'org_type_other','')),'') else m.org_type_other end,
    org_name      = case when p ? 'org_name' then nullif(btrim(coalesce(p ->> 'org_name','')),'') else m.org_name end,
    position_name = case when p ? 'position_name' then nullif(btrim(coalesce(p ->> 'position_name','')),'') else m.position_name end,
    work_tambon = case when p ? 'work_tambon' then nullif(btrim(coalesce(p ->> 'work_tambon','')),'') else m.work_tambon end,
    work_amphoe = case when p ? 'work_amphoe' then nullif(btrim(coalesce(p ->> 'work_amphoe','')),'') else m.work_amphoe end,
    work_zip    = case when p ? 'work_zip' then nullif(btrim(coalesce(p ->> 'work_zip','')),'') else m.work_zip end,
    work_phone  = case when p ? 'work_phone' then nullif(btrim(coalesce(p ->> 'work_phone','')),'') else m.work_phone end,
    addr_tambon = case when p ? 'addr_tambon' then nullif(btrim(coalesce(p ->> 'addr_tambon','')),'') else m.addr_tambon end,
    addr_amphoe = case when p ? 'addr_amphoe' then nullif(btrim(coalesce(p ->> 'addr_amphoe','')),'') else m.addr_amphoe end,
    addr_zip    = case when p ? 'addr_zip' then nullif(btrim(coalesce(p ->> 'addr_zip','')),'') else m.addr_zip end,
    photo_path     = case when p ? 'photo_path' then nullif(btrim(coalesce(p ->> 'photo_path','')),'') else m.photo_path end,
    signature_path = case when p ? 'signature_path' then nullif(btrim(coalesce(p ->> 'signature_path','')),'') else m.signature_path end,
    status      = case when p ? 'status' then coalesce(nullif(btrim(coalesce(p ->> 'status','')),''), m.status) else m.status end,
    member_code = case when p ? 'member_code' then nullif(btrim(coalesce(p ->> 'member_code','')),'') else m.member_code end,
    member_since = case when p ? 'member_since' then nullif(p ->> 'member_since','')::date else m.member_since end,
    valid_from  = case when p ? 'valid_from' then nullif(p ->> 'valid_from','')::date else m.valid_from end,
    valid_to    = case when p ? 'valid_to' then nullif(p ->> 'valid_to','')::date else m.valid_to end,
    updated_by  = auth.uid()
  where m.id = p_member_id;

  if nullif(btrim(coalesce(p ->> 'reason','')),'') is not null then
    perform app_private.log_audit('update_note', 'members', p_member_id::text, null, null,
      'เหตุผลการแก้ไข: ' || btrim(p ->> 'reason'));
  end if;

  return jsonb_build_object('ok', true, 'member_id', p_member_id);
end; $$;

-- ลบสมาชิก (ต้องระบุเหตุผล, บันทึก log ก่อนลบ)
create or replace function public.admin_delete_member(p_member_id uuid, p_reason text)
returns jsonb language plpgsql security definer
set search_path = public, app_private, pg_temp
as $$
declare v_m public.members;
begin
  perform app_private.require_admin(array['admin']);
  if nullif(btrim(coalesce(p_reason,'')),'') is null then
    raise exception 'กรุณาระบุเหตุผลในการลบข้อมูลสมาชิก' using errcode = '22023';
  end if;
  select * into v_m from public.members m where m.id = p_member_id;
  if v_m.id is null then
    raise exception 'ไม่พบข้อมูลสมาชิก' using errcode = 'P0002';
  end if;

  perform app_private.log_audit('delete_member', 'members', p_member_id::text,
    btrim(coalesce(v_m.title,'') || ' ' || v_m.first_name || ' ' || v_m.last_name) ||
    coalesce(' (' || v_m.member_code || ')', ''),
    jsonb_build_object('member_code', v_m.member_code, 'status', v_m.status),
    'ลบข้อมูลสมาชิก เหตุผล: ' || btrim(p_reason));

  delete from public.members m where m.id = p_member_id;
  return jsonb_build_object('ok', true);
end; $$;

-- ยกเลิกบัตร
create or replace function public.admin_revoke_card(p_card_id uuid, p_reason text)
returns jsonb language plpgsql security definer
set search_path = public, app_private, pg_temp
as $$
declare v_c public.cards;
begin
  perform app_private.require_admin(array['registrar','admin']);
  if nullif(btrim(coalesce(p_reason,'')),'') is null then
    raise exception 'กรุณาระบุเหตุผลในการยกเลิกบัตร' using errcode = '22023';
  end if;
  select * into v_c from public.cards c where c.id = p_card_id;
  if v_c.id is null then
    raise exception 'ไม่พบบัตรสมาชิก' using errcode = 'P0002';
  end if;
  update public.cards c set status = 'revoked' where c.id = p_card_id;
  update public.members m set status = 'revoked' where m.id = v_c.member_id;
  perform app_private.log_audit('revoke_card', 'cards', p_card_id::text, v_c.card_no,
    null, 'ยกเลิกบัตร เหตุผล: ' || btrim(p_reason));
  return jsonb_build_object('ok', true);
end; $$;

-- ออกบัตรใบใหม่แทนใบเดิม (บัตรหาย/ข้อมูลเปลี่ยน) โดยคงช่วงอายุเดิม
create or replace function public.admin_reissue_card(p_member_id uuid, p_reason text)
returns jsonb language plpgsql security definer
set search_path = public, app_private, pg_temp
as $$
declare v_m public.members; v_card public.cards;
begin
  perform app_private.require_admin(array['registrar','admin']);
  select * into v_m from public.members m where m.id = p_member_id;
  if v_m.id is null then
    raise exception 'ไม่พบข้อมูลสมาชิก' using errcode = 'P0002';
  end if;
  if v_m.valid_from is null or v_m.valid_to is null then
    raise exception 'สมาชิกรายนี้ยังไม่มีช่วงอายุสมาชิก ไม่สามารถออกบัตรได้' using errcode = '55000';
  end if;

  update public.cards c set status = 'replaced'
   where c.member_id = p_member_id and c.status = 'active';

  insert into public.cards (member_id, card_no, verify_token, valid_from, valid_to, status)
  values (p_member_id, app_private.gen_code('CARD'),
          encode(extensions.gen_random_bytes(16), 'hex'),
          v_m.valid_from, v_m.valid_to, 'active')
  returning * into v_card;

  perform app_private.log_audit('reissue_card', 'cards', v_card.id::text, v_card.card_no,
    null, 'ออกบัตรใบใหม่ เหตุผล: ' || coalesce(btrim(p_reason), 'ไม่ระบุ'));

  return jsonb_build_object('ok', true, 'card_no', v_card.card_no, 'card_id', v_card.id);
end; $$;

-- ปรับสถานะสมาชิก/บัตรที่หมดอายุแล้ว
create or replace function public.admin_expire_memberships()
returns jsonb language plpgsql security definer
set search_path = public, app_private, pg_temp
as $$
declare v_m int; v_c int;
begin
  perform app_private.require_admin(array['registrar','admin']);
  update public.cards c set status = 'expired'
   where c.status = 'active' and c.valid_to < current_date;
  get diagnostics v_c = row_count;
  update public.members m set status = 'expired'
   where m.status = 'active' and m.valid_to is not null and m.valid_to < current_date;
  get diagnostics v_m = row_count;
  if v_m > 0 or v_c > 0 then
    perform app_private.log_audit('expire_sweep', 'members', null, null,
      jsonb_build_object('members_expired', v_m, 'cards_expired', v_c),
      'ปรับสถานะสมาชิก/บัตรที่หมดอายุ');
  end if;
  return jsonb_build_object('ok', true, 'members_expired', v_m, 'cards_expired', v_c);
end; $$;

-- ข้อมูลสมาชิกทั้งหมดสำหรับตาราง/ส่งออก Excel (ถอดรหัสให้ผู้ดูแล)
create or replace function public.admin_export_members(p_include_pii boolean default true)
returns jsonb language plpgsql security definer
set search_path = public, app_private, pg_temp
as $$
declare v_rows jsonb; v_n int;
begin
  perform app_private.require_admin();

  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.created_at), '[]'::jsonb), count(*)
    into v_rows, v_n
  from (
    select
      m.member_code, m.status,
      coalesce(nullif(m.title, 'อื่นๆ'), m.title_other) as title,
      m.first_name, m.last_name, m.first_name_en, m.last_name_en,
      case when p_include_pii then app_private.decrypt_pii(m.national_id_enc)
           else 'xxxxxxxxx' || coalesce(m.national_id_last4, '') end as national_id,
      m.birth_date, m.gender, m.email,
      case when p_include_pii then app_private.decrypt_pii(m.phone_enc) else null end as phone,
      m.license_no, m.license_type, m.license_issued_on, m.license_expires_on,
      m.education_level, m.education_major,
      o.name as org_type_name, m.org_type_other, m.org_name, m.position_name,
      m.work_tambon, m.work_amphoe, m.work_province, m.work_zip, m.work_phone,
      case when p_include_pii then app_private.decrypt_pii(m.addr_detail_enc) else null end as addr_detail,
      m.addr_tambon, m.addr_amphoe, m.addr_province, m.addr_zip,
      m.member_since, m.valid_from, m.valid_to,
      c.card_no, c.issued_at as card_issued_at, c.status as card_status,
      r.receipt_no, r.amount as fee_paid, r.issued_at as receipt_issued_at,
      m.created_at
    from public.members m
    left join public.org_types o on o.code = m.org_type_code
    left join lateral (
      select c2.* from public.cards c2
       where c2.member_id = m.id and c2.status = 'active'
       order by c2.issued_at desc limit 1
    ) c on true
    left join lateral (
      select r2.* from public.receipts r2
       where r2.member_id = m.id order by r2.issued_at desc limit 1
    ) r on true
  ) t;

  perform app_private.log_audit('export_excel', 'members', null, null,
    jsonb_build_object('rows', v_n, 'include_pii', p_include_pii),
    'ส่งออกข้อมูลสมาชิกเป็นไฟล์ Excel');

  return jsonb_build_object('rows', v_rows, 'count', v_n, 'exported_at', now());
end; $$;

-- สรุปตัวเลขหน้าแรกของผู้ดูแล
create or replace function public.admin_stats()
returns jsonb language plpgsql security definer
set search_path = public, app_private, pg_temp
as $$
begin
  perform app_private.require_admin();
  return jsonb_build_object(
    'members_total',   (select count(*) from public.members),
    'members_active',  (select count(*) from public.members where status = 'active'),
    'members_pending', (select count(*) from public.members where status = 'pending'),
    'members_expired', (select count(*) from public.members where status = 'expired'),
    'expiring_60d',    (select count(*) from public.members
                         where status = 'active' and valid_to is not null
                           and valid_to between current_date and current_date + 60),
    'apps_awaiting_payment', (select count(*) from public.applications where status = 'awaiting_payment'),
    'apps_payment_submitted',(select count(*) from public.applications where status = 'payment_submitted'),
    'apps_payment_verified', (select count(*) from public.applications where status = 'payment_verified'),
    'payments_pending',(select count(*) from public.payments where status = 'pending'),
    'fees_verified_total', (select coalesce(sum(amount), 0) from public.payments where status = 'verified'),
    'cards_active',    (select count(*) from public.cards where status = 'active'),
    'by_org_type',     (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (
                          select coalesce(o.name, 'ไม่ระบุ') as k, count(*) as n
                          from public.members m
                          left join public.org_types o on o.code = m.org_type_code
                          group by 1) s),
    'by_amphoe',       (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (
                          select coalesce(work_amphoe, 'ไม่ระบุ') as k, count(*) as n
                          from public.members group by 1) s2)
  );
end; $$;

-- จัดการบัญชีผู้ดูแล (superadmin เท่านั้น) - ค้นผู้ใช้จากอีเมล
create or replace function public.admin_grant_admin(
  p_email text, p_role text default 'admin', p_full_name text default null,
  p_position text default null)
returns jsonb language plpgsql security definer
set search_path = public, app_private, pg_temp
as $$
declare v_uid uuid;
begin
  perform app_private.require_admin(array['superadmin']);
  if p_role not in ('superadmin','admin','registrar','treasurer') then
    raise exception 'บทบาทไม่ถูกต้อง' using errcode = '22023';
  end if;
  select u.id into v_uid from auth.users u where lower(u.email) = lower(btrim(p_email));
  if v_uid is null then
    raise exception 'ไม่พบบัญชีผู้ใช้อีเมล % (ผู้ใช้ต้องสมัครใช้งานระบบก่อน)', p_email
      using errcode = 'P0002';
  end if;
  insert into public.admins (user_id, role, full_name, position, created_by)
  values (v_uid, p_role, nullif(btrim(coalesce(p_full_name,'')),''),
          nullif(btrim(coalesce(p_position,'')),''), auth.uid())
  on conflict (user_id) do update
    set role = excluded.role, active = true,
        full_name = coalesce(excluded.full_name, admins.full_name),
        position  = coalesce(excluded.position, admins.position);
  return jsonb_build_object('ok', true, 'user_id', v_uid, 'role', p_role);
end; $$;

create or replace function public.admin_revoke_admin(p_user_id uuid)
returns jsonb language plpgsql security definer
set search_path = public, app_private, pg_temp
as $$
begin
  perform app_private.require_admin(array['superadmin']);
  if p_user_id = auth.uid() then
    raise exception 'ไม่สามารถยกเลิกสิทธิ์ผู้ดูแลของตนเองได้' using errcode = '55000';
  end if;
  update public.admins a set active = false where a.user_id = p_user_id;
  return jsonb_build_object('ok', true);
end; $$;

grant execute on function public.admin_review_payment(uuid, boolean, text)     to authenticated;
grant execute on function public.admin_decide_application(uuid, boolean, text) to authenticated;
grant execute on function public.admin_update_member(uuid, jsonb)              to authenticated;
grant execute on function public.admin_delete_member(uuid, text)               to authenticated;
grant execute on function public.admin_revoke_card(uuid, text)                 to authenticated;
grant execute on function public.admin_reissue_card(uuid, text)                to authenticated;
grant execute on function public.admin_expire_memberships()                    to authenticated;
grant execute on function public.admin_export_members(boolean)                 to authenticated;
grant execute on function public.admin_stats()                                 to authenticated;
grant execute on function public.admin_grant_admin(text, text, text, text)     to authenticated;
grant execute on function public.admin_revoke_admin(uuid)                      to authenticated;
