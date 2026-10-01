/*
 * heic-worker.js — Web Worker ที่ถอดรหัสภาพ HEIC/HEIF (รูปจาก iPhone และมือถือ Android หลายรุ่น) ด้วย libheif
 * แยกจากหน้าเว็บ หน้าจอจึงไม่ค้างระหว่างถอดรหัส — ใช้เฉพาะเมื่อเบราว์เซอร์ถอดรหัสไฟล์นั้นเองไม่ได้
 *
 * ข้อความเข้า:
 *   { type: 'decode', id, lib, buffer, maxPixels }   lib = URL ของ vendor/libheif/libheif-bundle.js (เว็บไซต์เดียวกัน
 *                                                    หรือ blob: ที่หน้าเว็บสร้าง — เวอร์ชัน Apps Script)
 * ข้อความออก:
 *   { type: 'result', id, width, height, data }      data = RGBA (ArrayBuffer ส่งแบบ transfer)
 *   { type: 'result', id, error, code? }             code: 'too-large' | 'not-heif'
 */
'use strict';

var heif = null;
var decoder = null;

function sameOrigin(url) {
  try { return new URL(url, self.location.href).origin === self.location.origin; } catch (e) { return false; }
}

function load(lib) {
  if (heif) return heif;
  if (typeof lib !== 'string' || !sameOrigin(lib)) throw new Error('อนุญาตเฉพาะไฟล์จากเว็บไซต์เดียวกัน');
  importScripts(lib);
  if (typeof self.libheif !== 'function') throw new Error('โหลดตัวถอดรหัส HEIC ไม่สำเร็จ');
  heif = self.libheif();
  return heif;
}

/** ถอดรหัสภาพแรกของไฟล์เป็น RGBA — display() ของ libheif ทำงานแบบ async จึงคืนหน่วยความจำหลังได้ผลเท่านั้น */
function decodeOne(msg) {
  if (!(msg.buffer instanceof ArrayBuffer) || !msg.buffer.byteLength) throw new Error('ไม่มีข้อมูลภาพ');
  var maxPixels = Number(msg.maxPixels) > 0 ? Number(msg.maxPixels) : 40e6;
  var lib = load(msg.lib);
  if (!decoder) decoder = new lib.HeifDecoder(); // ใช้ตัวเดิม: decode ครั้งถัดไปคืนหน่วยความจำของไฟล์ก่อนเอง
  var images = decoder.decode(new Uint8Array(msg.buffer)) || [];
  var free = function () { images.forEach(function (im) { try { if (im && im.free) im.free(); } catch (_) { /* ignore */ } }); };
  if (!images.length) { free(); return Promise.resolve({ error: 'ไม่ใช่ไฟล์ HEIC/HEIF ที่อ่านได้', code: 'not-heif' }); }
  var img = images[0]; // ภาพหลัก
  var w = img.get_width(), h = img.get_height();
  if (!(w > 0 && h > 0)) { free(); return Promise.resolve({ error: 'ขนาดภาพไม่ถูกต้อง' }); }
  if (w * h > maxPixels) { free(); return Promise.resolve({ error: 'ภาพใหญ่เกินไป', code: 'too-large' }); }
  var out = new Uint8ClampedArray(w * h * 4);
  return new Promise(function (resolve) {
    img.display({ data: out, width: w, height: h }, function (d) {
      free();
      resolve(d ? { width: w, height: h, data: out.buffer } : { error: 'ถอดรหัส HEIC ไม่สำเร็จ' });
    });
  });
}

// ทีละไฟล์ตามลำดับ (ไฟล์ถัดไปเริ่มหลังไฟล์ก่อนถอดรหัสเสร็จ)
var chain = Promise.resolve();

function decode(msg) {
  chain = chain.then(function () {
    return Promise.resolve().then(function () { return decodeOne(msg); }).then(function (r) {
      if (r.data) self.postMessage({ type: 'result', id: msg.id, width: r.width, height: r.height, data: r.data }, [r.data]);
      else self.postMessage({ type: 'result', id: msg.id, error: r.error, code: r.code });
    }, function (e) {
      self.postMessage({ type: 'result', id: msg.id, error: (e && e.message) || String(e) });
    });
  });
}

self.onmessage = function (e) {
  var msg = e.data || {};
  if (msg.type === 'decode') decode(msg);
};
