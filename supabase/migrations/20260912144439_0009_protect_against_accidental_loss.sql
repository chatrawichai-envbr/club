-- =====================================================================
-- 0009 : ป้องกันข้อมูลหายโดยไม่ได้ตั้งใจ
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) ค่าตรวจสอบกุญแจเข้ารหัส (canary)
--    เก็บข้อความที่รู้ค่าอยู่แล้วในรูปเข้ารหัส ถ้าวันใดถอดกลับไม่ได้
--    แปลว่ากุญแจใน Vault หาย/เปลี่ยน ต้องหยุดใช้งานและกู้กุญแจทันที
--    ก่อนที่จะมีข้อมูลใหม่เข้ามาทับ
-- ---------------------------------------------------------------------
create table if not exists app_private.crypto_canary (
  id         int primary key default 1,
  plain      text not null,
  cipher     bytea not null,
  bidx       text not null,
  created_at timestamptz not null default now(),
  constraint crypto_canary_single_row check (id = 1)
);
revoke all on app_private.crypto_canary from public, anon, authenticated;

insert into app_private.crypto_canary (id, plain, cipher, bidx)
select 1,
       'canary-ชมรมอนามัยสิ่งแวดล้อมบุรีรัมย์-2569',
       app_private.encrypt_pii('canary-ชมรมอนามัยสิ่งแวดล้อมบุรีรัมย์-2569'),
       app_private.bidx('canary-ชมรมอนามัยสิ่งแวดล้อมบุรีรัมย์-2569')
where not exists (select 1 from app_private.crypto_canary where id = 1);

-- ตรวจว่ากุญแจยังใช้งานได้ครบทั้งกุญแจเข้ารหัสและ pepper ของ blind index
create or replace function app_private.check_encryption()
returns jsonb language plpgsql security definer
set search_path = app_private, public, pg_temp
as $$
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
$$;

-- ---------------------------------------------------------------------
-- 2) audit_log เป็นแบบเพิ่มได้เท่านั้น (append-only) จริง
--    กันแม้แต่ผู้ที่เข้าถึง SQL ได้ ลบประวัติทิ้งโดยพลั้งเผลอ
--    หากต้องลบตามรอบเก็บรักษาข้อมูล ต้องตั้งค่าสถานะอนุญาตก่อนอย่างจงใจ
-- ---------------------------------------------------------------------
create or replace function app_private.block_audit_mutation()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
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
$$;

drop trigger if exists trg_audit_log_append_only on public.audit_log;
create trigger trg_audit_log_append_only
  before update or delete on public.audit_log
  for each row execute function app_private.block_audit_mutation();

-- ---------------------------------------------------------------------
-- 3) บันทึกความยินยอม PDPA ต้องไม่หายไปพร้อมการลบสมาชิก
--    เปลี่ยนจาก CASCADE เป็น SET NULL เพื่อคงหลักฐานการให้ความยินยอมไว้
-- ---------------------------------------------------------------------
alter table public.consents drop constraint if exists consents_member_id_fkey;
alter table public.consents
  add constraint consents_member_id_fkey
  foreign key (member_id) references public.members(id) on delete set null;

-- ---------------------------------------------------------------------
-- 4) การลบสมาชิกต้องยืนยันด้วยการพิมพ์ชื่อ และจำกัดให้ superadmin เท่านั้น
--    กันการกดพลาด และกันการลบสมาชิกที่เคยออกบัตรหรือใบเสร็จแล้ว
-- ---------------------------------------------------------------------
create or replace function public.admin_delete_member(
  p_member_id uuid, p_reason text, p_confirm_name text default null)
returns jsonb language plpgsql security definer
set search_path = public, app_private, pg_temp
as $$
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
$$;

revoke all on function public.admin_delete_member(uuid, text) from public, anon, authenticated;
drop function if exists public.admin_delete_member(uuid, text);
revoke all on function public.admin_delete_member(uuid, text, text) from public, anon;
grant execute on function public.admin_delete_member(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 5) รายงานสุขภาพระบบสำหรับผู้ดูแล (เห็นได้ทันทีว่ากุญแจยังดีอยู่)
-- ---------------------------------------------------------------------
create or replace function public.admin_system_health()
returns jsonb language plpgsql security definer
set search_path = public, app_private, pg_temp
as $$
declare v_enc jsonb;
begin
  perform app_private.require_admin();
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
$$;

revoke all on function public.admin_system_health() from public, anon;
grant execute on function public.admin_system_health() to authenticated;
