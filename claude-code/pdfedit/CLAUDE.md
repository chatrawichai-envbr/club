# แนวทางการทำงานในโฟลเดอร์ pdfedit/

ใช้กฎของทั้ง repo ใน `../CLAUDE.md` ด้วย (ตอบภาษาไทย ตรวจบั๊กและช่องโหว่ push `main` เท่านั้น) กฎเฉพาะของระบบนี้:

- รันเทสต์ในโฟลเดอร์นี้ให้ผ่านก่อน commit: `python3 -m unittest discover -s tests -v`
  (รัน `js/pdf-core.js` ด้วย Node.js ผ่าน `tests/harness.js` ถ้าไม่มี Node.js จะข้าม)
- CSP ใน `index.html` ห้ามมี `unsafe-inline`/`unsafe-eval`: ไม่ใส่สคริปต์ สไตล์ หรือ `onclick` ในหน้า
  ข้อมูลออกนอกเว็บได้เฉพาะ Gemini API (`connect-src`) และต้องถามผู้ใช้ก่อนส่งข้อความในไฟล์
- ข้อความจากไฟล์ PDF, ผู้ใช้ และคำตอบของ AI ไม่น่าเชื่อถือ: สร้างหน้าต่าง/ข้อความด้วย `Dialog.el` และ `textContent` เท่านั้น
  (ห้าม `innerHTML` และห้ามส่งสตริง HTML ให้หน้าต่าง)
- API Key ของ Gemini เก็บในหน่วยความจำ (`S.apiKey`) เท่านั้น ห้ามบันทึกลง `localStorage`/`sessionStorage`/IndexedDB/cookie
  (ใช้ร่วมกันทั้งโดเมน) และส่งทาง header `x-goog-api-key` ห้ามใส่ใน URL
- ช่องเลือก PDF ไม่มี `accept` ในหน้า `js/app.js` ใส่ให้เฉพาะเบราว์เซอร์ที่ไม่ใช่ Firefox บน Android แล้วตรวจ `%PDF-` ในเนื้อไฟล์เสมอ
- องค์ประกอบที่เพิ่มบนหน้าเก็บพิกัดของ PDF (`px`, `py`, `rot`) แปลงกับจอด้วย viewport ของ PDF.js เท่านั้น
  (หมุน/ลบ/เรียงหน้าแล้วตำแหน่งต้องตรงกับที่เห็น) ข้อความไทยส่งผ่าน `PdfCore.shapeThai` ก่อนวาดด้วย pdf-lib
- เปลี่ยนคลาส Tailwind ต้องสร้าง `css/tailwind.css` ใหม่ (คำสั่งใน `README.md`)
- ไลบรารีใน `vendor/` ห้ามแก้ด้วยมือ ถ้าอัปเดตต้องแก้ `SHA256SUMS` ของโฟลเดอร์นั้นด้วย
