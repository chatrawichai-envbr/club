create or replace function app_private.thai_read_int(p_n bigint)
returns text language plpgsql immutable as $$
declare
  d text[] := array['ศูนย์','หนึ่ง','สอง','สาม','สี่','ห้า','หก','เจ็ด','แปด','เก้า'];
  u text[] := array['','สิบ','ร้อย','พัน','หมื่น','แสน'];
  n bigint := p_n; res text := ''; s text;
  i int; len int; digit int; pos int;
begin
  if n = 0 then return 'ศูนย์'; end if;
  if n >= 1000000 then
    res := app_private.thai_read_int(n / 1000000) || 'ล้าน';
    n := n % 1000000;
    if n = 0 then return res; end if;
  end if;
  s := n::text; len := length(s);
  for i in 1..len loop
    digit := substr(s, i, 1)::int;
    pos := len - i;
    if digit = 0 then continue; end if;
    if pos = 0 then
      if digit = 1 and len > 1 then res := res || 'เอ็ด';
      else res := res || d[digit + 1]; end if;
    elsif pos = 1 then
      if digit = 1 then res := res || 'สิบ';
      elsif digit = 2 then res := res || 'ยี่สิบ';
      else res := res || d[digit + 1] || 'สิบ'; end if;
    else
      res := res || d[digit + 1] || u[pos + 1];
    end if;
  end loop;
  return res;
end; $$;

create or replace function app_private.baht_text(p_amount numeric)
returns text language plpgsql immutable as $$
declare
  v_amt numeric := round(coalesce(p_amount, 0), 2);
  v_baht bigint; v_satang int;
begin
  v_baht := floor(v_amt)::bigint;
  v_satang := round((v_amt - floor(v_amt)) * 100)::int;
  if v_baht = 0 and v_satang = 0 then return 'ศูนย์บาทถ้วน'; end if;
  if v_satang = 0 then return app_private.thai_read_int(v_baht) || 'บาทถ้วน'; end if;
  if v_baht = 0 then return app_private.thai_read_int(v_satang) || 'สตางค์'; end if;
  return app_private.thai_read_int(v_baht) || 'บาท' || app_private.thai_read_int(v_satang) || 'สตางค์';
end; $$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''))
  on conflict (id) do update
    set email = excluded.email,
        full_name = coalesce(excluded.full_name, profiles.full_name);
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function app_private.setting(p_key text, p_default jsonb default null)
returns jsonb language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce((select s.value from public.settings s where s.key = p_key), p_default);
$$;

create or replace function public.upsert_my_member(p jsonb)
returns uuid language plpgsql security definer
set search_path = public, app_private, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_member public.members;
  v_id uuid;
  v_nid text := nullif(btrim(coalesce(p ->> 'national_id', '')), '');
  v_nid_digits text;
  v_bidx text;
  v_phone text := nullif(btrim(coalesce(p ->> 'phone', '')), '');
  v_addr text := nullif(btrim(coalesce(p ->> 'addr_detail', '')), '');
  v_open_status text;
