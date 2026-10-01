# ฝากไฟล์ (file-share/)

เปิดใช้งาน: <https://envburiramclub.github.io/claude-code/file-share/>

อัปโหลดไฟล์ละไม่เกิน 100 MB แล้วรับลิงก์ไปแชร์ เลือกที่ฝากได้ 3 แบบ:

| ที่ฝาก | เข้าสู่ระบบ | ข้อจำกัดสำคัญ |
| --- | --- | --- |
| Google Drive | Gmail ของผู้ใช้เอง | ใช้พื้นที่ Drive ของผู้ใช้ (ฟรี 15 GB) ไฟล์อยู่ในโฟลเดอร์ "ระบบฝากไฟล์" และระบบเห็นเฉพาะไฟล์ที่อัปโหลดผ่านระบบนี้ |
| Microsoft OneDrive | Outlook/Hotmail ของผู้ใช้เอง | ใช้พื้นที่ OneDrive ของผู้ใช้ (ฟรี 5 GB) ไฟล์อยู่ในโฟลเดอร์ Apps ของแอป ตอนนี้ตั้งค่าให้ใช้ได้เฉพาะบัญชี Microsoft ส่วนตัว |
| tmpfiles.org | ไม่ต้อง | สาธารณะ ไม่เกิน 100 MB (ฐานสิบ) ลบอัตโนมัติหลัง 60 นาที |
| Gofile.io | ไม่ต้อง | สาธารณะ ไฟล์ที่ไม่มีคนดาวน์โหลดนาน ๆ อาจถูกลบ ลบเองไม่ได้ |

- **ลิงก์แชร์:** ไฟล์ใน Drive/OneDrive เป็นส่วนตัว จนกว่าจะติ๊ก "ให้ทุกคนที่มีลิงก์ดาวน์โหลดได้"
- **ดูและลบไฟล์:** ดูรายการไฟล์ที่ฝากไว้และลบได้ (ไฟล์ไปอยู่ในถังขยะ กู้คืนได้)
- **ไม่มีเซิร์ฟเวอร์ของตัวเอง:** ไฟล์ส่งตรงจากเบราว์เซอร์ไปยังผู้ให้บริการด้วย REST API
- **ไม่มีไลบรารีภายนอก:** ไม่ใช้ CDN เลย เข้าสู่ระบบด้วย OAuth 2.0 ที่เขียนเอง
- **ไม่เก็บโทเคน:** โทเคนการเข้าสู่ระบบอยู่ในหน่วยความจำเท่านั้น (หมดอายุใน 1 ชั่วโมง ปิดหน้าแล้วต้องเข้าสู่ระบบใหม่)
- **เว็บฝากไฟล์ฟรีเป็นบริการภายนอก:** อาจปิด เปลี่ยน API หรือไม่รับไฟล์จากเว็บอื่นได้ทุกเมื่อ หน้าเว็บจะแจ้งให้ลองอีกบริการ

## ตั้งค่า Google Drive และ OneDrive (ผู้ดูแลระบบทำครั้งเดียว)

ต้องลงทะเบียนแอปกับ Google และ Microsoft แล้วใส่ Client ID ใน `js/config.js`
Client ID ไม่ใช่ความลับ ใส่ใน repo ได้ **ไม่ต้องสร้างและห้ามใส่ Client Secret**

redirect URI ที่ใช้ทั้งสองแห่ง (ต้องเป็น URL เต็มนี้ตรงทุกตัวอักษร **ใส่แค่ `https://envburiramclub.github.io` ไม่ได้**):

```
https://envburiramclub.github.io/claude-code/file-share/index.html
```

### Google Drive

