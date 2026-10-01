/*!
 * Code.gs - จุดเข้าเว็บแอปของระบบรับสมัครสมาชิก (Google Apps Script)
 * ---------------------------------------------------------------
 * แอปเป็นเว็บหน้าเดียว (SEP: Single Entry Point ตามข้อจำกัดของ Google Apps Script)
 * ใช้พารามิเตอร์ <?!= ScriptApp.getService().getUrl(); ?>?page=xxx เพื่อเลือกหน้าที่จะแสดง แทนชื่อไฟล์ .html แบบเดิม
 * Backend (Server-side) เป็น Supabase (Postgres + RLS + RPC + Storage)
 */

/** แผนที่ page key -> ไฟล์เทมเพลตใน pages/ (ชื่อไฟล์ไม่ต้องมีนามสกุล .html) */
var PAGE_MAP = {
  "index": { file: "pages/index", title: "ชมรมอนามัยสิ่งแวดล้อมจังหวัดบุรีรัมย์" },
  "login": { file: "pages/login", title: "เข้าสู่ระบบ" },
  "register": { file: "pages/register", title: "สมัครใช้งานระบบ" },
  "forgot": { file: "pages/forgot", title: "ลืมรหัสผ่าน" },
  "reset": { file: "pages/reset", title: "ตั้งรหัสผ่านใหม่" },
  "terms": { file: "pages/terms", title: "ข้อตกลงการใช้บริการ" },
  "privacy": { file: "pages/privacy", title: "นโยบายคุ้มครองข้อมูลส่วนบุคคล" },
  "verify": { file: "pages/verify", title: "ตรวจสอบบัตรสมาชิก" },
  "app": { file: "pages/app", title: "สถานะการสมัคร" },
  "apply": { file: "pages/apply", title: "ใบสมัครสมาชิก" },
  "payment": { file: "pages/payment", title: "ชำระค่าสมัครและแนบสลิป" },
  "card": { file: "pages/card", title: "บัตรสมาชิก" },
  "receipt": { file: "pages/receipt", title: "ใบสำคัญรับเงิน" },
  "admin-index": { file: "pages/admin_index", title: "เข้าสู่ระบบผู้ดูแล" },
  "admin-dashboard": { file: "pages/admin_dashboard", title: "ภาพรวม | ระบบผู้ดูแล" },
  "admin-applications": { file: "pages/admin_applications", title: "ตรวจใบสมัคร | ระบบผู้ดูแล" },
  "admin-payments": { file: "pages/admin_payments", title: "ตรวจสลิป | ระบบผู้ดูแล" },
  "admin-members": { file: "pages/admin_members", title: "ทะเบียนสมาชิก | ระบบผู้ดูแล" },
  "admin-member-edit": { file: "pages/admin_member_edit", title: "แก้ไขข้อมูลสมาชิก | ระบบผู้ดูแล" },
  "admin-audit": { file: "pages/admin_audit", title: "ประวัติการแก้ไข | ระบบผู้ดูแล" },
  "admin-announcements": { file: "pages/admin_announcements", title: "ประชาสัมพันธ์ | ระบบผู้ดูแล" },
  "admin-signatories": { file: "pages/admin_signatories", title: "ผู้ลงนามในเอกสาร | ระบบผู้ดูแล" },
  "admin-settings": { file: "pages/admin_settings", title: "ตั้งค่าระบบ | ระบบผู้ดูแล" }
};

/*
 * พารามิเตอร์ที่ยอมส่งต่อให้หน้าเว็บ
 *
 * ส่งเฉพาะรายการที่หน้าเว็บใช้จริง ไม่ส่งทั้งก้อนของ e.parameter
 * เพื่อไม่ให้ผู้ใด ๆ ยัดค่าแปลกปลอมเข้ามาอยู่ในหน้าเว็บผ่าน URL ได้ตามใจ
 */
var ALLOWED_PARAMS = [
  "page",   // หน้าที่จะแสดง
  "next",   // ปลายทางหลังเข้าสู่ระบบ (หน้า login และ admin-index)
  "id",     // รหัสสมาชิก (หน้า admin-member-edit)
  "t",      // รหัสตรวจสอบบัตร (หน้า verify และ QR หลังบัตร)
  "token",  // ชื่อเดิมของ t ยังรับไว้เพื่อไม่ให้ลิงก์เก่าที่แจกไปแล้วใช้ไม่ได้

  /*
   * โทเคนจากลิงก์ในอีเมลของ Supabase (ตั้งรหัสผ่านใหม่ / ยืนยันอีเมล)
   * ลิงก์แบบเดิมส่งโทเคนมาหลังเครื่องหมาย # ซึ่งไม่ถูกส่งมาถึงเซิร์ฟเวอร์
   * และหน้าเว็บในกรอบของ Apps Script ก็อ่านจากหน้านอกไม่ได้ จึงใช้ไม่ได้เลย
   * ต้องตั้งเทมเพลตอีเมลให้ส่งมาเป็นพารามิเตอร์ token_hash แทน
   */
  "token_hash",
  "type"
];

