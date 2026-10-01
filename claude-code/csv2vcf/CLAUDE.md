# แนวทางการทำงานในโฟลเดอร์ csv2vcf/

ใช้กฎของทั้ง repo ใน `../CLAUDE.md` ด้วย (ตอบภาษาไทย ตรวจบั๊กและช่องโหว่ push `main` เท่านั้น) กฎเฉพาะของระบบนี้:

- รันเทสต์ในโฟลเดอร์นี้ให้ผ่านก่อน commit: `python3 -m unittest discover -s tests -v`
  (และเทสต์หน้าหลักที่โฟลเดอร์บนสุดของ repo: `python3 -m unittest discover -s tests -v`)
- ใช้เฉพาะ Python standard library (Python 3.8+)
- หน้าเว็บ GitHub Pages คือ `index.html`, `app.js`, `worker.js`, `csv2vcf.js`, `csv2vcf-data.js` ในโฟลเดอร์นี้
  (HTML/CSS/JavaScript ไม่มี dependency ภายนอก ใช้ path แบบ relative มีลิงก์กลับหน้าหลัก `../index.html`)
  เมื่อแก้ `csv2vcf.py` ต้องแก้ `csv2vcf.js` ให้ได้ผลเหมือนกัน และรัน `python3 tools/build_js_data.py`
  ถ้าแก้ตารางข้อมูล (`tests/test_static_site.py` เทียบผลสองภาษา ต้องมี Node.js)
- `style.css` กับ `web/style.css` ต้องเหมือนกันทุกไบต์
- ห้าม commit ไฟล์รายชื่อจริง (`*.csv`, `*.vcf`) ยกเว้นไฟล์ตัวอย่าง `example.csv`