1. เข้า <https://console.cloud.google.com/> แล้วสร้างโปรเจกต์ใหม่
2. เปิด Google Drive API: APIs & Services → Library → "Google Drive API" → Enable
3. ตั้งค่า Google Auth Platform (หน้ายินยอม OAuth):
   - **Branding:** กรอกให้ครบก่อน ไม่งั้นปุ่ม Publish app กดไม่ได้ ("To publish your app, you must complete your configuration on the Branding page")
     - App name: `ระบบฝากไฟล์` / User support email และ Developer contact information: อีเมลของผู้ดูแล
     - App logo: **เว้นว่าง** (ใส่โลโก้แล้ว Google บังคับให้ส่งแอปตรวจสอบ)
     - Application home page: `https://envburiramclub.github.io/claude-code/file-share/index.html`
     - Application privacy policy link: `https://envburiramclub.github.io/claude-code/file-share/privacy.html`
     - Application terms of service link: เว้นว่างได้
     - Authorized domains: `envburiramclub.github.io`
   - **Audience:** External แล้วกด **Publish app** → Confirm (สถานะต้องเป็น In production)
     ถ้ายังเป็น Testing จะใช้ได้เฉพาะอีเมลที่เพิ่มเป็น Test users (รวมถึงบัญชีของผู้ดูแลเองด้วย)
     อย่าอัปโหลดโลโก้และอย่าเพิ่ม scope อื่น ไม่งั้น Google จะบังคับให้ส่งแอปตรวจสอบก่อน
   - **Data Access:** เพิ่ม scope `https://www.googleapis.com/auth/drive.file`
     (สิทธิ์เฉพาะไฟล์ที่แอปสร้าง ไม่ใช่สิทธิ์อ่อนไหว จึงไม่ต้องขอตรวจสอบแอป)
4. สร้าง Client ID: **Clients** → Create client → Web application
   - Authorized JavaScript origins: `https://envburiramclub.github.io` (โดเมนอย่างเดียว)
   - Authorized redirect URIs: URL เต็มด้านบน (มี `/claude-code/file-share/index.html`)
   - กด Save แล้วรอ 5 นาทีถึงไม่กี่ชั่วโมงให้ Google อัปเดต
5. คัดลอก Client ID (ลงท้าย `.apps.googleusercontent.com`) ใส่ใน `googleClientId` ของ `js/config.js`

### Microsoft OneDrive

1. เข้า <https://entra.microsoft.com/> → App registrations → New registration
   - Name: เช่น "ระบบฝากไฟล์" (OneDrive สร้างโฟลเดอร์ Apps/ชื่อนี้)
   - Supported account types: ตั้ง `microsoftAuthority` ใน `js/config.js` ให้ตรงกัน
     - "Personal Microsoft accounts only" → `'consumers'` (ค่าปัจจุบัน)
     - "Accounts in any organizational directory and personal Microsoft accounts" → `'common'`
     - "Accounts in any organizational directory" → `'organizations'`
   - Redirect URI: แพลตฟอร์ม **Single-page application (SPA)** และ URL ด้านบน (ต้องเป็น SPA ไม่งั้นแลกรหัสเข้าสู่ระบบไม่ได้)
2. API permissions: Microsoft Graph → Delegated → `Files.ReadWrite` และ `User.Read`
3. คัดลอก Application (client) ID ใส่ใน `microsoftClientId` ของ `js/config.js`

### แก้ปัญหาเข้าสู่ระบบไม่ได้

