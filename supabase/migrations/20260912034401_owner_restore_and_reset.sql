-- ผู้ดูแลสูงสุดต้องเขียนตัวนับได้ตอนกู้คืนข้อมูลจากไฟล์สำรอง
create policy counters_owner_write  on public.counters for insert with check (app.is_owner());
create policy counters_owner_update on public.counters for update using (app.is_owner()) with check (app.is_owner());
grant insert, update on public.counters to authenticated;

-- ล้างระบบทั้งหมดเพื่อติดตั้งใหม่
-- บันทึกประวัติลบทีละรายการไม่ได้ตลอดกาล แต่การล้างทั้งระบบเป็นการกระทำ
-- ที่ชอบด้วยเหตุผล จึงเปิดทางไว้เฉพาะผู้ดูแลสูงสุด และทำครบทุกตารางในคราวเดียว
create or replace function public.reset_system()
returns void language plpgsql security definer
set search_path = public, app, pg_catalog
as $$
begin
  if not app.is_owner() then
    raise exception 'ล้างข้อมูลทั้งระบบได้เฉพาะผู้ดูแลสูงสุด' using errcode = '42501';
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
