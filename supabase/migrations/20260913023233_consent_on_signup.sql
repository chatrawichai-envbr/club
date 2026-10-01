-- 0010: บันทึกความยินยอมตาม PDPA ตอนสมัครบัญชี ให้ทำฝั่งฐานข้อมูล
-- register.html เดิมบันทึกความยินยอมต่อเมื่อมี session ทันทีตอนสมัคร
-- ซึ่งเกิดเฉพาะตอนปิด Confirm email เมื่อเปิด Confirm email จึงไม่มีหลักฐานเลย
-- ย้ายมาไว้ในทริกเกอร์ handle_new_user ที่ทำงานตอนสร้างบัญชีเสมอ

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- กู้ข้อมูลย้อนหลังสำหรับบัญชีที่สมัครก่อนมีการแก้ไขนี้
-- บัญชีเหล่านี้ให้ความยินยอมจริง เพราะแบบฟอร์มบังคับติ๊กก่อนจึงกดสมัครได้
-- ใช้เวลาที่สร้างบัญชีจริงเป็นเวลาที่ให้ความยินยอม และระบุที่มาไว้ใน user_agent
-- อย่างตรงไปตรงมาว่าเป็นข้อมูลกู้ย้อนหลัง ให้ผู้ตรวจสอบแยกออกจากหลักฐานที่บันทึกสด
-- ทำเฉพาะบัญชีที่สมัครผ่านหน้าเว็บ (มีชื่อ-นามสกุลใน metadata)
do $$
declare
  v_legal   jsonb := app_private.setting('legal', '{}'::jsonb);
  v_terms   text  := coalesce(v_legal ->> 'terms_version', '1.0');
  v_privacy text  := coalesce(v_legal ->> 'privacy_version', '1.0');
  v_note    text  := '(กู้ย้อนหลังโดย migration 0010 - ระบบไม่ได้บันทึก user agent ไว้ ณ เวลาที่สมัคร)';
  v_rows    int;
begin
  with u as (
    select au.id, au.created_at
    from auth.users au
    where nullif(btrim(coalesce(au.raw_user_meta_data ->> 'full_name', '')), '') is not null
      and not exists (
        select 1 from public.consents c
        where c.user_id = au.id and c.doc in ('terms', 'privacy')
      )
  ), ins as (
    insert into public.consents (user_id, doc, version, accepted, accepted_at, created_at, user_agent)
    select u.id, d.doc,
           case d.doc when 'terms' then v_terms else v_privacy end,
           true, u.created_at, u.created_at, v_note
    from u cross join (values ('terms'), ('privacy')) as d(doc)
    returning 1
  )
  select count(*) into v_rows from ins;

  if v_rows > 0 then
    insert into public.audit_log (actor_id, actor_email, actor_role, action, entity, entity_label, changed, note)
    values (null, null, 'system', 'consent_backfill', 'consents',
            'กู้หลักฐานความยินยอมย้อนหลัง',
            jsonb_build_object('rows', v_rows, 'terms_version', v_terms, 'privacy_version', v_privacy),
            'กู้หลักฐานความยินยอมย้อนหลังสำหรับบัญชีที่สมัครก่อนย้ายการบันทึกไปฝั่งฐานข้อมูล ' ||
            'ใช้เวลาที่สร้างบัญชีเป็นเวลาที่ให้ความยินยอม (migration 0010)');
    raise notice 'กู้หลักฐานความยินยอมย้อนหลัง % แถว', v_rows;
  end if;
end $$;