| ข้อความที่เห็น | สาเหตุและวิธีแก้ |
| --- | --- |
| Google: `Error 400: redirect_uri_mismatch` | Authorized redirect URIs ไม่มี URL เต็มด้านบน เพิ่มแล้วรอให้ Google อัปเดต |
| Google: `Access blocked: ... has not completed the Google verification process` และ `Error 403: access_denied` | หน้ายินยอมยังเป็น Testing: Google Auth Platform → Audience → Publish app (ทุกคนใช้ได้) หรือ Test users → Add users (เฉพาะอีเมลที่เพิ่ม) |
| Google: ปุ่ม Publish app กดไม่ได้ และมีข้อความ `you must complete your configuration on the Branding page` | กรอกหน้า Branding ให้ครบตามขั้นตอนที่ 3 ด้านบน แล้วกลับไปกด Publish app |
| Google: `Google Drive API has not been used in project` | ยังไม่ได้ Enable Google Drive API ในโปรเจกต์ |
| Microsoft: `AADSTS50011` หรือ (บัญชีส่วนตัว) `invalid_request: The provided value for the input parameter 'redirect_uri' is not valid` | ยังไม่ได้ลงทะเบียน URL เต็มด้านบน: App registrations → แอป → Authentication → Add a platform → Single-page application → ใส่ URL เต็ม → Configure |
| Microsoft (หน้า login.live.com): `server_error: The contextID supplied in the request did not have a matching cookie` | คุกกี้ของหน้าเข้าสู่ระบบ Microsoft ไม่ตรง (กดย้อนกลับ/รีเฟรช/ค้างหน้านานหรือเปิดหลายแท็บ ส่วนขยายบล็อกคุกกี้ หรือ Edge เข้าสู่ระบบ Microsoft อัตโนมัติ) ปิดหน้านั้นแล้วเริ่มจากหน้าฝากไฟล์ใหม่ ถ้ายังไม่ได้ลองหน้าต่าง InPrivate หรือลบคุกกี้ของ live.com — ไม่ใช่ปัญหาการตั้งค่าแอป |
| Microsoft: `AADSTS9002331` หรือ `AADSTS50194` | `microsoftAuthority` ไม่ตรงกับ Supported account types ของแอป |
| Microsoft: `AADSTS70002: ... must include a 'client_secret'`, `AADSTS7000218` หรือ `AADSTS9002326` | Redirect URI ลงทะเบียนเป็น Web แทน SPA: Authentication → ลบ URL ใต้ Web → Add a platform → Single-page application → ใส่ URL เต็ม (ห้ามแก้ด้วยการสร้าง Client Secret) |

## ไฟล์

| ไฟล์ | หน้าที่ |
| --- | --- |
| `index.html`, `css/app.css`, `favicon.svg` | หน้าเว็บ (CSP อนุญาตสคริปต์จากเว็บนี้เท่านั้น และส่งข้อมูลได้เฉพาะ API ของที่ฝากไฟล์) |
| `privacy.html` | นโยบายความเป็นส่วนตัว (Google ต้องใช้ลิงก์นี้ในหน้า Branding ก่อน Publish app) — ถ้าระบบเข้าถึงข้อมูลเพิ่ม ต้องแก้หน้านี้ด้วย |
| `js/config.js` | Client ID ของ Google/Microsoft (ผู้ดูแลระบบใส่) |
| `js/core.js` | ฟังก์ชันล้วน: ขีดจำกัดไฟล์, ชื่อไฟล์, URL เข้าสู่ระบบ, PKCE, ตรวจลิงก์จาก API |
| `js/providers.js` | อัปโหลด/รายการ/ลบไฟล์ของ Google Drive, OneDrive, tmpfiles.org, Gofile ผ่าน REST API |
| `js/app.js` | ควบคุมหน้าเว็บ เข้าสู่ระบบแบบ redirect คิวอัปโหลด |
| `tests/test_fileshare.py`, `tests/harness.js` | เทสต์ฟังก์ชันใน `js/core.js` (Node.js) และตรวจความปลอดภัยของหน้าเว็บ |

## ความปลอดภัย

- **เข้าสู่ระบบ:** แบบ redirect ตามมาตรฐาน OAuth 2.0 และตรวจค่า `state` ทุกครั้ง
  - Google: implicit grant ได้โทเคนใน `#fragment`
  - Microsoft: authorization code + PKCE ไม่ใช้ Client Secret
  - โทเคนและรหัสถูกลบออกจาก URL ทันที
- **สิ่งที่เก็บในเครื่อง:**
  - `sessionStorage` เก็บเฉพาะ `state`/PKCE verifier ระหว่างไปหน้าเข้าสู่ระบบ (key `file-share:auth` ลบทันทีที่กลับมา อายุไม่เกิน 10 นาที)
  - `localStorage` เก็บแค่ที่ฝากที่เลือกล่าสุด (key `file-share:provider`)
- **ลิงก์และชื่อไฟล์:**
  - ลิงก์ที่ได้จาก API ต้องเป็น https และอยู่ในโดเมนของผู้ให้บริการเท่านั้น
  - ชื่อไฟล์ตัดอักขระล่องหน/กลับทิศข้อความก่อนแสดงและอัปโหลด

## เทสต์

```bash
python3 -m unittest discover -s tests -v
```

บางเทสต์ต้องมี Node.js ถ้าไม่มีจะข้าม