begin
  if v_uid is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนบันทึกข้อมูล' using errcode = '28000';
  end if;
  if nullif(btrim(coalesce(p ->> 'first_name', '')), '') is null
     or nullif(btrim(coalesce(p ->> 'last_name', '')), '') is null then
    raise exception 'กรุณากรอกชื่อและนามสกุล' using errcode = '22023';
  end if;

  select * into v_member from public.members m where m.user_id = v_uid;

  if v_member.id is not null then
    select a.status into v_open_status from public.applications a
     where a.member_id = v_member.id
       and a.status in ('payment_submitted', 'payment_verified') limit 1;
    if v_open_status is not null then
      raise exception 'ใบสมัครอยู่ระหว่างการตรวจสอบ ไม่สามารถแก้ไขข้อมูลได้ กรุณาติดต่อเจ้าหน้าที่'
        using errcode = '55000';
    end if;
  end if;

  if v_nid is not null then
    v_nid_digits := regexp_replace(v_nid, '[^0-9]', '', 'g');
    if not app_private.is_valid_thai_id(v_nid_digits) then
      raise exception 'เลขประจำตัวประชาชนไม่ถูกต้อง (ตรวจสอบเลข 13 หลักอีกครั้ง)' using errcode = '22023';
    end if;
    v_bidx := app_private.bidx(v_nid_digits);
    if exists (select 1 from public.members m
               where m.national_id_bidx = v_bidx
                 and (v_member.id is null or m.id <> v_member.id)) then
      raise exception 'เลขประจำตัวประชาชนนี้มีการสมัครไว้แล้วในระบบ' using errcode = '23505';
    end if;
  end if;

  if nullif(btrim(coalesce(p ->> 'org_type_code', '')), '') is not null then
    if not exists (select 1 from public.org_types o
                   where o.code = p ->> 'org_type_code' and o.active) then
      raise exception 'ประเภทหน่วยงานไม่ถูกต้อง' using errcode = '22023';
    end if;
  end if;

  if v_member.id is null then
    insert into public.members (
      user_id, title, title_other, first_name, last_name, first_name_en, last_name_en,
      national_id_enc, national_id_bidx, national_id_last4,
      phone_enc, phone_bidx, addr_detail_enc,
      birth_date, gender, email,
      license_no, license_type, license_issued_on, license_expires_on,
      education_level, education_major,
      org_type_code, org_type_other, org_name, position_name,
      work_tambon, work_amphoe, work_province, work_zip, work_phone,
      addr_tambon, addr_amphoe, addr_province, addr_zip,
      photo_path, signature_path, updated_by
    ) values (
      v_uid,
      nullif(btrim(coalesce(p ->> 'title', '')), ''),
      nullif(btrim(coalesce(p ->> 'title_other', '')), ''),
      btrim(p ->> 'first_name'),
      btrim(p ->> 'last_name'),
      nullif(btrim(coalesce(p ->> 'first_name_en', '')), ''),
      nullif(btrim(coalesce(p ->> 'last_name_en', '')), ''),
      app_private.encrypt_pii(v_nid_digits),
      v_bidx,
      case when v_nid_digits is not null then right(v_nid_digits, 4) end,
      app_private.encrypt_pii(v_phone),
      app_private.bidx(v_phone),
      app_private.encrypt_pii(v_addr),
      nullif(p ->> 'birth_date', '')::date,
      nullif(btrim(coalesce(p ->> 'gender', '')), ''),
      nullif(btrim(coalesce(p ->> 'email', '')), ''),
      nullif(btrim(coalesce(p ->> 'license_no', '')), ''),
      nullif(btrim(coalesce(p ->> 'license_type', '')), ''),
      nullif(p ->> 'license_issued_on', '')::date,
      nullif(p ->> 'license_expires_on', '')::date,
      nullif(btrim(coalesce(p ->> 'education_level', '')), ''),
      nullif(btrim(coalesce(p ->> 'education_major', '')), ''),
      nullif(btrim(coalesce(p ->> 'org_type_code', '')), ''),
      nullif(btrim(coalesce(p ->> 'org_type_other', '')), ''),
      nullif(btrim(coalesce(p ->> 'org_name', '')), ''),
      nullif(btrim(coalesce(p ->> 'position_name', '')), ''),
      nullif(btrim(coalesce(p ->> 'work_tambon', '')), ''),
      nullif(btrim(coalesce(p ->> 'work_amphoe', '')), ''),
      coalesce(nullif(btrim(coalesce(p ->> 'work_province', '')), ''), 'บุรีรัมย์'),
      nullif(btrim(coalesce(p ->> 'work_zip', '')), ''),
      nullif(btrim(coalesce(p ->> 'work_phone', '')), ''),
      nullif(btrim(coalesce(p ->> 'addr_tambon', '')), ''),
      nullif(btrim(coalesce(p ->> 'addr_amphoe', '')), ''),
      coalesce(nullif(btrim(coalesce(p ->> 'addr_province', '')), ''), 'บุรีรัมย์'),
      nullif(btrim(coalesce(p ->> 'addr_zip', '')), ''),
      nullif(btrim(coalesce(p ->> 'photo_path', '')), ''),
      nullif(btrim(coalesce(p ->> 'signature_path', '')), ''),
      v_uid
    ) returning id into v_id;
  else
    v_id := v_member.id;
    update public.members m set
      title = nullif(btrim(coalesce(p ->> 'title', '')), ''),
      title_other = nullif(btrim(coalesce(p ->> 'title_other', '')), ''),
      first_name = btrim(p ->> 'first_name'),
      last_name = btrim(p ->> 'last_name'),
      first_name_en = nullif(btrim(coalesce(p ->> 'first_name_en', '')), ''),
      last_name_en = nullif(btrim(coalesce(p ->> 'last_name_en', '')), ''),
      national_id_enc = coalesce(app_private.encrypt_pii(v_nid_digits), m.national_id_enc),
      national_id_bidx = coalesce(v_bidx, m.national_id_bidx),
      national_id_last4 = coalesce(right(v_nid_digits, 4), m.national_id_last4),
      phone_enc = coalesce(app_private.encrypt_pii(v_phone), m.phone_enc),
      phone_bidx = coalesce(app_private.bidx(v_phone), m.phone_bidx),
      addr_detail_enc = coalesce(app_private.encrypt_pii(v_addr), m.addr_detail_enc),
      birth_date = nullif(p ->> 'birth_date', '')::date,
      gender = nullif(btrim(coalesce(p ->> 'gender', '')), ''),
      email = nullif(btrim(coalesce(p ->> 'email', '')), ''),
      license_no = nullif(btrim(coalesce(p ->> 'license_no', '')), ''),
      license_type = nullif(btrim(coalesce(p ->> 'license_type', '')), ''),
      license_issued_on = nullif(p ->> 'license_issued_on', '')::date,
      license_expires_on = nullif(p ->> 'license_expires_on', '')::date,
      education_level = nullif(btrim(coalesce(p ->> 'education_level', '')), ''),
      education_major = nullif(btrim(coalesce(p ->> 'education_major', '')), ''),
      org_type_code = nullif(btrim(coalesce(p ->> 'org_type_code', '')), ''),
      org_type_other = nullif(btrim(coalesce(p ->> 'org_type_other', '')), ''),
      org_name = nullif(btrim(coalesce(p ->> 'org_name', '')), ''),
      position_name = nullif(btrim(coalesce(p ->> 'position_name', '')), ''),
      work_tambon = nullif(btrim(coalesce(p ->> 'work_tambon', '')), ''),
      work_amphoe = nullif(btrim(coalesce(p ->> 'work_amphoe', '')), ''),
      work_province = coalesce(nullif(btrim(coalesce(p ->> 'work_province', '')), ''), 'บุรีรัมย์'),
      work_zip = nullif(btrim(coalesce(p ->> 'work_zip', '')), ''),
      work_phone = nullif(btrim(coalesce(p ->> 'work_phone', '')), ''),
      addr_tambon = nullif(btrim(coalesce(p ->> 'addr_tambon', '')), ''),
      addr_amphoe = nullif(btrim(coalesce(p ->> 'addr_amphoe', '')), ''),
      addr_province = coalesce(nullif(btrim(coalesce(p ->> 'addr_province', '')), ''), 'บุรีรัมย์'),
      addr_zip = nullif(btrim(coalesce(p ->> 'addr_zip', '')), ''),
      photo_path = coalesce(nullif(btrim(coalesce(p ->> 'photo_path', '')), ''), m.photo_path),
      signature_path = coalesce(nullif(btrim(coalesce(p ->> 'signature_path', '')), ''), m.signature_path),
      updated_by = v_uid
    where m.id = v_id;
  end if;

  return v_id;
