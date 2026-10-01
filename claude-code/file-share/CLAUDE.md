# แนวทางการทำงานในโฟลเดอร์ file-share/

ใช้กฎของทั้ง repo ใน `../CLAUDE.md` ด้วย (ตอบภาษาไทย ตรวจบั๊กและช่องโหว่ push `main` เท่านั้น) กฎเฉพาะของระบบนี้:

- รันเทสต์ในโฟลเดอร์นี้ให้ผ่านก่อน commit: `python3 -m unittest discover -s tests -v`
  (รัน `js/core.js` ด้วย Node.js ผ่าน `tests/harness.js` ถ้าไม่มี Node.js จะข้าม)
- ห้ามใช้ไลบรารีจาก CDN หรือเว็บอื่น (รวมถึง Google Identity Services และ MSAL จาก CDN) — `script-src 'self'` เท่านั้น
  API ใหม่ที่เรียกด้วย fetch/XHR ต้องเพิ่มใน `connect-src` ของ CSP (`tests/test_fileshare.py` ตรวจ)
- `js/config.js` ใส่ได้เฉพาะ Client ID (ไม่ใช่ความลับ) ห้ามใส่ Client Secret หรือรหัสผ่านใด ๆ — repo เป็นสาธารณะ
- โทเคนการเข้าสู่ระบบอยู่ในหน่วยความจำเท่านั้น ห้ามบันทึกลง localStorage/sessionStorage/IndexedDB/cookie
  (ใช้ร่วมกันทุกแอปใต้ envburiramclub.github.io) — sessionStorage ใช้ได้เฉพาะ state/PKCE ชั่วคราว (`file-share:auth`)
- ตรวจ `state` ทุกครั้งที่กลับจากหน้าเข้าสู่ระบบ และลบโทเคน/code ออกจาก URL ทันที
- ขอสิทธิ์น้อยที่สุด (Google: `drive.file`) และลิงก์ที่ได้จาก API ต้องผ่าน `ShareCore.safeLink` ก่อนแสดง
- ข้อความ/ชื่อไฟล์ใส่หน้าเว็บด้วย `textContent` เท่านั้น แสดงชื่อไฟล์ผ่าน `ShareCore.displayName` (ตัดอักขระกลับทิศข้อความ)
- ช่องเลือกไฟล์ไม่มี `accept` (ฝากได้ทุกชนิด และ accept ที่มีนามสกุลทำให้ Firefox บน Android ล่ม)
- ขีดจำกัด 100 MB ต่อไฟล์อยู่ที่ `PROVIDERS` ใน `js/core.js` — ถ้าแก้ต้องแก้ข้อความในหน้าเว็บและ README ให้ตรงกัน
