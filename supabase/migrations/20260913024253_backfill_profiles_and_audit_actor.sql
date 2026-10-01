-- 0011: เติม profiles ที่ขาด และกันไม่ให้ประวัติการแก้ไขขาดชื่อผู้กระทำ
-- บัญชีที่สร้างผ่าน Admin API อาจไม่มีแถวใน profiles ซึ่ง log_audit ใช้หาอีเมลผู้กระทำ

insert into public.profiles (id, email, full_name)
select u.id,
       u.email,
       nullif(btrim(coalesce(u.raw_user_meta_data ->> 'full_name', '')), '')
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id)
on conflict (id) do nothing;

-- ฟังก์ชันนี้อยู่ในสคีมา app_private สิทธิ์เรียกใช้จำกัดที่ postgres เท่านั้น
-- (ตั้งไว้ตั้งแต่ 0007) ห้ามย้ายไป public และห้าม grant ให้ authenticated หรือ anon
-- เพราะจะทำให้ผู้ใช้ที่ล็อกอินแล้วปลอมแถวในประวัติการแก้ไขได้
-- ใช้ create or replace เพื่อคงสิทธิ์เดิม ไม่แตะ grant ใด ๆ
create or replace function app_private.log_audit(
  p_action       text,
  p_entity       text,
  p_entity_id    text,
  p_entity_label text default null,
  p_changed      jsonb default null,
  p_note         text default null
)
returns void
language plpgsql
security definer
set search_path = public, app_private, pg_temp
as $$
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
$$;
