# สำรองฐานข้อมูล Supabase: club-data

โปรเจกต์ `club-data` (ref `ooovzjovkrfyuqakkpig`, องค์กร envburiramclub, ap-southeast-1, PostgreSQL 17)
สำรองเมื่อ 2026-10-01

| ไฟล์ | เนื้อหา |
| --- | --- |
| `schema.sql` | โครงสร้างฐานข้อมูลปัจจุบันทั้งหมดของสคีมา `public` และ `app_private`: ตาราง ฟังก์ชัน 56 ตัว ทริกเกอร์ ดัชนี RLS policy (รวม `storage.objects`) สิทธิ์ grant คอมเมนต์ และ storage bucket 4 ตัว |
| `seed.sql` | ข้อมูลอ้างอิงของระบบ: `org_types` (9 แถว) และ `settings` (8 แถว) |
| `migrations/` | SQL ของ migration ทั้ง 30 รายการตามที่บันทึกไว้ใน `supabase_migrations.schema_migrations` |

## ใช้ไฟล์ไหนกู้ระบบ

ใช้ `schema.sql` เป็นหลัก เพราะมีการแก้ฐานข้อมูลจริงหลายครั้งโดยไม่ผ่าน migration
(เช่น ตาราง `announcements`, บทบาท `registrar_treasurer`, policy ที่ใช้ `admin_can()`,
คอลัมน์ `receipts.voided_*` และ `members.work_addr_detail_enc`)
การรัน `migrations/` ตามลำดับจะได้โครงสร้างที่ยังไม่ตรงกับของจริง จึงเก็บไว้เป็นประวัติเท่านั้น

`schema.sql` ตรวจแล้วว่าตรงกับฐานข้อมูลจริงทุกรายการ (ตาราง คอลัมน์ ค่าเริ่มต้น เนื้อฟังก์ชัน
policy ทริกเกอร์ ดัชนี constraint สิทธิ์ RLS คอมเมนต์ และ bucket)

## วิธีกู้ลงโปรเจกต์ Supabase ใหม่

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f supabase/schema.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f supabase/seed.sql
```

`DATABASE_URL` ดูได้ที่ Project Settings > Database > Connection string (ใช้ผู้ใช้ `postgres`)

## สิ่งที่ไม่อยู่ในที่เก็บนี้

ที่เก็บนี้เป็นสาธารณะ และ GitHub Pages เผยแพร่ทุกไฟล์ในที่เก็บ ห้ามนำข้อมูลต่อไปนี้มาไว้ที่นี่

- ข้อมูลสมาชิกและข้อมูลส่วนบุคคล: `members`, `applications`, `payments`, `receipts`, `cards`,
  `consents`, `profiles`, `admins`, `audit_log`, `app_private.counters` และทุกตารางในสคีมา `auth`
- ไฟล์ใน Storage (รูปถ่าย ลายมือชื่อ สลิป)
- กุญแจใน Vault (`club_pii_enc_key`, `club_pii_bidx_pepper`)
  `schema.sql` จะสร้างกุญแจใหม่แบบสุ่มให้โปรเจกต์ใหม่ ถ้าจะกู้ข้อมูลสมาชิกเดิมต้องใช้กุญแจเดิม
  มิฉะนั้นถอดรหัสคอลัมน์ `*_enc` (เลขบัตรประชาชน โทรศัพท์ ที่อยู่) ไม่ได้
- Edge Function `verify-slip` และ secret ของมัน
