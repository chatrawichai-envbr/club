-- ป้องกันการส่ง photo_path / signature_path ที่ชี้ไปยังโฟลเดอร์ของผู้ใช้คนอื่น
-- ผ่าน RPC โดยตรง (ข้ามหน้าเว็บ) เดิมมีการตรวจลักษณะนี้เฉพาะ admin_replace_slip
-- แต่ upsert_my_member และ admin_update_member ไม่มี ทำให้ยืนยันตัวตนแล้วสามารถ
-- ส่งเส้นทางไฟล์ของผู้ใช้อื่นมาแทนที่ข้อมูลของตนเอง/ของสมาชิกที่กำลังแก้ไขได้

CREATE OR REPLACE FUNCTION public.upsert_my_member(p jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
declare
  v_uid       uuid := auth.uid();
  v_member    public.members;
  v_id        uuid;
  v_nid       text := nullif(btrim(coalesce(p ->> 'national_id', '')), '');
  v_nid_digits text;
  v_bidx      text;
  v_phone     text := nullif(btrim(coalesce(p ->> 'phone', '')), '');
  v_addr      text := nullif(btrim(coalesce(p ->> 'addr_detail', '')), '');
  v_work_addr text := nullif(btrim(coalesce(p ->> 'work_addr_detail', '')), '');
  v_open_status text;
  v_photo_path text := nullif(btrim(coalesce(p ->> 'photo_path', '')), '');
  v_sign_path  text := nullif(btrim(coalesce(p ->> 'signature_path', '')), '');
begin
  if v_uid is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนบันทึกข้อมูล' using errcode = '28000';
  end if;

  if nullif(btrim(coalesce(p ->> 'first_name', '')), '') is null
     or nullif(btrim(coalesce(p ->> 'last_name', '')), '') is null then
    raise exception 'กรุณากรอกชื่อและนามสกุล' using errcode = '22023';
  end if;

  -- ไฟล์รูปถ่าย/ลายเซ็นต้องอยู่ในโฟลเดอร์ของผู้ใช้ที่ล็อกอินอยู่เท่านั้น
  -- กันการชี้ไปยังไฟล์ของคนอื่น (เทียบเคียงการตรวจ slip_path ใน admin_replace_slip)
  if v_photo_path is not null and split_part(v_photo_path, '/', 1) <> v_uid::text then
    raise exception 'เส้นทางไฟล์รูปถ่ายไม่ตรงกับผู้ใช้ที่เข้าสู่ระบบ' using errcode = '42501';
  end if;
  if v_sign_path is not null and split_part(v_sign_path, '/', 1) <> v_uid::text then
    raise exception 'เส้นทางไฟล์ลายเซ็นไม่ตรงกับผู้ใช้ที่เข้าสู่ระบบ' using errcode = '42501';
  end if;

  select * into v_member from public.members m where m.user_id = v_uid;

  -- ระหว่างรอตรวจสอบการชำระเงิน ห้ามแก้ข้อมูลเพื่อกันข้อมูลไม่ตรงกับใบสมัคร
  if v_member.id is not null then
    select a.status into v_open_status
    from public.applications a
    where a.member_id = v_member.id
      and a.status in ('payment_submitted', 'payment_verified')
    limit 1;

    if v_open_status is not null then
      raise exception 'ใบสมัครอยู่ระหว่างการตรวจสอบ ไม่สามารถแก้ไขข้อมูลได้ กรุณาติดต่อเจ้าหน้าที่'
        using errcode = '55000';
    end if;
  end if;

  -- ตรวจเลขประจำตัวประชาชน
  if v_nid is not null then
    v_nid_digits := regexp_replace(v_nid, '[^0-9]', '', 'g');
    if not app_private.is_valid_thai_id(v_nid_digits) then
      raise exception 'เลขประจำตัวประชาชนไม่ถูกต้อง (ตรวจสอบเลข 13 หลักอีกครั้ง)'
        using errcode = '22023';
    end if;
    v_bidx := app_private.bidx(v_nid_digits);

    if exists (
      select 1 from public.members m
      where m.national_id_bidx = v_bidx
        and (v_member.id is null or m.id <> v_member.id)
    ) then
      raise exception 'เลขประจำตัวประชาชนนี้มีการสมัครไว้แล้วในระบบ'
        using errcode = '23505';
    end if;
  end if;

  -- ตรวจประเภทหน่วยงาน
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
      phone_enc, phone_bidx, addr_detail_enc, work_addr_detail_enc,
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
      app_private.encrypt_pii(v_work_addr),
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
    )
    returning id into v_id;
  else
    v_id := v_member.id;
    update public.members m set
      title        = nullif(btrim(coalesce(p ->> 'title', '')), ''),
      title_other  = nullif(btrim(coalesce(p ->> 'title_other', '')), ''),
      first_name   = btrim(p ->> 'first_name'),
      last_name    = btrim(p ->> 'last_name'),
      first_name_en = nullif(btrim(coalesce(p ->> 'first_name_en', '')), ''),
      last_name_en  = nullif(btrim(coalesce(p ->> 'last_name_en', '')), ''),
      national_id_enc   = coalesce(app_private.encrypt_pii(v_nid_digits), m.national_id_enc),
      national_id_bidx  = coalesce(v_bidx, m.national_id_bidx),
      national_id_last4 = coalesce(right(v_nid_digits, 4), m.national_id_last4),
      phone_enc    = coalesce(app_private.encrypt_pii(v_phone), m.phone_enc),
      phone_bidx   = coalesce(app_private.bidx(v_phone), m.phone_bidx),
      addr_detail_enc = coalesce(app_private.encrypt_pii(v_addr), m.addr_detail_enc),
      work_addr_detail_enc =
        coalesce(app_private.encrypt_pii(v_work_addr), m.work_addr_detail_enc),
      birth_date   = nullif(p ->> 'birth_date', '')::date,
      gender       = nullif(btrim(coalesce(p ->> 'gender', '')), ''),
      email        = nullif(btrim(coalesce(p ->> 'email', '')), ''),
      license_no   = nullif(btrim(coalesce(p ->> 'license_no', '')), ''),
      license_type = nullif(btrim(coalesce(p ->> 'license_type', '')), ''),
      license_issued_on  = nullif(p ->> 'license_issued_on', '')::date,
      license_expires_on = nullif(p ->> 'license_expires_on', '')::date,
      education_level = nullif(btrim(coalesce(p ->> 'education_level', '')), ''),
      education_major = nullif(btrim(coalesce(p ->> 'education_major', '')), ''),
      org_type_code  = nullif(btrim(coalesce(p ->> 'org_type_code', '')), ''),
      org_type_other = nullif(btrim(coalesce(p ->> 'org_type_other', '')), ''),
      org_name       = nullif(btrim(coalesce(p ->> 'org_name', '')), ''),
      position_name  = nullif(btrim(coalesce(p ->> 'position_name', '')), ''),
      work_tambon    = nullif(btrim(coalesce(p ->> 'work_tambon', '')), ''),
      work_amphoe    = nullif(btrim(coalesce(p ->> 'work_amphoe', '')), ''),
      work_province  = coalesce(nullif(btrim(coalesce(p ->> 'work_province', '')), ''), 'บุรีรัมย์'),
      work_zip       = nullif(btrim(coalesce(p ->> 'work_zip', '')), ''),
      work_phone     = nullif(btrim(coalesce(p ->> 'work_phone', '')), ''),
      addr_tambon    = nullif(btrim(coalesce(p ->> 'addr_tambon', '')), ''),
      addr_amphoe    = nullif(btrim(coalesce(p ->> 'addr_amphoe', '')), ''),
      addr_province  = coalesce(nullif(btrim(coalesce(p ->> 'addr_province', '')), ''), 'บุรีรัมย์'),
      addr_zip       = nullif(btrim(coalesce(p ->> 'addr_zip', '')), ''),
      photo_path     = coalesce(nullif(btrim(coalesce(p ->> 'photo_path', '')), ''), m.photo_path),
      signature_path = coalesce(nullif(btrim(coalesce(p ->> 'signature_path', '')), ''), m.signature_path),
      updated_by     = v_uid
    where m.id = v_id;
  end if;

  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_update_member(p_member_id uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
declare
  v_m public.members;
  v_nid text; v_bidx text;
  v_photo_path text := nullif(btrim(coalesce(p ->> 'photo_path', '')), '');
  v_sign_path  text := nullif(btrim(coalesce(p ->> 'signature_path', '')), '');
begin
  perform app_private.require_area('members');

  select * into v_m from public.members m where m.id = p_member_id;
  if v_m.id is null then
    raise exception 'ไม่พบข้อมูลสมาชิก' using errcode = 'P0002';
  end if;

  -- ไฟล์รูปถ่าย/ลายเซ็นต้องอยู่ในโฟลเดอร์ของสมาชิกรายนี้เท่านั้น
  -- กันการชี้ไปยังไฟล์ของสมาชิกรายอื่น (เทียบเคียงการตรวจ slip_path ใน admin_replace_slip)
  if v_photo_path is not null
     and (v_m.user_id is null or split_part(v_photo_path, '/', 1) <> v_m.user_id::text) then
    raise exception 'เส้นทางไฟล์รูปถ่ายไม่ตรงกับเจ้าของสมาชิกรายนี้' using errcode = '42501';
  end if;
  if v_sign_path is not null
     and (v_m.user_id is null or split_part(v_sign_path, '/', 1) <> v_m.user_id::text) then
    raise exception 'เส้นทางไฟล์ลายเซ็นไม่ตรงกับเจ้าของสมาชิกรายนี้' using errcode = '42501';
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
    work_addr_detail_enc = case when p ? 'work_addr_detail'
      then app_private.encrypt_pii(nullif(btrim(coalesce(p ->> 'work_addr_detail','')),''))
      else m.work_addr_detail_enc end,
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
end;
$function$;