/** ความยาวสูงสุดของค่าพารามิเตอร์แต่ละตัว กัน URL ยาวผิดปกติ */
var MAX_PARAM_LEN = 200;

/*
 * โดเมนของหน้าครอบที่ยอมให้นำเว็บแอปนี้ไปแสดงในกรอบ (iframe)
 *
 * Google แสดงแถบ "แอปพลิเคชันนี้สร้างโดยผู้ใช้ Google Apps Script" เหนือเว็บแอป
 * ของบัญชี Gmail ทั่วไปทุกตัว และไม่มีค่าตั้งใดในโค้ดปิดแถบนี้ได้
 * เพราะแถบอยู่ในหน้านอกของ Google ซึ่งหน้าเว็บของเราอยู่ในกรอบชั้นในเข้าไปแตะไม่ได้
 * ทางที่ใช้ได้จริงคือให้ผู้ใช้เปิดหน้าครอบบน GitHub Pages ของชมรม
 * แล้วหน้านั้นครอบเว็บแอปไว้ในกรอบอีกชั้น Google ไม่แสดงแถบเมื่อเว็บแอปอยู่ในกรอบ
 *
 * รายการนี้ใช้สองที่
 *   1. ลิงก์ของหน้าครอบที่ส่งมาทาง ?host= ต้องอยู่ในโดเมนเหล่านี้เท่านั้น
 *   2. partials/js_frame_guard ยอมแสดงหน้าเว็บในกรอบ เฉพาะเมื่อหน้าบนสุดมาจากโดเมนเหล่านี้
 * ถ้าย้ายหน้าครอบไปโดเมนอื่น (เช่น โดเมนของชมรมเอง) ต้องเพิ่มโดเมนนั้นที่นี่
 */
var HOST_ORIGINS = ["https://envburiramclub.github.io"];

/**
 * ผนวกไฟล์ HTML อีกไฟล์เข้ากับเทมเพลตปัจจุบัน
 * เรียกจากไฟล์ pages/*.html ผ่าน scriptlet: <?!= include('partials/xxx'); ?>
 * ใช้ createHtmlOutputFromFile (ไม่ใช่ createTemplateFromFile) จึงคืนเนื้อหาดิบ
 * โดยไม่ตีความ <? ... ?> ซ้ำ - ปลอดภัยแม้เนื้อหาไฟล์ (โค้ด JS/CSS ขนาดใหญ่) จะมีอักขระพิเศษ
 *
 * ข้อควรระวัง: ไฟล์ใน partials/ จึงใส่ scriptlet ไม่ได้ ค่าที่ต้องมาจากฝั่งเซิร์ฟเวอร์
 * (ลิงก์เว็บแอปและพารามิเตอร์จาก URL) ถูกวางไว้ใน window.GAS ของไฟล์หน้าแทน
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * จุดเข้าเว็บแอป (Web App) ของ Google Apps Script
 * e.parameter.page กำหนดว่าจะแสดงหน้าใด ตามผังใน PAGE_MAP
 */
function doGet(e) {
  var params = (e && e.parameter) || {};
  var pageKey = String(params.page || "index");

  /*
   * ต้องใช้ hasOwnProperty ไม่ใช่ PAGE_MAP[pageKey] เฉย ๆ
   * เพราะชื่ออย่าง "constructor" หรือ "toString" มีอยู่ในต้นแบบของอ็อบเจ็กต์ทุกตัว
   * การเช็คแบบเดิมจะถือว่าเป็นหน้าที่มีอยู่จริง แล้วไปล้มตอนอ่านไฟล์
   */
  if (!Object.prototype.hasOwnProperty.call(PAGE_MAP, pageKey)) pageKey = "index";
  var entry = PAGE_MAP[pageKey];

  try {
    var execUrl = ScriptApp.getService().getUrl();
    var tpl = HtmlService.createTemplateFromFile(entry.file);
    /*
     * ลิงก์ฐานของทุกลิงก์ในหน้า
     * เปิดผ่านหน้าครอบ = ลิงก์ของหน้าครอบ ผู้ใช้จึงอยู่ในหน้าที่ไม่มีแถบของ Google ตลอด
     * ถ้าใช้ลิงก์ /exec กดครั้งเดียวก็หลุดออกจากหน้าครอบ แถบจะกลับมาทันที
     * เปิดตรงที่ /exec = ลิงก์ของเว็บแอปเหมือนเดิม
     */
    tpl.URL = hostUrl_(params.host) || execUrl;
    tpl.PARAMS = jsonForScript_(pickParams_(params));
    tpl.FRAME_GUARD = frameGuardHtml_(execUrl, pageKey);
    return tpl
      .evaluate()
      .setTitle(entry.title)
      .addMetaTag("viewport", "width=device-width, initial-scale=1")
      /*
       * ต้องเป็น ALLOWALL หน้าครอบบน GitHub Pages จึงนำเว็บแอปไปแสดงในกรอบได้
       * ค่า DEFAULT ห้ามเว็บอื่นครอบ ซึ่งทำให้ซ่อนแถบของ Google ไม่ได้เลย
       *
       * ALLOWALL เพียงอย่างเดียวเปิดช่องให้เว็บใดก็ได้ซ้อนหน้านี้ไว้ใต้หน้าเว็บปลอม
       * แล้วหลอกให้ผู้ใช้กดปุ่มโดยไม่รู้ตัว (clickjacking) ช่องนี้ปิดด้วย
       * partials/js_frame_guard ที่ทุกหน้าโหลดไว้ในส่วน head ซึ่งซ่อนทั้งหน้าไว้
       * จนกว่าจะยืนยันได้ว่าหน้าบนสุดมาจากโดเมนใน HOST_ORIGINS
       */
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (err) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:sans-serif;padding:24px">เกิดข้อผิดพลาด: ' +
        escapeHtml_(err && err.message ? err.message : err) +
      '</div>'
    );
  }
}

