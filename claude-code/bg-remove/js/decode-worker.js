/*
 * decode-worker.js — Web Worker ถอดรหัสรูปที่เบราว์เซอร์ส่วนใหญ่เปิดเองไม่ได้
 *   HEIC/HEIF (รูปจาก iPhone และมือถือหลายรุ่น) ด้วย libheif, TIFF ด้วย UTIF.js (+ pako สำหรับการบีบอัดแบบ Deflate)
 * แยกจากหน้าเว็บ หน้าจอจึงไม่ค้าง และไฟล์ที่ทำให้ตัวถอดรหัสล่มไม่ทำให้หน้าเว็บล่มตาม
 *
 * ข้อความเข้า:  { type: 'decode', id, format: 'heif'|'tiff', buffer: ArrayBuffer, maxPixels, fitPixels, maxSide }
 *              maxPixels = ภาพใหญ่กว่านี้ไม่ถอดรหัส, fitPixels/maxSide = ย่อผลลัพธ์ให้ไม่เกินนี้ก่อนส่งกลับ
 * ข้อความออก:  { type: 'result', id, width, height, data: ArrayBuffer (RGBA), original: [w, h] } | { type: 'result', id, error }
 */
'use strict';

importScripts('core.js');

var heifLib = null;
var heifDecoder = null;
var utifLoaded = false;

function tooLarge(w, h, maxPixels) {
  if (!(w > 0 && h > 0)) throw new Error('ขนาดภาพไม่ถูกต้อง');
  if (w * h > maxPixels) throw new Error('ภาพใหญ่เกินไป (' + w + '×' + h + ' พิกเซล)');
}

function decodeHeif(buffer, maxPixels) {
  if (!heifLib) {
    importScripts('../vendor/libheif/libheif-bundle.js');
    if (typeof self.libheif !== 'function') throw new Error('โหลดตัวถอดรหัส HEIC ไม่สำเร็จ');
    heifLib = self.libheif();
  }
  if (!heifDecoder) heifDecoder = new heifLib.HeifDecoder(); // ใช้ตัวเดิม: ครั้งถัดไปคืนหน่วยความจำของไฟล์ก่อนเอง
  var images = heifDecoder.decode(new Uint8Array(buffer)) || [];
  var free = function () { images.forEach(function (im) { try { if (im && im.free) im.free(); } catch (e) { /* ignore */ } }); };
  if (!images.length) { free(); throw new Error('ไม่ใช่ไฟล์ HEIC/HEIF ที่อ่านได้'); }
  var img = images[0];
  var w = img.get_width(), h = img.get_height();
  try { tooLarge(w, h, maxPixels); } catch (e) { free(); throw e; }
  var out = new Uint8ClampedArray(w * h * 4);
  return new Promise(function (resolve, reject) {
    img.display({ data: out, width: w, height: h }, function (d) {
      free();
      if (d) resolve({ width: w, height: h, data: out.buffer });
      else reject(new Error('ถอดรหัส HEIC ไม่สำเร็จ'));
    });
  });
}

function tag(ifd, key) {
  var v = ifd && ifd[key];
  return v && v.length ? Number(v[0]) : 0;
}

function decodeTiff(buffer, maxPixels) {
  if (!utifLoaded) {
    importScripts('../vendor/utif/pako_inflate.min.js', '../vendor/utif/UTIF.js');
    if (!self.UTIF || typeof self.UTIF.decode !== 'function') throw new Error('โหลดตัวถอดรหัส TIFF ไม่สำเร็จ');
    utifLoaded = true;
  }
  var ifds = self.UTIF.decode(buffer);
  if (!ifds || !ifds.length) throw new Error('ไม่ใช่ไฟล์ TIFF ที่อ่านได้');
  // หน้าแรกที่มีภาพจริง (บางไฟล์มี IFD ของภาพย่อ/ข้อมูลอื่นก่อน) — เลือกหน้าที่ใหญ่ที่สุดใน 8 หน้าแรก
  var best = null;
  ifds.slice(0, 8).forEach(function (ifd) {
    var w = tag(ifd, 't256'), h = tag(ifd, 't257');
    if (w > 0 && h > 0 && (!best || w * h > tag(best, 't256') * tag(best, 't257'))) best = ifd;
  });
  if (!best) throw new Error('ไม่พบภาพในไฟล์ TIFF');
  tooLarge(tag(best, 't256'), tag(best, 't257'), maxPixels);
  self.UTIF.decodeImage(buffer, best, ifds);
  var rgba = self.UTIF.toRGBA8(best);
  var w = best.width, h = best.height;
  tooLarge(w, h, maxPixels);
  if (!rgba || rgba.length !== w * h * 4) throw new Error('ถอดรหัส TIFF ไม่สำเร็จ (รูปแบบการบีบอัดนี้ยังไม่รองรับ)');
  var out = new Uint8ClampedArray(rgba.length);
  out.set(rgba);
  return { width: w, height: h, data: out.buffer };
}

var chain = Promise.resolve();

self.onmessage = function (e) {
  var msg = e.data || {};
  if (msg.type !== 'decode') return;
  chain = chain.then(function () {
    return Promise.resolve().then(function () {
      if (!(msg.buffer instanceof ArrayBuffer) || !msg.buffer.byteLength) throw new Error('ไม่มีข้อมูลภาพ');
      var max = Number(msg.maxPixels) > 0 ? Number(msg.maxPixels) : 40e6;
      if (msg.format === 'heif') return decodeHeif(msg.buffer, max);
      if (msg.format === 'tiff') return decodeTiff(msg.buffer, max);
      throw new Error('ไม่รองรับไฟล์ชนิดนี้');
    }).then(function (r) {
      var fit = BgCore.fitSize(r.width, r.height, Number(msg.fitPixels) || 16e6, Number(msg.maxSide) || 8192);
      var original = [r.width, r.height];
      if (fit.width < r.width || fit.height < r.height) {
        r = { width: fit.width, height: fit.height, data: BgCore.resizeRGBA(new Uint8ClampedArray(r.data), r.width, r.height, fit.width, fit.height).buffer };
      }
      self.postMessage({ type: 'result', id: msg.id, width: r.width, height: r.height, data: r.data, original: original }, [r.data]);
    }, function (err) {
      self.postMessage({ type: 'result', id: msg.id, error: String((err && err.message) || err).slice(0, 300) });
    });
  });
};
