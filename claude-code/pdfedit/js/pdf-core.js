/*
 * PdfCore — ฟังก์ชันล้วนของหน้าแก้ไข PDF (ไม่ยุ่งกับหน้าเว็บ เทสต์ได้ใน Node: tests/harness.js)
 *
 * พิกัดขององค์ประกอบที่ผู้ใช้เพิ่ม (ข้อความ/รูป/ลายเซ็น) เก็บเป็นพิกัดของ PDF (หน่วย pt, แกน y ชี้ขึ้น)
 *   px, py = มุมซ้ายบนขององค์ประกอบ, rot = มุมหมุนของหน้า (/Rotate) ตอนที่เพิ่ม — องค์ประกอบตั้งตรงในมุมมองนั้น
 * หมุน/ลบ/เรียงหน้าใหม่แล้วองค์ประกอบจึงติดอยู่กับเนื้อหาเดิมบนหน้า และส่งออกได้ตรงตำแหน่งที่เห็น
 */
(function (root) {
  'use strict';

  var MAX_NAME = 100;

  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function own(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

  // ---------------------------------------------------------------- ตรวจชนิดไฟล์จากเนื้อไฟล์

  /** มี %PDF- ใน 1 KB แรก (PDF.js ยอมให้มีข้อมูลอื่นนำหน้าได้ เช่น ไฟล์แนบจากอีเมล) */
  function hasPdfHeader(bytes) {
    var n = Math.min(bytes.length, 1024) - 5;
    for (var i = 0; i <= n; i++) {
      if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) return true;
    }
    return false;
  }

  /** ชนิดรูปที่ pdf-lib ฝังได้ตรง ๆ: 'png' | 'jpeg' | null (ชนิดอื่นต้องแปลงผ่าน canvas ก่อน) */
  function imageKind(bytes) {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
        bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
    return null;
  }

  /**
   * ค่า EXIF Orientation ของ JPEG (1 = ตั้งตรง) — รูปจากมือถือมักเก็บภาพนอนแล้วบอกให้หมุนตอนแสดง
   * เบราว์เซอร์หมุนให้ แต่ pdf-lib ฝังไบต์ตรง ๆ ทำให้รูปใน PDF ตะแคง จึงต้องรู้ค่านี้ก่อน
   * อ่านเฉพาะส่วนหัว วนไม่เกินจำนวน segment/entry ที่กำหนด ไฟล์เสียคืน 1
   */
  function jpegOrientation(bytes) {
    if (imageKind(bytes) !== 'jpeg') return 1;
    var pos = 2;
    for (var seg = 0; seg < 64 && pos + 4 <= bytes.length; seg++) {
      if (bytes[pos] !== 0xff) return 1;
      var marker = bytes[pos + 1];
      if (marker === 0xda || marker === 0xd9) return 1; // เริ่มข้อมูลภาพแล้ว ไม่มี EXIF
      var len = (bytes[pos + 2] << 8) | bytes[pos + 3];
      if (len < 2) return 1;
      var start = pos + 4;
      if (marker === 0xe1 && len >= 16 && start + 6 <= bytes.length &&
          bytes[start] === 0x45 && bytes[start + 1] === 0x78 && bytes[start + 2] === 0x69 && bytes[start + 3] === 0x66 &&
          bytes[start + 4] === 0 && bytes[start + 5] === 0) {
        return tiffOrientation(bytes, start + 6, Math.min(bytes.length, pos + 2 + len));
      }
      pos += 2 + len;
    }
    return 1;
  }

  function tiffOrientation(b, t, end) {
    if (t + 8 > end) return 1;
    var le;
    if (b[t] === 0x49 && b[t + 1] === 0x49) le = true;
    else if (b[t] === 0x4d && b[t + 1] === 0x4d) le = false;
    else return 1;
    function u16(o) { return le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]; }
    function u32(o) { return le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216 : b[o] * 16777216 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]); }
    if (u16(t + 2) !== 42) return 1;
    var ifd = t + u32(t + 4);
    if (ifd + 2 > end) return 1;
    var count = Math.min(u16(ifd), 512);
    for (var i = 0; i < count; i++) {
      var e = ifd + 2 + i * 12;
      if (e + 12 > end) return 1;
      if (u16(e) === 0x0112) {
        var v = u16(e + 8);
        return v >= 1 && v <= 8 ? v : 1;
      }
    }
    return 1;
  }

  // ---------------------------------------------------------------- ข้อความและสี

  /**
   * pdf-lib + fontkit ไม่จัดตำแหน่งสระอำตามหลังวรรณยุกต์ในฟอนต์ TH Sarabun New ให้ถูก ("ป่ำ" มีช่องว่างใหญ่)
   * แยกสระอำเป็นนิคหิต + สระอา แบบที่ตัวจัดรูปอักษรไทยทำ (ํ ไปอยู่ก่อนวรรณยุกต์) ผลที่เห็นเหมือนเดิมทุกประการ
   */
  function shapeThai(text) {
    return str(text).replace(/([\u0E48-\u0E4B])\u0E33/g, '\u0E4D$1\u0E32');
  }

  /** ข้อความที่ผู้ใช้พิมพ์: ตัดอักขระควบคุม (ยกเว้นขึ้นบรรทัด/แท็บ) ขึ้นบรรทัดแบบเดียว ตัดช่องว่างท้าย จำกัดความยาว */
  function cleanText(text, maxLength) {
    var t = str(text).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
    t = t.replace(/\t/g, '    ');
    var end = t.length;
    while (end > 0 && /\s/.test(t.charAt(end - 1))) end--; // ตัดท้ายด้วยลูป (regex /\s+$/ ช้ากับข้อความยาว)
    t = t.slice(0, end);
    return maxLength && t.length > maxLength ? t.slice(0, maxLength) : t;
  }

  function hexColor(v, fallback) {
    var s = str(v).trim();
    return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : (fallback === undefined ? '#000000' : fallback);
  }

  /** '#rrggbb' → { r, g, b } ช่วง 0..1 สำหรับ pdf-lib */
  function hexToRgb01(hex) {
    var h = hexColor(hex);
    return {
      r: parseInt(h.slice(1, 3), 16) / 255,
      g: parseInt(h.slice(3, 5), 16) / 255,
      b: parseInt(h.slice(5, 7), 16) / 255
    };
  }

  function clamp(v, min, max, fallback) {
    var n = typeof v === 'number' ? v : Number(str(v).trim() === '' ? NaN : v);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  // ---------------------------------------------------------------- ชื่อไฟล์

  /**
   * ชื่อไฟล์ที่ดาวน์โหลด: prefix + ชื่อเดิม (ตัด .pdf) + suffix
   * ตัดโฟลเดอร์ อักขระควบคุม/อักขระล่องหน และอักขระที่ใช้ในชื่อไฟล์ไม่ได้ จำกัดความยาว
   */
  function outputName(name, prefix, suffix) {
    var base = str(name).split(/[\\/]/).pop();
    base = base.replace(/\.pdf$/i, '');
    base = base.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF<>:"|?*\\/]+/g, '_');
    base = base.replace(/^[\s.]+/, '');
    if (base.length > MAX_NAME) base = base.slice(0, MAX_NAME);
    var end = base.length;
    while (end > 0 && /[\s.]/.test(base.charAt(end - 1))) end--;
    base = base.slice(0, end) || 'document';
    return str(prefix) + base + str(suffix);
  }

  // ---------------------------------------------------------------- องค์ประกอบต่อหน้า

  function pageKeys(edits) {
    var keys = [];
    for (var k in edits) {
      if (own(edits, k) && /^[1-9][0-9]{0,5}$/.test(k) && Array.isArray(edits[k])) keys.push(Number(k));
    }
    return keys.sort(function (a, b) { return a - b; });
  }

  /** ลบหน้า deleted (เริ่มที่ 1): องค์ประกอบของหน้านั้นหายไป หน้าหลังจากนั้นเลื่อนขึ้นหนึ่งหน้า */
  function remapAfterDelete(edits, deleted) {
    var out = {};
    pageKeys(edits).forEach(function (p) {
      if (p < deleted) out[p] = edits[p];
      else if (p > deleted) out[p - 1] = edits[p];
    });
    return out;
  }

  /** เรียงหน้าใหม่/รวมไฟล์: order = [{ source: 'main'|'new', page }] → องค์ประกอบตามหน้าใหม่ (หน้าจากไฟล์ใหม่ไม่มี) */
  function remapForOrder(edits, order) {
    var out = {};
    order.forEach(function (item, i) {
      var p = item && typeof item.page === 'number' ? item.page : NaN;
      if (item && item.source === 'main' && p >= 1 && Math.floor(p) === p && own(edits, String(p)) && Array.isArray(edits[p])) {
        out[i + 1] = edits[p].slice();
      }
    });
    return out;
  }

  function countEdits(edits) {
    return pageKeys(edits).reduce(function (n, p) { return n + edits[p].length; }, 0);
  }

  // ---------------------------------------------------------------- เรขาคณิต

  function normAngle(a) {
    var n = Math.round(Number(a) / 90) * 90;
    return isFinite(n) ? ((n % 360) + 360) % 360 : 0;
  }

  /** มุมบนหน้าจอ (องศา ตามเข็มนาฬิกา) ขององค์ประกอบที่เพิ่มตอนหน้าหมุน elemRot เมื่อหน้าหมุนเป็น pageRot */
  function screenAngle(pageRot, elemRot) {
    return normAngle(normAngle(pageRot) - normAngle(elemRot));
  }

  // cos/sin ของมุมที่เป็นพหุคูณของ 90 แบบไม่มีเศษทศนิยม
  function cosSin(deg) {
    switch (normAngle(deg)) {
      case 90: return [0, 1];
      case 180: return [-1, 0];
      case 270: return [0, -1];
      default: return [1, 0];
    }
  }

  /**
   * จุดเริ่มวาดใน PDF: เลื่อนจากมุมซ้ายบนลง "ด้านล่างขององค์ประกอบ" (หมุนตาม rot) เป็นระยะ dist
   * ใช้กับเส้นฐานบรรทัดแรกของข้อความ (dist = baselineOffset) และมุมซ้ายล่างของรูป (dist = ความสูง)
   */
  function offsetDown(px, py, rot, dist) {
    var cs = cosSin(rot);
    return [px + dist * cs[1], py - dist * cs[0]];
  }

  /**
   * ระยะจากขอบบนของกล่องข้อความถึงเส้นฐานบรรทัดแรก เมื่อ CSS line-height = lineHeight (เท่าของขนาดตัวอักษร)
   * ascent/descent เป็นสัดส่วนของ em จากตาราง hhea ของฟอนต์ (เบราว์เซอร์วางเส้นฐานแบบนี้)
   */
  function baselineOffset(size, lineHeight, ascent, descent) {
    return size * (lineHeight / 2 + (ascent - descent) / 2);
  }

  /** ระยะที่ลากตามแกนนอนขององค์ประกอบที่หมุนอยู่ angle องศา (ใช้ย่อ/ขยายรูปที่หมุน) */
  function alongAxis(dx, dy, angle) {
    var cs = cosSin(angle);
    return dx * cs[0] + dy * cs[1];
  }

  /** scale สำหรับเรนเดอร์หน้าให้ไม่เกิน maxPixels (canvas ใหญ่เกินจะว่างเปล่าบนมือถือ) */
  function renderScale(width, height, wanted, maxPixels) {
    var s = wanted;
    if (width * height * s * s > maxPixels) s = Math.sqrt(maxPixels / (width * height));
    return Math.max(0.05, s);
  }

  // ---------------------------------------------------------------- AI (Gemini)

  /**
   * แบ่งคำตอบของ AI (markdown อย่างง่าย) เป็นบรรทัด → [{ kind: 'text'|'bullet'|'heading'|'blank', parts: [{ text, bold }] }]
   * หน้าเว็บสร้าง DOM จากผลนี้ด้วย textContent — ไม่มีการแปลงเป็น HTML เลย
   */
  function aiLines(text) {
    return str(text).replace(/\r\n?/g, '\n').split('\n').slice(0, 2000).map(function (raw) {
      var line = raw.trim();
      var kind = 'text';
      if (!line) return { kind: 'blank', parts: [] };
      var m = /^(#{1,6})\s+/.exec(line);
      if (m) { kind = 'heading'; line = line.slice(m[0].length); }
      else if (/^[*\-\u2022]\s+/.test(line)) { kind = 'bullet'; line = line.replace(/^[*\-\u2022]\s+/, ''); }
      var chunks = line.split('**');
      if (chunks.length % 2 === 0) { // ** ไม่ครบคู่: ตัวสุดท้ายเป็นข้อความธรรมดา
        var last = chunks.pop();
        chunks[chunks.length - 1] += '**' + last;
      }
      var parts = [];
      chunks.forEach(function (c, i) { if (c) parts.push({ text: c, bold: i % 2 === 1 }); });
      return { kind: kind, parts: parts };
    });
  }

  /** ข้อความคำตอบจากผลของ Gemini generateContent (รวมทุก part) → { text, blocked } */
  function geminiText(json) {
    var out = { text: '', blocked: null };
    if (!json || typeof json !== 'object') return out;
    if (json.promptFeedback && json.promptFeedback.blockReason) out.blocked = str(json.promptFeedback.blockReason);
    var cand = Array.isArray(json.candidates) ? json.candidates[0] : null;
    var parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
    out.text = parts.map(function (p) { return p && typeof p.text === 'string' ? p.text : ''; }).join('');
    if (!out.text && cand && cand.finishReason && cand.finishReason !== 'STOP') out.blocked = out.blocked || str(cand.finishReason);
    return out;
  }

  /** API key ของ Gemini: ตัวอักษร ตัวเลข _ - . เท่านั้น (ส่งเป็น HTTP header ห้ามมีขึ้นบรรทัด/อักขระแปลก) */
  function validApiKey(key) {
    var k = str(key).trim();
    return /^[A-Za-z0-9_.\-]{10,200}$/.test(k) ? k : '';
  }

  var api = {
    hasPdfHeader: hasPdfHeader,
    imageKind: imageKind,
    jpegOrientation: jpegOrientation,
    shapeThai: shapeThai,
    cleanText: cleanText,
    hexColor: hexColor,
    hexToRgb01: hexToRgb01,
    clamp: clamp,
    outputName: outputName,
    pageKeys: pageKeys,
    remapAfterDelete: remapAfterDelete,
    remapForOrder: remapForOrder,
    countEdits: countEdits,
    normAngle: normAngle,
    screenAngle: screenAngle,
    offsetDown: offsetDown,
    baselineOffset: baselineOffset,
    alongAxis: alongAxis,
    renderScale: renderScale,
    aiLines: aiLines,
    geminiText: geminiText,
    validApiKey: validApiKey
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PdfCore = api;
})(typeof self !== 'undefined' ? self : this);