end; $$;

create or replace function public.submit_application()
returns jsonb language plpgsql security definer
set search_path = public, app_private, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_m public.members;
  v_type text; v_fee numeric; v_years int;
  v_app public.applications; v_fees jsonb;
begin
  if v_uid is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน' using errcode = '28000';
  end if;
  select * into v_m from public.members m where m.user_id = v_uid;
  if v_m.id is null then
    raise exception 'ไม่พบข้อมูลผู้สมัคร กรุณากรอกใบสมัครก่อน' using errcode = 'P0002';
  end if;
  if v_m.national_id_enc is null then
    raise exception 'กรุณากรอกเลขประจำตัวประชาชน' using errcode = '22023';
  end if;
  if v_m.org_type_code is null then
    raise exception 'กรุณาเลือกประเภทหน่วยงาน' using errcode = '22023';
  end if;
  if v_m.addr_tambon is null or v_m.addr_amphoe is null then
    raise exception 'กรุณากรอกที่อยู่ที่ติดต่อได้ให้ครบถ้วน' using errcode = '22023';
  end if;
  if v_m.photo_path is null then
    raise exception 'กรุณาอัปโหลดรูปถ่ายสำหรับทำบัตรสมาชิก' using errcode = '22023';
  end if;

  if exists (select 1 from public.applications a
             where a.member_id = v_m.id
               and a.status in ('draft','submitted','awaiting_payment','payment_submitted','payment_verified')) then
    raise exception 'มีใบสมัครที่กำลังดำเนินการอยู่แล้ว' using errcode = '23505';
  end if;

  v_type := case when v_m.status in ('active','expired') then 'renew' else 'new' end;
  v_fees := app_private.setting('fees', '{"new": 300, "renew": 200}'::jsonb);
  v_fee := coalesce((v_fees ->> v_type)::numeric, 300);
  v_years := coalesce((app_private.setting('membership', '{"term_years": 1}'::jsonb) ->> 'term_years')::int, 1);

  insert into public.applications
    (member_id, app_no, app_type, status, fee_amount, term_years, submitted_at)
  values
    (v_m.id, app_private.gen_code('APP'), v_type, 'awaiting_payment', v_fee, v_years, now())
  returning * into v_app;

  return jsonb_build_object(
    'application_id', v_app.id, 'app_no', v_app.app_no, 'app_type', v_app.app_type,
    'status', v_app.status, 'fee_amount', v_app.fee_amount, 'term_years', v_app.term_years);
