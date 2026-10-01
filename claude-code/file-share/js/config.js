/*
 * ค่าตั้งค่าของระบบฝากไฟล์ — ผู้ดูแลระบบต้องใส่ Client ID ก่อนใช้ Google Drive / OneDrive (วิธีสร้างอยู่ใน README.md)
 *
 * Client ID ไม่ใช่ความลับ (เบราว์เซอร์ทุกเครื่องเห็นอยู่แล้ว) ใส่ในไฟล์นี้ได้ แต่ห้ามใส่ Client Secret หรือรหัสผ่านใด ๆ
 * เพราะทุกไฟล์ใน repo นี้เป็นสาธารณะ — ระบบนี้ไม่ต้องใช้ Client Secret เลย
 *
 * redirect URI ที่ต้องลงทะเบียนทั้ง Google และ Microsoft:
 *   https://envburiramclub.github.io/claude-code/file-share/index.html
 */
window.FILE_SHARE_CONFIG = {
  // Google Cloud Console → APIs & Services → Credentials → OAuth client ID (ชนิด Web application)
  googleClientId: '362694565096-0bt17rd0eujd6inolfrsv200gahcc1gu.apps.googleusercontent.com',
  // Microsoft Entra ID (Azure) → App registrations → Application (client) ID (แพลตฟอร์ม Single-page application)
  microsoftClientId: '8eeb9af7-8531-429d-83e9-ef647592850a',
  // ต้องตรงกับ "Supported account types" ของแอปใน Entra ID:
  //   'consumers' = Personal Microsoft accounts only (outlook.com/hotmail/live) — แอปนี้ลงทะเบียนแบบนี้
  //   'common' = บัญชีส่วนตัวและบัญชีองค์กร, 'organizations' = บัญชีองค์กร/โรงเรียนเท่านั้น
  // ถ้าไม่ตรง Microsoft จะปฏิเสธตอนแลกรหัสเข้าสู่ระบบ (AADSTS9002331 / AADSTS50194)
  microsoftAuthority: 'consumers'
};
