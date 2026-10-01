-- =====================================================================
-- club-data (Supabase project ooovzjovkrfyuqakkpig) : schema snapshot
-- สำรองเมื่อ 2026-10-01 จากฐานข้อมูลจริง (PostgreSQL 17)
--
-- ไฟล์นี้คือโครงสร้างฐานข้อมูล "ปัจจุบัน" ทั้งหมดของสคีมา public และ app_private
-- รวมฟังก์ชัน ทริกเกอร์ RLS policy สิทธิ์ (grant) และ storage bucket/policy
-- ไม่มีข้อมูลส่วนบุคคลของสมาชิก
--
-- ข้อมูลอ้างอิง (org_types, settings) อยู่ใน seed.sql
-- ประวัติ migration ทีละขั้นอยู่ใน migrations/
-- =====================================================================

set check_function_bodies = false;
set client_min_messages = warning;

-- ---------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------

create extension if not exists pg_stat_statements with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists supabase_vault with schema vault;
create extension if not exists "uuid-ossp" with schema extensions;

-- ---------------------------------------------------------------------
-- Schemas
-- ---------------------------------------------------------------------

create schema if not exists app_private;

-- ---------------------------------------------------------------------
-- Sequences
-- ---------------------------------------------------------------------

create sequence if not exists public.audit_log_id_seq as bigint increment by 1 minvalue 1 maxvalue 9223372036854775807 start with 1 cache 1;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists app_private.counters (
  name text not null,
  value bigint not null,
  updated_at timestamp with time zone not null,
  constraint counters_pkey PRIMARY KEY (name)
);

create table if not exists app_private.crypto_canary (
  id integer not null,
  plain text not null,
  cipher bytea not null,
  bidx text not null,
  created_at timestamp with time zone not null,
  constraint crypto_canary_pkey PRIMARY KEY (id)
);

create table if not exists public.admins (
  user_id uuid not null,
  role text not null,
  full_name text,
  "position" text,
  active boolean not null,
  created_at timestamp with time zone not null,
  created_by uuid,
  constraint admins_pkey PRIMARY KEY (user_id)
);

create table if not exists public.announcements (
  id uuid not null,
  title text not null,
  body text not null,
  event_date date,
  status text not null,
  pinned boolean not null,
  published_at timestamp with time zone,
  created_by uuid,
  updated_by uuid,
  created_at timestamp with time zone not null,
  updated_at timestamp with time zone not null,
  constraint announcements_pkey PRIMARY KEY (id)
);

create table if not exists public.applications (
  id uuid not null,
  member_id uuid not null,
  app_no text,
  app_type text not null,
  status text not null,
  fee_amount numeric(10,2) not null,
  term_years integer not null,
  period_start date,
  period_end date,
  submitted_at timestamp with time zone,
  reviewed_at timestamp with time zone,
  reviewed_by uuid,
  review_note text,
  created_at timestamp with time zone not null,
  updated_at timestamp with time zone not null,
  constraint applications_pkey PRIMARY KEY (id),
  constraint applications_app_no_key UNIQUE (app_no)
);

create table if not exists public.audit_log (
  id bigint not null,
  at timestamp with time zone not null,
  actor_id uuid,
  actor_email text,
  actor_role text,
  action text not null,
  entity text not null,
  entity_id text,
  entity_label text,
  changed jsonb,
  note text,
  user_agent text,
  constraint audit_log_pkey PRIMARY KEY (id)
);

create table if not exists public.cards (
  id uuid not null,
  member_id uuid not null,
  application_id uuid,
  card_no text not null,
  verify_token text not null,
  issued_at timestamp with time zone not null,
  valid_from date not null,
  valid_to date not null,
  status text not null,
  print_count integer not null,
  last_printed_at timestamp with time zone,
  created_at timestamp with time zone not null,
  updated_at timestamp with time zone not null,
  constraint cards_pkey PRIMARY KEY (id),
  constraint cards_card_no_key UNIQUE (card_no),
  constraint cards_verify_token_key UNIQUE (verify_token)
);

create table if not exists public.consents (
  id uuid not null,
  user_id uuid,
  member_id uuid,
  doc text not null,
  version text not null,
  accepted boolean not null,
  accepted_at timestamp with time zone not null,
  user_agent text,
  created_at timestamp with time zone not null,
  constraint consents_pkey PRIMARY KEY (id)
);

create table if not exists public.members (
  id uuid not null,
  user_id uuid not null,
  member_code text,
  title text,
  title_other text,
  first_name text not null,
  last_name text not null,
  first_name_en text,
  last_name_en text,
  national_id_enc bytea,
  national_id_bidx text,
  national_id_last4 text,
  phone_enc bytea,
  phone_bidx text,
  addr_detail_enc bytea,
  birth_date date,
  gender text,
  email text,
  license_no text,
  license_type text,
  license_issued_on date,
  license_expires_on date,
  education_level text,
  education_major text,
  org_type_code text,
  org_type_other text,
  org_name text,
  position_name text,
  work_tambon text,
  work_amphoe text,
  work_province text,
  work_zip text,
  work_phone text,
  addr_tambon text,
  addr_amphoe text,
  addr_province text,
  addr_zip text,
  photo_path text,
  signature_path text,
  status text not null,
  member_since date,
  valid_from date,
  valid_to date,
  created_at timestamp with time zone not null,
  updated_at timestamp with time zone not null,
  updated_by uuid,
  work_addr_detail_enc bytea,
  constraint members_pkey PRIMARY KEY (id),
  constraint members_member_code_key UNIQUE (member_code),
  constraint members_national_id_bidx_key UNIQUE (national_id_bidx),
  constraint members_user_id_key UNIQUE (user_id)
);

create table if not exists public.org_types (
  code text not null,
  name text not null,
  sort_order integer not null,
  requires_text boolean not null,
  active boolean not null,
  constraint org_types_pkey PRIMARY KEY (code)
);

create table if not exists public.payments (
  id uuid not null,
  application_id uuid not null,
  member_id uuid not null,
  amount numeric(10,2) not null,
  paid_at timestamp with time zone,
  bank_code text,
  bank_name text,
  payer_name text,
  ref_no text,
  slip_path text,
  slip_sha256 text,
  slip_qr_raw text,
  check_score integer,
  check_result jsonb,
  status text not null,
  verified_at timestamp with time zone,
  verified_by uuid,
  reject_reason text,
  created_at timestamp with time zone not null,
  updated_at timestamp with time zone not null,
  server_check_score integer,
  server_check_result jsonb,
  bank_verify_status text not null,
  bank_verify_result jsonb,
  bank_verify_at timestamp with time zone,
  bank_ref text,
  constraint payments_pkey PRIMARY KEY (id)
);

create table if not exists public.profiles (
  id uuid not null,
  email text,
  full_name text,
  created_at timestamp with time zone not null,
  updated_at timestamp with time zone not null,
  constraint profiles_pkey PRIMARY KEY (id)
);

create table if not exists public.receipts (
  id uuid not null,
  receipt_no text not null,
  payment_id uuid not null,
  application_id uuid not null,
  member_id uuid not null,
  amount numeric(10,2) not null,
  amount_text text,
  payer_name text,
  purpose text,
  issued_at timestamp with time zone not null,
  issued_by uuid,
  created_at timestamp with time zone not null,
  voided_at timestamp with time zone,
  voided_by uuid,
  void_reason text,
  constraint receipts_pkey PRIMARY KEY (id),
  constraint receipts_payment_id_key UNIQUE (payment_id),
  constraint receipts_receipt_no_key UNIQUE (receipt_no)
);

create table if not exists public.settings (
  key text not null,
  value jsonb not null,
  is_public boolean not null,
  description text,
  updated_at timestamp with time zone not null,
  updated_by uuid,
  constraint settings_pkey PRIMARY KEY (key)
);

-- ---------------------------------------------------------------------
-- Sequence ownership
-- ---------------------------------------------------------------------

alter sequence public.audit_log_id_seq owned by public.audit_log.id;

-- ---------------------------------------------------------------------
-- Vault keys (fresh project only)
-- ---------------------------------------------------------------------

-- สร้างกุญแจใหม่แบบสุ่มเฉพาะเมื่อยังไม่มี (เหมือน migration 0001_foundation)
-- ถ้าจะกู้ข้อมูลสมาชิกเดิม ต้องนำกุญแจเดิมจาก Vault ของโปรเจกต์เดิมมาใส่แทน
-- มิฉะนั้นจะถอดรหัสคอลัมน์ *_enc ไม่ได้
do $$
declare
  v_names text[] := array['club_pii_enc_key', 'club_pii_bidx_pepper'];
  v_name  text;