end; $$;

create or replace function public.submit_payment(p jsonb)
returns jsonb language plpgsql security definer
set search_path = public, app_private, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_app public.applications; v_m public.members;
  v_hash text := nullif(btrim(coalesce(p ->> 'slip_sha256', '')), '');
  v_ref text := nullif(btrim(coalesce(p ->> 'ref_no', '')), '');
  v_amount numeric := coalesce((p ->> 'amount')::numeric, 0);
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
    nullif(btrim(coalesce(p ->> 'slip_path', '')), ''),
    v_hash,
    nullif(btrim(coalesce(p ->> 'slip_qr_raw', '')), ''),
    nullif(p ->> 'check_score', '')::int,
    case when p ? 'check_result' then p -> 'check_result' else null end,
    'pending'
  ) returning * into v_pay;

  update public.applications a set status = 'payment_submitted' where a.id = v_app.id;

  return jsonb_build_object(
    'payment_id', v_pay.id, 'status', v_pay.status, 'amount', v_pay.amount,
    'expected', v_app.fee_amount, 'amount_matches', (v_pay.amount = v_app.fee_amount));
end; $$;

create or replace function public.get_member_pii(p_member_id uuid)
returns jsonb language plpgsql security definer
set search_path = public, app_private, pg_temp
as $$
declare v_m public.members;
begin
  select * into v_m from public.members m where m.id = p_member_id;
  if v_m.id is null then
    raise exception 'ไม่พบข้อมูลสมาชิก' using errcode = 'P0002';
  end if;
  if not (v_m.user_id = auth.uid() or public.is_admin()) then
    raise exception 'ไม่มีสิทธิ์เข้าถึงข้อมูลนี้' using errcode = '42501';
  end if;
  if v_m.user_id <> auth.uid() then
    perform app_private.log_audit('read_pii', 'members', v_m.id::text,
      btrim(coalesce(v_m.title, '') || ' ' || v_m.first_name || ' ' || v_m.last_name),
      null, 'เปิดดูข้อมูลส่วนบุคคลที่เข้ารหัส');
  end if;
  return jsonb_build_object(
    'national_id', app_private.decrypt_pii(v_m.national_id_enc),
    'phone', app_private.decrypt_pii(v_m.phone_enc),
    'addr_detail', app_private.decrypt_pii(v_m.addr_detail_enc));
end; $$;

create or replace function public.get_my_status()
returns jsonb language plpgsql security definer
set search_path = public, app_private, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_m public.members; v_app public.applications;
  v_pay public.payments; v_rec public.receipts; v_card public.cards;
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
    select * into v_rec from public.receipts r where r.application_id = v_app.id limit 1;
  end if;
  select * into v_card from public.cards c
   where c.member_id = v_m.id and c.status = 'active' order by c.issued_at desc limit 1;

  return jsonb_build_object(
    'has_member', true,
    'is_admin', public.is_admin(),
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
      'period_start', v_app.period_start, 'period_end', v_app.period_end) end,
    'payment', case when v_pay.id is null then null else jsonb_build_object(
      'id', v_pay.id, 'amount', v_pay.amount, 'status', v_pay.status,
      'paid_at', v_pay.paid_at, 'bank_name', v_pay.bank_name, 'ref_no', v_pay.ref_no,
      'slip_path', v_pay.slip_path, 'check_score', v_pay.check_score,
      'check_result', v_pay.check_result, 'reject_reason', v_pay.reject_reason,
      'verified_at', v_pay.verified_at) end,
    'receipt', case when v_rec.id is null then null else jsonb_build_object(
      'id', v_rec.id, 'receipt_no', v_rec.receipt_no, 'amount', v_rec.amount,
      'amount_text', v_rec.amount_text, 'issued_at', v_rec.issued_at,
      'payer_name', v_rec.payer_name, 'purpose', v_rec.purpose) end,
    'card', case when v_card.id is null then null else jsonb_build_object(
      'id', v_card.id, 'card_no', v_card.card_no, 'verify_token', v_card.verify_token,
      'issued_at', v_card.issued_at, 'valid_from', v_card.valid_from,
      'valid_to', v_card.valid_to, 'status', v_card.status,
      'print_count', v_card.print_count,
      'is_expired', (v_card.valid_to < current_date)) end
  );
