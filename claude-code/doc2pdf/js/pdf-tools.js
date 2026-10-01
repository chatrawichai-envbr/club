/*
 * PdfTools — แปลงไฟล์ PDF เป็นรูป JPEG หรือเอกสาร Word (.docx) ในเครื่องทั้งหมด ด้วย PDF.js (vendor/pdfjs)
 *
 *   PdfTools.isSupported() → boolean     ต้องเปิดผ่านเว็บไซต์ — เบราว์เซอร์ไม่โหลด ES module (PDF.js) จาก file://
 *   PdfTools.preload()                   เริ่มโหลด PDF.js ล่วงหน้า
 *   PdfTools.open(file, { onPassword }) → Promise<Doc>    Doc: { numPages, name, destroy() }
 *     onPassword(retry) → Promise<string|null>   ไฟล์มีรหัสผ่าน (retry = ใส่รหัสผิด) — null = ยกเลิก
 *   PdfTools.toJpeg(doc, { preset, pages, onProgress, isCancelled }) → Promise<{ blob, name, count, zip }>
 *     preset: small (96 dpi) | standard (150 dpi) | high (300 dpi) — หน้าเดียวได้ .jpg, หลายหน้าได้ .zip
 *   PdfTools.toDocx(doc, { pages, mode, lang, font, onProgress, isCancelled }) → Promise<{ blob, name, ... }>
 *     mode: auto (ข้อความในไฟล์ + OCR หน้าที่เป็นภาพ) | text (ข้อความในไฟล์เท่านั้น) | ocr (OCR ทุกหน้า)
 *   PdfTools.parsePages(text, numPages) → number[] (เลขหน้าเริ่มที่ 1) — โยน Error ถ้ารูปแบบผิด
 *
 * ภาษาไทยใน Word: ใช้ข้อความ Unicode ที่ฝังอยู่ในไฟล์ PDF ตรงตามต้นฉบับ (ไม่อ่านจากภาพ) แล้วทำให้ถูกมาตรฐานด้วย
 * js/thai-text.js (สระอำ, ลำดับสระ/วรรณยุกต์, อักขระ PUA และรหัส TIS-620 ของฟอนต์รุ่นเก่า) — หน้าที่เป็นภาพสแกน
 * ไม่มีข้อความให้ดึง จึงอ่านด้วย OCR (js/ocr.js) และแจ้งให้ผู้ใช้ตรวจทาน เพราะ OCR อาจอ่านผิดได้
 *
 * ความปลอดภัย: ไม่รันสคริปต์/ฟอร์ม XFA ในไฟล์ PDF, จำกัดขนาดไฟล์/ภาพ/จำนวนหน้า/ขนาด canvas
 * ทุกไฟล์ที่ PDF.js ต้องใช้ (worker, ฟอนต์มาตรฐาน, wasm) หาผ่าน AppPlatform.resolve
 */
