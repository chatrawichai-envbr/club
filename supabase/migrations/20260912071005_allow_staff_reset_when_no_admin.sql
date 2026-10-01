-- ============================================================================
-- ทางออกเมื่อระบบติดตาย
--
-- ถ้าบัญชีผู้ดูแลหายไปทั้งหมดและไม่มีรหัสกู้คืน จะไม่มีใครเข้าระบบได้อีกเลย
-- ทางออกเดียวคือล้างแล้วติดตั้งใหม่ แต่การล้างระบบสงวนไว้ให้ผู้ดูแลสูงสุด
-- ซึ่งในสถานการณ์นั้นอาจไม่มีตัวตนอยู่แล้ว เจ้าหน้าที่จึงติดตายไปด้วย
--
-- แก้โดยอนุญาตให้เจ้าหน้าที่ล้างระบบได้ "เฉพาะเมื่อไม่มีบัญชีผู้ดูแลเหลืออยู่จริง"
-- เงื่อนไขนี้ตรวจที่ฝั่งฐานข้อมูล ไม่ใช่ที่หน้าเว็บ จึงหลอกไม่ได้ และตราบใดที่
-- ยังมีบัญชีผู้ดูแลอยู่แม้เพียงบัญชีเดียว เจ้าหน้าที่ก็ยังล้างข้อมูลไม่ได้เหมือนเดิม
-- ============================================================================
create or replace function public.reset_system()
returns void language plpgsql security definer
set search_path = public, app, pg_catalog
as $$
declare
  v_admins bigint;
begin
  select count(*) into v_admins from public.admins;

  if app.is_owner() then
    null;  -- ผู้ดูแลสูงสุดล้างได้เสมอ
  elsif app.is_staff() and v_admins = 0 then
    null;  -- ระบบติดตายจริง ไม่มีผู้ดูแลเหลืออยู่ เปิดทางให้ติดตั้งใหม่ได้
  else
    raise exception 'ล้างข้อมูลทั้งระบบได้เฉพาะผู้ดูแลสูงสุด หรือเมื่อไม่มีบัญชีผู้ดูแลเหลืออยู่แล้ว'
      using errcode = '42501';
  end if;

  delete from public.members;
  delete from public.verify;
  delete from public.audit;
  delete from public.counters;
  delete from public.admins;
  delete from public.meta;
end;
$$;
revoke all on function public.reset_system() from public, anon;
grant execute on function public.reset_system() to authenticated;
