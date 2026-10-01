/*
 * Zip — สร้างไฟล์ ZIP ในเครื่อง (ไม่มีไลบรารีภายนอก) ใช้รวมรูป JPG หลายหน้าเป็นไฟล์เดียว และเป็นโครงของไฟล์ Word (.docx)
 *
 *   Zip.create(entries, opts) → Promise<Blob>
 *     entries: [{ name, data }]   data = string (UTF-8) | Uint8Array | ArrayBuffer | Blob
 *     opts.type: MIME ของไฟล์ที่ได้ (ค่าเริ่มต้น application/zip)
 *     opts.compress: บีบอัดไฟล์ข้อความ/XML (deflate) เมื่อเบราว์เซอร์มี CompressionStream — รูป JPG เก็บตรง ๆ
 *   Zip.crc32(bytes) → number
 *
 * ชื่อไฟล์ UTF-8 (บิต 11), เวลาไฟล์คงที่ (ผลเหมือนเดิมทุกครั้งเมื่อข้อมูลเหมือนเดิม), ไม่รองรับ ZIP64 (รวมไม่เกิน 4 GB)
 */
(function () {
  'use strict';

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  var enc = new TextEncoder();
  var MAX_TOTAL = 0xFFFFFFFE; // ไม่ใช้ ZIP64

  function toBytes(data) {
    if (typeof data === 'string') return Promise.resolve(enc.encode(data));
    if (data instanceof Uint8Array) return Promise.resolve(data);
    if (data instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(data));
    if (data && typeof data.arrayBuffer === 'function') return data.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    return Promise.reject(new Error('ข้อมูลไฟล์ใน ZIP ไม่ถูกต้อง'));
  }

  function canDeflate() { return typeof CompressionStream === 'function'; }

  function deflateRaw(bytes) {
    var cs = new CompressionStream('deflate-raw');
    return new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  function validName(name) {
    // ชื่อในไฟล์ ZIP: ห้ามพาธย้อนกลับ/พาธเต็ม/อักขระควบคุม
    return typeof name === 'string' && name.length > 0 && name.length <= 255 &&
      !/^[\\/]|(^|[\\/])\.\.([\\/]|$)|[\u0000-\u001f\\:*?"<>|]/.test(name);
  }

  // วันที่ DOS คงที่ 2026-01-01 00:00 (ไม่ใส่เวลาเครื่อง — ผลเหมือนเดิมทุกครั้ง)
  var DOS_TIME = 0, DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

  function header(sig, size) { var b = new DataView(new ArrayBuffer(size)); b.setUint32(0, sig, true); return b; }

  function create(entries, opts) {
    opts = opts || {};
    if (!Array.isArray(entries) || !entries.length) return Promise.reject(new Error('ไม่มีไฟล์ให้รวม'));
    var names = Object.create(null); // ชื่อ "__proto__" ต้องไม่ถูกนับว่าซ้ำ
    for (var i = 0; i < entries.length; i++) {
      if (!validName(entries[i].name)) return Promise.reject(new Error('ชื่อไฟล์ใน ZIP ไม่ถูกต้อง: ' + entries[i].name));
      if (names[entries[i].name]) return Promise.reject(new Error('ชื่อไฟล์ซ้ำใน ZIP: ' + entries[i].name));
      names[entries[i].name] = true;
    }
    return entries.reduce(function (p, e) {
      return p.then(function (list) {
        return toBytes(e.data).then(function (raw) {
          var crc = crc32(raw);
          var compress = opts.compress && canDeflate() && !/\.(jpe?g|png|zip|pdf)$/i.test(e.name) && raw.length > 256;
          return (compress ? deflateRaw(raw) : Promise.resolve(raw)).then(function (stored) {
            if (compress && stored.length >= raw.length) { stored = raw; compress = false; }
            list.push({ name: enc.encode(e.name), crc: crc, size: raw.length, stored: stored, method: compress ? 8 : 0 });
            return list;
          });
        });
      });
    }, Promise.resolve([])).then(function (list) {
      var parts = [], central = [], offset = 0;
      list.forEach(function (f) {
        var h = header(0x04034b50, 30);
        h.setUint16(4, 20, true);               // version needed
        h.setUint16(6, 0x0800, true);           // UTF-8 names
        h.setUint16(8, f.method, true);
        h.setUint16(10, DOS_TIME, true);
        h.setUint16(12, DOS_DATE, true);
        h.setUint32(14, f.crc, true);
        h.setUint32(18, f.stored.length, true);
        h.setUint32(22, f.size, true);
        h.setUint16(26, f.name.length, true);
        h.setUint16(28, 0, true);
        parts.push(h.buffer, f.name, f.stored);
        var c = header(0x02014b50, 46);
        c.setUint16(4, 20, true);               // version made by
        c.setUint16(6, 20, true);
        c.setUint16(8, 0x0800, true);
        c.setUint16(10, f.method, true);
        c.setUint16(12, DOS_TIME, true);
        c.setUint16(14, DOS_DATE, true);
        c.setUint32(16, f.crc, true);
        c.setUint32(20, f.stored.length, true);
        c.setUint32(24, f.size, true);
        c.setUint16(28, f.name.length, true);
        c.setUint32(42, offset, true);          // local header offset
        central.push(c.buffer, f.name);
        offset += 30 + f.name.length + f.stored.length;
      });
      var cdSize = central.reduce(function (n, b) { return n + b.byteLength; }, 0);
      if (offset + cdSize > MAX_TOTAL || list.length > 0xFFFF) throw new Error('ไฟล์ ZIP ใหญ่เกินไป');
      var end = header(0x06054b50, 22);
      end.setUint16(8, list.length, true);
      end.setUint16(10, list.length, true);
      end.setUint32(12, cdSize, true);
      end.setUint32(16, offset, true);
      return new Blob(parts.concat(central, [end.buffer]), { type: opts.type || 'application/zip' });
    });
  }

  window.Zip = { create: create, crc32: crc32 };
})();