begin
  foreach v_name in array v_names loop
    if not exists (select 1 from vault.secrets s where s.name = v_name) then
      perform vault.create_secret(
        encode(extensions.gen_random_bytes(32), 'base64'),
        v_name,
        'ชมรมอนามัยสิ่งแวดล้อมบุรีรัมย์: กุญแจเข้ารหัสข้อมูลส่วนบุคคล (สร้างอัตโนมัติ)'
      );
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_private.approve_payment(p_payment_id uuid, p_actor uuid, p_auto boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
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

  -- ใบสมัครที่อนุมัติออกบัตรไปแล้ว คงสถานะเดิม ไม่ถอยกลับ
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
end; $function$
;

CREATE OR REPLACE FUNCTION app_private.baht_text(p_amount numeric)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'app_private', 'pg_catalog', 'pg_temp'
AS $function$
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
end; $function$
;

CREATE OR REPLACE FUNCTION app_private.be_year()
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  select (extract(year from (now() at time zone 'Asia/Bangkok'))::int + 543);
$function$
;

CREATE OR REPLACE FUNCTION app_private.bidx(p_plain text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app_private', 'extensions', 'pg_temp'
AS $function$
declare
  v_norm text;
begin
  if p_plain is null then
    return null;
  end if;
  v_norm := lower(regexp_replace(p_plain, '[^0-9A-Za-zก-๙]', '', 'g'));
  if v_norm = '' then
    return null;
  end if;
  return encode(
           extensions.hmac(v_norm, app_private.secret('club_pii_bidx_pepper'), 'sha256'),
           'hex'
         );
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.block_audit_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
  if coalesce(current_setting('app.allow_audit_maintenance', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception
    'ตาราง audit_log เป็นบันทึกแบบเพิ่มได้เท่านั้น จึงแก้ไขหรือลบไม่ได้ (%). '
    'หากต้องลบตามรอบเก็บรักษาข้อมูล ให้รัน: '
    'set local app.allow_audit_maintenance = ''on''; ภายในธุรกรรมเดียวกันก่อน',
    tg_op
    using errcode = '42501';
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.block_audit_truncate()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
  if coalesce(current_setting('app.allow_audit_maintenance', true), '') = 'on' then
    return null;
  end if;
  raise exception
    'ตาราง audit_log เป็นบันทึกแบบเพิ่มได้เท่านั้น จึง TRUNCATE ไม่ได้ '
    'หากต้องลบตามรอบเก็บรักษาข้อมูล ให้รัน: '
    'set local app.allow_audit_maintenance = ''on''; ภายในธุรกรรมเดียวกันก่อน'
    using errcode = '42501';
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.check_encryption()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app_private', 'public', 'pg_temp'
AS $function$
declare
  c app_private.crypto_canary;
  v_dec text; v_bidx text;
  v_enc_ok boolean := false; v_bidx_ok boolean := false;
begin
  select * into c from app_private.crypto_canary where id = 1;
  if c.id is null then
    return jsonb_build_object('ok', false, 'reason', 'ไม่พบค่าตรวจสอบ (canary) ในระบบ');
  end if;

  begin
    v_dec := app_private.decrypt_pii(c.cipher);
    v_enc_ok := (v_dec = c.plain);
  exception when others then v_enc_ok := false; end;

  begin
    v_bidx := app_private.bidx(c.plain);
    v_bidx_ok := (v_bidx = c.bidx);
  exception when others then v_bidx_ok := false; end;

  return jsonb_build_object(
    'ok', (v_enc_ok and v_bidx_ok),
    'encryption_key_ok', v_enc_ok,
    'blind_index_pepper_ok', v_bidx_ok,
    'canary_created_at', c.created_at,
    'checked_at', now(),
    'reason', case
      when v_enc_ok and v_bidx_ok then 'กุญแจเข้ารหัสใช้งานได้ปกติ'
      when not v_enc_ok and not v_bidx_ok then 'กุญแจเข้ารหัสและ pepper ใช้ไม่ได้ทั้งคู่ ห้ามบันทึกข้อมูลใหม่ ให้กู้กุญแจก่อน'
      when not v_enc_ok then 'กุญแจเข้ารหัส (club_pii_enc_key) ใช้ไม่ได้ ข้อมูลเดิมจะถอดรหัสไม่ออก'
      else 'pepper ของ blind index (club_pii_bidx_pepper) ใช้ไม่ได้ การตรวจสมัครซ้ำจะผิดพลาด'
    end
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.decrypt_pii(p_cipher bytea)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app_private', 'extensions', 'pg_temp'
AS $function$
begin
  if p_cipher is null then
    return null;
  end if;
  return extensions.pgp_sym_decrypt(p_cipher, app_private.secret('club_pii_enc_key'));
exception
  when others then
    return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.encrypt_pii(p_plain text)
 RETURNS bytea
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app_private', 'extensions', 'pg_temp'
AS $function$
begin
  if p_plain is null or btrim(p_plain) = '' then
    return null;
  end if;
  return extensions.pgp_sym_encrypt(
           p_plain,
           app_private.secret('club_pii_enc_key'),
           'cipher-algo=aes256, compress-algo=0, s2k-mode=3, s2k-digest-algo=sha256'
         );
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.gen_code(p_prefix text, p_width integer DEFAULT 4)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app_private', 'pg_temp'
AS $function$
declare
  v_year int := app_private.be_year();
  v_n    bigint;
begin
  v_n := app_private.next_number(p_prefix || '-' || v_year::text);
  return p_prefix || '-' || v_year::text || '-' || lpad(v_n::text, p_width, '0');
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.is_valid_thai_id(p_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
  v_digits text;
  v_sum    int := 0;
  i        int;
begin
  if p_id is null then
    return false;
  end if;
  v_digits := regexp_replace(p_id, '[^0-9]', '', 'g');
  if length(v_digits) <> 13 then
    return false;
  end if;
  for i in 1..12 loop
    v_sum := v_sum + substr(v_digits, i, 1)::int * (14 - i);
  end loop;
  return ((11 - (v_sum % 11)) % 10) = substr(v_digits, 13, 1)::int;
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.log_audit(p_action text, p_entity text, p_entity_id text, p_entity_label text DEFAULT NULL::text, p_changed jsonb DEFAULT NULL::jsonb, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  v_role  text;
begin
  begin
    v_email := nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'email', '');
  exception when others then
    v_email := null;
  end;

  if v_email is null and v_uid is not null then
    select p.email into v_email from public.profiles p where p.id = v_uid;
  end if;

  -- ทางสำรองสุดท้าย อ่านจากตารางผู้ใช้โดยตรง
  if v_email is null and v_uid is not null then
    select u.email into v_email from auth.users u where u.id = v_uid;
  end if;

  select a.role into v_role from public.admins a where a.user_id = v_uid and a.active;

  insert into public.audit_log
    (actor_id, actor_email, actor_role, action, entity, entity_id, entity_label, changed, note)
  values
    (v_uid, v_email, coalesce(v_role, 'member'), p_action, p_entity,
     p_entity_id, p_entity_label, p_changed, p_note);
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.next_number(p_name text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app_private', 'pg_temp'
AS $function$
declare
  v_value bigint;
begin
  insert into app_private.counters as c (name, value)
  values (p_name, 1)
  on conflict (name) do update
    set value = c.value + 1, updated_at = now()
  returning c.value into v_value;
  return v_value;
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.require_admin(p_roles text[] DEFAULT NULL::text[])
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if not public.is_admin() then
    raise exception 'ต้องเข้าสู่ระบบด้วยบัญชีผู้ดูแลระบบ' using errcode = '42501';
  end if;
  if p_roles is not null and not public.has_admin_role(p_roles) then
    raise exception 'บัญชีผู้ดูแลของท่านไม่มีสิทธิ์ดำเนินการนี้' using errcode = '42501';
  end if;
end; $function$
;

CREATE OR REPLACE FUNCTION app_private.require_area(p_area text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if not public.is_admin() then
    raise exception 'ต้องเข้าสู่ระบบด้วยบัญชีผู้ดูแลระบบ' using errcode = '42501';
  end if;
  if not public.admin_can(p_area) then
    raise exception 'บัญชีผู้ดูแลของท่านไม่มีสิทธิ์ในส่วนนี้ (%)', p_area using errcode = '42501';
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.secret(p_name text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'app_private', 'vault', 'pg_temp'
AS $function$
declare
  v_val text;
begin
  select ds.decrypted_secret into v_val
  from vault.decrypted_secrets ds
  where ds.name = p_name
  limit 1;

  if v_val is null then
    raise exception 'ไม่พบกุญแจเข้ารหัสชื่อ % ใน Vault', p_name
      using errcode = 'internal_error';
  end if;
  return v_val;
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.setting(p_key text, p_default jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce((select s.value from public.settings s where s.key = p_key), p_default);
$function$
;

CREATE OR REPLACE FUNCTION app_private.settings_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_old jsonb;
begin
  if tg_op = 'DELETE' then
    if old.key = 'slip_verify' and auth.uid() is not null
       and not public.admin_can('bank_verify_switch') then
      raise exception 'ลบค่าตั้งค่าการยืนยันสลิปกับธนาคารได้เฉพาะผู้ดูแลระดับสูงสุด'
        using errcode = '42501';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and new.key is distinct from old.key and auth.uid() is not null then
    raise exception 'เปลี่ยนชื่อคีย์ของค่าตั้งค่าไม่ได้' using errcode = '42501';
  end if;

  if new.key = 'slip_check' and new.value ? 'bank_verify' then
    new.value := new.value - 'bank_verify';
  end if;

  if new.key = 'slip_verify' then
    new.is_public := false;

    if auth.uid() is not null and not public.admin_can('bank_verify_switch') then
      v_old := case when tg_op = 'UPDATE' and old.key = 'slip_verify'
                    then old.value else '{}'::jsonb end;

      if (new.value - 'auto_approve_on_verified') is distinct from
         (v_old - 'auto_approve_on_verified') then
        raise exception 'เปลี่ยนเกณฑ์การยืนยันสลิปกับธนาคารได้เฉพาะผู้ดูแลระดับสูงสุด'
          using errcode = '42501';
      end if;

      if (new.value -> 'auto_approve_on_verified') is distinct from
         (v_old -> 'auto_approve_on_verified')
         and not public.admin_can('slip_auto_approve') then
        raise exception 'บัญชีผู้ดูแลของท่านไม่มีสิทธิ์เปิด/ปิดการออกใบสำคัญรับเงินอัตโนมัติ'
          using errcode = '42501';
      end if;
    end if;
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.slip_server_check(p_uid uuid, p_fee numeric, p_amount numeric, p_paid_at timestamp with time zone, p_slip_path text, p_slip_sha256 text, p_ref text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'storage', 'pg_temp'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION app_private.thai_read_int(p_n bigint)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'app_private', 'pg_catalog', 'pg_temp'
AS $function$
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
end; $function$
;

CREATE OR REPLACE FUNCTION public.admin_can(p_area text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select exists (
    select 1 from public.admins a
    where a.user_id = auth.uid()
      and a.active
      and (
        -- ผู้ดูแลระดับสูงสุด เข้าได้ทุกพื้นที่
        a.role = 'superadmin'
        -- ภาพรวม เปิดให้ผู้ดูแลทุกบทบาท
        or p_area = 'dashboard'
        or (p_area = 'settings'      and a.role = 'admin')
        -- ประชาสัมพันธ์ เปิดให้ผู้ที่ทำทั้งงานทะเบียนและงานการเงินดูแลได้ด้วย
        or (p_area = 'announcements' and a.role in ('admin', 'registrar_treasurer'))
        -- ช่องลงนามในเอกสาร แยกสิทธิ์ตามหน้าที่
        --   ช่องลงนามประธานชมรม (พิมพ์บนบัตรสมาชิก) เป็นงานของนายทะเบียน
        --   ช่องผู้ลงนามในใบสำคัญรับเงิน เป็นงานของเจ้าหน้าที่การเงิน
        --   ผู้ที่ทำทั้งสองหน้าที่จึงดูแลได้ทั้งสองช่อง
        or (p_area = 'signatory_president' and a.role in ('admin', 'registrar', 'registrar_treasurer'))
        or (p_area = 'signatory_receipt'   and a.role in ('admin', 'treasurer', 'registrar_treasurer'))
        -- หน้าผู้ลงนามในเอกสาร เปิดให้ผู้ที่ดูแลได้อย่างน้อยหนึ่งช่อง
        or (p_area = 'signatories' and a.role in ('admin', 'registrar', 'treasurer', 'registrar_treasurer'))
        or (p_area = 'applications'  and a.role in ('admin', 'registrar', 'registrar_treasurer'))
        or (p_area = 'payments'      and a.role in ('admin', 'treasurer', 'registrar_treasurer'))
        -- เปิด/ปิดการออกใบสำคัญรับเงินอัตโนมัติ เป็นของผู้ที่มีหน้าที่ตรวจสลิป
        -- เพราะเป็นงานของคนกลุ่มนี้ที่สวิตช์นี้ทำแทน
        or (p_area = 'slip_auto_approve' and a.role in ('admin', 'treasurer', 'registrar_treasurer'))
        or (p_area = 'members'       and a.role in ('admin', 'registrar', 'treasurer', 'registrar_treasurer'))
        or (p_area = 'audit'         and a.role in ('admin', 'registrar', 'treasurer', 'registrar_treasurer'))
        -- admin_accounts และ slip_override ไม่มีในรายการนี้โดยเจตนา
        -- จึงเป็นจริงได้เฉพาะกับผู้ดูแลระดับสูงสุดในเงื่อนไขข้อแรก
      )
  );
$function$
;

CREATE OR REPLACE FUNCTION public.admin_decide_application(p_app_id uuid, p_approve boolean, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
declare
  v_app public.applications; v_m public.members; v_card public.cards;
  v_from date; v_to date; v_code text; v_years int;
begin
  perform app_private.require_area('applications');

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
end; $function$
;

CREATE OR REPLACE FUNCTION public.admin_delete_member(p_member_id uuid, p_reason text, p_confirm_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
declare
  v_m public.members;
  v_expected text; v_given text;
  v_cards int; v_receipts int; v_payments int;
begin
  perform app_private.require_admin(array['superadmin']);

  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'กรุณาระบุเหตุผลในการลบข้อมูลสมาชิก' using errcode = '22023';
  end if;

  select * into v_m from public.members m where m.id = p_member_id;
  if v_m.id is null then
    raise exception 'ไม่พบข้อมูลสมาชิก' using errcode = 'P0002';
  end if;

  -- ต้องพิมพ์ชื่อ-นามสกุลให้ตรง จึงจะลบได้ (กันการกดพลาด)
  v_expected := lower(regexp_replace(v_m.first_name || v_m.last_name, '\s', '', 'g'));
  v_given    := lower(regexp_replace(coalesce(p_confirm_name, ''), '\s', '', 'g'));
  if v_given <> v_expected then
    raise exception
      'การลบต้องพิมพ์ชื่อ-นามสกุลของสมาชิกให้ตรงเพื่อยืนยัน (ต้องพิมพ์ว่า "% %")',
      v_m.first_name, v_m.last_name
      using errcode = '22023';
  end if;

  select count(*) into v_receipts from public.receipts r where r.member_id = p_member_id;
  select count(*) into v_cards    from public.cards c    where c.member_id = p_member_id;
  select count(*) into v_payments from public.payments p where p.member_id = p_member_id;

  -- เคยออกใบสำคัญรับเงิน = เป็นหลักฐานทางการเงิน ห้ามลบ
  if v_receipts > 0 then
    raise exception
      'สมาชิกรายนี้มีใบสำคัญรับเงิน % ฉบับ ซึ่งเป็นหลักฐานทางการเงินที่ต้องเก็บรักษา '
      'จึงลบไม่ได้ หากต้องการยุติสมาชิกภาพ ให้ใช้ "ยกเลิกบัตร/สมาชิกภาพ" แทน',
      v_receipts using errcode = '23503';
  end if;

  -- เคยออกบัตรแล้ว = เป็นสมาชิกจริง ควรยกเลิกไม่ใช่ลบ
  if v_cards > 0 then
    raise exception
      'สมาชิกรายนี้เคยได้รับบัตรสมาชิกแล้ว (% ใบ) จึงลบไม่ได้ '
      'หากต้องการยุติสมาชิกภาพ ให้ใช้ "ยกเลิกบัตร/สมาชิกภาพ" แทน '
      'เพื่อคงประวัติไว้ตรวจสอบได้',
      v_cards using errcode = '23503';
  end if;

  perform app_private.log_audit('delete_member', 'members', p_member_id::text,
    btrim(coalesce(v_m.title,'') || ' ' || v_m.first_name || ' ' || v_m.last_name) ||
    coalesce(' (' || v_m.member_code || ')', ''),
    jsonb_build_object('member_code', v_m.member_code, 'status', v_m.status,
                       'payments_deleted', v_payments),
    'ลบข้อมูลสมาชิก เหตุผล: ' || btrim(p_reason));

  delete from public.members m where m.id = p_member_id;
  return jsonb_build_object('ok', true, 'payments_deleted', v_payments);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_expire_memberships()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
declare v_m int; v_c int;
begin
  perform app_private.require_area('members');
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
end; $function$
;

CREATE OR REPLACE FUNCTION public.admin_export_members(p_include_pii boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
declare v_rows jsonb; v_n int;
begin
  perform app_private.require_area('members');

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
end; $function$
;

CREATE OR REPLACE FUNCTION public.admin_grant_admin(p_email text, p_role text DEFAULT 'admin'::text, p_full_name text DEFAULT NULL::text, p_position text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
declare
  v_uid uuid;
begin
  perform app_private.require_admin(array['superadmin']);
  -- ไม่มีรายชื่อบทบาทเขียนไว้ที่นี่แล้ว constraint ของตารางเป็นแหล่งความจริงเดียว
  if p_role is null or btrim(p_role) = '' then
    raise exception 'ต้องเลือกบทบาทของผู้ดูแล' using errcode = '22023';
  end if;
  select u.id into v_uid from auth.users u where lower(u.email) = lower(btrim(p_email));
  if v_uid is null then
    raise exception 'ไม่พบบัญชีผู้ใช้อีเมล % (ผู้ใช้ต้องสมัครใช้งานระบบก่อน)', p_email
      using errcode = 'P0002';
  end if;
  begin
    insert into public.admins (user_id, role, full_name, position, created_by)
    values (v_uid, p_role, nullif(btrim(coalesce(p_full_name,'')),''),
            nullif(btrim(coalesce(p_position,'')),''), auth.uid())
    on conflict (user_id) do update
      set role = excluded.role, active = true,
          full_name = coalesce(excluded.full_name, admins.full_name),
          position  = coalesce(excluded.position, admins.position);
  exception
    when check_violation then
      raise exception 'บทบาทไม่ถูกต้อง: %', p_role using errcode = '22023';
  end;
  return jsonb_build_object('ok', true, 'user_id', v_uid, 'role', p_role);
end; $function$
;

CREATE OR REPLACE FUNCTION public.admin_menu()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select jsonb_build_object(
    'role',           public.admin_role(),
    'dashboard',      public.admin_can('dashboard'),
    'applications',   public.admin_can('applications'),
    'payments',       public.admin_can('payments'),
    'members',        public.admin_can('members'),
    'audit',          public.admin_can('audit'),
    'announcements',  public.admin_can('announcements'),
    'signatories',         public.admin_can('signatories'),
    'signatory_president', public.admin_can('signatory_president'),
    'signatory_receipt',   public.admin_can('signatory_receipt'),
    'settings',       public.admin_can('settings'),
    'admin_accounts', public.admin_can('admin_accounts'),
    'slip_override',  public.admin_can('slip_override'),
    'slip_auto_approve',  public.admin_can('slip_auto_approve'),
    'bank_verify_switch', public.admin_can('bank_verify_switch')
  );
$function$
;

CREATE OR REPLACE FUNCTION public.admin_pin_announcement(p_id uuid, p_pinned boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
declare v_row public.announcements;
begin
  perform app_private.require_area('announcements');

  select * into v_row from public.announcements where id = p_id;
  if v_row.id is null then
    raise exception 'ไม่พบประกาศที่ต้องการ' using errcode = 'P0002';
  end if;
  if coalesce(p_pinned, false) and v_row.status <> 'published' then
    raise exception 'ปักหมุดได้เฉพาะประกาศที่เผยแพร่แล้ว' using errcode = '22023';
  end if;

  update public.announcements a
     set pinned = coalesce(p_pinned, false), updated_by = auth.uid()
   where a.id = p_id
  returning * into v_row;

  perform app_private.log_audit('update', 'announcements', v_row.id::text, v_row.title,
    jsonb_build_object('pinned', coalesce(p_pinned, false)),
    case when coalesce(p_pinned, false) then 'ปักหมุดประกาศ' else 'เลิกปักหมุดประกาศ' end);

  return to_jsonb(v_row);
end; $function$
;

CREATE OR REPLACE FUNCTION public.admin_reissue_card(p_member_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
declare v_m public.members; v_card public.cards;
begin
  perform app_private.require_area('members');
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
end; $function$
;

CREATE OR REPLACE FUNCTION public.admin_replace_slip(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
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
end; $function$
;

CREATE OR REPLACE FUNCTION public.admin_review_payment(p_payment_id uuid, p_approve boolean, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
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
      -- มีคำขออื่นอนุมัติไปก่อนหน้าเสี้ยววินาที
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
end; $function$
;

CREATE OR REPLACE FUNCTION public.admin_revoke_admin(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
begin
  perform app_private.require_admin(array['superadmin']);
  if p_user_id = auth.uid() then
    raise exception 'ไม่สามารถยกเลิกสิทธิ์ผู้ดูแลของตนเองได้' using errcode = '55000';
  end if;
  update public.admins a set active = false where a.user_id = p_user_id;
  return jsonb_build_object('ok', true);
end; $function$
;

CREATE OR REPLACE FUNCTION public.admin_revoke_card(p_card_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
declare v_c public.cards;
begin
  perform app_private.require_area('members');
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
end; $function$
;

CREATE OR REPLACE FUNCTION public.admin_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select a.role from public.admins a
  where a.user_id = auth.uid() and a.active limit 1;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_save_announcement(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
declare
  v_id    uuid := nullif(p->>'id', '')::uuid;
  v_title text := btrim(coalesce(p->>'title', ''));
  v_body  text := btrim(coalesce(p->>'body', ''));
  v_date  date := nullif(p->>'event_date', '')::date;
  v_row   public.announcements;
  v_new   boolean := v_id is null;
begin
  perform app_private.require_area('announcements');

  if v_title = '' then
    raise exception 'ต้องกรอกหัวข้อประกาศ' using errcode = '22023';
  end if;
  if v_body = '' then
    raise exception 'ต้องกรอกรายละเอียดประกาศ' using errcode = '22023';
  end if;
  if length(v_title) > 200 then
    raise exception 'หัวข้อประกาศยาวเกิน 200 ตัวอักษร' using errcode = '22023';
  end if;
  if length(v_body) > 20000 then
    raise exception 'รายละเอียดประกาศยาวเกิน 20,000 ตัวอักษร' using errcode = '22023';
  end if;

  if v_new then
    insert into public.announcements (title, body, event_date, created_by, updated_by)
    values (v_title, v_body, v_date, auth.uid(), auth.uid())
    returning * into v_row;
  else
    update public.announcements a
       set title = v_title, body = v_body, event_date = v_date, updated_by = auth.uid()
     where a.id = v_id
    returning * into v_row;
    if v_row.id is null then
      raise exception 'ไม่พบประกาศที่ต้องการแก้ไข' using errcode = 'P0002';
    end if;
  end if;

  perform app_private.log_audit(
    case when v_new then 'insert' else 'update' end,
    'announcements', v_row.id::text, v_row.title, null,
    case when v_new then 'สร้างประกาศฉบับร่าง' else 'แก้ไขเนื้อหาประกาศ' end);

  return to_jsonb(v_row);
end; $function$
;

CREATE OR REPLACE FUNCTION public.admin_save_signatories(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
/*
 * บันทึกช่องลงนามในเอกสาร โดยตรวจสิทธิ์แยกทีละช่อง
 *
 * ต้องมีฟังก์ชันนี้ ไม่ใช่ให้เขียนตาราง settings ตรง ๆ
 * เพราะนโยบายเขียนตาราง settings เป็นแบบทั้งตาราง ถ้าเปิดให้นายทะเบียน
 * หรือเจ้าหน้าที่การเงินเขียนได้ จะเขียนทับค่าอื่นได้หมด ทั้งเลขบัญชีธนาคาร
 * ค่าธรรมเนียม และเกณฑ์ตรวจสลิป ฟังก์ชันนี้จึงแก้ได้เฉพาะคีย์ signatories
 * และเฉพาะช่องที่ผู้เรียกมีสิทธิ์จริง
 *
 * ส่งมาเฉพาะช่องที่ต้องการแก้ ช่องที่ไม่ได้ส่งมาจะคงค่าเดิมไว้
 */
declare
  v_cur  jsonb;
  v_new  jsonb;
  v_chg  jsonb := '{}'::jsonb;
  v_pres boolean;
  v_rcpt boolean;
  v_txt  text;
  v_path text;
  -- อักขระล่องหนที่ติดมากับการคัดลอกวาง ต้องล้างออกก่อนเก็บ
  v_zero text := chr(8203) || chr(8204) || chr(8205) || chr(65279);
begin
  perform app_private.require_area('signatories');
  v_pres := public.admin_can('signatory_president');
  v_rcpt := public.admin_can('signatory_receipt');

  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'ข้อมูลที่ส่งมาไม่ถูกต้อง' using errcode = '22023';
  end if;

  select value into v_cur from public.settings where key = 'signatories';
  if v_cur is null then
    v_cur := jsonb_build_object(
      'president_name', '', 'president_position', '', 'president_signature_path', '',
      'receipt_name', '', 'receipt_signature_path', '');
  end if;
  v_new := v_cur;

  /* ---------- ช่องลงนามประธานชมรม ---------- */
  if p ?| array['president_name', 'president_position', 'president_signature_path'] then
    if not v_pres then
      raise exception 'บัญชีผู้ดูแลของท่านไม่มีสิทธิ์แก้ไขช่องลงนามประธานชมรม'
        using errcode = '42501';
    end if;

    if p ? 'president_name' then
      v_txt := btrim(translate(coalesce(p->>'president_name', ''), v_zero, ''));
      if length(v_txt) > 160 then
        raise exception 'ชื่อประธานชมรมยาวเกิน 160 ตัวอักษร' using errcode = '22023';
      end if;
      v_new := jsonb_set(v_new, '{president_name}', to_jsonb(v_txt));
    end if;

    if p ? 'president_position' then
      v_txt := btrim(translate(coalesce(p->>'president_position', ''), v_zero, ''));
      if length(v_txt) > 160 then
        raise exception 'ตำแหน่งประธานชมรมยาวเกิน 160 ตัวอักษร' using errcode = '22023';
      end if;
      v_new := jsonb_set(v_new, '{president_position}', to_jsonb(v_txt));
    end if;

    if p ? 'president_signature_path' then
      v_path := btrim(coalesce(p->>'president_signature_path', ''));
      -- ต้องเป็นไฟล์ของช่องประธานเท่านั้น กันการชี้ไปใช้ลายเซ็นของอีกช่องหนึ่ง
      if v_path <> '' and v_path !~ '^club/president-[0-9]+\.(png|jpg|jpeg|webp)$' then
        raise exception 'เส้นทางไฟล์ลายเซ็นประธานชมรมไม่ถูกต้อง' using errcode = '22023';
      end if;
      v_new := jsonb_set(v_new, '{president_signature_path}', to_jsonb(v_path));
    end if;
  end if;

  /* ---------- ช่องผู้ลงนามในใบสำคัญรับเงิน ---------- */
  if p ?| array['receipt_name', 'receipt_signature_path'] then
    if not v_rcpt then
      raise exception 'บัญชีผู้ดูแลของท่านไม่มีสิทธิ์แก้ไขช่องผู้ลงนามในใบสำคัญรับเงิน'
        using errcode = '42501';
    end if;

    if p ? 'receipt_name' then
      v_txt := btrim(translate(coalesce(p->>'receipt_name', ''), v_zero, ''));
      if length(v_txt) > 160 then
        raise exception 'ชื่อผู้ลงนามในใบสำคัญรับเงินยาวเกิน 160 ตัวอักษร' using errcode = '22023';
      end if;
      v_new := jsonb_set(v_new, '{receipt_name}', to_jsonb(v_txt));
    end if;

    if p ? 'receipt_signature_path' then
      v_path := btrim(coalesce(p->>'receipt_signature_path', ''));
      if v_path <> '' and v_path !~ '^club/receipt-[0-9]+\.(png|jpg|jpeg|webp)$' then
        raise exception 'เส้นทางไฟล์ลายเซ็นผู้ลงนามในใบสำคัญรับเงินไม่ถูกต้อง' using errcode = '22023';
      end if;
      v_new := jsonb_set(v_new, '{receipt_signature_path}', to_jsonb(v_path));
    end if;
  end if;

  if v_new = v_cur then
    return v_new;
  end if;

  select jsonb_object_agg(k, jsonb_build_object('เดิม', v_cur->k, 'ใหม่', v_new->k))
    into v_chg
    from jsonb_object_keys(v_new) k
   where v_cur->k is distinct from v_new->k;

  update public.settings
     set value = v_new, updated_at = now(), updated_by = auth.uid()
   where key = 'signatories';

  perform app_private.log_audit(
    'settings_change', 'settings', 'signatories', 'ช่องลงนามในเอกสาร',
    v_chg, 'แก้ไขผ่านหน้าผู้ลงนามในเอกสาร');

  return v_new;
end
$function$
;

CREATE OR REPLACE FUNCTION public.admin_save_slip_verify(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
/*
 * แก้ได้สองคีย์เท่านั้น และแต่ละคีย์ต้องมีสิทธิ์ของตัวเอง
 *   auto_approve_on_verified  ต้องมีพื้นที่ slip_auto_approve
 *   enabled                   ต้องมีพื้นที่ bank_verify_switch (ผู้ดูแลระดับสูงสุดเท่านั้น)
 * ค่าอื่นในแถว (require_account_match ฯลฯ) คงไว้ตามเดิมเสมอ
 *
 * รวมค่าในฐานข้อมูลด้วย jsonb_set ไม่ได้เขียนทับทั้งแถวจากค่าที่หน้าเว็บถือไว้
 * สองคนแก้คนละคีย์พร้อมกันจึงไม่ทับกัน
 * ทริกเกอร์ settings_guard ตรวจสิทธิ์ชุดเดียวกันซ้ำที่ตัวแถวอีกชั้น
 */
declare
  v_cur jsonb;
  v_new jsonb;
  v_chg jsonb;
  v_key text;
begin
  perform app_private.require_area('slip_auto_approve');

  if p is null or jsonb_typeof(p) <> 'object' or p = '{}'::jsonb then
    raise exception 'ข้อมูลที่ส่งมาไม่ถูกต้อง' using errcode = '22023';
  end if;

  for v_key in select jsonb_object_keys(p) loop
    if v_key not in ('auto_approve_on_verified', 'enabled') then
      raise exception 'แก้ค่า % ผ่านช่องทางนี้ไม่ได้', v_key using errcode = '22023';
    end if;
    if jsonb_typeof(p -> v_key) <> 'boolean' then
      raise exception 'ค่า % ต้องเป็นจริงหรือเท็จ', v_key using errcode = '22023';
    end if;
  end loop;

  if p ? 'enabled' and not public.admin_can('bank_verify_switch') then
    raise exception 'เปิด/ปิดการยืนยันสลิปกับธนาคารได้เฉพาะผู้ดูแลระดับสูงสุด'
      using errcode = '42501';
  end if;

  select s.value into v_cur from public.settings s where s.key = 'slip_verify' for update;
  if v_cur is null then
    raise exception 'ไม่พบค่าตั้งค่าการยืนยันสลิปกับธนาคาร' using errcode = 'P0002';
  end if;

  v_new := v_cur;
  for v_key in select jsonb_object_keys(p) loop
    v_new := jsonb_set(v_new, array[v_key], p -> v_key);
  end loop;

  if v_new = v_cur then
    return v_new;
  end if;

  select jsonb_object_agg(k, jsonb_build_object('เดิม', v_cur -> k, 'ใหม่', v_new -> k))
    into v_chg
    from jsonb_object_keys(v_new) k
   where v_cur -> k is distinct from v_new -> k;

  update public.settings
     set value = v_new, updated_at = now(), updated_by = auth.uid()
   where key = 'slip_verify';

  perform app_private.log_audit(
    'settings_change', 'settings', 'slip_verify', 'การยืนยันสลิปกับธนาคาร',
    v_chg,
    case
      when v_new -> 'auto_approve_on_verified' is distinct from v_cur -> 'auto_approve_on_verified'
        then case when (v_new ->> 'auto_approve_on_verified')::boolean
                  then 'เปิดการออกใบสำคัญรับเงินอัตโนมัติ'
                  else 'ปิดการออกใบสำคัญรับเงินอัตโนมัติ' end
      else case when (v_new ->> 'enabled')::boolean
                then 'เปิดการยืนยันสลิปกับธนาคาร'
                else 'ปิดการยืนยันสลิปกับธนาคาร' end
    end);

  return v_new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_set_announcement_status(p_id uuid, p_status text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
declare v_row public.announcements; v_old text;
begin
  perform app_private.require_area('announcements');

  if p_status is null or p_status not in ('draft', 'published', 'archived') then
    raise exception 'สถานะประกาศไม่ถูกต้อง: %', coalesce(p_status, '(ไม่ได้ระบุ)')
      using errcode = '22023';
  end if;

  select status into v_old from public.announcements where id = p_id;
  if v_old is null then
    raise exception 'ไม่พบประกาศที่ต้องการ' using errcode = 'P0002';
  end if;

  update public.announcements a
     set status = p_status,
         updated_by = auth.uid(),
         -- จำเวลาเผยแพร่ครั้งแรกไว้ การนำกลับมาเผยแพร่ใหม่ไม่เปลี่ยนเวลาเดิม
         published_at = case
                          when p_status = 'published' and a.published_at is null then now()
                          else a.published_at
                        end,
         -- ประกาศที่ไม่ได้เผยแพร่ ไม่ควรค้างสถานะปักหมุดไว้
         pinned = case when p_status = 'published' then a.pinned else false end
   where a.id = p_id
  returning * into v_row;

  perform app_private.log_audit('update', 'announcements', v_row.id::text, v_row.title,
    jsonb_build_object('status', jsonb_build_object('from', v_old, 'to', p_status)),
    case p_status
      when 'published' then 'เผยแพร่ประกาศ'
      when 'archived'  then 'เก็บประกาศเข้าคลัง'
      else 'เปลี่ยนประกาศกลับเป็นฉบับร่าง'
    end);

  return to_jsonb(v_row);
end; $function$
;

CREATE OR REPLACE FUNCTION public.admin_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
begin
  perform app_private.require_area('dashboard');
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
end; $function$
;

CREATE OR REPLACE FUNCTION public.admin_system_health()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
declare v_enc jsonb;
begin
  perform app_private.require_area('dashboard');
  v_enc := app_private.check_encryption();
  return jsonb_build_object(
    'encryption', v_enc,
    'counts', jsonb_build_object(
      'members',      (select count(*) from public.members),
      'applications', (select count(*) from public.applications),
      'payments',     (select count(*) from public.payments),
      'receipts',     (select count(*) from public.receipts),
      'cards',        (select count(*) from public.cards),
      'consents',     (select count(*) from public.consents),
      'audit_log',    (select count(*) from public.audit_log),
      'admins',       (select count(*) from public.admins where active)
    ),
    'oldest_audit', (select min(at) from public.audit_log),
    'latest_audit', (select max(at) from public.audit_log),
    'protections', jsonb_build_object(
      'audit_log_append_only', exists (
        select 1 from pg_trigger where tgname = 'trg_audit_log_append_only' and not tgisinternal),
      'receipts_block_member_delete', true,
      'delete_requires_name_confirmation', true,
      'consents_survive_member_delete', true
    ),
    'checked_at', now()
  );
end;
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public.audit_keyed_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
declare
  v_old jsonb; v_new jsonb; v_changed jsonb;
  v_key text; v_action text;
begin
  if tg_op = 'INSERT' then
    v_action := 'insert'; v_new := to_jsonb(new); v_old := '{}'::jsonb;
  elsif tg_op = 'UPDATE' then
    v_action := 'update'; v_new := to_jsonb(new); v_old := to_jsonb(old);
  else
    v_action := 'delete'; v_new := '{}'::jsonb; v_old := to_jsonb(old);
  end if;

  v_key := coalesce(v_new ->> 'key', v_old ->> 'key', v_new ->> 'code', v_old ->> 'code');

  select jsonb_object_agg(k, jsonb_build_object('from', v_old -> k, 'to', v_new -> k))
    into v_changed
  from (
    select key as k from jsonb_each(v_old)
    union
    select key as k from jsonb_each(v_new)
  ) keys
  where (v_old -> k) is distinct from (v_new -> k)
    and k not in ('updated_at', 'updated_by');

  if v_changed is null or v_changed = '{}'::jsonb then
    return coalesce(new, old);
  end if;

  perform app_private.log_audit(v_action, tg_table_name, v_key, v_key, v_changed, null);
  return coalesce(new, old);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.audit_row_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
declare
  v_old jsonb; v_new jsonb; v_changed jsonb;
  v_label text; v_id text; v_action text;
  v_masked text[] := array['national_id_enc','phone_enc','addr_detail_enc',
                           'national_id_bidx','phone_bidx'];
begin
  if tg_op = 'INSERT' then
    v_action := 'insert'; v_new := to_jsonb(new); v_old := '{}'::jsonb;
  elsif tg_op = 'UPDATE' then
    v_action := 'update'; v_new := to_jsonb(new); v_old := to_jsonb(old);
  else
    v_action := 'delete'; v_new := '{}'::jsonb; v_old := to_jsonb(old);
  end if;

  select jsonb_object_agg(
           k,
           case when k = any (v_masked) then jsonb_build_object('changed', true)
                else jsonb_build_object('from', v_old -> k, 'to', v_new -> k) end
         )
    into v_changed
  from (
    select key as k from jsonb_each(v_old)
    union
    select key as k from jsonb_each(v_new)
  ) keys
  where (v_old -> k) is distinct from (v_new -> k)
    and k not in ('updated_at','created_at','updated_by');

  if v_changed is null or v_changed = '{}'::jsonb then
    return coalesce(new, old);
  end if;

  v_id := coalesce(v_new ->> 'id', v_old ->> 'id');
  v_label := case tg_table_name
    when 'members' then
      btrim(coalesce(v_new ->> 'title', v_old ->> 'title', '') || ' ' ||
            coalesce(v_new ->> 'first_name', v_old ->> 'first_name', '') || ' ' ||
            coalesce(v_new ->> 'last_name', v_old ->> 'last_name', '')) ||
      coalesce(' (' || (v_new ->> 'member_code') || ')', '')
    when 'applications' then coalesce(v_new ->> 'app_no', v_old ->> 'app_no')
    when 'payments'     then 'ชำระเงิน ' || coalesce(v_new ->> 'amount', v_old ->> 'amount') || ' บาท'
    when 'cards'        then coalesce(v_new ->> 'card_no', v_old ->> 'card_no')
    when 'receipts'     then coalesce(v_new ->> 'receipt_no', v_old ->> 'receipt_no')
    when 'admins'       then coalesce(v_new ->> 'full_name', v_old ->> 'full_name')
    else null
  end;

  perform app_private.log_audit(
    v_action, tg_table_name, v_id, nullif(btrim(coalesce(v_label,'')), ''), v_changed, null);

  return coalesce(new, old);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_member_pii(p_member_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
declare
  v_m public.members;
begin
  select * into v_m from public.members m where m.id = p_member_id;
  if v_m.id is null then
    raise exception 'ไม่พบข้อมูลสมาชิก' using errcode = 'P0002';
  end if;

  if not (v_m.user_id = auth.uid() or public.admin_can('members')) then
    raise exception 'ไม่มีสิทธิ์เข้าถึงข้อมูลนี้' using errcode = '42501';
  end if;

  -- ผู้ดูแลที่เปิดดูข้อมูลอ่อนไหวของผู้อื่นจะถูกบันทึกไว้ใน log
  if v_m.user_id <> auth.uid() then
    perform app_private.log_audit(
      'read_pii', 'members', v_m.id::text,
      btrim(coalesce(v_m.title, '') || ' ' || v_m.first_name || ' ' || v_m.last_name),
      null, 'เปิดดูข้อมูลส่วนบุคคลที่เข้ารหัส'
    );
  end if;

  return jsonb_build_object(
    'national_id', app_private.decrypt_pii(v_m.national_id_enc),
    'phone',       app_private.decrypt_pii(v_m.phone_enc),
    'addr_detail', app_private.decrypt_pii(v_m.addr_detail_enc),
    'work_addr_detail', app_private.decrypt_pii(v_m.work_addr_detail_enc)
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_my_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_legal   jsonb;
  v_terms   text;
  v_privacy text;
  v_ua      text;
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''))
  on conflict (id) do update
    set email = excluded.email,
        full_name = coalesce(excluded.full_name, public.profiles.full_name);

  -- บันทึกความยินยอมเมื่อหน้าสมัครยืนยันมาว่าผู้ใช้ติ๊กยอมรับแล้ว
  -- เลขรุ่นเอกสารอ่านจาก settings ฝั่งเซิร์ฟเวอร์ ไม่รับจากผู้ใช้ กันการปลอมเลขรุ่น
  if coalesce(new.raw_user_meta_data ->> 'consented', '') = 'true' then
    begin
      v_legal   := app_private.setting('legal', '{}'::jsonb);
      v_terms   := coalesce(v_legal ->> 'terms_version', '1.0');
      v_privacy := coalesce(v_legal ->> 'privacy_version', '1.0');
      v_ua      := left(nullif(btrim(coalesce(new.raw_user_meta_data ->> 'consent_user_agent', '')), ''), 500);

      insert into public.consents (user_id, doc, version, accepted, user_agent)
      values (new.id, 'terms',   v_terms,   true, v_ua),
             (new.id, 'privacy', v_privacy, true, v_ua);
    exception when others then
      -- ห้ามให้การสมัครล้มเหลวเพราะบันทึกความยินยอมไม่ได้
      raise warning 'บันทึกความยินยอมของผู้ใช้ % ไม่สำเร็จ: %', new.id, sqlerrm;
    end;
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.has_admin_role(p_roles text[])
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select exists (
    select 1 from public.admins a
    where a.user_id = auth.uid() and a.active
      and (a.role = 'superadmin' or a.role = any (p_roles))
  );
$function$
;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select exists (select 1 from public.admins a where a.user_id = auth.uid() and a.active);
$function$
;

CREATE OR REPLACE FUNCTION public.log_client_event(p_action text, p_entity text DEFAULT NULL::text, p_entity_id text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then return; end if;
  if p_action not in ('print_card','print_receipt','export_excel',
                      'login','logout','download_slip','view_member') then
    raise exception 'ชนิดเหตุการณ์ไม่ถูกต้อง' using errcode = '22023';
  end if;
  perform app_private.log_audit(p_action,
    coalesce(nullif(btrim(coalesce(p_entity, '')), ''), 'system'),
    p_entity_id, null, null, left(coalesce(p_note, ''), 500));
end; $function$
;

CREATE OR REPLACE FUNCTION public.record_card_print(p_card_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
declare v_c public.cards; v_m public.members;
begin
  select * into v_c from public.cards c where c.id = p_card_id;
  if v_c.id is null then
    raise exception 'ไม่พบบัตรสมาชิก' using errcode = 'P0002';
  end if;
  select * into v_m from public.members m where m.id = v_c.member_id;
  if not (v_m.user_id = auth.uid() or public.admin_can('members')) then
    raise exception 'ไม่มีสิทธิ์พิมพ์บัตรใบนี้' using errcode = '42501';
  end if;
  if v_c.status <> 'active' then
    raise exception 'บัตรใบนี้ถูกยกเลิก/แทนที่แล้ว ไม่สามารถพิมพ์ได้' using errcode = '55000';
  end if;
  update public.cards c set print_count = c.print_count + 1, last_printed_at = now()
   where c.id = p_card_id;
end; $function$
;

CREATE OR REPLACE FUNCTION public.record_slip_verification(p_payment_id uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
declare
  v_pay    public.payments;
  v_status text := nullif(btrim(coalesce(p ->> 'status', '')), '');
  v_ref    text := nullif(btrim(coalesce(p ->> 'bank_ref', '')), '');
  v_slip   jsonb := app_private.setting('slip_check', '{}'::jsonb);
  v_cfg    jsonb := coalesce(app_private.setting('slip_verify'), v_slip -> 'bank_verify', '{}'::jsonb);
  v_auto   boolean := coalesce((v_cfg ->> 'auto_reject_on_mismatch')::boolean, false);
  v_approve boolean := coalesce((v_cfg ->> 'auto_approve_on_verified')::boolean, true);
  v_tol    numeric := coalesce((v_slip ->> 'allow_amount_tolerance')::numeric, 0);
  v_fee    numeric;
  v_res    jsonb;
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

  -- เลขอ้างอิงจากธนาคารต้องไม่ถูกใช้กับรายการอื่นมาก่อน
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
   * จึงรับข้อผิดพลาดไว้แล้วปล่อยให้เจ้าหน้าที่ตรวจเองตามปกติ
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
end; $function$
;

CREATE OR REPLACE FUNCTION public.submit_application()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
declare
  v_uid    uuid := auth.uid();
  v_m      public.members;
  v_type   text;
  v_fee    numeric;
  v_years  int;
  v_app    public.applications;
  v_fees   jsonb;
begin
  if v_uid is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน' using errcode = '28000';
  end if;

  select * into v_m from public.members m where m.user_id = v_uid;
  if v_m.id is null then
    raise exception 'ไม่พบข้อมูลผู้สมัคร กรุณากรอกใบสมัครก่อน' using errcode = 'P0002';
  end if;

  -- ตรวจความครบถ้วนของข้อมูลที่จำเป็น
  if v_m.national_id_enc is null then
    raise exception 'กรุณากรอกเลขประจำตัวประชาชน' using errcode = '22023';
  end if;
  if v_m.org_type_code is null then
    raise exception 'กรุณาเลือกประเภทหน่วยงาน' using errcode = '22023';
  end if;
  if v_m.addr_tambon is null or v_m.addr_amphoe is null then
    raise exception 'กรุณากรอกที่อยู่ที่ติดต่อได้ให้ครบถ้วน' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.applications a
    where a.member_id = v_m.id
      and a.status in ('draft','submitted','awaiting_payment','payment_submitted','payment_verified')
  ) then
    raise exception 'มีใบสมัครที่กำลังดำเนินการอยู่แล้ว' using errcode = '23505';
  end if;

  v_type := case when v_m.status = 'active' or v_m.status = 'expired' then 'renew' else 'new' end;

  v_fees  := app_private.setting('fees', '{"new": 300, "renew": 200}'::jsonb);
  v_fee   := coalesce((v_fees ->> v_type)::numeric, 300);
  v_years := coalesce((app_private.setting('membership', '{"term_years": 1}'::jsonb) ->> 'term_years')::int, 1);

  insert into public.applications
    (member_id, app_no, app_type, status, fee_amount, term_years, submitted_at)
  values
    (v_m.id, app_private.gen_code('APP'), v_type, 'awaiting_payment', v_fee, v_years, now())
  returning * into v_app;

  return jsonb_build_object(
    'application_id', v_app.id,
    'app_no',         v_app.app_no,
    'app_type',       v_app.app_type,
    'status',         v_app.status,
    'fee_amount',     v_app.fee_amount,
    'term_years',     v_app.term_years
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.submit_payment(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
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
end; $function$
;

CREATE OR REPLACE FUNCTION public.touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
  new.updated_at := now();
  return new;
end;
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public.verify_card(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
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
end; $function$
;

-- ---------------------------------------------------------------------
-- Column defaults
-- ---------------------------------------------------------------------

alter table only app_private.counters alter column updated_at set default now();
alter table only app_private.counters alter column value set default 0;
alter table only app_private.crypto_canary alter column created_at set default now();
alter table only app_private.crypto_canary alter column id set default 1;
alter table only public.admins alter column active set default true;
alter table only public.admins alter column created_at set default now();
alter table only public.admins alter column role set default 'admin'::text;
alter table only public.announcements alter column created_at set default now();
alter table only public.announcements alter column id set default gen_random_uuid();
alter table only public.announcements alter column pinned set default false;
alter table only public.announcements alter column status set default 'draft'::text;
alter table only public.announcements alter column updated_at set default now();
alter table only public.applications alter column app_type set default 'new'::text;
alter table only public.applications alter column created_at set default now();
alter table only public.applications alter column fee_amount set default 0;
alter table only public.applications alter column id set default gen_random_uuid();
alter table only public.applications alter column status set default 'draft'::text;
alter table only public.applications alter column term_years set default 1;
alter table only public.applications alter column updated_at set default now();
alter table only public.audit_log alter column at set default now();
alter table only public.audit_log alter column id set default nextval('public.audit_log_id_seq'::regclass);
alter table only public.cards alter column created_at set default now();
alter table only public.cards alter column id set default gen_random_uuid();
alter table only public.cards alter column issued_at set default now();
alter table only public.cards alter column print_count set default 0;
alter table only public.cards alter column status set default 'active'::text;
alter table only public.cards alter column updated_at set default now();
alter table only public.consents alter column accepted set default true;
alter table only public.consents alter column accepted_at set default now();
alter table only public.consents alter column created_at set default now();
alter table only public.consents alter column id set default gen_random_uuid();
alter table only public.members alter column addr_province set default 'บุรีรัมย์'::text;
alter table only public.members alter column created_at set default now();
alter table only public.members alter column id set default gen_random_uuid();
alter table only public.members alter column status set default 'pending'::text;
alter table only public.members alter column updated_at set default now();
alter table only public.members alter column work_province set default 'บุรีรัมย์'::text;
alter table only public.org_types alter column active set default true;
alter table only public.org_types alter column requires_text set default false;
alter table only public.org_types alter column sort_order set default 100;
alter table only public.payments alter column bank_verify_status set default 'not_checked'::text;
alter table only public.payments alter column created_at set default now();
alter table only public.payments alter column id set default gen_random_uuid();
alter table only public.payments alter column status set default 'pending'::text;
alter table only public.payments alter column updated_at set default now();
alter table only public.profiles alter column created_at set default now();
alter table only public.profiles alter column updated_at set default now();
alter table only public.receipts alter column created_at set default now();
alter table only public.receipts alter column id set default gen_random_uuid();
alter table only public.receipts alter column issued_at set default now();
alter table only public.settings alter column is_public set default true;
alter table only public.settings alter column updated_at set default now();

-- ---------------------------------------------------------------------
-- Check constraints
-- ---------------------------------------------------------------------

alter table only app_private.crypto_canary add constraint crypto_canary_single_row CHECK ((id = 1));
alter table only public.admins add constraint admins_role_check CHECK ((role = ANY (ARRAY['superadmin'::text, 'admin'::text, 'registrar'::text, 'treasurer'::text, 'registrar_treasurer'::text])));
alter table only public.announcements add constraint announcements_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'archived'::text])));
alter table only public.applications add constraint applications_app_type_check CHECK ((app_type = ANY (ARRAY['new'::text, 'renew'::text])));
alter table only public.applications add constraint applications_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'submitted'::text, 'awaiting_payment'::text, 'payment_submitted'::text, 'payment_verified'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text])));
alter table only public.cards add constraint cards_period_valid CHECK ((valid_to >= valid_from));
alter table only public.cards add constraint cards_status_check CHECK ((status = ANY (ARRAY['active'::text, 'expired'::text, 'revoked'::text, 'replaced'::text])));
alter table only public.members add constraint members_gender_check CHECK (((gender IS NULL) OR (gender = ANY (ARRAY['ชาย'::text, 'หญิง'::text, 'ไม่ระบุ'::text]))));
alter table only public.members add constraint members_org_other_required CHECK (((org_type_code IS DISTINCT FROM 'other'::text) OR (NULLIF(btrim(COALESCE(org_type_other, ''::text)), ''::text) IS NOT NULL)));
alter table only public.members add constraint members_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'expired'::text, 'revoked'::text])));
alter table only public.members add constraint members_title_other_required CHECK (((title IS DISTINCT FROM 'อื่นๆ'::text) OR (NULLIF(btrim(COALESCE(title_other, ''::text)), ''::text) IS NOT NULL)));
alter table only public.payments add constraint payments_bank_verify_status_chk CHECK ((bank_verify_status = ANY (ARRAY['not_checked'::text, 'disabled'::text, 'verified'::text, 'mismatch'::text, 'not_found'::text, 'error'::text, 'duplicate'::text])));
alter table only public.payments add constraint payments_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'verified'::text, 'rejected'::text, 'duplicate'::text])));

-- ---------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------

alter table only public.admins add constraint admins_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table only public.admins add constraint admins_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table only public.applications add constraint applications_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.members(id) ON DELETE CASCADE;
alter table only public.applications add constraint applications_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table only public.cards add constraint cards_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE SET NULL;
alter table only public.cards add constraint cards_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.members(id) ON DELETE CASCADE;
alter table only public.consents add constraint consents_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.members(id) ON DELETE SET NULL;
alter table only public.consents add constraint consents_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table only public.members add constraint members_org_type_code_fkey FOREIGN KEY (org_type_code) REFERENCES public.org_types(code) ON DELETE SET NULL;
alter table only public.members add constraint members_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table only public.members add constraint members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;
alter table only public.payments add constraint payments_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;
alter table only public.payments add constraint payments_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.members(id) ON DELETE CASCADE;
alter table only public.payments add constraint payments_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table only public.profiles add constraint profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table only public.receipts add constraint receipts_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE RESTRICT;
alter table only public.receipts add constraint receipts_issued_by_fkey FOREIGN KEY (issued_by) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table only public.receipts add constraint receipts_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.members(id) ON DELETE RESTRICT;
alter table only public.receipts add constraint receipts_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id) ON DELETE RESTRICT;
alter table only public.settings add constraint settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------

CREATE INDEX announcements_feed_idx ON public.announcements USING btree (status, pinned DESC, published_at DESC NULLS LAST, created_at DESC);
CREATE INDEX applications_created_idx ON public.applications USING btree (created_at DESC);
CREATE INDEX applications_member_idx ON public.applications USING btree (member_id);
CREATE UNIQUE INDEX applications_one_open_per_member ON public.applications USING btree (member_id) WHERE (status = ANY (ARRAY['draft'::text, 'submitted'::text, 'awaiting_payment'::text, 'payment_submitted'::text, 'payment_verified'::text]));
CREATE INDEX applications_status_idx ON public.applications USING btree (status);
CREATE INDEX audit_log_actor_idx ON public.audit_log USING btree (actor_id);
CREATE INDEX audit_log_at_idx ON public.audit_log USING btree (at DESC);
CREATE INDEX audit_log_entity_idx ON public.audit_log USING btree (entity, entity_id);
CREATE INDEX cards_member_idx ON public.cards USING btree (member_id);
CREATE INDEX cards_status_idx ON public.cards USING btree (status);
CREATE INDEX consents_user_idx ON public.consents USING btree (user_id);
CREATE INDEX members_name_idx ON public.members USING btree (last_name, first_name);
CREATE INDEX members_org_type_idx ON public.members USING btree (org_type_code);
CREATE INDEX members_phone_bidx_idx ON public.members USING btree (phone_bidx);
CREATE INDEX members_status_idx ON public.members USING btree (status);
CREATE INDEX members_valid_to_idx ON public.members USING btree (valid_to);
CREATE INDEX payments_application_idx ON public.payments USING btree (application_id);
CREATE UNIQUE INDEX payments_bank_ref_uniq ON public.payments USING btree (bank_ref) WHERE ((bank_ref IS NOT NULL) AND (status <> 'rejected'::text));
CREATE INDEX payments_member_idx ON public.payments USING btree (member_id);
CREATE UNIQUE INDEX payments_ref_no_uniq ON public.payments USING btree (ref_no) WHERE ((ref_no IS NOT NULL) AND (btrim(ref_no) <> ''::text) AND (status <> 'rejected'::text));
CREATE UNIQUE INDEX payments_slip_hash_uniq ON public.payments USING btree (slip_sha256) WHERE ((slip_sha256 IS NOT NULL) AND (status <> 'rejected'::text));
CREATE INDEX payments_status_idx ON public.payments USING btree (status);
CREATE INDEX receipts_member_idx ON public.receipts USING btree (member_id);

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
CREATE TRIGGER trg_audit_admins AFTER INSERT OR DELETE OR UPDATE ON public.admins FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();
CREATE TRIGGER trg_announcements_touch BEFORE UPDATE ON public.announcements FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_applications_touch BEFORE UPDATE ON public.applications FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_audit_applications AFTER INSERT OR DELETE OR UPDATE ON public.applications FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();
CREATE TRIGGER trg_audit_log_append_only BEFORE DELETE OR UPDATE ON public.audit_log FOR EACH ROW EXECUTE FUNCTION app_private.block_audit_mutation();
CREATE TRIGGER trg_audit_log_no_truncate BEFORE TRUNCATE ON public.audit_log FOR EACH STATEMENT EXECUTE FUNCTION app_private.block_audit_truncate();
CREATE TRIGGER trg_audit_cards AFTER INSERT OR DELETE OR UPDATE ON public.cards FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();
CREATE TRIGGER trg_cards_touch BEFORE UPDATE ON public.cards FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_audit_members AFTER INSERT OR DELETE OR UPDATE ON public.members FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();
CREATE TRIGGER trg_members_touch BEFORE UPDATE ON public.members FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_audit_org_types AFTER INSERT OR DELETE OR UPDATE ON public.org_types FOR EACH ROW EXECUTE FUNCTION public.audit_keyed_change();
CREATE TRIGGER trg_audit_payments AFTER INSERT OR DELETE OR UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();
CREATE TRIGGER trg_payments_touch BEFORE UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_profiles_touch BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_audit_receipts AFTER INSERT OR DELETE OR UPDATE ON public.receipts FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();
CREATE TRIGGER trg_audit_settings AFTER INSERT OR DELETE OR UPDATE ON public.settings FOR EACH ROW EXECUTE FUNCTION public.audit_keyed_change();
CREATE TRIGGER trg_settings_guard BEFORE INSERT OR DELETE OR UPDATE ON public.settings FOR EACH ROW EXECUTE FUNCTION app_private.settings_guard();

-- ---------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------

alter table public.admins enable row level security;
alter table public.announcements enable row level security;
alter table public.applications enable row level security;
alter table public.audit_log enable row level security;
alter table public.cards enable row level security;
alter table public.consents enable row level security;
alter table public.members enable row level security;
alter table public.org_types enable row level security;
alter table public.payments enable row level security;
alter table public.profiles enable row level security;
alter table public.receipts enable row level security;
alter table public.settings enable row level security;

-- ---------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------

create policy admins_select on public.admins as permissive for select to authenticated
  using (public.admin_can('admin_accounts'::text));

create policy admins_write on public.admins as permissive for all to authenticated
  using ((public.admin_role() = 'superadmin'::text))
  with check ((public.admin_role() = 'superadmin'::text));

create policy announcements_admin_read on public.announcements as permissive for select to authenticated
  using (public.admin_can('announcements'::text));

create policy announcements_public_read on public.announcements as permissive for select to anon, authenticated
  using ((status = 'published'::text));

create policy applications_select on public.applications as permissive for select to authenticated
  using (((EXISTS ( SELECT 1
   FROM public.members m
  WHERE ((m.id = applications.member_id) AND (m.user_id = auth.uid())))) OR public.admin_can('applications'::text) OR public.admin_can('payments'::text)));

create policy audit_log_select on public.audit_log as permissive for select to authenticated
  using (public.admin_can('audit'::text));

create policy cards_select on public.cards as permissive for select to authenticated
  using (((EXISTS ( SELECT 1
   FROM public.members m
  WHERE ((m.id = cards.member_id) AND (m.user_id = auth.uid())))) OR public.admin_can('members'::text)));

create policy consents_insert on public.consents as permissive for insert to authenticated
  with check ((user_id = auth.uid()));

create policy consents_select on public.consents as permissive for select to authenticated
  using (((user_id = auth.uid()) OR public.admin_can('applications'::text)));

create policy members_select on public.members as permissive for select to authenticated
  using (((user_id = auth.uid()) OR public.admin_can('members'::text) OR public.admin_can('applications'::text) OR public.admin_can('payments'::text)));

create policy org_types_select on public.org_types as permissive for select to anon, authenticated
  using (active);

create policy org_types_write on public.org_types as permissive for all to authenticated
  using (public.admin_can('settings'::text))
  with check (public.admin_can('settings'::text));

create policy payments_select on public.payments as permissive for select to authenticated
  using (((EXISTS ( SELECT 1
   FROM public.members m
  WHERE ((m.id = payments.member_id) AND (m.user_id = auth.uid())))) OR public.admin_can('payments'::text)));

create policy profiles_insert on public.profiles as permissive for insert to authenticated
  with check ((id = auth.uid()));

create policy profiles_select on public.profiles as permissive for select to authenticated
  using (((id = auth.uid()) OR public.admin_can('members'::text)));

create policy profiles_update on public.profiles as permissive for update to authenticated
  using ((id = auth.uid()))
  with check ((id = auth.uid()));

create policy receipts_select on public.receipts as permissive for select to authenticated
  using (((EXISTS ( SELECT 1
   FROM public.members m
  WHERE ((m.id = receipts.member_id) AND (m.user_id = auth.uid())))) OR public.admin_can('payments'::text) OR public.admin_can('members'::text)));

create policy settings_admin_read on public.settings as permissive for select to authenticated
  using (public.is_admin());

create policy settings_public_read on public.settings as permissive for select to anon, authenticated
  using (is_public);

create policy settings_write on public.settings as permissive for all to authenticated
  using (public.admin_can('settings'::text))
  with check (public.admin_can('settings'::text));

create policy club_files_insert on storage.objects as permissive for insert to authenticated
  with check ((((bucket_id = ANY (ARRAY['member-photos'::text, 'member-signatures'::text, 'payment-slips'::text])) AND ((storage.foldername(name))[1] = (auth.uid())::text)) OR ((bucket_id = 'payment-slips'::text) AND public.admin_can('slip_override'::text))));

create policy club_files_select on storage.objects as permissive for select to authenticated
  using ((((bucket_id = 'payment-slips'::text) AND (((storage.foldername(name))[1] = (auth.uid())::text) OR public.admin_can('payments'::text))) OR ((bucket_id = ANY (ARRAY['member-photos'::text, 'member-signatures'::text])) AND (((storage.foldername(name))[1] = (auth.uid())::text) OR public.admin_can('members'::text)))));

create policy club_signatures_delete on storage.objects as permissive for delete to authenticated
  using (((bucket_id = 'club-signatures'::text) AND (((name ~~ 'club/president-%'::text) AND public.admin_can('signatory_president'::text)) OR ((name ~~ 'club/receipt-%'::text) AND public.admin_can('signatory_receipt'::text)))));

create policy club_signatures_insert on storage.objects as permissive for insert to authenticated
  with check (((bucket_id = 'club-signatures'::text) AND (((name ~~ 'club/president-%'::text) AND public.admin_can('signatory_president'::text)) OR ((name ~~ 'club/receipt-%'::text) AND public.admin_can('signatory_receipt'::text)))));

create policy club_signatures_select on storage.objects as permissive for select to authenticated
  using ((bucket_id = 'club-signatures'::text));

create policy club_signatures_update on storage.objects as permissive for update to authenticated
  using (((bucket_id = 'club-signatures'::text) AND (((name ~~ 'club/president-%'::text) AND public.admin_can('signatory_president'::text)) OR ((name ~~ 'club/receipt-%'::text) AND public.admin_can('signatory_receipt'::text)))))
  with check (((bucket_id = 'club-signatures'::text) AND (((name ~~ 'club/president-%'::text) AND public.admin_can('signatory_president'::text)) OR ((name ~~ 'club/receipt-%'::text) AND public.admin_can('signatory_receipt'::text)))));

-- ---------------------------------------------------------------------
-- Schema privileges
-- ---------------------------------------------------------------------

revoke all on schema app_private from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Table and sequence privileges
-- ---------------------------------------------------------------------

revoke all on table app_private.counters from public, anon, authenticated, service_role;

revoke all on table app_private.crypto_canary from public, anon, authenticated, service_role;

revoke all on table public.admins from public, anon, authenticated, service_role;
grant maintain, select on table public.admins to anon;
grant delete, insert, maintain, select, update on table public.admins to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.admins to service_role;

revoke all on table public.announcements from public, anon, authenticated, service_role;
grant select on table public.announcements to anon;
grant select on table public.announcements to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.announcements to service_role;

revoke all on table public.applications from public, anon, authenticated, service_role;
grant maintain, select on table public.applications to anon;
grant maintain, select on table public.applications to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.applications to service_role;

revoke all on table public.audit_log from public, anon, authenticated, service_role;
grant maintain, select on table public.audit_log to anon;
grant maintain, select on table public.audit_log to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.audit_log to service_role;

revoke all on sequence public.audit_log_id_seq from public, anon, authenticated, service_role;
grant select, update, usage on sequence public.audit_log_id_seq to anon;
grant select, update, usage on sequence public.audit_log_id_seq to authenticated;
grant select, update, usage on sequence public.audit_log_id_seq to service_role;

revoke all on table public.cards from public, anon, authenticated, service_role;
grant maintain, select on table public.cards to anon;
grant maintain, select on table public.cards to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cards to service_role;

revoke all on table public.consents from public, anon, authenticated, service_role;
grant insert, maintain, select on table public.consents to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.consents to service_role;

revoke all on table public.members from public, anon, authenticated, service_role;
grant maintain, select on table public.members to anon;
grant maintain, select on table public.members to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.members to service_role;

revoke all on table public.org_types from public, anon, authenticated, service_role;
grant maintain, select on table public.org_types to anon;
grant delete, insert, maintain, select, update on table public.org_types to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.org_types to service_role;

revoke all on table public.payments from public, anon, authenticated, service_role;
grant maintain, select on table public.payments to anon;
grant maintain, select on table public.payments to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.payments to service_role;

revoke all on table public.profiles from public, anon, authenticated, service_role;
grant insert, maintain, select, update on table public.profiles to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.profiles to service_role;

revoke all on table public.receipts from public, anon, authenticated, service_role;
grant maintain, select on table public.receipts to anon;
grant maintain, select on table public.receipts to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.receipts to service_role;

revoke all on table public.settings from public, anon, authenticated, service_role;
grant maintain, select on table public.settings to anon;
grant delete, insert, maintain, select, update on table public.settings to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.settings to service_role;

-- ---------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------

revoke all on function app_private.approve_payment(p_payment_id uuid, p_actor uuid, p_auto boolean) from public, anon, authenticated, service_role;

revoke all on function app_private.baht_text(p_amount numeric) from public, anon, authenticated, service_role;

revoke all on function app_private.be_year() from public, anon, authenticated, service_role;

revoke all on function app_private.bidx(p_plain text) from public, anon, authenticated, service_role;

revoke all on function app_private.block_audit_mutation() from public, anon, authenticated, service_role;

revoke all on function app_private.block_audit_truncate() from public, anon, authenticated, service_role;

revoke all on function app_private.check_encryption() from public, anon, authenticated, service_role;

revoke all on function app_private.decrypt_pii(p_cipher bytea) from public, anon, authenticated, service_role;

revoke all on function app_private.encrypt_pii(p_plain text) from public, anon, authenticated, service_role;

revoke all on function app_private.gen_code(p_prefix text, p_width integer) from public, anon, authenticated, service_role;

revoke all on function app_private.is_valid_thai_id(p_id text) from public, anon, authenticated, service_role;

revoke all on function app_private.log_audit(p_action text, p_entity text, p_entity_id text, p_entity_label text, p_changed jsonb, p_note text) from public, anon, authenticated, service_role;

revoke all on function app_private.next_number(p_name text) from public, anon, authenticated, service_role;

revoke all on function app_private.require_admin(p_roles text[]) from public, anon, authenticated, service_role;

revoke all on function app_private.require_area(p_area text) from public, anon, authenticated, service_role;

revoke all on function app_private.secret(p_name text) from public, anon, authenticated, service_role;

revoke all on function app_private.setting(p_key text, p_default jsonb) from public, anon, authenticated, service_role;

revoke all on function app_private.settings_guard() from public, anon, authenticated, service_role;
grant execute on function app_private.settings_guard() to public;

revoke all on function app_private.slip_server_check(p_uid uuid, p_fee numeric, p_amount numeric, p_paid_at timestamp with time zone, p_slip_path text, p_slip_sha256 text, p_ref text) from public, anon, authenticated, service_role;

revoke all on function app_private.thai_read_int(p_n bigint) from public, anon, authenticated, service_role;

revoke all on function public.admin_can(p_area text) from public, anon, authenticated, service_role;
grant execute on function public.admin_can(p_area text) to authenticated;
grant execute on function public.admin_can(p_area text) to service_role;

revoke all on function public.admin_decide_application(p_app_id uuid, p_approve boolean, p_note text) from public, anon, authenticated, service_role;
grant execute on function public.admin_decide_application(p_app_id uuid, p_approve boolean, p_note text) to authenticated;
grant execute on function public.admin_decide_application(p_app_id uuid, p_approve boolean, p_note text) to service_role;

revoke all on function public.admin_delete_member(p_member_id uuid, p_reason text, p_confirm_name text) from public, anon, authenticated, service_role;
grant execute on function public.admin_delete_member(p_member_id uuid, p_reason text, p_confirm_name text) to authenticated;
grant execute on function public.admin_delete_member(p_member_id uuid, p_reason text, p_confirm_name text) to service_role;

revoke all on function public.admin_expire_memberships() from public, anon, authenticated, service_role;
grant execute on function public.admin_expire_memberships() to authenticated;
grant execute on function public.admin_expire_memberships() to service_role;

revoke all on function public.admin_export_members(p_include_pii boolean) from public, anon, authenticated, service_role;
grant execute on function public.admin_export_members(p_include_pii boolean) to authenticated;
grant execute on function public.admin_export_members(p_include_pii boolean) to service_role;

revoke all on function public.admin_grant_admin(p_email text, p_role text, p_full_name text, p_position text) from public, anon, authenticated, service_role;
grant execute on function public.admin_grant_admin(p_email text, p_role text, p_full_name text, p_position text) to authenticated;
grant execute on function public.admin_grant_admin(p_email text, p_role text, p_full_name text, p_position text) to service_role;

revoke all on function public.admin_menu() from public, anon, authenticated, service_role;
grant execute on function public.admin_menu() to authenticated;
grant execute on function public.admin_menu() to service_role;

revoke all on function public.admin_pin_announcement(p_id uuid, p_pinned boolean) from public, anon, authenticated, service_role;
grant execute on function public.admin_pin_announcement(p_id uuid, p_pinned boolean) to authenticated;
grant execute on function public.admin_pin_announcement(p_id uuid, p_pinned boolean) to service_role;

revoke all on function public.admin_reissue_card(p_member_id uuid, p_reason text) from public, anon, authenticated, service_role;
grant execute on function public.admin_reissue_card(p_member_id uuid, p_reason text) to authenticated;
grant execute on function public.admin_reissue_card(p_member_id uuid, p_reason text) to service_role;

revoke all on function public.admin_replace_slip(p jsonb) from public, anon, authenticated, service_role;
grant execute on function public.admin_replace_slip(p jsonb) to authenticated;
grant execute on function public.admin_replace_slip(p jsonb) to service_role;

revoke all on function public.admin_review_payment(p_payment_id uuid, p_approve boolean, p_reason text) from public, anon, authenticated, service_role;
grant execute on function public.admin_review_payment(p_payment_id uuid, p_approve boolean, p_reason text) to authenticated;
grant execute on function public.admin_review_payment(p_payment_id uuid, p_approve boolean, p_reason text) to service_role;

revoke all on function public.admin_revoke_admin(p_user_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.admin_revoke_admin(p_user_id uuid) to authenticated;
grant execute on function public.admin_revoke_admin(p_user_id uuid) to service_role;

revoke all on function public.admin_revoke_card(p_card_id uuid, p_reason text) from public, anon, authenticated, service_role;
grant execute on function public.admin_revoke_card(p_card_id uuid, p_reason text) to authenticated;
grant execute on function public.admin_revoke_card(p_card_id uuid, p_reason text) to service_role;

revoke all on function public.admin_role() from public, anon, authenticated, service_role;
grant execute on function public.admin_role() to authenticated;
grant execute on function public.admin_role() to service_role;

revoke all on function public.admin_save_announcement(p jsonb) from public, anon, authenticated, service_role;
grant execute on function public.admin_save_announcement(p jsonb) to authenticated;
grant execute on function public.admin_save_announcement(p jsonb) to service_role;

revoke all on function public.admin_save_signatories(p jsonb) from public, anon, authenticated, service_role;
grant execute on function public.admin_save_signatories(p jsonb) to authenticated;
grant execute on function public.admin_save_signatories(p jsonb) to service_role;

revoke all on function public.admin_save_slip_verify(p jsonb) from public, anon, authenticated, service_role;
grant execute on function public.admin_save_slip_verify(p jsonb) to authenticated;
grant execute on function public.admin_save_slip_verify(p jsonb) to service_role;

revoke all on function public.admin_set_announcement_status(p_id uuid, p_status text) from public, anon, authenticated, service_role;
grant execute on function public.admin_set_announcement_status(p_id uuid, p_status text) to authenticated;
grant execute on function public.admin_set_announcement_status(p_id uuid, p_status text) to service_role;

revoke all on function public.admin_stats() from public, anon, authenticated, service_role;
grant execute on function public.admin_stats() to authenticated;
grant execute on function public.admin_stats() to service_role;

revoke all on function public.admin_system_health() from public, anon, authenticated, service_role;
grant execute on function public.admin_system_health() to authenticated;
grant execute on function public.admin_system_health() to service_role;

revoke all on function public.admin_update_member(p_member_id uuid, p jsonb) from public, anon, authenticated, service_role;
grant execute on function public.admin_update_member(p_member_id uuid, p jsonb) to authenticated;
grant execute on function public.admin_update_member(p_member_id uuid, p jsonb) to service_role;

revoke all on function public.audit_keyed_change() from public, anon, authenticated, service_role;
grant execute on function public.audit_keyed_change() to service_role;

revoke all on function public.audit_row_change() from public, anon, authenticated, service_role;
grant execute on function public.audit_row_change() to service_role;

revoke all on function public.get_member_pii(p_member_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_member_pii(p_member_id uuid) to authenticated;
grant execute on function public.get_member_pii(p_member_id uuid) to service_role;

revoke all on function public.get_my_status() from public, anon, authenticated, service_role;
grant execute on function public.get_my_status() to authenticated;
grant execute on function public.get_my_status() to service_role;

revoke all on function public.handle_new_user() from public, anon, authenticated, service_role;
grant execute on function public.handle_new_user() to service_role;

revoke all on function public.has_admin_role(p_roles text[]) from public, anon, authenticated, service_role;
grant execute on function public.has_admin_role(p_roles text[]) to authenticated;
grant execute on function public.has_admin_role(p_roles text[]) to service_role;

revoke all on function public.is_admin() from public, anon, authenticated, service_role;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_admin() to service_role;

revoke all on function public.log_client_event(p_action text, p_entity text, p_entity_id text, p_note text) from public, anon, authenticated, service_role;
grant execute on function public.log_client_event(p_action text, p_entity text, p_entity_id text, p_note text) to authenticated;
grant execute on function public.log_client_event(p_action text, p_entity text, p_entity_id text, p_note text) to service_role;

revoke all on function public.record_card_print(p_card_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.record_card_print(p_card_id uuid) to authenticated;
grant execute on function public.record_card_print(p_card_id uuid) to service_role;

revoke all on function public.record_slip_verification(p_payment_id uuid, p jsonb) from public, anon, authenticated, service_role;
grant execute on function public.record_slip_verification(p_payment_id uuid, p jsonb) to service_role;

revoke all on function public.submit_application() from public, anon, authenticated, service_role;
grant execute on function public.submit_application() to authenticated;
grant execute on function public.submit_application() to service_role;

revoke all on function public.submit_payment(p jsonb) from public, anon, authenticated, service_role;
grant execute on function public.submit_payment(p jsonb) to authenticated;
grant execute on function public.submit_payment(p jsonb) to service_role;

revoke all on function public.touch_updated_at() from public, anon, authenticated, service_role;
grant execute on function public.touch_updated_at() to service_role;

revoke all on function public.upsert_my_member(p jsonb) from public, anon, authenticated, service_role;
grant execute on function public.upsert_my_member(p jsonb) to authenticated;
grant execute on function public.upsert_my_member(p jsonb) to service_role;

revoke all on function public.verify_card(p_token text) from public, anon, authenticated, service_role;
grant execute on function public.verify_card(p_token text) to anon;
grant execute on function public.verify_card(p_token text) to authenticated;
grant execute on function public.verify_card(p_token text) to service_role;

-- ---------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------

comment on table public.announcements is 'ประกาศประชาสัมพันธ์และกิจกรรมของชมรม จัดการโดย superadmin และ admin เท่านั้น';
comment on column public.admins.role is 'superadmin=ผู้ดูแลระดับสูงสุด (จัดการผู้ดูแลและดูได้ทั้งหมด), admin=ผู้ดูแลระบบ (ทุกเมนู ยกเว้นบัญชีผู้ดูแลและการลบสมาชิก), registrar=เจ้าหน้าที่ทะเบียน (ตรวจใบสมัคร/ทะเบียนสมาชิก/ประวัติ), treasurer=เจ้าหน้าที่การเงิน (ตรวจสลิป/ทะเบียนสมาชิก/ประวัติ), registrar_treasurer=เจ้าหน้าที่ทะเบียนและการเงิน (ตรวจใบสมัคร+ตรวจสลิป/ทะเบียนสมาชิก/ประวัติ)';
comment on column public.announcements.status is 'draft=ฉบับร่าง (เห็นเฉพาะผู้ดูแล), published=เผยแพร่แล้ว (ทุกคนเห็น), archived=เก็บเข้าคลัง (เห็นเฉพาะผู้ดูแล)';
comment on column public.members.work_addr_detail_enc is 'บ้านเลขที่ / หมู่ / ถนน ของที่ตั้งหน่วยงาน เข้ารหัสด้วย app_private.encrypt_pii()';
comment on column public.receipts.voided_at is 'เวลาที่ใบสำคัญรับเงินฉบับนี้ถูกยกเลิกเพราะมีการแนบสลิปใหม่แทน ห้ามลบแถวทิ้ง เอกสารที่เคยส่งมอบไปแล้วต้องตรวจสอบย้อนหลังได้';
comment on function public.admin_can(p_area text) is 'บัญชีผู้ดูแลที่ล็อกอินอยู่ เข้าพื้นที่งานที่ระบุได้หรือไม่ พื้นที่: dashboard, applications, payments, members, audit, settings, admin_accounts';
comment on schema app_private is 'สคีมาภายใน: กุญแจเข้ารหัส ตัวนับเลขเอกสาร และฟังก์ชันที่ห้ามเรียกจาก API';

-- ---------------------------------------------------------------------
-- Storage buckets
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('club-signatures', 'club-signatures', false, 1048576, '{image/png,image/jpeg,image/webp}'::text[])
on conflict (id) do update set name = excluded.name, public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('member-photos', 'member-photos', false, 3145728, '{image/jpeg,image/png,image/webp}'::text[])
on conflict (id) do update set name = excluded.name, public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('member-signatures', 'member-signatures', false, 1048576, '{image/png,image/jpeg,image/webp}'::text[])
on conflict (id) do update set name = excluded.name, public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payment-slips', 'payment-slips', false, 5242880, '{image/jpeg,image/png,image/webp,application/pdf}'::text[])
on conflict (id) do update set name = excluded.name, public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