end; $$;

create or replace function public.verify_card(p_token text)
returns jsonb language plpgsql security definer
set search_path = public, app_private, pg_temp
as $$
declare v_c public.cards; v_m public.members; v_org text;
begin
  if p_token is null or btrim(p_token) = '' then
    return jsonb_build_object('found', false, 'reason', 'ไม่พบรหัสตรวจสอบ');
  end if;
  select * into v_c from public.cards c where c.verify_token = btrim(p_token);
  if v_c.id is null then
    return jsonb_build_object('found', false, 'reason', 'ไม่พบบัตรสมาชิกที่ตรงกับรหัสนี้');
  end if;
  select * into v_m from public.members m where m.id = v_c.member_id;
  v_org := case
    when v_m.org_type_code = 'other' then coalesce(v_m.org_name, v_m.org_type_other)
    else coalesce(v_m.org_name, (select o.name from public.org_types o where o.code = v_m.org_type_code))
  end;
  return jsonb_build_object(
    'found', true,
    'member_code', v_m.member_code,
    'full_name', btrim(coalesce(nullif(v_m.title, 'อื่นๆ'), v_m.title_other, '') || ' ' ||
                       v_m.first_name || ' ' || v_m.last_name),
    'position_name', v_m.position_name,
    'org_name', v_org,
    'card_no', v_c.card_no,
    'issued_at', v_c.issued_at,
    'valid_from', v_c.valid_from,
    'valid_to', v_c.valid_to,
    'card_status', v_c.status,
    'member_status', v_m.status,
    'is_valid', (v_c.status = 'active'
                 and current_date between v_c.valid_from and v_c.valid_to
                 and v_m.status = 'active'),
    'checked_at', now());
end; $$;

create or replace function public.log_client_event(
  p_action text, p_entity text default null,
  p_entity_id text default null, p_note text default null)
returns void language plpgsql security definer
set search_path = public, app_private, pg_temp
as $$
begin
  if auth.uid() is null then return; end if;
  if p_action not in ('print_card','print_receipt','export_excel',
                      'login','logout','download_slip','view_member') then
    raise exception 'ชนิดเหตุการณ์ไม่ถูกต้อง' using errcode = '22023';
  end if;
  perform app_private.log_audit(p_action,
    coalesce(nullif(btrim(coalesce(p_entity, '')), ''), 'system'),
    p_entity_id, null, null, left(coalesce(p_note, ''), 500));
end; $$;

create or replace function public.record_card_print(p_card_id uuid)
returns void language plpgsql security definer
set search_path = public, app_private, pg_temp
as $$
declare v_c public.cards; v_m public.members;
begin
  select * into v_c from public.cards c where c.id = p_card_id;
  if v_c.id is null then
    raise exception 'ไม่พบบัตรสมาชิก' using errcode = 'P0002';
  end if;
  select * into v_m from public.members m where m.id = v_c.member_id;
  if not (v_m.user_id = auth.uid() or public.is_admin()) then
    raise exception 'ไม่มีสิทธิ์พิมพ์บัตรใบนี้' using errcode = '42501';
  end if;
  if v_c.status <> 'active' then
    raise exception 'บัตรใบนี้ถูกยกเลิก/แทนที่แล้ว ไม่สามารถพิมพ์ได้' using errcode = '55000';
  end if;
  update public.cards c set print_count = c.print_count + 1, last_printed_at = now()
   where c.id = p_card_id;
end; $$;

grant execute on function public.upsert_my_member(jsonb) to authenticated;
grant execute on function public.submit_application() to authenticated;
grant execute on function public.submit_payment(jsonb) to authenticated;
grant execute on function public.get_member_pii(uuid) to authenticated;
grant execute on function public.get_my_status() to authenticated;
grant execute on function public.record_card_print(uuid) to authenticated;
grant execute on function public.log_client_event(text, text, text, text) to authenticated;
grant execute on function public.verify_card(text) to anon, authenticated;