/**
 * ตัวช่วยทั่วไป
 */
function escapeHtml_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** คัดเฉพาะพารามิเตอร์ในบัญชีขาว พร้อมตัดความยาวส่วนเกินทิ้ง */
function pickParams_(params) {
  var out = {};
  for (var i = 0; i < ALLOWED_PARAMS.length; i++) {
    var k = ALLOWED_PARAMS[i];
    if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
    var v = params[k];
    if (v === null || v === undefined) continue;
    out[k] = String(v).slice(0, MAX_PARAM_LEN);
  }
  return out;
}

/**
 * ตรวจลิงก์ของหน้าครอบที่ส่งมาทาง ?host= คืนค่าว่างถ้าไม่ผ่าน
 *
 * ใครก็ใส่ ?host= เองได้ ถ้ารับทุกค่า ลิงก์ทุกลิงก์ในหน้าจะพาผู้ใช้ไปเว็บปลอมได้
 * จึงรับเฉพาะลิงก์ที่ขึ้นต้นด้วยโดเมนใน HOST_ORIGINS ตามด้วยพาธล้วน ๆ
 * ห้ามมี ? # เครื่องหมายคำพูด หรือ < > เพราะค่านี้ถูกวางลงใน href และในสคริปต์ของหน้าโดยตรง
 */
function hostUrl_(raw) {
  if (raw === null || raw === undefined) return "";
  var s = String(raw);
  if (s.length > MAX_PARAM_LEN) return "";
  for (var i = 0; i < HOST_ORIGINS.length; i++) {
    var origin = HOST_ORIGINS[i];
    if (s.indexOf(origin + "/") !== 0) continue;
    return /^\/[A-Za-z0-9._~%\/-]*$/.test(s.slice(origin.length)) ? s : "";
  }
  return "";
}

/**
 * สคริปต์กันการนำหน้าไปซ้อนในเว็บอื่น พร้อมค่าตั้งที่สคริปต์ต้องใช้
 * วางไว้ใน head ของทุกหน้าผ่าน <?!= FRAME_GUARD ?> ให้ทำงานก่อนเนื้อหาหน้าจะแสดง
 *   origins = โดเมนของหน้าครอบที่ยอมรับ
 *   direct  = ลิงก์เปิดหน้าเดิมโดยตรง ใช้ในข้อความแจ้งเมื่อพบว่าถูกซ้อนในเว็บอื่น
 */
function frameGuardHtml_(execUrl, pageKey) {
  var cfg = {
    origins: HOST_ORIGINS,
    direct: execUrl + "?page=" + encodeURIComponent(pageKey)
  };
  return "<script>window.GAS_FRAME = " + jsonForScript_(cfg) + ";</script>\n" +
    include("partials/js_frame_guard");
}

/**
 * แปลงค่าเป็น JSON ที่วางในบล็อก <script> ได้อย่างปลอดภัย
 *
 * JSON.stringify เพียงอย่างเดียวไม่พอ เพราะถ้าค่ามีข้อความว่า </script>
 * เบราว์เซอร์จะถือว่าบล็อกสคริปต์จบตรงนั้น แล้วอ่านส่วนที่เหลือเป็น HTML
 * กลายเป็นช่องให้แทรกสคริปต์ผ่าน URL ได้ (XSS)
 * จึงต้องเข้ารหัส < > & เป็นรูปแบบ \u ซึ่ง JSON อ่านได้ค่าเดิมทุกประการ
 * และอักขระ U+2028 U+2029 ที่ JavaScript ถือเป็นตัวขึ้นบรรทัดใหม่แต่ JSON ไม่ถือ
 */
function jsonForScript_(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
