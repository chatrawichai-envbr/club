create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;

create extension if not exists pgcrypto with schema extensions;

create table if not exists app_private.counters (
  name       text primary key,
  value      bigint not null default 0,
  updated_at timestamptz not null default now()
);

create or replace function app_private.next_number(p_name text)
returns bigint
language plpgsql
security definer
set search_path = app_private, pg_temp
as $$
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
$$;

create or replace function app_private.be_year()
returns int
language sql
stable
as $$
  select (extract(year from (now() at time zone 'Asia/Bangkok'))::int + 543);
$$;

create or replace function app_private.gen_code(p_prefix text, p_width int default 4)
returns text
language plpgsql
security definer
set search_path = app_private, pg_temp
as $$
declare
  v_year int := app_private.be_year();
  v_n    bigint;
begin
  v_n := app_private.next_number(p_prefix || '-' || v_year::text);
  return p_prefix || '-' || v_year::text || '-' || lpad(v_n::text, p_width, '0');
end;
$$;

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

create or replace function app_private.secret(p_name text)
returns text
language plpgsql
security definer
stable
set search_path = app_private, vault, pg_temp
as $$
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
$$;

create or replace function app_private.encrypt_pii(p_plain text)
returns bytea
language plpgsql
security definer
set search_path = app_private, extensions, pg_temp
as $$
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
$$;

create or replace function app_private.decrypt_pii(p_cipher bytea)
returns text
language plpgsql
security definer
set search_path = app_private, extensions, pg_temp
as $$
begin
  if p_cipher is null then
    return null;
  end if;
  return extensions.pgp_sym_decrypt(p_cipher, app_private.secret('club_pii_enc_key'));
exception
  when others then
    return null;
end;
$$;

create or replace function app_private.bidx(p_plain text)
returns text
language plpgsql
security definer
set search_path = app_private, extensions, pg_temp
as $$
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
$$;

create or replace function app_private.is_valid_thai_id(p_id text)
returns boolean
language plpgsql
immutable
as $$
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
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on schema app_private is
  'สคีมาภายใน: กุญแจเข้ารหัส ตัวนับเลขเอกสาร และฟังก์ชันที่ห้ามเรียกจาก API';
