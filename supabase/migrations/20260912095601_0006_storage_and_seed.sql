-- ===== ที่เก็บไฟล์ (ทุก bucket เป็นแบบส่วนตัว เข้าถึงผ่าน signed URL) =====
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('member-photos',     'member-photos',     false, 3145728,
   array['image/jpeg','image/png','image/webp']),
  ('member-signatures', 'member-signatures', false, 1048576,
   array['image/png','image/jpeg','image/webp']),
  ('payment-slips',     'payment-slips',     false, 5242880,
   array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ผู้ใช้เข้าถึงได้เฉพาะโฟลเดอร์ที่ตั้งชื่อด้วย user id ของตนเอง
drop policy if exists club_files_insert on storage.objects;
create policy club_files_insert on storage.objects for insert to authenticated
  with check (
    bucket_id in ('member-photos','member-signatures','payment-slips')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists club_files_select on storage.objects;
create policy club_files_select on storage.objects for select to authenticated
  using (
    bucket_id in ('member-photos','member-signatures','payment-slips')
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

drop policy if exists club_files_update on storage.objects;
create policy club_files_update on storage.objects for update to authenticated
  using (
    bucket_id in ('member-photos','member-signatures','payment-slips')
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id in ('member-photos','member-signatures','payment-slips')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists club_files_delete on storage.objects;
create policy club_files_delete on storage.objects for delete to authenticated
  using (
    bucket_id in ('member-photos','member-signatures','payment-slips')
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

-- ===== ประเภทหน่วยงาน =====
insert into public.org_types (code, name, sort_order, requires_text) values
  ('pho',       'สำนักงานสาธารณสุขจังหวัด', 10, false),
  ('dho',       'สำนักงานสาธารณสุขอำเภอ',   20, false),
  ('hospital',  'โรงพยาบาล',                 30, false),
  ('hpht',      'โรงพยาบาลส่งเสริมสุขภาพตำบล', 40, false),
  ('sanh',      'สถานีอนามัยเฉลิมพระเกียรติ 60 พรรษา นวมินทราชินี', 50, false),
  ('local_gov', 'องค์กรปกครองส่วนท้องถิ่น',  60, false),
  ('school',    'สถานศึกษา',                 70, false),
  ('private',   'ภาคเอกชน',                  80, false),
  ('other',     'อื่นๆ',                     999, true)
on conflict (code) do update
  set name = excluded.name,
      sort_order = excluded.sort_order,
      requires_text = excluded.requires_text,
      active = true;

-- ===== ค่าตั้งค่าระบบ =====
insert into public.settings (key, value, is_public, description) values
  ('club', jsonb_build_object(
      'name',    'ชมรมอนามัยสิ่งแวดล้อมจังหวัดบุรีรัมย์',
      'name_en', 'Buriram Environmental Health Club',
      'short_name', 'ชมรมอนามัยสิ่งแวดล้อมบุรีรัมย์',
      'address', 'ชมรมอนามัยสิ่งแวดล้อมจังหวัดบุรีรัมย์ กลุ่มงานอนามัยสิ่งแวดล้อมและอาชีวอนามัย สำนักงานสาธารณสุขจังหวัดบุรีรัมย์ ตำบลในเมือง อำเภอเมืองบุรีรัมย์ จังหวัดบุรีรัมย์ 31000',
      'phone',   '044-611562',
      'email',   'envburiram@gmail.com',
      'president', '',
      'registrar', ''
    ), true, 'ข้อมูลชมรมที่แสดงบนบัตรสมาชิกและใบสำคัญรับเงิน (ผู้ดูแลแก้ไขได้)'),

  ('fees', jsonb_build_object('new', 300, 'renew', 200), true,
   'ค่าธรรมเนียม: new = สมัครใหม่, renew = ต่ออายุ (บาท)'),

  ('membership', jsonb_build_object('term_years', 1, 'renew_window_days', 90), true,
   'อายุบัตรสมาชิก (ปี) และช่วงวันที่เปิดให้ต่ออายุก่อนหมดอายุ'),

  ('bank', jsonb_build_object(
      'bank_name',    'ธนาคารกรุงไทย',
      'account_no',   '',
      'account_name', 'ชมรมอนามัยสิ่งแวดล้อมจังหวัดบุรีรัมย์',
      'promptpay_id', '',
      'promptpay_type','phone',
      'note', 'กรุณาโอนตามจำนวนที่ระบุ และเก็บสลิปไว้เพื่อแนบในระบบ'
    ), true, 'บัญชีรับชำระค่าสมัคร (ผู้ดูแลต้องกรอกเลขบัญชี/พร้อมเพย์ก่อนเปิดใช้งาน)'),

  ('legal', jsonb_build_object(
      'privacy_version', '1.0',
      'terms_version',   '1.0',
      'dpo_email',       'envburiram@gmail.com',
      'retention_years', 5
    ), true, 'เวอร์ชันเอกสารทางกฎหมายและระยะเวลาเก็บข้อมูล'),

  ('slip_check', jsonb_build_object(
      'max_age_days',       30,
      'require_qr',         false,
      'min_score_auto_flag', 60,
      'allow_amount_tolerance', 0
    ), true, 'เกณฑ์ตรวจสอบสลิปอัตโนมัติ')
on conflict (key) do nothing;
