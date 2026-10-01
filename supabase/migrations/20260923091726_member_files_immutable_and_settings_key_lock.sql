-- ไฟล์หลักฐานของสมาชิกแก้หรือลบไม่ได้หลังอัปโหลด และปิดทางเลี่ยงของ settings_guard
-- ---------------------------------------------------------------------------
-- 1) สลิป รูปถ่าย และลายมือชื่อของสมาชิก
--    นโยบาย club_files_update / club_files_delete เปิดให้เจ้าของโฟลเดอร์เขียนทับหรือลบไฟล์ของตัวเอง
--    ได้ตลอดเวลา รวมถึงหลังส่งสลิปและหลังเจ้าหน้าที่อนุมัติแล้ว
--    สมาชิกจึงเรียก Storage API ตรง ๆ เปลี่ยนภาพสลิปที่ผ่านการตรวจแล้วเป็นภาพอื่น
--    หรือลบทิ้งได้ หลักฐานการชำระเงินที่ใช้ออกใบสำคัญรับเงินจึงไม่น่าเชื่อถือ
--
--    หน้าเว็บทั้งสองรุ่น (home และ gas) อัปโหลดด้วย upsert: false และตั้งชื่อไฟล์ใหม่ทุกครั้ง
--    (<user_id>/<ชนิด>-<เวลา>.<นามสกุล>) ไม่มีจุดใดเขียนทับหรือลบไฟล์ของสมาชิก
--    จึงถอนสองนโยบายนี้ได้โดยไม่กระทบการใช้งาน เหลือเพียงเพิ่มไฟล์ใหม่และอ่านไฟล์ของตน
--    ไฟล์ลายมือชื่อของชมรม (club-signatures) มีนโยบายของตัวเอง ไม่ได้รับผลกระทบ
--
-- 2) settings_guard ตรวจเฉพาะแถวที่ key เป็น slip_verify
--    ผู้มีพื้นที่ settings จึงเปลี่ยน key ของแถว slip_verify เป็นชื่ออื่นได้
--    ซึ่งมีผลเท่ากับการลบแถว (ที่ทริกเกอร์นี้ห้ามไว้เฉพาะผู้ดูแลระดับสูงสุด)
--    key เป็นตัวระบุค่าตั้งค่าที่หน้าเว็บและฐานข้อมูลอ้างถึงตรง ๆ ไม่มีเหตุให้ผู้ใช้เปลี่ยน
--    จึงห้ามเปลี่ยน key ของทุกแถวเมื่อทำผ่านบัญชีผู้ใช้ (migration และ service_role ไม่ถูกตรวจ)

drop policy if exists club_files_update on storage.objects;
drop policy if exists club_files_delete on storage.objects;

create or replace function app_private.settings_guard()
 returns trigger
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
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
$function$;
