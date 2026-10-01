/*
 * pdf-worker.js — Web Worker (module) ที่รันตัวอ่าน PDF ของ PDF.js (vendor/pdfjs/pdf.worker.min.mjs) — สร้างโดย js/pdf-tools.js
 *
 *   new Worker(<ที่อยู่ไฟล์นี้>, { type: 'module', name: <ที่อยู่ pdf.worker.min.mjs จาก AppPlatform.resolve> })
 *
 * ทำไมไม่ให้ PDF.js สร้าง worker เอง: PDF.js (แม้รุ่น legacy) ใช้ฟังก์ชันใหม่ที่เบราว์เซอร์/WebView รุ่นเก่ายังไม่มี
 * (เช่น Promise.withResolvers ก่อน Chrome 119, for await กับ ReadableStream ก่อน Chrome 124) — ไฟล์นี้เติมให้ก่อน แล้วจึงโหลด PDF.js
 * ที่อยู่ของ PDF.js ส่งมาทาง name ของ worker (ใช้ได้ทั้ง URL ปกติและ blob: URL ของเวอร์ชัน Apps Script)
 * ข้อความที่มาถึงก่อน PDF.js โหลดเสร็จถูกเก็บไว้แล้วส่งต่อตามลำดับ (PDF.js ฝั่งหน้าเว็บส่งข้อความทันทีที่สร้าง worker)
 */
(function () {
  'use strict';

  // ---- ฟังก์ชันที่ PDF.js ใช้แต่เบราว์เซอร์/WebView รุ่นเก่ายังไม่มี (PDF.js รุ่น legacy ไม่ได้เติมให้) ----
  // เหมือนกันทุกตัวอักษรใน js/pdf-tools.js (หน้าเว็บ) และ js/pdf-worker.js (worker) — แก้ต้องแก้ทั้งสองที่
  //   Promise.withResolvers (Chrome 119, Safari 17.4), for await กับ ReadableStream (Chrome 124),
  //   Response/Blob.bytes() (Chrome 132, Safari 18), ArrayBuffer.transferToFixedLength (Chrome 114)
  function addPolyfills(g) {
    function define(obj, name, fn) {
      if (obj && typeof obj[name] !== 'function') {
        Object.defineProperty(obj, name, { value: fn, writable: true, configurable: true, enumerable: false });
      }
    }
    define(g.Promise, 'withResolvers', function () {
      var resolve, reject;
      var promise = new this(function (a, b) { resolve = a; reject = b; });
      return { promise: promise, resolve: resolve, reject: reject };
    });
    var RS = g.ReadableStream && g.ReadableStream.prototype;
    if (RS && typeof RS[Symbol.asyncIterator] !== 'function') {
      define(RS, 'values', function (opts) {
        var reader = this.getReader();
        var preventCancel = !!(opts && opts.preventCancel);
        var it = {
          next: function () {
            return reader.read().then(function (r) {
              if (r.done) reader.releaseLock();
              return r;
            }, function (e) { reader.releaseLock(); throw e; });
          },
          'return': function (value) {
            var end = function () { return { done: true, value: value }; };
            if (preventCancel) { reader.releaseLock(); return Promise.resolve(end()); }
            var p = reader.cancel(value);
            reader.releaseLock();
            return p.then(end, end);
          }
        };
        it[Symbol.asyncIterator] = function () { return this; };
        return it;
      });
      define(RS, Symbol.asyncIterator, RS.values);
    }
    ['Response', 'Blob'].forEach(function (name) {
      define(g[name] && g[name].prototype, 'bytes', function () {
        return this.arrayBuffer().then(function (b) { return new Uint8Array(b); });
      });
    });
    define(g.ArrayBuffer.prototype, 'transferToFixedLength', function (length) {
      var n = length === undefined ? this.byteLength : Math.max(0, Math.floor(length));
      var out = new ArrayBuffer(n);
      new Uint8Array(out).set(new Uint8Array(this, 0, Math.min(n, this.byteLength)));
      return out;
    });
  }
  addPolyfills(self);

  var early = [];
  function hold(e) { early.push(e); }
  self.addEventListener('message', hold);

  /** รับเฉพาะ PDF.js ของแอปเอง: ต้นทางเดียวกัน (หรือ blob: ของต้นทางเดียวกัน) และเป็นไฟล์ pdf.worker.min.mjs */
  function allowed(src) {
    try {
      var u = new URL(src);
      if (u.protocol === 'blob:') return u.origin === self.location.origin;
      return u.origin === self.location.origin && /\/vendor\/pdfjs\/pdf\.worker\.min\.mjs$/.test(u.pathname);
    } catch (e) {
      return false;
    }
  }

  function fail(e) {
    self.removeEventListener('message', hold);
    early = null;
    setTimeout(function () { throw e; }); // ส่งเหตุการณ์ error ให้หน้าเว็บ (pdf-tools.js แจ้งผู้ใช้)
  }

  var src = String(self.name || '');
  if (!allowed(src)) {
    fail(new Error('PDF.js worker: ที่อยู่ไฟล์ไม่ถูกต้อง'));
    return;
  }
  import(src).then(function () {
    // PDF.js ติดตั้งตัวรับข้อความของตัวเองแล้ว — ส่งข้อความที่เก็บไว้ต่อตามลำดับ
    self.removeEventListener('message', hold);
    var list = early;
    early = null;
    list.forEach(function (e) { self.dispatchEvent(new MessageEvent('message', { data: e.data })); });
  }, fail);
})();