(function () {
  'use strict';

  var BASE = 'vendor/pdfjs/';
  var MAX_FILE_BYTES = 200 * 1024 * 1024;
  var MAX_JPEG_PAGES = 200;          // รูป JPEG ทุกหน้าอยู่ในหน่วยความจำจนรวมเป็น ZIP
  var MAX_DOCX_PAGES = 1000;
  var MAX_IMAGE_PIXELS = 80e6;       // ภาพในไฟล์ PDF ที่ใหญ่กว่านี้ไม่ถอดรหัส (กันไฟล์ที่ทำให้หน่วยความจำเต็ม)
  var MAX_CANVAS_PIXELS = 16e6;      // เพดาน canvas ของ Safari บน iPhone/iPad (16.7 ล้านพิกเซล)
  var MAX_CANVAS_SIDE = 8192;
  var OCR_DPI = 300;                 // ความละเอียดที่ Tesseract อ่านได้แม่นที่สุด
  var OCR_LANGS = ['tha+eng', 'tha', 'eng'];

  var PRESETS = {
    small: { dpi: 96, quality: 0.6 },
    standard: { dpi: 150, quality: 0.8 },
    high: { dpi: 300, quality: 0.92 }
  };

  // ฟอนต์ของไฟล์ Word: ขนาดปกติต่างกันเพราะ TH Sarabun New ตัวเล็กกว่าฟอนต์อื่นที่ขนาด pt เท่ากัน
  var FONTS = {
    sarabun: { name: 'TH Sarabun New', size: 16 },
    tahoma: { name: 'Tahoma', size: 11 },
    leelawadee: { name: 'Leelawadee UI', size: 11 }
  };

  var libPromise = null;
  var loadAttempt = 0;
  var workerMode = null;             // 'worker' | 'page' — วิธีที่ใช้รันตัวอ่าน PDF ครั้งล่าสุด (สำหรับทดสอบ)

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
  addPolyfills(globalThis);

  function platform() {
    if (!window.AppPlatform) throw new Error('ไม่พบ AppPlatform (js/boot.js)');
    return window.AppPlatform;
  }

  function isSupported() {
    return location.protocol !== 'file:' && typeof Worker === 'function' && typeof WebAssembly === 'object' &&
      typeof Promise === 'function' && typeof TextDecoder === 'function';
  }

  function cancelledError() {
    var e = new Error('ยกเลิกแล้ว');
    e.cancelled = true;
    return e;
  }

  function loadLib() {
    if (!libPromise) {
      var attempt = loadAttempt++;
      libPromise = Promise.resolve().then(function () {
        var P = platform();
        return Promise.all([P.resolve(BASE + 'pdf.min.mjs', true), P.resolve(BASE + 'pdf.worker.min.mjs', true)]);
      }).then(function (urls) {
        // เบราว์เซอร์จำ module ที่โหลดไม่สำเร็จตาม URL — ลองใหม่ด้วย URL ใหม่ (เฉพาะ http/https ไม่ใช่ blob:)
        var url = attempt && /^https?:/i.test(urls[0]) ? urls[0] + (urls[0].indexOf('?') >= 0 ? '&' : '?') + 'retry=' + attempt : urls[0];
        return import(url).then(function (lib) {
          if (!lib || typeof lib.getDocument !== 'function') throw new Error('bad module');
          lib.GlobalWorkerOptions.workerSrc = urls[1];
          return { lib: lib, workerSrc: urls[1] };
        });
      }).catch(function (e) {
        console.warn('PDF.js', e);
        throw new Error('โหลดตัวอ่านไฟล์ PDF ไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่');
      });
      libPromise.catch(function () { libPromise = null; }); // ลองใหม่ได้ครั้งหน้า
    }
    return libPromise;
  }

  function preload() {
    if (isSupported()) loadLib().catch(function () { /* แจ้งตอนเปิดไฟล์จริง */ });
  }

  /**
   * Worker ของ PDF.js ผ่าน js/pdf-worker.js (เติม Promise.withResolvers ก่อนโหลด PDF.js) — คืน { port, pdfWorker, failed }
   * failed: Promise ที่ reject เมื่อ worker โหลดไม่สำเร็จ (PDF.js จะรอคำตอบตลอดไปถ้าไม่ตรวจเอง)
   * ถ้าเบราว์เซอร์สร้าง module worker ไม่ได้เลย → รันตัวอ่านในหน้าเว็บแทน (ช้ากว่า แต่ใช้งานได้)
   */
  async function startWorker(loaded) {
    var lib = loaded.lib;
    var port = null;
    try {
      var shim = await platform().resolve('js/pdf-worker.js');
      port = new Worker(shim, { type: 'module', name: loaded.workerSrc });
    } catch (e) {
      port = null;
    }
    if (!port) {
      if (!globalThis.pdfjsWorker) await import(loaded.workerSrc); // ไฟล์ตั้ง globalThis.pdfjsWorker เอง → PDF.js ใช้ในหน้าเว็บ
      workerMode = 'page';
      return { port: null, pdfWorker: null, failed: new Promise(function () {}) };
    }
    var failed = new Promise(function (resolve, reject) {
      port.addEventListener('error', function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        var err = new Error('โหลดตัวอ่านไฟล์ PDF ไม่สำเร็จ' + (ev && ev.message ? ' (' + ev.message + ')' : ''));
        err.workerFailed = true;
        reject(err);
      });
    });
    failed.catch(function () { /* จัดการตอนรอเปิดไฟล์ */ });
    workerMode = 'worker';
    return { port: port, pdfWorker: new lib.PDFWorker({ port: port }), failed: failed };
  }

  /**
   * PDF.js ขอไฟล์ฟอนต์มาตรฐาน/wasm ผ่านคลาสนี้ (useWorkerFetch: false) — หาไฟล์ด้วย AppPlatform.resolve
   * เพื่อให้แพลตฟอร์มอื่น (Apps Script, แอป Android) ส่งไฟล์เองได้ ชื่อไฟล์มาจาก PDF.js เท่านั้น แต่ยังตรวจรูปแบบ
   */
  function BinaryData() { /* PDF.js ส่ง { standardFontDataUrl, wasmUrl } มา — ไม่ใช้ (หาไฟล์จาก BASE เอง) */ }
  BinaryData.prototype.fetch = function (req) {
    var dir = { standardFontDataUrl: 'standard_fonts/', wasmUrl: 'wasm/' }[req && req.kind];
    var name = String(req && req.filename || '');
    if (!dir || !/^[A-Za-z0-9_-]+\.(pfb|ttf|wasm)$/.test(name)) return Promise.reject(new Error('ไม่รู้จักไฟล์ ' + name));
    return platform().resolve(BASE + dir + name, true)
      .then(function (url) { return fetch(url); })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      })
      .then(function (buf) { return new Uint8Array(buf); });
  };

  function hasPdfHeader(bytes) {
    // PDF.js ยอมให้มีข้อมูลอื่นก่อน %PDF- ได้ (เช่น ไฟล์จากอีเมล) — ค้นใน 1 KB แรก
    var head = String.fromCharCode.apply(null, bytes.subarray(0, 1024));
    return head.indexOf('%PDF-') >= 0;
  }

  function baseName(name) {
    var n = String(name || '').replace(/\.pdf$/i, '');
    var safe = window.PdfExport ? PdfExport.sanitizeFilename(n).replace(/\.pdf$/i, '') : n.replace(/[^\w\u0e00-\u0e7f .-]+/g, '_');
    return safe || 'document';
  }

  /**
   * เปิดไฟล์ PDF
   * @returns {Promise<{numPages: number, name: string, pdf: Object, lib: Object, destroy: Function}>}
   */
  async function open(file, opts) {
    opts = opts || {};
    if (!isSupported()) throw new Error('แปลงไฟล์ PDF ได้เมื่อเปิดผ่านเว็บไซต์ (https) เท่านั้น — ไม่รองรับการเปิดไฟล์จากเครื่องโดยตรง');
    if (!file || typeof file.arrayBuffer !== 'function') throw new Error('ไม่พบไฟล์');
    if (!file.size) throw new Error('ไฟล์ว่างเปล่า');
    if (file.size > MAX_FILE_BYTES) throw new Error('ไฟล์ใหญ่เกิน ' + Math.round(MAX_FILE_BYTES / 1048576) + ' MB');
    var bytes = new Uint8Array(await file.arrayBuffer());
    if (!hasPdfHeader(bytes)) throw new Error('ไฟล์นี้ไม่ใช่ไฟล์ PDF');
    var loaded = await loadLib();
    var lib = loaded.lib;
    var w = await startWorker(loaded);
    var stopped = false;
    function stopWorker() {
      if (stopped) return;
      stopped = true;
      if (w.pdfWorker) { try { w.pdfWorker.destroy(); } catch (e) { /* ignore */ } }
      if (w.port) w.port.terminate();
    }
    /** ปิดเอกสาร (PDF.js ส่งคำสั่งปิดให้ worker) แล้วจึงปิด worker — ไม่เกิน 3 วินาที */
    function close() {
      var done = Promise.resolve().then(function () { return task.destroy(); }).catch(function () { /* ignore */ });
      Promise.race([done, new Promise(function (r) { setTimeout(r, 3000); })]).then(stopWorker);
    }
    var aborted = false;
    var task = lib.getDocument({
      worker: w.pdfWorker || undefined,
      data: bytes,
      BinaryDataFactory: BinaryData,
      useWorkerFetch: false,
      standardFontDataUrl: BASE + 'standard_fonts/',
      wasmUrl: BASE + 'wasm/',
      enableXfa: false,
      disableAutoFetch: true,
      maxImageSize: MAX_IMAGE_PIXELS,
      verbosity: 0
    });
    task.onPassword = function (update, reason) {
      var retry = reason === lib.PasswordResponses.INCORRECT_PASSWORD;
      Promise.resolve(typeof opts.onPassword === 'function' ? opts.onPassword(retry) : null).then(function (pw) {
        if (typeof pw === 'string' && pw) { update(pw); return; }
        aborted = true;
        task.destroy();
      }, function () { aborted = true; task.destroy(); });
    };
    var pdf;
    try {
      pdf = await Promise.race([task.promise, w.failed]);
    } catch (e) {
      close();
      if (e && e.workerFailed) throw e;
      if (aborted) {
        var err = new Error('ไฟล์นี้มีรหัสผ่าน — ต้องใส่รหัสผ่านเพื่อเปิด');
        err.cancelled = true;
        throw err;
      }
      if (!e || (e.name !== 'InvalidPDFException' && e.name !== 'PasswordException')) console.warn('PDF', e);
      if (e && e.name === 'PasswordException') throw new Error('ไฟล์นี้มีรหัสผ่าน — ต้องใส่รหัสผ่านเพื่อเปิด');
      throw new Error('เปิดไฟล์ PDF ไม่ได้ — ไฟล์อาจเสียหาย' + (e && e.name === 'InvalidPDFException' ? '' : ' (' + (e && e.message || e) + ')'));
    }
    return {
      numPages: pdf.numPages,
      name: String(file.name || 'document.pdf'),
      pdf: pdf,
      lib: lib,
      // ข้อความแทน (/ActualText) ที่ PDF.js ไม่ส่งออกมา — อ่านไฟล์เองเมื่อหน้ามี marked content (js/pdf-actualtext.js)
      actual: window.PdfActualText ? PdfActualText.create(function () { return pdf.getData(); }) : null,
      destroy: close
    };
  }

  /** "1-3, 5, 8-" → [1,2,3,5,8,...] ช่องว่าง = ทุกหน้า */
  function parsePages(text, numPages) {
    var s = String(text == null ? '' : text).replace(/\s+/g, '').replace(/[–—]/g, '-');
    if (!s || /^(all|ทั้งหมด|ทุกหน้า)$/i.test(s)) {
      var all = [];
      for (var i = 1; i <= numPages; i++) all.push(i);
      return all;
    }
    if (s.length > 200 || !/^[0-9,\-]+$/.test(s)) throw new Error('รูปแบบเลขหน้าไม่ถูกต้อง (ตัวอย่าง: 1-3, 5)');
    var seen = {}, out = [];
    s.split(',').forEach(function (part) {
      if (!part) return;
      var m = /^(\d{1,6})?(-)?(\d{1,6})?$/.exec(part);
      if (!m || (!m[1] && !m[3]) || (!m[2] && !m[1])) throw new Error('รูปแบบเลขหน้าไม่ถูกต้อง: "' + part + '"');
      var a = m[1] ? Number(m[1]) : 1;
      var b = m[2] ? (m[3] ? Number(m[3]) : numPages) : a;
      if (a < 1 || b < 1 || a > numPages || b > numPages) throw new Error('ไฟล์นี้มี ' + numPages + ' หน้า — ไม่มีหน้า "' + part + '"');
      if (a > b) throw new Error('ช่วงหน้าไม่ถูกต้อง: "' + part + '"');
      for (var p = a; p <= b; p++) if (!seen[p]) { seen[p] = true; out.push(p); }
    });
    if (!out.length) throw new Error('ยังไม่ได้เลือกหน้า');
    return out;
  }

  function nextFrame() { return new Promise(function (r) { setTimeout(r, 0); }); }

  function releaseCanvas(c) { if (c) { c.width = 0; c.height = 0; } }

  /** วาดหน้า PDF ลง canvas พื้นขาว ที่ความละเอียด dpi (ลดลงอัตโนมัติถ้าเกินเพดาน canvas) */
  async function renderCanvas(doc, n, dpi) {
    var page = await doc.pdf.getPage(n);
    var canvas = null;
    try {
      var vp1 = page.getViewport({ scale: 1 });
      var scale = Math.min(dpi / 72, Math.sqrt(MAX_CANVAS_PIXELS / (vp1.width * vp1.height)),
        MAX_CANVAS_SIDE / vp1.width, MAX_CANVAS_SIDE / vp1.height);
      if (!(scale > 0) || !isFinite(scale)) throw new Error('ขนาดหน้า ' + n + ' ไม่ถูกต้อง');
      var vp = page.getViewport({ scale: scale });
      canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(vp.width));
      canvas.height = Math.max(1, Math.floor(vp.height));
      var ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({
        canvasContext: ctx,
        viewport: vp,
        intent: 'print',                                  // เหมือนสั่งพิมพ์: ไม่วาดส่วนที่ตั้งไว้ว่าไม่พิมพ์
        annotationMode: doc.lib.AnnotationMode.ENABLE,    // ค่าในช่องฟอร์ม/ตราประทับที่เป็นภาพ ติดไปด้วย
        background: '#ffffff'
      }).promise;
      return { canvas: canvas, dpi: Math.round(scale * 72) };
    } catch (e) {
      releaseCanvas(canvas);
      throw e;
    } finally {
      page.cleanup();
    }
  }

  function canvasToJpeg(canvas, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) { if (b) resolve(b); else reject(new Error('แปลงภาพเป็น JPEG ไม่สำเร็จ')); }, 'image/jpeg', quality);
    });
  }

  function pad(n, width) { var s = String(n); while (s.length < width) s = '0' + s; return s; }

  /** ค่าจากตาราง (PRESETS/FONTS) เฉพาะชื่อที่มีจริง — ชื่ออย่าง "constructor" ได้ค่าเริ่มต้น */
  function pick(table, key, fallback) {
    return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : table[fallback];
  }

  async function toJpeg(doc, opts) {
    opts = opts || {};
    var preset = pick(PRESETS, opts.preset, 'standard');
    var pages = Array.isArray(opts.pages) ? opts.pages : parsePages('', doc.numPages);
    if (!pages.length) throw new Error('ยังไม่ได้เลือกหน้า');
    if (pages.length > MAX_JPEG_PAGES) {
      throw new Error('แปลงเป็นรูปได้ครั้งละไม่เกิน ' + MAX_JPEG_PAGES + ' หน้า — เลือกช่วงหน้า เช่น 1-' + MAX_JPEG_PAGES);
    }
    var isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : function () { return false; };
    var progress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
    var base = baseName(doc.name);
    var width = String(doc.numPages).length;
    var files = [], dpi = 0;
    for (var i = 0; i < pages.length; i++) {
      if (isCancelled()) throw cancelledError();
      progress(i, pages.length, pages[i]);
      var r = await renderCanvas(doc, pages[i], preset.dpi);
      try {
        dpi = dpi ? Math.min(dpi, r.dpi) : r.dpi;
        var blob = await canvasToJpeg(r.canvas, preset.quality);
        files.push({ name: base + (doc.numPages > 1 ? '-' + pad(pages[i], width) : '') + '.jpg', data: blob });
      } finally {
        releaseCanvas(r.canvas);
      }
      await nextFrame();
    }
    if (isCancelled()) throw cancelledError();
    progress(pages.length, pages.length, 0);
    if (files.length === 1) {
      return { blob: files[0].data, name: files[0].name, count: 1, zip: false, dpi: dpi };
    }
    var zip = await window.Zip.create(files, { type: 'application/zip' });
    return { blob: zip, name: base + '-jpg.zip', count: files.length, zip: true, dpi: dpi };
  }

  // ---------------------------------------------------------------------
  //  ข้อความ → ย่อหน้า
  // ---------------------------------------------------------------------

  var BAD_CHARS = /[�\ue000-\uf8ff\u0000-\u0008\u000E-\u001F]/g;
  var LETTER = /[\p{L}\p{N}]/gu;

  /** ค่าที่ตำแหน่ง q (0..1) ของข้อมูลที่เรียงแล้ว (q = 0.5 คือค่ากลาง) */
  function quantile(arr, q) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    return s[Math.min(s.length - 1, Math.floor(s.length * q))];
  }
  function median(arr) { return quantile(arr, 0.5); }

  /**
   * ตัดอักขระใน chars ออกจากท้ายข้อความ โดยไล่จากท้ายสตริง — ข้อความมาจากไฟล์ PDF (ไม่น่าเชื่อถือ)
   * ห้ามใช้ regex แบบ /[ \t]+$/ ซึ่งใช้เวลาแบบกำลังสองกับช่องว่างยาว ๆ กลางข้อความ (หน้าเว็บค้างได้)
   */
  function trimEndOf(s, chars) {
    var end = s.length;
    while (end > 0 && chars.indexOf(s.charAt(end - 1)) >= 0) end--;
    return end === s.length ? s : s.slice(0, end);
  }

  /**
   * รายการข้อความของ PDF.js → บรรทัด (ตามลำดับในไฟล์)
   * PDF.js ใส่ช่องว่างระหว่างคำและแจ้งการขึ้นบรรทัด (hasEOL) ให้แล้ว — ที่นี่ต่อข้อความในบรรทัดเดียวกันตามลำดับเดิม
   * (สระ/วรรณยุกต์ที่ถูกวาดแยกชิ้นจึงต่อกับพยัญชนะถูกตัว ไม่มีช่องว่างแทรก), เปลี่ยนช่องว่างยาว (คอลัมน์/ตาราง) เป็นแท็บ,
   * และขึ้นบรรทัดใหม่เมื่อเส้นฐานของข้อความเปลี่ยน
   */
  function buildLines(items, vt, Util) {
    var lines = [], cur = null;
    function close() {
      if (cur) {
        cur.text = trimEndOf(cur.text, ' \t');
        if (cur.text) lines.push(cur);
      }
      cur = null;
    }
    items.forEach(function (it) {
      if (!it || typeof it.str !== 'string') return; // marked content
      var str = it.str;
      if (str && !str.trim()) {
        // ช่องว่างที่ PDF.js เติมให้ (ระหว่างคำ/ก่อนคอลัมน์ถัดไป) — อยู่ในบรรทัดปัจจุบันเสมอ
        if (cur && cur.text && !/[ \t]$/.test(cur.text)) cur.text += ' ';
      } else if (str) {
        var tx = Util.transform(vt, it.transform);
        var len = Math.hypot(tx[0], tx[1]);
        var size = Math.hypot(tx[2], tx[3]) || len || Math.abs(it.height) || 1;
        var ux = len ? tx[0] / len : 1, uy = len ? tx[1] / len : 0;
        var along = tx[4] * ux + tx[5] * uy;
        var across = tx[5] * ux - tx[4] * uy;
        var w = Math.abs(Number(it.width) || 0);
        var same = cur && Math.abs(ux - cur.ux) + Math.abs(uy - cur.uy) < 0.2 &&
          Math.abs(across - cur.across) < 0.5 * Math.max(size, cur.size);
        if (!same) {
          close();
          cur = { text: '', ux: ux, uy: uy, across: across, size: size, end: along };
        }
        var gap = along - cur.end;
        if (cur.text && gap > 1.5 * Math.max(size, cur.size)) cur.text = trimEndOf(cur.text, ' ') + '\t';
        cur.text += str;
        cur.size = Math.max(cur.size, size);
        cur.end = Math.max(cur.end, along + w);
      }
      if (it.hasEOL) close();
    });
    close();
    return lines;
  }

  /**
   * บรรทัด → ย่อหน้า: ขึ้นย่อหน้าใหม่เมื่อระยะห่างบรรทัดมากกว่าระยะบรรทัดปกติ ย้อนขึ้น (คอลัมน์ใหม่)
   * หรือขนาดตัวอักษรเปลี่ยนชัดเจน — ระยะบรรทัดปกติ = ระยะที่แคบในกลุ่มล่าง (ควอไทล์ที่ 1) ไม่ใช่ค่ากลาง
   * เพราะเอกสารที่ย่อหน้าละบรรทัดเดียวมีระยะระหว่างย่อหน้ามากกว่าระยะภายในย่อหน้า
   */
  function buildParagraphs(lines) {
    var gaps = [];
    for (var i = 1; i < lines.length; i++) {
      var g = lines[i].across - lines[i - 1].across;
      if (g > 0.8 * lines[i].size && g < 4 * lines[i].size) gaps.push(g / lines[i].size);
    }
    var normal = quantile(gaps, 0.25) || 1.2;
    var paras = [], cur = null;
    lines.forEach(function (l, k) {
      var prev = lines[k - 1];
      var gap = prev ? (l.across - prev.across) / l.size : 0;
      var ratio = prev ? l.size / prev.size : 1;
      var sameDir = prev && Math.abs(l.ux - prev.ux) + Math.abs(l.uy - prev.uy) < 0.2;
      // gap > 1.9 เท่าของขนาดตัวอักษร: ห่างกว่าระยะบรรทัดปกติของฟอนต์ทั่วไป (รวมฟอนต์ไทยที่บรรทัดสูง ~1.6) — ย่อหน้าใหม่เสมอ
      // แม้ทุกบรรทัดในหน้าจะห่างเท่ากัน (เอกสารที่ย่อหน้าละบรรทัดเดียว เช่น Sarabun 16 pt + ระยะย่อหน้า 14 pt ≈ 2.2)
      var split = !cur || !sameDir || gap <= 0.3 || gap > Math.min(normal * 1.3, 1.9) || ratio > 1.25 || ratio < 0.8;
      if (split) {
        cur = { lines: [], sizes: [] };
        paras.push(cur);
      }
      cur.lines.push(l.text);
      cur.sizes.push(l.size);
    });
    return paras.map(function (p) { return { lines: p.lines, size: median(p.sizes) }; });
  }

  function normalizeLine(s) { return window.ThaiText.normalize(window.ThaiText.fixLegacy(s)); }
  function stripControls(s) { return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ''); }

  function isBegin(it) { return it && (it.type === 'beginMarkedContent' || it.type === 'beginMarkedContentProps'); }

  /**
   * แทนข้อความของ marked content ที่มี /ActualText ด้วยข้อความนั้น (อันนอกสุดเมื่อซ้อนกัน)
   * entries ต้องตรงกับ marked content ของ PDF.js ทีละอันตามลำดับ (ตรวจแล้วก่อนเรียก)
   * ช่องว่างที่ PDF.js เติมไว้หน้า/หลังกลุ่มอักษรคงไว้ — เป็นช่องว่างระหว่างคำ ไม่ใช่ส่วนของกลุ่มอักษร
   */
  function applyActualText(items, entries) {
    var out = [], k = 0, depth = 0, active = null;
    function flush(a) {
      var its = a.items, first = -1, last = -1;
      its.forEach(function (it, i) { if (it.str && it.str.trim()) { if (first < 0) first = i; last = i; } });
      if (first < 0) { out.push.apply(out, its); return; } // ไม่มีรูปอักษร (เช่น ภาพ) — ไม่แทรกข้อความ
      var mid = its.slice(first, last + 1), head = mid[0];
      var text = a.text;
      if (first > 0) text = text.replace(/^\s+/, '');
      if (last < its.length - 1) text = text.trimEnd(); // เท่ากับ /\s+$/ แต่ไม่ช้าแบบกำลังสอง
      out.push.apply(out, its.slice(0, first));
      out.push({
        str: text,
        transform: head.transform,
        width: mid.reduce(function (w, it) { return w + (Number(it.width) || 0); }, 0),
        height: head.height,
        dir: head.dir,
        fontName: head.fontName,
        hasEOL: !!mid[mid.length - 1].hasEOL
      });
      out.push.apply(out, its.slice(last + 1));
    }
    items.forEach(function (it) {
      if (isBegin(it)) {
        var e = entries[k++];
        depth++;
        if (!active && e && typeof e.text === 'string') active = { text: e.text, depth: depth, items: [] };
      } else if (it && it.type === 'endMarkedContent') {
        if (active && active.depth === depth) { flush(active); active = null; }
        depth = Math.max(0, depth - 1);
      } else {
        (active ? active.items : out).push(it);
      }
    });
    if (active) flush(active);
    return out;
  }

  /** รายการข้อความของหน้า พร้อม ActualText — { items, spansUnread } */
  async function textItems(doc, page) {
    var tc = await page.getTextContent({ includeMarkedContent: true });
    var items = tc.items || [];
    var markers = items.filter(isBegin);
    if (!markers.length) return { items: items, spansUnread: false };
    var entries = doc.actual ? await doc.actual.forPage(page.ref) : null;
    var match = entries && entries.length === markers.length &&
      entries.every(function (e, i) { return e.tag === markers[i].tag; });
    if (match && entries.some(function (e) { return typeof e.text === 'string'; })) items = applyActualText(items, entries);
    // อ่าน ActualText ไม่ได้ ทั้งที่หน้ามี /Span (ที่มักใช้ใส่ ActualText) — ข้อความบางตัวอาจหายไป
    return { items: items, spansUnread: !match && markers.some(function (m) { return m.tag === 'Span'; }) };
  }

  /**
   * สัดส่วนพื้นที่หน้าที่ถูกภาพปิดทับ (0..1) — ไล่ตามคำสั่งวาดของหน้า (save/restore/transform/ฟอร์ม)
   * ภาพที่อยู่นอกหน้าเกือบทั้งหมด (เช่น ภาพจากหน้าก่อนที่ล้นมา) นับเฉพาะส่วนที่อยู่ในหน้า
   */
  async function imageCoverage(page, lib) {
    var OPS = lib.OPS, Util = lib.Util;
    var list = await page.getOperatorList({ intent: 'print' });
    var view = page.view, pageArea = (view[2] - view[0]) * (view[3] - view[1]);
    if (!(pageArea > 0)) return 0;
    var IMAGES = [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject];
    var ctm = [1, 0, 0, 1, 0, 0], stack = [], covered = 0;
    for (var i = 0; i < list.fnArray.length; i++) {
      var fn = list.fnArray[i], args = list.argsArray[i];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() || ctm;
      else if (fn === OPS.transform && args && args.length === 6) ctm = Util.transform(ctm, args);
      else if (fn === OPS.paintFormXObjectBegin) {
        stack.push(ctm);
        if (args && Array.isArray(args[0]) && args[0].length === 6) ctm = Util.transform(ctm, args[0]);
      } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
      else if (IMAGES.indexOf(fn) >= 0) {
        var p = [[0, 0], [1, 0], [0, 1], [1, 1]].map(function (q) {
          return [ctm[0] * q[0] + ctm[2] * q[1] + ctm[4], ctm[1] * q[0] + ctm[3] * q[1] + ctm[5]];
        });
        var x0 = Math.max(view[0], Math.min.apply(null, p.map(function (q) { return q[0]; })));
        var x1 = Math.min(view[2], Math.max.apply(null, p.map(function (q) { return q[0]; })));
        var y0 = Math.max(view[1], Math.min.apply(null, p.map(function (q) { return q[1]; })));
        var y1 = Math.min(view[3], Math.max.apply(null, p.map(function (q) { return q[1]; })));
        if (x1 > x0 && y1 > y0) covered += (x1 - x0) * (y1 - y0);
      }
    }
    return Math.min(1, covered / pageArea);
  }

  /** ข้อความของหน้าจากไฟล์ PDF: { paras, letters, bad, imageOnly } */
  async function pageText(doc, n) {
    var page = await doc.pdf.getPage(n);
    try {
      var vp = page.getViewport({ scale: 1 });
      var t = await textItems(doc, page);
      var lines = buildLines(t.items, vp.transform, doc.lib.Util);
      // นับอักขระเสีย (รูปอักษรที่ไม่มีรหัส Unicode = "\0", U+FFFD, PUA ที่ไม่ใช่ของฟอนต์ไทย) ก่อนตัดอักขระควบคุมทิ้ง
      var bad = 0;
      lines.forEach(function (l) {
        var norm = normalizeLine(l.text);
        bad += (norm.match(BAD_CHARS) || []).length;
        l.text = stripControls(norm);
      });
      lines = lines.filter(function (l) { return l.text.trim(); });
      var all = lines.map(function (l) { return l.text; }).join('\n');
      var letters = (all.match(LETTER) || []).length;
      // หน้าสแกนที่มีข้อความเล็กน้อย (เช่น ลายน้ำของแอปสแกน) — ข้อความส่วนใหญ่อยู่ในภาพ
      var imageOnly = letters < 40 && await imageCoverage(page, doc.lib) > 0.3;
      return { paras: buildParagraphs(lines), letters: letters, bad: bad, spansUnread: t.spansUnread, imageOnly: imageOnly };
    } finally {
      page.cleanup();
    }
  }

  function ocrParagraphs(text) {
    var norm = window.ThaiText.normalize(String(text || '').replace(/\r\n?/g, '\n'));
    return norm.split(/\n[ \t]*\n+/).map(function (block) {
      // OCR เว้นช่องว่างยาวแทนคอลัมน์ของตาราง → แท็บ
      return block.split('\n').map(function (l) { return trimEndOf(l, ' \t').replace(/ {3,}/g, '\t'); }).filter(Boolean);
    }).filter(function (lines) { return lines.length; }).map(function (lines) { return { lines: lines, size: 0 }; });
  }

  async function ocrPage(doc, n, lang, onProgress, isCancelled) {
    if (isCancelled()) throw cancelledError();
    var canvas = (await renderCanvas(doc, n, OCR_DPI)).canvas;
    var png, size;
    try {
      // ภาพสแกน: ลบเงา/พื้นหลังไม่เรียบ และเส้นตาราง (ทำให้ Tesseract ข้ามข้อความในตาราง) ด้วยตัวกรอง "ocr" เดียวกับ
      // การแปลงภาพถ่ายเป็นข้อความในแอป — ถ้าตัวประมวลผลภาพยังไม่พร้อม ใช้ภาพที่วาดได้ตรง ๆ
      if (window.CvEngine && CvEngine.isReady()) {
        try {
          var processed = await CvEngine.process(canvas, { filter: 'ocr' }, 'high');
          releaseCanvas(canvas);
          canvas = processed;
        } catch (e) { console.warn('OCR filter', e); }
      }
      size = { width: canvas.width, height: canvas.height };
      png = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
    } finally {
      releaseCanvas(canvas); // คืนหน่วยความจำก่อนเริ่มอ่าน (OCR ใช้เวลาหลายวินาที)
    }
    if (!png) throw new Error('เตรียมภาพหน้า ' + n + ' ไม่สำเร็จ');
    if (isCancelled()) throw cancelledError();
    var res = await window.Ocr.recognize(png, lang, onProgress, size);
    return { paras: ocrParagraphs(res.text), confidence: res.confidence };
  }

  /** ขนาดตัวอักษรของย่อหน้า → สัดส่วนเทียบขนาดปกติของเอกสาร (หัวเรื่องใหญ่กว่า เชิงอรรถเล็กกว่า) */
  function applyScale(pagesParas) {
    var weights = {};
    pagesParas.forEach(function (paras) {
      paras.forEach(function (p) {
        if (!p.size) return;
        var k = Math.round(p.size * 2) / 2;
        weights[k] = (weights[k] || 0) + p.lines.join('').length;
      });
    });
    var body = 0, best = -1;
    Object.keys(weights).forEach(function (k) { if (weights[k] > best) { best = weights[k]; body = Number(k); } });
    return pagesParas.map(function (paras) {
      return paras.map(function (p) {
        var scale = body && p.size ? p.size / body : 1;
        scale = Math.abs(scale - 1) < 0.12 ? 1 : Math.min(2.5, Math.max(0.7, Math.round(scale * 4) / 4));
        return { lines: p.lines, scale: scale };
      });
    });
  }

  async function toDocx(doc, opts) {
    opts = opts || {};
    var pages = Array.isArray(opts.pages) ? opts.pages : parsePages('', doc.numPages);
    if (!pages.length) throw new Error('ยังไม่ได้เลือกหน้า');
    if (pages.length > MAX_DOCX_PAGES) throw new Error('แปลงเป็น Word ได้ครั้งละไม่เกิน ' + MAX_DOCX_PAGES + ' หน้า');
    var mode = opts.mode === 'text' || opts.mode === 'ocr' ? opts.mode : 'auto';
    var lang = OCR_LANGS.indexOf(opts.lang) >= 0 ? opts.lang : 'tha+eng';
    var canOcr = !!(window.Ocr && Ocr.isSupported());
    if (mode === 'ocr' && !canOcr) throw new Error('อ่านข้อความจากภาพ (OCR) ได้เมื่อเปิดผ่านเว็บไซต์ (https) เท่านั้น');
    var font = pick(FONTS, opts.font, 'sarabun');
    var isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : function () { return false; };
    var progress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};

    var out = [], textPages = [], ocrPages = [], emptyPages = [], badPages = [], ocrFailed = [];
    for (var i = 0; i < pages.length; i++) {
      if (isCancelled()) throw cancelledError();
      var n = pages[i];
      progress(i, pages.length, n, 'text', 0);
      var t = mode === 'ocr' ? null : await pageText(doc, n);
      // ข้อความเสียมาก (ฟอนต์ไม่บอกรหัสตัวอักษร) → อ่านจากภาพแทน; เสียเล็กน้อย → ใช้ข้อความแต่แจ้งให้ตรวจทาน
      var broken = t && t.bad > Math.max(2, t.letters * 0.05);
      var suspect = t && (t.bad > 0 || t.spansUnread);
      var needOcr = mode === 'ocr' || (mode === 'auto' && canOcr && (t.imageOnly || !t.letters || broken));
      if (needOcr) {
        try {
          var o = await ocrPage(doc, n, lang, (function (idx, pageNo) {
            return function (status, p) { if (!isCancelled()) progress(idx, pages.length, pageNo, status, p); };
          })(i, n), isCancelled);
          if (o.paras.length) {
            out.push(o.paras);
            ocrPages.push(n);
            continue;
          }
        } catch (e) {
          if (e && e.cancelled || isCancelled()) throw cancelledError();
          console.warn('OCR', e);
          ocrFailed.push(n);
        }
      }
      if (t && t.letters) {
        out.push(t.paras);
        textPages.push(n);
        if (suspect) badPages.push(n);
      } else {
        out.push([]);
        emptyPages.push(n);
      }
      await nextFrame();
    }
    if (isCancelled()) throw cancelledError();
    progress(pages.length, pages.length, 0, 'build', 1);
    var blob = await window.Docx.create({
      title: doc.name.replace(/\.pdf$/i, ''),
      pages: applyScale(out),
      font: font.name,
      size: font.size
    });
    return {
      blob: blob,
      name: baseName(doc.name) + '.docx',
      count: pages.length,
      textPages: textPages,
      ocrPages: ocrPages,
      emptyPages: emptyPages,
      badPages: badPages,
      ocrFailed: ocrFailed
    };
  }

  window.PdfTools = {
    PRESETS: PRESETS,
    FONTS: FONTS,
    MAX_FILE_BYTES: MAX_FILE_BYTES,
    isSupported: isSupported,
    preload: preload,
    /** วิธีที่รันตัวอ่าน PDF: { mode: 'worker' | 'page' | null } */
    info: function () { return { mode: workerMode }; },
    open: open,
    parsePages: parsePages,
    toJpeg: toJpeg,
    toDocx: toDocx,
    // สำหรับทดสอบ
    _buildLines: buildLines,
    _pick: pick,
    _buildParagraphs: buildParagraphs
  };
})();
