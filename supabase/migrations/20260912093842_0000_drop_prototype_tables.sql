-- ลบตารางต้นแบบเดิม (ทุกตารางไม่มีข้อมูล - ตรวจสอบแล้วว่า 0 แถว)
drop table if exists public.meta     cascade;
drop table if exists public.admins   cascade;
drop table if exists public.counters cascade;
drop table if exists public.members  cascade;
drop table if exists public.audit    cascade;
drop table if exists public.verify   cascade;
