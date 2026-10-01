# สร้าง QR Code (qrcode-generator/)

เปิดใช้งาน: <https://envburiramclub.github.io/claude-code/qrcode-generator/>

สร้าง QR Code ในเบราว์เซอร์ ข้อมูลที่กรอกไม่ถูกส่งขึ้นอินเทอร์เน็ต

- ประเภทข้อมูล: ลิงก์เว็บไซต์, ข้อความ (รองรับภาษาไทยและอีโมจิ), WiFi, เบอร์โทร, อีเมล และพร้อมเพย์
- พร้อมเพย์: ใช้เบอร์มือถือ 10 หลัก เลขประจำตัวประชาชน/ผู้เสียภาษี 13 หลัก หรือ e-Wallet 15 หลัก
  ใส่จำนวนเงินได้ (0 หรือเว้นว่าง = ผู้จ่ายกรอกเอง) เลขที่ความยาวไม่ถูกต้องจะไม่สร้าง QR
- ปรับสี รูปแบบจุด และมุม ใส่โลโก้กลาง QR ได้ (รูปภาพไม่เกิน 5 MB เมื่อมีโลโก้จะใช้ระดับแก้ข้อผิดพลาด H)
- ดาวน์โหลดเป็น PNG (1024×1024 พิกเซล) หรือ SVG
- สีธีมที่เลือกจำไว้ใน `localStorage` ของเบราว์เซอร์ (key `qrcode-generator:settings` ไม่เก็บข้อมูลที่กรอก)

## ไฟล์

| ไฟล์ | หน้าที่ |
| --- | --- |
| `index.html` | หน้าเว็บ (CSP อนุญาตเฉพาะไฟล์จากเว็บนี้ ไม่มีสคริปต์หรือสไตล์ในหน้า) |
| `js/payload.js` | สร้างข้อความใน QR แต่ละประเภท (พร้อมเพย์ EMVCo + CRC-16, WiFi, `tel:`, `mailto:`) ไม่ยุ่งกับหน้าเว็บ |
| `js/app.js` | ควบคุมหน้าเว็บ แสดงตัวอย่าง QR ดาวน์โหลด โลโก้ และธีม |
| `css/app.css` | สไตล์เฉพาะของหน้านี้ |
| `css/tailwind.css` | คลาส Tailwind ที่หน้านี้ใช้ (สร้างจากคำสั่งด้านล่าง ห้ามแก้ด้วยมือ) |
| `css/fonts.css`, `vendor/fonts/` | ฟอนต์ K2D (SIL OFL 1.1) เก็บในเว็บนี้ ไม่โหลดจาก Google Fonts |
| `vendor/qr-code-styling/` | ไลบรารี qr-code-styling 1.9.2 (MIT) ค่า SHA-256 อยู่ใน `SHA256SUMS` |
| `tests/test_qrcode.py`, `tests/harness.js` | เทสต์ข้อความใน QR (รัน `js/payload.js` ด้วย Node.js) และตรวจความปลอดภัยของหน้าเว็บ |

## สร้าง css/tailwind.css ใหม่

เมื่อเพิ่มหรือเปลี่ยนคลาส Tailwind ใน `index.html` หรือ `js/app.js` ให้รันที่โฟลเดอร์นี้:

```bash
npx tailwindcss@3.4.17 --content "./index.html,./js/app.js" -o css/tailwind.css --minify
```

## เทสต์

```bash
python3 -m unittest discover -s tests -v
```

บางเทสต์ต้องมี Node.js ถ้าไม่มีจะข้าม
