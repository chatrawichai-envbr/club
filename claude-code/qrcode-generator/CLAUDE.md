# แนวทางการทำงานในโฟลเดอร์ qrcode-generator/

ใช้กฎของทั้ง repo ใน `../CLAUDE.md` ด้วย (ตอบภาษาไทย ตรวจบั๊กและช่องโหว่ push `main` เท่านั้น) กฎเฉพาะของระบบนี้:

- รันเทสต์ในโฟลเดอร์นี้ให้ผ่านก่อน commit: `python3 -m unittest discover -s tests -v`
  (รัน `js/payload.js` ด้วย Node.js ผ่าน `tests/harness.js` ถ้าไม่มี Node.js จะข้าม)
- CSP ใน `index.html` ห้ามมี `unsafe-inline`/`unsafe-eval` และห้ามโหลดไฟล์จากเว็บอื่น (CDN, Google Fonts):
  ไม่ใส่สคริปต์ สไตล์ หรือ `onclick` ในหน้า ผูก event ใน `js/app.js` ใช้ไฟล์ใน `vendor/` เท่านั้น
- ข้อมูลที่ผู้ใช้กรอกไม่น่าเชื่อถือ: ใส่หน้าเว็บด้วย `textContent` เท่านั้น (ห้าม `innerHTML`)
  ส่งข้อความให้ qr-code-styling ผ่าน `QrPayload.utf8Binary` เสมอ (ไลบรารีเข้ารหัสแบบ Latin-1 ภาษาไทยจะเพี้ยน)
- พร้อมเพย์เกี่ยวกับการโอนเงิน: เลขหรือจำนวนเงินที่ไม่ถูกต้องต้องไม่ได้ QR แก้ `js/payload.js` แล้วต้องเพิ่มเทสต์
- เปลี่ยนคลาส Tailwind ต้องสร้าง `css/tailwind.css` ใหม่ (คำสั่งใน `README.md`)
- ไลบรารีใน `vendor/` ห้ามแก้ด้วยมือ ถ้าอัปเดตต้องแก้ `SHA256SUMS` ของโฟลเดอร์นั้นด้วย
- ช่องเลือกโลโก้ใช้ `accept="image/*"` เท่านั้น (Firefox บน Android) แล้วตรวจชนิดและขนาดไฟล์ใน `js/app.js`
